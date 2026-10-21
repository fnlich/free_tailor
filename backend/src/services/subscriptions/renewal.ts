import { subscriptionRenewalSweepMs } from '../../config/operational';
import { renewDueSubscriptions, type RenewalReport } from './index';

/**
 * The renewal sweep's timer: one pass at once, then one every
 * SUBSCRIPTION_RENEWAL_SWEEP_MS (ten minutes by default), each renewing or
 * ending every paid subscription whose 30 days are up (`renewDueSubscriptions`).
 *
 * Started from exactly one place, the server's listen callback, once the
 * credit books are put straight after a restart (`startSubscriptionRenewalAfter`)
 * - never when this module loads, so a test that loads it starts nothing -
 * and unref'd, so it never holds the process open. A pass still running when
 * the next is due is not overlapped: that tick is skipped. Overlap could not
 * charge anybody twice (each renewal is conditional on the period it renews,
 * and its ledger key is unique), but two passes would only fight over the
 * same rows.
 */

let timer: NodeJS.Timeout | null = null;
let running = false;

/** "10 minute(s)", or seconds below a minute: how the startup line says the interval. */
export function describeRenewalInterval(intervalMs: number): string {
  if (intervalMs < 60_000) return `${(intervalMs - (intervalMs % 1000)) / 1000} second(s)`;
  return `${(intervalMs - (intervalMs % 60_000)) / 60_000} minute(s)`;
}

/**
 * Starts the sweep, and answers how to stop it. `pass` is the sweep itself -
 * a test hands in one of its own to watch the timing.
 */
export function startSubscriptionRenewal(
  intervalMs: number = subscriptionRenewalSweepMs(),
  pass: () => Promise<RenewalReport> = renewDueSubscriptions
): () => void {
  stopSubscriptionRenewal();

  const sweep = (): void => {
    if (running) return;
    running = true;
    void Promise.resolve()
      .then(() => pass())
      .then((report) => {
        if (report.renewed + report.lapsed > 0) {
          console.log(`[subscriptions] Renewal: ${report.renewed} renewed, ${report.lapsed} ended.`);
        }
      })
      .catch((error) => {
        console.warn('[subscriptions] The renewal sweep failed; it will run again.', error);
      })
      .finally(() => {
        running = false;
      });
  };

  sweep();
  timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  return stopSubscriptionRenewal;
}

export function stopSubscriptionRenewal(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Starts the sweep once `ready` has settled, either way - the server's boot
 * hands in the restore of the generation queue and the credit reconciliation
 * chained on it (index.ts). That reconciliation gives back the credit held by
 * runs that never finished, and a renewal is decided on the balance: a first
 * pass run ahead of it ended a subscription for "not enough credit" moments
 * before the credit that covered it came back. Answers how to stop it, which
 * also stops it from starting.
 */
export function startSubscriptionRenewalAfter(
  ready: Promise<unknown>,
  intervalMs: number = subscriptionRenewalSweepMs(),
  pass: () => Promise<RenewalReport> = renewDueSubscriptions
): () => void {
  let cancelled = false;
  void ready
    .catch(() => undefined)
    .then(() => {
      if (!cancelled) startSubscriptionRenewal(intervalMs, pass);
    });
  return () => {
    cancelled = true;
    stopSubscriptionRenewal();
  };
}
