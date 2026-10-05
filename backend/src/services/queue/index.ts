import {
  deleteBatchRow,
  loadBatchRows,
  pruneBatchRows,
  saveBatchRow,
  saveBatchWithTasks,
  saveTaskRow,
} from '../../database/generationRepository';
import { orderExistsForBatch } from '../../database/orderRepository';
import { getProfile } from '../../database/profileRepository';
import { cliConcurrency, codexConcurrency } from '../ai/batchCapacity';
import { geminiCliConcurrency } from '../ai/providers/geminiCli/options';
import { closeIfSettled, refundTaskUnit } from '../credits';
import { recordTaskFinished, recordTaskStarted } from '../orders/orderTracking';
import {
  isQueueName,
  registerTaskRunner,
  TaskQueue,
  type Batch,
  type Capacity,
  type QueueName,
  type QueueStore,
  type Slot,
  type Task,
  type TaskState,
} from './taskQueue';
import type { AiChoice } from '../../config/aiPreferences';
import {
  currentChoice,
  makeResumeRunner,
  namesRetiredProvider,
  RESUME_TASK_KIND,
  type ResumeJob,
} from './resumeTask';

export { TaskQueue, registerTaskRunner, newBatchId, isQueueName, QUEUE_NAMES, LANE_PROVIDER } from './taskQueue';
export type {
  Assignment,
  Batch,
  BatchEvent,
  BatchSnapshot,
  BatchState,
  Capacity,
  QueueName,
  QueueStore,
  Slot,
  Task,
  TaskDescriptor,
  TaskLabel,
  TaskState,
} from './taskQueue';
export {
  runResumeTask,
  makeResumeRunner,
  resetResumeTaskStateForTests,
  RESUME_TASK_KIND,
  type ResumeJob,
  type ResumeTaskInput,
  type ResumeTaskPayload,
  type ResumeTaskResult,
} from './resumeTask';

/**
 * What the queue may run at once: one slot per real resource.
 *
 * A seat's slots are interchangeable WITHIN its lane, so they are just counted
 * out - but each CLI provider gets its OWN lane, sized from its own variable.
 * They hold separate semaphores, so one shared lane would either strand the
 * larger pool or let the smaller one's blocked tasks squat on slots the other
 * provider's work needs.
 *
 * Read from the environment alone, with no settings read: nothing an
 * administrator saves changes how many processes a seat may run.
 */
async function readCapacity(env: NodeJS.ProcessEnv = process.env): Promise<Capacity> {
  // `cli` is the Claude seat's lane, sized like its semaphore.
  const cli: Slot[] = Array.from({ length: cliConcurrency(env) }, (_, index) => ({
    id: `cli:${index}`,
    queue: 'cli' as const,
  }));

  const codex: Slot[] = Array.from({ length: codexConcurrency(env) }, (_, index) => ({
    id: `codex:${index}`,
    queue: 'codex' as const,
  }));

  // The Gemini seat's, from the same reader its adapter sizes its semaphore with.
  const gemini: Slot[] = Array.from({ length: geminiCliConcurrency(env) }, (_, index) => ({
    id: `gemini:${index}`,
    queue: 'gemini' as const,
  }));

  return { cli, codex, gemini };
}

/** The batch's serializable half: everything but the tasks and the controller. */
function batchRow(batch: Batch) {
  return {
    id: batch.id,
    state: batch.state,
    data: {
      label: batch.label,
      jobCount: batch.jobCount,
      shared: batch.shared,
      createdAt: batch.createdAt,
      ...(batch.finishedAt ? { finishedAt: batch.finishedAt } : {}),
    },
  };
}

function taskRow(task: Task) {
  return {
    id: task.id,
    batchId: task.batchId,
    seq: task.seq,
    state: task.state,
    data: {
      queue: task.queue,
      label: task.label,
      kind: task.kind,
      payload: task.payload,
      ...(task.value !== undefined ? { value: task.value } : {}),
      ...(task.error ? { error: task.error } : {}),
      /*
       * The attempt counter, and it has to be written EXPLICITLY.
       *
       * `data` is a projection, not the task - so a field added to `Task` does
       * not reach the disk by being there. Leaving this out made the retry cap
       * unbounded in the one case the on-disk queue exists for: a task that was
       * mid-build when the process died came back with no counter, `start` read
       * it as attempt 1, and a crash-looping job got a fresh budget every boot.
       */
      ...(task.attempts && task.attempts > 1 ? { attempts: task.attempts } : {}),
    },
  };
}

const store: QueueStore = {
  saveBatch: (batch) => saveBatchRow(batchRow(batch)),
  saveTask: (task) => saveTaskRow(taskRow(task)),
  deleteBatch: (batchId) => deleteBatchRow(batchId),
};

let queue: TaskQueue | null = null;

/**
 * What a task was charged, in thousandths of a dollar, read back from its
 * payload - for the charge at submit (`chargeFor` sums these) and for the
 * refund when it does not deliver, so the two can never be worked out two
 * different ways.
 *
 * The snapshot when it carries a sane one. A payload WITHOUT one is $0, and
 * that is a decision, not a gap:
 *
 *   - a task queued before credits became dollars was paid for in credits,
 *     and the reset cleared every credit. It finishes on that payment - not
 *     charged again in dollars - and if it fails, what it would give back was
 *     reset with the balance, so it gives back nothing. The switch writes
 *     `costMilli: 0` on such a task explicitly; this is the same answer for
 *     one it could not reach. Its `creditCost` (whole credits) is never read
 *     as money: one credit read as one thousandth would be a refund nobody
 *     was charged, and the reservation it would refund into was closed by the
 *     switch anyway.
 *   - every task the queue makes now carries `costMilli` (`buildTasks`), so
 *     nothing new reaches this branch; the stub payloads the queue's own tests
 *     run are not resumes and are not charged.
 *
 * Never re-priced from the model: see ResumeTaskPayload.costMilli.
 */
export function taskCostMilli(payload: unknown): number {
  const cost = (payload as { costMilli?: unknown } | null | undefined)?.costMilli;
  return typeof cost === 'number' && Number.isSafeInteger(cost) && cost >= 0 ? cost : 0;
}

/**
 * The one queue, shared by every request in the process.
 *
 * Process-wide is the whole point: two pages submitting batches must end up in
 * ONE line for each seat, not two lines that each believe they have the run of
 * the place.
 */
/**
 * How many times one resume may be BUILT before it is given up on.
 *
 * Counts the first go, so 3 means "try, then twice more" and 1 means no
 * retrying at all. Spelled that way round because "at most 3" is ambiguous and
 * an operator setting it must not have to guess which reading this file took.
 *
 * Capped rather than trusted: a large number here would keep one broken job
 * cycling through the queue for hours, holding a slot each time, and the thing
 * it is competing with is other people's resumes.
 */
function readMaxAttempts(): number {
  const raw = Number.parseInt((process.env.GENERATION_MAX_ATTEMPTS ?? '').trim(), 10);
  if (!Number.isFinite(raw)) return 3;
  return Math.min(10, Math.max(1, raw));
}

export function getGenerationQueue(): TaskQueue {
  if (!queue) {
    queue = new TaskQueue(() => readCapacity(), store, {
      /** Moves an order's item from "waiting" to "being built". A no-op for
       *  every batch that was not placed as an order, which is most of them. */
      taskStarted: (task) => recordTaskStarted(task),
      /**
       * Gives back what each unit that did not deliver was charged.
       *
       * The hook needs no identity plumbing at all: a reservation's id IS the
       * batch id, and it carries the account. That is why there is no user id on
       * the task payload and no owner column on generation_tasks - the one thing
       * a refund needs, it already has in `task.batchId`.
       *
       * What it gives back is the unit's own snapshotted price (`taskCostMilli`),
       * not its model's price now - a batch can mix models at different prices,
       * and an administrator can reprice one while the batch runs.
       *
       * A task that reached 'done' wrote a file, so its credit is spent and
       * stays spent. Note the asymmetry with the line below: a unit that FAILED
       * after writing a partial file is still refunded, because a half-finished
       * run is not a deliverable. An abort that lands after the file was written
       * arrives here as 'done' and is correctly kept.
       */
      taskFinished: (task) => {
        // A task that delivered keeps its credit; one that did not gives it
        // back. Either way the batch may now be finished, so the close check
        // below runs for BOTH - skipping it for 'done' would leave a fully
        // successful batch holding its credits until the reconciler swept them
        // back hours later, which is to say it would eventually make a
        // successful run free.
        if (task.state !== 'done') {
          refundTaskUnit(
            task.batchId,
            task.id,
            taskCostMilli(task.payload),
            `${task.label.profileName} / ${task.label.companyName}: ${task.state}`
          );
        }
        // After the refund, and never before it: this writes to a different
        // table and swallows its own failures, but the credit is the thing a
        // person notices missing, so it goes first.
        recordTaskFinished(task);

        const batch = queue?.getBatch(task.batchId);
        closeIfSettled(
          task.batchId,
          batch
            ? {
                queued: batch.tasks.filter((entry) => entry.state === 'queued').length,
                running: batch.tasks.filter((entry) => entry.state === 'running').length,
              }
            : null
        );
      },
    },
    readMaxAttempts()
    );
    registerTaskRunner(
      RESUME_TASK_KIND,
      makeResumeRunner(
        (batchId) => (queue?.getBatch(batchId)?.shared.jobs as ResumeJob[] | undefined) ?? undefined,
        (profileId) => getProfile(profileId)
      )
    );
  }
  return queue;
}

/**
 * The capacity reading, exposed so the lane split can be asserted.
 *
 * Not a test seam for the dispatcher. It makes the reading callable with an
 * environment of the caller's choosing, which is the only way to pin that the
 * three CLI lanes are sized from three different variables.
 */
export function readCapacityForTests(env: NodeJS.ProcessEnv): Promise<Capacity> {
  return readCapacity(env);
}

/**
 * Saves a whole submission in one transaction.
 *
 * Used instead of the queue's own per-row writes at submit time: thirty tasks is
 * thirty statements, and a batch that half-landed because the process died
 * mid-loop would come back with tasks whose batch does not exist.
 */
export function persistNewBatch(batch: Batch): void {
  saveBatchWithTasks(batchRow(batch), batch.tasks.map(taskRow));
}

/** How long a finished batch is kept on disk. Matches the queue's own retention. */
const KEEP_FINISHED_MS = 60 * 60_000;

export type RestoreReport = {
  batches: number;
  requeued: number;
  pruned: number;
  /**
   * Every batch this restore put back, by id - which is also its credit
   * reservation's id. The boot reconciler leaves these alone: their tasks are
   * about to run again (or have just been settled here), and releasing the
   * reservation as abandoned would build the rest of the run for free.
   */
  batchIds: string[];
};

/**
 * What kind of run a batch is, on `shared.kind`. Only `order` is written for
 * now; a batch without one is a run the builder started and follows.
 *
 * On `shared` because `shared` is persisted whole and read back whole by the
 * restore - a field there survives a restart with no projection to update.
 */
export const ORDER_BATCH_KIND = 'order';

/** True for a batch placed as an order: it is filed on /orders, and no builder tab follows it. */
export function isOrderBatch(batch: { shared: Record<string, unknown> }): boolean {
  return batch.shared.kind === ORDER_BATCH_KIND;
}

/**
 * The lane `routeFor` gives new work on `provider`: each seat's own, and `cli`
 * for anything else - a retired provider on a choice stored before the
 * upgrade, which the restore resolves again before it runs.
 */
export function laneFor(provider: unknown): QueueName {
  if (provider === 'codex-cli') return 'codex';
  if (provider === 'gemini-cli') return 'gemini';
  return 'cli';
}

/**
 * The lane a restored task goes back in.
 *
 * Its stored lane, when this build has it. Otherwise - a lane from an earlier
 * build (the browser chat providers had one of their own), no lane at all, or
 * anything unrecognisable - the lane is worked out again from the provider the
 * task was resolved to, the way `routeFor` places new work.
 */
function restoredLane(stored: unknown, payload: unknown): QueueName {
  if (isQueueName(stored)) return stored;
  return laneFor((payload as { choice?: { provider?: unknown } } | null | undefined)?.choice?.provider);
}

/**
 * The payload of a task that will run, with a choice naming a removed provider
 * resolved again from its profile - and so the lane it belongs in.
 *
 * Done HERE, before the task is placed, rather than only when it starts. The
 * lane is the provider's resource: placed by the stale provider, a task that
 * now resolves to the Codex seat would sit in a Claude-seat slot, report that
 * seat as what it runs on, and queue at the Codex semaphore with its deadline
 * already running - beside the Codex lane's own work, past the limit the lane
 * split exists to keep. The fresh choice is written back with the batch, so a
 * second restart reads it as stored.
 *
 * Resolved once per profile, which is what a batch's tasks usually share. A
 * profile that cannot be read leaves the task as it was: the runner resolves it
 * again at start, or reports the profile missing, which is its job.
 */
async function refreshRetiredChoice(
  payload: unknown,
  resolved: Map<string, Promise<AiChoice | null>>
): Promise<{ payload: unknown; lane: QueueName } | null> {
  const stored = payload as { profileId?: unknown; choice?: unknown } | null | undefined;
  if (!stored || typeof stored.profileId !== 'string' || !namesRetiredProvider(stored.choice)) return null;
  const profileId = stored.profileId;
  const storedChoice = stored.choice;

  let pending = resolved.get(profileId);
  if (!pending) {
    pending = (async () => {
      const profile = getProfile(profileId);
      return profile ? currentChoice(storedChoice, profile) : null;
    })().catch(() => null);
    resolved.set(profileId, pending);
  }
  const choice = await pending;
  if (!choice) return null;
  return { payload: { ...stored, choice }, lane: laneFor(choice.provider) };
}

/**
 * Puts the queue back together after a restart.
 *
 * Two things need saying about what this does with tasks that were RUNNING when
 * the process died. They are requeued, not failed: nothing completed them, so
 * their resume does not exist, and leaving them failed would mean a restart
 * silently dropped whatever happened to be running at the time. Requeueing
 * costs one repeated model call, which is the cheapest of the honest options.
 *
 * It is safe to repeat because the output path is derived from the profile, the
 * company and the row - so a re-run overwrites the same files rather than adding
 * a second copy. The one exception worth knowing is a restart that crosses
 * midnight, where the date folder in the path changes and the earlier partial
 * output stays where it was.
 *
 * Each batch is restored on its own. One that cannot be - a row this build
 * cannot make sense of - is reported by id and left as it was, and every other
 * batch still comes back: a single bad row used to end the loop and lose the
 * batches after it too, holding their credits until the reconciler gave up on
 * them hours later.
 *
 * Never rejects. A queue that could not be restored must not stop the server
 * from starting - the admin pages are how an operator would find out why.
 */
export async function restoreGenerationQueue(): Promise<RestoreReport> {
  const report: RestoreReport = { batches: 0, requeued: 0, pruned: 0, batchIds: [] };

  let rows: ReturnType<typeof loadBatchRows>;
  let restored: TaskQueue;
  try {
    report.pruned = pruneBatchRows(new Date(Date.now() - KEEP_FINISHED_MS).toISOString());
    rows = loadBatchRows();
    restored = getGenerationQueue();
  } catch (error) {
    console.warn(
      '[queue] Could not restore the generation queue after restart; anything queued before is ' +
        'lost. ' + (error instanceof Error ? error.message : String(error))
    );
    return report;
  }

  const resolvedChoices = new Map<string, Promise<AiChoice | null>>();
  for (const row of rows) {
    if (row.state !== 'running') continue;
    if (row.tasks.length === 0) continue;

    try {
      const data = row.data as {
        label?: string;
        jobCount?: number;
        shared?: Record<string, unknown>;
        createdAt?: number;
      };

      // EVERY task, not only the unfinished ones. A batch of thirty with eight
      // already built must come back as a batch of thirty with eight built -
      // restoring only the remainder would shrink its total and drop the
      // finished resumes out of its results.
      let requeued = 0;
      const entries = [];
      for (const task of [...row.tasks].sort((a, b) => a.seq - b.seq)) {
        // `data` is whatever the build that wrote it projected, so every field
        // is read as possibly absent. An earlier build also wrote a list of
        // chat sites here; it is not read, and the next write drops it.
        const taskData = task.data as {
          queue?: unknown;
          label?: Task['label'];
          kind?: string;
          payload?: unknown;
          value?: unknown;
          error?: string;
          attempts?: number;
        };
        if (task.state === 'running') requeued += 1;
        // Only work that will run again needs a model it can run on; a
        // finished task keeps the choice it was built with. Awaited only for
        // a choice that needs it, so a restore with none - every one, once the
        // upgrade's own queue has drained - finishes before any request can
        // queue work ahead of it, as it did when it was synchronous.
        const refreshed =
          (task.state === 'queued' || task.state === 'running') &&
          namesRetiredProvider((taskData.payload as { choice?: unknown } | null | undefined)?.choice)
            ? await refreshRetiredChoice(taskData.payload, resolvedChoices)
            : null;
        entries.push({
          id: task.id,
          seq: task.seq,
          state: task.state as TaskState,
          queue: refreshed ? refreshed.lane : restoredLane(taskData.queue, taskData.payload),
          label: taskData.label ?? {
            profileId: '',
            profileName: 'Unknown',
            companyName: 'Unknown',
            role: '',
          },
          kind: taskData.kind ?? RESUME_TASK_KIND,
          payload: refreshed ? refreshed.payload : taskData.payload,
          ...(taskData.value !== undefined ? { value: taskData.value } : {}),
          ...(taskData.error ? { error: taskData.error } : {}),
          // Carried across the restart, so the attempts already spent still
          // count against the cap. A task requeued here is on its NEXT go,
          // not its first.
          ...(taskData.attempts ? { attempts: taskData.attempts } : {}),
        });
      }

      // An order queued before batches carried their kind: the orders table
      // still knows, and the builder must not take it for a run of its own.
      // Written back with the batch below, so this is asked once.
      const shared = { ...(data.shared ?? {}) };
      if (shared.kind === undefined && orderExistsForBatch(row.id)) shared.kind = ORDER_BATCH_KIND;

      // Restored under its OWN id, so the payloads still point at the right
      // batch for their jobs and the rows on disk stay the rows for this batch.
      const batch = restored.restore(
        {
          id: row.id,
          label: data.label ?? 'Generation',
          jobCount: data.jobCount ?? entries.length,
          shared,
          createdAt: data.createdAt ?? (Date.parse(row.createdAt) || Date.now()),
        },
        entries
      );
      report.batches += 1;
      report.requeued += requeued;
      report.batchIds.push(row.id);
      // Every task had finished before the process stopped, but it stopped
      // before the last one closed the run's reservation. Closed now, exactly
      // as the `taskFinished` hook would have: each unit that did not deliver
      // gets its own price back (keyed on the task, so one already refunded
      // is not refunded twice), and what delivered stays spent. Left open, it
      // would wait for the reconciler, which releases everything outstanding -
      // the finished resumes included.
      if (batch.state !== 'running') settleRestoredBatch(batch as Batch);
      // Written back once, so the requeued tasks are queued on disk too - a
      // second restart must not count them as mid-flight all over again. Its
      // own catch, because the batch is back in the queue and running by now,
      // and a failed write must not be reported as a batch that was not.
      try {
        persistNewBatch(batch as Batch);
      } catch (error) {
        console.warn(
          `[queue] Restored batch ${row.id}, but could not write it back to the database; its ` +
            'running resumes will be counted as mid-flight again after another restart. ' +
            (error instanceof Error ? error.message : String(error))
        );
      }
    } catch (error) {
      console.warn(
        `[queue] Could not restore batch ${row.id} after restart; the other batches are unaffected. ` +
          (error instanceof Error ? error.message : String(error))
      );
    }
  }

  if (report.batches > 0) {
    console.log(
      `[queue] Restored ${report.batches} unfinished batch(es) after restart: ` +
        `${report.requeued} resume(s) were mid-flight and will be built again.`
    );
  }
  return report;
}

/** The `taskFinished` hook's accounting, for a batch the restore found already finished. */
function settleRestoredBatch(batch: Batch): void {
  try {
    for (const task of batch.tasks) {
      if (task.state === 'done') continue;
      refundTaskUnit(
        batch.id,
        task.id,
        taskCostMilli(task.payload),
        `${task.label.profileName} / ${task.label.companyName}: ${task.state}`
      );
    }
    closeIfSettled(batch.id, { queued: 0, running: 0 });
  } catch (error) {
    console.warn(
      `[queue] Restored batch ${batch.id} had finished, but its credits could not be settled. ` +
        (error instanceof Error ? error.message : String(error))
    );
  }
}

/** Tests share one process; a queue left running would leak into the next. */
export function resetGenerationQueueForTests(): void {
  queue?.resetForTests();
  queue = null;
}

