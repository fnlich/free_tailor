/**
 * How often the return page asks whether a payment has settled, and when it
 * stops asking. Kept apart from the page so the backend suite can test it
 * (backend/test/frontendHelpers.test.js); imports nothing at runtime.
 *
 * It used to be a fixed two-second interval for as long as the tab was open.
 * A card payment settles within a second or two, so that was right for it -
 * but a crypto one can stay pending for the provider's whole invoice lifetime
 * (an hour by default, up to twelve), which was up to 21,600 requests from one
 * tab, and a payment that answered 404 counted as "still pending" and was
 * asked about every two seconds for ever.
 */

/** The pace while a payment is likely to settle at any moment. */
export const FAST_POLL_MS = 2_000;

/**
 * When the page stops expecting it to happen at once. The same moment the
 * waiting copy changes to say what to do, so the two cannot drift apart.
 */
export const SLOW_AFTER_MS = 120_000;

/** The pace after that: a crypto transfer confirming on the network. */
export const SLOW_POLL_MS = 20_000;

/**
 * What one look at the payment came back with.
 *
 * - `pending`: still waiting for the provider.
 * - `settled`: anything else - paid, failed, expired, refunded. Final.
 * - `gone`: the server answered 404 - no such payment, or somebody else's.
 *   Asking again cannot change that.
 * - `retry`: the request itself failed (offline, a restart). Worth asking again.
 */
export type PollOutcome = 'pending' | 'settled' | 'gone' | 'retry';

/** How long to wait before the next look, given how long the page has waited. */
export function pollDelay(elapsedMs: number): number {
  return elapsedMs < SLOW_AFTER_MS ? FAST_POLL_MS : SLOW_POLL_MS;
}

/** Whether a look that came back with this is worth following with another. */
export function keepPolling(outcome: PollOutcome): boolean {
  return outcome === 'pending' || outcome === 'retry';
}
