const test = require('node:test');
const assert = require('node:assert/strict');

const { loadFresh } = require('./helpers');

/*
 * Turning dollars into coin, and what happens when the price feed is down.
 *
 * The conversion is the single highest-stakes calculation in the crypto path.
 * Getting it wrong does not throw and does not log: it quotes a buyer an
 * amount, they send it, and either they overpay by a factor nobody notices or
 * their money arrives at a figure no invoice matches and sits there.
 *
 * The case this file exists for above all others is **USDT on BNB Chain**.
 * USDT is 6 decimals on Ethereum and TRON and EIGHTEEN on BNB Chain - a factor
 * of a trillion, on a token with the same name and the same ticker. Every
 * assertion about the two together is there to make that difference
 * impossible to lose.
 */

function assets() {
  return loadFresh('../dist/config/chainAssets').ASSETS;
}

function invoices() {
  return loadFresh('../dist/services/payments/chain/invoices');
}

test('a stablecoin sale converts to exactly its dollar figure', () => {
  const { usdCentsToAtomic, formatAtomic } = invoices();
  const ASSETS = assets();

  for (const id of ['ethereum:USDT', 'ethereum:USDC', 'tron:USDT']) {
    const atomic = usdCentsToAtomic(5_000, '1', ASSETS[id], 0);
    assert.equal(atomic, 50_000_000n, `${id} did not come to 50 USDT`);
    assert.equal(formatAtomic(atomic, ASSETS[id].decimals), '50');
  }
});

test('the same sale is a TRILLION times larger on BNB Chain, and that is correct', () => {
  const { usdCentsToAtomic, formatAtomic } = invoices();
  const ASSETS = assets();

  const onEthereum = usdCentsToAtomic(5_000, '1', ASSETS['ethereum:USDT'], 0);
  const onBnb = usdCentsToAtomic(5_000, '1', ASSETS['bsc:USDT'], 0);

  assert.equal(onEthereum, 50_000_000n);
  assert.equal(onBnb, 50_000_000_000_000_000_000n);
  assert.equal(onBnb / onEthereum, 1_000_000_000_000n);

  // And both read back as the same fifty dollars to a human, which is the
  // whole reason the raw figures are never shown.
  assert.equal(formatAtomic(onEthereum, 6), '50');
  assert.equal(formatAtomic(onBnb, 18), '50');
});

test('an 18-decimal amount stays exact, well past what a double holds', () => {
  const { usdCentsToAtomic } = invoices();
  const ASSETS = assets();

  const atomic = usdCentsToAtomic(200_000, '1', ASSETS['bsc:USDC'], 0);
  assert.equal(atomic, 2_000_000_000_000_000_000_000n);

  // The proof that no Number was involved: this value is far beyond
  // Number.MAX_SAFE_INTEGER, so a float step would have rounded it.
  assert.ok(atomic > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(atomic.toString(), '2000000000000000000000');
});

test('every quoted amount lands on the asset’s own lattice', () => {
  const { usdCentsToAtomic } = invoices();
  const ASSETS = assets();

  // BNB Chain steps by 10^12 so the figure a buyer is shown has six decimals
  // rather than eighteen - legible, and not truncated by an exchange.
  for (const cents of [250, 1_234, 5_000, 9_999, 100_000]) {
    for (const id of Object.keys(ASSETS)) {
      const asset = ASSETS[id];
      const price = asset.stable ? '1' : '64231.55';
      const atomic = usdCentsToAtomic(cents, price, asset, 1);
      assert.equal(
        atomic % asset.slotUnit,
        0n,
        `${id} at ${cents}c produced ${atomic}, which is off the lattice`
      );
    }
  }
});

test('rounding is UP, so a sale is never quoted below what it is worth', () => {
  const { usdCentsToAtomic } = invoices();
  const ASSETS = assets();

  // $5.00 of BTC at $64,231.55 is 0.00007784... BTC. Rounded down that is
  // 7,784 satoshis and the house is short; rounded up it is 7,785, and with
  // the 1% spread applied first, 7,863.
  const exact = usdCentsToAtomic(500, '64231.55', ASSETS['bitcoin:BTC'], 0);
  assert.equal(exact, 7_785n);

  const withSpread = usdCentsToAtomic(500, '64231.55', ASSETS['bitcoin:BTC'], 1);
  assert.equal(withSpread, 7_863n);
  assert.ok(withSpread > exact, 'the spread must widen what the buyer sends, not narrow it');
});

test('a price is read as an exact decimal, not through a float', () => {
  const { parseDecimal } = invoices();

  assert.equal(parseDecimal('1', 12), 1_000_000_000_000n);
  assert.equal(parseDecimal('0.1', 12), 100_000_000_000n);
  assert.equal(parseDecimal('64231.55', 2), 6_423_155n);
  // More precision than the scale keeps is truncated, not rounded into a
  // float and back - which is the step that would introduce an error.
  assert.equal(parseDecimal('1.23456789012345', 6), 1_234_567n);
  // Anything that is not a plain decimal is nothing, rather than NaN.
  assert.equal(parseDecimal('1e6', 6), 0n);
  assert.equal(parseDecimal('-5', 6), 0n);
  assert.equal(parseDecimal('', 6), 0n);
});

test('an atomic amount is shown to a buyer without a trailing zero in sight', () => {
  const { formatAtomic } = invoices();

  assert.equal(formatAtomic('50000000', 6), '50');
  assert.equal(formatAtomic('50500000', 6), '50.5');
  assert.equal(formatAtomic('7863', 8), '0.00007863');
  assert.equal(formatAtomic('12463400000000000000', 18), '12.4634');
  assert.equal(formatAtomic('0', 8), '0');
});

/* ------------------------------------------------------------------ rates */

test('a stablecoin needs no price feed at all', async () => {
  const rates = loadFresh('../dist/services/payments/chain/rates');
  const ASSETS = assets();

  // Not "a call that usually returns 1.00" - no call. The proof is that this
  // resolves with the network unreachable, which it is here.
  const rate = await rates.rateFor(ASSETS['ethereum:USDT'], {});
  assert.equal(rate.usd, '1');
  assert.equal(rate.stale, false);
});

test('a price that will not fetch falls back to the last one that did', async () => {
  const rpc = loadFresh('../dist/services/payments/chain/rpc');
  const rates = loadFresh('../dist/services/payments/chain/rates');
  const ASSETS = assets();
  rates.clearRateCache();

  let answer = { bitcoin: { usd: 64231.55 } };
  rpc.getJson = async () => {
    if (!answer) throw new Error('rate limited');
    return answer;
  };

  const first = await rates.rateFor(ASSETS['bitcoin:BTC'], {}, new Date(1_000));
  assert.equal(first.usd, '64231.55');
  assert.equal(first.stale, false);

  // The feed goes away, and the cache is more than a minute old so it will
  // genuinely be asked again.
  answer = null;
  const second = await rates.rateFor(ASSETS['bitcoin:BTC'], {}, new Date(1_000 + 120_000));
  assert.equal(second.usd, '64231.55', 'the last good price should have been reused');
  assert.equal(second.stale, true, 'and it should be reported as stale rather than passed off');
});

test('a price that has NEVER been fetched refuses the sale instead of quoting zero', async () => {
  const rpc = loadFresh('../dist/services/payments/chain/rpc');
  const rates = loadFresh('../dist/services/payments/chain/rates');
  const ASSETS = assets();
  rates.clearRateCache();

  rpc.getJson = async () => {
    throw new Error('rate limited');
  };

  // There is nothing to be stale about yet. Quoting anyway would mean an
  // amount of coin derived from a price nobody stands behind.
  await assert.rejects(
    () => rates.rateFor(ASSETS['bitcoin:BTC'], {}),
    (error) => error.name === 'RateUnavailableError'
  );
});

test('a price feed answering something unexpected counts as not answering', () => {
  const rates = loadFresh('../dist/services/payments/chain/rates');

  assert.equal(rates.parseCoingeckoPrice({ bitcoin: { usd: 64231.55 } }, 'bitcoin'), '64231.55');
  // Every one of these is a feed that changed shape, rate-limited with a JSON
  // body, or answered about something else. None is a price.
  assert.equal(rates.parseCoingeckoPrice({}, 'bitcoin'), null);
  assert.equal(rates.parseCoingeckoPrice({ bitcoin: {} }, 'bitcoin'), null);
  assert.equal(rates.parseCoingeckoPrice({ bitcoin: { usd: 0 } }, 'bitcoin'), null);
  assert.equal(rates.parseCoingeckoPrice({ bitcoin: { usd: -1 } }, 'bitcoin'), null);
  assert.equal(rates.parseCoingeckoPrice({ ethereum: { usd: 2 } }, 'bitcoin'), null);
  assert.equal(rates.parseCoingeckoPrice({ error: 'too many requests' }, 'bitcoin'), null);
  assert.equal(rates.parseCoingeckoPrice(null, 'bitcoin'), null);
});
