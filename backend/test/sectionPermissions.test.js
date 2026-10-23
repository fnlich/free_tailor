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
 *   - profiles (people, each holding resumes) are open to every signed-in
 *     builder on every subscription: the subscription's cap is on HOW MANY
 *     profiles an account may make (402 `profile-limit`, test/profileTree.test.js),
 *     not on using them.
 * An administrator is exempt from a subscription check where one still exists
 * (owner decision B1) - see `hasSubscription`.
 */

async function serve() {
  useTempStorage(`section-permissions-${Math.random().toString(36).slice(2)}`);
  useAdminEmails('admin@example.com');
  const express = require('express');

  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const templateRoutes = loadFresh('../dist/routes/templates');
  const profileRoutes = loadFresh('../dist/routes/profiles');

  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/templates', templateRoutes.default);
  app.use('/api/profiles', profileRoutes.default);
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
    onSubscription: (account, subscription) => {
      users.updateUser(account.id, { subscription });
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

test('profiles are open on the Default subscription: no tier is asked for', async () => {
  const server = await serve();
  try {
    const response = await server.call(server.aliceToken, 'GET', '/api/profiles');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  } finally {
    server.close();
  }
});

test('every subscription is let through, and moving down never closes them', async () => {
  const server = await serve();
  try {
    for (const subscription of ['default', 'premium', 'premium-plus', 'premium-max']) {
      const token = server.onSubscription(server.alice, subscription);
      assert.equal((await server.call(token, 'GET', '/api/profiles')).status, 200, subscription);
    }
    // Moved back down to Default, it is still open.
    const back = server.onSubscription(server.alice, 'default');
    assert.equal((await server.call(back, 'GET', '/api/profiles')).status, 200);
  } finally {
    server.close();
  }
});

test('writes are open too: a Default account makes, reads, renames and deletes a profile', async () => {
  const server = await serve();
  try {
    assert.equal(server.users.getUserById(server.alice.id).subscription, 'default');
    const made = await server.call(server.aliceToken, 'POST', '/api/profiles', { name: 'Mine' });
    assert.equal(made.status, 201);
    const { id } = await made.json();
    assert.equal((await server.call(server.aliceToken, 'GET', `/api/profiles/${id}`)).status, 200);
    assert.equal((await server.call(server.aliceToken, 'PUT', `/api/profiles/${id}`, { name: 'Renamed' })).status, 200);
    assert.equal((await server.call(server.aliceToken, 'DELETE', `/api/profiles/${id}`)).status, 200);
    // What a Default account is held to is how MANY it makes, not whether it may.
    for (const [method, path, body] of [
      ['PUT', '/api/profiles/anything', { name: 'x' }],
      ['DELETE', '/api/profiles/anything', undefined],
      ['GET', '/api/profiles/anything', undefined],
    ]) {
      const response = await server.call(server.aliceToken, method, path, body);
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.equal((await response.json()).code, 'profile-not-found');
    }
  } finally {
    server.close();
  }
});

test('an administrator reaches profiles on Default, and the role is not what opens them', async () => {
  const server = await serve();
  try {
    // Owner decision B1 still exempts an administrator wherever a subscription
    // is checked (credits, the multi-profile build gate). Profiles check none.
    assert.equal(server.users.getUserById(server.admin.id).subscription, 'default');
    assert.equal((await server.call(server.adminToken, 'GET', '/api/profiles')).status, 200);
    assert.equal((await server.call(server.adminToken, 'POST', '/api/profiles', { name: 'x', resumeIds: [] })).status, 201);

    // The same account demoted to a user on Default is let through like anybody else.
    server.users.updateUser(server.admin.id, { role: 'user' });
    const demoted = server.users.createSession(server.admin.id);
    assert.equal((await server.call(demoted, 'GET', '/api/profiles')).status, 200);
  } finally {
    server.close();
  }
});

test('hasSubscription: the role exempts, the tier decides for everybody else', () => {
  const { hasSubscription } = loadFresh('../dist/middleware/auth');
  assert.equal(hasSubscription({ role: 'admin', subscription: 'default' }, 'premium-max'), true);
  assert.equal(hasSubscription({ role: 'user', subscription: 'default' }, 'premium'), false);
  assert.equal(hasSubscription({ role: 'user', subscription: 'premium' }, 'premium'), true);
  assert.equal(hasSubscription({ role: 'user', subscription: 'premium-plus' }, 'premium'), true);
  // An unknown stored tier resolves to the smallest, and nobody signed in has none.
  assert.equal(hasSubscription({ role: 'user', subscription: 'gold' }, 'premium'), false);
  assert.equal(hasSubscription(null, 'default'), false);
});

test('signing out closes both sections', async () => {
  const server = await serve();
  try {
    assert.equal((await server.call(null, 'GET', '/api/profiles')).status, 401);
    assert.equal((await server.call(null, 'GET', '/api/templates')).status, 401);
    assert.equal((await server.call(null, 'POST', '/api/templates/create-manual', {})).status, 401);
  } finally {
    server.close();
  }
});

test('subscriptionAtLeast ranks every tier in both directions', () => {
  const { subscriptionAtLeast } = require('../dist/config/accountSubscriptions');
  const tiers = ['default', 'premium', 'premium-plus', 'premium-max'];

  tiers.forEach((subscription, subscriptionIndex) => {
    tiers.forEach((minimum, minimumIndex) => {
      assert.equal(
        subscriptionAtLeast(subscription, minimum),
        subscriptionIndex >= minimumIndex,
        `${subscription} vs ${minimum}`
      );
    });
  });

  // An unknown stored value ranks lowest and is refused - the same safe
  // direction the profile cap takes.
  assert.equal(subscriptionAtLeast('premium-ultra', 'premium'), false);
  assert.equal(subscriptionAtLeast(undefined, 'premium'), false);
  assert.equal(subscriptionAtLeast(null, 'default'), true);
});
