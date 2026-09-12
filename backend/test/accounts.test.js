const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage } = require('./helpers');

/**
 * Accounts, plans and the profile cap.
 *
 * The claims worth pinning are the ones a mistake would make silently wrong:
 * that the two sign-in paths land on ONE account, that a profile belongs to
 * whoever made it and is invisible to everybody else, that the plan's limit is
 * enforced on every door into the profiles table, and that an admin cannot
 * leave the installation with nobody who can administer it.
 */

function profile(id, name, ownerId) {
  const { buildNewProfile } = require('../dist/services/profileService');
  return {
    ...buildNewProfile(
      {
        name,
        title: 'Engineer',
        skills: ['C#'],
        contact: { email: `${id}@example.com`, phone: '1', location: 'X' },
        summary: 's',
        experience: [],
        strengths: [],
        education: [],
      },
      id
    ),
    ownerId,
  };
}

test('the first account is the admin and every one after it is a user', () => {
  useTempStorage('accounts-first-admin');
  const users = loadFresh('../dist/database/userRepository');

  // Somebody has to be. The admin pages are where accounts are managed and
  // they are admin-only, so an install whose first user was ordinary would
  // have no way to ever appoint one.
  assert.equal(users.createUser({ email: 'first@example.com' }).role, 'admin');
  assert.equal(users.createUser({ email: 'second@example.com' }).role, 'user');
  assert.equal(users.createUser({ email: 'third@example.com' }).role, 'user');
});

test('ADMIN_EMAILS decides instead, when it is set', () => {
  useTempStorage('accounts-admin-emails');
  process.env.ADMIN_EMAILS = 'boss@example.com';
  try {
    const users = loadFresh('../dist/database/userRepository');
    // First in, but not on the list: an ordinary user, and the install waits
    // for the named address rather than handing the keys to whoever is quickest.
    assert.equal(users.createUser({ email: 'early@example.com' }).role, 'user');
    assert.equal(users.createUser({ email: 'BOSS@Example.com' }).role, 'admin');
  } finally {
    delete process.env.ADMIN_EMAILS;
  }
});

test('the two sign-in paths land on one account', () => {
  useTempStorage('accounts-one-identity');
  const users = loadFresh('../dist/database/userRepository');

  const google = users.findOrCreateUser({
    email: 'Same.Person@Example.com',
    name: 'Same Person',
    picture: 'https://example.com/p.png',
    googleSub: 'google-123',
  });
  const code = users.findOrCreateUser({ email: 'same.person@example.com ' });

  assert.equal(code.created, false, 'the second path found the account rather than making one');
  assert.equal(code.account.id, google.account.id);
  // A code sign-in carries no name or picture, and must not blank what Google
  // set - somebody's avatar disappearing because they used the other door
  // would be a bug nobody could explain.
  assert.equal(code.account.name, 'Same Person');
  assert.equal(code.account.picture, 'https://example.com/p.png');
});

test('a profile belongs to whoever made it, and nobody else can see it', () => {
  useTempStorage('accounts-scoping');
  const users = loadFresh('../dist/database/userRepository');
  const profiles = loadFresh('../dist/database/profileRepository');

  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  const bob = users.createUser({ email: 'bob@example.com' });

  profiles.saveProfile(profile('p-alice', 'Alice CV', alice.id));
  profiles.saveProfile(profile('p-bob', 'Bob CV', bob.id));

  assert.deepEqual(profiles.listProfilesFor(alice).map((p) => p.id), ['p-alice']);
  assert.deepEqual(profiles.listProfilesFor(bob).map((p) => p.id), ['p-bob']);

  // Reaching for it by id is the same answer, not a different one: a route
  // that trusted `get` alone would otherwise hand it over.
  assert.equal(profiles.getProfileFor(alice, 'p-bob'), null);
  assert.equal(profiles.getProfileFor(bob, 'p-alice'), null);

  // An admin is an ordinary user by default - the builder showing them
  // everybody's profiles would be unusable - and sees all only when asked.
  assert.deepEqual(profiles.listProfilesFor(admin).map((p) => p.id), []);
  assert.deepEqual(
    profiles.listProfilesFor(admin, { allOwners: true }).map((p) => p.id).sort(),
    ['p-alice', 'p-bob']
  );
  assert.equal(profiles.getProfileFor(admin, 'p-alice')?.id, 'p-alice');
});

test('a row from before accounts existed is admin-only until it is adopted', () => {
  useTempStorage('accounts-unowned');
  const users = loadFresh('../dist/database/userRepository');
  const profiles = loadFresh('../dist/database/profileRepository');

  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  profiles.saveProfile(profile('p-old', 'Legacy CV', undefined));

  // The safe direction. An unowned row shown to everybody would be a leak;
  // shown to nobody it is merely invisible until an admin hands it on.
  assert.deepEqual(profiles.listProfilesFor(alice).map((p) => p.id), []);
  assert.deepEqual(profiles.listProfilesFor(admin, { allOwners: true }).map((p) => p.id), ['p-old']);
});

test('the plan caps how many profiles an account may keep', () => {
  useTempStorage('accounts-plan-cap');
  const users = loadFresh('../dist/database/userRepository');
  const profiles = loadFresh('../dist/database/profileRepository');

  const admin = users.createUser({ email: 'admin@example.com' });
  let alice = users.createUser({ email: 'alice@example.com' });

  // Default: one profile.
  assert.doesNotThrow(() => profiles.assertCanAddProfile(alice));
  profiles.saveProfile(profile('a1', 'One', alice.id));
  assert.throws(() => profiles.assertCanAddProfile(alice), /Default plan allows 1 profile/);

  // A DISABLED profile still occupies its slot. Not counting it would make the
  // limit meaningless the moment somebody worked out that disabling is free.
  profiles.saveProfile({ ...profile('a1', 'One', alice.id), disabled: true });
  assert.throws(() => profiles.assertCanAddProfile(alice), /allows 1 profile/);

  alice = users.updateUser(alice.id, { plan: 'premium' });
  assert.doesNotThrow(() => profiles.assertCanAddProfile(alice));
  // An import is counted whole, so six into a plan with room for four refuses
  // all six rather than landing four and failing.
  assert.throws(() => profiles.assertCanAddProfile(alice, 6), /allows 5 profiles/);
  assert.doesNotThrow(() => profiles.assertCanAddProfile(alice, 4));

  alice = users.updateUser(alice.id, { plan: 'premium-max' });
  assert.doesNotThrow(() => profiles.assertCanAddProfile(alice, 1000), 'Premium Max is unlimited');

  // Admins are exempt: they can already change any account's plan, so a limit
  // on them only gets in the way of fixing somebody else's.
  assert.doesNotThrow(() => profiles.assertCanAddProfile(admin, 1000));
});

test('moving an account down a plan does not take away the profiles it has', () => {
  useTempStorage('accounts-downgrade');
  const users = loadFresh('../dist/database/userRepository');
  const profiles = loadFresh('../dist/database/profileRepository');

  users.createUser({ email: 'admin@example.com' });
  let alice = users.createUser({ email: 'alice@example.com' });
  alice = users.updateUser(alice.id, { plan: 'premium' });
  for (const id of ['a1', 'a2', 'a3']) profiles.saveProfile(profile(id, id, alice.id));

  alice = users.updateUser(alice.id, { plan: 'default' });

  // They keep what they made - losing work because an admin changed a dropdown
  // would be the wrong way round. What they lose is the ability to add.
  assert.equal(profiles.listProfilesFor(alice).length, 3);
  assert.throws(() => profiles.assertCanAddProfile(alice), /allows 1 profile/);
});

test('a plan this build does not know reads as the smallest one', () => {
  useTempStorage('accounts-unknown-plan');
  const users = loadFresh('../dist/database/userRepository');
  const { getDb } = loadFresh('../dist/database/sqlite');

  const account = users.createUser({ email: 'admin@example.com' });
  getDb().prepare('UPDATE users SET plan = ? WHERE id = ?').run('premium-ultra', account.id);

  // Landing small is the safe direction: it can refuse a profile somebody was
  // entitled to, which an admin fixes in a click, where the other direction
  // hands out entitlements nobody granted.
  assert.equal(users.getUserById(account.id).plan, 'default');
});

test('credits start at zero and block nothing', () => {
  useTempStorage('accounts-credits');
  const users = loadFresh('../dist/database/userRepository');
  const profiles = loadFresh('../dist/database/profileRepository');

  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });

  assert.equal(alice.credits, 0);
  // Nothing in this release spends them, so a brand-new account can still work.
  assert.doesNotThrow(() => profiles.assertCanAddProfile(alice));

  assert.equal(users.updateUser(alice.id, { credits: 25 }).credits, 25);
  // A fractional or negative balance has no meaning, and a negative one would
  // read as a debt this app has no way to collect.
  assert.equal(users.updateUser(alice.id, { credits: -5 }).credits, 0);
  assert.equal(users.updateUser(alice.id, { credits: 7.9 }).credits, 7);
});

test('disabling an account ends its sessions at once', () => {
  useTempStorage('accounts-disable');
  const users = loadFresh('../dist/database/userRepository');

  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  const token = users.createSession(alice.id);
  assert.equal(users.resolveSession(token)?.id, alice.id);

  users.updateUser(alice.id, { disabled: true });

  // Immediately, not at the end of the day. Disabling an account is exactly
  // the moment a live session must stop working.
  assert.equal(users.resolveSession(token), null);
});

test('an expired session stops resolving and is cleaned up', () => {
  useTempStorage('accounts-expiry');
  const users = loadFresh('../dist/database/userRepository');

  const account = users.createUser({ email: 'admin@example.com' });
  const token = users.createSession(account.id, -1000);

  assert.equal(users.resolveSession(token), null);
  assert.equal(users.pruneExpiredSessions(), 0, 'resolving already removed the dead row');
});

test('a login code expires, is single-use, and burns after five wrong guesses', () => {
  useTempStorage('accounts-codes');
  const users = loadFresh('../dist/database/userRepository');

  const code = users.generateLoginCode();
  assert.match(code, /^\d{6}$/);

  users.storeLoginCode('a@example.com', code);
  assert.deepEqual(users.consumeLoginCode('a@example.com', code), { ok: true });
  assert.equal(users.consumeLoginCode('a@example.com', code).reason, 'no-code', 'single use');

  users.storeLoginCode('b@example.com', code, -1);
  assert.equal(users.consumeLoginCode('b@example.com', code).reason, 'expired');

  const fresh = users.generateLoginCode();
  users.storeLoginCode('c@example.com', fresh);
  const wrong = fresh === '000000' ? '111111' : '000000';
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert.equal(users.consumeLoginCode('c@example.com', wrong).reason, 'wrong-code', `guess ${attempt}`);
  }
  // The fifth burns the code rather than merely refusing that guess, so an
  // attacker cannot keep it alive for the full ten minutes.
  assert.equal(users.consumeLoginCode('c@example.com', wrong).reason, 'too-many-attempts');
  assert.equal(users.consumeLoginCode('c@example.com', fresh).reason, 'no-code');
});

test('asking for a code again replaces the last one rather than adding to it', () => {
  useTempStorage('accounts-code-replace');
  const users = loadFresh('../dist/database/userRepository');

  const first = users.generateLoginCode();
  const second = first === '000000' ? '111111' : '000000';
  users.storeLoginCode('a@example.com', first);
  users.storeLoginCode('a@example.com', second);

  // Otherwise every "resend" would widen the guess space.
  assert.equal(users.consumeLoginCode('a@example.com', first).reason, 'wrong-code');
  assert.deepEqual(users.consumeLoginCode('a@example.com', second), { ok: true });
});
