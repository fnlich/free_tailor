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

test('an admin can change a subscription, a balance in dollars and a role', async () => {
  const server = await serve();
  try {
    const response = await server.request(server.adminToken, `/${server.alice.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ subscription: 'premium-plus', balanceUsd: '3.977', role: 'admin' }),
    });
    const { account } = await response.json();

    assert.equal(account.subscription, 'premium-plus');
    assert.equal(account.subscriptionLabel, 'Premium+');
    assert.equal(account.profileLimit, 25);
    assert.equal(account.balanceMilli, 3_977, '$3.977, exactly');
    assert.equal('credits' in account, false, 'the whole-credit field is gone');
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
      [{ role: 'reporter' }, /remove the administrator role from/],
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
      body: JSON.stringify({ name: 'Renamed', subscription: 'premium', balanceUsd: '5', role: 'admin', disabled: false }),
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
      body: JSON.stringify({ email: 'New.Person@Example.com', subscription: 'premium', balanceUsd: '10.005' }),
    });
    assert.equal(response.status, 201);
    const { account } = await response.json();

    assert.equal(account.email, 'new.person@example.com', 'normalized on the way in');
    assert.equal(account.subscription, 'premium');
    assert.equal(account.balanceMilli, 10_005);
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

test('a balance is set and granted in dollars to $0.001, and anything finer, or a page still in credits, is refused', async () => {
  const server = await serve();
  try {
    const patch = (body) =>
      server.request(server.adminToken, `/${server.alice.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    const grant = (body) =>
      server.request(server.adminToken, `/${server.alice.id}/credits`, { method: 'POST', body: JSON.stringify(body) });

    assert.equal((await patch({ balanceUsd: '1' })).status, 200);
    const granted = await grant({ amountUsd: '0.005', note: 'a half cent' });
    assert.equal(granted.status, 200);
    const body = await granted.json();
    assert.equal(body.balanceMilli, 1_005);
    assert.equal(body.account.balanceMilli, 1_005);

    const taken = await (await grant({ amountUsd: '-0.105' })).json();
    assert.equal(taken.balanceMilli, 900);

    for (const [bad, why] of [
      ['0.0005', /three decimal places/],
      ['0', /an amount in dollars to add/],
      ['ten', /must be an amount in dollars/],
      [undefined, /is required/],
    ]) {
      const refused = await grant({ amountUsd: bad });
      assert.equal(refused.status, 400, JSON.stringify(bad));
      assert.match((await refused.json()).error, why);
    }
    for (const [bad, why] of [
      ['3.9775', /three decimal places/],
      ['-1', /cannot be negative/],
      ['', /is required/],
    ]) {
      const refused = await patch({ balanceUsd: bad });
      assert.equal(refused.status, 400, JSON.stringify(bad));
      assert.match((await refused.json()).error, why);
    }

    // An Accounts page loaded before credits were dollars sends whole credits.
    // Read as dollars, or quietly ignored, either would move somebody's money
    // by a figure nobody meant; it is refused, and nothing moves.
    for (const [request, body] of [
      [patch, { credits: 40 }],
      [grant, { amount: 5 }],
    ]) {
      const refused = await request(body);
      assert.equal(refused.status, 400);
      assert.equal((await refused.json()).code, 'stale-page');
    }
    const preCreate = await server.request(server.adminToken, '/', {
      method: 'POST',
      body: JSON.stringify({ email: 'stale@example.com', credits: 10 }),
    });
    assert.equal(preCreate.status, 400);

    const ledger = await (await server.request(server.adminToken, `/${server.alice.id}/credits`)).json();
    assert.equal(ledger.balanceMilli, 900, 'untouched by every refusal');
    assert.deepEqual(
      ledger.entries.map((entry) => [entry.reason, entry.deltaMilli]),
      [
        ['admin-revoke', -105],
        ['admin-grant', 5],
        ['admin-set', 1_000],
      ]
    );
    assert.match(ledger.entries[2].note, /Set from the accounts page/);
  } finally {
    server.close();
  }
});

/* ------------------------------------------------------------ reporters */

test('an admin can make an account a reporter, pre-create one, and the role list rides along', async () => {
  const server = await serve();
  try {
    const list = await (await server.request(server.adminToken, '/')).json();
    // The page's role select reads this rather than keeping its own copy.
    assert.deepEqual(list.roles, [
      { id: 'user', label: 'User' },
      { id: 'reporter', label: 'Reporter' },
      { id: 'admin', label: 'Administrator' },
    ]);
    const aliceRow = list.accounts.find((account) => account.id === server.alice.id);
    assert.equal(aliceRow.roleLabel, 'User');
    assert.equal(aliceRow.reportRateMilli, null);
    assert.equal(aliceRow.configuredAdmin, false);
    assert.equal(aliceRow.configuredAdminSource, null);
    const adminRow = list.accounts.find((account) => account.id === server.admin.id);
    assert.equal(adminRow.configuredAdmin, true);
    assert.equal(adminRow.configuredAdminSource, 'ADMIN_EMAILS');

    const made = await server.request(server.adminToken, `/${server.alice.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'reporter' }),
    });
    assert.equal(made.status, 200);
    const { account, note } = await made.json();
    assert.equal(account.role, 'reporter');
    assert.equal(account.roleLabel, 'Reporter');
    assert.equal(note, undefined, 'not a configured address');
    // A role change keeps the session: the next request is judged by the new
    // role anyway, because every request reads the account again.
    assert.equal(server.users.resolveSession(server.aliceToken)?.role, 'reporter');

    const invited = await server.request(server.adminToken, '/', {
      method: 'POST',
      body: JSON.stringify({ email: 'scout@example.com', role: 'reporter', reportRateUsd: '0.050' }),
    });
    assert.equal(invited.status, 201);
    const scout = (await invited.json()).account;
    assert.equal(scout.role, 'reporter');
    assert.equal(scout.reportRateMilli, 50);
    assert.equal(server.users.getUserByEmail('scout@example.com').role, 'reporter');

    // A role this build does not have is refused by name, on both doors, and
    // the invite creates nothing - never a quiet `user`.
    const badInvite = await server.request(server.adminToken, '/', {
      method: 'POST',
      body: JSON.stringify({ email: 'odd@example.com', role: 'superuser' }),
    });
    assert.equal(badInvite.status, 400);
    assert.equal((await badInvite.json()).code, 'bad-role');
    assert.equal(server.users.getUserByEmail('odd@example.com'), null);
    const badPatch = await server.request(server.adminToken, `/${server.alice.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'Reporter' }),
    });
    assert.equal(badPatch.status, 400);
    assert.equal((await badPatch.json()).code, 'bad-role');
    assert.equal(server.users.getUserById(server.alice.id).role, 'reporter');
  } finally {
    server.close();
  }
});

test("a reporter's rate per job is set in dollars, cleared with empty, and only on a reporter", async () => {
  const server = await serve();
  try {
    const patch = (body) =>
      server.request(server.adminToken, `/${server.alice.id}`, { method: 'PATCH', body: JSON.stringify(body) });

    // Alice is a user: a rate on her is refused, and nothing is changed.
    const onUser = await patch({ reportRateUsd: '0.050' });
    assert.equal(onUser.status, 409);
    assert.equal((await onUser.json()).code, 'not-a-reporter');
    assert.equal(server.users.getReportRateMilli(server.alice.id), null);

    // In the same change that makes her a reporter, it is fine.
    const both = await patch({ role: 'reporter', reportRateUsd: '0.025' });
    assert.equal(both.status, 200);
    assert.equal((await both.json()).account.reportRateMilli, 25);

    const changed = await (await patch({ reportRateUsd: 0.04 })).json();
    assert.equal(changed.account.reportRateMilli, 40);
    // The list serves it too, by its own one-query map rather than the
    // per-account read the change answered with: the Accounts page fills the
    // box from the list, and skips saving a figure it believes unchanged.
    const listedRate = async () =>
      (await (await server.request(server.adminToken, '/')).json()).accounts.find(
        (account) => account.id === server.alice.id
      ).reportRateMilli;
    assert.equal(await listedRate(), 40, 'the list serves the rate too');

    for (const [bad, why] of [
      ['0.0005', /three decimal places/],
      ['-0.010', /cannot be negative/],
      ['1000.001', /at most \$1,000\./],
      ['ten', /must be an amount in dollars/],
    ]) {
      const refused = await patch({ reportRateUsd: bad });
      assert.equal(refused.status, 400, bad);
      const body = await refused.json();
      assert.equal(body.code, 'bad-rate');
      assert.match(body.error, why);
    }
    assert.equal(server.users.getReportRateMilli(server.alice.id), 40, 'refusals changed nothing');

    // Empty goes back to the global rate.
    const cleared = await (await patch({ reportRateUsd: '' })).json();
    assert.equal(cleared.account.reportRateMilli, null);
    assert.equal(await listedRate(), null, 'and the list serves the clear');

    // Made a user again, she keeps the figure (a role change keeps data), and
    // a clear is accepted on any account.
    await patch({ reportRateUsd: '0.030' });
    const back = await (await patch({ role: 'user' })).json();
    assert.equal(back.account.role, 'user');
    assert.equal(back.account.reportRateMilli, 30);
    assert.equal((await patch({ reportRateUsd: null })).status, 200);
    assert.equal(server.users.getReportRateMilli(server.alice.id), null);
  } finally {
    server.close();
  }
});

test('taking the admin role from a configured address works, says it will not last, and sign-in restores it', async () => {
  const server = await serve();
  try {
    // Alice is promoted, then takes the role from the configured admin (only
    // somebody else may: the own-account rule).
    await server.request(server.adminToken, `/${server.alice.id}`, { method: 'PATCH', body: JSON.stringify({ role: 'admin' }) });
    const demoted = await server.request(server.aliceToken, `/${server.admin.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'reporter' }),
    });
    assert.equal(demoted.status, 200);
    const body = await demoted.json();
    assert.equal(body.account.role, 'reporter');
    assert.equal(body.account.configuredAdmin, true);
    // Administrators only, so it may name the setting that decides it.
    assert.match(body.note, /admin@example\.com is named by ADMIN_EMAILS, so it becomes an administrator again/);

    // completeSignIn's promotion, which runs at every sign-in.
    assert.equal(server.users.promoteIfConfiguredAdmin(server.users.getUserById(server.admin.id)), true);
    assert.equal(server.users.getUserById(server.admin.id).role, 'admin');

    // An invite for a configured address says the same: it will be an
    // administrator from its first sign-in, whatever it is created as.
    process.env.ADMIN_EMAILS = 'admin@example.com,second@example.com';
    const invited = await server.request(server.adminToken, '/', {
      method: 'POST',
      body: JSON.stringify({ email: 'second@example.com', role: 'reporter' }),
    });
    assert.equal(invited.status, 201);
    const invite = await invited.json();
    assert.equal(invite.account.role, 'reporter');
    assert.equal(invite.account.configuredAdmin, true);
    assert.match(invite.note, /second@example\.com is named by ADMIN_EMAILS/);

    // Not a configured address: no note.
    const plain = await server.request(server.adminToken, `/${server.alice.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'user' }),
    });
    assert.equal((await plain.json()).note, undefined);
  } finally {
    server.close();
  }
});

test('a row named by the SMTP_USER fallback says SMTP_USER, as the note does - never an empty ADMIN_EMAILS', async () => {
  const server = await serve();
  try {
    // An install that signs in by email and names no ADMIN_EMAILS: its
    // operator is SMTP_USER's address (config/adminIdentity.ts).
    delete process.env.ADMIN_EMAILS;
    process.env.SMTP_USER = 'admin@example.com';

    const list = await (await server.request(server.adminToken, '/')).json();
    const adminRow = list.accounts.find((account) => account.id === server.admin.id);
    assert.equal(adminRow.configuredAdmin, true);
    assert.equal(adminRow.configuredAdminSource, 'SMTP_USER');
    assert.equal(list.accounts.find((account) => account.id === server.alice.id).configuredAdminSource, null);

    // The demotion's note and the row it answers with agree on the setting.
    await server.request(server.adminToken, `/${server.alice.id}`, { method: 'PATCH', body: JSON.stringify({ role: 'admin' }) });
    const demoted = await server.request(server.aliceToken, `/${server.admin.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'reporter' }),
    });
    assert.equal(demoted.status, 200);
    const body = await demoted.json();
    assert.equal(body.account.configuredAdminSource, 'SMTP_USER');
    assert.match(body.note, /admin@example\.com is named by SMTP_USER, so it becomes an administrator again/);
    assert.doesNotMatch(body.note, /ADMIN_EMAILS/);

    // Once ADMIN_EMAILS names anybody, it alone decides: SMTP_USER's address
    // is configured no longer.
    process.env.ADMIN_EMAILS = 'alice@example.com';
    const after = await (await server.request(server.aliceToken, '/')).json();
    assert.equal(after.accounts.find((account) => account.id === server.admin.id).configuredAdminSource, null);
    assert.equal(after.accounts.find((account) => account.id === server.alice.id).configuredAdminSource, 'ADMIN_EMAILS');
  } finally {
    delete process.env.SMTP_USER;
    delete process.env.ADMIN_EMAILS;
    server.close();
  }
});

/**
 * `users` exactly as the build before reporters created it (ed39205): no
 * `report_rate_milli`. Frozen here on purpose - the point is a database this
 * build did not make, which only addMissingColumns brings up to date.
 */
const PRE_REPORTER_USERS = `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    picture       TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'user',
    subscription  TEXT NOT NULL DEFAULT 'default',
    credits       INTEGER NOT NULL DEFAULT 0,
    balance_milli INTEGER NOT NULL DEFAULT 0,
    google_sub    TEXT,
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    last_login_at TEXT,
    sheet_id       TEXT,
    sheet_url      TEXT,
    sheet_tab_date TEXT,
    sheet_tab_gid  TEXT,
    sheet_shared_at TEXT,
    notifications_seen_at TEXT,
    stripe_customer_id TEXT
  );
`;

test('a database from before reporters gains the rate column on boot, and Accounts lists and sets it', async () => {
  // Every query of the rate names users.report_rate_milli, and a fresh
  // database has it from CREATE TABLE - so without addMissingColumns' entry
  // only an UPGRADED install would find out, as a 500 on every Accounts load.
  const path = require('node:path');
  const Database = require('better-sqlite3');
  const { dbDir } = useTempStorage(`account-routes-upgrade-${Math.random().toString(36).slice(2)}`);
  useAdminEmails('admin@example.com');
  const old = new Database(path.join(dbDir, 'free_tailor.db'));
  try {
    old.exec(PRE_REPORTER_USERS);
    const insert = old.prepare(
      `INSERT INTO users (id, email, role, created_at, updated_at)
       VALUES (?, ?, ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`
    );
    insert.run('u-admin', 'admin@example.com', 'admin');
    insert.run('u-alice', 'alice@example.com', 'user');
  } finally {
    old.close();
  }

  const express = require('express');
  const db = loadFresh('../dist/database/sqlite').getDb();
  const columns = db.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
  assert.ok(columns.includes('report_rate_milli'), columns.join(', '));

  const users = loadFresh('../dist/database/userRepository');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const routes = loadFresh('../dist/routes/accounts');
  // Every account that was there reads as "the global rate".
  assert.deepEqual([...users.listReportRates()].sort(), [['u-admin', null], ['u-alice', null]]);

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/admin/accounts', routes.default);
  const server = app.listen(0);
  const token = users.createSession('u-admin');
  const call = (route, init = {}) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/admin/accounts${route}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    });
  try {
    const listed = await call('/');
    assert.equal(listed.status, 200);
    const { accounts } = await listed.json();
    assert.deepEqual(
      accounts.map((account) => [account.id, account.reportRateMilli]).sort(),
      [['u-admin', null], ['u-alice', null]]
    );

    const made = await call('/u-alice', { method: 'PATCH', body: JSON.stringify({ role: 'reporter', reportRateUsd: '0.050' }) });
    assert.equal(made.status, 200);
    const { account } = await made.json();
    assert.equal(account.role, 'reporter');
    assert.equal(account.reportRateMilli, 50);
    assert.equal(users.getReportRateMilli('u-alice'), 50);
  } finally {
    server.close();
  }
});

test('a payout is recorded for a reporter as a deduction with a note, never above the balance', async () => {
  const server = await serve();
  try {
    const { findInconsistentBalances } = require('../dist/services/credits');
    const payout = (id, body, token = server.adminToken) =>
      server.request(token, `/${id}/payout`, { method: 'POST', body: JSON.stringify(body) });

    // Not a reporter: refused, whatever the balance.
    await server.request(server.adminToken, `/${server.alice.id}/credits`, {
      method: 'POST',
      body: JSON.stringify({ amountUsd: '5' }),
    });
    const onUser = await payout(server.alice.id, { amountUsd: '1', note: 'Bank transfer' });
    assert.equal(onUser.status, 409);
    assert.equal((await onUser.json()).code, 'not-a-reporter');
    assert.equal(server.users.getUserById(server.alice.id).balanceMilli, 5_000);

    await server.request(server.adminToken, `/${server.alice.id}`, { method: 'PATCH', body: JSON.stringify({ role: 'reporter' }) });

    // Not an administrator: the router's guard, before anything is read.
    assert.equal((await payout(server.alice.id, { amountUsd: '1', note: 'x' }, server.aliceToken)).status, 403);

    for (const [body, status, code, why] of [
      [{ note: 'Bank transfer' }, 400, undefined, /The payout is required/],
      [{ amountUsd: '0', note: 'Bank transfer' }, 400, undefined, /the amount paid/],
      [{ amountUsd: '-1', note: 'Bank transfer' }, 400, undefined, /cannot be negative/],
      [{ amountUsd: '0.0005', note: 'Bank transfer' }, 400, undefined, /three decimal places/],
      [{ amountUsd: '1' }, 400, 'note-required', /how it was paid/],
      [{ amountUsd: '1', note: '   ' }, 400, 'note-required', /how it was paid/],
      [{ amountUsd: '1', note: 'x'.repeat(501) }, 400, 'note-too-long', /under 500/],
      [{ amountUsd: '1', note: 'ok', requestId: 'short' }, 400, 'bad-request-id', /request id/],
      // A page still sending an amount in credits.
      [{ amount: 1, note: 'Bank transfer' }, 400, 'stale-page', /older version/],
      [{ amountUsd: '5.001', note: 'Bank transfer' }, 409, 'insufficient-balance', /more than this reporter's balance of \$5\. /],
    ]) {
      const refused = await payout(server.alice.id, body);
      assert.equal(refused.status, status, JSON.stringify(body));
      const answer = await refused.json();
      if (code) assert.equal(answer.code, code, JSON.stringify(body));
      assert.match(answer.error, why, JSON.stringify(body));
      if (code === 'insufficient-balance') assert.equal(answer.balanceMilli, 5_000);
    }
    assert.equal(server.users.getUserById(server.alice.id).balanceMilli, 5_000, 'no refusal moved anything');

    const paid = await payout(server.alice.id, {
      amountUsd: '2.5',
      note: 'Bank transfer, 2026-10-01, ref 4471',
      requestId: 'payout-0001-aaaa',
    });
    assert.equal(paid.status, 201);
    const first = await paid.json();
    assert.equal(first.recorded, true);
    assert.equal(first.balanceMilli, 2_500);
    assert.equal(first.account.balanceMilli, 2_500);
    assert.equal(first.entry.reason, 'reporter-payout');
    assert.equal(first.entry.deltaMilli, -2_500);
    assert.equal(first.entry.balanceAfterMilli, 2_500);
    assert.equal(first.entry.note, 'Bank transfer, 2026-10-01, ref 4471');
    assert.equal(first.entry.actorId, server.admin.id);
    assert.equal(first.entry.legacyCredits, null);

    // The same page's id again - a double press, a retry - records nothing more.
    const repeat = await payout(server.alice.id, {
      amountUsd: '2.5',
      note: 'Bank transfer, 2026-10-01, ref 4471',
      requestId: 'payout-0001-aaaa',
    });
    assert.equal(repeat.status, 200);
    const second = await repeat.json();
    assert.equal(second.recorded, false);
    assert.equal(second.balanceMilli, 2_500);
    assert.equal(second.entry.id, first.entry.id);

    // Exactly the balance is fine; a fresh id is a fresh payout.
    const rest = await payout(server.alice.id, { amountUsd: 2.5, note: 'Second transfer' });
    assert.equal(rest.status, 201);
    assert.equal((await rest.json()).balanceMilli, 0);
    const empty = await payout(server.alice.id, { amountUsd: '0.001', note: 'One more' });
    assert.equal(empty.status, 409);
    assert.equal((await empty.json()).code, 'insufficient-balance');

    const history = await (await server.request(server.adminToken, `/${server.alice.id}/credits`)).json();
    assert.deepEqual(
      history.entries.filter((entry) => entry.reason === 'reporter-payout').map((entry) => entry.deltaMilli),
      [-2_500, -2_500]
    );
    // The ledger still sums to the balance it caches.
    assert.deepEqual(findInconsistentBalances(), []);

    // Each recorded payout - and only those, not the repeat - told the
    // reporter, in a notice nobody else reads.
    const { listNotificationsFor } = require('../dist/database/notificationRepository');
    const notices = listNotificationsFor(server.alice.id).filter((notice) => notice.title.startsWith('Payout recorded'));
    assert.equal(notices.length, 2);
    assert.equal(notices.every((notice) => notice.recipientId === server.alice.id && notice.link === '/credits'), true);
    assert.ok(notices.some((notice) => /payout of \$2\.5 to you: Bank transfer, 2026-10-01, ref 4471\. Your balance is now \$2\.5\./.test(notice.body)));
    assert.equal(listNotificationsFor(server.admin.id).some((notice) => notice.title.startsWith('Payout recorded')), false);
  } finally {
    server.close();
  }
});
