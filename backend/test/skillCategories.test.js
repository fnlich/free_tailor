const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeProfilePayload,
  normalizeSkillsInput,
  getProfileTechnicalSkillsLayout,
} = require('../dist/services/profileService');

/**
 * Skills as people actually write them, and as the resume renders them.
 *
 * Two halves that have to agree. A profile may CARRY its skills grouped, and it
 * may RENDER them grouped - and those are separate decisions: someone who took
 * the trouble to sort their skills into headings can still want a flat list on
 * a one-page resume, and must get their grouping back when they switch away
 * from it.
 */

test('skills are read in every shape a real file writes them in', () => {
  // Refusing three of these would mean editing the file by hand before an
  // import whose whole purpose is to save exactly that work.
  const flat = normalizeSkillsInput(['C#', 'Python']);
  assert.deepEqual(flat.skills, ['C#', 'Python']);
  assert.deepEqual(flat.categories, [], 'a plain list claims no grouping');

  const map = normalizeSkillsInput({ Languages: ['C#'], 'Cloud and Infrastructure': ['Vault'] });
  assert.deepEqual(map.skills, ['C#', 'Vault']);
  assert.deepEqual(map.categories, [
    { category: 'Languages', skills: ['C#'] },
    { category: 'Cloud and Infrastructure', skills: ['Vault'] },
  ]);

  const groups = normalizeSkillsInput([{ category: 'Languages', skills: ['C#', 'Python'] }]);
  assert.deepEqual(groups.categories, [{ category: 'Languages', skills: ['C#', 'Python'] }]);

  // What a half-edited file looks like, and what the admin form produces while
  // somebody is in the middle of grouping a list they pasted.
  const mixed = normalizeSkillsInput(['Rust', { category: 'Languages', skills: ['C#'] }]);
  assert.deepEqual(mixed.skills.sort(), ['C#', 'Rust']);
  assert.deepEqual(mixed.categories, [{ category: 'Languages', skills: ['C#'] }]);
});

test('the names other resume tools export a group under are understood', () => {
  const named = normalizeSkillsInput([{ name: 'Frameworks', items: ['Rails', 'Angular'] }]);
  assert.deepEqual(named.categories, [{ category: 'Frameworks', skills: ['Rails', 'Angular'] }]);
});

test('a category written twice is extended, not replaced', () => {
  // What a file assembled from two sources looks like. Replacing would lose the
  // earlier half of it with nothing to say so.
  const merged = normalizeSkillsInput([
    { category: 'Languages', skills: ['C#'] },
    { category: 'languages', skills: ['Go'] },
  ]);
  assert.deepEqual(merged.categories, [{ category: 'Languages', skills: ['C#', 'Go'] }]);
});

test('a skill under a blank heading is still a skill', () => {
  // Dropping it would silently lose skills the moment somebody left a heading
  // empty, which is one keystroke away in any editor.
  const orphan = normalizeSkillsInput([{ category: '', skills: ['Vault'] }]);
  assert.deepEqual(orphan.skills, ['Vault']);
  assert.deepEqual(orphan.categories, []);
});

test('every categorized skill is also in the flat list', () => {
  // The invariant the rest of the app leans on. `skills` is what the tailoring
  // prompt is given, so a skill typed only into a category would be rendered on
  // the resume and never reach the model - which would then drop it as
  // unclaimed, and the resume would show a skill the prose never supports.
  const saved = normalizeProfilePayload({
    name: 'A',
    skills: ['Rust'],
    skillCategories: [{ category: 'Languages', skills: ['C#'] }],
  });
  for (const group of saved.skillCategories ?? []) {
    for (const skill of group.skills) {
      assert.ok(saved.skills.includes(skill), `${skill} is categorized but not in skills`);
    }
  }
  assert.ok(saved.skills.includes('Rust'), 'and an uncategorized one survives too');
});

test('a payload naming neither skills field leaves both alone', () => {
  // Omitting a field means "leave it alone" everywhere else in this normalizer.
  // A client that predates categories must not blank them by saving a profile.
  const existing = normalizeProfilePayload({
    name: 'A',
    skills: [{ category: 'Languages', skills: ['C#'] }],
  });
  const after = normalizeProfilePayload({ name: 'A', title: 'Engineer' }, {
    ...existing,
    id: 'p1',
    createdAt: '',
    updatedAt: '',
  });
  assert.deepEqual(after.skills, ['C#']);
  assert.deepEqual(after.skillCategories, [{ category: 'Languages', skills: ['C#'] }]);
});

test('a payload naming a flat list CLEARS the grouping', () => {
  // "My skills are these, in a list" is a complete statement. Keeping a stale
  // grouping around it would put back headings the person just removed.
  const grouped = normalizeProfilePayload({
    name: 'A',
    skills: [{ category: 'Languages', skills: ['C#', 'Python'] }],
  });
  const flattened = normalizeProfilePayload({ name: 'A', skills: ['C#', 'Python'] }, {
    ...grouped,
    id: 'p1',
    createdAt: '',
    updatedAt: '',
  });
  assert.deepEqual(flattened.skills, ['C#', 'Python']);
  assert.equal(flattened.skillCategories, undefined);
});

test('the layout defaults to categories, which is how templates render today', () => {
  assert.equal(getProfileTechnicalSkillsLayout(null), 'categorized');
  assert.equal(getProfileTechnicalSkillsLayout({ profileSettings: {} }), 'categorized');
  assert.equal(
    getProfileTechnicalSkillsLayout({ profileSettings: { technicalSkillsLayout: 'sideways' } }),
    'categorized',
    'a value this build does not understand inherits rather than breaking the render'
  );
  assert.equal(
    getProfileTechnicalSkillsLayout({ profileSettings: { technicalSkillsLayout: 'flat' } }),
    'flat'
  );
});

test('the layout survives a save that does not mention it', () => {
  const saved = normalizeProfilePayload({
    name: 'A',
    profileSettings: { technicalSkillsLayout: 'flat' },
  });
  const after = normalizeProfilePayload({ name: 'A', profileSettings: {} }, {
    ...saved,
    id: 'p1',
    createdAt: '',
    updatedAt: '',
  });
  assert.equal(after.profileSettings.technicalSkillsLayout, 'flat');
});
