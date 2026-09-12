import { getBrowserChatEndpoints } from '../../config/aiModelConfig';
import { cliConcurrency } from '../ai/batchCapacity';
import { TaskQueue, type Capacity, type Slot } from './taskQueue';

export { TaskQueue } from './taskQueue';
export type {
  Assignment,
  Batch,
  BatchEvent,
  BatchSnapshot,
  BatchState,
  Capacity,
  QueueName,
  Slot,
  Task,
  TaskDescriptor,
  TaskLabel,
  TaskState,
} from './taskQueue';
export {
  runResumeTask,
  resetResumeTaskStateForTests,
  type ResumeJob,
  type ResumeTaskInput,
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
 *
 * Never throws. A settings read that fails must not stop a queue that is running
 * perfectly well on the previous reading; the queue keeps what it had.
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

let queue: TaskQueue | null = null;

/**
 * The one queue, shared by every request in the process.
 *
 * Process-wide is the whole point: two pages submitting batches must end up in
 * ONE line for the browsers, not two lines that each believe they have the run
 * of the place.
 */
export function getGenerationQueue(): TaskQueue {
  if (!queue) queue = new TaskQueue(() => readCapacity());
  return queue;
}

/** Tests share one process; a queue left running would leak into the next. */
export function resetGenerationQueueForTests(): void {
  queue?.resetForTests();
  queue = null;
}
