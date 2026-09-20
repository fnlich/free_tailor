import {
  markItemRunning,
  recordItemOutcome,
  settleOrderIfFinished,
  type OrderFile,
  type OrderItemState,
} from '../../database/orderRepository';
import type { ResumeTaskResult } from '../queue/resumeTask';

/**
 * How a finished resume finds its way onto the order that asked for it.
 *
 * The queue knows nothing about orders and should not: it dispatches work. So
 * the composition root hands it two listeners, and this is what they do. Every
 * function here is called from inside the dispatcher's loop and therefore
 * swallows its own failures - an order that misses a row is a wrong number on a
 * page, while a throw from here would abort the dispatch and strand every slot
 * it had not reached.
 *
 * Most batches are not orders. `recordItemOutcome` answering null is the normal
 * case, not an error, which is why nothing below treats it as one.
 */

/** Only these four states exist on an item; the queue has no others that settle. */
function toItemState(state: string): OrderItemState {
  if (state === 'done' || state === 'failed' || state === 'cancelled') return state;
  return 'failed';
}

/**
 * The paths a finished task produced, in the order somebody would want them.
 *
 * Resume before cover letter and PDF before DOCX, because that is the order a
 * zip should list them and the order the page should show them. Anything absent
 * is simply not in the array - a run configured for PDF only has two files, not
 * four with two blanks.
 */
export function filesFromTaskResult(value: unknown): OrderFile[] {
  if (!value || typeof value !== 'object') return [];
  const result = value as Partial<ResumeTaskResult>;
  const candidates: Array<[OrderFile['kind'], unknown]> = [
    ['resume-pdf', result.pdf],
    ['resume-docx', result.docx],
    ['cover-letter-pdf', result.coverLetterPdf],
    ['cover-letter-docx', result.coverLetterDocx],
  ];

  const files: OrderFile[] = [];
  for (const [kind, path] of candidates) {
    if (typeof path === 'string' && path.trim()) {
      files.push({ kind, path: path.trim() });
    }
  }
  return files;
}

type FinishedTask = {
  id: string;
  batchId: string;
  seq: number;
  state: string;
  value?: unknown;
  error?: string;
};

export function recordTaskStarted(task: { batchId: string; seq: number }): void {
  try {
    markItemRunning(task.batchId, task.seq);
  } catch (error) {
    console.warn('[orders] Could not mark a resume as being built.', error);
  }
}

export function recordTaskFinished(task: FinishedTask): void {
  try {
    const orderId = recordItemOutcome(task.batchId, task.seq, {
      state: toItemState(task.state),
      taskId: task.id,
      ...(task.error ? { error: task.error } : {}),
      files: filesFromTaskResult(task.value),
    });
    if (orderId) settleOrderIfFinished(orderId);
  } catch (error) {
    console.warn('[orders] Could not record a finished resume against its order.', error);
  }
}
