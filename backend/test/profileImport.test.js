const assert = require('node:assert/strict');
const test = require('node:test');

const { useTempStorage } = require('./helpers');

/**
 * Importing profiles from an uploaded JSON file.
 *
 * The thing under test is the GATE. profileService normalizes whatever it is
 * handed and never throws, which is right for the admin form and wrong for a
 * file someone picked out of a downloads folder: without a gate, a package.json
 * becomes a profile. So most of what follows is about what gets refused, and
 * about ids - an import must never overwrite a profile that is already here.
 */

const {
  buildImportedProfiles,
  readProfileImportDocument,
  ProfileImportError,
  MAX_PROFILES_PER_IMPORT,
} = require('../dist/services/profileImport');

/** A profile as `GET /api/profiles/:id` hands it out. */
function exportedProfile(overrides = {}) {
  return {
    id: 'profile-alice',
    name: 'Alice Nguyen',
    title: 'Staff Engineer',
    contact: { phone: '555-0100', email: 'alice@example.com', location: 'Remote' },
    summary: 'Builds things.',
    experience: [
      {
        title: 'Staff Engineer',
        company: 'Acme',
        startDate: '01/2022',
        endDate: 'Present',
        location: 'Remote',
        description: 'Led the platform team.',
        achievements: ['Cut deploy time in half.'],
        skills: ['TypeScript'],
      },
    ],
    strengths: [],
    skills: ['TypeScript', 'SQL'],
    education: [],
    certifications: [],
    createdAt: '2025-03-04T10:00:00.000Z',
    updatedAt: '2025-03-04T10:00:00.000Z',
    ...overrides,
  };
}

/** Ids nothing has claimed, and a counter so each minted one is distinct. */
function emptyStore() {
  let next = 0;
  return { idExists: () => false, newId: () => `generated-${++next}` };
}

test('the three shapes a profile file actually comes in are all accepted', () => {
  const one = exportedProfile();
  const two = exportedProfile({ id: 'profile-bo', name: 'Bo Chen' });

  // A single profile, as exported from the API.
  assert.deepEqual(readProfileImportDocument(one), [one]);
  // A bare list of them.
  assert.deepEqual(readProfileImportDocument([one, two]), [one, two]);
  // And the wrapper an export of several would have.
  assert.deepEqual(readProfileImportDocument({ profiles: [one, two] }), [one, two]);
});

test('a file that is not a profile is refused, and says which entry', () => {
  const store = emptyStore();
  const reject = (document, pattern) =>
    assert.throws(() => buildImportedProfiles(document, store), pattern);

  reject('just a string', /not a profile/i);
  reject(42, /not a profile/i);
  reject(null, /not a profile/i);
  reject([], /no profiles in it/i);
  reject({ profiles: [] }, /no profiles in it/i);
  reject([exportedProfile(), 'nope'], /Profile 2 of 2 is not a JSON object/);

  // The case the gate exists for: a JSON file with a name and nothing else.
  // Without it this saves cleanly as an empty profile called "my-app".
  reject(
    { name: 'my-app', version: '1.0.0', dependencies: {} },
    /none of the fields a profile is made of/i
  );

  // And a profile-shaped object with no name, which would otherwise import as
  // "Untitled Profile" - valid, saved, and useless.
  reject({ title: 'Staff Engineer', summary: 'Builds things.' }, /has no "name"/);
});

test('nothing is imported when one entry in the middle is bad', () => {
  const store = emptyStore();
  assert.throws(
    () =>
      buildImportedProfiles(
        [exportedProfile(), { name: 'no fields' }, exportedProfile({ id: 'profile-bo', name: 'Bo' })],
        store
      ),
    /Profile 2 of 3/
  );
});

test('a free id is kept and a taken one is replaced, never overwritten', () => {
  let next = 0;
  const taken = new Set(['profile-alice']);
  const store = { idExists: (id) => taken.has(id), newId: () => `generated-${++next}` };

  // Restoring into an install that already has this profile makes a copy. The
  // promise is that an import cannot destroy a profile you already had.
  const [copy] = buildImportedProfiles(exportedProfile(), store);
  assert.equal(copy.keptId, false);
  assert.equal(copy.profile.id, 'generated-1');
  assert.equal(copy.profile.name, 'Alice Nguyen');

  // Restoring into an install that does not have it keeps the id, so the
  // groups that reference this profile still resolve.
  const [restored] = buildImportedProfiles(exportedProfile({ id: 'profile-bo' }), store);
  assert.equal(restored.keptId, true);
  assert.equal(restored.profile.id, 'profile-bo');
});

test('a file naming the same id twice does not collapse into one profile', () => {
  const store = emptyStore();
  const imported = buildImportedProfiles(
    [exportedProfile({ name: 'First' }), exportedProfile({ name: 'Second' })],
    store
  );

  assert.equal(imported.length, 2);
  assert.notEqual(imported[0].profile.id, imported[1].profile.id, 'the second entry gets an id of its own');
  assert.deepEqual(imported.map((entry) => entry.profile.name), ['First', 'Second']);
});

test('the profile content survives the round trip', () => {
  const source = exportedProfile();
  const [{ profile }] = buildImportedProfiles(source, emptyStore());

  assert.equal(profile.title, 'Staff Engineer');
  assert.equal(profile.contact.email, 'alice@example.com');
  assert.equal(profile.summary, 'Builds things.');
  assert.deepEqual(profile.skills, ['TypeScript', 'SQL']);
  assert.equal(profile.experience.length, 1);
  assert.deepEqual(profile.experience[0].achievements, ['Cut deploy time in half.']);

  // The profile's own history is a fact about the profile and survives;
  // updatedAt does not, because this row was written just now.
  assert.equal(profile.createdAt, '2025-03-04T10:00:00.000Z');
  assert.notEqual(profile.updatedAt, '2025-03-04T10:00:00.000Z');

  // Settings a file omits come back as the defaults rather than as undefined,
  // so an imported profile is usable without being opened and saved first.
  assert.equal(profile.profileSettings.resumePromptId, 'tailor-resume');
  assert.equal(profile.profileSettings.hardSkillOrdering, 'library');
});

test('a nonsense createdAt is ignored rather than stored', () => {
  const [{ profile }] = buildImportedProfiles(
    exportedProfile({ createdAt: 'last Tuesday' }),
    emptyStore()
  );
  assert.ok(!Number.isNaN(Date.parse(profile.createdAt)));
});

test('an oversized file is refused before anything is built', () => {
  const many = Array.from({ length: MAX_PROFILES_PER_IMPORT + 1 }, (_, index) =>
    exportedProfile({ id: `profile-${index}`, name: `Person ${index}` })
  );
  assert.throws(() => buildImportedProfiles(many, emptyStore()), /is the most one import may carry/);
});

test('the error type is the one the route maps to a 400', () => {
  assert.throws(() => buildImportedProfiles('nope', emptyStore()), ProfileImportError);
});

test('an import lands in the database whole, or not at all', () => {
  useTempStorage('profile-import-store');
  const repository = require('../dist/database/profileRepository');

  const saved = repository.saveProfiles(
    buildImportedProfiles(
      [exportedProfile(), exportedProfile({ id: 'profile-bo', name: 'Bo Chen' })],
      { idExists: repository.hasProfile, newId: () => `generated-${Math.random()}` }
    ).map((entry) => entry.profile)
  );

  assert.equal(saved.length, 2);
  const stored = repository.listProfiles({ includeDisabled: true });
  assert.deepEqual(stored.map((profile) => profile.name).sort(), ['Alice Nguyen', 'Bo Chen']);

  // A batch that cannot be written leaves the table exactly as it was. The
  // second row is made unserializable to force the failure - a synthetic
  // cause, but the path it takes is the real one: a save throws partway
  // through the batch, and the rows before it must not survive.
  const unserializable = exportedProfile({ id: 'profile-dee', name: 'Dee' });
  unserializable.self = unserializable;

  assert.throws(() =>
    repository.saveProfiles([exportedProfile({ id: 'profile-cy', name: 'Cy' }), unserializable])
  );
  assert.equal(repository.listProfiles({ includeDisabled: true }).length, 2, 'the failed batch wrote nothing');
  assert.equal(repository.hasProfile('profile-cy'), false, 'the row before the failure was rolled back');
});

test('an uploaded profile may group its skills, or not, or both', () => {
  // The point of the upload is to save hand-editing a file. Accepting only one
  // of these shapes would mean rewriting the other three by hand first.
  const opts = { idExists: () => false, newId: () => 'gen' };
  const only = (document) => buildImportedProfiles(document, opts)[0].profile;

  const flat = only({ name: 'A', skills: ['C#', 'Python'] });
  assert.deepEqual(flat.skills, ['C#', 'Python']);
  assert.equal(flat.skillCategories, undefined);

  const map = only({ name: 'A', skills: { Languages: ['C#'], Cloud: ['Vault'] } });
  assert.deepEqual(map.skills, ['C#', 'Vault']);
  assert.deepEqual(map.skillCategories, [
    { category: 'Languages', skills: ['C#'] },
    { category: 'Cloud', skills: ['Vault'] },
  ]);

  const grouped = only({ name: 'A', skills: [{ category: 'Languages', skills: ['C#'] }] });
  assert.deepEqual(grouped.skillCategories, [{ category: 'Languages', skills: ['C#'] }]);

  // A file whose ONLY skills field is the grouped one still has to read as a
  // profile - the probe list decides that, and it had never heard of this field.
  const separate = only({ name: 'A', skillCategories: [{ category: 'Languages', skills: ['C#'] }] });
  assert.deepEqual(separate.skills, ['C#']);
  assert.deepEqual(separate.skillCategories, [{ category: 'Languages', skills: ['C#'] }]);
});

test('a profile file still has to be a profile', () => {
  // Adding a field to the probe list must not turn the gate off: a package.json
  // has a name and nothing else, and became an empty profile called "my-app".
  assert.throws(
    () =>
      buildImportedProfiles(
        { name: 'my-app', version: '1.0.0', dependencies: {} },
        { idExists: () => false, newId: () => 'gen' }
      ),
    /none of the fields a profile is made of/
  );
});
