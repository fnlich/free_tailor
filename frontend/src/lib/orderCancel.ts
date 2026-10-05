/**
 * What Cancel on an order asks, and what it says it did - kept side by side so
 * the two cannot disagree about money again, and apart from lib/orders.ts
 * (which imports the API client) so the backend suite can run them
 * (backend/test/immediateRunHelpers.test.js). Imports nothing at runtime.
 *
 * Used on /orders, on an order's own page and on the builder's receipt alike.
 */

/** What the server's POST /orders/:id/cancel answers: the queue's own counts. */
export type CancelOutcome = { cancelled: number; aborted: number };

/**
 * What Cancel asks before it stops an order. Said plainly because it cannot be
 * undone, and because a resume already being built may still finish (and is
 * then charged) before the stop reaches it.
 */
export function cancelOrderQuestion(number: string): string {
  return (
    `Cancel what is left of order ${number}? Resumes not started yet are refunded. ` +
    'One already being built is stopped and refunded, unless it finishes first.'
  );
}

function resumes(count: number): string {
  return `${count} resume${count === 1 ? '' : 's'}`;
}

/**
 * What a Cancel did, in the question's own terms, for after "Cancelled: ".
 *
 * `cancelled` is what was still queued - dropped and refunded at once.
 * `aborted` is what was being built when the stop went out: each of those is
 * refunded too, unless it finished before the stop reached it. Saying only
 * "stopped" about them read as "not refunded", so a small order - where every
 * resume is usually already running - reported "0 refunded" to somebody who
 * had just had all of it back.
 */
export function describeCancelOutcome(outcome: CancelOutcome): string {
  const parts: string[] = [];
  if (outcome.cancelled > 0) {
    parts.push(`${resumes(outcome.cancelled)} not started ${outcome.cancelled === 1 ? 'was' : 'were'} refunded`);
  }
  if (outcome.aborted > 0) {
    const one = outcome.aborted === 1;
    parts.push(
      `${resumes(outcome.aborted)} being built ${one ? 'was' : 'were'} stopped and refunded, ` +
        `unless ${one ? 'it' : 'they'} finished first`
    );
  }
  if (parts.length === 0) return 'nothing was left to stop.';
  return `${parts.join(', and ')}.`;
}
