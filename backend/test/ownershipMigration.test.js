const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage } = require('./helpers');

/**
 * Adopting the data that predates accounts.
 *
 * The awkward shape here is that the migration needs something that does not
 * exist yet at the moment migrations normally run: an admin. On a fresh install
 * the database is opened - and migrated - long before anybody signs in. So this
 * step DEFERS rather than completing, and the first admin sign-in runs it.
 */

function legacyProfile(id, name) {
  const { buildNewProfile } = require('../dist/services/profileService');
  // No ownerId: exactly what every row written before v2 looks like.
  return buildNewProfile(
    {
      name,
      title: 'Engineer',
      skills: ['C#'],
      contact: { email: 'a@b.c', phone: '1', location: 'X' },
      summary: 's',
      experience: [],
      strengths: [],
      education: [],
    },
    id
  );
}

test('the migration waits rather than failing when there is no admin yet', () => {
  useTempStorage('ownership-defer');
  const profiles = loadFresh('../dist/database/profileRepository');
  const { migrate003 } = loadFresh('../dist/database/migrations/003_assign_owners');
  const { getDb } = loadFresh('../dist/database/sqlite');

  profiles.saveProfile(legacyProfile('p-old', 'Legacy'));

  const report = migrate003(getDb());
  assert.equal(report.deferred, true, 'nothing to hand the rows to yet');
  assert.equal(report.ran, false);
  assert.equal(report.profiles, 0);
});

test('a deferred step does not record its version, so it runs again', () => {
  useTempStorage('ownership-retry');
  const profiles = loadFresh('../dist/database/profileRepository');
  const { getDb } = loadFresh('../dist/database/sqlite');
  const { runDataMigrations, OWNERSHIP_SCHEMA_VERSION } = loadFresh('../dist/database/migrations');

  profiles.saveProfile(legacyProfile('p-old', 'Legacy'));

  const db = getDb();
  runDataMigrations(db);

  const version = db.prepare("SELECT value FROM schema_meta WHERE key = 'provider_schema_version'").get();
  // Below the ownership version, which is what brings the step back on the
  // next run instead of marking a job it never did as done.
  assert.ok(Number(version.value) < OWNERSHIP_SCHEMA_VERSION);
});

test('the first admin adopts every unowned profile and group', () => {
  useTempStorage('ownership-adopt');
  const users = loadFresh('../dist/database/userRepository');
  const profiles = loadFresh('../dist/database/profileRepository');
  const groups = loadFresh('../dist/database/groupRepository');

  profiles.saveProfile(legacyProfile('p1', 'One'));
  profiles.saveProfile(legacyProfile('p2', 'Two'));
  const stamp = new Date().toISOString();
  groups.saveGroup({ id: 'g1', name: 'Legacy group', profileIds: ['p1'], createdAt: stamp, updatedAt: stamp });

  const admin = users.createUser({ email: 'admin@example.com' });

  // A fresh connection is what a restart looks like, and opening one is what
  // runs the deferred step. Asserting through this rather than by calling the
  // migration directly is the point: it is the path a real boot takes.
  loadFresh('../dist/database/sqlite').getDb();

  assert.deepEqual(profiles.listProfilesFor(admin).map((p) => p.id).sort(), ['p1', 'p2']);
  assert.deepEqual(groups.listGroupsFor(admin).map((g) => g.id), ['g1']);
});

test('adoption touches only the unowned rows, and running it twice changes nothing', () => {
  useTempStorage('ownership-idempotent');
  const users = loadFresh('../dist/database/userRepository');
  const profiles = loadFresh('../dist/database/profileRepository');

  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });

  profiles.saveProfile(legacyProfile('p-old', 'Legacy'));
  profiles.saveProfile({ ...legacyProfile('p-alice', 'Alice CV'), ownerId: alice.id });

  const sqlite = loadFresh('../dist/database/sqlite');
  const db = sqlite.getDb();
  const { migrate003 } = loadFresh('../dist/database/migrations/003_assign_owners');

  const first = migrate003(db);
  assert.equal(first.profiles, 1, 'only the unowned row moved');

  // A second run must find nothing rather than sweeping up rows that now have
  // owners - otherwise every boot would re-home whatever the last one did.
  const again = migrate003(db);
  assert.equal(again.profiles, 0);
  assert.equal(again.ran, false);

  // Alice keeps hers. A migration that took owned rows too would silently
  // transfer everybody's profiles to the admin.
  assert.deepEqual(profiles.listProfilesFor(alice).map((p) => p.id), ['p-alice']);
  assert.deepEqual(profiles.listProfilesFor(admin).map((p) => p.id), ['p-old']);
});

test('signing in as the first admin adopts the old data without waiting for a restart', () => {
  useTempStorage('ownership-on-signin');
  const profiles = loadFresh('../dist/database/profileRepository');
  const users = loadFresh('../dist/database/userRepository');

  profiles.saveProfile(legacyProfile('p-old', 'Legacy'));

  const admin = users.createUser({ email: 'admin@example.com' });

  // What the sign-in path does, on the connection that is already open.
  // Waiting for the next restart could mean weeks on a long-running server.
  const { runDataMigrations } = require('../dist/database/migrations');
  runDataMigrations(require('../dist/database/sqlite').getDb());

  assert.deepEqual(profiles.listProfilesFor(admin).map((p) => p.id), ['p-old']);
});
