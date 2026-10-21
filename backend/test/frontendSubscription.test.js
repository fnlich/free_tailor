const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const ts = require('typescript');

const { loadFresh, useAdminEmails, useTempStorage } = require('./helpers');

/**
 * The Subscription page's half of self-serve subscriptions (frontend
 * lib/subscriptionBilling.ts, the client, and lib/subscriptionDisplay.ts,
 * what the page draws from its answers), run against the server's own routes
 * - the frontendSettings pattern: the frontend's modules transpiled with the
 * backend's TypeScript, their requests sent to routes/subscription.ts on a
 * port of its own, on the services' fake clock.
 *
 * What is held here:
 *  - the amount the client sends back (`chargeUsd`, written by
 *    `toDollarInput`) is the one the server works out, to the thousandth and
 *    in whole cents alike - so a purchase the page showed goes through;
 *  - every card's action and the "Current subscription" summary, drawn from
 *    REAL answers in each state: Default, paid and renewing, switching at
 *    renewal, cancelled, set by an administrator, an administrator's own;
 *  - a refusal reaches the page as the page reads it: 409 `charge-changed`
 *    with the figure in effect, 402 `insufficient-credits` with its numbers;
 *  - Admin -> Accounts' line under a paid tier, and its confirm, from the
 *    accounts list's own answer.
 */

const SRC = path.join(__dirname, '..', '..', 'frontend', 'src');
const DAY = 86_400_000;
const T0 = Date.parse('2026-10-19T12:00:00.000Z');

function loadFrontend(relative, seen = new Map()) {
  const file = path.join(SRC, relative);
  if (seen.has(file)) return seen.get(file).exports;
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  });
  const module = { exports: {} };
  seen.set(file, module);
  const resolve = (specifier) => {
    let base;
    if (specifier.startsWith('@/')) base = specifier.slice(2);
    else if (specifier.startsWith('./') || specifier.startsWith('../')) {
      base = path.relative(SRC, path.join(path.dirname(file), specifier));
    } else {
      throw new Error(`${relative} imports ${specifier} at runtime; it is meant to import only frontend modules`);
    }
    const candidate = ['.ts', '.tsx'].map((ext) => `${base}${ext}`).find((name) => fs.existsSync(path.join(SRC, name)));
    if (!candidate) throw new Error(`${relative}: cannot resolve ${specifier}`);
    return loadFrontend(candidate, seen);
  };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, resolve);
  return module.exports;
}

/** The routes the page calls, priced, on the services' clock; an administrator, a user with $50 and one with $1. */
async function serve(name) {
  const dirs = useTempStorage(`frontend-subscription-${name}`);
  useAdminEmails('admin@example.com');
  for (const variable of [
    'SUBSCRIPTION_PREMIUM_PRICE_USD',
    'SUBSCRIPTION_PREMIUM_PLUS_PRICE_USD',
    'SUBSCRIPTION_PREMIUM_MAX_PRICE_USD',
  ]) {
    delete process.env[variable];
  }
  loadFresh('../dist/database/sqlite');
  loadFresh('../dist/database/creditRepository');
  loadFresh('../dist/database/subscriptionRepository');
  const users = loadFresh('../dist/database/userRepository');
  const config = loadFresh('../dist/config/aiModelConfig');
  const credits = loadFresh('../dist/services/credits');
  const subscriptions = loadFresh('../dist/services/subscriptions');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const routes = loadFresh('../dist/routes/subscription');
  const accounts = loadFresh('../dist/routes/accounts');

  await config.updateAppSettings({ premiumPriceUsd: '9.99', premiumPlusPriceUsd: '19.99' });
  let now = T0;
  subscriptions.setSubscriptionClockForTests(() => now);

  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  const bob = users.createUser({ email: 'bob@example.com' });
  credits.grantCredits(alice.id, 50_000, admin.id, 'test');
  credits.grantCredits(bob.id, 1_000, admin.id, 'test');

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/subscription', routes.default);
  app.use('/api/admin/accounts', accounts.default);
  const server = app.listen(0);
  return {
    ...dirs,
    users,
    credits,
    config,
    ids: { admin: admin.id, alice: alice.id, bob: bob.id },
    base: `http://127.0.0.1:${server.address().port}/api`,
    tokens: {
      admin: users.createSession(admin.id),
      alice: users.createSession(alice.id),
      bob: users.createSession(bob.id),
    },
    setNow: (ms) => {
      now = ms;
    },
    close: () => {
      subscriptions.setSubscriptionClockForTests();
      server.close();
    },
  };
}

/** The frontend's client, with its requests sent to `server` as `who`. */
async function asClient(server, who, fn) {
  const seen = new Map();
  const api = loadFrontend('lib/api.ts', seen);
  const modules = {
    api,
    auth: loadFrontend('lib/auth.ts', seen),
    billing: loadFrontend('lib/subscriptionBilling.ts', seen),
    display: loadFrontend('lib/subscriptionDisplay.ts', seen),
    spend: loadFrontend('lib/spendConfirm.ts', seen),
  };
  const realFetch = globalThis.fetch;
  const saved = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  };
  const stored = new Map();
  Object.defineProperty(globalThis, 'window', { value: { location: { hostname: 'localhost' } }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, String(value)),
      removeItem: (key) => stored.delete(key),
    },
    configurable: true,
    writable: true,
  });
  globalThis.fetch = (url, init) => realFetch(String(url).replace(/^https?:\/\/[^/]+\/api/, server.base), init);
  api.setToken(server.tokens[who]);
  try {
    return await fn(modules);
  } finally {
    globalThis.fetch = realFetch;
    for (const name of ['window', 'localStorage']) {
      if (saved[name]) Object.defineProperty(globalThis, name, saved[name]);
      else delete globalThis[name];
    }
  }
}

async function refusalOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('the server accepted it');
}

const tierOf = (view, id) => view.tiers.find((tier) => tier.id === id);
const actionsOf = (display, view) =>
  Object.fromEntries(view.tiers.map((tier) => [tier.id, display.cardAction(tier, view)]));

test('the page buys and moves up for exactly the amount it shows - thousandths and whole cents alike - and says what it did', async () => {
  const server = await serve('buy');
  try {
    await asClient(server, 'alice', async ({ billing, display }) => {
      let view = await billing.subscriptionApi.get();
      let actions = actionsOf(display, view);
      assert.deepEqual(actions.default, { kind: 'state', text: 'Current subscription' });
      assert.deepEqual(actions.premium, {
        kind: 'buy',
        label: 'Subscribe',
        title: 'Subscribe to Premium',
        chargeMilli: 9_990,
        creditMilli: 0,
        daysLeft: 0,
        prorationNote: null,
      });
      assert.deepEqual(actions['premium-max'], { kind: 'state', text: 'Not offered here' });
      assert.deepEqual(
        view.tiers.map((tier) => display.priceText(tier)),
        ['Free', '$9.99', '$19.99', 'Not offered']
      );
      const free = display.statusSummary(view);
      assert.equal(free.headline, 'Default');
      assert.deepEqual(free.rows, []);
      assert.equal(free.canCancel, false);
      assert.equal(free.warning, null);

      // Whole cents: "9.99" is what the client sends, and it is charged.
      let result = await billing.subscriptionApi.subscribe('premium', actions.premium.chargeMilli);
      assert.equal(result.subscription, 'premium');
      assert.equal(result.chargedMilli, 9_990);
      assert.equal(result.balanceMilli, 40_010);
      const until = display.dayText(result.paid.paidThrough);
      assert.equal(
        display.changeMessage('subscribe', result),
        `Your account is on Premium now, until ${until}. $9.99 was taken from your credit.`
      );

      // A day on, the upgrade's price is the new one less 29 unused days: $10.333 - thousandths.
      server.setNow(T0 + DAY);
      view = await billing.subscriptionApi.get();
      actions = actionsOf(display, view);
      assert.deepEqual(actions['premium-plus'], {
        kind: 'buy',
        label: 'Upgrade · $10.333',
        title: 'Upgrade to Premium+',
        chargeMilli: 10_333,
        creditMilli: 9_657,
        daysLeft: 29,
        prorationNote: '$19.99 less $9.657 for 29 unused days of Premium',
      });
      assert.deepEqual(actions.default, { kind: 'state', text: 'You return here if you cancel' });
      // The confirm asks about that amount, taken now.
      const asked = display.buyQuestion(tierOf(view, 'premium-plus'), actions['premium-plus'], view, T0 + DAY);
      assert.deepEqual(asked.estimate, { costMilli: 10_333, balanceMilli: 40_010, exempt: false, chargedOn: null });
      assert.equal(asked.what, 'Premium+ for 30 days');
      assert.equal(
        asked.detail,
        '$19.99 less $9.657 for 29 unused days of Premium. Your 30 days start now, and Premium+ renews from your credit at the end of them, at its price then, until you cancel.'
      );
      result = await billing.subscriptionApi.subscribe('premium-plus', actions['premium-plus'].chargeMilli);
      assert.equal(result.subscription, 'premium-plus');
      assert.equal(result.chargedMilli, 10_333);
      assert.equal(result.balanceMilli, 40_010 - 10_333);

      // Renewing, with the next charge at today's price.
      const status = display.statusSummary(result);
      assert.equal(status.headline, 'Premium+');
      assert.equal(status.source, 'Paid from your credit, 30 days at a time.');
      assert.deepEqual(
        status.rows.map((row) => row.label),
        ['Started', 'Renews on', 'Next charge']
      );
      assert.equal(
        status.rows[2].value,
        `$19.99, on ${display.dayText(result.paid.paidThrough)}, and every 30 days after until you cancel`
      );
      assert.equal(status.canCancel, true);
      assert.equal(status.warning, null);
    });
  } finally {
    server.close();
  }
});

test('an upgrade the unused days cover takes nothing now - and is still asked about, since it starts 30 days that renew', async () => {
  const server = await serve('covered');
  try {
    await asClient(server, 'alice', async ({ billing, display, spend }) => {
      let view = await billing.subscriptionApi.get();
      await billing.subscriptionApi.subscribe('premium', tierOf(view, 'premium').chargeMilli);
      // A price cut after the purchase: Premium+ now costs less than the 30
      // unused days of Premium are worth.
      await server.config.updateAppSettings({ premiumPlusPriceUsd: '5' });
      view = await billing.subscriptionApi.get();
      const plus = tierOf(view, 'premium-plus');
      const action = display.cardAction(plus, view);
      assert.deepEqual(action, {
        kind: 'buy',
        label: 'Upgrade · $0',
        title: 'Upgrade to Premium+',
        chargeMilli: 0,
        creditMilli: 9_990,
        daysLeft: 30,
        prorationNote: '$5 less $9.99 for 30 unused days of Premium',
      });

      // $0 now would not be asked about; this is asked as what it is - nothing
      // now, the new price when the new 30 days end - and says what is given up.
      const asked = display.buyQuestion(plus, action, view, T0);
      assert.deepEqual(asked.estimate, {
        costMilli: 5_000,
        balanceMilli: 40_010,
        exempt: false,
        chargedOn: new Date(T0 + 30 * DAY).toISOString(),
      });
      assert.equal(spend.confirmNeeded('subscription', asked.estimate), true);
      assert.equal(spend.spendFigures(asked.estimate).state, 'later');
      assert.equal(spend.spendFigures(asked.estimate).blocks, false);
      assert.equal(asked.what, 'Premium+');
      assert.equal(
        asked.detail,
        '$5 less $9.99 for 30 unused days of Premium: your unused days cover it, so nothing is taken now, and the $4.99 of their credit that Premium+ does not use is not refunded. Your 30 days of Premium+ start now.'
      );

      // Proceeded: nothing is taken, and it renews on the day the confirm named.
      const result = await billing.subscriptionApi.subscribe('premium-plus', action.chargeMilli);
      assert.equal(result.subscription, 'premium-plus');
      assert.equal(result.balanceMilli, 40_010);
      assert.equal(result.paid.paidThrough, asked.estimate.chargedOn);
      assert.equal(
        display.changeMessage('subscribe', result),
        `Your account is on Premium+ now, until ${display.dayText(result.paid.paidThrough)}. Nothing was taken from your credit: the unused days covered it.`
      );
    });
  } finally {
    server.close();
  }
});

test('switch at renewal, cancel and keep: each card and the summary say what the server holds', async () => {
  const server = await serve('switch');
  try {
    await asClient(server, 'alice', async ({ billing, display }) => {
      let view = await billing.subscriptionApi.get();
      await billing.subscriptionApi.subscribe('premium-plus', tierOf(view, 'premium-plus').chargeMilli);
      view = await billing.subscriptionApi.get();
      const on = display.dayText(view.paid.paidThrough);

      // Premium is between the base (Default) and Premium+: switched to at renewal.
      let actions = actionsOf(display, view);
      assert.equal(actions.premium.kind, 'switch');
      assert.equal(actions.premium.title, 'Switch to Premium at renewal');
      assert.equal(actions.premium.on, view.paid.paidThrough);
      assert.equal(actions.premium.priceMilli, 9_990);

      let result = await billing.subscriptionApi.downgrade('premium');
      assert.equal(result.changed, true);
      assert.equal(display.changeMessage('downgrade', result), `You keep Premium+ until ${on}; then your subscription switches to Premium.`);
      actions = actionsOf(display, result);
      assert.deepEqual(actions.premium, { kind: 'state', text: `Switches here on ${on}` });
      assert.deepEqual(actions['premium-plus'], {
        kind: 'keep',
        label: 'Keep Premium+',
        title: 'Keep Premium+',
        on: result.paid.paidThrough,
        priceMilli: 19_990,
      });
      let status = display.statusSummary(result);
      assert.deepEqual(status.rows.slice(1), [
        { label: 'Switches on', value: `${on}, to Premium` },
        { label: 'Next charge', value: `$9.99 for Premium, on ${on}` },
      ]);
      // A repeat moved nothing, and says so.
      assert.equal(display.changeMessage('downgrade', await billing.subscriptionApi.downgrade('premium')), 'Nothing changed: your subscription was already like that.');

      result = await billing.subscriptionApi.cancel();
      assert.equal(display.changeMessage('cancel', result), `Premium+ is cancelled: it stays until ${on}, then your account returns to Default. Nothing more is taken.`);
      assert.equal(display.cancelQuestion(result), `Premium+ stays until ${on}, then your account returns to Default. Nothing is refunded.`);
      status = display.statusSummary(result);
      assert.deepEqual(status.rows.slice(1), [
        { label: 'Ends on', value: `${on}, then your account returns to Default` },
        { label: 'Next charge', value: 'None: cancelled, so nothing more is taken' },
      ]);
      assert.equal(status.canCancel, false);
      actions = actionsOf(display, result);
      assert.deepEqual(actions.default, { kind: 'state', text: `Your account returns here on ${on}` });
      assert.equal(actions['premium-plus'].kind, 'keep');
      // Switch at renewal on a cancelled tier keeps it renewing, as the lower one.
      assert.equal(actions.premium.kind, 'switch');

      result = await billing.subscriptionApi.resume();
      assert.equal(display.changeMessage('resume', result), `Premium+ renews again on ${on}.`);
      assert.equal(display.statusSummary(result).canCancel, true);
      assert.deepEqual(actionsOf(display, result)['premium-plus'], { kind: 'state', text: 'Current subscription' });
    });
  } finally {
    server.close();
  }
});

test("a refusal reaches the page as the page reads it: the new figure on charge-changed, the numbers on a short balance", async () => {
  const server = await serve('refusals');
  try {
    await asClient(server, 'alice', async ({ api, billing }) => {
      // Shown $9.99, sent $9.98: refused with the figure in effect, nothing taken.
      const changed = await refusalOf(billing.subscriptionApi.subscribe('premium', 9_980));
      assert.ok(changed instanceof api.ApiResponseError);
      assert.equal(changed.status, 409);
      assert.equal(changed.code, 'charge-changed');
      assert.equal(changed.number('chargeMilli'), 9_990);
      assert.equal((await billing.subscriptionApi.get()).balanceMilli, 50_000);
    });
    await asClient(server, 'bob', async ({ api, billing, display }) => {
      const view = await billing.subscriptionApi.get();
      const short = await refusalOf(billing.subscriptionApi.subscribe('premium', tierOf(view, 'premium').chargeMilli));
      assert.equal(api.isInsufficientCredits(short), true);
      assert.equal(short.status, 402);
      assert.equal(short.number('neededMilli'), 9_990);
      assert.equal(short.number('balanceMilli'), 1_000);
      assert.equal(api.isSubscriptionTooLow(short), false);
      // Nothing moved.
      assert.equal(display.statusSummary(await billing.subscriptionApi.get()).headline, 'Default');
    });
  } finally {
    server.close();
  }
});

test("a renewal the balance cannot cover is warned about before its day", async () => {
  const server = await serve('short');
  try {
    // $10 buys Premium and leaves $0.01: short of the renewal by $9.98.
    server.credits.grantCredits(server.ids.bob, 9_000, server.ids.admin, 'test');
    await asClient(server, 'bob', async ({ billing, display }) => {
      const view = await billing.subscriptionApi.get();
      const result = await billing.subscriptionApi.subscribe('premium', tierOf(view, 'premium').chargeMilli);
      const { warning } = display.statusSummary(result);
      assert.equal(warning.shortMilli, 9_980);
      assert.equal(
        warning.sentence,
        `Your balance ($0.01) is less than the renewal ($9.99). Buy credits before ${display.dayText(result.paid.paidThrough)}, or the subscription ends then.`
      );
      // Cancelled, nothing will be taken: no warning.
      assert.equal(display.statusSummary(await billing.subscriptionApi.cancel()).warning, null);
    });
  } finally {
    server.close();
  }
});

test("set by an administrator, an administrator's own, and Admin -> Accounts' line and confirm for a paid tier", async () => {
  const server = await serve('admin');
  try {
    server.users.updateUser(server.ids.bob, { subscription: 'premium' });
    await asClient(server, 'bob', async ({ billing, display }) => {
      const view = await billing.subscriptionApi.get();
      assert.equal(view.source, 'admin');
      const status = display.statusSummary(view);
      assert.equal(status.headline, 'Premium');
      assert.equal(status.source, 'Set by an administrator. It does not renew and nothing is taken from your credit.');
      assert.equal(status.canCancel, false);
      const actions = actionsOf(display, view);
      assert.deepEqual(actions.premium, { kind: 'state', text: 'Current subscription' });
      assert.deepEqual(actions.default, { kind: 'state', text: 'Included in yours' });
      // Above it, the full price: nothing was paid for the administrator's.
      assert.equal(actions['premium-plus'].label, 'Subscribe');
      assert.equal(actions['premium-plus'].chargeMilli, 19_990);
    });

    await asClient(server, 'admin', async ({ billing, display }) => {
      const view = await billing.subscriptionApi.get();
      assert.equal(view.source, 'exempt');
      assert.match(display.statusSummary(view).source, /never charged, so there is nothing to buy here/);
      for (const tier of view.tiers) {
        const action = display.cardAction(tier, view);
        assert.equal(action.kind, 'state', tier.id);
        assert.equal(action.text, tier.offer === 'current' ? 'Current subscription' : 'Included for administrators');
      }
    });

    await asClient(server, 'alice', async ({ billing }) => {
      const view = await billing.subscriptionApi.get();
      await billing.subscriptionApi.subscribe('premium', tierOf(view, 'premium').chargeMilli);
    });
    await asClient(server, 'admin', async ({ auth, display }) => {
      const { accounts } = await auth.accountsApi.list();
      const alice = accounts.find((row) => row.email === 'alice@example.com');
      const on = display.dayText(alice.subscriptionBilling.paidThrough);
      assert.deepEqual(Object.keys(alice.subscriptionBilling).sort(), ['next', 'paidThrough', 'renews']);
      assert.equal(display.billingLine(alice.subscriptionBilling), `Paid · renews ${on}`);
      assert.equal(display.billingLine({ ...alice.subscriptionBilling, renews: false }), `Paid · ends ${on}`);
      assert.equal(display.billingLine({ ...alice.subscriptionBilling, next: 'premium' }), `Paid · switches to Premium ${on}`);
      assert.equal(
        display.overrideQuestion(alice, alice.subscriptionBilling, 'subscription'),
        `alice@example.com pays for Premium from credit until ${on}. Setting the subscription here ends that at once and refunds nothing.`
      );
      assert.equal(accounts.find((row) => row.email === 'bob@example.com').subscriptionBilling, null);

      // Confirmed, the change ends it: the server's note says so, and the line goes.
      const change = await auth.accountsApi.update(alice.id, { subscription: 'premium-plus' });
      assert.match(change.note, /nothing was refunded/);
      assert.equal(change.account.subscriptionBilling, null);
    });
  } finally {
    server.close();
  }
});

test('the page and its parts: cards in a grid, the not-offered card asks for the administrator, no "plan" anywhere', () => {
  const read = (relative) => fs.readFileSync(path.join(SRC, relative), 'utf8').replace(/\r\n/g, '\n');
  const cards = read('components/subscription/SubscriptionCards.tsx');
  assert.match(cards, /Not offered on this installation\. Ask your administrator if you need it\. <ContactAdminLink \/>/);
  // Four across, two or one - never three and one, which an auto-fit grid
  // drew on most laptop windows: the counts follow the width the cards have.
  assert.match(cards, /<div className=\{css\.cardsBox\}>\s*<ul className=\{css\.cards\}/);
  const css = read('components/subscription/subscription.module.css');
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(rules, /\.cardsBox \{\s*container-type: inline-size;\s*\}/);
  assert.match(rules, /\.cards \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\);/);
  const columns = [...rules.matchAll(/@container \(min-width: ([\d.]+)rem\) \{\s*\.cards \{\s*grid-template-columns: repeat\((\d), minmax\(0, 1fr\)\);/g)].map(
    (match) => [Number(match[1]), Number(match[2])]
  );
  // Each step is exactly that many cards of 13.5rem and the 1rem gaps between them.
  assert.deepEqual(columns, [
    [28, 2],
    [57, 4],
  ]);
  for (const [width, count] of columns) assert.equal(width, count * 13.5 + (count - 1));
  assert.doesNotMatch(rules, /auto-fit|auto-fill/);
  // Tokens only: no colour literal, so both themes follow.
  assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b|rgba?\(/i);
  const page = read('app/settings/subscription/page.tsx');
  assert.match(page, /title="Current subscription"/);
  assert.match(page, /title="Choose a subscription"/);
  // What a change did is said where it was asked from - Cancel and Keep under
  // the cards, not four cards above them on a phone - and brought into view.
  assert.match(page, /\{resultFrom === 'cards' && result\}/);
  assert.match(page, /\{resultFrom === 'status' && result\}/);
  assert.match(page, /void send\('cancel', 'status', /);
  assert.match(page, /onKeep=\{\(action\) => keepCurrent\(action, 'status'\)\}/);
  assert.match(page, /block\.scrollIntoView\(\{ behavior: 'smooth', block: 'nearest' \}\);\s*block\.focus\(\{ preventScroll: true \}\);/);
  // An administrator is never charged: the Credits section does not say otherwise.
  assert.match(
    page,
    /exempt\s*\? 'Administrators are never charged, for a subscription or for a resume, so nothing is taken from this balance\.'\s*: 'Your subscription is paid from this balance/
  );
  // The cards are ABOVE the status block that points to them.
  const status = read('components/subscription/SubscriptionStatus.tsx');
  assert.match(status, /A higher subscription bought on this page is paid from your credit/);
  assert.doesNotMatch(status, /bought below/);
  for (const file of [
    'app/settings/subscription/page.tsx',
    'components/subscription/SubscriptionCards.tsx',
    'components/subscription/SubscriptionStatus.tsx',
    'components/subscription/LockedFeature.tsx',
    'lib/subscriptionDisplay.ts',
    'lib/subscriptionBilling.ts',
  ]) {
    assert.doesNotMatch(read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), /\bplans?\b/i, file);
  }
});
