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
    super(
      balance === 0
        ? `This needs ${needed} credit${needed === 1 ? '' : 's'} and the account has none. ` +
          'Ask an administrator of this installation to add some.'
        : `This needs ${needed} credit${needed === 1 ? '' : 's'} and the account has ${balance}. ` +
          'Generate fewer at once, or ask an administrator to add more.'
    );
    this.name = 'InsufficientCreditsError';
    this.needed = needed;
    this.balance = balance;
  }
}
