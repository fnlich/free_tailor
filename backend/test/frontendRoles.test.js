const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ts = require('typescript');

const { loadFresh, useTempStorage, useAdminEmails } = require('./helpers');

/**
 * The reporter's side of the frontend (owner decisions A3, A4, J7), tested
 * from here because the frontend has no test runner - the frontendHelpers
 * pattern, made to follow `@/` and `./` imports between frontend modules so
 * navModel (which imports the role and tier lists) and lib/reporterPay.ts
 * (which imports lib/format.ts) load as they are. Anything else imported at
 * runtime - React, Next - is refused: these modules must stay leaves.
 *
 * What is held here:
 *   - the frontend's copy of the role catalog is the backend's;
 *   - AuthGate's reporter allowlist is an allowlist: of every page the App
 *     Router has, a reporter opens exactly Report Jobs, Credits and Settings ->
 *     Profile / Job Sheet, and is sent to Report Jobs from every other one;
 *   - the rail and the Settings tabs offer a reporter exactly those, and
 *     nothing the allowlist would bounce them from;
 *   - the rate box and the Record payout form say what the server would, in
 *     its words, before anything is sent.
 */

const SRC = path.join(__dirname, '..', '..', 'frontend', 'src');

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
      throw new Error(`${relative} imports ${specifier} at runtime; it is meant to import only frontend leaves`);
    }
    const candidate = ['.ts', '.tsx'].map((ext) => `${base}${ext}`).find((name) => fs.existsSync(path.join(SRC, name)));
    if (!candidate) throw new Error(`${relative}: cannot resolve ${specifier}`);
    return loadFrontend(candidate, seen);
  };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, resolve);
  return module.exports;
}

/** Every App Router page, as the path it answers (a dynamic segment filled in). */
function appRoutes() {
  const routes = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'page.tsx' || entry.name === 'page.jsx') {
        const segments = path
          .relative(path.join(SRC, 'app'), dir)
          .split(path.sep)
          .filter(Boolean)
          // A route group is not part of the address; a dynamic segment is any value.
          .filter((segment) => !/^\(.*\)$/.test(segment))
          .map((segment) => (/^\[.*\]$/.test(segment) ? 'x123' : segment));
        routes.push(`/${segments.join('/')}`);
      }
    }
  };
  walk(path.join(SRC, 'app'));
  return routes.sort();
}

/** A reporter's pages (owner decision A3), as the README's Roles section lists them. */
const REPORTER_PAGES = ['/credits', '/report', '/settings', '/settings/job-sheet'];

test("the frontend's role catalog is the backend's", () => {
  const frontend = loadFrontend('lib/roles.ts');
  const backend = require('../dist/config/accountRoles');

  assert.deepEqual([...frontend.ACCOUNT_ROLES], [...backend.ACCOUNT_ROLES]);
  assert.deepEqual({ ...frontend.ROLE_LABELS }, { ...backend.ROLE_LABELS });
  assert.deepEqual(
    frontend.ACCOUNT_ROLES.map((id) => ({ id, label: frontend.roleLabel(id) })),
    backend.listRoles()
  );
  for (const value of [...backend.ACCOUNT_ROLES, 'owner', 'Admin', '', null, undefined, 1]) {
    assert.equal(frontend.isAccountRole(value), backend.isAccountRole(value), String(value));
    assert.equal(frontend.canBuildResumes(value), backend.canBuildResumes(value), String(value));
  }
  // An unknown role reads as what it says, never as a role it is not.
  assert.equal(frontend.roleLabel('owner'), 'owner');
  assert.deepEqual([...frontend.BUILDER_ROLES], backend.ACCOUNT_ROLES.filter((role) => backend.canBuildResumes(role)));
});

test('a reporter opens exactly their own pages, and is sent to Report Jobs from every other one', () => {
  const roles = loadFrontend('lib/roles.ts');
  const routes = appRoutes();

  // The walk is reading the app: the pages this phase is about are all there.
  for (const page of [...REPORTER_PAGES, '/', '/admin/profiles', '/admin/accounts', '/credits/invoice', '/orders/x123']) {
    assert.ok(routes.includes(page), `${page} is a page (found ${routes.length})`);
  }

  // Every page, both ways: the allowlist is exactly the reporter's pages, so
  // a page added later stays closed to them until somebody opens it.
  assert.deepEqual(routes.filter((route) => roles.reporterMayOpen(route)), REPORTER_PAGES);
  for (const route of routes) {
    const allowed = REPORTER_PAGES.includes(route);
    assert.equal(roles.redirectFor('reporter', route), allowed ? null : roles.REPORTER_HOME, route);
    // Nobody else is ever sent anywhere: their pages explain themselves.
    for (const role of ['user', 'admin']) assert.equal(roles.redirectFor(role, route), null, `${role} ${route}`);
  }

  // /admin/* is NOT a reporter's, though it holds everybody's profiles - and a
  // purchase's pages under /credits are not theirs either.
  for (const refused of ['/admin', '/admin/profiles', '/admin/profiles/new', '/credits/invoice', '/credits/return',
    '/settings/subscription', '/settings/payment-methods', '/reports', '/creditsx', '/account']) {
    assert.equal(roles.reporterMayOpen(refused), false, refused);
  }
  // The same page however it is spelled, and Report Jobs' later pages with it.
  for (const allowed of ['/credits/', '/credits?tab=history', '/settings#top', '/report/', '/report/runs/42']) {
    assert.equal(roles.reporterMayOpen(allowed), true, allowed);
  }

  assert.equal(roles.REPORTER_HOME, '/report');
  assert.equal(roles.homeFor('reporter'), '/report');
  assert.equal(roles.homeFor('user'), '/');
  assert.equal(roles.homeFor('admin'), '/');
  assert.equal(roles.reporterMayOpen(roles.homeFor('reporter')), true, 'home is a page they may open');

  // Report Jobs is a reporter's, and an administrator may open it.
  assert.deepEqual(['user', 'reporter', 'admin', 'owner', null].map(roles.canOpenReportJobs), [false, true, true, false, false]);
});

test("the rail and the Settings tabs offer a reporter exactly their pages, and every builder what it had", () => {
  const nav = loadFrontend('components/shell/navModel.ts');
  const roles = loadFrontend('lib/roles.ts');
  const rail = [...nav.SIDEBAR_MAIN, ...nav.SIDEBAR_ASSISTANT, ...nav.SIDEBAR_BOTTOM];
  const offered = (role, subscription = 'default') =>
    rail.filter((item) => nav.canSee(item, role, subscription)).map((item) => item.label);

  assert.deepEqual(offered('reporter'), ['Report Jobs', 'Credits', 'Settings']);
  const builders = [
    'Profiles', 'Find Jobs', 'Build Resumes', 'Orders', 'Credits',
    'Job Filter', 'Bid Assistant', 'Calendar', 'Templates', 'Settings',
  ];
  assert.deepEqual(offered('user'), builders);
  assert.deepEqual(offered('admin'), builders);
  // A role this page does not know is offered nothing a builder is.
  assert.deepEqual(offered('owner'), []);
  assert.deepEqual(offered(undefined), []);

  // Nothing offered to a reporter is a page AuthGate would bounce them from.
  for (const item of rail.filter((entry) => nav.canSee(entry, 'reporter', 'default'))) {
    assert.equal(item.external, undefined, `${item.label} leaves the app`);
    assert.equal(roles.reporterMayOpen(item.href), true, item.label);
  }

  assert.deepEqual(nav.settingsTabsFor('reporter').map((tab) => tab.label), ['Profile', 'Job Sheet']);
  for (const tab of nav.settingsTabsFor('reporter')) assert.equal(roles.reporterMayOpen(tab.href), true, tab.href);
  const all = ['Profile', 'Job Sheet', 'Payment Methods', 'Subscription'];
  assert.deepEqual(nav.settingsTabsFor('user').map((tab) => tab.label), all);
  assert.deepEqual(nav.settingsTabsFor('admin').map((tab) => tab.label), all);
  assert.deepEqual(nav.settingsTabsFor('owner'), []);
  // The installation's own tabs are not a reporter's either.
  for (const tab of nav.SETTINGS_ADMIN_TABS) assert.equal(roles.reporterMayOpen(tab.href), false, tab.href);

  // The safe default: an entry that names no roles is the builders', so one
  // added later is kept from reporters until somebody names them on it.
  assert.equal(nav.canSee({}, 'reporter', 'premium-max'), false);
  assert.equal(nav.canSee({}, 'user', 'default'), true);
  // A tier on top of the role, which an administrator is exempt from (B1).
  const premium = { needs: 'premium' };
  assert.equal(nav.canSee(premium, 'user', 'default'), false);
  assert.equal(nav.canSee(premium, 'user', 'premium'), true);
  assert.equal(nav.canSee(premium, 'admin', 'default'), true);
  assert.equal(nav.canSee({ roles: ['reporter'], needs: 'premium' }, 'reporter', 'default'), false);
});

test("a reporter's sheet link is the shell's, else the session's, and only ever an https address", () => {
  const { sheetLinkFor } = loadFrontend('lib/roles.ts');
  const today = 'https://docs.google.com/spreadsheets/d/abc/edit#gid=7';
  const stored = 'https://docs.google.com/spreadsheets/d/abc/edit';
  assert.equal(sheetLinkFor(today, stored), today);
  assert.equal(sheetLinkFor('', stored), stored);
  assert.equal(sheetLinkFor(undefined, undefined), '');
  for (const bad of ['javascript:alert(1)', 'http://docs.google.com/x', 'data:text/html,x', '//evil.example/x', 'https://']) {
    assert.equal(sheetLinkFor(bad, undefined), '', bad);
    assert.equal(sheetLinkFor(bad, stored), stored, `${bad} falls back to the stored address`);
  }
});

test("the rate per job box reads dollars exactly as the server's parseReportRateUsd does", () => {
  const frontend = loadFrontend('lib/reporterPay.ts');
  const backend = require('../dist/config/reportRate');
  assert.equal(frontend.MAX_REPORT_RATE_MILLI, backend.MAX_REPORT_RATE_MILLI);

  const inputs = [
    '', '   ', null, '0', '0.075', '.5', '$1.25', ' 2 ', '1000', '1000.000', '1000.001', '0.0005', '-1', '-0',
    '1,000', '1e3', 'abc', '12.', '0.1', 75, 0.075, 1000.001, 1e-7,
  ];
  for (const input of inputs) {
    assert.deepEqual(frontend.parseReportRate(input), backend.parseReportRateUsd(input), JSON.stringify(input));
  }
  // Empty is the global rate - the box's way of saying "none of their own".
  assert.deepEqual(frontend.parseReportRate(''), { ok: true, milli: null });
  assert.deepEqual(frontend.parseReportRate('0.075'), { ok: true, milli: 75 });
  assert.equal(frontend.describeReportRate(null), 'The global rate per job');
  assert.equal(frontend.describeReportRate(75), '$0.075 per job');
});

test('Record payout says what the server would, in its words, before anything is sent', async () => {
  useTempStorage(`frontend-roles-${Math.random().toString(36).slice(2)}`);
  useAdminEmails('admin@example.com');
  const express = require('express');
  const users = loadFresh('../dist/database/userRepository');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const routes = loadFresh('../dist/routes/accounts');
  const pay = loadFrontend('lib/reporterPay.ts');

  const admin = users.createUser({ email: 'admin@example.com', name: 'Admin' });
  const reporter = users.createUser({ email: 'rita@example.com', name: 'Rita' });
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/admin/accounts', routes.default);
  const server = app.listen(0);
  const token = users.createSession(admin.id);
  const call = (route, body, method = 'POST') =>
    fetch(`http://127.0.0.1:${server.address().port}/api/admin/accounts${route}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  try {
    await call(`/${reporter.id}`, { role: 'reporter' }, 'PATCH');
    await call(`/${reporter.id}/credits`, { amountUsd: '5' });
    const balance = 5_000;

    // Every refusal the form can foresee, against the real route: the
    // sentence the page shows is the one the server would have answered.
    const cases = [
      ['', 'Bank transfer'],
      ['0', 'Bank transfer'],
      ['0.000', 'Bank transfer'],
      ['-1', 'Bank transfer'],
      ['0.0005', 'Bank transfer'],
      ['1,5', 'Bank transfer'],
      ['abc', 'Bank transfer'],
      ['1', ''],
      ['1', '   '],
      ['1', 'x'.repeat(501)],
      ['5.001', 'Bank transfer'],
      ['50', 'Bank transfer'],
    ];
    for (const [amountUsd, note] of cases) {
      const said = pay.payoutProblem(amountUsd, note, balance);
      assert.notEqual(said, '', `the page refuses ${JSON.stringify([amountUsd, note])}`);
      const refused = await call(`/${reporter.id}/payout`, { amountUsd, note });
      assert.ok(refused.status === 400 || refused.status === 409, `${amountUsd}: ${refused.status}`);
      assert.equal(said, (await refused.json()).error, JSON.stringify([amountUsd, note]));
      // And the live line under the amount says the amount's own problem the same way.
      const line = pay.describePayoutAmount(amountUsd, balance);
      if (note === 'Bank transfer' && amountUsd !== '') {
        assert.equal(line.tone, 'error');
        assert.equal(line.text, said, amountUsd);
      }
    }
    assert.equal(users.getUserById(reporter.id).balanceMilli, balance, 'no refusal moved anything');

    // What the page lets through, the server records - with the page's id.
    const requestId = pay.mintPayoutRequestId();
    assert.match(requestId, /^[A-Za-z0-9_-]{8,100}$/);
    assert.equal(pay.payoutProblem('2.5', 'Bank transfer, ref 4471', balance), '');
    assert.equal(pay.payoutLeaves('2.5', balance), 2_500);
    assert.deepEqual(pay.describePayoutAmount('2.5', balance), {
      tone: 'ok',
      text: 'Leaves $2.500 of their $5.000 balance.',
    });
    const paid = await call(`/${reporter.id}/payout`, { amountUsd: '2.5', note: 'Bank transfer, ref 4471', requestId });
    assert.equal(paid.status, 201);
    const first = await paid.json();
    assert.equal(first.balanceMilli, 2_500);
    // The form keeps its id across a retry, so a second press records nothing more.
    const again = await call(`/${reporter.id}/payout`, { amountUsd: '2.5', note: 'Bank transfer, ref 4471', requestId });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).recorded, false);
    assert.equal(users.getUserById(reporter.id).balanceMilli, 2_500);

    // Exactly the balance is a payout; a thousandth more is the server's refusal.
    assert.equal(pay.payoutProblem('2.5', 'Second', 2_500), '');
    assert.equal(pay.payoutLeaves('2.5', 2_500), 0);
    assert.equal(pay.payoutLeaves('2.501', 2_500), null);
    assert.deepEqual(pay.describePayoutAmount('', 2_500), { tone: 'idle', text: 'Their balance is $2.500.' });
  } finally {
    server.close();
  }
});

test('the payout id fits the server without a secure origin too', () => {
  const pay = loadFrontend('lib/reporterPay.ts');
  // Node's own, with randomUUID: what a secure origin has.
  assert.match(pay.mintPayoutRequestId(), /^[0-9a-f-]{36}$/);
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    // A plain-http LAN address has no crypto.randomUUID.
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true, writable: true });
    const fallback = pay.mintPayoutRequestId();
    assert.match(fallback, /^payout-[A-Za-z0-9_-]{6,93}$/);
    assert.notEqual(pay.mintPayoutRequestId(), fallback, 'each form gets its own');
  } finally {
    Object.defineProperty(globalThis, 'crypto', saved);
  }
});

/** Strips comments, so prose about a rule is not mistaken for the code. */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/** The source of one top-level function in a page, up to the next one. */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is defined`);
  const next = source.slice(start + 1).search(/\n(?:export default )?function \w+\(/);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

test("a reporter's pages mount nothing that asks a route a reporter is refused", () => {
  /*
   * Hiding is not the protection - the server refuses a reporter every
   * builder route with 403 `role-not-allowed` - but a page of theirs that
   * asked one anyway would be a page of refusals, and with the role-refused
   * re-read in lib/api.ts, a page that asks again every ten seconds.
   */
  const credits = codeOnly(fs.readFileSync(path.join(SRC, 'app/credits/page.tsx'), 'utf8'));
  const earnings = functionBody(credits, 'EarningsCredits');
  for (const builderOnly of ['paymentsApi', 'OrderHistory', 'RefundRequestHistory', 'BuyCreditsDialog', 'refundsApi']) {
    assert.doesNotMatch(earnings, new RegExp(`\\b${builderOnly}\\b`), `a reporter's Credits mounts ${builderOnly}`);
  }
  assert.match(earnings, /<CreditHistory[^>]*variant="earnings"/);
  // The switch is the role, read once AuthGate has the account.
  assert.match(functionBody(credits, 'CreditsBody'), /isReporter \? <EarningsCredits \/> : <PurchaserCredits \/>/);

  // The earnings history asks for no refund: no Action column, no dialog.
  const history = codeOnly(fs.readFileSync(path.join(SRC, 'components/credits/CreditHistory.tsx'), 'utf8'));
  assert.match(history, /const asks = variant === 'credits';/);
  assert.match(history, /asks \? refundChargeIdFor\(entry\) : null/);

  // Report Jobs reads only /api/report - the reporter's own sheet, tabs, rows
  // and runs, behind requireReporter - never /api/import, which is a builder's.
  const report = codeOnly(fs.readFileSync(path.join(SRC, 'app/report/page.tsx'), 'utf8'));
  assert.match(report, /reportApi\.overview\(\)/);
  for (const builderOnly of ['importApi', "'/import", 'generationApi', 'profilesApi', 'adminJobLakeApi', 'accountsApi']) {
    assert.equal(report.includes(builderOnly), false, `Report Jobs uses ${builderOnly}`);
  }
  assert.match(report, /<ReporterOnly>/);
  const lakeApi = codeOnly(fs.readFileSync(path.join(SRC, 'lib/jobLake.ts'), 'utf8'));
  const reportApi = lakeApi.slice(lakeApi.indexOf('export const reportApi'), lakeApi.indexOf('export type LakeRequester'));
  const paths = [...reportApi.matchAll(/[`'](\/[^`'?$]*)/g)].map((match) => match[1]);
  assert.ok(paths.length >= 5, `reportApi's paths are found: ${paths.join(', ')}`);
  for (const route of paths) assert.match(route, /^\/report(\/|$)/, `reportApi asks ${route}`);
});

/**
 * Every place the frontend calls `fetch` itself, and why each is allowed to.
 * A new one that reaches this backend must hand a refusal to lib/api.ts's
 * `noticeRefusal` - or a reporter it refuses, or a session it finds gone, is
 * left on a page of errors - and is added here once it does.
 */
const RAW_FETCHES = {
  // The three request paths - JSON, stream, file - each followed by noticeRefusal.
  'lib/api.ts': 3,
  // bidAssistantFetch; its refusals go through responseError -> noticeRefusal.
  'bid-assistant/lib/apiBase.js': 1,
  // The pagehide keepalive release of an immediate run: the page is going
  // away, nothing reads the answer, and the lease's grace timer is the backstop.
  'lib/generationQueue.ts': 1,
  // The Next app's OWN route handlers (app/api/calendars), not this backend:
  // they answer no role, and no session of ours.
  'components/CalendarWorkspace.tsx': 4,
  'lib/calendar/service.ts': 1,
};

test('every fetcher of the API hands a 401 or a 403 role-not-allowed to the one handler', () => {
  const found = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
        const count = (codeOnly(fs.readFileSync(full, 'utf8')).match(/(?<![\w$])fetch\(/g) ?? []).length;
        if (count > 0) found[path.relative(SRC, full).split(path.sep).join('/')] = count;
      }
    }
  };
  walk(SRC);
  assert.deepEqual(found, RAW_FETCHES);

  // The calendar's are its own routes, by a path relative to the page.
  const calendar = codeOnly(fs.readFileSync(path.join(SRC, 'components/CalendarWorkspace.tsx'), 'utf8'));
  for (const call of calendar.match(/(?<![\w$])fetch\(\s*`[^`]*/g) ?? []) {
    assert.match(call, /^fetch\(\s*`\/api\/calendars\//, call);
  }
});

test("the Bid Assistant's client re-reads a refused role and signs a lost session out, like every other request", async () => {
  const seen = new Map();
  const api = loadFrontend('lib/api.ts', seen);
  // The same lib/api.ts instance, so the handlers installed below are the ones it calls.
  const bid = loadFrontend('bid-assistant/lib/apiBase.js', seen);

  const calls = { roleRefused: 0, signedOut: 0 };
  api.setRoleRefusedHandler(() => {
    calls.roleRefused += 1;
  });
  api.setUnauthorizedHandler(() => {
    calls.signedOut += 1;
  });
  const stored = new Map([['adminToken', 'session-token']]);
  const saved = {
    fetch: globalThis.fetch,
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  };
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
  let answer;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), authorization: init?.headers?.Authorization });
    return answer();
  };
  const json = (status, body) => () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  try {
    // A user made a reporter: the server refuses the Bid Assistant by role.
    answer = json(403, {
      error: 'That part of the app is not available for your account. Ask your administrator if you need it.',
      code: 'role-not-allowed',
    });
    const refused = await bid.readError(await bid.bidAssistantFetch('/api/jobs'), 'Request failed.');
    assert.match(sent[0].url, /\/bid-assistant\/jobs$/);
    assert.equal(sent[0].authorization, 'Bearer session-token');
    assert.equal(api.isRoleNotAllowed(refused), true, 'the same error type, body and all');
    assert.deepEqual(calls, { roleRefused: 1, signedOut: 0 });
    assert.equal(stored.get('adminToken'), 'session-token', 'a role refusal is not a sign-out');

    // The form most of the page uses: the body already parsed.
    const response = await bid.bidAssistantFetch('/api/answers/7');
    bid.responseError(response, await response.json(), 'Failed to load answers.');
    assert.deepEqual(calls, { roleRefused: 2, signedOut: 0 });

    // Any other refusal is the page's own business.
    for (const [status, body] of [[403, { error: 'Only an administrator can do that.' }], [403, { code: 'subscription-too-low' }], [500, {}], [404, null]]) {
      answer = json(status, body);
      await bid.readError(await bid.bidAssistantFetch('/api/jobs'), 'Request failed.');
    }
    assert.deepEqual(calls, { roleRefused: 2, signedOut: 0 });

    // A session gone - expired, revoked, the account disabled - signs the page out.
    answer = json(401, { error: 'Sign in to do that.' });
    const gone = await bid.readError(await bid.bidAssistantFetch('/api/jobs'), 'Request failed.');
    assert.equal(gone.status, 401);
    assert.deepEqual(calls, { roleRefused: 2, signedOut: 1 });
    assert.equal(stored.has('adminToken'), false, 'the stale token is not sent again');
  } finally {
    globalThis.fetch = saved.fetch;
    for (const name of ['window', 'localStorage']) {
      if (saved[name]) Object.defineProperty(globalThis, name, saved[name]);
      else delete globalThis[name];
    }
    api.setRoleRefusedHandler(null);
    api.setUnauthorizedHandler(null);
  }
});

test("Admin -> Accounts names the setting that makes a row an administrator again, as the server's note does", () => {
  const { configuredAdminNotes } = loadFrontend('lib/roles.ts');
  assert.deepEqual(configuredAdminNotes('SMTP_USER'), {
    line: 'SMTP_USER: an administrator again at sign-in',
    title:
      'Named by SMTP_USER: the server makes this account an administrator again at its next sign-in ' +
      'and at every restart, whatever role is set here.',
  });
  assert.equal(configuredAdminNotes('ADMIN_EMAILS').line, 'ADMIN_EMAILS: an administrator again at sign-in');
  // A backend from before `configuredAdminSource` sent only the flag, which meant ADMIN_EMAILS.
  for (const older of [undefined, null, '', 'none', 'smtp_user']) {
    assert.equal(configuredAdminNotes(older).line, 'ADMIN_EMAILS: an administrator again at sign-in', String(older));
  }
  // The page draws the row from the server's field, never a fixed setting name.
  const page = codeOnly(fs.readFileSync(path.join(SRC, 'app/admin/accounts/page.tsx'), 'utf8'));
  assert.match(page, /configuredAdminNotes\(row\.configuredAdminSource\)/);
  assert.equal(page.includes('ADMIN_EMAILS'), false, 'no setting name is written into the page itself');
});

test('a 403 role-not-allowed re-reads the account, and is not a sign-out', () => {
  const api = codeOnly(fs.readFileSync(path.join(SRC, 'lib/api.ts'), 'utf8'));
  // Every request path - JSON, stream, file - goes through the one handler.
  assert.equal((api.match(/noticeRefusal\(response\.status, body\)/g) ?? []).length, 3);
  assert.equal((api.match(/status === 401/g) ?? []).length, 1, 'the 401 rule is written once, in noticeRefusal');
  const handler = api.slice(api.indexOf('export function noticeRefusal('), api.indexOf('function getAuthHeaders('));
  assert.ok(handler.length > 0, 'noticeRefusal is exported, for the clients that do not come through lib/api.ts');
  // And so does the Bid Assistant's own client: every refusal on that page is
  // built by `responseError` (`readError` included), which hands it over
  // first. Without it, a user made a reporter there stayed on a page of 403s
  // under the builder's rail.
  const bidClient = codeOnly(fs.readFileSync(path.join(SRC, 'bid-assistant/lib/apiBase.js'), 'utf8'));
  assert.match(bidClient, /import \{[^}]*\bnoticeRefusal\b[^}]*\} from '@\/lib\/api'/);
  assert.match(functionBody(bidClient, 'responseError'), /noticeRefusal\(response\.status, body\);[\s\S]*new ApiResponseError/);
  assert.match(functionBody(bidClient, 'readError'), /return responseError\(/);
  assert.match(handler, /status === 403 && body\.code === 'role-not-allowed'\) \{\s*onRoleRefused\?\.\(\);/);
  // The refusal never clears the session the way a 401 does.
  assert.equal((handler.match(/removeToken\(\)/g) ?? []).length, 1);

  const context = codeOnly(fs.readFileSync(path.join(SRC, 'contexts/AuthContext.tsx'), 'utf8'));
  assert.match(context, /setRoleRefusedHandler\(\(\) => \{[\s\S]*?void refresh\(\);/);
  assert.match(context, /now - lastRoleCheck\.current < 10_000/);

  // And AuthGate sends a reporter by the allowlist, never mounting the page asked for.
  const gate = codeOnly(fs.readFileSync(path.join(SRC, 'components/auth/AuthGate.tsx'), 'utf8'));
  assert.match(gate, /redirectFor\(role, pathname\)/);
  assert.match(gate, /router\.replace\(sendTo\)/);
  assert.match(gate, /if \(sendTo\) \{\s*return \(\s*<Centered>/);
});
