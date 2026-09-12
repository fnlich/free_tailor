import { getBrowserChatEndpoints } from '../../config/aiModelConfig';
import {
  deleteBatchRow,
  loadBatchRows,
  pruneBatchRows,
  saveBatchRow,
  saveBatchWithTasks,
  saveTaskRow,
} from '../../database/generationRepository';
import { getProfile } from '../../database/profileRepository';
import { cliConcurrency } from '../ai/batchCapacity';
import type { BrowserChatSiteId } from '../../config/providerCatalog';
import {
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
import { makeResumeRunner, RESUME_TASK_KIND, type ResumeJob } from './resumeTask';

export { TaskQueue, registerTaskRunner } from './taskQueue';
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
 * A slot per REGISTERED BROWSER, carrying which site it shows, rather than a
 * count - the browser queue's capacity is a multiset, not a number. Two Claude
 * browsers and one ChatGPT browser is three slots, and which of them is free is
 * what decides whether a Claude-pinned task may start.
 *
 * The CLI seat's slots are interchangeable, so they are just counted out.
 */
async function readCapacity(env: NodeJS.ProcessEnv = process.env): Promise<Capacity> {
  const endpoints = await getBrowserChatEndpoints();
  const browser: Slot[] = endpoints.map((entry) => ({
    // Keyed on the PORT, so the same browser keeps the same slot identity across
    // readings. A slot id that changed each time would let the dispatcher hand
    // work to a browser it already had busy.
    id: `browser:${entry.port}`,
    queue: 'browser' as const,
    site: entry.siteId,
  }));

  const cli: Slot[] = Array.from({ length: cliConcurrency(env) }, (_, index) => ({
    id: `cli:${index}`,
    queue: 'cli' as const,
  }));

  return { browser, cli };
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
      ...(task.sites ? { sites: task.sites } : {}),
      label: task.label,
      kind: task.kind,
      payload: task.payload,
      ...(task.value !== undefined ? { value: task.value } : {}),
      ...(task.error ? { error: task.error } : {}),
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
 * The one queue, shared by every request in the process.
 *
 * Process-wide is the whole point: two pages submitting batches must end up in
 * ONE line for the browsers, not two lines that each believe they have the run
 * of the place.
 */
export function getGenerationQueue(): TaskQueue {
  if (!queue) {
    queue = new TaskQueue(() => readCapacity(), store);
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
};

/**
 * Puts the queue back together after a restart.
 *
 * Two things need saying about what this does with tasks that were RUNNING when
 * the process died. They are requeued, not failed: nothing completed them, so
 * their resume does not exist, and leaving them failed would mean a restart
 * silently dropped whatever happened to be in a browser at the time. Requeueing
 * costs one repeated browser turn, which is the cheapest of the honest options.
 *
 * It is safe to repeat because the output path is derived from the profile, the
 * company and the row - so a re-run overwrites the same files rather than adding
 * a second copy. The one exception worth knowing is a restart that crosses
 * midnight, where the date folder in the path changes and the earlier partial
 * output stays where it was.
 *
 * Never throws. A queue that could not be restored must not stop the server from
 * starting - the admin pages are how an operator would find out why.
 */
export function restoreGenerationQueue(): RestoreReport {
  const report: RestoreReport = { batches: 0, requeued: 0, pruned: 0 };
  try {
    report.pruned = pruneBatchRows(new Date(Date.now() - KEEP_FINISHED_MS).toISOString());

    const rows = loadBatchRows();
    const restored = getGenerationQueue();

    for (const row of rows) {
      if (row.state !== 'running') continue;
      if (row.tasks.length === 0) continue;

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
      const entries = [...row.tasks]
        .sort((a, b) => a.seq - b.seq)
        .map((task) => {
          const taskData = task.data as {
            queue?: QueueName;
            sites?: BrowserChatSiteId[];
            label?: Task['label'];
            kind?: string;
            payload?: unknown;
            value?: unknown;
            error?: string;
          };
          if (task.state === 'running') report.requeued += 1;
          return {
            id: task.id,
            seq: task.seq,
            state: task.state as TaskState,
            queue: taskData.queue ?? ('browser' as QueueName),
            ...(taskData.sites ? { sites: taskData.sites } : {}),
            label: taskData.label ?? {
              profileId: '',
              profileName: 'Unknown',
              companyName: 'Unknown',
              role: '',
            },
            kind: taskData.kind ?? RESUME_TASK_KIND,
            payload: taskData.payload,
            ...(taskData.value !== undefined ? { value: taskData.value } : {}),
            ...(taskData.error ? { error: taskData.error } : {}),
          };
        });

      // Restored under its OWN id, so the payloads still point at the right
      // batch for their jobs and the rows on disk stay the rows for this batch.
      const batch = restored.restore(
        {
          id: row.id,
          label: data.label ?? 'Generation',
          jobCount: data.jobCount ?? entries.length,
          shared: data.shared ?? {},
          createdAt: data.createdAt ?? (Date.parse(row.createdAt) || Date.now()),
        },
        entries
      );
      // Written back once, so the requeued tasks are queued on disk too - a
      // second restart must not count them as mid-flight all over again.
      persistNewBatch(batch as Batch);
      report.batches += 1;
    }

    if (report.batches > 0) {
      console.log(
        `[queue] Restored ${report.batches} unfinished batch(es) after restart: ` +
          `${report.requeued} resume(s) were mid-flight and will be built again.`
      );
    }
  } catch (error) {
    console.warn(
      '[queue] Could not restore the generation queue after restart; anything queued before is ' +
        'lost. ' + (error instanceof Error ? error.message : String(error))
    );
  }
  return report;
}

/** Tests share one process; a queue left running would leak into the next. */
export function resetGenerationQueueForTests(): void {
  queue?.resetForTests();
  queue = null;
}

