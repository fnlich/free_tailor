import { PublicError } from '../../middleware/publicError';
import { formatMoney } from '../../utils/money';

/**
 * Not enough credit to start what was asked for.
 *
 * Carries the numbers rather than only a sentence so the route can send them as
 * fields and the page can show "$0.023 of $0.161" without parsing English back
 * out of an error message. Both are thousandths of a dollar.
 */
export class InsufficientCreditsError extends PublicError {
  readonly neededMilli: number;
  readonly balanceMilli: number;

  constructor(neededMilli: number, balanceMilli: number) {
    /*
     * Deliberately vague about HOW to get more.
     *
     * This message is written once and read on an installation that may or may
     * not have a payment method configured - naming a Buy page that leads to
     * "no payment method is set up" is worse than not naming one. The page
     * catching this error knows which install it is on and links accordingly.
     */
    super(
      balanceMilli === 0
        ? `This needs ${formatMoney(neededMilli)} of credit and the account has none. ` +
          'Add credit to carry on; previews are free.'
        : `This needs ${formatMoney(neededMilli)} of credit and the account has ${formatMoney(balanceMilli)}. ` +
          'Generate fewer at once, or add more credit.',
      // The caller's own balance, so it is theirs to read in full - and the
      // numbers ride along as fields, which is what the builder shows.
      { status: 402, code: 'insufficient-credits', extra: { neededMilli, balanceMilli } }
    );
    this.name = 'InsufficientCreditsError';
    this.neededMilli = neededMilli;
    this.balanceMilli = balanceMilli;
  }
}
