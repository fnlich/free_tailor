const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ts = require('typescript');

/**
 * The browser's half of "a credit is a dollar, counted in thousandths".
 *
 * The frontend has no test runner, so its pure money helpers are transpiled
 * with the backend's own TypeScript and run from here - the frontendHelpers
 * pattern. Two kinds of claim:
 *
 *  - MIRRORS. lib/format.ts copies the server's `parseDollars`,
 *    `describeDollarProblem` and `formatMoney` (utils/money.ts), and the Admin
 *    -> Models box copies the server's price rule. Each pair is run over the
 *    same inputs and must agree exactly: a box that accepts "0.0235" while the
 *    server refuses it is a form that cannot be saved and does not say why,
 *    and a balance printed $3.98 here and $3.977 in the server's own sentence
 *    is two figures for one amount.
 *  - DECISIONS with no React in them: the cost line, how a ledger row and a
 *    payment read (in the unit they were written in), the purchase wizard.
 *
 * Unlike frontendHelpers' loader, this one lets a module import another
 * frontend module (`./format`, `@/lib/format`) - loaded by the same rules -
 * because every money helper reaches the one formatter. Anything else (React,
 * Next, the API client) is still refused: these must stay pure.
 */

const SRC = path.join(__dirname, '..', '..', 'frontend', 'src');
const cache = new Map();

function resolveFrontend(fromFile, specifier) {
  const base = specifier.startsWith('@/')
    ? path.join(SRC, specifier.slice(2))
    : specifier.startsWith('.')
      ? path.resolve(path.dirname(fromFile), specifier)
      : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function loadFile(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  });
  const module = { exports: {} };
  cache.set(file, module);
  const requireFrontend = (specifier) => {
    const target = resolveFrontend(file, specifier);
    if (!target) {
      throw new Error(`${path.relative(SRC, file)} imports ${specifier}; money helpers import only other pure frontend modules`);
    }
    return loadFile(target);
  };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, requireFrontend);
  return module.exports;
}

const load = (relative) => loadFile(path.join(SRC, relative));

const backendMoney = require('../dist/utils/money');
const backendPrice = require('../dist/config/pricePerResume');
const { CREDIT_REASONS } = require('../dist/services/credits/types');

// -- the mirrors ------------------------------------------------------------- //

const AMOUNTS_MILLI = [
  0, 1, 9, 10, 23, 99, 100, 161, 999, 1000, 1001, 2500, 3977, 12_500, 50_000, 100_000, 999_999,
  1_000_000, 1_234_567, 1_000_000_000, 123_456_789_012, -1, -46, -1000, -1_234_567,
];

test('formatMoney prints exactly what the server prints, every significant decimal and no trailing zero', () => {
  const { formatMoney } = load('lib/format.ts');
  for (const milli of AMOUNTS_MILLI) {
    assert.equal(formatMoney(milli), backendMoney.formatMoney(milli), String(milli));
  }
  // The owner's examples: a price, a balance, a purchase - and "$1", never
  // "$1.000", which reads as a thousand.
  assert.equal(formatMoney(23), '$0.023');
  assert.equal(formatMoney(3977), '$3.977');
  assert.equal(formatMoney(50_000), '$50');
  assert.equal(formatMoney(1000), '$1');
  assert.equal(formatMoney(4100), '$4.1');
  assert.equal(formatMoney(0), '$0');
  assert.equal(formatMoney(10), '$0.01');
  assert.equal(formatMoney(1_234_500), '$1,234.5');
  assert.equal(formatMoney(1_234_567), '$1,234.567');
  assert.equal(formatMoney(-46), '-$0.046');
  assert.equal(formatMoney(-1000), '-$1');
  // Never a bare dot, and never a negative zero.
  for (const milli of AMOUNTS_MILLI) assert.doesNotMatch(formatMoney(milli), /\.$|^-\$0$/, String(milli));
  assert.equal(formatMoney(-0), '$0');
  // Display only, so junk does not print "$NaN" - and agrees with the server.
  for (const junk of [NaN, 2.6, undefined]) {
    assert.equal(formatMoney(junk), backendMoney.formatMoney(junk), String(junk));
  }
});

const DOLLAR_INPUTS = [
  '0.023', '0.0235', '0.001', '0.0001', '.5', '5.', '12.50', '$12.50', ' $ 7 ', '+3', '-1', '-0', '-0.000',
  '-$0.046', '1,000', '1e3', '1E-3', 'two', '', '   ', '.', '-', '$', '12.5.0', '00012.5',
  '999999999999', '9999999999999', '999999999999.999', 0.023, 0.1 + 0.2, 1e21, 1e-7, 25, -1.5, 0,
  NaN, Infinity, null, undefined, true, {}, [],
];

test('parseDollars reads and refuses exactly as the server does, with and without negatives', () => {
  const { parseDollars } = load('lib/format.ts');
  for (const input of DOLLAR_INPUTS) {
    for (const options of [{}, { allowNegative: true }]) {
      assert.deepEqual(
        parseDollars(input, options),
        backendMoney.parseDollars(input, options),
        `${JSON.stringify(input)} ${JSON.stringify(options)}`
      );
    }
  }
  // The plan's own pair: "0.023" is 23, "0.0235" is refused for its precision.
  assert.deepEqual(parseDollars('0.023'), { ok: true, milli: 23 });
  assert.deepEqual(parseDollars('0.0235'), { ok: false, problem: 'precision' });
});

test('a refused amount is described in the server\'s words', () => {
  const { describeDollarProblem } = load('lib/format.ts');
  for (const problem of ['empty', 'format', 'precision', 'negative', 'range']) {
    assert.equal(
      describeDollarProblem(problem, 'The amount'),
      backendMoney.describeDollarProblem(problem, 'The amount'),
      problem
    );
  }
});

test('whole cents, and the text a dollar box is filled with, round-trip exactly', () => {
  const { isWholeCents, parseDollars, toDollarInput } = load('lib/format.ts');
  for (const milli of AMOUNTS_MILLI.filter((value) => value >= 0)) {
    assert.equal(isWholeCents(milli), backendMoney.isWholeCents(milli), String(milli));
    // Whatever goes into a box parses back to the very same amount.
    assert.deepEqual(parseDollars(toDollarInput(milli)), { ok: true, milli }, String(milli));
  }
  // Money reads like money, and a price keeps its third digit - however
  // formatMoney happens to print (these do not read its text any more).
  assert.equal(toDollarInput(2500), '2.50');
  assert.equal(toDollarInput(50_000), '50.00');
  assert.equal(toDollarInput(0), '0.00');
  assert.equal(toDollarInput(23), '0.023');
  assert.equal(toDollarInput(125), '0.125');
  assert.equal(toDollarInput(1_234_567), '1234.567');
  assert.equal(toDollarInput(1_234_500), '1234.50');
  assert.equal(toDollarInput(1_000_000_000), '1000000.00');
});

test("a legacy credit's unit price keeps the two decimals its receipt was printed with", () => {
  const { formatLegacyUnitPrice } = load('lib/format.ts');
  assert.equal(formatLegacyUnitPrice(500), '$0.50');
  assert.equal(formatLegacyUnitPrice(1000), '$1.00');
  assert.equal(formatLegacyUnitPrice(1_250_000), '$1,250.00');
  // Not whole cents: every digit, as any other amount.
  assert.equal(formatLegacyUnitPrice(505), '$0.505');
  assert.equal(formatLegacyUnitPrice(5), '$0.005');
});

test('the helpers that need fixed decimals build them from the digits, not from formatMoney\'s text', () => {
  const source = fs.readFileSync(path.join(SRC, 'lib', 'format.ts'), 'utf8');
  for (const name of ['toDollarInput', 'formatLegacyUnitPrice']) {
    const start = source.indexOf(`export function ${name}(`);
    const body = source.slice(start, source.indexOf('\n}\n', start));
    assert.match(body, /moneyParts\(/, `${name} reads the digits`);
    assert.doesNotMatch(body, /formatMoney\([^)]*\)\s*\.(?:slice|replace)/, `${name} slices formatMoney's text`);
  }
});

test("a model's price is checked in the box exactly as the server checks it", () => {
  const { readPriceDraft } = load('app/admin/models/modelPrice.ts');
  for (const input of ['0.023', '0', '0.000', '1000', '1000.000', '1000.001', '0.0235', '-1', 'two', '', '  5 ', '$2']) {
    let server;
    try {
      server = { ok: true, milli: backendPrice.parsePricePerResume(input, undefined) };
    } catch (error) {
      server = { ok: false, message: error.message };
    }
    assert.deepEqual(readPriceDraft(input), server, JSON.stringify(input));
  }
});

test('the models listed in red are exactly the ones the server says are free', () => {
  const { freeEnabledModels } = load('app/admin/models/modelPrice.ts');
  const aiModels = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
  assert.deepEqual(
    freeEnabledModels({ aiModels, freeEnabledModelIds: ['c', 'a', 'gone'] }).map((model) => model.id),
    ['a', 'c']
  );
  assert.deepEqual(freeEnabledModels({ aiModels, freeEnabledModelIds: [] }), []);
});

// -- the builder's cost line ------------------------------------------------- //

test('the cost line multiplies a single price out, and states a mixed run as its total', () => {
  const { describeRunCost } = load('lib/format.ts');
  assert.equal(describeRunCost({ resumes: 7, costMilli: 161, pricePerResumeMilli: 23 }), '7 resumes × $0.023 = $0.161');
  assert.equal(describeRunCost({ resumes: 1, costMilli: 23, pricePerResumeMilli: 23 }), '1 resume × $0.023 = $0.023');
  // Profiles on models at different prices: no single price to show.
  assert.equal(describeRunCost({ resumes: 3, costMilli: 71, pricePerResumeMilli: null }), '3 resumes = $0.071');
  assert.equal(describeRunCost({ resumes: 0, costMilli: 0, pricePerResumeMilli: null }), '0 resumes = $0');
  // A model nobody has priced yet is free, and says so in figures.
  assert.equal(describeRunCost({ resumes: 2, costMilli: 0, pricePerResumeMilli: 0 }), '2 resumes × $0 = $0');
  // Whole dollars read as dollars.
  assert.equal(describeRunCost({ resumes: 4, costMilli: 2000, pricePerResumeMilli: 500 }), '4 resumes × $0.5 = $2');
});

// -- the ledger -------------------------------------------------------------- //

test('the frontend knows every ledger reason the server writes, reset included', () => {
  // lib/credits.ts imports the API client, so its union is read as text. The
  // Record of phrases beside it is checked against the union by the compiler;
  // this checks the union against the server.
  const source = fs.readFileSync(path.join(SRC, 'lib', 'credits.ts'), 'utf8');
  const block = /export type CreditReason =([\s\S]*?);/.exec(source)[1];
  const reasons = [...block.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]);
  assert.deepEqual([...reasons].sort(), [...CREDIT_REASONS].sort());
});

test('a ledger row reads in the unit it was written in', () => {
  const { describeLedgerBalance, describeLedgerChange, ledgerDirection } = load('lib/ledger.ts');
  const row = (fields) => ({ deltaMilli: 0, balanceAfterMilli: 0, legacyCredits: null, ...fields });

  const charge = row({ deltaMilli: -161, balanceAfterMilli: 3977 });
  assert.equal(describeLedgerChange(charge), '-$0.161');
  assert.equal(describeLedgerBalance(charge), '$3.977');
  assert.equal(ledgerDirection(charge), -1);

  const refund = row({ deltaMilli: 46, balanceAfterMilli: 4023 });
  assert.equal(describeLedgerChange(refund), '+$0.046');
  assert.equal(ledgerDirection(refund), 1);

  // From before dollars: its credits, never "$0" and never converted.
  const bought = row({ legacyCredits: { delta: 40, balanceAfter: 52 } });
  assert.equal(describeLedgerChange(bought), '+40 credits');
  assert.equal(describeLedgerBalance(bought), '52 credits');
  assert.equal(ledgerDirection(bought), 1);
  const reset = row({ legacyCredits: { delta: -1, balanceAfter: 0 } });
  assert.equal(describeLedgerChange(reset), '-1 credit');
  assert.equal(describeLedgerBalance(reset), '0 credits');
  assert.equal(ledgerDirection(reset), -1);
  // The reset row of an account whose credits were all held by a run moves
  // nothing - and still reads in credits, not as a "+$0" movement.
  const heldOnly = row({ legacyCredits: { delta: 0, balanceAfter: 0 } });
  assert.equal(describeLedgerChange(heldOnly), '0 credits');
  assert.equal(describeLedgerBalance(heldOnly), '0 credits');
  assert.equal(ledgerDirection(heldOnly), 0);
});

// -- payments ---------------------------------------------------------------- //

function payment(fields) {
  return {
    id: 'p1',
    reference: 'FT-PAY-1',
    method: 'card',
    provider: 'stripe',
    state: 'paid',
    amountMilli: 25_000,
    feeMilli: 0,
    creditMilli: 25_000,
    creditedMilli: 25_000,
    refundedMilli: 0,
    refundAmountMilli: 0,
    legacyCredits: null,
    ...fields,
  };
}

/** A crypto purchase from before dollars: 200 credits quoted at $0.50, 3 lost to the fee. */
const LEGACY = payment({
  method: 'crypto',
  provider: 'cryptomus',
  amountMilli: 100_000,
  feeMilli: 2_200,
  creditMilli: 0,
  creditedMilli: 0,
  legacyCredits: { credits: 195, creditsGranted: 195, refundedCredits: 0, unitPriceMilli: 500 },
});

test('a purchase since dollars reads as its charge, and one from before as the credits it bought', () => {
  const pd = load('lib/paymentDisplay.ts');
  const card = payment({});
  assert.equal(pd.isLegacyPurchase(card), false);
  assert.equal(pd.describePurchaseCredit(card), '$25');
  assert.equal(pd.describeCreditReceived(card), '$25');
  assert.equal(pd.describePurchase(card), '$25 of credit.');

  assert.equal(pd.isLegacyPurchase(LEGACY), true);
  assert.equal(pd.describePurchaseCredit(LEGACY), '195 credits');
  assert.equal(pd.describeCreditReceived(LEGACY), '195 credits');
  assert.equal(pd.describePurchase(LEGACY), '195 credits for $100.');
  // A very old row has no granted column: what was quoted is what landed.
  const older = { ...LEGACY, legacyCredits: { ...LEGACY.legacyCredits, creditsGranted: 0 } };
  assert.equal(pd.describeCreditReceived(older), '195 credits');

  // Opened before the switch, paid after: it carries its old figures, but it
  // was credited its charge in dollars, and that is what it says.
  const straddled = payment({ legacyCredits: { credits: 50, creditsGranted: 0, refundedCredits: 0, unitPriceMilli: 500 } });
  assert.equal(pd.isLegacyPurchase(straddled), false);
  assert.equal(pd.describeCreditReceived(straddled), '$25');
});

test("an invoice keeps an old payment's original line, and a new one is one line of credit", () => {
  const { describeInvoice } = load('lib/paymentDisplay.ts');

  const legacy = describeInvoice(LEGACY);
  assert.deepEqual(legacy.lines, [
    { description: '195 Credits at $0.50 each', amountMilli: 97_500 },
    { description: 'Rounding (less than one credit)', amountMilli: 300 },
  ]);
  // The rows and the fee add up to the total charged.
  assert.equal(legacy.lines.reduce((sum, line) => sum + line.amountMilli, 0) + legacy.feeMilli, LEGACY.amountMilli);
  assert.equal(legacy.net, '195 credits');

  const card = describeInvoice(payment({}));
  assert.deepEqual(card.lines, [{ description: '$25 of Tailor credit', amountMilli: 25_000 }]);
  assert.equal(card.feeMilli, 0);
  assert.equal(card.net, '$25');

  assert.equal(card.amountRefundedMilli, 0, 'nothing refunded on a payment that was not');
  // The payments list's Refund returns the whole charge, and reverses what the
  // balance can cover: the rest was spent.
  const refunded = describeInvoice(payment({ state: 'refunded', refundedMilli: 12_400, refundAmountMilli: 25_000 }));
  assert.equal(refunded.amountRefundedMilli, 25_000);
  assert.equal(refunded.reversal, 'Credit reversed: $12.4 of $25 - the other $12.6 had already been spent.');
  const whole = describeInvoice(payment({ state: 'refunded', refundedMilli: 25_000, refundAmountMilli: 25_000 }));
  assert.equal(whole.reversal, 'Credit reversed: $25 of $25.');
  // A row the server sent without the figure reads as the whole charge, as the
  // server reads an older refunded row - never as $0 refunded.
  assert.equal(describeInvoice(payment({ state: 'refunded', refundedMilli: 25_000 })).amountRefundedMilli, 25_000);
});

test('an invoice says what a partial refund returned, and never calls a balance still there spent', () => {
  const { describeInvoice, describeRefundedNote } = load('lib/paymentDisplay.ts');

  // A refund request on a $10 card purchase after 2 x $0.023 was spent:
  // the unspent $9.954 goes back in whole cents, $9.95, and $0.004 stays on
  // the balance. "Amount Refunded" is that, not the $10 paid, and the
  // $0.05 not reversed is not all spent.
  const request = payment({
    amountMilli: 10_000,
    creditMilli: 10_000,
    creditedMilli: 10_000,
    state: 'refunded',
    refundedMilli: 9_950,
    refundAmountMilli: 9_950,
  });
  const invoice = describeInvoice(request);
  assert.equal(invoice.amountRefundedMilli, 9_950);
  assert.equal(
    invoice.reversal,
    'Credit reversed: $9.95 of $10 - the other $0.05 was not reversed: it had been spent, or is still on the balance.'
  );
  assert.equal(
    describeRefundedNote(request),
    '$9.95 of $10 reversed, $9.95 returned - the other $0.05 was not reversed: spent, or still on the balance.'
  );

  // A crypto purchase refunded by hand: the administrator sent $20 of
  // $50, and that much came off the balance.
  const byHand = payment({
    method: 'crypto',
    provider: 'cryptomus',
    amountMilli: 50_000,
    creditMilli: 50_000,
    creditedMilli: 50_000,
    state: 'refunded',
    refundedMilli: 20_000,
    refundAmountMilli: 20_000,
  });
  const byHandInvoice = describeInvoice(byHand);
  assert.equal(byHandInvoice.amountRefundedMilli, 20_000);
  assert.equal(
    byHandInvoice.reversal,
    'Credit reversed: $20 of $50 - the other $30 was not reversed: it had been spent, or is still on the balance.'
  );
  assert.equal(
    describeRefundedNote(byHand),
    '$20 of $50 reversed, $20 returned - the other $30 was not reversed: spent, or still on the balance.'
  );
});

test('the invoice page draws Amount Refunded from the money returned, not the charge', () => {
  const source = fs.readFileSync(path.join(SRC, 'app/credits/invoice/page.tsx'), 'utf8');
  const block = source.slice(source.indexOf('Amount Refunded'));
  const figure = block.slice(0, block.indexOf('</dd>'));
  assert.match(figure, /formatMoney\(invoice\.amountRefundedMilli\)/);
  assert.doesNotMatch(figure, /payment\.amountMilli/);
});

test('an administrator is told what a refund reversed, in dollars, and why an old one reversed nothing', () => {
  const { describeRefundedNote, describeRefundOutcome } = load('lib/paymentDisplay.ts');
  assert.equal(
    describeRefundOutcome('FT-PAY-1', { creditedMilli: 50_000, reversedMilli: 12_400, shortfallMilli: 37_600 }),
    'FT-PAY-1 refunded in full. Only $12.4 of $50 could be reversed - the other $37.6 had already been spent.'
  );
  assert.equal(
    describeRefundOutcome('FT-PAY-1', { creditedMilli: 50_000, reversedMilli: 50_000, shortfallMilli: 0 }),
    'FT-PAY-1 refunded, and all $50 of credit reversed.'
  );
  assert.match(
    describeRefundOutcome('FT-PAY-1', { creditedMilli: 0, reversedMilli: 0, shortfallMilli: 0 }),
    /before credits became dollars .* nothing on the balance to reverse/
  );

  assert.equal(
    describeRefundedNote(payment({ state: 'refunded', refundedMilli: 10_000, refundAmountMilli: 25_000 })),
    '$10 of $25 reversed - the other $15 had been spent.'
  );
  assert.match(describeRefundedNote({ ...LEGACY, state: 'refunded' }), /^0 of 195 credits reversed - the other 195/);
});

// -- the purchase wizard ----------------------------------------------------- //

const CARD = {
  id: 'card',
  method: 'card',
  minAmountMilli: 2_500,
  maxAmountMilli: 100_000,
  presets: [{ amountMilli: 10_000 }, { amountMilli: 5_000 }, { amountMilli: 250_000 }],
};
const CRYPTO = {
  id: 'crypto',
  method: 'crypto',
  minAmountMilli: 50_000,
  maxAmountMilli: 2_000_000,
  presets: [],
};

test('a typed purchase is fitted into the bounds, and refused when it is not dollars and cents', () => {
  const { CHOOSE_AN_AMOUNT, describeFitted, readPurchaseAmount } = load('components/credits/order.ts');
  assert.deepEqual(readPurchaseAmount('25', CARD), { ok: true, milli: 25_000, fitted: null });
  assert.deepEqual(readPurchaseAmount('$12.50', CARD), { ok: true, milli: 12_500, fitted: null });
  assert.deepEqual(readPurchaseAmount('1', CARD), { ok: true, milli: 2_500, fitted: 'min' });
  assert.deepEqual(readPurchaseAmount('500', CARD), { ok: true, milli: 100_000, fitted: 'max' });
  assert.equal(
    describeFitted(readPurchaseAmount('1', CARD), CARD),
    'The smallest card purchase is $2.5. $2.5 will be bought.'
  );
  // Not an amount a card can be charged: refused, never rounded.
  for (const typed of ['2.505', '0', '-5', 'ten', '', '1e3']) {
    assert.deepEqual(readPurchaseAmount(typed, CARD), { ok: false, message: CHOOSE_AN_AMOUNT }, typed);
  }
  // The server's own sentence, so the box and a refused checkout say the same.
  const pricing = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'payments', 'pricing.ts'), 'utf8');
  assert.ok(pricing.includes(`'${CHOOSE_AN_AMOUNT}'`), 'the refusal matches services/payments/pricing.ts');
});

test('the wizard starts at the smallest preset, keeps the amount through Back, and fits it to a new method', () => {
  const { FIRST_STEP, defaultAmountFor, wizardReducer } = load('components/credits/order.ts');
  // The preset outside the bounds is not a starting point.
  assert.equal(defaultAmountFor(CARD), 5_000);
  assert.equal(defaultAmountFor(CRYPTO), 50_000);

  let step = wizardReducer(FIRST_STEP, { type: 'choose', target: CARD });
  assert.deepEqual(step, { name: 'amount', target: CARD, amount: '5.00' });

  // Half-typed amounts are kept as typed; nothing is fitted mid-keystroke.
  step = wizardReducer(step, { type: 'amount', amount: '1' });
  assert.equal(step.amount, '1');
  step = wizardReducer(step, { type: 'amount', amount: '12.5' });
  step = wizardReducer(step, { type: 'forward' });
  assert.deepEqual(step, { name: 'summary', target: CARD, amountMilli: 12_500 });

  // Back keeps it, as dollars in the box.
  step = wizardReducer(step, { type: 'back' });
  assert.deepEqual(step, { name: 'amount', target: CARD, amount: '12.50' });
  step = wizardReducer(step, { type: 'back' });
  assert.deepEqual(step, { name: 'options', amount: '12.50' });

  // Crypto starts at $50: the remembered $12.50 is fitted, not carried.
  step = wizardReducer(step, { type: 'choose', target: CRYPTO });
  assert.deepEqual(step, { name: 'amount', target: CRYPTO, amount: '50.00' });

  // Something that is not an amount does not go forward.
  step = wizardReducer(step, { type: 'amount', amount: '50.005' });
  assert.equal(wizardReducer(step, { type: 'forward' }), step);

  // ...and a method chosen after it starts from that method's default.
  const back = wizardReducer(step, { type: 'back' });
  assert.deepEqual(wizardReducer(back, { type: 'choose', target: CARD }), { name: 'amount', target: CARD, amount: '5.00' });
});

// -- the guard ---------------------------------------------------------------- //

/**
 * The frontend half of test/money.test.js's guard: no page or helper that
 * shows or sends money floors, truncates or float-parses an amount. The old
 * pages did all three - `Math.floor(Number(grantAmount))` turned a $0.50
 * grant into nothing, and `readCount` floored the builder's quote.
 */
const FRONTEND_MONEY_SOURCES = [
  'lib/format.ts',
  'lib/ledger.ts',
  'lib/paymentDisplay.ts',
  'lib/payments.ts',
  'lib/credits.ts',
  'lib/generationQueue.ts',
  'components/credits/order.ts',
  'components/credits/AmountStep.tsx',
  'components/credits/BuyCreditsDialog.tsx',
  'components/credits/OrderSummaryStep.tsx',
  'components/credits/PaymentOptionsStep.tsx',
  'components/credits/CardPanel.tsx',
  'components/credits/CryptoPanel.tsx',
  'components/credits/PayForm.tsx',
  'components/credits/CreditHistory.tsx',
  'components/credits/OrderHistory.tsx',
  'components/credits/PayoutRequestDialog.tsx',
  'components/credits/RefundRequestHistory.tsx',
  'lib/refunds.ts',
  'lib/refundDisplay.ts',
  'components/shell/AppTopBar.tsx',
  'components/auth/AccountMenu.tsx',
  'lib/reporterPay.ts',
  'app/credits/page.tsx',
  'app/credits/invoice/page.tsx',
  'app/credits/return/page.tsx',
  'app/admin/accounts/page.tsx',
  'app/admin/payments/page.tsx',
  'app/admin/payments/RefundQueue.tsx',
  'app/orders/[id]/page.tsx',
  'app/admin/models/page.tsx',
  'app/admin/models/modelPrice.ts',
  // The Job Data Lake: a reporter's earnings and rate, the admin rate, cap and rewards.
  'lib/jobLake.ts',
  'lib/jobLakeDisplay.ts',
  'app/report/page.tsx',
  'app/admin/job-lake/page.tsx',
  'app/admin/job-lake/LakeTab.tsx',
  'app/admin/job-lake/MergeTab.tsx',
  'app/admin/job-lake/SettingsTab.tsx',
];

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

test('no page that shows or sends money floors, truncates or float-parses it', () => {
  for (const relative of FRONTEND_MONEY_SOURCES) {
    const code = withoutComments(fs.readFileSync(path.join(SRC, relative), 'utf8'));
    for (const banned of [/Math\.floor\s*\(/, /Math\.trunc\s*\(/, /parseFloat\s*\(/, /parseInt\s*\(/, /Number\.isInteger\s*\(/, /\.toFixed\s*\(/]) {
      assert.doesNotMatch(code, banned, `${relative} uses ${banned.source.replace(/\\s\*\\\(/, '').replace(/\\/g, '')}`);
    }
  }
});

/**
 * And no box an amount is typed into is `type="number"`. A number box hands
 * the page what the BROWSER made of the keystrokes: in an en-US Chrome "0,023"
 * arrives as "0023", so Admin -> Models saved $23 a resume - a thousand
 * times the price typed - where a text box sends "0,023" on, for parseDollars
 * and the server to refuse by name. Every dollar box is
 * `type="text" inputMode="decimal"`.
 */
test('no box an amount of money is typed into is a number box', () => {
  for (const relative of FRONTEND_MONEY_SOURCES) {
    const code = withoutComments(fs.readFileSync(path.join(SRC, relative), 'utf8'));
    assert.doesNotMatch(code, /type=\{?["'`]number["'`]\}?/, `${relative} has a type="number" input`);
  }
  // The one that did, by name: Admin -> Models' price per resume.
  const models = withoutComments(fs.readFileSync(path.join(SRC, 'app/admin/models/page.tsx'), 'utf8'));
  const priceBox = models.match(/<input\s+id="model-price-per-resume"[\s\S]*?\/>/);
  assert.ok(priceBox, 'the price per resume input is found');
  assert.match(priceBox[0], /type="text"/);
  assert.match(priceBox[0], /inputMode="decimal"/);
  assert.doesNotMatch(priceBox[0], /\bstep=|\bmin=|\bmax=/);
});
