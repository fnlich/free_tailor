const assert = require('node:assert/strict');
const test = require('node:test');

/**
 * services/skillGroups.ts: the model's Technical Skills block, read the same
 * way by the tailoring parse and by the render gate. Pure - no library, no
 * database - so nothing here needs storage.
 *
 *   - sanitising makes the shape printable and changes nothing else: no
 *     de-duplication, no re-spelling, no reordering, nothing from the library;
 *   - the soft-skill group is found by its mark, then the drawn heading, then
 *     the last group ONLY when its heading is one of the closed list;
 *   - Plain is every skill once, in the order written.
 */

const {
  sanitizeSkillGroups,
  findSoftSkillGroup,
  flattenSkillGroups,
  SOFT_SKILL_GROUP_HEADINGS,
  MAX_SKILL_GROUPS,
  MAX_SKILLS_PER_GROUP,
} = require('../dist/services/skillGroups');

test('sanitising keeps the groups as written: strings only, trimmed, empties dropped, nothing else changed', () => {
  const groups = sanitizeSkillGroups([
    { category: '  CI/CD   &  Automation ', skills: [' GitHub Actions ', 'Argo   CD', '', 7, null, 'GitHub Actions', 'zsh'] },
    { category: 'Empty', skills: ['', '   '] },
    { category: 'Not a list', skills: 'Go, Rust' },
    'Languages: Go',
    null,
    ['Go'],
    { skills: ['Honeycomb'] },
    { category: 'Soft', skills: ['Mentoring'], soft: true },
    { category: 'Truthy', skills: ['Ownership'], soft: 'yes' },
  ]);
  assert.deepEqual(groups, [
    // A repeat inside a group is the model's to keep; only Plain removes repeats.
    { category: 'CI/CD & Automation', skills: ['GitHub Actions', 'Argo CD', 'GitHub Actions', 'zsh'] },
    { category: '', skills: ['Honeycomb'] },
    { category: 'Soft', skills: ['Mentoring'], soft: true },
    { category: 'Truthy', skills: ['Ownership'] },
  ]);

  for (const nothing of [undefined, null, 'x', 42, {}, { skillGroups: [] }]) {
    assert.deepEqual(sanitizeSkillGroups(nothing), []);
  }
});

test('sanitising holds a runaway block to a safety bound, never a style rule', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    category: `Group ${i}`,
    skills: Array.from({ length: 60 }, (_, j) => `Skill ${i}.${j}`),
  }));
  const groups = sanitizeSkillGroups(many);
  assert.equal(groups.length, MAX_SKILL_GROUPS);
  assert.ok(groups.every((group) => group.skills.length === MAX_SKILLS_PER_GROUP));
  assert.equal(groups[0].skills[0], 'Skill 0.0', 'the first ones, in order');
  // The prompt asks for 4-7 groups of 4-10: well inside the bound.
  assert.ok(MAX_SKILL_GROUPS >= 7 && MAX_SKILLS_PER_GROUP >= 10);
});

test('the soft-skill group: its mark, then the drawn heading, then the last group only under a known heading', () => {
  const technical = [
    { category: 'Languages', skills: ['Go'] },
    { category: 'Cloud', skills: ['AWS'] },
  ];

  // 1. The mark the parse leaves wins over everything, wherever the group sits.
  assert.equal(
    findSoftSkillGroup([{ category: 'Renamed by hand', skills: ['Mentoring'], soft: true }, ...technical], 'Soft Skills'),
    0
  );
  // 2. The heading drawn for this resume, case-insensitively.
  assert.equal(findSoftSkillGroup([...technical, { category: 'working style', skills: ['Ownership'] }], 'Working Style'), 2);
  assert.equal(
    findSoftSkillGroup([{ category: 'Interpersonal Skills', skills: ['Mentoring'] }, ...technical], 'Interpersonal Skills'),
    0,
    'the drawn heading is found wherever the group sits'
  );
  // 3. The last group, under a heading from the closed list, when the drawn one was not followed.
  assert.equal(findSoftSkillGroup([...technical, { category: 'Core Competencies', skills: ['Mentoring'] }], 'Soft Skills'), 2);
  assert.equal(findSoftSkillGroup([...technical, { category: 'Soft Skills', skills: ['Mentoring'] }]), 2);

  // Never a technical group because it happens to be last.
  assert.equal(findSoftSkillGroup(technical, 'Soft Skills'), -1);
  assert.equal(findSoftSkillGroup([...technical, { category: 'Monitoring', skills: ['Grafana'] }]), -1);
  // A known heading that is NOT last is not the soft group either, unless it is the drawn one.
  assert.equal(findSoftSkillGroup([{ category: 'Soft Skills', skills: ['Mentoring'] }, ...technical], 'Working Style'), -1);
  assert.equal(findSoftSkillGroup([], 'Soft Skills'), -1);
});

test('the closed heading list is the one the tailoring draw uses', () => {
  assert.deepEqual([...SOFT_SKILL_GROUP_HEADINGS], [
    'Soft Skills',
    'Professional Skills',
    'Interpersonal Skills',
    'Collaboration & Communication',
    'Working Style',
    'Core Competencies',
  ]);
});

test('Plain is every skill once, in the order written', () => {
  assert.deepEqual(
    flattenSkillGroups([
      { category: 'Languages', skills: ['Go', 'Python', 'TypeScript'] },
      { category: 'Automation', skills: ['python', 'GitHub Actions', 'Go'] },
      { category: 'Data', skills: ['PostgreSQL', 'GitHub actions'] },
    ]),
    ['Go', 'Python', 'TypeScript', 'GitHub Actions', 'PostgreSQL'],
    'a repeat in any case keeps the spelling where it first appears'
  );
  assert.deepEqual(flattenSkillGroups([]), []);
});
