const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const money = require('../dist/utils/money');

/**
 * Money is integer thousandths of a dollar, and text becomes money in exactly
 * one place.
 *
 * Pinned here: the one parser every typed amount goes through (an
 * administrator's price, a balance, a grant, a purchase, CREDIT_SIGNUP_GRANT),
 * the one formatter every sentence goes through, the provider-amount reader
 * the Cryptomus webhook compares with - and, as a guard, that no money path in
 * the source floors, truncates or float-parses an amount, which is what made a
 * $0.001 price a free resume before.
 */

test('"0.023" is 23 thousandths, read from its digits; "0.0235" is refused for its precision', () => {
  const parse = (value, options) => money.parseDollars(value, options);
  assert.deepEqual(parse('0.023'), { ok: true, milli: 23 });
  assert.deepEqual(parse('0.0235'), { ok: false, problem: 'precision' });
  assert.deepEqual(parse(0.023), { ok: true, milli: 23 }, 'a JSON number, through its shortest spelling');
  // The float that is not what it looks like is refused, not rounded.
  assert.deepEqual(parse(0.1 + 0.2), { ok: false, problem: 'precision' });
  assert.deepEqual(parse('$12.50'), { ok: true, milli: 12_500 });
  assert.deepEqual(parse(' 7 '), { ok: true, milli: 7_000 });
  assert.deepEqual(parse('.5'), { ok: true, milli: 500 });
  assert.deepEqual(parse('5.'), { ok: true, milli: 5_000 });
  assert.deepEqual(parse('007.100'), { ok: true, milli: 7_100 });
  assert.deepEqual(parse('1000'), { ok: true, milli: 1_000_000 });

  // Values parseFloat would have accepted and made into something else.
  for (const junk of ['25abc', '1e3', '0x14', '1,000', 'twenty', '.', '$', '--1', true, {}, [1]]) {
    assert.equal(parse(junk).ok, false, JSON.stringify(junk));
  }
  assert.deepEqual(parse(''), { ok: false, problem: 'empty' });
  assert.deepEqual(parse(null), { ok: false, problem: 'empty' });
  assert.deepEqual(parse(undefined), { ok: false, problem: 'empty' });
  assert.deepEqual(parse(1e-7), { ok: false, problem: 'precision' });
  assert.deepEqual(parse(1e21), { ok: false, problem: 'range' });
  assert.deepEqual(parse('9999999999999'), { ok: false, problem: 'range' });

  // Negative only where the caller allows it - an administrator taking away.
  assert.deepEqual(parse('-0.046'), { ok: false, problem: 'negative' });
  assert.deepEqual(parse('-0.046', { allowNegative: true }), { ok: true, milli: -46 });
  assert.deepEqual(parse('-0'), { ok: true, milli: 0 });
});

test('every refusal reads the same way, naming what was being typed', () => {
  assert.equal(
    money.describeDollarProblem('precision', 'Price per resume'),
    'Price per resume can have at most three decimal places: $0.001 is the smallest step.'
  );
  assert.match(money.describeDollarProblem('format', 'The amount'), /must be an amount in dollars, like 0\.023/);
  assert.match(money.describeDollarProblem('negative', 'The balance'), /cannot be negative/);
  assert.match(money.describeDollarProblem('empty', 'The balance'), /is required/);
});

test('an amount always reads with three decimals, built from its digits', () => {
  assert.equal(money.formatMoney(0), '$0.000');
  assert.equal(money.formatMoney(23), '$0.023');
  assert.equal(money.formatMoney(161), '$0.161');
  assert.equal(money.formatMoney(46), '$0.046');
  assert.equal(money.formatMoney(3_977), '$3.977');
  assert.equal(money.formatMoney(50_000), '$50.000');
  assert.equal(money.formatMoney(1_234_567), '$1,234.567');
  assert.equal(money.formatMoney(-46), '-$0.046');
  assert.equal(money.formatMoney(1), '$0.001');
  // Seven $0.023 resumes, as integers: exactly $0.161. As floats a sum is
  // only sometimes right - ten $0.10 grants come to 0.9999999999999999.
  assert.notEqual([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1].reduce((a, b) => a + b, 0), 1);
  assert.equal(money.formatMoney(Array.from({ length: 10 }, () => 100).reduce((a, b) => a + b, 0)), '$1.000');
  assert.equal(money.formatMoney(23 * 7), '$0.161');
  assert.equal(money.formatMoney(23 * 2), '$0.046');
});

test('cents and thousandths convert exactly, and only a whole cent is chargeable', () => {
  assert.equal(money.centsToMilli(250), 2_500);
  assert.equal(money.milliToCents(2_500), 250);
  assert.equal(money.isWholeCents(12_340), true);
  assert.equal(money.isWholeCents(12_345), false);
  assert.throws(() => money.milliToCents(12_345), /not a whole number of cents/);
});

test('a refund returns whole cents: the sub-cent remainder stays on the balance', () => {
  assert.equal(money.wholeCentsBelow(39_993), 39_990);
  assert.equal(money.wholeCentsBelow(39_990), 39_990);
  assert.equal(money.wholeCentsBelow(9), 0, 'less than a cent returns nothing');
  assert.equal(money.wholeCentsBelow(0), 0);
  assert.equal(money.wholeCentsBelow(-50), 0);
  assert.equal(money.wholeCentsBelow(1.5), 0, 'never a fraction of a thousandth');
  assert.equal(money.isWholeCents(money.wholeCentsBelow(123_457)), true);
});

test('a provider amount is read exactly: trailing zeros agree, a half cent does not round into a match', () => {
  assert.equal(money.parseProviderCents('12.50'), 1_250);
  assert.equal(money.parseProviderCents('12.5'), 1_250);
  assert.equal(money.parseProviderCents('12.50000000'), 1_250);
  assert.equal(money.parseProviderCents(12.5), 1_250);
  assert.equal(money.parseProviderCents('12'), 1_200);
  assert.equal(money.parseProviderCents('12.505'), null);
  assert.equal(money.parseProviderCents('12.50abc'), null);
  assert.equal(money.parseProviderCents('-12.50'), null);
  assert.equal(money.parseProviderCents(''), null);
  assert.equal(money.parseProviderCents(undefined), null);
});

/**
 * The guard: no money path floors, truncates or float-parses an amount.
 *
 * `Math.floor(credits)` is how a $0.001 price would have become a free resume,
 * `Number.isInteger(cost)` is how a fractional cost would have refunded a whole
 * credit, and `parseFloat(x) * 100` is how a provider's "12.505" agreed with a
 * $12.50 invoice. Comments are stripped first, because several of these files
 * explain exactly why they do not do it.
 */
const MONEY_SOURCES = [
  'utils/money.ts',
  'config/pricePerResume.ts',
  'database/creditRepository.ts',
  'database/paymentRepository.ts',
  'database/dollarSwitch.ts',
  'services/credits/index.ts',
  'services/credits/errors.ts',
  'services/credits/reconcile.ts',
  'services/payments/pricing.ts',
  'services/payments/index.ts',
  'routes/credits.ts',
  'routes/accounts.ts',
  'routes/generation.ts',
  'integrations/cryptomus.ts',
  'database/refundRequestRepository.ts',
  'services/refunds/index.ts',
  'routes/refundRequests.ts',
  'config/reportRate.ts',
  // The Job Data Lake's rewards, revokes, rate and cap.
  'database/jobLakeRepository.ts',
  'services/jobLake/index.ts',
  'services/jobLake/settings.ts',
  'services/jobLake/reportRun.ts',
  'routes/jobLake.ts',
  'routes/report.ts',
];

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

test('no money path floors, truncates or float-parses an amount', () => {
  const root = path.join(__dirname, '..', 'src');
  for (const relative of MONEY_SOURCES) {
    const code = withoutComments(fs.readFileSync(path.join(root, relative), 'utf8'));
    for (const banned of [/Math\.floor\s*\(/, /Math\.trunc\s*\(/, /parseFloat\s*\(/, /parseInt\s*\(/, /Number\.isInteger\s*\(/]) {
      assert.doesNotMatch(code, banned, `${relative} uses ${banned.source.replace(/\\s\*\\\(/, '')}`);
    }
  }
  // And the two places that read amounts from outside reach the exact readers.
  const webhook = withoutComments(fs.readFileSync(path.join(root, 'routes/paymentWebhooks.ts'), 'utf8'));
  assert.match(webhook, /parseProviderCents\(body\.amount\)/);
  assert.doesNotMatch(webhook, /parseFloat\s*\(/);
  const queue = withoutComments(fs.readFileSync(path.join(root, 'services/queue/index.ts'), 'utf8'));
  assert.doesNotMatch(queue, /Number\.isInteger\s*\(/);
});
