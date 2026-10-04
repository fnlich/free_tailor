import { randomUUID } from 'crypto';

/**
 * The queues the server runs generation out of.
 *
 * A TASK is one resume. A request to generate ten resumes appends ten tasks to
 * the tail of a queue and returns; slots take tasks off the head as they free
 * up, until the queue is empty. The request is a way to SUBMIT work, not the
 * thing that performs it - which is what lets a batch outlive the page that
 * started it.
 *
 * One queue per resource, and each subscription seat is one. Each draws from
 * its own lane at its own concurrency, so a stalled seat cannot hold up
 * another and one seat's backlog cannot starve another's work.
 *
 * Why a dispatcher at all, when each seat's semaphore already has a FIFO waiter
 * list: a call queued at the semaphore is ALREADY RUNNING ITS OWN CLOCK.
 * `acquireSlot` bounds the wait at `min(deadline.remainingMs(), queueWaitMs)`,
 * and a tailoring call takes minutes - so dropping thirty tasks straight onto a
 * four-slot seat has tasks five through thirty time out while the first four
 * are still being answered. This queue exists to hold work whose clock has NOT
 * started. The semaphore stays underneath as the guarantee that a seat never
 * runs more calls at once than it was sized for.
 */

/**
 * One lane per REAL resource, which is the whole rule here.
 *
 * `codex` and `gemini` are lanes of their own rather than sharing `cli`, and
 * that is not tidiness.
 * Each CLI provider holds its own semaphore, and Claude's happens to be the
 * same size as the lane it ran in, so sharing was invisible until a second
 * provider arrived with a limit set by a different variable. Sharing one lane
 * across two independently-sized pools breaks both ways: the dispatcher offers
 * at most the lane's width, so the larger pool is unreachable, and tasks for the
 * smaller one sit in lane slots BLOCKED on their own semaphore - for up to ten
 * minutes - while the other provider's work starves behind them.
 */
export type QueueName = 'cli' | 'codex' | 'gemini';

/** Every lane this build has, in the order the dispatcher fills them. */
export const QUEUE_NAMES: readonly QueueName[] = ['cli', 'codex', 'gemini'];

/**
 * The seat each lane's slots run on - what a running task reports as
 * `runningOn`. A map rather than a branch, so a lane added later cannot report
 * the Claude seat by falling through.
 */
export const LANE_PROVIDER: Readonly<Record<QueueName, string>> = Object.freeze({
  cli: 'claude-cli',
  codex: 'codex-cli',
  gemini: 'gemini-cli',
});

/**
 * Whether a stored lane name is one this build has.
 *
 * A task's lane is written to disk and read back after a restart, possibly by
 * a build with different lanes - an earlier release had a third, for the
 * browser chat providers. Asked of the list rather than by indexing the queue
 * map, so a stored `constructor` is not mistaken for a lane either.
 */
export function isQueueName(value: unknown): value is QueueName {
  return typeof value === 'string' && (QUEUE_NAMES as readonly string[]).includes(value);
}

/**
 * One unit of capacity: one process slot on a seat.
 *
 * A list rather than a count so each slot has an identity the dispatcher can
 * mark busy, and the identity is stable across capacity readings - a slot id
 * that changed each time would let the dispatcher hand work to a slot it
 * already had busy.
 */
export type Slot = {
  id: string;
  queue: QueueName;
};

export type Capacity = Record<QueueName, Slot[]>;

function emptyCapacity(): Capacity {
  return { cli: [], codex: [], gemini: [] };
}

export type TaskState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** What a task is told when it starts: which lane is running it, and how to stop. */
export type Assignment = {
  queue: QueueName;
  signal: AbortSignal;
};

export type TaskLabel = {
  profileId: string;
  profileName: string;
  companyName: string;
  role: string;
  sourceRowNumber?: number;
};

/**
 * How a task is run, once it has come back off disk.
 *
 * A closure cannot be written to a database, so a task stores WHAT to do - a
 * kind and a plain payload - and the runner for that kind is looked up when the
 * task starts. The registry is the price of surviving a restart, and it is a
 * small one: there is one kind today.
 */
export type TaskRunner = (payload: unknown, assignment: Assignment) => Promise<unknown>;

const runners = new Map<string, TaskRunner>();

export function registerTaskRunner(kind: string, runner: TaskRunner): void {
  runners.set(kind, runner);
}

export type TaskDescriptor<T> = {
  queue: QueueName;
  label: TaskLabel;
  /** Which registered runner performs it. */
  kind: string;
  /** Everything that runner needs, and nothing that cannot be serialized. */
  payload: unknown;
};

export type Task<T = unknown> = TaskDescriptor<T> & {
  id: string;
  batchId: string;
  /** Position in the submitted list, so results keep INPUT order. */
  seq: number;
  state: TaskState;
  runningOn?: string;
  value?: T;
  error?: string;
  /**
   * How many times this task has been STARTED, counting the first.
   *
   * Absent on a task written before retrying existed, which reads as 1, so no
   * migration is needed. It does NOT persist by itself, though: the row's `data`
   * column is a projection built by `taskRow` in `services/queue/index.ts`, not
   * this object serialized, so this field only survives a restart because that
   * projection and the restore mapper beside it both name it. Adding another
   * field here means editing both.
   */
  attempts?: number;
};

export type BatchState = 'running' | 'done' | 'cancelled';

export type Batch<T = unknown> = {
  id: string;
  label: string;
  jobCount: number;
  /**
   * Anything the batch's tasks share, held once.
   *
   * The job descriptions live here. Thirty tasks on one posting would otherwise
   * hold thirty copies of it, on disk and in memory alike.
   */
  shared: Record<string, unknown>;
  createdAt: number;
  finishedAt?: number;
  state: BatchState;
  tasks: Task<T>[];
  controller: AbortController;
  /** Per-batch scratch the task runner uses; cleared when the batch finishes. */
  scratch: Map<string, unknown>;
};

export type BatchSnapshot = {
  batchId: string;
  label: string;
  state: BatchState;
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  jobCount: number;
  createdAt: string;
  finishedAt?: string;
  /**
   * How many goes each task gets here, so a page can say "attempt 2 of 3"
   * without knowing what `GENERATION_MAX_ATTEMPTS` is set to. On the snapshot
   * rather than baked into the UI precisely because the number is an operator's
   * to choose.
   */
  maxAttempts: number;
  tasks: Array<
    TaskLabel & {
      id: string;
      seq: number;
      state: TaskState;
      /** Present only from the second go on, so "attempt 1" is never rendered. */
      attempts?: number;
      runningOn?: string;
      error?: string;
    }
  >;
};

export type BatchEvent =
  | { type: 'task'; batchId: string; taskId: string; snapshot: BatchSnapshot }
  | { type: 'done'; batchId: string; snapshot: BatchSnapshot };

/** The batch id prefix, in one place, so a caller can mint one the same way. */
export function newBatchId(): string {
  return `bat_${randomUUID()}`;
}

type Listener = (event: BatchEvent) => void;

/**
 * How long a finished batch is kept, and how many.
 *
 * Kept at all so a page reloading just as its batch ends finds the result rather
 * than a 404. Bounded because nothing else deletes them, and a server left
 * running for a week would otherwise hold every resume it ever built.
 */
const KEEP_FINISHED_MS = 60 * 60_000;
const KEEP_FINISHED_COUNT = 20;

/** How stale the capacity reading may get before it is re-read. */
const CAPACITY_TTL_MS = 15_000;

/**
 * Where the queue is written down, so a run survives a restart.
 *
 * An interface rather than a direct import, because the dispatcher is the one
 * piece here worth testing without a database - and because a queue that could
 * not run at all when the disk was unavailable would be worse than one that
 * merely forgets on a restart.
 */
export type QueueStore = {
  saveBatch(batch: Batch): void;
  saveTask(task: Task): void;
  deleteBatch(batchId: string): void;
};

/**
 * Told when a task stops being work.
 *
 * A SEPARATE seam from QueueStore, deliberately. QueueStore is documented above
 * as "where the queue is written down"; a terminal-state notification is not
 * writing the queue down, and folding it in would make the persistence
 * interface carry a lifecycle concern it has no business knowing about. A
 * second optional parameter costs one line and keeps both contracts honest -
 * and keeps this class constructible bare, which the dispatcher's tests rely on.
 *
 * The dispatcher still has no database import. What the hook does with a
 * finished task is the composition root's business, not the queue's.
 */
export type QueueHooks = {
  taskStarted?(task: Task): void;
  taskFinished?(task: Task): void;
};

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class TaskQueue {
  /**
   * One array per queue, and THE ORDER IS THE CONTRACT. A task submitted later
   * never runs before one submitted earlier that an idle slot could take.
   */
  private readonly queues: Record<QueueName, Task[]> = { cli: [], codex: [], gemini: [] };

  private readonly batches = new Map<string, Batch>();

  /** Slot id -> the task holding it. */
  private readonly busy = new Map<string, Task>();

  private readonly listeners = new Map<string, Set<Listener>>();

  /**
   * The last capacity reading, held rather than fetched inside the loop.
   *
   * `dispatch` below is SYNCHRONOUS from end to end, and this is what makes that
   * possible. An `await` in the dispatch loop opens a window in which two tasks
   * settling concurrently both observe the same free slot and both start into
   * it - a seat handed more work than it was sized for, which is the single
   * failure this class exists to prevent. Reading capacity is an injected async
   * call, so it happens out here instead, and the loop only ever reads a plain
   * field.
   */
  private capacity: Capacity = emptyCapacity();
  private capacityReadAt = 0;
  private refreshing: Promise<void> | null = null;

  /**
   * Re-entrancy guard. `dispatch` can settle a task synchronously (a task that
   * fails validation), which calls `dispatch` again from inside itself.
   */
  private dispatching = false;
  private dispatchAgain = false;

  constructor(
    private readonly readCapacity: () => Promise<Capacity>,
    private readonly store?: QueueStore,
    private readonly hooks?: QueueHooks,
    /**
     * How many times a task may RUN in total, not how many retries follow the
     * first go. 1 disables retrying.
     *
     * Passed in rather than read from the environment here so a test can set it
     * without touching `process.env`, and so the one place that reads the
     * variable is the one place that builds the real queue.
     */
    private readonly maxAttempts = 1
  ) {}

  /**
   * Writes through to the store, and never lets it fail the queue.
   *
   * A disk that will not take the row is a reason to lose a restart, not a
   * reason to stop building somebody's resumes. It is said out loud once rather
   * than swallowed silently, because a queue that is quietly not persisting is
   * exactly the thing this was added to stop.
   */
  private persist(action: (store: QueueStore) => void): void {
    if (!this.store) return;
    try {
      action(this.store);
    } catch (error) {
      if (!this.warnedAboutStore) {
        this.warnedAboutStore = true;
        console.warn(
          '[queue] Could not write the queue to the database, so a restart will lose it. ' +
            'Generation itself is unaffected. ' +
            (error instanceof Error ? error.message : String(error))
        );
      }
    }
  }

  private warnedAboutStore = false;

  /**
   * Re-reads how wide each lane is, then dispatches.
   *
   * Called on submit and whenever the reading goes stale. The reader is
   * injected, so the dispatcher never assumes where the widths come from - the
   * real one sizes the seats from the environment, a test however it likes.
   */
  async refreshCapacity(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        this.capacity = await this.readCapacity();
        this.capacityReadAt = Date.now();
      } catch {
        // A settings read that fails must not stop a queue that is already
        // running on a perfectly good previous reading.
      } finally {
        this.refreshing = null;
      }
      this.dispatch();
    })();
    return this.refreshing;
  }

  /**
   * Appends tasks to the tail of their queue and returns at once.
   *
   * The batch is registered before anything runs, so the caller can hand back
   * its id while every task is still queued.
   */
  submit<T>(
    descriptors: Array<TaskDescriptor<T>>,
    meta: {
      id?: string;
      label?: string;
      jobCount?: number;
      shared?: Record<string, unknown>;
      /**
       * The caller will write this batch itself, atomically.
       *
       * Set by the submit route, which wraps the batch and all N task rows in
       * one transaction - so without this the same rows are written twice, once
       * per row here and once as a transaction there. A hundred and fifty
       * resumes meant three hundred and two statements for a hundred and
       * fifty-one rows.
       */
      deferPersist?: boolean;
    } = {}
  ): Batch<T> {
    // The caller may mint the id. `restore` already does, and a caller that must
    // reserve something against this batch needs the id BEFORE any task can
    // start - `submit` dispatches immediately, so there is no window afterwards.
    const batchId = meta.id ?? newBatchId();
    const tasks: Task<T>[] = descriptors.map((descriptor, seq) => ({
      ...descriptor,
      id: `tsk_${randomUUID()}`,
      batchId,
      seq,
      state: 'queued' as const,
    }));

    const batch: Batch<T> = {
      id: batchId,
      label: meta.label ?? 'Generation',
      jobCount: meta.jobCount ?? tasks.length,
      shared: meta.shared ?? {},
      createdAt: Date.now(),
      state: 'running',
      tasks,
      controller: new AbortController(),
      scratch: new Map(),
    };
    this.batches.set(batchId, batch as Batch);

    for (const task of tasks) {
      this.queues[this.laneOf(task as Task)].push(task as Task);
    }

    if (!meta.deferPersist) {
      this.persist((store) => {
        store.saveBatch(batch as Batch);
        for (const task of tasks) store.saveTask(task as Task);
      });
    }

    this.evictFinished();
    // Refreshed rather than dispatched directly: a first submit on a cold server
    // has no capacity reading yet, and dispatching against an empty one would
    // leave every task queued until something else happened to wake it.
    void this.refreshCapacity();
    return batch;
  }

  /**
   * Puts a batch back exactly as it was, after a restart.
   *
   * Not `submit`, because `submit` queues everything and that would lose the
   * work already done: a batch of thirty with eight built would come back as a
   * batch of twenty-two, its eight finished resumes gone from the list and its
   * total quietly wrong. Finished tasks are restored FINISHED, with their
   * results, and only the unfinished ones go back in the queue.
   *
   * A task that was RUNNING when the process died is requeued rather than
   * failed. Nothing completed it, so its resume does not exist; leaving it
   * failed would mean a restart silently dropped whatever happened to be
   * running at the time.
   */
  restore<T>(
    meta: { id: string; label: string; jobCount: number; shared: Record<string, unknown>; createdAt: number },
    entries: Array<
      TaskDescriptor<T> & {
        id: string;
        seq: number;
        state: TaskState;
        value?: T;
        error?: string;
        /** Attempts already spent, so a restart does not hand out a fresh budget. */
        attempts?: number;
      }
    >
  ): Batch<T> {
    const tasks: Task<T>[] = entries.map((entry) => ({
      ...entry,
      batchId: meta.id,
      // Both unfinished states come back as queued: the clock of a task that
      // was running died with the process that was running it.
      state: entry.state === 'running' ? 'queued' : entry.state,
    }));

    const batch: Batch<T> = {
      id: meta.id,
      label: meta.label,
      jobCount: meta.jobCount,
      shared: meta.shared,
      createdAt: meta.createdAt,
      state: 'running',
      tasks,
      controller: new AbortController(),
      scratch: new Map(),
    };
    this.batches.set(meta.id, batch as Batch);

    for (const task of tasks) {
      // Every task's lane is checked, finished ones included: the snapshot and
      // the stats count by lane, and a finished task still names one.
      const lane = this.laneOf(task as Task);
      if (task.state === 'queued') this.queues[lane].push(task as Task);
    }

    // A batch whose every task had finished before the restart is finished, and
    // saying otherwise would leave it listed as active for ever.
    if (!tasks.some((task) => task.state === 'queued')) {
      batch.state = 'done';
      batch.finishedAt = Date.now();
    }

    void this.refreshCapacity();
    return batch;
  }

  getBatch(batchId: string): Batch | undefined {
    return this.batches.get(batchId);
  }

  listBatches(activeOnly: boolean): Batch[] {
    const all = [...this.batches.values()].sort((a, b) => b.createdAt - a.createdAt);
    return activeOnly ? all.filter((batch) => batch.state === 'running') : all;
  }

  snapshot(batchId: string): BatchSnapshot | undefined {
    const batch = this.batches.get(batchId);
    return batch ? this.describe(batch) : undefined;
  }

  /**
   * Stops a batch: queued tasks are dropped, running ones are aborted.
   *
   * Running work is aborted rather than waited out, because the only reason to
   * cancel is to get the slots back.
   */
  cancel(batchId: string): { cancelled: number; aborted: number } | null {
    const batch = this.batches.get(batchId);
    if (!batch || batch.state !== 'running') return null;

    let cancelled = 0;
    let aborted = 0;
    for (const task of batch.tasks) {
      if (task.state === 'queued') {
        // Through the funnel, but NOT through `settle`: its tail would mark the
        // batch done in the middle of cancelling it. The write and the
        // announcement are suppressed because this method does both in bulk
        // below - otherwise a thirty-task batch would write and emit thirty
        // times for one click.
        this.finishTask(task, 'cancelled', {
          // "Before it started" is only true on the FIRST go. A task cancelled
          // while queued for a retry HAS been tried, and overwriting its error
          // would throw away the reason the first attempt failed - which
          // `retryTask` kept on purpose.
          error:
            (task.attempts ?? 1) > 1
              ? `Cancelled after ${task.attempts} attempt(s)` +
                (task.error ? `; last failure: ${task.error}` : '')
              : 'Cancelled before it started',
          persist: false,
          emit: false,
        });
        cancelled += 1;
      } else if (task.state === 'running') {
        aborted += 1;
      }
    }
    for (const name of Object.keys(this.queues) as QueueName[]) {
      this.queues[name] = this.queues[name].filter((task) => task.batchId !== batchId);
    }

    batch.state = 'cancelled';
    batch.finishedAt = Date.now();
    batch.scratch.clear();
    batch.controller.abort();
    this.persist((store) => {
      store.saveBatch(batch);
      for (const task of batch.tasks) store.saveTask(task);
    });
    this.emit({ type: 'done', batchId, snapshot: this.describe(batch) });
    this.dispatch();
    return { cancelled, aborted };
  }

  subscribe(batchId: string, listener: Listener): () => void {
    const existing = this.listeners.get(batchId) ?? new Set<Listener>();
    existing.add(listener);
    this.listeners.set(batchId, existing);
    return () => {
      existing.delete(listener);
      if (existing.size === 0) this.listeners.delete(batchId);
    };
  }

  /**
   * What the dispatcher is doing right now, for the admin page and the logs.
   *
   * Built by walking the lanes rather than naming them, like everything else
   * here that has to cover every lane: a lane named by hand is a lane the next
   * one added is missing from.
   */
  stats(): Record<QueueName, { queued: number; running: number; width: number }> {
    const stats = {} as Record<QueueName, { queued: number; running: number; width: number }>;
    for (const lane of QUEUE_NAMES) {
      stats[lane] = { queued: this.queues[lane].length, running: 0, width: this.capacity[lane]?.length ?? 0 };
    }
    for (const task of this.busy.values()) {
      if (stats[task.queue]) stats[task.queue].running += 1;
    }
    return stats;
  }

  /** Tests share one process; a queue left running would leak into the next. */
  resetForTests(): void {
    for (const batch of this.batches.values()) batch.controller.abort();
    // Every lane. This named two of them and left the Codex lane's backlog to
    // the next test.
    for (const lane of QUEUE_NAMES) this.queues[lane] = [];
    this.batches.clear();
    this.busy.clear();
    this.listeners.clear();
    this.capacity = emptyCapacity();
    this.capacityReadAt = 0;
    this.dispatching = false;
    this.dispatchAgain = false;
  }

  /**
   * The lane a task belongs in, never one this build lacks.
   *
   * The restore mapper already turns a stored lane this build does not have
   * into one it does; this is the last line behind it, for `submit` and
   * `restore` alike. Pushing onto a lane that does not exist throws inside the
   * caller, and in `restore` that throw would take the whole batch with it. So
   * an unknown lane becomes `cli` - the lane that carries every provider without
   * a seat of its own - and the task records it, so the stats and the retry path
   * agree with where it actually waits.
   */
  private laneOf(task: Task): QueueName {
    if (!isQueueName(task.queue)) task.queue = 'cli';
    return task.queue;
  }

  /**
   * Hands every free slot the first task it is allowed to run.
   *
   * SYNCHRONOUS, deliberately - see `capacity`. Nothing in here may await.
   */
  private dispatch(): void {
    if (this.dispatching) {
      this.dispatchAgain = true;
      return;
    }
    this.dispatching = true;
    try {
      do {
        this.dispatchAgain = false;
        // Every lane, by iteration rather than by name. Naming them meant a lane
        // added later was sized, routed to, and then never filled - its tasks
        // sat queued for ever with nothing saying why.
        for (const lane of QUEUE_NAMES) {
          this.fill(this.capacity[lane] ?? []);
        }
      } while (this.dispatchAgain);
    } finally {
      this.dispatching = false;
    }

    // Outside the loop, and never awaited from inside it.
    if (Date.now() - this.capacityReadAt > CAPACITY_TTL_MS && this.pending() > 0) {
      void this.refreshCapacity();
    }
  }

  /**
   * Everything still waiting, in every lane.
   *
   * By iteration, for the reason `dispatch` gives. Naming lanes here once
   * counted a lane that no longer did anything and left out the Codex one, so a
   * backlog that was ALL Codex work never asked for a fresh capacity reading.
   */
  private pending(): number {
    return QUEUE_NAMES.reduce((total, lane) => total + this.queues[lane].length, 0);
  }

  private fill(slots: Slot[]): void {
    for (const slot of slots) {
      if (this.busy.has(slot.id)) continue;
      if (!isQueueName(slot.queue)) continue;
      // The head of the slot's own lane. Slots are interchangeable WITHIN a
      // lane, so the first task waiting is the one this slot may run; the lane
      // is what keeps the two seats' pools apart.
      const task = this.queues[slot.queue].shift();
      if (!task) continue;
      this.start(task, slot);
    }
  }

  private start(task: Task, slot: Slot): void {
    const batch = this.batches.get(task.batchId);
    if (!batch || batch.state !== 'running') {
      this.settle(task, 'cancelled', 'The batch was cancelled');
      return;
    }

    task.state = 'running';
    // Counted on the way in, so a task that is running has always been started
    // at least once and the snapshot can say "attempt 2 of 3" honestly.
    task.attempts = task.attempts ?? 1;
    // Each lane names the seat it runs on. Reading the lane rather than
    // hard-coding one provider is what keeps this honest with three seats.
    task.runningOn = LANE_PROVIDER[slot.queue];
    this.busy.set(slot.id, task);
    this.persist((store) => store.saveTask(task));
    this.emitTask(task);

    try {
      // Told, not asked: nothing outside can see a task START, only that some
      // later snapshot says it is running. An order's item list wants the
      // difference between "waiting" and "being built" while the run is live.
      this.hooks?.taskStarted?.(task);
    } catch (error) {
      // Same posture as the finished hook below: a listener that throws costs
      // whatever the listener was for, never the dispatch loop it threw inside.
      console.warn('[queue] A task-started hook threw; the task itself is unaffected.', error);
    }

    const release = () => {
      this.busy.delete(slot.id);
      // The only thing that can let a queued task start is a slot coming free.
      this.dispatch();
    };

    /*
     * Resolved BEFORE the try below, and the placement is the whole point.
     *
     * A kind nothing registered is deterministic, so inside the retrying catch
     * it would burn every attempt on the identical error and only delay it. It
     * settles outside that catch, which is what makes `retryTask`'s claim that
     * only the runner's own failure reaches it true rather than nearly true.
     *
     * Only reachable for a task restored from a build that knew a kind this one
     * does not; failing it by name beats it sitting queued for ever.
     */
    const runner = runners.get(task.kind);
    if (!runner) {
      this.settle(task, 'failed', `No runner is registered for "${task.kind}" tasks`);
      release();
      return;
    }

    // Every rejection is caught HERE. There is no HTTP request left to absorb an
    // unhandled one, and Node's default policy for an unhandled rejection is to
    // take the process down - so a single failed resume would stop the server.
    void (async () => {
      try {
        task.value = await runner(task.payload, {
          queue: slot.queue,
          signal: batch.controller.signal,
        });
        this.settle(task, 'done');
      } catch (error) {
        const cancelled = batch.controller.signal.aborted;
        // Retried HERE and nowhere else, which is what makes the credit
        // arithmetic come out right without touching it. `settle` is what
        // eventually calls the taskFinished hook, and that hook is where a
        // failed unit is refunded - so a task that goes back on the queue
        // instead of settling has neither been charged again nor refunded
        // early. It is simply still in flight, which is the truth.
        if (!cancelled && this.retryTask(task, describeError(error))) {
          return;
        }
        this.settle(task, cancelled ? 'cancelled' : 'failed', describeError(error));
      } finally {
        release();
      }
    })().catch(() => {
      // Unreachable - the body catches everything - and kept because "should be
      // unreachable" is not a guarantee, and the cost of being wrong is the
      // whole server.
      release();
    });
  }

  /**
   * The ONE place a task stops being work.
   *
   * There were two. `settle` handled done, failed and cancelled-while-running;
   * `cancel` flipped its QUEUED tasks inline and never came through here. Any
   * hook wired to `settle` alone would therefore miss every queued task of every
   * cancelled batch - which on a two-hundred-row sheet import is nearly all of
   * them.
   *
   * Rerouting `cancel` through `settle` would have been wrong the other way:
   * `settle`'s tail marks the batch done once nothing is left queued or running,
   * so it would declare a batch finished half way through cancelling it and emit
   * a second terminal event. So the shared half lives here and both paths call
   * it, with `cancel` suppressing the per-task write and emit it does in bulk.
   */
  private finishTask(
    task: Task,
    state: TaskState,
    options: { error?: string; persist?: boolean; emit?: boolean } = {}
  ): void {
    task.state = state;
    task.runningOn = undefined;
    if (options.error) task.error = options.error;
    if (options.persist !== false) this.persist((store) => store.saveTask(task));

    try {
      this.hooks?.taskFinished?.(task);
    } catch (error) {
      // Same posture as `persist` above: a hook that throws costs whatever the
      // hook was for, not the task that was only reporting it had stopped.
      console.warn('[queue] A task-finished hook threw; the task itself is unaffected.', error);
    }

    if (options.emit !== false) this.emitTask(task);
  }

  /**
   * Puts a failed task back on the queue, or says it is out of attempts.
   *
   * Only the RUNNER's own failure comes here. The other two ways a task can
   * fail are deliberately excluded and both would be bugs to include: a
   * cancelled batch is not a failure to retry, and a task whose kind has no
   * registered runner would fail identically on every attempt - re-queueing
   * that one would only spend the attempts and delay the same answer.
   *
   * It goes on the TAIL. A retry is not more urgent than the work already
   * waiting, and a task that fails fast at the head would otherwise spin
   * through its attempts while everything behind it waited.
   */
  private retryTask(task: Task, error: string): boolean {
    const attempts = task.attempts ?? 1;
    if (attempts >= this.maxAttempts) return false;

    task.attempts = attempts + 1;
    task.state = 'queued';
    task.runningOn = undefined;
    // Kept, so a task waiting on its second go still says what went wrong the
    // first time rather than looking like it was never tried.
    task.error = error;
    this.queues[task.queue].push(task);
    this.persist((store) => store.saveTask(task));
    this.emitTask(task);
    return true;
  }

  private settle(task: Task, state: TaskState, error?: string): void {
    this.finishTask(task, state, { error });

    const batch = this.batches.get(task.batchId);
    if (!batch || batch.state !== 'running') return;
    if (batch.tasks.some((entry) => entry.state === 'queued' || entry.state === 'running')) return;

    batch.state = 'done';
    batch.finishedAt = Date.now();
    // A job description is tens of kilobytes and a thirty-job batch holds thirty
    // of them. The finished batch is kept for an hour; its working set is not.
    batch.scratch.clear();
    this.persist((store) => store.saveBatch(batch));
    this.emit({ type: 'done', batchId: batch.id, snapshot: this.describe(batch) });
  }

  private emitTask(task: Task): void {
    const batch = this.batches.get(task.batchId);
    if (!batch) return;
    this.emit({ type: 'task', batchId: batch.id, taskId: task.id, snapshot: this.describe(batch) });
  }

  private emit(event: BatchEvent): void {
    for (const listener of this.listeners.get(event.batchId) ?? []) {
      // One listener throwing must not stop the others hearing about it, nor
      // fail the task that was only reporting progress.
      try {
        listener(event);
      } catch {
        // ignored on purpose
      }
    }
  }

  private describe(batch: Batch): BatchSnapshot {
    const counted = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const task of batch.tasks) {
      if (task.state === 'queued') counted.queued += 1;
      else if (task.state === 'running') counted.running += 1;
      else if (task.state === 'done') counted.completed += 1;
      else if (task.state === 'failed') counted.failed += 1;
      else counted.cancelled += 1;
    }

    return {
      batchId: batch.id,
      label: batch.label,
      state: batch.state,
      total: batch.tasks.length,
      ...counted,
      jobCount: batch.jobCount,
      maxAttempts: this.maxAttempts,
      createdAt: new Date(batch.createdAt).toISOString(),
      ...(batch.finishedAt ? { finishedAt: new Date(batch.finishedAt).toISOString() } : {}),
      tasks: batch.tasks.map((task) => ({
        ...task.label,
        id: task.id,
        seq: task.seq,
        state: task.state,
        // Sent only once it means something. A task on its first go says
        // nothing, so a UI has no "attempt 1 of 3" noise to suppress.
        ...(task.attempts && task.attempts > 1 ? { attempts: task.attempts } : {}),
        ...(task.runningOn ? { runningOn: task.runningOn } : {}),
        ...(task.error ? { error: task.error } : {}),
      })),
    };
  }

  private evictFinished(): void {
    const finished = [...this.batches.values()]
      .filter((batch) => batch.state !== 'running')
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));

    const now = Date.now();
    finished.forEach((batch, index) => {
      const stale = now - (batch.finishedAt ?? now) > KEEP_FINISHED_MS;
      if (index >= KEEP_FINISHED_COUNT || stale) {
        this.batches.delete(batch.id);
        this.listeners.delete(batch.id);
        this.persist((store) => store.deleteBatch(batch.id));
      }
    });
  }
}
