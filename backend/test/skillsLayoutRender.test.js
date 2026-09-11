const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { prepareResumeRenderData, generatePreviewHTML } = require('../dist/generators/pdfGenerator');

const TEMPLATES_DIR = path.join(__dirname, '..', 'static', 'templates');

function templateNamed(id) {
  return JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, `${id}.json`), 'utf8'));
}

function profile(extra = {}) {
  return {
    id: 'p1',
    name: 'A Person',
    title: 'Engineer',
    contact: { email: 'a@b.c', phone: '1', location: 'X' },
    summary: 'A summary.',
    experience: [],
    strengths: [],
    education: [],
    certifications: [],
    skills: ['C#', 'Python', 'C', 'Angular', 'Vault', 'Azure', 'Keras'],
    createdAt: '',
    updatedAt: '',
    ...extra,
  };
}

test('the flat layout renders skill names, not headings', () => {
  const data = prepareResumeRenderData(profile({ profileSettings: { technicalSkillsLayout: 'flat' } }));
  assert.equal(data.skillCategories.length, 1, 'one group, so every template keeps its single loop');
  assert.equal(data.skillCategories[0].category, '', 'and that group has no heading');

  // One entry per skill, not one entry holding the whole list behind a colon.
  // A template that renders a chip per entry has to produce a chip per SKILL.
  assert.deepEqual(data.hardSkills, data.skillCategories[0].skills);
  for (const line of data.hardSkills) {
    assert.doesNotMatch(line, /:/, `"${line}" still carries a heading`);
  }
});

test('the flat layout does not pad the list with skills the profile never claimed', () => {
  // The padding rules exist to make a CATEGORIZED block look right - five per
  // heading, at least five headings. A list with no headings has no such shape
  // to fill, and filling it anyway invents claims on somebody's resume.
  const claimed = profile().skills.map((skill) => skill.toLowerCase());
  const data = prepareResumeRenderData(profile({ profileSettings: { technicalSkillsLayout: 'flat' } }));
  for (const skill of data.skillCategories[0].skills) {
    assert.ok(
      claimed.includes(skill.toLowerCase()),
      `"${skill}" is on the resume but not in the profile`
    );
  }
});

test('the categorized layout is unchanged, and does pad', () => {
  const data = prepareResumeRenderData(profile());
  assert.ok(data.skillCategories.length > 1);
  assert.equal(data.skillCategories[0].category, 'Languages');
  assert.match(data.hardSkills[0], /^Languages: /);
});

test("a profile's own grouping beats the library's guess", () => {
  // The library has no idea that a particular person's Vault is infrastructure
  // rather than a library. Somebody who says so has to be believed.
  const inferred = prepareResumeRenderData(profile());
  const guessed = inferred.skillCategories.find((group) => group.skills.includes('Vault'));
  assert.equal(guessed.category, 'Frameworks and Libraries', 'what the library guesses today');

  const authored = prepareResumeRenderData(
    profile({
      skillCategories: [
        { category: 'Languages', skills: ['C#', 'Python', 'C'] },
        { category: 'Cloud and Infrastructure', skills: ['Vault', 'Azure'] },
      ],
    })
  );
  const placed = authored.skillCategories.find((group) => group.skills.includes('Vault'));
  assert.equal(placed.category, 'Cloud and Infrastructure');
});

test('a skill the author never placed still reaches the resume', () => {
  // Under the library's heading for it, appended after the author's own order -
  // dropping it would mean grouping your skills quietly deleted the ones you
  // had not got round to.
  const data = prepareResumeRenderData(
    profile({ skillCategories: [{ category: 'Languages', skills: ['C#'] }] })
  );
  const all = data.skillCategories.flatMap((group) => group.skills);
  assert.ok(all.includes('Keras'), 'an unplaced skill must not vanish');
  assert.equal(data.skillCategories[0].category, 'Languages', "the author's order leads");
});

test("the author's headings are not padded to a count they never chose", () => {
  // The five-per-heading rule is about making an INFERRED block look full.
  // Applying it to somebody's own headings files skills under headings they
  // did not pick for them.
  const data = prepareResumeRenderData(
    profile({ skillCategories: [{ category: 'Languages', skills: ['C#', 'Python', 'C'] }] })
  );
  const languages = data.skillCategories.find((group) => group.category === 'Languages');
  assert.deepEqual(languages.skills, ['C#', 'Python', 'C']);
});

test('flat wins over a grouping, and the grouping survives it', () => {
  // A rendering choice, not a storage one: switching to flat and back must not
  // lose the headings somebody typed in.
  const stored = profile({
    profileSettings: { technicalSkillsLayout: 'flat' },
    skillCategories: [{ category: 'Languages', skills: ['C#'] }],
  });
  const data = prepareResumeRenderData(stored);
  assert.equal(data.skillCategories.length, 1);
  assert.equal(data.skillCategories[0].category, '');
  assert.deepEqual(
    stored.skillCategories,
    [{ category: 'Languages', skills: ['C#'] }],
    'the profile itself is not rewritten by rendering it'
  );
});

test('every built-in template renders the flat layout without an empty heading', async () => {
  // The flat layout is delivered as one group with an empty heading so that
  // every template keeps the single loop it already has. The cost of that
  // choice is an unguarded heading element rendering as a blank box - which on
  // a resume is a visible empty line and, in several of these, a stray rule.
  const ids = fs
    .readdirSync(TEMPLATES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''));
  assert.ok(ids.length >= 10, 'this must cover the whole set, not a sample');

  for (const id of ids) {
    const html = await generatePreviewHTML(
      profile({ profileSettings: { technicalSkillsLayout: 'flat' } }),
      templateNamed(id)
    );
    const body = html.slice(html.indexOf('</style>'));
    assert.doesNotMatch(
      body,
      /<div class="skill-category-title"[^>]*>\s*<\/div>/,
      `${id} renders an empty category heading`
    );
    // The list-style templates put the heading in a <strong> followed by a
    // <br>. Guard only the <strong> and the break is left behind, opening the
    // list with a blank line - which is what this looked like when the two
    // rewrite rules ran in the wrong order.
    assert.doesNotMatch(body, /<li>\s*<br\s*\/?>/, `${id} opens its skill list with a blank line`);
    assert.doesNotMatch(body, /<strong>\s*<\/strong>/, `${id} renders an empty bold heading`);
    assert.ok(body.includes('C#'), `${id} did not render the skills at all`);
  }
});

test('every built-in template still renders headings when categorized', async () => {
  const ids = fs
    .readdirSync(TEMPLATES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''));

  for (const id of ids) {
    const html = await generatePreviewHTML(profile(), templateNamed(id));
    const body = html.slice(html.indexOf('</style>'));
    assert.ok(body.includes('Languages'), `${id} lost its category headings`);
  }
});
