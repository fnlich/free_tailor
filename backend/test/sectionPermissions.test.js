const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage, useAdminEmails } = require('./helpers');

/**
 * Who may reach which part of the installation.
 *
 * Hiding a link is paint. These are the checks that actually refuse, so they
 * are the ones worth pinning: a nav entry removed without the matching
 * middleware leaves the whole thing open to anybody who types the URL or keeps
 * an old tab open.
 *
 * Two separate rules, deliberately not conflated:
 *   - templates are shared by the installation, so writing one is ADMIN work;
 *   - groups are an entitlement, so using them is a PLAN question.
 * An administrator on the default plan is therefore refused by the second even
 * though the first lets them through - see `requirePlan`.
 */

async function serve() {
  useTempStorage(`section-permissions-${Math.random().toString(36).slice(2)}`);
  useAdminEmails('admin@example.com');
  const express = require('express');

  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const templateRoutes = loadFresh('../dist/routes/templates');
  const groupRoutes = loadFresh('../dist/routes/groups');

  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/templates', templateRoutes.default);
  app.use('/api/groups', groupRoutes.default);
  const server = app.listen(0);
  const port = server.address().port;

  const call = (token, method, path, body) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });

  return {
    users,
    admin,
    alice,
    adminToken: users.createSession(admin.id),
    aliceToken: users.createSession(alice.id),
    onPlan: (account, plan) => {
      users.updateUser(account.id, { plan });
      return users.createSession(account.id);
    },
    close: () => server.close(),
    call,
  };
}

/** Every way a template can be created, changed or destroyed. */
const TEMPLATE_WRITES = [
  ['POST', '/api/templates/create-manual', { name: 'x' }],
  ['POST', '/api/templates/upload-json', undefined],
  ['POST', '/api/templates/upload', undefined],
  ['PUT', '/api/templates/anything/update-manual', { name: 'x' }],
  ['PATCH', '/api/templates/anything', { name: 'x' }],
  ['DELETE', '/api/templates/anything', undefined],
];

test('an ordinary account cannot create, change or delete a template', async () => {
  const server = await serve();
  try {
    for (const [method, path, body] of TEMPLATE_WRITES) {
      const response = await server.call(server.aliceToken, method, path, body);
      // 403 and not 404: she is signed in, and the fix is being somebody else.
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal((await response.json()).code, 'not-an-admin');
    }
  } finally {
    server.close();
  }
});

test('but she can still read them, because the builder offers her the choice', async () => {
  const server = await serve();
  try {
    // The whole point of the split: a user who cannot list templates cannot
    // build anything at all.
    assert.equal((await server.call(server.aliceToken, 'GET', '/api/templates')).status, 200);
  } finally {
    server.close();
  }
});

test('an administrator is refused none of the template writes', async () => {
  const server = await serve();
  try {
    for (const [method, path, body] of TEMPLATE_WRITES) {
      const response = await server.call(server.adminToken, method, path, body);
      assert.notEqual(response.status, 401, `${method} ${path}`);
      assert.notEqual(response.status, 403, `${method} ${path}`);
    }
  } finally {
    server.close();
  }
});

test('groups need Premium, and the default plan is refused', async () => {
  const server = await serve();
  try {
    const response = await server.call(server.aliceToken, 'GET', '/api/groups');
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.code, 'plan-too-low');
    assert.equal(body.requiredPlan, 'premium');
    // Named in the sentence, so somebody reading it knows what to ask for.
    assert.match(body.error, /Premium/);
  } finally {
    server.close();
  }
});

test('every plan from Premium upwards is let through', async () => {
  const server = await serve();
  try {
    for (const plan of ['premium', 'premium-plus', 'premium-max']) {
      const token = server.onPlan(server.alice, plan);
      assert.equal((await server.call(token, 'GET', '/api/groups')).status, 200, plan);
    }
    // And moving back down closes it again.
    const back = server.onPlan(server.alice, 'default');
    assert.equal((await server.call(back, 'GET', '/api/groups')).status, 403);
  } finally {
    server.close();
  }
});

test('the plan gate covers writes as well as reads', async () => {
  const server = await serve();
  try {
    // At the router, so a route added later is covered by default. A read-only
    // gate would let a default-plan account create groups it could not see.
    for (const [method, path] of [
      ['POST', '/api/groups'],
      ['PUT', '/api/groups/anything'],
      ['DELETE', '/api/groups/anything'],
      ['GET', '/api/groups/anything'],
    ]) {
      // No body on a GET - fetch refuses to send one, which is a failure about
      // the test rather than about the guard.
      const body = method === 'GET' || method === 'DELETE' ? undefined : { name: 'x' };
      const response = await server.call(server.aliceToken, method, path, body);
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal((await response.json()).code, 'plan-too-low');
    }
  } finally {
    server.close();
  }
});

test('being an administrator is not a substitute for the plan', async () => {
  const server = await serve();
  try {
    // Deliberate, and the reason it is written down: a role says who may change
    // what everybody shares, a plan says what your account includes. Every
    // account starts on the default plan, so the first administrator is refused
    // here until somebody moves them up.
    assert.equal(server.users.getUserById(server.admin.id).plan, 'default');
    assert.equal((await server.call(server.adminToken, 'GET', '/api/groups')).status, 403);

    const upgraded = server.onPlan(server.admin, 'premium');
    assert.equal((await server.call(upgraded, 'GET', '/api/groups')).status, 200);
  } finally {
    server.close();
  }
});

test('signing out closes both sections', async () => {
  const server = await serve();
  try {
    assert.equal((await server.call(null, 'GET', '/api/groups')).status, 401);
    assert.equal((await server.call(null, 'GET', '/api/templates')).status, 401);
    assert.equal((await server.call(null, 'POST', '/api/templates/create-manual', {})).status, 401);
  } finally {
    server.close();
  }
});

test('planAtLeast ranks every tier in both directions', () => {
  const { planAtLeast } = require('../dist/config/accountPlans');
  const tiers = ['default', 'premium', 'premium-plus', 'premium-max'];

  tiers.forEach((plan, planIndex) => {
    tiers.forEach((minimum, minimumIndex) => {
      assert.equal(
        planAtLeast(plan, minimum),
        planIndex >= minimumIndex,
        `${plan} vs ${minimum}`
      );
    });
  });

  // An unknown stored value ranks lowest and is refused - the same safe
  // direction the profile cap takes.
  assert.equal(planAtLeast('premium-ultra', 'premium'), false);
  assert.equal(planAtLeast(undefined, 'premium'), false);
  assert.equal(planAtLeast(null, 'default'), true);
});
