import { randomUUID } from 'crypto';

import { publicTaskError } from '../../middleware/publicError';

/**
 * The queues the server runs generation out of.
 *
 * A TASK is one resume. A request to generate ten resumes appends ten tasks to
 * the tail of a queue - of its tier: an urgent batch's (Generate Immediately)
 * wait ahead of the rest, see `enqueue` - and returns; slots take tasks off
 * the head as they free up, until the queue is empty. The request is a way to SUBMIT work, not the
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
 * One lane per REAL resource, which is the whole rule here - and the resource
 * is a PROVIDER (owner decision P3): one CLI signed in at one location
 * (config/aiProviders.ts), with its own semaphore sized by its own
 * `concurrency_max_requests`. Two Claude providers are two lanes.
 *
 * Why not one lane per type: each provider holds its own semaphore, and
 * sharing one lane across independently-sized pools breaks both ways - the
 * dispatcher offers at most the lane's width, so the larger pool is
 * unreachable, and tasks for the smaller one sit in lane slots BLOCKED on
 * their own semaphore while the other provider's work starves behind them.
 * That was learned with Claude and Codex sharing a lane, and holds the same
 * for two Claude accounts.
 *
 * A lane belongs to a POOL - its provider's type - and a task names its pool
 * (the type its model runs on, owner decision P4). The queue puts each task in
 * the lane of a SERVING provider of its pool - enabled, ready, not held - with
 * the most free capacity: tasks running plus waiting, relative to the lane's
 * width, ties to the reading's order (`place`). A lane that stops serving -
 * held, signed out, switched off, removed - has its WAITING tasks moved to one
 * that serves (`rebalance`); a slot left idle takes the head of a busier
 * lane of its pool (`steal`). With no lane of a pool serving, its tasks wait.
 *
 * Lane names are whatever the capacity reading names: provider ids in the
 * real queue (`claude-cli` for the built-in Claude provider, `prv-...` for an
 * added one), anything at all in a test.
 */
export type QueueName = string;

/**
 * One unit of capacity: one process slot on a provider.
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

/**
 * A capacity reading in its plain form: lane -> slots, each lane its own pool,
 * always serving. What the tests hand in.
 */
export type Capacity = Record<QueueName, Slot[]>;

/** One lane as the real queue reads it: its pool, whether it is switched on, and its slots. */
export type LaneReading = {
  id: QueueName;
  /** The pool (provider type) it serves. */
  pool: string;
  /** Switched on, with its type switched on and not locked. A lane that is not takes nothing. */
  enabled: boolean;
  slots: Slot[];
};

/** What `readCapacity` may answer: the plain form, or every lane with its pool. */
export type CapacityReading = Capacity | { lanes: LaneReading[] };

/**
 * What the dispatcher asks about a lane between readings, synchronously:
 * whether its provider can take work NOW (no hold on the seat, not signed
 * out), and which pool a lane the last reading did not name belongs to - a
 * removed provider's, or one an older build wrote. Every method optional; the
 * default is a lane that is always ready and a pool nobody knows.
 */
export type LanePolicy = {
  ready?(lane: QueueName): boolean;
  poolOf?(lane: QueueName): string | null;
};

function normalizeReading(reading: CapacityReading | null | undefined): LaneReading[] {
  if (!reading) return [];
  if (Array.isArray((reading as { lanes?: unknown }).lanes)) {
    return (reading as { lanes: LaneReading[] }).lanes.map((lane) => ({ ...lane, slots: [...lane.slots] }));
  }
  return Object.entries(reading as Capacity).map(([id, slots]) => ({
    id,
    pool: id,
    enabled: true,
    slots: Array.isArray(slots) ? [...slots] : [],
  }));
}

/** How often work that no lane can serve asks again whether one can - a hold ends by itself. */
const BLOCKED_RECHECK_MS = 10_000;

export type TaskState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** What a task is told when it starts: which lane - which provider - is running it, and how to stop. */
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
  /**
   * Where it waits. Submitted as the POOL it runs in (its model's type, which
   * is also the built-in provider's lane); the queue moves it to the lane of
   * the provider it places it with, and records that here.
   */
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
  /** The lane - the provider - running it, while it runs. */
  runningOn?: string;
  /**
   * The lane - the provider - it last ran on, kept after it settles: an
   * administrator's answer to "which account built this". Persisted, so it is
   * named in `taskRow` and the restore mapper (services/queue/index.ts).
   */
  ranOn?: string;
  /**
   * The pool it belongs to, worked out the first time the queue could tell
   * and kept, so a task left in the lane of a provider removed since still
   * knows its type. Not persisted: the restore works it out again.
   */
  pool?: string;
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
  /**
   * Whether this batch's tasks go ahead of other work waiting in their lane.
   *
   * Set for a run somebody is sitting in front of (Generate Immediately) and
   * not for an order, which nobody is waiting on: a 300-row order queued first
   * would otherwise put every later Generate on that seat behind it, and an
   * "immediate" run that waits an hour is not immediate. Within each tier the
   * order is still first come, first served - see `enqueue`. The queue does not
   * know what the flag means beyond that; the submit route and the restore
   * decide it from the batch's kind.
   */
  urgent?: boolean;
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
      /** The provider it last ran on. Administrators only, like `runningOn`. */
      ranOn?: string;
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
  /**
   * The batch stopped being work: its last task settled, or it was cancelled.
   * Called once per batch, after every task's own `taskFinished`. Not called
   * for a batch `restore` brings back already finished - the restore settles
   * that one itself.
   */
  batchFinished?(batch: Batch): void;
};

/**
 * The text a failed task stores.
 *
 * Stored, so it outlives the request that queued it: it is persisted with the
 * task, copied onto the order item, and read by the owner's page days later.
 * The raw message - a seat's stderr, a path, a model id - is never what is
 * stored. It is the public sentence and a ref, and the cause is logged once
 * under that ref (see `publicTaskError`).
 */
/** What a task that was running when its batch was cancelled says. */
export const CANCELLED_WHILE_RUNNING = 'Cancelled while it was running';

/**
 * A runner's failure that no later attempt can change - it says so with
 * `retryable: false` (a deleted profile, say) - settles at once instead of
 * spending the remaining attempts reaching the same answer.
 */
function isFinalFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { retryable?: unknown }).retryable === false;
}

function describeError(error: unknown, task: Task): string {
  return publicTaskError(error, 'This resume could not be built', `task ${task.id} (batch ${task.batchId})`);
}

export class TaskQueue {
  /**
   * One array per lane - per provider - and THE ORDER IS THE CONTRACT. Within
   * a tier, a task placed in a lane later never runs before one placed there
   * earlier that an idle slot could take; an urgent batch's tasks wait ahead
   * of every non-urgent one in their lane (`place`). A lane exists here from
   * the moment a task waits in it, whether or not a reading names it yet.
   */
  private readonly queues = new Map<QueueName, Task[]>();

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
  private lanes: LaneReading[] = [];
  private laneById = new Map<QueueName, LaneReading>();
  private capacityReadAt = 0;
  private refreshing: Promise<void> | null = null;
  /** A pending re-check for work no lane can serve; see BLOCKED_RECHECK_MS. */
  private blockedTimer: NodeJS.Timeout | null = null;
  /** The pools whose work is waiting with no lane to serve it, as last said in the log. */
  private blockedPools = new Set<string>();

  /**
   * Re-entrancy guard. `dispatch` can settle a task synchronously (a task that
   * fails validation), which calls `dispatch` again from inside itself.
   */
  private dispatching = false;
  private dispatchAgain = false;

  constructor(
    private readonly readCapacity: () => Promise<CapacityReading>,
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
    private readonly maxAttempts = 1,
    /** Asked about a lane between readings: see LanePolicy. */
    private readonly policy: LanePolicy = {}
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
   * Called on submit, whenever the reading goes stale, while work waits that
   * no lane can serve, and after an administrator changes a provider. The
   * reader is injected, so the dispatcher never assumes where the widths come
   * from - the real one reads every provider and its limit from the settings
   * (services/queue/index.ts `readCapacity`), a test however it likes.
   */
  async refreshCapacity(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        this.lanes = normalizeReading(await this.readCapacity());
        this.laneById = new Map(this.lanes.map((lane) => [lane.id, lane]));
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
      /** Queue ahead of non-urgent work in each lane. See `Batch.urgent`. */
      urgent?: boolean;
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
      ...(meta.urgent ? { urgent: true } : {}),
    };
    this.batches.set(batchId, batch as Batch);

    this.enqueue(tasks as Task[]);

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
    meta: {
      id: string;
      label: string;
      jobCount: number;
      shared: Record<string, unknown>;
      createdAt: number;
      /** See `Batch.urgent`. Decided again from the stored batch, as at submit. */
      urgent?: boolean;
    },
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
      ...(meta.urgent ? { urgent: true } : {}),
    };
    this.batches.set(meta.id, batch as Batch);

    // Only what will run again is placed: a lane - a provider - restored from
    // disk may be one this process no longer has, and the placement is what
    // moves it to a provider of its type (`place`, `rebalance`).
    this.enqueue((tasks as Task[]).filter((task) => task.state === 'queued'));

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
    for (const [lane, waiting] of this.queues) {
      this.queues.set(lane, waiting.filter((task) => task.batchId !== batchId));
    }

    batch.state = 'cancelled';
    batch.finishedAt = Date.now();
    batch.scratch.clear();
    batch.controller.abort();
    this.persist((store) => {
      store.saveBatch(batch);
      for (const task of batch.tasks) store.saveTask(task);
    });
    this.batchFinished(batch);
    this.emit({ type: 'done', batchId, snapshot: this.describe(batch) });
    this.dispatch();
    return { cancelled, aborted };
  }

  subscribe(batchId: string, listener: Listener): () => void {
    const existing = this.listeners.get(batchId) ?? new Set<Listener>();
    existing.add(listener);
    this.listeners.set(batchId, existing);
    // Safe to call twice: a stream ended on its own (`done`, or a tab lease's
    // hold running out) unsubscribes again when its connection closes - by
    // when a new reader may have made a NEW set for the batch, which an
    // unguarded delete would have thrown away along with that reader's events.
    return () => {
      existing.delete(listener);
      if (existing.size === 0 && this.listeners.get(batchId) === existing) this.listeners.delete(batchId);
    };
  }

  /**
   * What the dispatcher is doing right now, for the admin page and the logs:
   * every lane the last reading named, in its order, and any other lane work
   * is waiting in. Built by walking the lanes rather than naming them - a lane
   * named by hand is a lane the next provider added is missing from.
   */
  stats(): Record<
    QueueName,
    { queued: number; running: number; width: number; pool: string | null; serving: boolean }
  > {
    // Null-prototype, so a lane an older build named `constructor` is a lane
    // like any other rather than something every object already has.
    const stats: Record<
      QueueName,
      { queued: number; running: number; width: number; pool: string | null; serving: boolean }
    > = Object.create(null);
    const waitingElsewhere = [...this.queues.entries()]
      .filter(([lane, waiting]) => waiting.length > 0 && !this.laneById.has(lane))
      .map(([lane]) => lane);
    for (const lane of [...this.lanes.map((entry) => entry.id), ...waitingElsewhere]) {
      if (stats[lane]) continue;
      stats[lane] = {
        queued: this.waitingIn(lane).length,
        running: this.runningIn(lane),
        width: this.laneById.get(lane)?.slots.length ?? 0,
        pool: this.laneById.get(lane)?.pool ?? this.policy.poolOf?.(lane) ?? null,
        serving: this.isServing(lane),
      };
    }
    return stats;
  }

  /** Tests share one process; a queue left running would leak into the next. */
  resetForTests(): void {
    for (const batch of this.batches.values()) batch.controller.abort();
    this.queues.clear();
    this.batches.clear();
    this.busy.clear();
    this.listeners.clear();
    this.lanes = [];
    this.laneById = new Map();
    this.capacityReadAt = 0;
    this.dispatching = false;
    this.dispatchAgain = false;
    if (this.blockedTimer) clearTimeout(this.blockedTimer);
    this.blockedTimer = null;
    this.blockedPools = new Set();
  }

  private waitingIn(lane: QueueName): Task[] {
    let list = this.queues.get(lane);
    if (!list) {
      list = [];
      this.queues.set(lane, list);
    }
    return list;
  }

  private runningIn(lane: QueueName): number {
    let count = 0;
    for (const task of this.busy.values()) if (task.queue === lane) count += 1;
    return count;
  }

  /** A lane that may take work now: in the reading, switched on, with slots, and ready. */
  private isServing(lane: QueueName): boolean {
    const reading = this.laneById.get(lane);
    if (!reading || !reading.enabled || reading.slots.length === 0) return false;
    return this.policy.ready ? this.policy.ready(lane) : true;
  }

  /** How full a lane is: running plus waiting, over its width. */
  private load(lane: QueueName): number {
    const width = Math.max(1, this.laneById.get(lane)?.slots.length ?? 0);
    return (this.runningIn(lane) + this.waitingIn(lane).length) / width;
  }

  /**
   * The pool a task runs in, worked out once and kept.
   *
   * From its lane's reading, else the policy (a lane the reading no longer
   * names - a removed provider's, an older build's), else - once there is a
   * reading at all - the first lane's pool: a lane name nothing knows would
   * otherwise be a lane no slot ever fills, and a task in it accepted,
   * counted and never run. Before the first reading it is not known, and the
   * task waits under the name it came with.
   */
  private poolOf(task: Task): string | null {
    if (task.pool) return task.pool;
    const pool =
      this.laneById.get(task.queue)?.pool ??
      this.policy.poolOf?.(task.queue) ??
      (this.capacityReadAt > 0 ? this.lanes[0]?.pool ?? null : null);
    if (pool) task.pool = pool;
    return pool;
  }

  /**
   * The lane a task should wait in: of its pool's lanes that serve, the one
   * with the most free capacity, ties to the reading's order. With none
   * serving, it stays where it is if that lane is its pool's and still in the
   * reading, else it goes to its pool's first lane - and waits there, because
   * nothing of its type can take it now.
   */
  private chooseLane(task: Task): QueueName {
    const pool = this.poolOf(task);
    if (!pool) return task.queue;
    const ofPool = this.lanes.filter((lane) => lane.pool === pool);
    let best: QueueName | null = null;
    let bestLoad = Infinity;
    for (const lane of ofPool) {
      if (!this.isServing(lane.id)) continue;
      const load = this.load(lane.id);
      if (load < bestLoad) {
        best = lane.id;
        bestLoad = load;
      }
    }
    if (best) return best;
    if (this.laneById.get(task.queue)?.pool === pool) return task.queue;
    return ofPool[0]?.id ?? task.queue;
  }

  /**
   * Puts tasks in line, each in the lane `chooseLane` picks: an urgent batch's
   * after the urgent work already waiting in that lane and before everything
   * else, any other batch's at the tail.
   *
   * The ONE way into a lane - submit, restore, a retry and a move off a lane
   * that stopped serving all come through here - so the two tiers cannot be
   * kept by one path and broken by another. A retry of an urgent task
   * therefore goes to the back of the urgent work, not behind a
   * three-hundred-row order, and a retried order task still goes to the very
   * back. Dispatch stays "take the head" (`fill`): the order of the arrays is
   * the whole policy.
   *
   * One task at a time, so each placement sees the load the previous one
   * added: six tasks for two providers of widths 1 and 2 land two and four.
   */
  private enqueue(tasks: Task[]): void {
    for (const task of tasks) this.place(task);
  }

  private place(task: Task): void {
    const lane = this.chooseLane(task);
    task.queue = lane;
    const waiting = this.waitingIn(lane);
    if (this.isUrgent(task)) {
      const firstOrdinary = waiting.findIndex((entry) => !this.isUrgent(entry));
      waiting.splice(firstOrdinary === -1 ? waiting.length : firstOrdinary, 0, task);
    } else {
      waiting.push(task);
    }
  }

  /**
   * Moves the WAITING work off every lane that does not serve - its provider
   * held, signed out, switched off or removed - to one of its pool that does.
   * What is running there finishes or fails as it would have. Nothing moves
   * while no lane of the pool serves: the work waits where it is.
   *
   * Written back when it moves, so a restart finds each task in the lane it
   * was moved to.
   */
  private rebalance(): void {
    for (const lane of [...this.queues.keys()]) {
      const waiting = this.queues.get(lane)!;
      if (waiting.length === 0 || this.isServing(lane)) continue;
      const pools = new Set(waiting.map((task) => this.poolOf(task)));
      const anyServing = [...pools].some(
        (pool) => pool !== null && this.lanes.some((entry) => entry.pool === pool && this.isServing(entry.id))
      );
      const inReading = this.laneById.has(lane);
      // Nothing serves and the lane still exists: leave the order as it is.
      if (!anyServing && inReading) continue;
      this.queues.set(lane, []);
      for (const task of waiting) {
        this.place(task);
        if (task.queue !== lane) this.persist((store) => store.saveTask(task));
      }
      // A lane no reading names and nothing waits in is gone: forgotten, so
      // the stats stop listing a provider removed or a name an older build had.
      if (!inReading && this.queues.get(lane)?.length === 0) this.queues.delete(lane);
    }
  }

  private isUrgent(task: Task): boolean {
    return this.batches.get(task.batchId)?.urgent === true;
  }

  /** The `batchFinished` hook, guarded like the others: a listener that throws costs only itself. */
  private batchFinished(batch: Batch): void {
    try {
      this.hooks?.batchFinished?.(batch);
    } catch (error) {
      console.warn('[queue] A batch-finished hook threw; the batch itself is unaffected.', error);
    }
  }

  /**
   * Hands every free slot the first task it is allowed to run.
   *
   * SYNCHRONOUS, deliberately - see `lanes`. Nothing in here may await.
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
        // Not before the first reading: until then no lane is known to serve,
        // and moving work about on no information would only scramble it.
        if (this.capacityReadAt > 0) this.rebalance();
        // Every lane, by iteration rather than by name. Naming them meant a lane
        // added later was sized, routed to, and then never filled - its tasks
        // sat queued for ever with nothing saying why.
        for (const lane of this.lanes) {
          if (this.isServing(lane.id)) this.fill(lane);
        }
        this.steal();
      } while (this.dispatchAgain);
    } finally {
      this.dispatching = false;
    }

    // Outside the loop, and never awaited from inside it.
    if (Date.now() - this.capacityReadAt > CAPACITY_TTL_MS && this.pending() > 0) {
      void this.refreshCapacity();
    }
    this.watchBlocked();
  }

  /**
   * Work that no lane can take now - every provider of its type held, signed
   * out or switched off - asks again in a little while. A hold ends by itself
   * and nothing else would notice; the reading this triggers is also when the
   * real queue asks a signed-out provider's health again.
   */
  private watchBlocked(): void {
    if (this.capacityReadAt === 0) return;
    // After `rebalance`, work still waiting on a lane that does not serve is
    // work no lane of its pool can serve.
    const blocked = new Set<string>();
    for (const [lane, waiting] of this.queues) {
      if (waiting.length > 0 && !this.isServing(lane)) blocked.add(this.poolOf(waiting[0]) ?? lane);
    }
    // Said once when it starts and once when it ends, not once per dispatch:
    // an operator who finds resumes sitting queued needs to know why.
    for (const pool of blocked) {
      if (!this.blockedPools.has(pool)) {
        console.warn(
          `[queue] Work for ${pool} is waiting: no provider of that type can take work now - each is held, ` +
            'signed out or switched off. It starts when one can; Admin -> Settings shows every provider\'s state.'
        );
      }
    }
    for (const pool of this.blockedPools) {
      if (!blocked.has(pool)) console.log(`[queue] A ${pool} provider can take work again; what was waiting carries on.`);
    }
    this.blockedPools = blocked;
    if (this.blockedTimer || blocked.size === 0) return;
    this.blockedTimer = setTimeout(() => {
      this.blockedTimer = null;
      void this.refreshCapacity();
    }, BLOCKED_RECHECK_MS);
    // Housekeeping, never the reason the process stays alive.
    this.blockedTimer.unref?.();
  }

  /**
   * Everything still waiting, in every lane.
   *
   * By iteration, for the reason `dispatch` gives. Naming lanes here once
   * counted a lane that no longer did anything and left out the Codex one, so a
   * backlog that was ALL Codex work never asked for a fresh capacity reading.
   */
  private pending(): number {
    let total = 0;
    for (const waiting of this.queues.values()) total += waiting.length;
    return total;
  }

  private fill(lane: LaneReading): void {
    const waiting = this.waitingIn(lane.id);
    for (const slot of lane.slots) {
      if (this.busy.has(slot.id)) continue;
      // The head of the slot's own lane. Slots are interchangeable WITHIN a
      // lane, so the first task waiting is the one this slot may run; the lane
      // is what keeps two providers' pools apart.
      const task = waiting.shift();
      if (!task) return;
      this.start(task, slot);
    }
  }

  /**
   * A free slot on a serving lane whose own line is empty takes the head of
   * another lane OF ITS POOL - an urgent head first, then the busiest lane's.
   * Placement guesses how long work will take; this is what keeps a provider
   * that finished early from idling while its type's work waits elsewhere.
   * Never across pools: a Claude slot never runs a Codex task.
   */
  private steal(): void {
    for (const lane of this.lanes) {
      if (!this.isServing(lane.id) || this.waitingIn(lane.id).length > 0) continue;
      for (const slot of lane.slots) {
        if (this.busy.has(slot.id)) continue;
        const donor = this.lanes
          .filter((other) => other.id !== lane.id && other.pool === lane.pool && this.waitingIn(other.id).length > 0)
          .sort((a, b) => {
            const urgent = Number(this.isUrgent(this.waitingIn(b.id)[0])) - Number(this.isUrgent(this.waitingIn(a.id)[0]));
            return urgent || this.load(b.id) - this.load(a.id);
          })[0];
        if (!donor) return;
        const task = this.waitingIn(donor.id).shift()!;
        task.queue = lane.id;
        this.start(task, slot);
      }
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
    // The lane IS the provider, and the slot's lane is where it runs - which,
    // after a steal, is not the lane it waited in.
    task.queue = slot.queue;
    task.runningOn = slot.queue;
    task.ranOn = slot.queue;
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
      this.settle(
        task,
        'failed',
        describeError(new Error(`No runner is registered for "${task.kind}" tasks`), task)
      );
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
        // A cancelled run's rejection is the abort itself, which says nothing
        // the person who pressed Cancel does not already know.
        const said = cancelled ? CANCELLED_WHILE_RUNNING : describeError(error, task);
        if (!cancelled && !isFinalFailure(error) && this.retryTask(task, said)) {
          return;
        }
        this.settle(task, cancelled ? 'cancelled' : 'failed', said);
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
   * It goes on the TAIL of its tier (`enqueue`). A retry is not more urgent
   * than the work already waiting, and a task that fails fast at the head would
   * otherwise spin through its attempts while everything behind it waited -
   * but an urgent run's retry still goes ahead of the orders, or a single
   * failed attempt would drop a Generate Immediately behind all of them.
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
    this.enqueue([task]);
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
    this.batchFinished(batch);
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
        ...(task.ranOn ? { ranOn: task.ranOn } : {}),
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
