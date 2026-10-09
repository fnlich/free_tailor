const test = require('node:test');
const assert = require('node:assert/strict');

const { useTempStorage, loadFresh, readSettingRaw, writeSettingRaw } = require('./helpers');

/*
 * There is no fee, and there is no price of a credit: a purchase credits
 * exactly what it charges.
 *
 * Before credits were dollars a credit cost 50c, the crypto row kept 2.2% of
 * the gross, and the fee rounded up while the credits rounded down - so $50 in
 * crypto bought 97 credits, not 100. The owner's decisions M1 and M2 removed
 * all of it: a credit is a dollar, and pay $50, get $50.000, by card or by
 * coin. What is pinned here is that nothing of the old arithmetic survives -
 * not a stored fee, not a rounding - and that the amount itself is read
 * exactly, in whole cents, because that is what a provider can be asked for.
 */

async function pricing({ settings = {} } = {}) {
  const { dbDir } = useTempStorage(`payment-fees-${Math.random().toString(36).slice(2)}`);
  writeSettingRaw(dbDir, 'app-settings', JSON.stringify(settings));

  loadFresh('../dist/database/sqlite');
  const config = loadFresh('../dist/config/aiModelConfig');
  return { dbDir, config, ...loadFresh('../dist/services/payments/pricing') };
}

/** The limits rows as a build from before dollars stored them: a price per credit, bounds in credits, a crypto fee. */
const PRE_DOLLAR_SETTINGS = {
  creditPriceCents: 50,
  creditMinCredits: 10,
  creditMaxCredits: 5000,
  paymentLimits: [
    { target: 'card', minCents: 250, maxCents: 10_000, feeBps: 0, feeFixedCents: 0, presetsCents: [250, 500] },
    { target: 'crypto', minCents: 5_000, maxCents: 200_000, feeBps: 220, feeFixedCents: 25, presetsCents: [5_000] },
  ],
};

test('a purchase credits exactly what it charges, by card and by crypto', async () => {
  const { quotePurchase } = await pricing();

  const card = await quotePurchase('5', { method: 'card' });
  assert.deepEqual(card, { amountCents: 500, amountMilli: 5_000, creditMilli: 5_000, currency: 'usd', target: 'card' });

  // The case the fee used to bite: $50 of crypto was 97 credits. It is $50.000 now.
  const crypto = await quotePurchase('50', { method: 'crypto' });
  assert.equal(crypto.amountCents, 5_000);
  assert.equal(crypto.creditMilli, 50_000);
  assert.equal(crypto.creditMilli, crypto.amountMilli, 'credit = charge');
  assert.equal('feeCents' in crypto, false, 'no fee on a quote at all');
});

test('a fee stored by a build from before dollars is not read, and the next save drops it', async () => {
  const { quotePurchase, config, dbDir } = await pricing({ settings: PRE_DOLLAR_SETTINGS });

  const crypto = await quotePurchase('50.00', { method: 'crypto' });
  assert.equal(crypto.creditMilli, 50_000, '220bps and a fixed 25c are ignored');

  // Nor is the old 10-credit floor: at 50c that made the real card minimum $5,
  // whatever the card row said. The row's own $2.50 is the floor now.
  const smallest = await quotePurchase('2.50', { method: 'card' });
  assert.equal(smallest.creditMilli, 2_500);

  // The admin payload carries the limits in thousandths and no fee or price.
  const admin = await config.getAdminAppSettings();
  assert.deepEqual(admin.paymentLimits, [
    { target: 'card', minMilli: 2_500, maxMilli: 100_000, presetsMilli: [2_500, 5_000] },
    { target: 'crypto', minMilli: 50_000, maxMilli: 2_000_000, presetsMilli: [50_000] },
  ]);
  for (const retired of ['creditPriceCents', 'creditMinCredits', 'creditMaxCredits']) {
    assert.equal(retired in admin, false, `${retired} is gone from the payload`);
  }

  await config.updateAppSettings({ defaultTheme: 'dark' });
  const stored = JSON.parse(readSettingRaw(dbDir, 'app-settings'));
  assert.equal('creditPriceCents' in stored, false);
  assert.equal(stored.paymentLimits.some((row) => 'feeBps' in row || 'feeFixedCents' in row), false);
  assert.deepEqual(stored.paymentLimits[1], { target: 'crypto', minCents: 5_000, maxCents: 200_000, presetsCents: [5_000] });
});

test('the amount is read exactly, in whole cents, and anything else is refused rather than rounded', async () => {
  const { quotePurchase, PriceError } = await pricing();

  for (const [asked, cents] of [
    ['12.5', 1_250],
    ['12.50', 1_250],
    ['$12.50', 1_250],
    [12.5, 1_250],
    ['20', 2_000],
  ]) {
    assert.equal((await quotePurchase(asked, { method: 'card' })).amountCents, cents, JSON.stringify(asked));
  }

  // Half a cent cannot be charged: refused, never charged as $12.50 or $12.51.
  // "25abc" and "1e3" are what parseFloat would have read as 25 and 1000.
  for (const bad of ['12.505', '12.5001', '25abc', '1e3', '1,000', '-5', '', null, undefined, true, 0.1 + 0.2, '0']) {
    await assert.rejects(
      () => quotePurchase(bad, { method: 'card' }),
      (error) => error instanceof PriceError && /Choose an amount in dollars and cents/.test(error.message),
      JSON.stringify(bad)
    );
  }
});

test('the bounds are each method\'s own, in dollars, and say so in dollars', async () => {
  const { quotePurchase, resolveLimits, presetsFor } = await pricing();

  await assert.rejects(() => quotePurchase('2.49', { method: 'card' }), /The smallest card purchase is \$2\.5\./);
  await assert.rejects(() => quotePurchase('100.01', { method: 'card' }), /The largest card purchase is \$100\./);
  await assert.rejects(() => quotePurchase('49.99', { method: 'crypto' }), /The smallest crypto purchase is \$50\./);
  assert.equal((await quotePurchase('2000', { method: 'crypto' })).creditMilli, 2_000_000);

  assert.deepEqual(await resolveLimits({ method: 'crypto' }), {
    target: 'crypto',
    currency: 'usd',
    minAmountCents: 5_000,
    maxAmountCents: 200_000,
  });
  // Each button charges, and credits, exactly what it says.
  assert.deepEqual(
    (await presetsFor({ method: 'card' })).map((preset) => preset.amountMilli),
    [2_500, 5_000, 10_000, 25_000, 50_000, 100_000]
  );
});

test('an asset names an asset row only, never the card row', async () => {
  const { quotePurchase } = await pricing();
  // `asset: 'card'` once priced crypto off the card row - a twentieth of the minimum.
  await assert.rejects(() => quotePurchase('5', { method: 'crypto', asset: 'card' }), /smallest crypto purchase/);
});

test('an administrator sets the limits in dollars, in whole cents, and a row with no dollars is refused', async () => {
  const { config, dbDir } = await pricing();

  const saved = await config.updateAppSettings({
    paymentLimits: [
      { target: 'card', minUsd: '3', maxUsd: 150.5, presetsUsd: ['5', '10.50'] },
      { target: 'crypto', minUsd: '40.00', maxUsd: '2000', presetsUsd: [] },
    ],
  });
  assert.deepEqual(saved.paymentLimits, [
    { target: 'card', minMilli: 3_000, maxMilli: 150_500, presetsMilli: [5_000, 10_500] },
    { target: 'crypto', minMilli: 40_000, maxMilli: 2_000_000, presetsMilli: [] },
  ]);
  // Stored as the cents a provider charges in.
  assert.deepEqual(JSON.parse(readSettingRaw(dbDir, 'app-settings')).paymentLimits[0], {
    target: 'card',
    minCents: 300,
    maxCents: 15_050,
    presetsCents: [500, 1_050],
  });

  for (const [rows, why] of [
    [[{ target: 'card', minUsd: '2.505', maxUsd: '100' }], /card: the smallest purchase must be a whole number of cents/],
    [[{ target: 'card', minUsd: '2.5', maxUsd: '1.00' }], /card: the smallest amount cannot be larger than the largest/],
    [[{ target: 'card', minUsd: '', maxUsd: '100' }], /card: the smallest purchase is required/],
    [[{ target: 'card', minUsd: '0', maxUsd: '100' }], /between \$0\.01/],
    [[{ target: 'card', minUsd: '1', maxUsd: '100', presetsUsd: ['five'] }], /card: preset 1 must be an amount in dollars/],
    // Cents, the shape the row is STORED in, are not an amount a save reads.
    [[{ target: 'card', minCents: 250, maxCents: 10_000, presetsCents: [] }], /card: the smallest purchase is required/],
  ]) {
    await assert.rejects(() => config.updateAppSettings({ paymentLimits: rows }), why, JSON.stringify(rows));
  }
  assert.equal(
    (await config.getAdminAppSettings()).paymentLimits[0].minMilli,
    3_000,
    'nothing a refused save carried was kept'
  );
});
