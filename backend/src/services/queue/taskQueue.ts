import { randomUUID } from 'crypto';
import type { BrowserChatSiteId } from '../../config/providerCatalog';

/**
 * The queues the server runs generation out of.
 *
 * A TASK is one resume. A request to generate ten resumes appends ten tasks to
 * the tail of a queue and returns; browsers take tasks off the head as they free
 * up, until the queue is empty. The request is a way to SUBMIT work, not the
 * thing that performs it - which is what lets a batch outlive the page that
 * started it.
 *
 * Two queues, because there are two resources. Every debug browser draws from
 * the browser queue whichever site it is showing; the Claude CLI seat draws from
 * its own, at its own concurrency. A stalled seat cannot hold up the browsers,
 * and browser work cannot starve the seat.
 *
 * Why a dispatcher at all, when the tab pool already has a FIFO waiter list: a
 * call queued at the pool is ALREADY RUNNING ITS OWN CLOCK. `browserChat/index`
 * bounds a tab wait at `min(deadline.remainingMs(), 10 minutes)`, and a
 * tailoring call takes minutes - so dropping thirty tasks straight onto the pool
 * has tasks four through thirty time out while the first three are still being
 * answered. This queue exists to hold work whose clock has NOT started. The pool
 * stays underneath as the guarantee that one browser serves one call.
 */

export type QueueName = 'browser' | 'cli';

/**
 * One unit of capacity: one debug browser, or one CLI process slot.
 *
 * A list rather than a count, because the browser queue's capacity is not a
 * number - it is a multiset of SITES. Two Claude browsers and one ChatGPT
 * browser is three slots, and which of them is free decides which queued tasks
 * are eligible. A bare count of three would hand a Claude-only task to the
 * ChatGPT browser.
 */
export type Slot = {
  id: string;
  queue: QueueName;
  /** Which site this browser shows. Absent for a CLI slot. */
  site?: BrowserChatSiteId;
};

export type Capacity = {
  browser: Slot[];
  cli: Slot[];
};

export type TaskState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** What a task is told when it starts: which browser is running it. */
export type Assignment = {
  queue: QueueName;
  site?: BrowserChatSiteId;
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
  /**
   * Which sites may run this task, for the browser queue.
   *
   * The profile's model choice, kept as a real constraint: "Claude (free)" means
   * a Claude browser, and a ChatGPT browser that happens to be idle must not
   * quietly take it. Hybrid lists both, which is what lets it go to whichever
   * frees up first.
   */
  sites?: BrowserChatSiteId[];
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
  tasks: Array<
    TaskLabel & {
      id: string;
      seq: number;
      state: TaskState;
      runningOn?: string;
      error?: string;
    }
  >;
};

export type BatchEvent =
  | { type: 'task'; batchId: string; taskId: string; snapshot: BatchSnapshot }
  | { type: 'done'; batchId: string; snapshot: BatchSnapshot };

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

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class TaskQueue {
  /**
   * One array per queue, and THE ORDER IS THE CONTRACT. A task submitted later
   * never runs before one submitted earlier that an idle browser could take.
   */
  private readonly queues: Record<QueueName, Task[]> = { browser: [], cli: [] };

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
   * it - two turns typed into one composer, which is the single failure this
   * class exists to prevent. Reading capacity is a settings-database call, so it
   * happens out here instead, and the loop only ever reads a plain field.
   */
  private capacity: Capacity = { browser: [], cli: [] };
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
    private readonly store?: QueueStore
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
   * Re-reads how many browsers there are, then dispatches.
   *
   * Called on submit and whenever the reading goes stale, so an operator who
   * starts a third browser sees the queue widen without restarting the server.
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
    meta: { label?: string; jobCount?: number; shared?: Record<string, unknown> } = {}
  ): Batch<T> {
    const batchId = `bat_${randomUUID()}`;
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
      this.queues[task.queue].push(task as Task);
    }

    this.persist((store) => {
      store.saveBatch(batch as Batch);
      for (const task of tasks) store.saveTask(task as Task);
    });

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
   * failed would mean a restart silently dropped whatever happened to be in a
   * browser at the time.
   */
  restore<T>(
    meta: { id: string; label: string; jobCount: number; shared: Record<string, unknown>; createdAt: number },
    entries: Array<TaskDescriptor<T> & { id: string; seq: number; state: TaskState; value?: T; error?: string }>
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
      if (task.state === 'queued') this.queues[task.queue].push(task as Task);
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
   * cancel is to get the browsers back.
   */
  cancel(batchId: string): { cancelled: number; aborted: number } | null {
    const batch = this.batches.get(batchId);
    if (!batch || batch.state !== 'running') return null;

    let cancelled = 0;
    let aborted = 0;
    for (const task of batch.tasks) {
      if (task.state === 'queued') {
        task.state = 'cancelled';
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

  /** What the dispatcher is doing right now, for the admin page and the logs. */
  stats(): Record<QueueName, { queued: number; running: number; width: number }> {
    const running: Record<QueueName, number> = { browser: 0, cli: 0 };
    for (const task of this.busy.values()) running[task.queue] += 1;
    return {
      browser: {
        queued: this.queues.browser.length,
        running: running.browser,
        width: this.capacity.browser.length,
      },
      cli: {
        queued: this.queues.cli.length,
        running: running.cli,
        width: this.capacity.cli.length,
      },
    };
  }

  /** Tests share one process; a queue left running would leak into the next. */
  resetForTests(): void {
    for (const batch of this.batches.values()) batch.controller.abort();
    this.queues.browser = [];
    this.queues.cli = [];
    this.batches.clear();
    this.busy.clear();
    this.listeners.clear();
    this.capacity = { browser: [], cli: [] };
    this.capacityReadAt = 0;
    this.dispatching = false;
    this.dispatchAgain = false;
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
        this.failUnservable();
        this.fill(this.capacity.browser);
        this.fill(this.capacity.cli);
      } while (this.dispatchAgain);
    } finally {
      this.dispatching = false;
    }

    // Outside the loop, and never awaited from inside it.
    if (Date.now() - this.capacityReadAt > CAPACITY_TTL_MS && this.pending() > 0) {
      void this.refreshCapacity();
    }
  }

  private pending(): number {
    return this.queues.browser.length + this.queues.cli.length;
  }

  private fill(slots: Slot[]): void {
    for (const slot of slots) {
      if (this.busy.has(slot.id)) continue;
      const task = this.takeEligible(slot);
      if (!task) continue;
      this.start(task, slot);
    }
  }

  /**
   * The first queued task THIS SLOT may run - not simply the first queued task.
   *
   * A Claude-only task at the head does not stop a ChatGPT browser taking a
   * later one it can run; it waits for a Claude browser instead. That is the
   * whole of what "one browser queue, but the model choice still counts" means.
   */
  private takeEligible(slot: Slot): Task | undefined {
    const queue = this.queues[slot.queue];
    const index = queue.findIndex((task) => this.eligible(task, slot));
    if (index < 0) return undefined;
    return queue.splice(index, 1)[0];
  }

  private eligible(task: Task, slot: Slot): boolean {
    if (task.queue !== slot.queue) return false;
    if (slot.queue === 'cli') return true;
    if (!task.sites || task.sites.length === 0) return true;
    return Boolean(slot.site && task.sites.includes(slot.site));
  }

  /**
   * Fails tasks no registered browser could ever run.
   *
   * A Claude-only task on an install with only ChatGPT browsers is eligible for
   * nothing. Left alone it sits in the queue for ever while later tasks pass it,
   * and the batch never finishes - a hang, with no error anywhere to explain it.
   * Saying so names the two things that actually cause it: a browser that was
   * never started, or a profile pointed at a platform this install does not run.
   */
  private failUnservable(): void {
    // Only once a capacity reading exists. Before the first one every task looks
    // unservable, and failing the batch a millisecond after submitting it would
    // be a spectacular own goal.
    if (this.capacityReadAt === 0) return;

    const servable = new Set(
      this.capacity.browser.map((slot) => slot.site).filter(Boolean) as BrowserChatSiteId[]
    );
    const queue = this.queues.browser;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const task = queue[index];
      const sites = task.sites ?? [];
      if (sites.length === 0 || sites.some((site) => servable.has(site))) continue;
      queue.splice(index, 1);
      this.settle(
        task,
        'failed',
        `No running browser can generate this resume: it is set to ${sites.join(' or ')}, and ` +
          (servable.size === 0
            ? 'no debug browser is registered. Run `npm run browser:debug`, then register its port ' +
              'under Admin -> Settings -> Browser Chat.'
            : `only ${[...servable].join(' and ')} ${servable.size === 1 ? 'is' : 'are'} registered.`)
      );
    }
  }

  private start(task: Task, slot: Slot): void {
    const batch = this.batches.get(task.batchId);
    if (!batch || batch.state !== 'running') {
      this.settle(task, 'cancelled', 'The batch was cancelled');
      return;
    }

    task.state = 'running';
    task.runningOn = slot.site ?? 'claude-cli';
    this.busy.set(slot.id, task);
    this.persist((store) => store.saveTask(task));
    this.emitTask(task);

    const release = () => {
      this.busy.delete(slot.id);
      // The only thing that can let a queued task start is a slot coming free.
      this.dispatch();
    };

    // Every rejection is caught HERE. There is no HTTP request left to absorb an
    // unhandled one, and Node's default policy for an unhandled rejection is to
    // take the process down - so a single failed resume would stop the server.
    void (async () => {
      try {
        const runner = runners.get(task.kind);
        if (!runner) {
          // A kind nothing registered. Only reachable for a task restored from
          // a build that knew a kind this one does not, and failing it by name
          // beats it sitting queued for ever.
          throw new Error(`No runner is registered for "${task.kind}" tasks`);
        }
        task.value = await runner(task.payload, {
          queue: slot.queue,
          site: slot.site,
          signal: batch.controller.signal,
        });
        this.settle(task, 'done');
      } catch (error) {
        this.settle(
          task,
          batch.controller.signal.aborted ? 'cancelled' : 'failed',
          describeError(error)
        );
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

  private settle(task: Task, state: TaskState, error?: string): void {
    task.state = state;
    task.runningOn = undefined;
    if (error) task.error = error;
    this.persist((store) => store.saveTask(task));
    this.emitTask(task);

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
      createdAt: new Date(batch.createdAt).toISOString(),
      ...(batch.finishedAt ? { finishedAt: new Date(batch.finishedAt).toISOString() } : {}),
      tasks: batch.tasks.map((task) => ({
        ...task.label,
        id: task.id,
        seq: task.seq,
        state: task.state,
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
