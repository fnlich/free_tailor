/**
 * Not enough credits to start what was asked for.
 *
 * Carries the numbers rather than only a sentence so the route can send them as
 * fields and the page can show "12 of 30" without parsing English back out of
 * an error message.
 */
export class InsufficientCreditsError extends Error {
  readonly needed: number;
  readonly balance: number;

  constructor(needed: number, balance: number) {
    /*
     * Deliberately vague about HOW to get more.
     *
     * This message is written once and read on an installation that may or may
     * not have a payment method configured - naming a Buy page that leads to
     * "no payment method is set up" is worse than not naming one. The page
     * catching this error knows which install it is on and links accordingly.
     */
    super(
      balance === 0
        ? `This needs ${needed} credit${needed === 1 ? '' : 's'} and the account has none. ` +
          'Add credits to carry on; previews are free.'
        : `This needs ${needed} credit${needed === 1 ? '' : 's'} and the account has ${balance}. ` +
          'Generate fewer at once, or add more credits.'
    );
    this.name = 'InsufficientCreditsError';
    this.needed = needed;
    this.balance = balance;
  }
}
