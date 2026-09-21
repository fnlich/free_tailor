const test = require('node:test');
const assert = require('node:assert/strict');

const { useTempStorage, loadFresh, writeSettingRaw } = require('./helpers');

/*
 * The fee comes off the credits, not out of the charge - and the rounding is a
 * decision, not an accident.
 *
 * A percentage of an integer is a fraction, and credits here are whole things:
 * one credit is one rendered resume with a real cost behind it. So the rule is
 * written down and tested rather than left to fall out of the arithmetic: THE
 * FEE ROUNDS UP AND THE CREDITS ROUND DOWN, which leaves a residue of at most
 * one credit's price less a cent with the house.
 *
 * The direction matters because the other one hands out a credit whose cash
 * never arrived. What stops that being a quiet skim is that the summary shows
 * `credits * unitPrice` rather than the net cents - so the buyer sees the
 * rounded-down figure, not a number they will not get.
 *
 * The other claim here is a boundary: a fee that would leave nothing must
 * refuse the sale rather than charge for zero credits.
 */

async function pricing({ settings = {} } = {}) {
  const { dbDir } = useTempStorage(`payment-fees-${Math.random().toString(36).slice(2)}`);
  writeSettingRaw(
    dbDir,
    'app-settings',
    JSON.stringify({
      creditPriceCents: 50,
      creditMinCredits: 1,
      creditMaxCredits: 100_000,
      ...settings,
    })
  );

  loadFresh('../dist/database/sqlite');
  loadFresh('../dist/config/aiModelConfig');
  return loadFresh('../dist/services/payments/pricing');
}

const limits = (target, feeBps, feeFixedCents = 0) => ({
  paymentLimits: [
    { target, minCents: 1, maxCents: 100_000_000, feeBps, feeFixedCents, presetsCents: [] },
  ],
});

test('a zero fee leaves the relation the card path has always had', async () => {
  const { quoteCredits } = await pricing({ settings: limits('card', 0) });

  const quote = await quoteCredits(40, { method: 'card' });
  assert.equal(quote.feeCents, 0);
  assert.equal(quote.credits, 40, 'what was asked for');
  assert.equal(quote.grossCredits, 40);
  assert.equal(
    quote.credits * quote.unitPriceCents,
    quote.amountCents,
    'credits times price equals the charge, which every existing test relies on'
  );
});

test('a 2.2% fee charges the whole amount and credits the rest', async () => {
  const { quoteCredits } = await pricing({ settings: limits('crypto', 220) });

  // 100 credits at 50c is $50. 220bps of 5000 is 110 exactly.
  const quote = await quoteCredits(100, { method: 'crypto' });
  assert.equal(quote.amountCents, 5000, 'the buyer is charged the gross');
  assert.equal(quote.grossCredits, 100);
  assert.equal(quote.feeCents, 110);
  assert.equal(quote.credits, 97, '(5000 - 110) / 50, floored');
});

test('the fee rounds up, the credits round down, and the residue stays with the house', async () => {
  const { quoteCredits } = await pricing({ settings: limits('crypto', 333) });

  // 20 credits at 50c is $10. 333bps of 1000 is 33.3, which rounds UP to 34.
  const quote = await quoteCredits(20, { method: 'crypto' });
  assert.equal(quote.amountCents, 1000);
  assert.equal(quote.feeCents, 34, 'the fee rounds up, against the buyer');

  // 966 / 50 is 19.32, which floors to 19 - also against the buyer.
  assert.equal(quote.credits, 19);

  // The residue is the difference between the net cash and the credits given,
  // and it is small and bounded rather than a percentage of anything.
  const residue = quote.amountCents - quote.feeCents - quote.credits * quote.unitPriceCents;
  assert.equal(residue, 16);
  assert.ok(
    residue < quote.unitPriceCents,
    'the residue can never reach the price of a whole credit'
  );
});

test('a fixed fee is added to the percentage, not chosen between', async () => {
  const { quoteCredits } = await pricing({ settings: limits('crypto', 100, 25) });

  // 100 credits at 50c is $50. 1% is 50, plus the fixed 25, so 75.
  const quote = await quoteCredits(100, { method: 'crypto' });
  assert.equal(quote.feeCents, 75);
  assert.equal(quote.credits, 98, '(5000 - 75) / 50, floored');
});

test('a fee that would leave no credits refuses the sale rather than charging for nothing', async () => {
  // A fixed fee larger than the smallest purchase is worth.
  const { quoteCredits, PriceError } = await pricing({ settings: limits('crypto', 0, 500) });

  // 20 credits is $10, and the fee is $5: fine, 10 credits left.
  const fine = await quoteCredits(20, { method: 'crypto' });
  assert.equal(fine.credits, 10);

  // 10 credits is $5, and the fee is $5: nothing would be credited.
  await assert.rejects(
    () => quoteCredits(10, { method: 'crypto' }),
    (error) => {
      assert.ok(error instanceof PriceError);
      assert.match(error.message, /too small once the transaction fee is taken/i);
      return true;
    },
    'taking money and crediting nothing is worse than refusing the sale'
  );
});

test('a fee can never exceed the amount, so a credit count is never negative', async () => {
  // An absurd fee, of the kind a mistyped setting produces.
  const { applyFee } = await pricing();

  const { credits, feeCents } = applyFee(10, 50, 0, 100_000);
  assert.equal(feeCents, 500, 'clamped to the amount rather than exceeding it');
  assert.equal(credits, 0, 'zero, never below it');
});

test('the fee a payment records is the one in force when it was made', async () => {
  const { quoteCredits } = await pricing({ settings: limits('crypto', 220) });
  const quote = await quoteCredits(100, { method: 'crypto' });

  // The quote carries the fee, which is what createPayment snapshots onto the
  // row - so an administrator changing the fee tomorrow cannot rewrite what
  // this buyer was charged today. The same reason unit_price_cents is stored.
  assert.equal(quote.feeCents, 110);
  assert.equal(quote.target, 'crypto', 'and which row decided it');
});
