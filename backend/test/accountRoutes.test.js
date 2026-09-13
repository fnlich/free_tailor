const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage } = require('./helpers');

/**
 * The admin account pages, and the one thing they must never allow.
 *
 * Every guard here is a variation on "do not strand the installation". Account
 * management lives behind an admin check, so an install with no enabled admin
 * has no way back in through the UI at all - the only remedy would be editing
 * the database by hand, which is not a remedy a user has.
 */

async function serve() {
  useTempStorage(`account-routes-${Math.random().toString(36).slice(2)}`);
  const express = require('express');

  const users = loadFresh('../dist/database/userRepository');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const routes = loadFresh('../dist/routes/accounts');

  const admin = users.createUser({ email: 'admin@example.com', name: 'The Admin' });
  const alice = users.createUser({ email: 'alice@example.com', name: 'Alice' });

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/admin/accounts', routes.default);
  const server = app.listen(0);
  const port = server.address().port;

  const as = (token) => ({ authorization: `Bearer ${token}` });

  return {
    users,
    admin,
    alice,
    adminToken: users.createSession(admin.id),
    aliceToken: users.createSession(alice.id),
    close: () => server.close(),
    request: (token, path, init = {}) =>
      fetch(`http://127.0.0.1:${port}/api/admin/accounts${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(token ? as(token) : {}),
          ...(init.headers ?? {}),
        },
      }),
  };
}

test('account management is closed to strangers and to ordinary users', async () => {
  const server = await serve();
  try {
    assert.equal((await server.request(null, '/')).status, 401);
    // 403, not 401: they ARE signed in, and telling them to sign in would send
    // them round a loop.
    assert.equal((await server.request(server.aliceToken, '/')).status, 403);
    assert.equal((await server.request(server.adminToken, '/')).status, 200);
  } finally {
    server.close();
  }
});

test('an admin sees every account with its plan and profile use', async () => {
  const server = await serve();
  try {
    const body = await (await server.request(server.adminToken, '/')).json();
    const byEmail = new Map(body.accounts.map((account) => [account.email, account]));

    assert.equal(byEmail.get('alice@example.com').role, 'user');
    assert.equal(byEmail.get('alice@example.com').planLabel, 'Default');
    assert.equal(byEmail.get('alice@example.com').profileLimit, 1);
    assert.equal(byEmail.get('alice@example.com').profilesUsed, 0);
    assert.equal(byEmail.get('admin@example.com').role, 'admin');

    // The plan catalog rides along, so the page's dropdown is not a second
    // copy of the list that can drift from the server's.
    assert.deepEqual(
      body.plans.map((plan) => plan.id),
      ['default', 'premium', 'premium-plus', 'premium-max']
    );
    assert.equal(body.plans.at(-1).profileLimit, null, 'Premium Max is unlimited');
  } finally {
    server.close();
  }
});

test('an admin can change a plan, credits and role', async () => {
  const server = await serve();
  try {
    const response = await server.request(server.adminToken, `/${server.alice.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ plan: 'premium-plus', credits: 40, role: 'admin' }),
    });
    const { account } = await response.json();

    assert.equal(account.plan, 'premium-plus');
    assert.equal(account.profileLimit, 25);
    assert.equal(account.credits, 40);
    assert.equal(account.role, 'admin');
  } finally {
    server.close();
  }
});

test('a plan this build does not have is refused rather than stored', async () => {
  const server = await serve();
  try {
    const response = await server.request(server.adminToken, `/${server.alice.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ plan: 'premium-ultra' }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /not a plan/i);
    assert.equal(server.users.getUserById(server.alice.id).plan, 'default');
  } finally {
    server.close();
  }
});

test('the last admin cannot be demoted, disabled or deleted', async () => {
  const server = await serve();
  try {
    for (const body of [{ role: 'user' }, { disabled: true }]) {
      const response = await server.request(server.adminToken, `/${server.admin.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 409, `refused: ${JSON.stringify(body)}`);
      assert.equal((await response.json()).code, 'last-admin');
    }

    const deleted = await server.request(server.adminToken, `/${server.admin.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 409);

    assert.equal(server.users.getUserById(server.admin.id).role, 'admin');
    assert.equal(server.users.getUserById(server.admin.id).disabled, false);
  } finally {
    server.close();
  }
});

test('once there are two admins, either may step down', async () => {
  const server = await serve();
  try {
    await server.request(server.adminToken, `/${server.alice.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'admin' }),
    });

    const response = await server.request(server.adminToken, `/${server.admin.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'user' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).account.role, 'user');
  } finally {
    server.close();
  }
});

test('a DISABLED admin does not count as one who could fix things', async () => {
  const server = await serve();
  try {
    // Promote Alice, then disable her. The install is back to one usable
    // admin, and the guard has to see that - counting rows rather than
    // ENABLED rows would let the last working admin lock everybody out.
    await server.request(server.adminToken, `/${server.alice.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'admin' }),
    });
    await server.request(server.adminToken, `/${server.alice.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ disabled: true }),
    });

    const response = await server.request(server.adminToken, `/${server.admin.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'user' }),
    });
    assert.equal(response.status, 409);
  } finally {
    server.close();
  }
});

test('disabling an account ends its sessions through the route too', async () => {
  const server = await serve();
  try {
    assert.equal(server.users.resolveSession(server.aliceToken)?.id, server.alice.id);

    await server.request(server.adminToken, `/${server.alice.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ disabled: true }),
    });

    assert.equal(server.users.resolveSession(server.aliceToken), null);
  } finally {
    server.close();
  }
});

test('an admin can pre-create an account with its plan already set', async () => {
  const server = await serve();
  try {
    const response = await server.request(server.adminToken, '/', {
      method: 'POST',
      body: JSON.stringify({ email: 'New.Person@Example.com', plan: 'premium', credits: 10 }),
    });
    assert.equal(response.status, 201);
    const { account } = await response.json();

    assert.equal(account.email, 'new.person@example.com', 'normalized on the way in');
    assert.equal(account.plan, 'premium');
    assert.equal(account.credits, 10);
    // Pre-creating is not a way in: they still have to prove the address.
    assert.equal(account.role, 'user');

    const again = await server.request(server.adminToken, '/', {
      method: 'POST',
      body: JSON.stringify({ email: 'new.person@example.com' }),
    });
    assert.equal(again.status, 409);
  } finally {
    server.close();
  }
});

test('deleting an account leaves its profiles behind, and says so', async () => {
  const server = await serve();
  try {
    const profiles = loadFresh('../dist/database/profileRepository');
    const { buildNewProfile } = loadFresh('../dist/services/profileService');
    profiles.saveProfile({
      ...buildNewProfile(
        {
          name: 'Alice CV',
          title: 'Engineer',
          skills: ['C#'],
          contact: { email: 'a@b.c', phone: '1', location: 'X' },
          summary: 's',
          experience: [],
          strengths: [],
          education: [],
        },
        'p-alice'
      ),
      ownerId: server.alice.id,
    });

    const response = await server.request(server.adminToken, `/${server.alice.id}`, { method: 'DELETE' });
    const body = await response.json();

    assert.equal(response.status, 200);
    // Deleting somebody's work as a side effect of removing their login is not
    // recoverable, so it does not happen - but it is not silent either.
    assert.equal(body.orphanedProfiles, 1);
    assert.match(body.note, /still exist/i);
    assert.ok(loadFresh('../dist/database/profileRepository').getProfile('p-alice'));
  } finally {
    server.close();
  }
});

test('an admin cannot delete the account they are signed in with', async () => {
  const server = await serve();
  try {
    await server.request(server.adminToken, `/${server.alice.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'admin' }),
    });

    // Not the last-admin guard - there are two now. This is the separate
    // "do not saw off the branch you are on" rule.
    const response = await server.request(server.adminToken, `/${server.admin.id}`, { method: 'DELETE' });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /signed in with/i);
  } finally {
    server.close();
  }
});
