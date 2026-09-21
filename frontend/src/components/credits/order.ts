import type { CreditQuote, PaymentTarget, StartedCheckout } from '@/lib/payments';

/**
 * The purchase wizard's state, with no JSX anywhere near it.
 *
 * A discriminated union over the step rather than a `step` number beside four
 * nullable fields - the house pattern, from `PayForm.tsx`'s load state, and
 * for the same reason: a summary step cannot be rendered without a target and
 * an amount, so the type is what says so and there is no `target!` anywhere in
 * the components.
 *
 * `credits` rides on EVERY step, including the one that has no target yet.
 * That is what makes Back preserve the amount: stepping back to the picker
 * keeps the number, and choosing a different method clamps it into the new
 * method's bounds rather than resetting it to a minimum somebody has to
 * retype.
 */
export type Step =
  | { name: 'options'; credits: number | null }
  | { name: 'amount'; target: PaymentTarget; credits: number }
  | { name: 'summary'; target: PaymentTarget; credits: number };

export type Action =
  | { type: 'choose'; target: PaymentTarget }
  | { type: 'credits'; credits: number }
  | { type: 'forward' }
  | { type: 'back' }
  | { type: 'reset' };

export function clampCredits(credits: number, target: PaymentTarget): number {
  if (!Number.isFinite(credits)) return target.minCredits;
  return Math.min(Math.max(Math.round(credits), target.minCredits), target.maxCredits);
}

/**
 * Where a target starts: its smallest preset, or its minimum.
 *
 * The smallest rather than a middle one, because a default that is not the
 * cheapest option is a default that costs somebody money they did not choose
 * to spend if they miss it.
 */
export function defaultCreditsFor(target: PaymentTarget): number {
  const smallest = target.presets.reduce<number | null>(
    (best, preset) => (best === null || preset.credits < best ? preset.credits : best),
    null
  );
  return clampCredits(smallest ?? target.minCredits, target);
}

export const FIRST_STEP: Step = { name: 'options', credits: null };

export function wizardReducer(step: Step, action: Action): Step {
  switch (action.type) {
    case 'reset':
      return FIRST_STEP;

    case 'choose': {
      // The remembered amount, fitted to the new target. A card minimum and a
      // crypto minimum can differ by a factor of twenty, so this is a clamp
      // and not a carry-over.
      const credits =
        step.credits === null
          ? defaultCreditsFor(action.target)
          : clampCredits(step.credits, action.target);
      return { name: 'amount', target: action.target, credits };
    }

    case 'credits':
      // Unclamped on purpose: a half-typed number has to be allowed to exist
      // in the box, or a maximum of 9 makes "12" impossible to type. The
      // clamp happens on blur and on the way forward, and the server quotes
      // the figure either way.
      if (step.name === 'options') return step;
      return { ...step, credits: action.credits };

    case 'forward':
      if (step.name === 'amount') {
        return {
          name: 'summary',
          target: step.target,
          credits: clampCredits(step.credits, step.target),
        };
      }
      return step;

    case 'back':
      if (step.name === 'summary') {
        return { name: 'amount', target: step.target, credits: step.credits };
      }
      if (step.name === 'amount') {
        return { name: 'options', credits: step.credits };
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
 * A QUOTE is the server pricing a purchase: the charge, the fee and the
 * credits the account will actually receive. It records nothing and calls no
 * provider, so the summary can print real figures the moment it opens. Every
 * number on that screen comes from here rather than from arithmetic in the
 * browser, because the fee and the price are settings an administrator can
 * change while the dialog is open.
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
  | { status: 'ready'; quote: CreditQuote }
  | { status: 'failed'; message: string };

export type Order =
  | { status: 'none' }
  | { status: 'starting' }
  | { status: 'ready'; started: StartedCheckout }
  | { status: 'failed'; message: string };
