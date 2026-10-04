/**
 * When the builder stops reattaching to a running batch's progress stream.
 * Kept apart from the page so the backend suite can test it
 * (backend/test/frontendHelpers.test.js); imports nothing at runtime.
 *
 * The budget used to count EVERY attach. A proxy that closes an idle
 * connection (Cloudflare after about 100 s, nginx and AWS load balancers after
 * 60 s by default) cut a healthy stream each time a resume took that long, so a
 * long batch spent all twenty reattaches on its own quiet spells - and the page
 * reported "Finished 4 of 30" while the server went on building the rest. Now
 * only attaches that delivered nothing count, and only in a row: one that
 * brought a snapshot proves the server is still there and starts the count
 * again. (The server also sends a bare newline every 25 s, which keeps most
 * proxies from cutting it at all.)
 */

/** How many attaches in a row may deliver nothing before the page stops following. */
export const MAX_IDLE_REATTACHES = 20;

/** What one attach to the stream, and the snapshot read after it, came back with. */
export type AttachOutcome = {
  /** Snapshot lines the stream delivered before it ended. */
  delivered: number;
  /** The server answered 404 for the batch: restarted or expired, and asking again cannot help. */
  gone: boolean;
};

/**
 * After an attach that ended with the batch still running: the count of
 * empty attaches in a row so far, and whether to stop following.
 */
export function nextAttach(
  idleInARow: number,
  outcome: AttachOutcome
): { idleInARow: number; stop: boolean } {
  if (outcome.gone) return { idleInARow, stop: true };
  const idle = outcome.delivered > 0 ? 0 : idleInARow + 1;
  return { idleInARow: idle, stop: idle >= MAX_IDLE_REATTACHES };
}
