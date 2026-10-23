const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { useTempStorage } = require('./helpers');

/**
 * The section catalogue and the section order (config/sectionCatalogue.ts),
 * and the resume fields the new section kinds are stored in.
 *
 *   - the catalogue is pure data with the semantics of the order beside it:
 *     `effectiveSectionOrder` is what the editor shows and the DOCX prints,
 *     `sectionSortKey` what the PDF's reorder sorts by, `cleanSectionOrder`
 *     what a save stores;
 *   - a stored order is exactly what the person arranged: nothing is appended
 *     or filled in, `[]` clears it back to the template's own order, and an
 *     absent one stays absent - the reason an existing resume never moves
 *     until its person drags a card;
 *   - the nine new kinds and the custom sections are lists of entries with the
 *     list normalisers' rules: omitted keeps what is stored, `[]` clears, an
 *     entry with nothing typed into it is dropped, caps hold;
 *   - the preview builder passes every new list and the order through, so the
 *     live preview draws what a save would print;
 *   - the frontend keeps a copy of the catalogue; test/frontendEditorHelpers
 *     .test.js runs both over the same inputs.
 */

useTempStorage('resume-sections');

const sections = require('../dist/config/sectionCatalogue');
const {
  buildNewResume,
  buildPreviewResume,
  buildUpdatedResume,
  getResumeSectionLayout,
  normalizeResumePayload,
} = require('../dist/services/resumeDocument');

const { CLASSIC_SECTION_KINDS, DEFAULT_SECTION_KINDS, EXTRA_SECTION_KINDS, SECTION_KIND_IDS } = sections;

const presence = (kinds = [], customKeys = []) => ({ kinds, customKeys });

/* -------------------------------------------------------------- catalogue */

test('the catalogue: fifteen kinds in canonical order, the classic six first in the DOCX order, ids = fields', () => {
  assert.deepEqual(SECTION_KIND_IDS, [
    'summary',
    'strengths',
    'skills',
    'softSkills',
    'experience',
    'education',
    'certifications',
    'projects',
    'volunteering',
    'awards',
    'publications',
    'courses',
    'languages',
    'interests',
    'references',
  ]);
  assert.deepEqual(CLASSIC_SECTION_KINDS, ['summary', 'strengths', 'skills', 'softSkills', 'experience', 'education']);
  assert.deepEqual(DEFAULT_SECTION_KINDS, [...CLASSIC_SECTION_KINDS, 'certifications']);
  assert.deepEqual(EXTRA_SECTION_KINDS, SECTION_KIND_IDS.slice(6));
  for (const kind of sections.SECTION_KINDS) {
    assert.equal(kind.field, kind.id, `${kind.id} reads its own field`);
    assert.equal(kind.isClassic, CLASSIC_SECTION_KINDS.includes(kind.id));
    assert.ok(kind.heading.length > 0);
  }
  assert.deepEqual(
    sections.SECTION_KINDS.filter((kind) => kind.hasBullets).map((kind) => kind.id),
    ['experience', 'projects', 'volunteering'],
    'the three kinds Write with AI serves'
  );
});

test('a section ref is a kind id or custom:<well-formed key>; nothing else, and nothing is trimmed or folded', () => {
  for (const id of SECTION_KIND_IDS) assert.deepEqual(sections.parseSectionRef(id), { kind: id });
  assert.deepEqual(sections.parseSectionRef('custom:cs-1a2b3c4d'), { kind: 'custom', key: 'cs-1a2b3c4d' });
  assert.equal(sections.sectionRefId({ kind: 'custom', key: 'cs-1a2b3c4d' }), 'custom:cs-1a2b3c4d');
  assert.equal(sections.sectionRefId({ kind: 'projects' }), 'projects');
  for (const bad of ['custom:', 'custom:Has Space', 'custom:Has_Caps', `custom:${'a'.repeat(41)}`, 'Custom:x', ' projects', 'Summary', 'bogus', '', 42, null, undefined, ['projects']]) {
    assert.equal(sections.parseSectionRef(bad), null, `${JSON.stringify(bad)} is not a ref`);
  }
  assert.equal(sections.isCustomSectionKey('cs-1a2b3c4d'), true);
  assert.equal(sections.isCustomSectionKey('a'.repeat(40)), true);
  assert.equal(sections.isCustomSectionKey('a'.repeat(41)), false);
  assert.equal(sections.isCustomSectionKey('CS-1'), false);
  assert.equal(sections.isSectionKind('custom'), false);
});

test('presenceOf: a kind is present with content - a non-blank summary, a skill or a group, an entry - and custom keys are read once each', () => {
  assert.deepEqual(sections.presenceOf({}), presence());
  assert.deepEqual(sections.presenceOf({ summary: '   ' }), presence());
  assert.deepEqual(sections.presenceOf({ summary: 'Builds things.' }), presence(['summary']));
  assert.deepEqual(sections.presenceOf({ skills: [], skillCategories: [{ category: 'Cloud', skills: ['AWS'] }] }), presence(['skills']));
  assert.deepEqual(
    sections.presenceOf({
      projects: [{ name: 'P' }],
      interests: ['x'],
      certifications: [],
      languages: 'French',
      customSections: [{ key: 'cs-2' }, { key: 'cs-1' }, { key: 'cs-2' }, { key: 'Bad Key' }, 'junk', null],
    }),
    presence(['projects', 'interests'], ['cs-2', 'cs-1'])
  );
});

test('cleanSectionOrder: the valid refs once each in the order given, custom refs only for an existing key, nothing for a non-list', () => {
  assert.deepEqual(sections.cleanSectionOrder(undefined, []), []);
  assert.deepEqual(sections.cleanSectionOrder('projects', []), []);
  assert.deepEqual(sections.cleanSectionOrder({ 0: 'projects' }, []), []);
  assert.deepEqual(
    sections.cleanSectionOrder(['custom:k2', 'languages', 'projects', 'bogus', 'custom:missing', 'languages', 42, 'custom:k1'], ['k1', 'k2']),
    ['custom:k2', 'languages', 'projects', 'custom:k1']
  );
});

test('sectionSortKey: a listed section keeps its place in the order; an unlisted one follows every listed one in the template\'s own order', () => {
  const stored = ['education', 'summary'];
  assert.equal(sections.sectionSortKey('education', stored, 5), 0);
  assert.equal(sections.sectionSortKey('summary', stored, 0), 1);
  assert.equal(sections.sectionSortKey('skills', stored, 2), 4);
  assert.equal(sections.sectionSortKey('strengths', stored, 1), 3);
  assert.equal(sections.sectionSortKey('anything', [], 3), 3, 'with nothing stored the native order stands');
});

const DEFAULT_NATIVE = ['summary', 'experience', 'strengths', 'skills', 'softSkills', 'education', ...EXTRA_SECTION_KINDS];

test('effectiveSectionOrder with nothing stored: the template\'s own order, filtered to the default kinds and the kinds with content', () => {
  // The default kinds show whether or not they have content; a non-default
  // kind only once it has an entry; the custom sections last.
  assert.deepEqual(
    sections.effectiveSectionOrder(undefined, DEFAULT_NATIVE, presence(['projects'], ['cs-1'])),
    ['summary', 'experience', 'strengths', 'skills', 'softSkills', 'education', 'certifications', 'projects', 'custom:cs-1']
  );
  // [] and a stored list that cleans to nothing read the same as absent.
  assert.deepEqual(sections.effectiveSectionOrder([], DEFAULT_NATIVE, presence()), DEFAULT_SECTION_KINDS.slice().sort(
    (a, b) => DEFAULT_NATIVE.indexOf(a) - DEFAULT_NATIVE.indexOf(b)
  ));
  assert.deepEqual(sections.effectiveSectionOrder(['bogus'], DEFAULT_NATIVE, presence()), sections.effectiveSectionOrder([], DEFAULT_NATIVE, presence()));
  // A template with no macro and no Strengths or Soft Skills: the kinds it
  // does not place follow in canonical order - the default ones always, the
  // others when they have content.
  assert.deepEqual(
    sections.effectiveSectionOrder(undefined, ['summary', 'experience', 'education', 'skills'], presence(['languages', 'certifications'])),
    ['summary', 'experience', 'education', 'skills', 'strengths', 'softSkills', 'certifications', 'languages']
  );
  // Junk and custom refs never come from a template; a repeat shows once.
  assert.deepEqual(
    sections.effectiveSectionOrder(undefined, ['foo', 'custom:x', 'summary', 'summary', 'education'], presence()),
    ['summary', 'education', 'strengths', 'skills', 'softSkills', 'experience', 'certifications']
  );
  // Where there is no template at all the canonical list stands in for it.
  assert.deepEqual(sections.effectiveSectionOrder(undefined, SECTION_KIND_IDS, presence(['awards'])), [...DEFAULT_SECTION_KINDS, 'awards']);
});

test('effectiveSectionOrder with a stored order: that order first, then the unlisted default kinds in the template\'s order, then the unlisted kinds with content, then the custom sections', () => {
  const pres = presence(['projects', 'awards', 'languages'], ['cs-1', 'cs-2']);
  assert.deepEqual(
    sections.effectiveSectionOrder(['education', 'custom:cs-2', 'languages', 'summary'], DEFAULT_NATIVE, pres),
    ['education', 'custom:cs-2', 'languages', 'summary', 'experience', 'strengths', 'skills', 'softSkills', 'certifications', 'projects', 'awards', 'custom:cs-1']
  );
  // A listed kind with no entries stays: an added, empty section.
  assert.deepEqual(
    sections.effectiveSectionOrder(['languages', 'summary'], DEFAULT_NATIVE, presence()),
    ['languages', 'summary', 'experience', 'strengths', 'skills', 'softSkills', 'education', 'certifications']
  );
  // Unknown ids and refs to custom sections that are gone are dropped; the
  // native order is ignored for the listed ones but still orders the rest.
  assert.deepEqual(
    sections.effectiveSectionOrder(['custom:gone', 'projects', 'bogus', 'projects'], ['education', 'summary', 'skills'], presence(['projects'], ['cs-9'])),
    ['projects', 'education', 'summary', 'skills', 'strengths', 'softSkills', 'experience', 'certifications', 'custom:cs-9']
  );
});

/* ------------------------------------------------------------ the resume */

function fullPayload() {
  return {
    name: 'Sam Chen',
    title: 'Engineer',
    projects: [
      {
        name: '  Lakehouse  ',
        role: 'Lead',
        startDate: '01/2023',
        endDate: '06/2023',
        link: 'github.com/sam/lakehouse',
        description: 'A lakehouse.',
        achievements: [' Cut query time by 40% ', '', 7],
      },
      { name: '', role: '', startDate: '', endDate: '', link: '', description: '', achievements: [] },
      'junk',
    ],
    languages: [{ language: 'French', proficiency: 'Fluent' }, { language: '', proficiency: 'Native' }],
    awards: [{ title: 'Best Paper', issuer: 'ACM', date: '2022', description: '' }],
    publications: [{ title: 'On Lakes', publisher: 'VLDB', date: '2022', link: 'javascript:alert(1)', description: 'd' }],
    volunteering: [{ role: 'Mentor', organization: 'Code Club', startDate: '2021', endDate: 'Present', location: 'Austin', description: '', achievements: ['Taught 30 kids'] }],
    courses: [{ name: 'ML', institution: 'Coursera', date: '2020' }, { name: '', institution: 'X', date: '' }],
    interests: [' Chess ', 'chess', 'Hiking', 'x'.repeat(150)],
    references: [{ name: 'Ann Lee', title: 'CTO', company: 'Acme', email: 'ann@acme.com', phone: '1' }, { name: '' }],
    customSections: [
      { key: 'cs-1', title: 'Patents', entries: [{ heading: 'US123', subheading: '', startDate: '', endDate: '', location: '', description: '', achievements: [] }, { heading: '' }] },
      { key: 'cs-2', title: 'Talks', entries: [] },
      { key: 'Bad Key', title: 'Dropped', entries: [{ heading: 'x' }] },
      { key: 'cs-1', title: 'Repeated key, dropped', entries: [] },
      { key: 'cs-3', title: '', entries: [] },
    ],
    sectionOrder: ['custom:cs-2', 'projects', 'summary', 'bogus', 'custom:cs-3', 'projects'],
  };
}

test('the new kinds are stored trimmed, with blank entries dropped and links kept as typed', () => {
  const resume = buildNewResume(fullPayload(), 'p1');
  assert.deepEqual(resume.projects, [
    {
      name: 'Lakehouse',
      role: 'Lead',
      startDate: '01/2023',
      endDate: '06/2023',
      link: 'github.com/sam/lakehouse',
      description: 'A lakehouse.',
      achievements: ['Cut query time by 40%'],
    },
  ]);
  assert.deepEqual(resume.languages, [{ language: 'French', proficiency: 'Fluent' }]);
  assert.deepEqual(resume.awards, [{ title: 'Best Paper', issuer: 'ACM', date: '2022', description: '' }]);
  // Stored as typed, like contact.github; the renderer keeps only http(s).
  assert.equal(resume.publications[0].link, 'javascript:alert(1)');
  assert.deepEqual(resume.volunteering[0].achievements, ['Taught 30 kids']);
  assert.deepEqual(resume.courses, [{ name: 'ML', institution: 'Coursera', date: '2020' }]);
  assert.deepEqual(resume.interests, ['Chess', 'Hiking', 'x'.repeat(100)]);
  assert.deepEqual(resume.references, [{ name: 'Ann Lee', title: 'CTO', company: 'Acme', email: 'ann@acme.com', phone: '1' }]);
  // A bad or repeated key drops its section; a title alone keeps one; neither
  // title nor entry is nothing.
  assert.deepEqual(resume.customSections.map((section) => [section.key, section.title, section.entries.length]), [
    ['cs-1', 'Patents', 1],
    ['cs-2', 'Talks', 0],
  ]);
  // The order: valid refs once each, as given; the ref to the dropped cs-3 is
  // gone; nothing appended.
  assert.deepEqual(resume.sectionOrder, ['custom:cs-2', 'projects', 'summary']);
});

test('the lists are capped like the soft skills: fifty entries, ten custom sections', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ name: `P${i}` }));
  const customs = Array.from({ length: 12 }, (_, i) => ({ key: `cs-${i}`, title: `S${i}`, entries: [] }));
  const resume = buildNewResume({ name: 'x', projects: many, courses: many, customSections: customs }, 'p1');
  assert.equal(resume.projects.length, 50);
  assert.equal(resume.courses.length, 50);
  assert.equal(resume.customSections.length, 10);
});

test('omitted keeps what is stored, a wrong shape reads as omitted, and an empty list clears', () => {
  const stored = buildNewResume(fullPayload(), 'p1');
  const same = buildUpdatedResume(stored, { name: 'Sam Chen' });
  for (const key of ['projects', 'languages', 'awards', 'publications', 'volunteering', 'courses', 'interests', 'references', 'customSections', 'sectionOrder']) {
    assert.deepEqual(same[key], stored[key], `${key} kept when omitted`);
  }
  const wrongShape = buildUpdatedResume(stored, { projects: 'none', customSections: { key: 'cs-9' }, sectionOrder: 'projects' });
  assert.deepEqual(wrongShape.projects, stored.projects);
  assert.deepEqual(wrongShape.customSections, stored.customSections);
  assert.deepEqual(wrongShape.sectionOrder, stored.sectionOrder);
  const cleared = buildUpdatedResume(stored, { projects: [], customSections: [], interests: [] });
  assert.deepEqual(cleared.projects, []);
  assert.deepEqual(cleared.customSections, []);
  assert.deepEqual(cleared.interests, []);
});

test('the order is the person\'s: never filled in, cleared by [], re-cleaned when a custom section goes, absent on a resume nobody arranged', () => {
  // A resume saved with no order has no key at all, so an older resume and
  // a new one read the same: the template's own order.
  const untouched = normalizeResumePayload({ name: 'x', projects: [{ name: 'P' }] });
  assert.equal('sectionOrder' in untouched, false);
  // A list is stored as its valid refs, as given; nothing appended.
  const arranged = buildNewResume({ name: 'x', sectionOrder: ['education', 'summary'] }, 'p1');
  assert.deepEqual(arranged.sectionOrder, ['education', 'summary']);
  // Omitted keeps it, re-cleaned against the custom sections just saved.
  const withCustom = buildNewResume(
    { name: 'x', customSections: [{ key: 'cs-1', title: 'T', entries: [] }], sectionOrder: ['custom:cs-1', 'summary'] },
    'p1'
  );
  assert.deepEqual(withCustom.sectionOrder, ['custom:cs-1', 'summary']);
  const customGone = buildUpdatedResume(withCustom, { customSections: [] });
  assert.deepEqual(customGone.sectionOrder, ['summary']);
  const kept = buildUpdatedResume(withCustom, { name: 'y' });
  assert.deepEqual(kept.sectionOrder, ['custom:cs-1', 'summary']);
  // [] clears, back to the template's own order; so does a list of junk.
  const cleared = buildUpdatedResume(arranged, { sectionOrder: [] });
  assert.equal('sectionOrder' in cleared, false);
  const junk = buildUpdatedResume(arranged, { sectionOrder: ['bogus', 'custom:nope'] });
  assert.equal('sectionOrder' in junk, false);
  // A wrong shape keeps what is stored.
  assert.deepEqual(buildUpdatedResume(arranged, { sectionOrder: 'education' }).sectionOrder, ['education', 'summary']);
});

test('getResumeSectionLayout: null for the template\'s own order, the cleaned list and the custom keys otherwise', () => {
  assert.deepEqual(getResumeSectionLayout({}), { sectionOrder: null, customKeys: [] });
  assert.deepEqual(getResumeSectionLayout({ sectionOrder: [] }), { sectionOrder: null, customKeys: [] });
  assert.deepEqual(getResumeSectionLayout({ sectionOrder: ['custom:gone'], customSections: [{ key: 'cs-1', title: 'T', entries: [] }] }), {
    sectionOrder: null,
    customKeys: ['cs-1'],
  });
  assert.deepEqual(
    getResumeSectionLayout({ sectionOrder: ['custom:cs-1', 'education', 'education'], customSections: [{ key: 'cs-1', title: 'T', entries: [] }] }),
    { sectionOrder: ['custom:cs-1', 'education'], customKeys: ['cs-1'] }
  );
});

test('the preview builder passes every new list and the order through, and a draft sending [] previews in the template\'s order', () => {
  const stored = buildNewResume(fullPayload(), 'p1');
  const draft = {
    ...fullPayload(),
    projects: [{ name: 'Only this one', role: '', startDate: '', endDate: '', link: '', description: '', achievements: [] }],
    sectionOrder: ['education', 'custom:cs-1'],
  };
  const previewed = buildPreviewResume(draft, stored);
  assert.deepEqual(previewed.projects.map((project) => project.name), ['Only this one']);
  assert.deepEqual(previewed.languages, stored.languages);
  assert.deepEqual(previewed.customSections.map((section) => section.key), ['cs-1', 'cs-2']);
  assert.deepEqual(previewed.sectionOrder, ['education', 'custom:cs-1']);
  assert.deepEqual(previewed.interests, stored.interests);
  // [] in the draft: no order, whatever is stored.
  assert.equal('sectionOrder' in buildPreviewResume({ ...draft, sectionOrder: [] }, stored), false);
  // A wrong shape in the draft reads as omitted - the stored value shows.
  assert.deepEqual(buildPreviewResume({ projects: 'typing...', interests: 'Chess' }, stored).projects, stored.projects);
  assert.deepEqual(buildPreviewResume({ projects: 'typing...', interests: 'Chess' }, stored).interests, stored.interests);
  assert.deepEqual(buildPreviewResume({ sectionOrder: 'education' }, stored).sectionOrder, stored.sectionOrder);
});

test('the tailoring cache ignores the order - it only decides how the answer is drawn - and misses on a new entry', () => {
  const { resumeFingerprint } = require('../dist/services/tailorCache');
  const base = buildNewResume(fullPayload(), 'p1');
  const moved = { ...base, sectionOrder: ['education', 'summary'] };
  const absent = { ...base };
  delete absent.sectionOrder;
  assert.equal(resumeFingerprint(moved), resumeFingerprint(absent));
  assert.notEqual(resumeFingerprint({ ...base, projects: [] }), resumeFingerprint(base));
});

/* ----------------------------------------------------- import, extraction */

test('a file with a name and only projects is a resume, and the extraction prompt asks for every new kind', () => {
  const { buildImportedResumes } = require('../dist/services/resumeImport');
  let next = 0;
  const store = { idExists: () => false, newId: () => `generated-${++next}` };
  const [{ resume }] = buildImportedResumes({ name: 'Pat', projects: [{ name: 'Lakehouse', achievements: ['Fast'] }] }, store);
  assert.deepEqual(resume.projects.map((project) => project.name), ['Lakehouse']);
  assert.equal('sectionOrder' in resume, false);

  const prompt = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'static', 'prompts', 'extract-profile-from-resume.json'), 'utf8'));
  for (const key of ['projects', 'languages', 'awards', 'publications', 'volunteering', 'courses', 'interests', 'certifications']) {
    assert.match(prompt.content, new RegExp(`"${key}":`), `the prompt's schema names ${key}`);
  }
  assert.match(prompt.content, /A paid job is experience, never a project/);
});
