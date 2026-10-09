import {
  deleteBatchRow,
  loadBatchRows,
  pruneBatchRows,
  saveBatchRow,
  saveBatchWithTasks,
  saveTaskRow,
} from '../../database/generationRepository';
import { getProfile } from '../../database/profileRepository';
import { getAppSettings, isProviderEnabled } from '../../config/aiModelConfig';
import {
  currentProviders,
  providerTypeOf,
  resolveProviders,
  type ResolvedAIProvider,
} from '../../config/aiProviders';
import { getDatabasePath } from '../../database/sqlite';
import { AI_PROVIDER_IDS } from '../../config/providerCatalog';
import { checkProviderHealth, providerReadiness, providersNow } from '../ai';
import { closeIfSettled, refundTaskUnit } from '../credits';
import { recordTaskFinished, recordTaskStarted } from '../orders/orderTracking';
import { immediateTabGraceMs } from '../../config/operational';
import { TabLeases } from './tabLease';
import {
  registerTaskRunner,
  TaskQueue,
  type Batch,
  type CapacityReading,
  type LanePolicy,
  type LaneReading,
  type QueueName,
  type QueueStore,
  type Task,
  type TaskState,
} from './taskQueue';
import { makeResumeRunner, RESUME_TASK_KIND, type ResumeJob } from './resumeTask';

export { TaskQueue, registerTaskRunner, newBatchId } from './taskQueue';
export { TabLeases, type TabLeaseDeps, type TabLeaseState } from './tabLease';
export type {
  Assignment,
  Batch,
  BatchEvent,
  BatchSnapshot,
  BatchState,
  Capacity,
  CapacityReading,
  LanePolicy,
  LaneReading,
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
  RESUME_TASK_KIND,
  type ResumeJob,
  type ResumeTaskInput,
  type ResumeTaskPayload,
  type ResumeTaskResult,
} from './resumeTask';

/**
 * What the queue may run at once: one lane per PROVIDER (owner decision P3),
 * each as wide as that provider's `concurrency_max_requests`.
 *
 * A provider's slots are interchangeable WITHIN its lane, so they are just
 * counted out; each lane names its pool - its provider's type - which is how a
 * model's work is spread over every provider of its type (P4, `place` in
 * taskQueue.ts). Every provider is read, switched off or not, so a lane that
 * stops serving is still known for what it is and its waiting work can move.
 *
 * Re-read on every refresh (fifteen seconds while work waits, and at once
 * after an administrator edits a provider), which is what makes a limit live:
 * a lane grows or shrinks at the next reading, and the provider's semaphore is
 * resized in place by the registry.
 */
async function readCapacity(env: NodeJS.ProcessEnv = process.env): Promise<CapacityReading> {
  let providers: ResolvedAIProvider[];
  let typeRuns: (type: ResolvedAIProvider['type']) => boolean;
  try {
    const settings = await getAppSettings();
    providers = resolveProviders(settings.aiProviders, env);
    typeRuns = (type) => isProviderEnabled(type, settings);
  } catch {
    // A settings read that fails must not take every lane away: the last
    // list read, with each type taken as switched on.
    providers = currentProviders(getDatabasePath(), env);
    typeRuns = () => true;
  }

  const lanes: LaneReading[] = providers.map((provider) => ({
    id: provider.id,
    pool: provider.type,
    enabled: provider.enabled && typeRuns(provider.type),
    slots: Array.from({ length: provider.concurrency_max_requests }, (_, index) => ({
      id: `${provider.id}:${index}`,
      queue: provider.id,
    })),
  }));

  // A provider the last health check found signed out takes no work until a
  // check says otherwise; this is that check, at most once a minute each (the
  // adapter's own cache), and only while it is switched on.
  for (const provider of providers) {
    if (provider.enabled && providerReadiness(provider.id).ready === false) {
      void checkProviderHealth(provider.id).catch(() => undefined);
    }
  }
  return { lanes };
}

/**
 * What the dispatcher asks between readings. A provider is ready when its
 * adapter has no hold on the whole seat - nor, for a task, on the task's
 * model - and its last health check was not against it, all synchronous, so
 * the dispatch loop stays free of awaits.
 */
const lanePolicy: LanePolicy = {
  ready: (lane, model) => {
    const readiness = providerReadiness(lane, model);
    return readiness.ready !== false && !readiness.held;
  },
  modelOf: (task) => taskModelName(task.payload),
  poolOf: (lane) => providerTypeOf(lane),
};

/**
 * The model a resume task's tailoring runs on - its run's choice, which wins
 * over any prompt override (`runChoiceWins`) - as the provider is asked for
 * it: '' for a choice that leaves it to the provider's default. Undefined for
 * a payload with no choice at all, which is asked about the seat only.
 */
export function taskModelName(payload: unknown): string | undefined {
  const choice = (payload as { choice?: { modelName?: unknown } } | null | undefined)?.choice;
  if (!choice || typeof choice !== 'object') return undefined;
  return typeof choice.modelName === 'string' ? choice.modelName : '';
}

/** A provider's name for the log: the type id for a built-in, label and id for an added one. */
function describeProvider(id: string): string {
  const provider = providersNow().find((entry) => entry.id === id);
  return provider && !provider.builtIn ? `"${provider.label}" (${id})` : id;
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
      // WHOLE, which is what carries a resume's price (`payload.costMilli`)
      // and its job's stored analysis (`payload.analysisId`) across a
      // restart: a restored task that names its analysis never reaches the
      // analysis step again (PLAN check 1, row 3).
      payload: task.payload,
      ...(task.value !== undefined ? { value: task.value } : {}),
      ...(task.error ? { error: task.error } : {}),
      // The provider it last ran on, for an administrator (P3/P4): named here
      // and in the restore mapper, like every field of this projection.
      ...(task.ranOn ? { ranOn: task.ranOn } : {}),
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
let leases: TabLeases | null = null;

/**
 * The tab leases of every immediate run in the process (services/queue/
 * tabLease.ts), wired to the one queue: a lease that runs out cancels its
 * batch through `cancel`, which is what refunds what had not started.
 */
export function getTabLeases(): TabLeases {
  if (!leases) {
    leases = new TabLeases({
      cancel: (batchId) => getGenerationQueue().cancel(batchId),
      isRunning: (batchId) => getGenerationQueue().getBatch(batchId)?.state === 'running',
      graceMs: () => immediateTabGraceMs(),
    });
  }
  return leases;
}

/**
 * What a task was charged, in thousandths of a dollar, read back from its
 * payload - for the charge at submit (`chargeFor` sums these) and for the
 * refund when it does not deliver, so the two can never be worked out two
 * different ways.
 *
 * The snapshot when it carries a sane one, and $0 for a payload without one:
 * every resume task the queue makes carries `costMilli` (`buildTasks`), so
 * only a payload that is not a resume - the stub payloads the queue's own
 * tests run - reaches that branch, and nothing charged it.
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
      /** Moves an order's item from "waiting" to "being built", and records
       *  which provider builds it - an administrator's to read on the order. */
      taskStarted: (task) => {
        console.log(
          `[queue] ${task.label.profileName} / ${task.label.companyName} (task ${task.id}) is running on ` +
            `${describeProvider(task.queue)}${(task.attempts ?? 1) > 1 ? `, attempt ${task.attempts}` : ''}.`
        );
        recordTaskStarted(task);
      },
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
      /** A run that is over needs no lease: nothing is left for a timer to stop. */
      batchFinished: (batch) => {
        leases?.forget(batch.id);
      },
    },
    readMaxAttempts(),
    lanePolicy
    );
    registerTaskRunner(
      RESUME_TASK_KIND,
      makeResumeRunner(
        (batchId) => (queue?.getBatch(batchId)?.shared.jobs as ResumeJob[] | undefined) ?? undefined,
        (profileId) => getProfile(profileId),
        {
          ownerOf: (batchId) => {
            const owner = queue?.getBatch(batchId)?.shared.ownerId;
            return typeof owner === 'string' ? owner : null;
          },
          recorded: (batchId, jobIndex, analysisId) => recordJobAnalysis(batchId, jobIndex, analysisId),
        }
      )
    );
  }
  return queue;
}

/**
 * The first task of a job to obtain its analysis gives it to every task of
 * that job: `analysisId` on each payload, written to disk at once, so a
 * sibling profile's task, a retry and a task restored after a restart all
 * skip the analysis step. Never fatal - a task without it finds the analysis
 * in the store by its posting, still without a model call.
 */
function recordJobAnalysis(batchId: string, jobIndex: number, analysisId: string): void {
  const batch = queue?.getBatch(batchId);
  if (!batch) return;
  for (const task of batch.tasks) {
    const payload = task.payload as { jobIndex?: unknown; analysisId?: unknown } | null;
    if (!payload || payload.jobIndex !== jobIndex || payload.analysisId === analysisId) continue;
    payload.analysisId = analysisId;
    try {
      saveTaskRow(taskRow(task));
    } catch (error) {
      console.warn(`[queue] Could not record analysis ${analysisId} on task ${task.id}; it is found in the store instead.`, error);
    }
  }
}

/**
 * The capacity reading, exposed so the lane split can be asserted.
 *
 * Not a test seam for the dispatcher. It makes the reading callable with an
 * environment of the caller's choosing, which is the only way to pin that each
 * built-in provider's lane is sized from its own variable - and an added
 * provider's from its own `concurrency_max_requests`.
 */
export function readCapacityForTests(env: NodeJS.ProcessEnv): Promise<CapacityReading> {
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
 * What kind of run a batch is, on `shared.kind`:
 *
 * - `order` - placed with the Order button. Runs on the server whether or not
 *   anybody is watching, is filed on /orders, and no builder tab follows it.
 * - `immediate` - Generate Immediately. Tied to the tab that started it by a
 *   lease (tabLease.ts) and cancelled when that tab is gone; its tasks go
 *   ahead of orders in their lane (`urgent`); it has an `orders` row of kind
 *   `immediate` that /orders never lists, so its files are filed and
 *   owner-checked like an order's and deleted soon after it ends.
 *
 * Every batch the generation routes submit carries one. On `shared` because `shared` is persisted whole and read back whole by the
 * restore - a field there survives a restart with no projection to update.
 */
export const ORDER_BATCH_KIND = 'order';
export const IMMEDIATE_BATCH_KIND = 'immediate';

export type BatchKind = typeof ORDER_BATCH_KIND | typeof IMMEDIATE_BATCH_KIND;

/** True for a batch placed as an order: it is filed on /orders, and no builder tab follows it. */
export function isOrderBatch(batch: { shared: Record<string, unknown> }): boolean {
  return batch.shared.kind === ORDER_BATCH_KIND;
}

/** True for a Generate Immediately run: leased to its tab, ahead of orders in its lane. */
export function isImmediateBatch(batch: { shared: Record<string, unknown> }): boolean {
  return batch.shared.kind === IMMEDIATE_BATCH_KIND;
}

/** A batch's kind as a page reads it, or null for a batch that names neither (never one the routes submit). */
export function batchKind(batch: { shared: Record<string, unknown> }): BatchKind | null {
  return isOrderBatch(batch) ? ORDER_BATCH_KIND : isImmediateBatch(batch) ? IMMEDIATE_BATCH_KIND : null;
}

/**
 * Where `routeFor` sends new work on `provider`: the POOL of its type, named
 * by the type id - which is also the built-in provider's lane, so the queue
 * has somewhere to hold it before its first reading. The queue then places it
 * with whichever provider of the type has the most room (taskQueue.ts
 * `place`). Anything that is not a type - a damaged task row - goes to the
 * first seat's pool rather than nowhere, and fails there by name.
 */
export function laneFor(provider: unknown): QueueName {
  return providerTypeOf(provider) === provider ? (provider as QueueName) : AI_PROVIDER_IDS[0];
}

/**
 * The lane a restored task goes back in.
 *
 * Its stored lane when that is a provider this process has. Otherwise - a
 * provider removed since - the pool of the provider type the task was
 * resolved to, the way `routeFor` places new work; the queue then moves it to
 * a provider of that type.
 */
function restoredLane(stored: unknown, payload: unknown): QueueName {
  if (typeof stored === 'string' && providersNow().some((entry) => entry.id === stored)) return stored;
  return laneFor((payload as { choice?: { provider?: unknown } } | null | undefined)?.choice?.provider);
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

  // The providers as stored, before any lane is decided: a restored task stays
  // with its provider only if this process has that provider.
  await getAppSettings().catch(() => undefined);

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
        // `data` is the projection `taskRow` wrote, every field read as
        // possibly absent.
        const taskData = task.data as {
          queue?: unknown;
          label?: Task['label'];
          kind?: string;
          payload?: unknown;
          value?: unknown;
          error?: string;
          attempts?: number;
          ranOn?: unknown;
        };
        if (task.state === 'running') requeued += 1;
        entries.push({
          id: task.id,
          seq: task.seq,
          state: task.state as TaskState,
          queue: restoredLane(taskData.queue, taskData.payload),
          label: taskData.label ?? {
            profileId: '',
            profileName: 'Unknown',
            companyName: 'Unknown',
            role: '',
          },
          kind: taskData.kind ?? RESUME_TASK_KIND,
          // Whole, as `taskRow` wrote it: `costMilli` (what was charged) and
          // `analysisId` (the job's stored analysis, so this task does not
          // reach the analysis step again) come back with it.
          payload: taskData.payload,
          ...(taskData.value !== undefined ? { value: taskData.value } : {}),
          ...(taskData.error ? { error: taskData.error } : {}),
          ...(typeof taskData.ranOn === 'string' && taskData.ranOn ? { ranOn: taskData.ranOn } : {}),
          // Carried across the restart, so the attempts already spent still
          // count against the cap. A task requeued here is on its NEXT go,
          // not its first.
          ...(taskData.attempts ? { attempts: taskData.attempts } : {}),
        });
      }

      const shared = { ...(data.shared ?? {}) };

      // Restored under its OWN id, so the payloads still point at the right
      // batch for their jobs and the rows on disk stay the rows for this batch.
      const batch = restored.restore(
        {
          id: row.id,
          label: data.label ?? 'Generation',
          jobCount: data.jobCount ?? entries.length,
          shared,
          createdAt: data.createdAt ?? (Date.parse(row.createdAt) || Date.now()),
          // Decided from the kind, exactly as at submit: `urgent` itself is
          // not stored, because the kind already says it.
          urgent: isImmediateBatch({ shared }),
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
      // An immediate run lives only while a page follows it, and a restart
      // closed every connection there was. Its tab gets the usual grace to
      // reattach - a page whose stream reconnects after a quick restart
      // carries on - and a run whose tab is gone stops instead of building
      // for nobody.
      else if (isImmediateBatch(batch)) getTabLeases().arm(batch.id);
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
  leases?.reset();
  leases = null;
  queue?.resetForTests();
  queue = null;
}

