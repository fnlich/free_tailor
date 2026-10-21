import { PublicError } from '../../middleware/publicError';
import { formatMoney } from '../../utils/money';

/**
 * A subscription change refused for a reason the account holder can act on:
 * the sentence is about THEIR request - a tier that is not offered, an amount
 * that changed since they were shown it - and `code` lets a page branch
 * without reading it. `charge-changed` carries the amount in effect now as
 * `chargeMilli`, so the page can show it and ask again.
 */
export class SubscriptionRefusal extends PublicError {
  constructor(code: string, status: number, message: string, extra?: Record<string, unknown>) {
    super(message, { status, code, ...(extra ? { extra } : {}) });
    this.name = 'SubscriptionRefusal';
  }
}

/**
 * Not enough credit for what a change costs now: 402 `insufficient-credits`
 * with `neededMilli` and `balanceMilli`, the same code and fields a run
 * refused for want of credit answers, so a page that already reads one reads
 * this. Nothing was taken.
 */
export class SubscriptionShortError extends PublicError {
  readonly neededMilli: number;
  readonly balanceMilli: number;

  constructor(tierLabel: string, neededMilli: number, balanceMilli: number) {
    super(
      `${tierLabel} costs ${formatMoney(neededMilli)} now and your balance is ${formatMoney(balanceMilli)}. ` +
        'Buy credits, then try again.',
      { status: 402, code: 'insufficient-credits', extra: { neededMilli, balanceMilli } }
    );
    this.name = 'SubscriptionShortError';
    this.neededMilli = neededMilli;
    this.balanceMilli = balanceMilli;
  }
}
