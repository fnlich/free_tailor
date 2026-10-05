const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { loadFresh, useTempStorage, useAdminEmails } = require('./helpers');

/**
 * Who may reach which part of the API: ONE explicit table, and three checks
 * that it is the truth.
 *
 * There are three roles (config/accountRoles.ts). A `reporter` adds jobs to the
 * lake and is paid per job (owner decisions A3, A4): their own account, credits,
 * notifications, job sheet, refund history and Contact admin - nothing for
 * building resumes, no scrapers, no buying. `requireUser` is the builder check
 * (user or admin) and `requireAccount` any signed-in role, so a router nobody
 * thought about is closed to reporters by default. This file is where "nobody
 * thought about it" becomes a failing test instead:
 *
 *  1. every mount in index.ts has a row here, and every row a mount - a new
 *     router cannot be mounted without somebody deciding who it is for;
 *  2. every route of every router carries the guard its row says, read off the
 *     router itself - a route added to a per-route router (admin.ts) without
 *     `requireAdmin`, or a builder router switched to `requireAccount`, fails;
 *  3. over HTTP, with real sessions for each role: a reporter is refused EVERY
 *     route of every router that is not theirs, with 403 `role-not-allowed`
 *     (or `not-an-admin`), and reaches the ones that are; a user and an
 *     administrator are refused none of the builder's.
 *
 * Access levels, least to most restricted:
 *   public  - no session needed (sign-in, contact, webhooks: their own checks)
 *   account - any signed-in role                     (requireAccount)
 *   builder - a user or an administrator, never a reporter (requireUser,
 *             requireSubscription)
 *   admin   - administrators                         (requireAdmin)
 */

const LEVELS = ['public', 'account', 'builder', 'admin'];
const GUARD_LEVEL = {
  requireAccount: 'account',
  requireUser: 'builder',
  // requireSubscription(min)'s middleware: a builder tier, refusing a reporter by role first.
  subscriptionGuard: 'builder',
  requireAdmin: 'admin',
};

/**
 * THE TABLE. `access` is every route's level unless `except` names the route
 * (`METHOD path` as the router declares it). Adding a mount to index.ts, or a
 * route whose level differs from its router's, means adding it here - which is
 * the decision this file exists to force.
 */
const MOUNTS = [
  {
    mount: '/api/payments/webhook',
    module: 'paymentWebhooks',
    access: 'public',
    why: 'Stripe and Cryptomus call it; the signature on the body is the authentication',
  },
  {
    mount: '/api/auth',
    module: 'auth',
    access: 'public',
    why: 'signing in, and "who am I", happen before there is a session',
    except: { 'GET /account': 'account', 'PATCH /account': 'account' },
  },
  { mount: '/api/contact', module: 'contact', access: 'public', why: 'shown on the sign-in and disabled-account screens (A2)' },
  { mount: '/api/admin/contact', module: 'contact', exportName: 'adminContactRouter', access: 'admin' },
  { mount: '/api/admin/accounts', module: 'accounts', access: 'admin' },
  { mount: '/api/credits', module: 'credits', access: 'account', why: "a reporter's earnings and payouts (A4)" },
  { mount: '/api/notifications', module: 'notifications', access: 'account', why: 'every account reads the bell (A3)' },
  { mount: '/api/sheet', module: 'sheet', access: 'account', why: 'Settings > Job Sheet, where a reporter finds jobs (A3)' },
  { mount: '/api/profiles', module: 'profiles', access: 'builder' },
  {
    mount: '/api/templates',
    module: 'templates',
    access: 'builder',
    except: {
      'POST /create-manual': 'admin',
      'POST /upload-json': 'admin',
      'POST /upload': 'admin',
      'PUT /:id/update-manual': 'admin',
      'PATCH /:id': 'admin',
      'DELETE /:id': 'admin',
    },
  },
  {
    mount: '/api/resume',
    module: 'resume',
    access: 'builder',
    except: {
      'POST /skills': 'admin',
      'PUT /skills': 'admin',
      'DELETE /skills': 'admin',
      'POST /analyze-prompt-test': 'admin',
    },
  },
  { mount: '/api/generation', module: 'generation', access: 'builder', except: { 'GET /queues': 'admin' } },
  { mount: '/api/orders', module: 'orders', access: 'builder' },
  { mount: '/api/payments', module: 'payments', access: 'builder', why: 'a reporter cannot buy credits (A4)' },
  { mount: '/api/admin/payments', module: 'payments', exportName: 'adminPaymentsRouter', access: 'admin' },
  { mount: '/api/admin/notifications', module: 'notifications', exportName: 'adminNotificationsRouter', access: 'admin' },
  {
    mount: '/api/refund-requests',
    module: 'refundRequests',
    access: 'account',
    why: 'reading your own requests is anybody\'s; asking is for an account that buys and builds',
    except: { 'GET /options': 'builder', 'POST /': 'builder' },
  },
  { mount: '/api/admin/refund-requests', module: 'refundRequests', exportName: 'adminRefundRequestsRouter', access: 'admin' },
  {
    mount: '/api/admin',
    module: 'admin',
    access: 'admin',
    why: 'guarded per route, so every route is listed by this check',
    // The retired shared-password login answers 410, and the old logout
    // redirects to /api/auth/logout: neither does anything.
    except: { 'ALL /login|/verify': 'public', 'POST /logout': 'public' },
  },
  { mount: '/api/groups', module: 'groups', access: 'builder' },
  { mount: '/api/import', module: 'import', access: 'builder' },
  {
    mount: '/api/prompts',
    module: 'prompts',
    access: 'builder',
    except: {
      'POST /validate': 'admin',
      'POST /preview': 'admin',
      'POST /': 'admin',
      'PUT /:id': 'admin',
      'POST /:id/activate': 'admin',
      'DELETE /:id': 'admin',
    },
  },
  { mount: '/api/jobs', module: 'jobs', access: 'builder', why: 'the scrapers and the Job Filter: no scrapers for a reporter (A3)' },
  {
    mount: '/api/bid-assistant',
    module: 'bidAssistant',
    access: 'builder',
    except: { 'DELETE /jobs/:jobId': 'admin', 'PUT /settings/prompt-template': 'admin' },
  },
  { mount: '/api/admin/ai', module: 'aiHealth', access: 'admin' },
];

/** Routes index.ts declares itself rather than through a router: the guard is read off the line. */
const INLINE_ROUTES = [
  { method: 'get', path: '/api/generated/:filename(*)', access: 'builder', guard: 'requireUser' },
  { method: 'get', path: '/api/health', access: 'public', guard: null },
];

const INDEX_SOURCE = path.join(__dirname, '..', 'src', 'index.ts');

/** index.ts's own view: the router imports, the `app.use` mounts, the inline routes. */
function readIndex() {
  const source = fs.readFileSync(INDEX_SOURCE, 'utf8');

  const imports = new Map();
  for (const match of source.matchAll(/^import\s+(\w+)?\s*,?\s*(?:\{([^}]*)\})?\s*from\s+'\.\/routes\/(\w+)';/gm)) {
    const [, defaultName, named, module] = match;
    if (defaultName) imports.set(defaultName, { module, exportName: 'default' });
    for (const part of (named ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)) {
      const [exported, local] = part.split(/\s+as\s+/);
      imports.set((local ?? exported).trim(), { module, exportName: exported.trim() });
    }
  }

  const mounts = [];
  for (const match of source.matchAll(/^app\.use\(\s*'(\/api[^']*)'\s*,([\s\S]*?)\);\s*$/gm)) {
    const args = match[2].split(',').map((entry) => entry.trim());
    const identifier = args[args.length - 1];
    mounts.push({ mount: match[1], identifier, router: imports.get(identifier) });
  }

  const inline = [];
  for (const match of source.matchAll(/^app\.(get|post|put|patch|delete|all)\(\s*'(\/api[^']*)'\s*,\s*([^,]*?)\s*,/gm)) {
    const [, method, routePath, first] = match;
    inline.push({ method, path: routePath, guard: /^\w+$/.test(first) ? first : null });
  }
  return { mounts, inline };
}

function levelOf(name) {
  return Object.prototype.hasOwnProperty.call(GUARD_LEVEL, name) ? GUARD_LEVEL[name] : null;
}

function stricter(a, b) {
  return LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b;
}

/**
 * Every route a router declares, with the level actually guarding it: the
 * strictest of the router-level guards before it and the route's own.
 */
function routesOf(router) {
  const routes = [];
  let routerLevel = 'public';
  for (const layer of router.stack) {
    if (!layer.route) {
      if (layer.handle && Array.isArray(layer.handle.stack)) {
        throw new Error('A router mounts a nested router; teach routeAccess.test.js to walk it before relying on it.');
      }
      const level = levelOf(layer.name);
      if (level) routerLevel = stricter(routerLevel, level);
      continue;
    }
    let level = routerLevel;
    for (const handler of layer.route.stack) {
      const own = levelOf(handler.name);
      if (own) level = stricter(level, own);
    }
    const methods = layer.route.methods._all
      ? ['ALL']
      : Object.keys(layer.route.methods).map((method) => method.toUpperCase());
    const declared = Array.isArray(layer.route.path) ? layer.route.path.join('|') : String(layer.route.path);
    const samplePath = (Array.isArray(layer.route.path) ? layer.route.path[0] : String(layer.route.path))
      .replace(/:(\w+)\([^)]*\)/g, 'probe')
      .replace(/:(\w+)/g, 'probe');
    for (const method of methods) {
      routes.push({ key: `${method} ${declared}`, method, samplePath, level });
    }
  }
  return routes;
}

function loadRouters() {
  const routers = new Map();
  for (const row of MOUNTS) {
    const module = require(path.join(__dirname, '..', 'dist', 'routes', row.module));
    const router = module[row.exportName ?? 'default'];
    assert.ok(router && Array.isArray(router.stack), `${row.module}.${row.exportName ?? 'default'} is a router`);
    routers.set(row.mount, router);
  }
  return routers;
}

test('every router index.ts mounts has a decision in this table, and every decision a router', () => {
  const { mounts, inline } = readIndex();

  const mounted = mounts.map((entry) => entry.mount).sort();
  const decided = MOUNTS.map((row) => row.mount).sort();
  assert.deepEqual(mounted, decided, 'index.ts mounts a router this table does not decide about, or the reverse');

  for (const entry of mounts) {
    const row = MOUNTS.find((candidate) => candidate.mount === entry.mount);
    assert.ok(entry.router, `${entry.mount}: ${entry.identifier} is imported from ./routes`);
    assert.equal(entry.router.module, row.module, `${entry.mount} mounts routes/${row.module}`);
    assert.equal(entry.router.exportName, row.exportName ?? 'default', `${entry.mount} mounts that export`);
  }

  assert.deepEqual(
    inline.map((route) => `${route.method} ${route.path} ${route.guard}`).sort(),
    INLINE_ROUTES.map((route) => `${route.method} ${route.path} ${route.guard}`).sort(),
    'index.ts declares an /api route of its own that this table does not decide about'
  );
});

test('every route of every router carries the guard its row decides', () => {
  useTempStorage(`route-access-static-${Math.random().toString(36).slice(2)}`);
  const routers = loadRouters();

  for (const row of MOUNTS) {
    const routes = routesOf(routers.get(row.mount));
    assert.ok(routes.length > 0, `${row.mount} declares routes`);
    const keys = new Set(routes.map((route) => route.key));
    for (const key of Object.keys(row.except ?? {})) {
      assert.ok(keys.has(key), `${row.mount}: the table names ${key}, which the router no longer has`);
    }
    for (const route of routes) {
      const expected = row.except?.[route.key] ?? row.access;
      assert.equal(route.level, expected, `${route.key} under ${row.mount}`);
    }
  }
});

/* -------------------------------------------------------------- over HTTP */

async function serveEverything() {
  useTempStorage(`route-access-${Math.random().toString(36).slice(2)}`);
  useAdminEmails('admin@example.com');
  const express = require('express');

  const users = loadFresh('../dist/database/userRepository');
  const { attachUser } = require('../dist/middleware/auth');
  const routers = loadRouters();

  const admin = users.createUser({ email: 'admin@example.com', name: 'Admin' });
  const user = users.createUser({ email: 'user@example.com', name: 'User' });
  const reporter = users.createUser({ email: 'reporter@example.com', name: 'Reporter', role: 'reporter' });
  assert.equal(admin.role, 'admin');
  assert.equal(reporter.role, 'reporter');

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  // In index.ts's order, so a path two mounts could claim reaches the same one.
  for (const entry of readIndex().mounts) app.use(entry.mount, routers.get(entry.mount));
  const server = app.listen(0);
  const port = server.address().port;

  const tokens = {
    admin: users.createSession(admin.id),
    user: users.createSession(user.id),
    reporter: users.createSession(reporter.id),
  };

  return {
    users,
    reporter,
    close: () => server.close(),
    async call(role, method, url, body) {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(role ? { authorization: `Bearer ${tokens[role]}` } : {}),
        },
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(body ?? {}) }),
      });
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: response.status, body: json };
    },
  };
}

test('a reporter is refused every route of every router that is not theirs, before anything runs', async () => {
  const server = await serveEverything();
  try {
    const routers = loadRouters();
    let probed = 0;
    for (const row of MOUNTS) {
      for (const route of routesOf(routers.get(row.mount))) {
        if (route.level !== 'builder' && route.level !== 'admin') continue;
        const method = route.method === 'ALL' ? 'GET' : route.method;
        const url = `${row.mount}${route.samplePath === '/' ? '' : route.samplePath}`;
        const answer = await server.call('reporter', method, url);
        const where = `${method} ${url}`;
        assert.equal(answer.status, 403, where);
        if (route.level === 'builder') {
          assert.equal(answer.body?.code, 'role-not-allowed', where);
          assert.equal(
            answer.body?.error,
            'That part of the app is not available for your account. Ask your administrator if you need it.',
            where
          );
        } else {
          // An admin route under a builder router meets the builder check
          // first; one under an admin router meets the admin check.
          assert.ok(['role-not-allowed', 'not-an-admin'].includes(answer.body?.code), where);
        }
        probed += 1;
      }
    }
    // The probe is the whole API minus the reporter's few routes: a number
    // that drops sharply means the walk above stopped seeing routers.
    assert.ok(probed > 100, `probed ${probed} routes`);
  } finally {
    server.close();
  }
});

test("a reporter reaches their own account, balance, ledger, bell, sheet, refund history and Contact admin", async () => {
  const server = await serveEverything();
  try {
    const me = await server.call('reporter', 'GET', '/api/auth/me');
    assert.equal(me.status, 200);
    // The shell routes on this: role reaches the page.
    assert.equal(me.body.account.role, 'reporter');
    assert.equal(me.body.account.email, 'reporter@example.com');
    // The rate is the administrators': never on the session payload.
    assert.equal('reportRateMilli' in me.body.account, false);

    for (const [method, url, body] of [
      ['GET', '/api/auth/account'],
      ['PATCH', '/api/auth/account', { name: 'Renamed Reporter' }],
      ['GET', '/api/credits'],
      ['GET', '/api/credits/ledger'],
      ['GET', '/api/notifications'],
      ['POST', '/api/notifications/seen'],
      ['GET', '/api/sheet'],
      ['GET', '/api/contact'],
      ['GET', '/api/refund-requests'],
    ]) {
      const answer = await server.call('reporter', method, url, body);
      assert.equal(answer.status, 200, `${method} ${url}: ${JSON.stringify(answer.body)}`);
    }
    assert.equal(server.users.getUserById(server.reporter.id).name, 'Renamed Reporter');

    const requests = await server.call('reporter', 'GET', '/api/refund-requests');
    assert.deepEqual(requests.body.requests, []);
    const ledger = await server.call('reporter', 'GET', '/api/credits/ledger');
    assert.equal(ledger.body.balanceMilli, 0);

    // Asking for a refund, and buying, are not theirs.
    for (const [method, url] of [
      ['GET', '/api/refund-requests/options?paymentId=probe'],
      ['POST', '/api/refund-requests'],
      ['POST', '/api/payments/checkout'],
      ['GET', '/api/payments/quote'],
      ['GET', '/api/payments'],
    ]) {
      const answer = await server.call('reporter', method, url, {});
      assert.equal(answer.status, 403, `${method} ${url}`);
      assert.equal(answer.body.code, 'role-not-allowed', `${method} ${url}`);
    }

    // Signed out, the account routes still say "sign in", not "not for you".
    for (const url of ['/api/credits', '/api/notifications', '/api/sheet', '/api/refund-requests', '/api/auth/account']) {
      const answer = await server.call(null, 'GET', url);
      assert.equal(answer.status, 401, url);
      assert.equal(answer.body.code, 'not-signed-in', url);
    }
  } finally {
    server.close();
  }
});

test('a user and an administrator are refused none of the builder by role', async () => {
  const server = await serveEverything();
  try {
    for (const role of ['user', 'admin']) {
      for (const url of [
        '/api/profiles',
        '/api/templates',
        '/api/resume/models',
        '/api/resume/skills',
        '/api/generation/batches?active=1',
        '/api/orders',
        '/api/payments',
        '/api/prompts',
        '/api/prompts/categories',
        '/api/jobs/scrapers/providers',
        '/api/bid-assistant/jobs',
        '/api/groups',
        '/api/refund-requests/options?paymentId=probe',
        '/api/credits',
        '/api/sheet',
      ]) {
        const answer = await server.call(role, 'GET', url);
        const where = `${role} GET ${url}: ${answer.status} ${JSON.stringify(answer.body)}`;
        assert.notEqual(answer.status, 401, where);
        assert.notEqual(answer.body?.code, 'role-not-allowed', where);
        assert.notEqual(answer.body?.code, 'not-an-admin', where);
      }
    }
    // Groups is a tier as well as a role: a Default user is refused by
    // subscription, an administrator is exempt.
    assert.equal((await server.call('user', 'GET', '/api/groups')).body.code, 'subscription-too-low');
    assert.equal((await server.call('admin', 'GET', '/api/groups')).status, 200);

    // And the administrator-only parts stay theirs.
    assert.equal((await server.call('user', 'GET', '/api/admin/accounts')).body.code, 'not-an-admin');
    assert.equal((await server.call('admin', 'GET', '/api/admin/accounts')).status, 200);
  } finally {
    server.close();
  }
});
