const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ts = require('typescript');

const { useAdminEmails, useTempStorage } = require('./helpers');

/**
 * The browser's half of refund requests and Contact admin.
 *
 * The frontend has no test runner, so its pure helpers are transpiled with the
 * backend's own TypeScript and run from here (the frontendMoney pattern - a
 * module may import another pure frontend module, nothing else). Two kinds of
 * claim:
 *
 *  - MIRRORS of a server rule, run against the server's own compiled code over
 *    the same inputs: the reason a decline must give, the note a payout
 *    request may carry, why Ask for Refund is off, what Record payout refuses
 *    (through the real queue route), the amount a crypto refund may say was
 *    sent, the app path a notice may link to, the contact types and their
 *    default labels. A box that accepts what the server refuses is a form
 *    that cannot be sent and does not say why.
 *  - DECISIONS with no React in them: which button a request in the queue
 *    gets, what the confirmation says before money moves or a payout is
 *    recorded, how a payout reads once paid out, which sentences get a
 *    Contact admin link, which of two open dialogs Escape closes, and that a
 *    link the server built is the only kind that reaches an anchor - and that
 *    nothing in the browser asks for a refund any more (owner decision R1).
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

/**
 * The real refund-request routes on a fresh database: a reporter with earnings
 * to ask about, and an administrator to decide - for the claims about payouts,
 * which only the routes can settle.
 */
async function payoutServer() {
  useTempStorage(`frontend-payouts-${Math.random().toString(36).slice(2)}`);
  useAdminEmails('boss@example.com');
  const express = require('express');
  // The same modules `server()` reads, not fresh copies: a second copy of the
  // database module would open a second connection to this file, and the two
  // would lock each other out. Connections are kept per file, so the new
  // DB_DIR is all a fresh installation needs.
  const users = require('../dist/database/userRepository');
  const credits = require('../dist/services/credits');
  const { attachUser } = require('../dist/middleware/auth');
  const routes = require('../dist/routes/refundRequests');

  const boss = users.createUser({ email: 'boss@example.com', name: 'Boss' });
  const scout = users.createUser({ email: 'scout@example.com', name: 'Scout', role: 'reporter' });
  const ids = { boss, scout };
  const tokens = { boss: users.createSession(boss.id), scout: users.createSession(scout.id) };

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/refund-requests', routes.default);
  app.use('/api/admin/refund-requests', routes.adminRefundRequestsRouter);
  const listening = app.listen(0);
  const port = listening.address().port;
  const call = async (who, route, init = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return {
    users,
    ids,
    call,
    earn: (who, milli) => credits.grantCredits(ids[who].id, milli, boss.id, 'Job rewards'),
    balance: (who) => users.getUserById(ids[who].id).balanceMilli,
    close: () => listening.close(),
  };
}

// -- reasons and notes ----------------------------------------------------- //

test("a decline's reason and a payout's note are refused by the page exactly when, and in the words, the server refuses them", () => {
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

    const adminSaid = reasonRefusal(() => refunds.declineRefund('nothing', { id: 'admin' }, { reason: input }));
    assert.equal(display.declineReasonProblem(input), adminSaid, `admin: ${JSON.stringify(input)}`);

    // A payout's note is checked before the account is looked up, so an
    // unknown account is fine here: a note refusal comes first or not at all.
    const reporterSaid = reasonRefusal(() => refunds.createPayoutRequest({ id: 'nobody' }, { reason: input }));
    assert.equal(display.payoutNoteProblem(input), reporterSaid, `reporter: ${JSON.stringify(input)}`);
  }
  // Optional: no note is a request with nothing to add.
  assert.equal(display.payoutNoteProblem(''), null);
});

// -- nothing asks for a refund any more ----------------------------------- //

test('no page asks for a refund: the asking routes are gone from the client, and only a reporter asks to be paid out', () => {
  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(full);
    }
    return out;
  };
  const code = (file) => fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

  assert.equal(fs.existsSync(path.join(SRC, 'components', 'credits', 'RefundRequestDialog.tsx')), false);
  for (const file of walk(SRC)) {
    const text = code(file);
    const where = path.relative(SRC, file);
    // The two asking routes the server no longer has, and the button that called them.
    assert.doesNotMatch(text, /refund-requests\/options/, `${where} reads the closed options route`);
    assert.doesNotMatch(text, />\s*Ask for refund\s*</, `${where} still offers Ask for refund`);
    assert.doesNotMatch(text, /refundRequestsApi\.(?:create|options)\b/, `${where} asks for a refund`);
  }
  const client = code(path.join(SRC, 'lib', 'refunds.ts'));
  // Every POST the client makes outside the administrators' queue.
  const posts = [...client.matchAll(/apiFetch<[^>]*>\(\s*['`]([^'`]+)['`],\s*\{\s*method: 'POST'/g)]
    .map((m) => m[1])
    .filter((route) => !route.startsWith('/admin/'));
  assert.deepEqual(posts, ['/refund-requests/payout'], 'the one request a page may make is a payout request');

  // The reporter's Credits has the button, where a user's has Purchase Credits.
  const credits = code(path.join(SRC, 'app', 'credits', 'page.tsx'));
  const earnings = credits.slice(credits.indexOf('function EarningsCredits('), credits.indexOf('function CreditsBody('));
  assert.match(earnings, /<div className="ml-auto">\s*<button[\s\S]*?data-shape="pill"[\s\S]*?Ask for Refund\s*<\/button>/);
  assert.match(earnings, /disabled=\{Boolean\(askBlocked\)\}/);
  assert.match(earnings, /<PayoutRequestDialog/);
  assert.match(earnings, /<RefundRequestHistory[^>]*variant="payouts"/);
  const purchaser = credits.slice(credits.indexOf('function PurchaserCredits('), credits.indexOf('function EarningsCredits('));
  assert.doesNotMatch(purchaser, /Ask for Refund|PayoutRequestDialog|payoutRequestsApi/);
  // The dialog never sends a figure: the server reads the balance itself.
  const dialog = code(path.join(SRC, 'components', 'credits', 'PayoutRequestDialog.tsx'));
  assert.match(dialog, /payoutRequestsApi\.create\(note\)/);
  assert.doesNotMatch(dialog, /amountUsd|<input[^>]*inputMode="decimal"/);
});

// -- how a request reads --------------------------------------------------- //

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

function payoutRequest(overrides = {}) {
  return request({
    kind: 'payout',
    itemType: 'payout',
    itemId: 'u-scout',
    label: 'Payout of earnings',
    amountMilli: 5_000,
    reason: '',
    ...overrides,
  });
}

test("the requester's line says what happens next, the administrator's reason, or what came back - and a payout is Paid out", () => {
  const { describeRequestOutcome, REFUND_STATE_LABELS, REFUND_STATE_TONES, refundStateLabel, refundKindLabel } =
    load('lib/refundDisplay.ts');
  const { REFUND_REQUEST_KINDS } = require('../dist/database/refundRequestRepository');

  assert.deepEqual(Object.keys(REFUND_STATE_LABELS).sort(), ['approved', 'declined', 'refunded', 'requested']);
  assert.deepEqual(Object.keys(REFUND_STATE_TONES).sort(), Object.keys(REFUND_STATE_LABELS).sort());
  // Every kind the server writes has a word, and one it does not know reads as itself.
  for (const kind of REFUND_REQUEST_KINDS) assert.notEqual(refundKindLabel(kind), kind, kind);
  assert.equal(refundKindLabel('payout'), 'Payout');
  assert.equal(refundKindLabel('gift'), 'gift');

  assert.match(describeRequestOutcome(request()), /Waiting for an administrator/);
  assert.equal(
    describeRequestOutcome(request({ state: 'declined', declineReason: 'It was downloaded twice.' })),
    'Declined: It was downloaded twice.'
  );
  assert.equal(describeRequestOutcome(request({ state: 'refunded', refundedMilli: 23 })), '$0.023 back on your balance.');
  assert.equal(
    describeRequestOutcome(
      request({ state: 'refunded', kind: 'purchase', itemType: 'payment', paymentMethod: 'card', refundedMilli: 39990 })
    ),
    '$39.99 on its way back to your card.'
  );
  assert.match(
    describeRequestOutcome(request({ state: 'refunded', kind: 'purchase', paymentMethod: 'crypto', refundedMilli: 5000 })),
    /^\$5 sent back to you by your administrator/
  );

  // A payout: "Paid out", never "Refunded", with what was RECORDED - which may
  // be more than was asked (owner decision R2).
  assert.equal(refundStateLabel(payoutRequest({ state: 'refunded', refundedMilli: 6_500 })), 'Paid out');
  assert.equal(refundStateLabel(payoutRequest()), 'Requested');
  assert.equal(refundStateLabel(request({ state: 'refunded' })), 'Refunded');
  assert.equal(describeRequestOutcome(payoutRequest({ state: 'refunded', refundedMilli: 6_500 })), '$6.5 paid out to you.');
  assert.match(describeRequestOutcome(payoutRequest({ state: 'approved' })), /The payout itself follows/);
});

test("Ask for Refund is off exactly when, and for the reason, the server says a reporter cannot ask", async () => {
  const s = await payoutServer();
  try {
    const { payoutBlocker, describePayoutAsk } = load('lib/refundDisplay.ts');
    const standing = async (who) => {
      const answer = await s.call(who, '/api/refund-requests/payout');
      assert.equal(answer.status, 200, who);
      return answer.body;
    };

    // Nothing earned yet: off, in the server's words.
    let status = await standing('scout');
    assert.equal(status.available, false);
    assert.equal(payoutBlocker(status, false), status.unavailableReason);
    assert.equal(status.unavailableCode, 'nothing-to-pay-out');

    // Earned: on, and the dialog names the whole balance.
    s.earn('scout', 4_100);
    status = await standing('scout');
    assert.equal(status.available, true);
    assert.equal(payoutBlocker(status, false), '');
    assert.match(describePayoutAsk(status.balanceMilli), /pay out your earned balance, \$4\.1\./);

    // Asked: off again while the request is open - one at a time.
    const asked = await s.call('scout', '/api/refund-requests/payout', { method: 'POST', body: { reason: 'PayPal please' } });
    assert.equal(asked.status, 201);
    assert.equal(asked.body.request.amountMilli, 4_100);
    status = asked.body.status;
    assert.equal(status.unavailableCode, 'request-open');
    assert.equal(payoutBlocker(status, false), status.unavailableReason);
    // ...and a second press is refused in the same words the button's tooltip said.
    const again = await s.call('scout', '/api/refund-requests/payout', { method: 'POST', body: {} });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, payoutBlocker(status, false));

    // An administrator passes the reporter guard and is refused by the service, by name.
    const admin = await standing('boss');
    assert.equal(admin.unavailableCode, 'not-a-reporter');
    assert.equal(payoutBlocker(admin, false), admin.unavailableReason);

    // Not read yet, or not readable: off, and said so rather than asked blind.
    assert.match(payoutBlocker(null, true), /Checking/);
    assert.match(payoutBlocker(null, false), /could not be read/);
  } finally {
    s.close();
  }
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
  assert.equal(card.title, "Refund $12.34 to jane@example.com's card?");
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
  assert.match(crypto.body, /^Crypto cannot be refunded automatically\. Send \$50 back from your Cryptomus merchant dashboard first/);

  const nothing = describeRefundConfirmation(
    adminRequest({ refundableNowMilli: 0, refundableNowReason: 'Nothing of this purchase is left unspent to refund.' })
  );
  assert.match(nothing.blocked, /^Nothing of this purchase is left unspent to refund\. Decline the request instead\.$/);

  // A payout is never described as a refund, even through this.
  const payout = describeRefundConfirmation(
    adminRequest({ ...payoutRequest(), accountEmail: 'scout@example.com', refundableNowMilli: 6_000 })
  );
  assert.equal(payout.title, 'Record a payout to scout@example.com?');
  assert.equal(payout.byHand, false);
  assert.equal(payout.amountMilli, 5_000);
});

test('Record payout is prefilled with the smaller of what was asked and the balance now, and says what it records', () => {
  const { describePayoutConfirmation, describePayoutBalanceNow, refundActionLabel } = load('lib/refundDisplay.ts');
  const row = (overrides) => adminRequest({ ...payoutRequest(), accountEmail: 'scout@example.com', ...overrides });

  // Earned more since asking: what was asked, and the balance named as the most.
  const more = describePayoutConfirmation(row({ refundableNowMilli: 6_500 }));
  assert.equal(more.prefillMilli, 5_000);
  assert.equal(more.balanceMilli, 6_500);
  assert.equal(more.blocked, null);
  assert.match(more.body, /asked to be paid out \$5 of earnings; their balance now is \$6\.5\./);
  // Paid some out from Admin -> Accounts since (that closes the request, but a
  // list read before it still shows it): the balance now, never above it.
  assert.equal(describePayoutConfirmation(row({ refundableNowMilli: 1_200 })).prefillMilli, 1_200);
  // Nothing left, or no longer a reporter: blocked with the server's reason.
  const gone = describePayoutConfirmation(
    row({ refundableNowMilli: 0, refundableNowReason: 'That account is no longer a reporter, so its balance is not paid out.' })
  );
  assert.equal(gone.blocked, 'That account is no longer a reporter, so its balance is not paid out. Decline the request instead.');

  assert.equal(describePayoutBalanceNow(row({ refundableNowMilli: 6_500 })), 'Balance now $6.5');
  assert.equal(describePayoutBalanceNow(row({ refundableNowMilli: 0, refundableNowReason: 'Gone.' })), 'Gone.');
  assert.equal(describePayoutBalanceNow(row({ state: 'refunded', refundableNowMilli: null })), null);
  assert.equal(describePayoutBalanceNow(adminRequest()), null, 'only a payout says its balance');
  assert.equal(refundActionLabel(row({})), 'Record payout');
  assert.equal(refundActionLabel(adminRequest()), 'Mark refunded');
});

test("Record payout in the queue refuses what the real route refuses, in its words, and records what it lets through", async () => {
  const s = await payoutServer();
  try {
    const pay = load('lib/reporterPay.ts');
    const display = load('lib/refundDisplay.ts');
    s.earn('scout', 5_000);
    const asked = await s.call('scout', '/api/refund-requests/payout', { method: 'POST', body: {} });
    assert.equal(asked.status, 201);
    const id = asked.body.request.id;
    const listed = (await s.call('boss', '/api/admin/refund-requests')).body.requests.find((row) => row.id === id);
    const prompt = display.describePayoutConfirmation(listed);
    assert.equal(prompt.balanceMilli, 5_000);
    assert.equal(prompt.prefillMilli, 5_000);

    // Earned more since: up to the new balance is allowed, as the box says.
    s.earn('scout', 1_500);
    const balance = s.balance('scout');
    const cases = [
      ['', 'Bank transfer'],
      ['0', 'Bank transfer'],
      ['-1', 'Bank transfer'],
      ['0.0005', 'Bank transfer'],
      ['abc', 'Bank transfer'],
      ['1', ''],
      ['1', 'x'.repeat(501)],
      ['6.501', 'Bank transfer'],
    ];
    for (const [amountUsd, note] of cases) {
      const said = pay.payoutProblem(amountUsd, note, balance);
      assert.notEqual(said, '', `the page refuses ${JSON.stringify([amountUsd, note])}`);
      const refused = await s.call('boss', `/api/admin/refund-requests/${id}/refund`, {
        method: 'POST',
        body: { amountUsd, note },
      });
      assert.ok(refused.status === 400 || refused.status === 409, `${amountUsd}: ${refused.status}`);
      assert.equal(refused.body.error, said, JSON.stringify([amountUsd, note]));
      // Each is about the press, so the dialog stays open on what was typed.
      assert.equal(display.isStaleRefundRefusal(refused.body.code), false, refused.body.code);
    }
    assert.equal(s.balance('scout'), balance, 'no refusal moved anything');

    // More than was asked, up to the balance: recorded, and the request Paid out.
    assert.equal(pay.payoutProblem('6.5', 'Bank transfer, ref 4471', balance), '');
    const paid = await s.call('boss', `/api/admin/refund-requests/${id}/refund`, {
      method: 'POST',
      body: { amountUsd: '6.5', note: 'Bank transfer, ref 4471' },
    });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.changed, true);
    assert.equal(s.balance('scout'), 0);
    assert.equal(display.refundStateLabel(paid.body.request), 'Paid out');
    assert.equal(
      display.describeRefundMade(paid.body.request, paid.body.outcome, paid.body.changed),
      `${paid.body.request.reference} paid out: $6.5 recorded as paid to scout@example.com and taken off their ` +
        'balance. They have been told.'
    );
    // A second press: already paid out, nothing more recorded.
    const again = await s.call('boss', `/api/admin/refund-requests/${id}/refund`, {
      method: 'POST',
      body: { amountUsd: '6.5', note: 'Bank transfer, ref 4471' },
    });
    assert.equal(again.status, 200);
    assert.equal(
      display.describeRefundMade(again.body.request, again.body.outcome, again.body.changed),
      `${paid.body.request.reference} was already paid out - nothing more was recorded.`
    );
    // And the reporter's own list reads it as the page will.
    const mine = (await s.call('scout', '/api/refund-requests?kind=payout')).body.requests;
    assert.equal(mine.length, 1);
    assert.equal(display.refundStateLabel(mine[0]), 'Paid out');
    assert.equal(display.describeRequestOutcome(mine[0]), '$6.5 paid out to you.');
  } finally {
    s.close();
  }
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
        'The amount sent back must be whole cents, more than $0 and no more than the ' +
        `${money.formatMoney(asked)} asked for.`
      );
    }
    return null;
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'refunds', 'index.ts'), 'utf8');
  assert.match(source, /The amount sent back must be whole cents, more than \$0 and no more than the/);
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
    'FT-RF-20261005-0001 refunded: $39.99 back to the card, and $39.99 of credit taken off the balance.'
  );
  // Only money sent back by hand can fall short, and the sentence does not
  // guess why the rest was gone.
  const crypto = adminRequest({ kind: 'purchase', paymentMethod: 'crypto', paymentProvider: 'cryptomus' });
  assert.equal(
    describeRefundMade(crypto, { refundedMilli: 10000, reversedMilli: 7000, shortfallMilli: 3000 }, true),
    'FT-RF-20261005-0001 marked refunded: $10 recorded as sent back by hand. Only $7 of credit could be ' +
      'taken off the balance - the other $3 was no longer on it.'
  );
  // A payout already paid out says so in payout words.
  const payout = adminRequest({ ...payoutRequest(), state: 'refunded' });
  assert.equal(describeRefundMade(payout, null, false), 'FT-RF-20261005-0001 was already paid out - nothing more was recorded.');

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
    // A payout's account no longer a reporter; a request a newer build wrote.
    'not-a-reporter',
    'unrecognised',
  ];
  // About this press, not the row: what was typed, or the by-hand confirmation
  // still to give. A payout above the balance names the balance now, and the
  // dialog stays open to record less; asking with nothing to pay out is the
  // reporter's side.
  const notStale = [
    'paid-by-hand-required',
    'bad-amount',
    'reason-required',
    'reason-too-long',
    'bad-item',
    'request-open',
    'insufficient-balance',
    'nothing-to-pay-out',
    'note-required',
    'note-too-long',
  ];
  for (const code of stale) assert.equal(isStaleRefundRefusal(code), true, code);
  for (const code of notStale) assert.equal(isStaleRefundRefusal(code), false, code);
  assert.equal(isStaleRefundRefusal(undefined), false);

  // Every code the server refuses a refund request with is one of the two -
  // a new one fails here until somebody decides which.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'refunds', 'index.ts'), 'utf8');
  const codes = new Set([...source.matchAll(/,\s*\d{3},\s*'([a-z][a-z-]*)'/g)].map((match) => match[1]));
  // Record payout's note is read by services/credits `readPayoutNote`, shared with Admin -> Accounts.
  const credits = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'credits', 'index.ts'), 'utf8');
  const noteReader = credits.slice(credits.indexOf('export function readPayoutNote('));
  for (const match of noteReader.slice(0, noteReader.indexOf('\n}\n')).matchAll(/code: '([a-z][a-z-]*)'/g)) {
    codes.add(match[1]);
  }
  for (const code of ['insufficient-balance', 'not-a-reporter', 'nothing-to-pay-out', 'unrecognised', 'note-required']) {
    assert.ok(codes.has(code), `${code} is read from the source`);
  }
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
  // Where a reporter's payout notices link: their Credits, which has no tabs.
  assert.equal(appLinkLabel('/credits'), 'See your credits');
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
