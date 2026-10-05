const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage, useAdminEmails } = require('./helpers');

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
  useAdminEmails('admin@example.com');
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

test('an admin sees every account with its subscription and profile use', async () => {
  const server = await serve();
  try {
    const body = await (await server.request(server.adminToken, '/')).json();
    const byEmail = new Map(body.accounts.map((account) => [account.email, account]));

    assert.equal(byEmail.get('alice@example.com').role, 'user');
    assert.equal(byEmail.get('alice@example.com').subscription, 'default');
    assert.equal(byEmail.get('alice@example.com').subscriptionLabel, 'Default');
    // Renamed with no alias: the frontend ships with the backend, and a second
    // name for the same field is a second thing to keep in step.
    assert.equal('plan' in byEmail.get('alice@example.com'), false);
    assert.equal('planLabel' in byEmail.get('alice@example.com'), false);
    assert.equal(byEmail.get('alice@example.com').profileLimit, 1);
    assert.equal(byEmail.get('alice@example.com').profilesUsed, 0);
    assert.equal(byEmail.get('admin@example.com').role, 'admin');

    // The subscription catalog rides along, so the page's dropdown is not a
    // second copy of the list that can drift from the server's.
    assert.deepEqual(
      body.subscriptions.map((subscription) => subscription.id),
      ['default', 'premium', 'premium-plus', 'premium-max']
    );
    assert.deepEqual(
      body.subscriptions.map((subscription) => subscription.label),
      ['Default', 'Premium', 'Premium+', 'Premium Max']
    );
    assert.equal(body.subscriptions.at(-1).profileLimit, null, 'Premium Max is unlimited');
    assert.equal('plans' in body, false);
  } finally {
    server.close();
  }
});

test('an admin can change a subscription, credits and role', async () => {
  const server = await serve();
  try {
    const response = await server.request(server.adminToken, `/${server.alice.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ subscription: 'premium-plus', credits: 40, role: 'admin' }),
    });
    const { account } = await response.json();

    assert.equal(account.subscription, 'premium-plus');
    assert.equal(account.subscriptionLabel, 'Premium+');
    assert.equal(account.profileLimit, 25);
    assert.equal(account.credits, 40);
    assert.equal(account.role, 'admin');
  } finally {
    server.close();
  }
});

test('a subscription this build does not have is refused rather than stored', async () => {
  const server = await serve();
  try {
    const response = await server.request(server.adminToken, `/${server.alice.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ subscription: 'premium-ultra' }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /not a subscription/i);
    assert.equal(server.users.getUserById(server.alice.id).subscription, 'default');
  } finally {
    server.close();
  }
});

test('a page still sending the retired `plan` field is told to reload, not silently ignored', async () => {
  const server = await serve();
  try {
    // An Accounts page left open across the upgrade. Ignoring the field would
    // answer "nothing to change" to a change, and create a Default account
    // from an invite meant for Premium.
    const patch = await server.request(server.adminToken, `/${server.alice.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ plan: 'premium' }),
    });
    assert.equal(patch.status, 400);
    assert.equal((await patch.json()).code, 'stale-page');
    assert.equal(server.users.getUserById(server.alice.id).subscription, 'default');

    const invite = await server.request(server.adminToken, '/', {
      method: 'POST',
      body: JSON.stringify({ email: 'stale@example.com', plan: 'premium' }),
    });
    assert.equal(invite.status, 400);
    assert.equal((await invite.json()).code, 'stale-page');
    assert.equal(server.users.getUserByEmail('stale@example.com'), null);
  } finally {
    server.close();
  }
});

test('an admin cannot disable, demote or delete their own account, even with another admin', async () => {
  const server = await serve();
  try {
    // Two admins, so the last-admin guard has nothing to say: this is the
    // separate "do not saw off the branch you are on" rule.
    await server.request(server.adminToken, `/${server.alice.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'admin' }),
    });

    for (const [body, verb] of [
      [{ role: 'user' }, /remove the administrator role from/],
      [{ disabled: true }, /disable/],
      // Any role that is not admin, including one this build does not grant:
      // the guard reads "not admin", never `user` by name.
      [{ disabled: true, role: 'user' }, /disable/],
    ]) {
      const response = await server.request(server.adminToken, `/${server.admin.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 409, `refused: ${JSON.stringify(body)}`);
      const answer = await response.json();
      assert.equal(answer.code, 'own-account');
      assert.match(answer.error, verb);
      assert.match(answer.error, /the account you are signed in with\. Another administrator can/);
    }

    const deleted = await server.request(server.adminToken, `/${server.admin.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 409);
    const answer = await deleted.json();
    assert.equal(answer.code, 'own-account');
    assert.match(answer.error, /^You cannot delete the account you are signed in with\./);

    const still = server.users.getUserById(server.admin.id);
    assert.equal(still.role, 'admin');
    assert.equal(still.disabled, false);
    assert.equal(server.users.resolveSession(server.adminToken)?.id, server.admin.id, 'still signed in');
  } finally {
    server.close();
  }
});

test('an admin may still change their own name, subscription and credits', async () => {
  const server = await serve();
  try {
    const response = await server.request(server.adminToken, `/${server.admin.id}`, {
      method: 'PATCH',
      // `role: 'admin'` and `disabled: false` change nothing that matters, so
      // they are not refused either.
      body: JSON.stringify({ name: 'Renamed', subscription: 'premium', credits: 5, role: 'admin', disabled: false }),
    });
    assert.equal(response.status, 200);
    const { account } = await response.json();
    assert.equal(account.name, 'Renamed');
    assert.equal(account.subscription, 'premium');
    assert.equal(account.role, 'admin');
  } finally {
    server.close();
  }
});

test('another admin may disable, demote and delete an admin', async () => {
  const server = await serve();
  try {
    const bob = server.users.createUser({ email: 'bob@example.com', name: 'Bob' });
    for (const id of [server.alice.id, bob.id]) {
      await server.request(server.adminToken, `/${id}`, { method: 'PATCH', body: JSON.stringify({ role: 'admin' }) });
    }

    const demoted = await server.request(server.adminToken, `/${server.alice.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'user' }),
    });
    assert.equal(demoted.status, 200);
    assert.equal((await demoted.json()).account.role, 'user');

    const disabled = await server.request(server.adminToken, `/${bob.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json()).account.disabled, true);

    const deleted = await server.request(server.adminToken, `/${bob.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.equal(server.users.getUserById(bob.id), null);

    // And the other way round: the admin the harness signed in as can be
    // demoted by Alice once she is an administrator again.
    await server.request(server.adminToken, `/${server.alice.id}`, { method: 'PATCH', body: JSON.stringify({ role: 'admin' }) });
    const byAlice = await server.request(server.aliceToken, `/${server.admin.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'user' }),
    });
    assert.equal(byAlice.status, 200);
    assert.equal((await byAlice.json()).account.role, 'user');
  } finally {
    server.close();
  }
});

/**
 * The last-admin guard, asked directly.
 *
 * Over HTTP it is now reached only through somebody else's change, and the
 * one asking is an enabled administrator too - so the case it exists for
 * cannot be staged through the route any more. It is still the guard that
 * holds if that ever stops being true, so it is pinned on its own.
 */
test('the last enabled admin cannot be taken away, by any role that is not admin', async () => {
  const server = await serve();
  try {
    const { wouldStrandInstall } = require('../dist/routes/accounts');
    const admin = server.users.getUserById(server.admin.id);

    assert.equal(wouldStrandInstall(admin, { role: 'user' }), true);
    assert.equal(wouldStrandInstall(admin, { disabled: true }), true);
    // A third role must not walk past it: the check is "not admin", not "user".
    assert.equal(wouldStrandInstall(admin, { role: 'reporter' }), true);
    assert.equal(wouldStrandInstall(admin, { role: 'admin' }), false);
    assert.equal(wouldStrandInstall(admin, { name: 'x', disabled: false }), false);
    assert.equal(wouldStrandInstall(server.users.getUserById(server.alice.id), { role: 'user' }), false, 'not an admin');

    // Promote Alice, then disable her. The install is back to one usable
    // admin, and the guard has to see that - counting rows rather than
    // ENABLED rows would let the last working admin lock everybody out.
    await server.request(server.adminToken, `/${server.alice.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'admin' }),
    });
    assert.equal(wouldStrandInstall(admin, { role: 'user' }), false, 'two enabled admins');
    await server.request(server.adminToken, `/${server.alice.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(wouldStrandInstall(admin, { role: 'user' }), true, 'a DISABLED admin does not count');
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

test('an admin can pre-create an account with its subscription already set', async () => {
  const server = await serve();
  try {
    const response = await server.request(server.adminToken, '/', {
      method: 'POST',
      body: JSON.stringify({ email: 'New.Person@Example.com', subscription: 'premium', credits: 10 }),
    });
    assert.equal(response.status, 201);
    const { account } = await response.json();

    assert.equal(account.email, 'new.person@example.com', 'normalized on the way in');
    assert.equal(account.subscription, 'premium');
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
