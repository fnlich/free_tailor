import type { StorageLike } from './immediateRun';

/**
 * The question asked before anything spends credit (the owner's "alert with
 * Do not show again"), with no React in it: when it is asked, what it says
 * the action costs, and its "Do not show again" - remembered per browser, per
 * KIND of action, so ticking it on an order does not stop Generate
 * Immediately or a subscription asking.
 *
 *  - `order` - an Order, from Build Resumes (the header, the preview,
 *    the sheet panel) or Find Jobs: asked only when something will
 *    be charged, or what it costs could not be worked out.
 *  - `immediate` - Generate Immediately: asked always (until skipped),
 *    because it also carries owner decision B4's warning that closing the tab
 *    stops the run - with the cost beside it when there is one.
 *  - `subscription` - buying, switching or keeping a subscription: asked
 *    when it takes credit, now or at its renewal.
 *
 * The keys are new for every kind: the Generate Immediately confirm's older
 * `freeTailor.immediateConfirm.skip` is not read, so everybody who ticked it
 * sees the confirm - which now names the cost - once more.
 *
 * Imports nothing at runtime, so backend/test/frontendSpendConfirm.test.js
 * loads it as it is. Storage can throw (a private window, blocked site data):
 * an unreadable flag keeps asking, and a flag that cannot be written is
 * simply not remembered.
 *
 * A MONEY MODULE (test/frontendMoney.test.js): amounts are integer thousandths.
 */

export type SpendKind = 'order' | 'immediate' | 'subscription';

export const SPEND_KINDS: readonly SpendKind[] = ['order', 'immediate', 'subscription'];

/** localStorage: "Do not show again", per kind of action, for this browser. */
export const SPEND_SKIP_KEYS: Readonly<Record<SpendKind, string>> = {
  order: 'freeTailor.spendConfirm.order.skip',
  immediate: 'freeTailor.spendConfirm.immediate.skip',
  subscription: 'freeTailor.spendConfirm.subscription.skip',
};

/**
 * What an action will take, as far as the page knows before it is sent.
 * `costMilli` null: it could not be worked out (the quote failed). `chargedOn`
 * set: nothing is taken now - the amount is taken on that day (a switch at
 * renewal, keeping a subscription).
 */
export type SpendEstimate = {
  costMilli: number | null;
  balanceMilli: number | null;
  /** An administrator: never charged. */
  exempt: boolean;
  chargedOn: string | null;
};

/** Owner decision B4's question, word for word: Generate Immediately is tied to its tab. */
export const IMMEDIATE_WARNING =
  'If you close the tab or the network drops, the run can be stopped. Would you like to proceed?';

function readFlag(storage: StorageLike | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** Whether "Do not show again" was ticked for this kind in this browser. Unreadable storage: no - keep asking. */
export function confirmSkipped(kind: SpendKind, storage: StorageLike | null): boolean {
  return readFlag(storage, SPEND_SKIP_KEYS[kind]) === '1';
}

/** "Do not show again", for this kind and this browser. Never throws. */
export function skipConfirm(kind: SpendKind, storage: StorageLike | null): void {
  if (!storage) return;
  try {
    storage.setItem(SPEND_SKIP_KEYS[kind], '1');
  } catch {
    // Not remembered: the next one asks again, which is the safe way round.
  }
}

/** Whether the action takes credit, or might: not an administrator, and a cost above $0 or not known. */
export function spendAlertNeeded(estimate: SpendEstimate): boolean {
  return !estimate.exempt && (estimate.costMilli === null || estimate.costMilli > 0);
}

/** Whether to ask at all (once skipping is ruled out): Generate Immediately always, the others when it spends. */
export function confirmNeeded(kind: SpendKind, estimate: SpendEstimate): boolean {
  return kind === 'immediate' || spendAlertNeeded(estimate);
}

/**
 * How the confirm states the cost:
 *
 *  - `exempt` - an administrator, never charged;
 *  - `unknown` - it could not be worked out just now;
 *  - `free` - nothing is taken;
 *  - `later` - nothing now; the amount on `chargedOn`;
 *  - `now` - the amount now, and the balance after it.
 *
 * `shortMilli` is how far the balance falls short of the amount (0 when it
 * covers it, or is not known), and `blocks` says Proceed cannot go: an amount
 * taken NOW that the balance does not hold would only be refused (402).
 */
export type SpendFigures = {
  state: 'exempt' | 'unknown' | 'free' | 'later' | 'now';
  costMilli: number | null;
  balanceAfterMilli: number | null;
  shortMilli: number;
  blocks: boolean;
};

export function spendFigures(estimate: SpendEstimate): SpendFigures {
  const { costMilli, balanceMilli } = estimate;
  if (estimate.exempt) return { state: 'exempt', costMilli, balanceAfterMilli: null, shortMilli: 0, blocks: false };
  if (costMilli === null) return { state: 'unknown', costMilli, balanceAfterMilli: null, shortMilli: 0, blocks: false };
  if (costMilli <= 0) return { state: 'free', costMilli: 0, balanceAfterMilli: balanceMilli, shortMilli: 0, blocks: false };
  const shortMilli = balanceMilli === null ? 0 : Math.max(0, costMilli - balanceMilli);
  if (estimate.chargedOn !== null) {
    return { state: 'later', costMilli, balanceAfterMilli: null, shortMilli, blocks: false };
  }
  return {
    state: 'now',
    costMilli,
    balanceAfterMilli: balanceMilli === null ? null : balanceMilli - costMilli,
    shortMilli,
    blocks: shortMilli > 0,
  };
}
