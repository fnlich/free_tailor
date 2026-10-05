import type { PaymentTarget, PurchaseQuote, StartedCheckout } from '@/lib/payments';
import { formatMoney, isWholeCents, parseDollars, toDollarInput } from '@/lib/format';

/**
 * The purchase wizard's state, with no JSX anywhere near it.
 *
 * A discriminated union over the step rather than a `step` number beside four
 * nullable fields - the house pattern, from `PayForm.tsx`'s load state, and
 * for the same reason: a summary step cannot be rendered without a target and
 * an amount, so the type is what says so and there is no `target!` anywhere in
 * the components. Pure, and importing only lib/format.ts at runtime, so
 * backend/test/frontendMoney.test.js runs it.
 *
 * **A purchase is an amount of money.** A credit is a dollar, so the buyer
 * chooses dollars and cents and is charged and credited exactly that. The
 * amount step holds what was TYPED - "12." has to be allowed to exist in the
 * box on the way to "12.50" - and the summary holds the amount that step
 * settled on, in thousandths of a dollar, already fitted to the method.
 *
 * The amount rides on EVERY step, including the one that has no target yet.
 * That is what makes Back preserve it: stepping back to the picker keeps it,
 * and choosing a different method fits it into the new method's bounds rather
 * than resetting it to a minimum somebody has to retype.
 */
export type Step =
  | { name: 'options'; amount: string | null }
  | { name: 'amount'; target: PaymentTarget; amount: string }
  | { name: 'summary'; target: PaymentTarget; amountMilli: number };

export type Action =
  | { type: 'choose'; target: PaymentTarget }
  | { type: 'amount'; amount: string }
  | { type: 'forward' }
  | { type: 'back' }
  | { type: 'reset' };

/** The server's own words for an amount that is not one (services/payments/pricing.ts). */
export const CHOOSE_AN_AMOUNT = 'Choose an amount in dollars and cents, like 25 or 12.50.';

/**
 * What the typed amount buys on this target: the amount, fitted into the
 * method's bounds - and which bound it was fitted to, so the step can say so -
 * or why it cannot be bought at all.
 *
 * Fitted rather than refused when it is merely too small or too large, as the
 * credit count always was: "The smallest card purchase is $2.500. $2.500 will
 * be bought." is a sentence somebody can act on by pressing Continue. Refused
 * when it is not an amount of money a card can be charged - text, a negative,
 * or a fraction of a cent ("2.505") - because there is no nearest amount that
 * is obviously what was meant, and rounding somebody's purchase is choosing a
 * price for them. The server checks all of this again; this is so the button
 * can say what it will charge before it is pressed.
 */
export type PurchaseAmount =
  | { ok: true; milli: number; fitted: 'min' | 'max' | null }
  | { ok: false; message: string };

export function readPurchaseAmount(amount: string, target: PaymentTarget): PurchaseAmount {
  const parsed = parseDollars(amount);
  if (!parsed.ok || parsed.milli <= 0 || !isWholeCents(parsed.milli)) {
    return { ok: false, message: CHOOSE_AN_AMOUNT };
  }
  if (parsed.milli < target.minAmountMilli) return { ok: true, milli: target.minAmountMilli, fitted: 'min' };
  if (parsed.milli > target.maxAmountMilli) return { ok: true, milli: target.maxAmountMilli, fitted: 'max' };
  return { ok: true, milli: parsed.milli, fitted: null };
}

/** What a fitted amount says under the box: the bound, and what will be bought instead. */
export function describeFitted(read: PurchaseAmount, target: PaymentTarget): string {
  if (!read.ok || read.fitted === null) return '';
  const bound = read.fitted === 'min' ? 'smallest' : 'largest';
  return `The ${bound} ${target.method} purchase is ${formatMoney(read.milli)}. ${formatMoney(read.milli)} will be bought.`;
}

/**
 * Where a target starts: its smallest preset, or its minimum.
 *
 * The smallest rather than a middle one, because a default that is not the
 * cheapest option is a default that costs somebody money they did not choose
 * to spend if they miss it.
 */
export function defaultAmountFor(target: PaymentTarget): number {
  const inside = target.presets
    .map((preset) => preset.amountMilli)
    .filter((milli) => milli >= target.minAmountMilli && milli <= target.maxAmountMilli);
  return inside.length > 0 ? Math.min(...inside) : target.minAmountMilli;
}

export const FIRST_STEP: Step = { name: 'options', amount: null };

export function wizardReducer(step: Step, action: Action): Step {
  switch (action.type) {
    case 'reset':
      return FIRST_STEP;

    case 'choose': {
      // The remembered amount, fitted to the new target. A card minimum and a
      // crypto minimum can differ by a factor of twenty, so this is a fit and
      // not a carry-over - and an amount that was never a valid one starts
      // the new target at its default rather than carrying the problem along.
      const typed = step.name === 'summary' ? toDollarInput(step.amountMilli) : step.amount;
      const remembered = typed === null ? null : readPurchaseAmount(typed, action.target);
      const milli = remembered?.ok ? remembered.milli : defaultAmountFor(action.target);
      return { name: 'amount', target: action.target, amount: toDollarInput(milli) };
    }

    case 'amount':
      // Unfitted on purpose: a half-typed amount has to be allowed to exist in
      // the box, or a minimum of $50 makes "120" impossible to type - the 1
      // snaps to 50 before the 2 arrives. The fit happens on blur and on the
      // way forward, and the server quotes the figure either way.
      if (step.name !== 'amount') return step;
      return { ...step, amount: action.amount };

    case 'forward': {
      if (step.name !== 'amount') return step;
      const read = readPurchaseAmount(step.amount, step.target);
      // Not an amount: stay, and let the step say why. The Continue button is
      // disabled in this state too; this is the reducer refusing on its own.
      if (!read.ok) return step;
      return { name: 'summary', target: step.target, amountMilli: read.milli };
    }

    case 'back':
      if (step.name === 'summary') {
        return { name: 'amount', target: step.target, amount: toDollarInput(step.amountMilli) };
      }
      if (step.name === 'amount') {
        return { name: 'options', amount: step.amount };
      }
      return step;
  }
}

/**
 * What the summary costs, and - separately - the checkout opened for it.
 *
 * Two things, deliberately, because they happen at different moments and one
 * of them has consequences.
 *
 * A QUOTE is the server pricing a purchase: the charge, and the credit the
 * account will receive for it - the same amount. It records nothing and calls
 * no provider, so the summary can print real figures the moment it opens.
 * Every number on that screen comes from here rather than from the browser,
 * because the bounds are settings an administrator can change while the dialog
 * is open, and an amount the server would refuse must not be shown as bought.
 *
 * An ORDER is a payment row and a live session at the provider. It is created
 * only when the buyer commits to paying with a NEW card, because that is the
 * only path that needs one up front - the Payment Element cannot mount without
 * a client secret. Paying with a card already kept creates its own payment at
 * the moment the button is pressed. Opening one for every visit to the summary
 * is what this shape exists to avoid: it left an abandoned `pending` row in the
 * buyer's own payment history for having looked, and spent two of the twenty
 * checkouts an account may open in an hour on a single purchase.
 */
export type Priced =
  | { status: 'loading' }
  | { status: 'ready'; quote: PurchaseQuote }
  | { status: 'failed'; message: string };

export type Order =
  | { status: 'none' }
  | { status: 'starting' }
  | { status: 'ready'; started: StartedCheckout }
  | { status: 'failed'; message: string };
