const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ts = require('typescript');

const { useTempStorage } = require('./helpers');

/**
 * The browser's half of refund requests and Contact admin.
 *
 * The frontend has no test runner, so its pure helpers are transpiled with the
 * backend's own TypeScript and run from here (the frontendMoney pattern - a
 * module may import another pure frontend module, nothing else). Two kinds of
 * claim:
 *
 *  - MIRRORS of a server rule, run against the server's own compiled code over
 *    the same inputs: the reason a request or a decline must give, the amount
 *    a crypto refund may say was sent, the app path a notice may link to, the
 *    contact types and their default labels. A box that accepts what the
 *    server refuses is a form that cannot be sent and does not say why.
 *  - DECISIONS with no React in them: which button a charge or a purchase
 *    gets, which a request in the queue gets, what the confirmation says
 *    before money moves, which sentences get a Contact admin link, which of
 *    two open dialogs Escape closes, and that a link the server built is the
 *    only kind that reaches an anchor.
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
      throw new Error(`${path.relative(SRC, file)} imports ${specifier}; these helpers import only other pure frontend modules`);
    }
    return loadFile(target);
  };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, requireFrontend);
  return module.exports;
}

const load = (relative) => loadFile(path.join(SRC, relative));

/** The server's modules, on a temp database nobody opens: these tests only read their rules. */
function server() {
  useTempStorage(`frontend-refunds-${Math.random().toString(36).slice(2)}`);
  return {
    refunds: require('../dist/services/refunds'),
    contact: require('../dist/services/contact'),
    notifications: require('../dist/database/notificationRepository'),
    publicError: require('../dist/middleware/publicError'),
    aiErrors: require('../dist/services/ai/errors'),
  };
}

/**
 * The sentence a server function refuses a REASON with, or null when the
 * reason got past its check (whatever it failed on after that - these calls
 * name no real item, and the reason is checked first).
 */
function reasonRefusal(run) {
  try {
    run();
    return null;
  } catch (error) {
    return error.code === 'reason-required' || error.code === 'reason-too-long' ? error.message : null;
  }
}

// -- reasons -------------------------------------------------------------- //

test("a refund reason is refused by the page exactly when, and in the words, the server refuses it", () => {
  const { refunds } = server();
  const display = load('lib/refundDisplay.ts');
  assert.equal(display.MAX_REFUND_REASON, refunds.MAX_REFUND_REASON);

  const inputs = [
    '',
    '   ',
    '\u0000\u0007\t ',
    'It never built.',
    '  padded  ',
    'x'.repeat(refunds.MAX_REFUND_REASON),
    'x'.repeat(refunds.MAX_REFUND_REASON + 1),
    // Control characters do not count towards the limit - they are removed first.
    `${'x'.repeat(refunds.MAX_REFUND_REASON)}\u0001\u0002`,
    'line one\nline two',
  ];
  for (const input of inputs) {
    assert.equal(display.cleanRefundReason(input), refunds.cleanReason(input) ?? '', JSON.stringify(input));

    // The requester's check runs before anything is looked up, so an unknown
    // payment is fine here: a reason refusal comes first or not at all.
    const serverSaid = reasonRefusal(() =>
      refunds.createRefundRequest({ id: 'nobody' }, { itemType: 'payment', itemId: 'p', reason: input })
    );
    assert.equal(display.refundReasonProblem(input, 'requester'), serverSaid, `requester: ${JSON.stringify(input)}`);

    const adminSaid = reasonRefusal(() => refunds.declineRefund('nothing', { id: 'admin' }, { reason: input }));
    assert.equal(display.refundReasonProblem(input, 'admin'), adminSaid, `admin: ${JSON.stringify(input)}`);
  }
});

// -- what a charge offers ------------------------------------------------- //

function option(overrides = {}) {
  return {
    kind: 'resume',
    itemType: 'order-item',
    itemId: 'item-1',
    label: 'FT-20261005-0001 - Jane / Acme',
    chargedMilli: 23,
    refundableMilli: 23,
    available: true,
    unavailableCode: null,
    unavailableReason: null,
    paymentMethod: null,
    openRequest: null,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    id: 'rfr_1',
    reference: 'FT-RF-20261005-0001',
    kind: 'resume',
    itemType: 'order-item',
    itemId: 'item-1',
    label: 'FT-20261005-0001 - Jane / Acme',
    amountMilli: 23,
    refundedMilli: 0,
    reason: 'It never arrived.',
    state: 'requested',
    declineReason: '',
    paymentMethod: null,
    createdAt: '2026-10-05T10:00:00.000Z',
    updatedAt: '2026-10-05T10:00:00.000Z',
    decidedAt: null,
    refundedAt: null,
    ...overrides,
  };
}

test('a charge offers Ask, says an open request is open, or says why not - never a second request', () => {
  const { refundActionFor } = load('lib/refundDisplay.ts');

  assert.deepEqual(refundActionFor(option()), { kind: 'ask' });

  // One open request per item: the open one is shown, and no Ask - even
  // though the item itself could still be refunded.
  const open = request({ state: 'approved' });
  assert.deepEqual(refundActionFor(option({ available: false, openRequest: open })), { kind: 'open', request: open });

  assert.deepEqual(
    refundActionFor(option({ available: false, refundableMilli: 0, unavailableCode: 'refunded', unavailableReason: 'x' })),
    { kind: 'refunded' }
  );
  assert.deepEqual(
    refundActionFor(
      option({
        available: false,
        refundableMilli: 0,
        unavailableCode: 'in-progress',
        unavailableReason: 'This resume is still being built.',
      })
    ),
    { kind: 'none', reason: 'This resume is still being built.' }
  );
});

test('a purchase offers "Ask for refund" only while paid and credited in dollars - the server\'s own rule', () => {
  const { purchaseOffersRefund } = load('lib/refundDisplay.ts');

  assert.equal(purchaseOffersRefund({ state: 'paid', creditedMilli: 25000 }), true);
  // Paid before credits were dollars: nothing of it is on any balance, and
  // the server refuses it as `legacy` - so no button that can only be refused.
  assert.equal(purchaseOffersRefund({ state: 'paid', creditedMilli: 0 }), false);
  for (const state of ['pending', 'failed', 'expired', 'refunding', 'refunded']) {
    assert.equal(purchaseOffersRefund({ state, creditedMilli: 25000 }), false, state);
  }

  // The server's rule it mirrors, pinned to its source: refunded and
  // refunding first, then not paid, then nothing credited in dollars.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'refunds', 'index.ts'), 'utf8');
  assert.match(source, /if \(payment\.state !== 'paid'\) \{\s*return unavailable\('not-paid'/);
  assert.match(source, /if \(payment\.creditedMilli <= 0\) \{\s*return unavailable\(\s*'legacy'/);
});

test("a resume's Refund cell says it came back on its own, or was never charged, rather than a bare dash", () => {
  const { refundCellNote } = load('lib/refundDisplay.ts');
  assert.equal(refundCellNote({ unavailableCode: 'auto-refunded' }), 'Refunded automatically');
  assert.equal(refundCellNote({ unavailableCode: 'not-charged' }), 'Not charged');
  for (const code of ['in-progress', 'cost-unknown', 'refunded', null]) {
    assert.equal(refundCellNote({ unavailableCode: code }), null, String(code));
  }
});

test('only a dollar-era charge for resumes in the credit history offers a refund, by its reservation', () => {
  const { refundChargeIdFor } = load('lib/refundDisplay.ts');
  const row = (overrides) => ({
    seq: 1,
    id: 'l1',
    userId: 'u1',
    deltaMilli: -161,
    balanceAfterMilli: 839,
    legacyCredits: null,
    reason: 'generation-reserve',
    refKind: 'batch',
    refId: 'batch-1',
    note: '',
    createdAt: '2026-10-05T10:00:00.000Z',
    ...overrides,
  });

  assert.equal(refundChargeIdFor(row()), 'batch-1');
  assert.equal(refundChargeIdFor(row({ refKind: 'request', refId: ' req-1 ' })), 'req-1');
  // Everything else is not a charge for resumes, or not one that can be given back.
  assert.equal(refundChargeIdFor(row({ reason: 'purchase', deltaMilli: 5000 })), null);
  assert.equal(refundChargeIdFor(row({ reason: 'generation-refund', deltaMilli: 23 })), null);
  assert.equal(refundChargeIdFor(row({ reason: 'refund-request', deltaMilli: 23 })), null);
  assert.equal(refundChargeIdFor(row({ deltaMilli: 0 })), null);
  assert.equal(refundChargeIdFor(row({ refId: '' })), null);
  // From before credits were dollars: reset with every balance.
  assert.equal(refundChargeIdFor(row({ deltaMilli: 0, legacyCredits: { delta: -3, balanceAfter: 7 } })), null);
});

test("the requester's line says what happens next, the administrator's reason, or what came back", () => {
  const { describeRequestOutcome, REFUND_STATE_LABELS, REFUND_STATE_TONES, describeRefundOffer } =
    load('lib/refundDisplay.ts');

  assert.deepEqual(Object.keys(REFUND_STATE_LABELS).sort(), ['approved', 'declined', 'refunded', 'requested']);
  assert.deepEqual(Object.keys(REFUND_STATE_TONES).sort(), Object.keys(REFUND_STATE_LABELS).sort());

  assert.match(describeRequestOutcome(request()), /Waiting for an administrator/);
  assert.equal(
    describeRequestOutcome(request({ state: 'declined', declineReason: 'It was downloaded twice.' })),
    'Declined: It was downloaded twice.'
  );
  assert.equal(
    describeRequestOutcome(request({ state: 'refunded', refundedMilli: 23 })),
    '$0.023 back on your balance.'
  );
  assert.equal(
    describeRequestOutcome(
      request({ state: 'refunded', kind: 'purchase', itemType: 'payment', paymentMethod: 'card', refundedMilli: 39990 })
    ),
    '$39.990 on its way back to your card.'
  );
  assert.match(
    describeRequestOutcome(request({ state: 'refunded', kind: 'purchase', paymentMethod: 'crypto', refundedMilli: 5000 })),
    /^\$5\.000 sent back to you by your administrator/
  );

  assert.match(describeRefundOffer(option()), /^\$0\.023 back on your balance as credit/);
  assert.match(
    describeRefundOffer(option({ kind: 'purchase', itemType: 'payment', paymentMethod: 'card', refundableMilli: 39990 })),
    /^\$39\.990 back to your card: what is left unspent/
  );
});

// -- the administrators' queue -------------------------------------------- //

function adminRequest(overrides = {}) {
  return {
    ...request(),
    accountId: 'u1',
    accountEmail: 'jane@example.com',
    paymentProvider: null,
    paymentReference: null,
    decidedBy: null,
    refundedBy: null,
    attemptMilli: null,
    refundableNowMilli: 23,
    refundableNowReason: null,
    ...overrides,
  };
}

test("the queue offers exactly the server's transitions, and nothing on a final request", () => {
  const { adminRefundActions } = load('lib/refundDisplay.ts');
  assert.deepEqual(adminRefundActions('requested'), ['approve', 'decline', 'refund']);
  assert.deepEqual(adminRefundActions('approved'), ['decline', 'refund']);
  assert.deepEqual(adminRefundActions('declined'), []);
  assert.deepEqual(adminRefundActions('refunded'), []);
});

test('Mark refunded says what will move before it moves - and crypto says send it back by hand first', () => {
  const { describeRefundConfirmation } = load('lib/refundDisplay.ts');

  const resume = describeRefundConfirmation(adminRequest());
  assert.equal(resume.title, 'Credit $0.023 back to jane@example.com?');
  assert.equal(resume.byHand, false);
  assert.equal(resume.blocked, null);

  const card = describeRefundConfirmation(
    adminRequest({
      kind: 'purchase',
      itemType: 'payment',
      paymentMethod: 'card',
      paymentProvider: 'stripe',
      amountMilli: 39990,
      refundableNowMilli: 12340,
    })
  );
  // The re-measured amount, not what was asked: they spent some since.
  assert.equal(card.title, "Refund $12.340 to jane@example.com's card?");
  assert.match(card.body, /partial Stripe refund/);
  assert.equal(card.byHand, false);

  const crypto = describeRefundConfirmation(
    adminRequest({
      kind: 'purchase',
      itemType: 'payment',
      paymentMethod: 'crypto',
      paymentProvider: 'cryptomus',
      amountMilli: 50000,
      refundableNowMilli: 50000,
    })
  );
  assert.equal(crypto.byHand, true);
  assert.match(crypto.body, /^Crypto cannot be refunded automatically\. Send \$50\.000 back from your Cryptomus merchant dashboard first/);

  const nothing = describeRefundConfirmation(
    adminRequest({ refundableNowMilli: 0, refundableNowReason: 'Nothing of this purchase is left unspent to refund.' })
  );
  assert.match(nothing.blocked, /^Nothing of this purchase is left unspent to refund\. Decline the request instead\.$/);
});

test("the amount a crypto refund says was sent is held to the server's rule", () => {
  const { refunds } = server();
  const money = require('../dist/utils/money');
  const { amountSentProblem } = load('lib/refundDisplay.ts');
  const asked = 50000;

  /*
   * The server's check, made from the server's own parts in the order
   * services/refunds `refundPurchase` makes it. Reaching it there needs a paid
   * crypto purchase and an open request; the sentence it ends in is pinned to
   * the source below, so this copy cannot drift from it unnoticed.
   */
  const serverSays = (value) => {
    const parsed = money.parseDollars(value);
    if (!parsed.ok) return money.describeDollarProblem(parsed.problem, 'The amount sent back');
    if (parsed.milli <= 0 || !money.isWholeCents(parsed.milli) || parsed.milli > asked) {
      return (
        'The amount sent back must be whole cents, more than $0.000 and no more than the ' +
        `${money.formatMoney(asked)} asked for.`
      );
    }
    return null;
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'refunds', 'index.ts'), 'utf8');
  assert.match(source, /The amount sent back must be whole cents, more than \$0\.000 and no more than the/);
  assert.match(source, /describeDollarProblem\(parsed\.problem, 'The amount sent back'\)/);
  assert.equal(typeof refunds.refundRequest, 'function');

  for (const value of ['49.99', '$50', '50', '50.01', '49.995', '49.9951', '0', '-1', 'ten', '1e3', '12,50']) {
    assert.equal(amountSentProblem(value, asked), serverSays(value), JSON.stringify(value));
  }
  // Left empty, it is not checked: the queue sends the figure its dialog named.
  assert.equal(amountSentProblem('', asked), null);
  assert.equal(amountSentProblem('   ', asked), null);
});

test('a crypto refund recorded by hand always sends the amount the administrator confirmed sending', () => {
  const money = require('../dist/utils/money');
  const { byHandRefundBody } = load('lib/refundDisplay.ts');
  // Nothing typed: the figure the dialog asked them to confirm, as text the
  // server reads back to exactly that - never left for it to measure again.
  for (const milli of [10000, 39990, 120, 1_000_000_000]) {
    const body = byHandRefundBody('', milli);
    assert.equal(body.paidByHand, true);
    assert.equal(typeof body.amountUsd, 'string');
    const parsed = money.parseDollars(body.amountUsd);
    assert.ok(parsed.ok, body.amountUsd);
    assert.equal(parsed.milli, milli, body.amountUsd);
  }
  assert.deepEqual(byHandRefundBody('   ', 10000), { paidByHand: true, amountUsd: '10.00' });
  // Typed: what was typed, as typed, for the server to check.
  assert.deepEqual(byHandRefundBody(' 7.50 ', 10000), { paidByHand: true, amountUsd: '7.50' });
});

test('the queue says what each decision did, and a repeat press as "already", never as an error', () => {
  const { describeDecision, describeRefundMade, describeClosedRequests } = load('lib/refundDisplay.ts');
  const row = adminRequest();

  assert.match(describeDecision('approve', row, true), /approved\. jane@example\.com has been told; no money has moved yet\./);
  assert.match(describeDecision('approve', row, false), /was already approved/);
  assert.match(describeDecision('decline', row, false), /first reason stands/);

  assert.equal(
    describeRefundMade(row, { refundedMilli: 23, reversedMilli: 0, shortfallMilli: 0 }, true),
    'FT-RF-20261005-0001 refunded: $0.023 credited back to jane@example.com.'
  );
  assert.match(describeRefundMade(row, null, false), /already refunded - nothing more was moved/);

  const card = adminRequest({ kind: 'purchase', paymentMethod: 'card', paymentProvider: 'stripe' });
  assert.equal(
    describeRefundMade(card, { refundedMilli: 39990, reversedMilli: 39990, shortfallMilli: 0 }, true),
    'FT-RF-20261005-0001 refunded: $39.990 back to the card, and $39.990 of credit taken off the balance.'
  );
  // Only money sent back by hand can fall short, and the sentence does not
  // guess why the rest was gone.
  const crypto = adminRequest({ kind: 'purchase', paymentMethod: 'crypto', paymentProvider: 'cryptomus' });
  assert.equal(
    describeRefundMade(crypto, { refundedMilli: 10000, reversedMilli: 7000, shortfallMilli: 3000 }, true),
    'FT-RF-20261005-0001 marked refunded: $10.000 recorded as sent back by hand. Only $7.000 of credit could be ' +
      'taken off the balance - the other $3.000 was no longer on it.'
  );

  assert.equal(describeClosedRequests(0), '');
  assert.equal(describeClosedRequests(undefined), '');
  assert.match(describeClosedRequests(1), /Its open refund request was closed as Refunded\./);
  assert.match(describeClosedRequests(2), /Its 2 open refund requests/);
});

test("a refusal that means the queue's row is out of date reads the list again - and every refusal is sorted", () => {
  const { isStaleRefundRefusal } = load('lib/refundDisplay.ts');
  const stale = [
    'request-final',
    'not-found',
    'not-refundable',
    'nothing-unspent',
    'account-missing',
    'refunding',
    'refund-unconfirmed',
  ];
  // About this press, not the row: what was typed, or the by-hand confirmation still to give.
  const notStale = ['paid-by-hand-required', 'bad-amount', 'reason-required', 'reason-too-long', 'bad-item', 'request-open'];
  for (const code of stale) assert.equal(isStaleRefundRefusal(code), true, code);
  for (const code of notStale) assert.equal(isStaleRefundRefusal(code), false, code);
  assert.equal(isStaleRefundRefusal(undefined), false);

  // Every code the server refuses a refund request with is one of the two -
  // a new one fails here until somebody decides which.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'refunds', 'index.ts'), 'utf8');
  const codes = new Set([...source.matchAll(/,\s*\d{3},\s*'([a-z][a-z-]*)'/g)].map((match) => match[1]));
  assert.ok(codes.size >= 10, `found only ${[...codes].join(', ')}`);
  for (const code of codes) {
    assert.ok(stale.includes(code) || notStale.includes(code), `${code} is neither stale nor about the press`);
  }
});

test('the queue filter reads only what the server accepts, and the open count is requested plus approved', () => {
  const { readRefundFilter, openRequestCount, REFUND_FILTERS } = load('lib/refundDisplay.ts');
  assert.deepEqual(
    REFUND_FILTERS.map((entry) => entry.id),
    ['open', 'requested', 'approved', 'declined', 'refunded', 'all']
  );
  assert.equal(readRefundFilter('declined', 'open'), 'declined');
  assert.equal(readRefundFilter('everything', 'open'), 'open');
  assert.equal(readRefundFilter(null, 'open'), 'open');
  assert.equal(openRequestCount({ requested: 2, approved: 3, declined: 9, refunded: 4 }), 5);
  assert.equal(openRequestCount(null), 0);
});

// -- dialogs over dialogs -------------------------------------------------- //

test('Escape belongs to the top dialog, and the page scrolls again only when the last one closes', () => {
  const { createDialogStack } = load('lib/dialogStack.ts');
  const stack = createDialogStack();
  const body = { style: { overflow: 'auto' } };

  // A refund dialog, then Contact admin opened from its error notice.
  const refund = stack.open(body);
  assert.equal(body.style.overflow, 'hidden');
  assert.equal(stack.isTop(refund), true);
  const contact = stack.open(body);
  assert.equal(stack.isTop(contact), true);
  assert.equal(stack.isTop(refund), false, 'Escape would close the refund dialog underneath too');

  // The outer one unmounted first (its page went away) - the page must not
  // get its scroll back while the inner one is still up...
  stack.close(refund, body);
  assert.equal(body.style.overflow, 'hidden');
  assert.equal(stack.isTop(contact), true);
  // ...and gets back what it had, not the `hidden` the inner one found.
  stack.close(contact, body);
  assert.equal(body.style.overflow, 'auto');
  assert.equal(stack.size(), 0);

  // Closing twice (React's strict-mode double effect, a stale cleanup) changes nothing.
  stack.close(contact, body);
  assert.equal(body.style.overflow, 'auto');
  const again = stack.open(body);
  stack.close(again, body);
  stack.close(again, body);
  assert.equal(body.style.overflow, 'auto');
  assert.equal(stack.isTop(again), false);

  // ONE stack for the page: every kit Dialog and every hand-rolled modal that
  // joins it (useDialogLayer) share `pageDialogs`, which is how a modal that is
  // not a kit Dialog - the payments list's Refund dialog - knows a Contact
  // admin opened from its own error notice is above it.
  const { pageDialogs } = load('lib/dialogStack.ts');
  const page = { style: { overflow: '' } };
  const legacy = pageDialogs.open(page);
  const kit = pageDialogs.open(page);
  assert.equal(pageDialogs.isTop(legacy), false);
  assert.equal(pageDialogs.size(), 2);
  pageDialogs.close(kit, page);
  assert.equal(pageDialogs.isTop(legacy), true);
  pageDialogs.close(legacy, page);
  assert.equal(page.style.overflow, '');
  const dialogSource = fs.readFileSync(path.join(SRC, 'components', 'ui', 'Dialog.tsx'), 'utf8');
  assert.match(dialogSource, /import \{ pageDialogs as dialogs \} from '@\/lib\/dialogStack'/);
  for (const file of [path.join('app', 'admin', 'payments', 'page.tsx')]) {
    assert.match(fs.readFileSync(path.join(SRC, file), 'utf8'), /useDialogLayer\(/, `${file} joins the stack`);
  }
});

// -- links the server hands the page --------------------------------------- //

test("a notice's link is an app path by the server's own rule, or nothing", () => {
  const { notifications } = server();
  const { safeAppPath, appLinkLabel } = load('lib/appLinks.ts');

  const inputs = [
    '/credits?tab=refunds',
    '/admin/payments?tab=refunds',
    '  /orders/abc  ',
    '//evil.example/path',
    '/\\evil.example',
    'https://evil.example/',
    'javascript:alert(1)',
    '/with space',
    '/tab\tbed',
    `/${'x'.repeat(400)}`,
    '',
    null,
    42,
  ];
  for (const input of inputs) {
    assert.equal(safeAppPath(input), notifications.safeAppPath(input) || null, JSON.stringify(input));
  }

  // The two pages the server links refund notices to read as what they are.
  assert.equal(appLinkLabel('/credits?tab=refunds'), 'See your refund requests');
  assert.equal(appLinkLabel('/admin/payments?tab=refunds'), 'Open the refund queue');
  assert.equal(appLinkLabel('/orders'), 'Open');
});

test('every contact link the server builds reaches an anchor unchanged, and nothing else does', () => {
  const { contact } = server();
  const { safeContactHref, opensInNewTab } = load('lib/appLinks.ts');

  const checked = contact.validateContactSettings({
    channels: [
      { type: 'email', value: 'help+tailor@mail.example.co.uk' },
      { type: 'telegram', value: '@tailor_help' },
      { type: 'discord', value: 'tailor.help' },
      { type: 'whatsapp', value: '+1 (555) 123-4567' },
      { type: 'other', value: 'https://example.com/help?x=1#top' },
      { type: 'other', value: 'www.example.org/support' },
      { type: 'other', value: 'Office hours: 9-5' },
    ],
  });
  assert.equal(checked.ok, true);
  for (const channel of checked.channels) {
    // A link the server built passes as it is; text the server left as text stays text.
    assert.equal(safeContactHref(channel.href), channel.href, `${channel.type}: ${channel.value}`);
  }
  assert.equal(opensInNewTab('https://t.me/tailor_help'), true);
  assert.equal(opensInNewTab('mailto:help@example.com'), false);

  for (const hostile of [
    'javascript:alert(1)',
    ' javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'mailto:a@b.com?subject=x&body=y',
    'https://user:pass@example.com/',
    'ftp://example.com/',
    '//example.com',
    '/relative/path',
    '',
    null,
    { href: 'https://example.com' },
  ]) {
    assert.equal(safeContactHref(hostile), null, JSON.stringify(hostile));
  }
});

// -- contact channels ------------------------------------------------------ //

test("the editor offers the server's channel types, and shows the label the server will give an empty one", () => {
  const { contact } = server();
  const { CONTACT_TYPES, CONTACT_TYPE_LABELS, DEFAULT_CONTACT_LABELS, CONTACT_VALUE_HINTS } = load('lib/contactChannels.ts');

  assert.deepEqual([...CONTACT_TYPES], [...contact.CONTACT_CHANNEL_TYPES]);
  for (const type of CONTACT_TYPES) {
    assert.ok(CONTACT_TYPE_LABELS[type], type);
    assert.ok(CONTACT_VALUE_HINTS[type].placeholder, type);
  }

  // Saved with no label, each type gets the server's default - the placeholder the editor shows.
  const samples = {
    email: 'help@example.com',
    telegram: '@tailor_help',
    discord: 'tailor.help',
    whatsapp: '+15551234567',
    other: 'Office hours',
  };
  for (const type of CONTACT_TYPES) {
    const saved = contact.validateContactSettings({ channels: [{ type, label: '', value: samples[type] }] });
    assert.equal(saved.ok, true, type);
    assert.equal(saved.channels[0].label, DEFAULT_CONTACT_LABELS[type], type);
  }

  // And each placeholder is a value the server accepts for its type - a hint
  // that would be refused if typed as shown is a hint that misleads.
  for (const type of CONTACT_TYPES) {
    const saved = contact.checkContactValue(type, CONTACT_VALUE_HINTS[type].placeholder);
    assert.equal(saved.ok, true, `${type}: ${CONTACT_VALUE_HINTS[type].placeholder}`);
  }
});

test("a refused save's field errors land on the rows that were sent, wherever those rows move after", () => {
  const { contact } = server();
  const { readContactFieldErrors, pinContactErrors, moveDraft, sameChannels, toChannelDrafts } =
    load('lib/contactChannels.ts');

  const sent = [
    { key: 'a', type: 'email', label: '', value: 'not an address' },
    { key: 'b', type: 'telegram', label: 'Telegram', value: '@ok_name' },
    { key: 'c', type: 'other', label: 'x'.repeat(61), value: 'javascript:alert(1)' },
  ];
  const refused = contact.validateContactSettings({ channels: sent.map(({ type, label, value }) => ({ type, label, value })) });
  assert.equal(refused.ok, false);

  // The body as the route sends it, read back by the page.
  const body = { error: 'Some contact details need fixing.', code: 'contact-invalid', fieldErrors: refused.errors };
  const errors = readContactFieldErrors(body);
  assert.deepEqual(errors, refused.errors);

  const pinned = pinContactErrors(sent, errors);
  assert.deepEqual(Object.keys(pinned.byKey).sort(), ['a', 'c']);
  assert.match(pinned.byKey.a.value, /email/i);
  assert.match(pinned.byKey.c.value, /http/);
  assert.match(pinned.byKey.c.label, /60/);
  assert.deepEqual(pinned.list, []);

  // Moved after the save, the rows keep their own errors: they are keyed, not indexed.
  const moved = moveDraft(sent, 2, -1);
  assert.deepEqual(moved.map((row) => row.key), ['a', 'c', 'b']);
  assert.ok(pinned.byKey[moved[1].key].value);
  assert.deepEqual(moveDraft(sent, 0, -1).map((row) => row.key), ['a', 'b', 'c']);
  assert.deepEqual(moveDraft(sent, 2, 1).map((row) => row.key), ['a', 'b', 'c']);

  // Too many channels is about the list, not a row.
  const tooMany = contact.validateContactSettings({
    channels: Array.from({ length: contact.MAX_CONTACT_CHANNELS + 1 }, () => ({ type: 'email', value: 'a@b.co' })),
  });
  const list = pinContactErrors([], readContactFieldErrors({ fieldErrors: tooMany.errors }));
  assert.equal(list.list.length, 1);
  assert.deepEqual(list.byKey, {});

  // Anything that is not the server's shape yields nothing, rather than a crash.
  assert.deepEqual(readContactFieldErrors(null), []);
  assert.deepEqual(readContactFieldErrors({ fieldErrors: [{ index: 'x' }, { index: 0, field: 'href', message: 'm' }] }), []);

  let key = 0;
  const drafts = toChannelDrafts([{ type: 'email', label: 'Email', value: 'a@b.co', href: 'mailto:a@b.co' }], () => `k${(key += 1)}`);
  assert.deepEqual(drafts, [{ key: 'k1', type: 'email', label: 'Email', value: 'a@b.co' }]);
  assert.equal(sameChannels(drafts, [{ type: 'email', label: 'Email', value: 'a@b.co' }]), true);
  assert.equal(sameChannels(drafts, [{ type: 'email', label: 'Mail', value: 'a@b.co' }]), false);
  assert.equal(sameChannels(drafts, []), false);
});

test('every sentence that tells its reader to contact an administrator gets the link, and no other', () => {
  const { publicError, aiErrors } = server();
  const { asksForAdministrator } = load('lib/contactChannels.ts');

  const asks = [
    publicError.GENERIC_ERROR_MESSAGE,
    publicError.genericMessage('Could not load your orders'),
    aiErrors.PUBLIC_AI_MESSAGE.contactAdmin,
    // services/auth/authService.ts, refusing a disabled account's sign-in.
    'That account has been disabled. Ask an administrator of this installation to re-enable it.',
    // services/refunds, for a run whose resumes the queue no longer holds.
    "This run's resumes are no longer listed, so they cannot be picked here. Ask your administrator if one of them should be refunded.",
    // The frontend's own (lib/api.ts GENERIC_MESSAGE, lib/userMessage.ts).
    'Something went wrong. Please try again, or contact your administrator.',
    "We can't reach the server right now. Please try again in a moment, or contact your administrator if this continues.",
    "Sign-in isn't available right now. Please contact your administrator.",
  ];
  for (const sentence of asks) assert.equal(asksForAdministrator(sentence), true, sentence);

  const doesNot = [
    // Said TO an administrator, about what they must do on the server.
    'The Claude subscription is not signed in on the server. An administrator needs to run `claude auth login`.',
    // Describes one; asks nothing.
    'Until then, an administrator can add credit to your account directly.',
    'Administrators are not charged for resumes, so you do not need to buy credit.',
    aiErrors.PUBLIC_AI_MESSAGE.busy,
    aiErrors.PUBLIC_AI_MESSAGE.retry,
    'Say why you are asking for a refund.',
    '',
    null,
  ];
  for (const sentence of doesNot) assert.equal(asksForAdministrator(sentence), false, String(sentence));
});

test('a sentence written into a page that asks for an administrator carries its Contact admin link', () => {
  const { asksForAdministrator } = load('lib/contactChannels.ts');
  /*
   * The kit adds the link itself to a notice whose only child is the sentence
   * (`withContactLink`); everywhere else the page has to put a ContactAdminLink
   * or ContactAdminFor after it, in the same element. Read with TypeScript's
   * parser, so what is checked is JSX text and the string literals a JSX
   * expression renders - not comments, props or prose about the rule.
   */
  const SELF_LINKING = new Set(['Notice', 'Status', 'ErrorNotice']);
  const LINKS = new Set(['ContactAdminLink', 'ContactAdminFor']);
  // The dialog itself, which is where the link leads.
  const EXEMPT = new Set([path.join('components', 'contact', 'ContactAdminDialog.tsx')]);

  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx|jsx)$/.test(entry.name)) files.push(full);
    }
  };
  walk(SRC);

  const tagOf = (element) =>
    ts.isJsxElement(element) ? element.openingElement.tagName.getText() : null;
  const meaningful = (children) =>
    children.filter((child) => !(ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces));
  const linksAfter = (siblings, index) =>
    siblings.slice(index + 1).some((sibling) => {
      let found = false;
      const visit = (node) => {
        if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && LINKS.has(node.tagName.getText())) {
          found = true;
        }
        if (!found) ts.forEachChild(node, visit);
      };
      visit(sibling);
      return found;
    });

  const offenders = [];
  let checked = 0;
  for (const file of files) {
    if (EXEMPT.has(path.relative(SRC, file))) continue;
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.TSX
    );
    /** The JSX child a sentence is drawn as, and the element it is a child of. */
    const report = (node, text) => {
      if (!asksForAdministrator(text.replace(/\s+/g, ' '))) return;
      checked += 1;
      let child = node;
      while (child.parent && !ts.isJsxElement(child.parent) && !ts.isJsxFragment(child.parent)) {
        child = child.parent;
        if (ts.isJsxAttribute(child) || ts.isCallExpression(child) || ts.isVariableDeclaration(child)) return;
      }
      const parent = child.parent;
      if (!parent) return;
      const siblings = parent.children;
      const kit = SELF_LINKING.has(tagOf(parent)) && meaningful(siblings).length === 1;
      if (kit || linksAfter(siblings, siblings.indexOf(child))) return;
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      offenders.push(`${path.relative(SRC, file)}:${line + 1}: ${text.trim().replace(/\s+/g, ' ')}`);
    };
    const visit = (node) => {
      if (ts.isJsxText(node)) report(node, node.text);
      else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        // Only a literal a JSX expression renders as it is: `{cond ? 'a' : 'b'}`.
        let up = node.parent;
        while (up && (ts.isConditionalExpression(up) || ts.isParenthesizedExpression(up) || ts.isBinaryExpression(up))) {
          up = up.parent;
        }
        if (up && ts.isJsxExpression(up) && up.parent && (ts.isJsxElement(up.parent) || ts.isJsxFragment(up.parent))) {
          report(node, node.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.ok(checked >= 4, `found only ${checked} such sentences - is the parser reading the pages?`);
  assert.deepEqual(offenders, [], 'these ask for an administrator with no Contact admin link after them');
});
