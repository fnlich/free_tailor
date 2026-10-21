const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ts = require('typescript');

const { useTempStorage } = require('./helpers');

/**
 * The profile editor's and the builder's decisions that need no browser:
 * the preview's scale width (the shake), what an unticked section keeps, the
 * sample-text notice and placeholders, which running batch the builder picks
 * back up, and - against the server's own copy - the section catalogue, the
 * section order's semantics, the draft's round trip through a save, and what
 * Write with AI is sent. Loaded the way frontendHelpers.test.js loads its
 * modules: transpiled with the backend's TypeScript, importing nothing at
 * runtime.
 */

const SRC = path.join(__dirname, '..', '..', 'frontend', 'src');

function loadFrontendModule(relative) {
  const file = path.join(SRC, relative);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  });
  const module = { exports: {} };
  const refuse = (specifier) => {
    throw new Error(`${relative} imports ${specifier}; it is meant to import nothing at runtime`);
  };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, refuse);
  return module.exports;
}

// -- the preview's scale width ----------------------------------------------- //

/**
 * The editor's well, frame by frame, at 1920x937 on Linux Chrome as the probe
 * measured it (backend/test/e2e/preview-vibration.js): a 565.3px border box,
 * 16px padding each side, a 15px scrollbar, room for 734px of page, and a
 * one-page (1123px) document scaled from 794px.
 *
 * `gutterStable` is `scrollbar-gutter: stable`: the strip is reserved whether
 * or not anything overflows. Without it the strip exists only while the page
 * overflows - which is what fed the loop.
 */
function simulateWell(widthFor, { gutterStable, frames = 12, bar = 15 }) {
  const outer = 565.3;
  const room = 734;
  let overflows = false;
  const widths = [];
  const state = {};
  for (let frame = 0; frame < frames; frame += 1) {
    const strip = gutterStable || overflows ? bar : 0;
    const box = {
      outerWidth: outer,
      clientWidth: Math.round(outer - strip),
      borderX: 0,
      paddingX: 32,
      scrolls: true,
      windowBar: 15,
    };
    const width = widthFor(box, state);
    widths.push(Math.round(width * 10) / 10);
    overflows = (1123 * width) / 794 > room;
  }
  return widths;
}

/**
 * The narrow layout, where the WINDOW scrolls: a 1080x1460 window (a portrait
 * screen) whose page is just the window's height. The well is the window's
 * width less fixed padding, so it loses the window's scrollbar when that comes
 * in. As the probe measured it: 758px wide without the window's scrollbar,
 * 743px with it, and the page overflows the window above 726px wide.
 */
function simulateWindow(widthFor, { gutterStable, frames = 12, bar = 15 }) {
  let overflows = false;
  const widths = [];
  const state = {};
  for (let frame = 0; frame < frames; frame += 1) {
    const windowBar = gutterStable || overflows ? bar : 0;
    const outer = 758 - windowBar;
    const box = { outerWidth: outer, clientWidth: outer, borderX: 0, paddingX: 32, scrolls: false, windowBar };
    const width = widthFor(box, state);
    widths.push(Math.round(width * 10) / 10);
    overflows = width > 720;
  }
  return widths;
}

/** What ProfilePreview did before: the well's inside as it stands. */
const insideAsItStands = (box) => box.clientWidth - box.paddingX;

function stableWidthFor() {
  const { stablePaneWidth } = loadFrontendModule('lib/previewPane.ts');
  return (box, state) => {
    const next = stablePaneWidth(box, state.gutters);
    state.gutters = next.gutters;
    return next.width;
  };
}

test('scaled to the inside as it stands, a one-page resume shakes for ever, in either layout', () => {
  // Two widths taking turns every frame: the loops the probe saw
  // (533.3 <-> 518.3 in the wide well, 726 <-> 711 in a narrow window).
  const wide = simulateWell(insideAsItStands, { gutterStable: false });
  assert.equal(new Set(wide.slice(2)).size, 2, wide.join(' '));
  const narrow = simulateWindow(insideAsItStands, { gutterStable: false });
  assert.equal(new Set(narrow.slice(2)).size, 2, narrow.join(' '));
});

test('stablePaneWidth settles in one step without scrollbar-gutter, and never moves after', () => {
  const wide = simulateWell(stableWidthFor(), { gutterStable: false });
  assert.equal(new Set(wide.slice(2)).size, 1, wide.join(' '));
  assert.ok(wide.at(-1) < 534 && wide.at(-1) > 517, `settled at ${wide.at(-1)}`);

  const narrow = simulateWindow(stableWidthFor(), { gutterStable: false });
  assert.equal(new Set(narrow.slice(2)).size, 1, narrow.join(' '));
});

test('stablePaneWidth with scrollbar-gutter: one width from the first frame', () => {
  const wide = simulateWell(stableWidthFor(), { gutterStable: true });
  assert.equal(new Set(wide).size, 1, wide.join(' '));
  const narrow = simulateWindow(stableWidthFor(), { gutterStable: true });
  assert.equal(new Set(narrow).size, 1, narrow.join(' '));
});

test('stablePaneWidth: which strip it allows for, and what it ignores', () => {
  const { NO_GUTTERS, stablePaneWidth } = loadFrontendModule('lib/previewPane.ts');
  const wide = (outerWidth, clientWidth, extra = {}) => ({
    outerWidth,
    clientWidth,
    borderX: 0,
    paddingX: 32,
    scrolls: true,
    windowBar: 15,
    ...extra,
  });
  // An overlay scrollbar (macOS trackpads, phones) takes no room: the whole inside.
  assert.deepEqual(stablePaneWidth(wide(565, 565), NO_GUTTERS), { width: 533, gutters: { well: 0, window: 0 } });
  // A strip once seen is kept while the bar is gone again.
  assert.deepEqual(stablePaneWidth(wide(565, 565), { well: 15, window: 0 }), {
    width: 518,
    gutters: { well: 15, window: 0 },
  });
  // A fractional border box against an integer clientWidth is rounding, not a scrollbar.
  assert.equal(stablePaneWidth(wide(565.33, 565)).gutters.well, 0);
  // Borders are not the inside either.
  assert.deepEqual(stablePaneWidth(wide(600, 583, { borderX: 2 })).width, 551);
  assert.equal(stablePaneWidth(wide(10, 10)).width, 0);

  // The narrow layout: the well does not scroll, so its own remembered strip
  // is not taken off - the WINDOW's is, and only while the window's scrollbar
  // is away (while it is there, the width already lacks it).
  const narrow = (outerWidth, windowBar) => ({
    outerWidth,
    clientWidth: outerWidth,
    borderX: 0,
    paddingX: 32,
    scrolls: false,
    windowBar,
  });
  assert.deepEqual(stablePaneWidth(narrow(743, 15), { well: 15, window: 0 }), {
    width: 711,
    gutters: { well: 15, window: 15 },
  });
  assert.equal(stablePaneWidth(narrow(758, 0), { well: 0, window: 15 }).width, 711);
  // A phone's overlay scrollbar never takes anything.
  assert.equal(stablePaneWidth(narrow(390, 0), NO_GUTTERS).width, 358);
});

// -- an unticked Soft Skills or Strengths box ------------------------------- //

test('an unticked section says how many entries it keeps, and counts only real ones', () => {
  const { keptCount, keptNote } = loadFrontendModule('lib/profileDraft.ts');
  const draft = {
    softSkills: ['Mentoring', 'Clear writing', 'Calm under pressure'],
    strengths: [
      { key: 'a', title: 'Ownership', description: '' },
      { key: 'b', title: '  ', description: '   ' },
      { key: 'c', title: '', description: 'Sees work through.' },
    ],
  };
  assert.equal(keptCount(draft, 'softSkills'), 3);
  // An empty card is not something kept.
  assert.equal(keptCount(draft, 'strengths'), 2);
  assert.equal(
    keptNote(3, 'softSkills'),
    '3 soft skills kept with the profile. Tick the box to print and edit them.'
  );
  assert.equal(keptNote(1, 'strengths'), '1 strength kept with the profile. Tick the box to print and edit it.');
  assert.equal(keptNote(0, 'strengths'), null);
});

// -- the preview's sample text ---------------------------------------------- //

test('the sample-text notice names what the server filled, in the form\'s order', () => {
  const { sampledNotice } = loadFrontendModule('lib/profileDraft.ts');
  assert.equal(sampledNotice(undefined), null);
  assert.equal(sampledNotice(null), null);
  assert.equal(sampledNotice([]), null);
  assert.equal(sampledNotice('name'), null);
  assert.equal(
    sampledNotice(['experience', 'phone', 'name', 'softSkills', 'linkedin']),
    'Sample text shown for: name, phone, LinkedIn, experience, soft skills.'
  );
  // A field a newer server fills is still named, never dropped.
  assert.equal(
    sampledNotice(['name', 'certifications', 'portfolioUrl', 'portfolioUrl']),
    'Sample text shown for: name, certifications, portfolio url.'
  );
});

test("the notice has a word for every field the server's sample can fill", () => {
  const { SAMPLED_FIELD_WORDS, sampledNotice } = loadFrontendModule('lib/profileDraft.ts');
  const { SAMPLE_FIELDS } = require('../dist/services/sampleProfile');
  const known = new Set(SAMPLED_FIELD_WORDS.map(([key]) => key));
  // Every key the server can send has its own word here - the camelCase
  // fallback is for a newer server, not for this one.
  assert.deepEqual(SAMPLE_FIELDS.filter((field) => !known.has(field)), []);
  // All of them at once names each one once.
  const all = sampledNotice([...SAMPLE_FIELDS]);
  assert.equal(all.replace('Sample text shown for: ', '').replace(/\.$/, '').split(', ').length, SAMPLE_FIELDS.length);
});

test("the form's placeholders are the server's sample text, field for field", () => {
  const { SAMPLE_PLACEHOLDERS } = loadFrontendModule('lib/profileDraft.ts');
  const { SAMPLE_PROFILE } = require('../dist/services/sampleProfile');
  assert.equal(SAMPLE_PLACEHOLDERS.name, SAMPLE_PROFILE.name);
  assert.equal(SAMPLE_PLACEHOLDERS.title, SAMPLE_PROFILE.title);
  assert.equal(SAMPLE_PLACEHOLDERS.email, SAMPLE_PROFILE.contact.email);
  assert.equal(SAMPLE_PLACEHOLDERS.phone, SAMPLE_PROFILE.contact.phone);
  assert.equal(SAMPLE_PLACEHOLDERS.location, SAMPLE_PROFILE.contact.location);
  assert.equal(SAMPLE_PLACEHOLDERS.linkedin, SAMPLE_PROFILE.contact.linkedin);
  // The summary placeholder is the sample's opening, cut where it says so.
  assert.ok(SAMPLE_PLACEHOLDERS.summary.endsWith('...'));
  assert.ok(SAMPLE_PROFILE.summary.startsWith(SAMPLE_PLACEHOLDERS.summary.slice(0, -3)), SAMPLE_PLACEHOLDERS.summary);
  assert.equal(SAMPLE_PLACEHOLDERS.experienceTitle, SAMPLE_PROFILE.experience[0].title);
  assert.equal(SAMPLE_PLACEHOLDERS.experienceCompany, SAMPLE_PROFILE.experience[0].company);
  assert.equal(SAMPLE_PLACEHOLDERS.educationDegree, SAMPLE_PROFILE.education[0].degree);
  assert.equal(SAMPLE_PLACEHOLDERS.educationInstitution, SAMPLE_PROFILE.education[0].institution);
});

// -- which running batch the builder picks back up --------------------------- //

test("the builder picks back up only this tab's own Generate Immediately run, never an order", () => {
  const { reattachTarget } = loadFrontendModule('lib/batchFollow.ts');
  const mine = { batchId: 'b-mine', state: 'running', kind: 'immediate' };
  const other = { batchId: 'b-other', state: 'running', kind: 'immediate' };

  // The remembered run, when the server still lists it for this tab.
  assert.deepEqual(reattachTarget([other, mine], 'b-mine'), { batchId: 'b-mine', forget: false });
  // Remembered but not listed - finished, stopped when the page was left,
  // gone after a restart: forgotten, and the server's own list decides.
  assert.deepEqual(reattachTarget([mine], 'b-stopped'), { batchId: 'b-mine', forget: true });
  assert.deepEqual(reattachTarget([], 'b-done'), { batchId: null, forget: true });
  // Nothing remembered (storage was blocked): the tab's first listed run.
  assert.deepEqual(reattachTarget([mine], null), { batchId: 'b-mine', forget: false });
  assert.deepEqual(reattachTarget([], null), { batchId: null, forget: false });

  // An order is followed on the Orders page, never here - even from a server
  // that still lists one, and even when it is the remembered id - and so is a
  // run without a kind (one the server no longer holds), which no tab holds.
  const order = { batchId: 'b-order', state: 'running', kind: 'order' };
  const legacy = { batchId: 'b-legacy', state: 'running', kind: null };
  assert.deepEqual(reattachTarget([order], null), { batchId: null, forget: false });
  assert.deepEqual(reattachTarget([legacy], null), { batchId: null, forget: false });
  assert.deepEqual(reattachTarget([order, mine], 'b-order'), { batchId: 'b-mine', forget: true });
  // Only a running batch.
  assert.deepEqual(
    reattachTarget([{ batchId: 'b-done', state: 'done', kind: 'immediate' }], null),
    { batchId: null, forget: false }
  );

  // The list could not be read: attach nothing, and keep the remembered run
  // for the next visit rather than forgetting it over a network blip.
  assert.deepEqual(reattachTarget(null, 'b-mine'), { batchId: null, forget: false });
});

// -- the section catalogue, against the server's ---------------------------- //

/*
 * The editor keeps a copy of config/profileSections.ts: the kinds, their
 * shared fields and the order's semantics. Both copies are run over the same
 * inputs here, so a change to either fails until it is made to both.
 */

const sections = loadFrontendModule('lib/profileSections.ts');
const server = require('../dist/config/profileSections');

test("the catalogue is the server's: the same ids in the same order, with the same heading, field, shape, bullets and classic flag", () => {
  assert.deepEqual([...sections.SECTION_KIND_IDS], [...server.SECTION_KIND_IDS]);
  assert.deepEqual([...sections.CLASSIC_SECTION_KINDS], [...server.CLASSIC_SECTION_KINDS]);
  assert.deepEqual([...sections.EXTRA_SECTION_KINDS], [...server.EXTRA_SECTION_KINDS]);
  assert.deepEqual([...sections.DEFAULT_SECTION_KINDS], [...server.DEFAULT_SECTION_KINDS]);
  for (const kind of server.SECTION_KINDS) {
    const copy = sections.SECTION_KIND_BY_ID[kind.id];
    assert.ok(copy, `${kind.id} is in the editor's catalogue`);
    for (const field of ['id', 'heading', 'field', 'shape', 'hasBullets', 'isClassic']) {
      assert.equal(copy[field], kind[field], `${kind.id}.${field}`);
    }
    // The editor's half: a label, an icon, a noun for a row, and fields for
    // every kind edited as rows.
    assert.ok(copy.label && copy.icon && copy.entryNoun, `${kind.id} has its editor copy`);
    if (copy.editor === 'entries') assert.ok(copy.fields.length > 0, `${kind.id} has Edit Entry fields`);
    assert.equal(Boolean(copy.aiKind), kind.hasBullets, `${kind.id}: Write with AI serves exactly the bullet kinds`);
  }
  assert.equal(sections.CUSTOM_REF_PREFIX, server.CUSTOM_REF_PREFIX);
  assert.equal(String(sections.CUSTOM_KEY_PATTERN), String(server.CUSTOM_KEY_PATTERN));
  assert.equal(sections.MAX_PROFILE_CUSTOM_SECTIONS, server.MAX_PROFILE_CUSTOM_SECTIONS);
  assert.equal(sections.MAX_PROFILE_SECTION_ENTRIES, server.MAX_PROFILE_SECTION_ENTRIES);
  assert.equal(sections.MAX_PROFILE_INTERESTS, server.MAX_PROFILE_INTERESTS);
  assert.equal(sections.MAX_INTEREST_LENGTH, server.MAX_INTEREST_LENGTH);
  // The custom section's spec has the shape of a bullet kind.
  assert.equal(sections.CUSTOM_SECTION_SPEC.shape, 'entries');
  assert.equal(sections.CUSTOM_SECTION_SPEC.hasBullets, true);
  assert.ok(sections.CUSTOM_SECTION_SPEC.fields.some((field) => field.name === 'heading'));
});

test('a section ref is read the same by both copies', () => {
  const refs = [
    ...server.SECTION_KIND_IDS,
    'custom:cs-1a2b3c4d',
    'custom:',
    'custom:Has Space',
    `custom:${'a'.repeat(41)}`,
    `custom:${'a'.repeat(40)}`,
    'Custom:x',
    ' projects',
    'bogus',
    'custom',
    '',
    42,
    null,
    undefined,
    ['projects'],
  ];
  for (const ref of refs) {
    assert.deepEqual(sections.parseSectionRef(ref), server.parseSectionRef(ref), JSON.stringify(ref));
    assert.equal(sections.isSectionKind(ref), server.isSectionKind(ref), JSON.stringify(ref));
  }
  for (const key of ['cs-1a2b3c4d', 'CS-1', 'a'.repeat(40), 'a'.repeat(41), '', null]) {
    assert.equal(sections.isCustomSectionKey(key), server.isCustomSectionKey(key), JSON.stringify(key));
  }
  assert.equal(sections.sectionRefId({ kind: 'custom', key: 'k' }), server.sectionRefId({ kind: 'custom', key: 'k' }));
  assert.equal(sections.customSectionRef('k'), server.customSectionRef('k'));
});

const NATIVE_DEFAULT = ['summary', 'experience', 'strengths', 'skills', 'softSkills', 'education', ...server.EXTRA_SECTION_KINDS];
const NATIVE_SIDEBAR = ['skills', 'summary', 'experience', 'education', ...server.EXTRA_SECTION_KINDS];
const NATIVE_BARE = ['summary', 'experience', 'education', 'skills'];

/** Drafts and profiles as `presenceOf` reads them - the fields by name, whatever else is on the object. */
const SOURCES = [
  {},
  { summary: '   ', skills: [], certifications: [] },
  { summary: 'Builds things.', skills: ['TypeScript'] },
  { skills: [], skillCategories: [{ category: 'Cloud', skills: ['AWS'] }] },
  {
    projects: [{ key: 'row-1', name: 'P' }],
    interests: ['x'],
    languages: 'French',
    awards: [],
    customSections: [{ key: 'cs-2' }, { key: 'cs-1' }, { key: 'cs-2' }, { key: 'Bad Key' }, 'junk', null],
  },
  { experience: [{}], education: [{}], strengths: [{}], softSkills: ['Calm'], volunteering: [{}], references: [{}] },
];

/** [stored, native, source]: every branch of the order's completion. */
const ORDER_CASES = [
  // Nothing stored: the template's own order, filtered to the default kinds and the present ones, customs last.
  [undefined, NATIVE_DEFAULT, SOURCES[4]],
  [[], NATIVE_DEFAULT, SOURCES[2]],
  [null, NATIVE_SIDEBAR, SOURCES[3]],
  ['projects', NATIVE_DEFAULT, SOURCES[4]],
  // Native order respected when nothing is stored, and a template that places few kinds.
  [[], NATIVE_BARE, SOURCES[4]],
  [[], ['foo', 'custom:x', 'summary', 'summary', 'education'], SOURCES[0]],
  [[], server.SECTION_KIND_IDS, SOURCES[5]],
  // A stored order that is not canonical is kept as arranged.
  [['education', 'summary', 'experience', 'skills'], NATIVE_DEFAULT, SOURCES[2]],
  // An unlisted filled kind follows in native-then-canonical order; a listed empty kind stays.
  [['languages', 'summary'], NATIVE_DEFAULT, SOURCES[4]],
  [['awards', 'courses', 'summary'], NATIVE_SIDEBAR, SOURCES[0]],
  // Unknown refs and duplicates dropped, a dangling custom ref dropped, an unlisted custom appended.
  [['custom:gone', 'projects', 'bogus', 'projects', 'custom:cs-1'], NATIVE_BARE, SOURCES[4]],
  [['custom:cs-2', 'interests', 'custom:cs-2'], NATIVE_DEFAULT, SOURCES[4]],
  // Where no template has loaded the default kinds stand in for one.
  [['experience'], server.DEFAULT_SECTION_KINDS, SOURCES[5]],
];

test("presenceOf, cleanSectionOrder, sectionSortKey and effectiveSectionOrder answer as the server's do", () => {
  for (const source of SOURCES) {
    assert.deepEqual(sections.presenceOf(source), server.presenceOf(source), JSON.stringify(source));
  }
  const customKeys = ['cs-1', 'cs-2'];
  for (const [stored] of ORDER_CASES) {
    assert.deepEqual(sections.cleanSectionOrder(stored, customKeys), server.cleanSectionOrder(stored, customKeys), JSON.stringify(stored));
  }
  for (const stored of [['education', 'summary'], [], ['custom:cs-1', 'projects']]) {
    for (const ref of ['education', 'summary', 'skills', 'custom:cs-1', 'anything']) {
      for (const index of [0, 1, 5]) {
        assert.equal(sections.sectionSortKey(ref, stored, index), server.sectionSortKey(ref, stored, index), `${ref} in ${stored} at ${index}`);
      }
    }
  }
  for (const [stored, native, source] of ORDER_CASES) {
    const presence = server.presenceOf(source);
    const label = `${JSON.stringify(stored)} / ${native.slice(0, 4).join(',')}... / ${JSON.stringify(presence)}`;
    assert.deepEqual(sections.effectiveSectionOrder(stored, native, presence), server.effectiveSectionOrder(stored, native, presence), label);
    // And over the editor's own reading of the same source.
    assert.deepEqual(sections.effectiveSectionOrder(stored, native, sections.presenceOf(source)), server.effectiveSectionOrder(stored, native, presence), label);
  }
  // Two the editor relies on, spelled out: a listed empty kind stays, and
  // an unlisted filled kind follows in the template's order.
  assert.deepEqual(
    sections.effectiveSectionOrder(['languages', 'summary'], NATIVE_DEFAULT, sections.presenceOf(SOURCES[4])),
    ['languages', 'summary', 'experience', 'strengths', 'skills', 'softSkills', 'education', 'certifications', 'projects', 'interests', 'custom:cs-2', 'custom:cs-1']
  );
  // The sidebar template places Certifications (through the macro) and lacks
  // Strengths and Soft Skills, which follow in canonical order.
  assert.deepEqual(sections.effectiveSectionOrder([], NATIVE_SIDEBAR, sections.presenceOf(SOURCES[3])), [
    'skills',
    'summary',
    'experience',
    'education',
    'certifications',
    'strengths',
    'softSkills',
  ]);
});

test('a new custom section key is cs- and eight hex digits, never one already taken, and a ref the server accepts', () => {
  const pattern = /^cs-[0-9a-f]{8}$/;
  const drawn = new Set();
  for (let i = 0; i < 200; i += 1) {
    const key = sections.newCustomSectionKey([...drawn]);
    assert.match(key, pattern);
    assert.ok(!drawn.has(key), `${key} drawn twice`);
    drawn.add(key);
    assert.deepEqual(server.parseSectionRef(`custom:${key}`), { kind: 'custom', key });
  }
  // Drawn again while taken: a source that answers the same bytes twice, then others.
  const bytesByAttempt = [
    [0x1a, 0x2b, 0x3c, 0x4d],
    [0x1a, 0x2b, 0x3c, 0x4d],
    [0x00, 0xff, 0x10, 0x01],
  ];
  const fill = (bytes, attempt) => bytes.set(bytesByAttempt[Math.min(attempt, bytesByAttempt.length - 1)]);
  assert.equal(sections.newCustomSectionKey([], fill), 'cs-1a2b3c4d');
  assert.equal(sections.newCustomSectionKey(['cs-1a2b3c4d'], fill), 'cs-00ff1001');
});

test('moveSection and insertRelative: the arrangement a Move button or a drop makes, never off the list', () => {
  const order = ['a', 'b', 'c', 'd'];
  assert.deepEqual(sections.moveSection(order, 'c', -1), ['a', 'c', 'b', 'd']);
  assert.deepEqual(sections.moveSection(order, 'c', 1), ['a', 'b', 'd', 'c']);
  assert.deepEqual(sections.moveSection(order, 'a', -1), order, 'the first stays first');
  assert.deepEqual(sections.moveSection(order, 'd', 1), order, 'the last stays last');
  assert.deepEqual(sections.moveSection(order, 'b', -5), ['b', 'a', 'c', 'd'], 'held inside the list');
  assert.deepEqual(sections.moveSection(order, 'x', 1), order, 'a ref the order lacks changes nothing');
  assert.notEqual(sections.moveSection(order, 'x', 1), order, 'always a new array');
  assert.deepEqual(order, ['a', 'b', 'c', 'd'], 'the input is never changed');

  assert.deepEqual(sections.insertRelative(order, 'd', 'a', 'before'), ['d', 'a', 'b', 'c']);
  assert.deepEqual(sections.insertRelative(order, 'd', 'a', 'after'), ['a', 'd', 'b', 'c']);
  assert.deepEqual(sections.insertRelative(order, 'a', 'd', 'after'), ['b', 'c', 'd', 'a']);
  assert.deepEqual(sections.insertRelative(order, 'a', 'b', 'before'), order, 'already there');
  assert.deepEqual(sections.insertRelative(order, 'b', 'b', 'after'), order, 'dropped on itself');
  assert.deepEqual(sections.insertRelative(order, 'x', 'b', 'after'), order, 'a ref the order lacks');
  assert.deepEqual(sections.insertRelative(order, 'b', 'x', 'after'), order, 'a target the order lacks');
  assert.deepEqual(order, ['a', 'b', 'c', 'd']);

  assert.equal(sections.dateRange('01/2023', '06/2023'), '01/2023 - 06/2023');
  assert.equal(sections.dateRange('2021', ''), '2021');
  assert.equal(sections.dateRange(undefined, 'Present'), 'Present');
  assert.equal(sections.dateRange('', ' '), '');
  const spec = sections.SECTION_KIND_BY_ID.experience;
  assert.deepEqual(sections.entrySummary(spec, { title: 'Engineer', company: 'Acme', startDate: '2020', endDate: 'Present', location: 'Remote' }, 0), {
    title: 'Engineer at Acme',
    meta: '2020 - Present · Remote',
    untitled: false,
  });
  assert.deepEqual(sections.entrySummary(spec, { title: '', company: '' }, 1), { title: 'Experience 2', meta: '', untitled: true });
  assert.deepEqual(sections.entrySummary(sections.CUSTOM_SECTION_SPEC, { heading: 'US123' }, 0), { title: 'US123', meta: '', untitled: false });
});

// -- the draft's round trip ------------------------------------------------- //

/** A stored profile with one entry of every kind, as the server would hand it over. */
function storedProfile() {
  return {
    id: 'p1',
    name: 'Sam Chen',
    title: 'Engineer',
    totalYearsExperience: 7,
    preferredTemplate: 'default',
    contact: { email: 'sam@example.com', phone: '1', location: 'Austin', linkedin: '', github: 'github.com/sam', portfolio: '' },
    summary: 'Builds things.',
    experience: [
      { title: 'Engineer', company: 'Acme', startDate: '2020', endDate: 'Present', location: 'Remote', description: 'd', achievements: ['Shipped it', 'Kept it up'], skills: ['Go'] },
    ],
    strengths: [{ title: 'Ownership', description: '' }],
    skills: ['Go', 'AWS'],
    skillCategories: [{ category: 'Languages', skills: ['Go'] }],
    softSkills: ['Calm'],
    education: [{ degree: 'B.S.', institution: 'UT', startDate: '2012', endDate: '2016', location: 'Austin', gpa: '3.9' }],
    certifications: [{ name: 'AWS SA', issuer: 'AWS', date: '2021', expiryDate: '2024', credentialId: 'X1' }],
    projects: [{ name: 'Lakehouse', role: 'Lead', startDate: '01/2023', endDate: '06/2023', link: 'github.com/sam/lakehouse', description: 'A lakehouse.', achievements: ['Cut query time by 40%'] }],
    languages: [{ language: 'French', proficiency: 'Fluent' }],
    awards: [{ title: 'Best Paper', issuer: 'ACM', date: '2022', description: '' }],
    publications: [{ title: 'On Lakes', publisher: 'VLDB', date: '2022', link: '', description: 'd' }],
    volunteering: [{ role: 'Mentor', organization: 'Code Club', startDate: '2021', endDate: 'Present', location: 'Austin', description: '', achievements: ['Taught 30 kids'] }],
    courses: [{ name: 'ML', institution: 'Coursera', date: '2020' }],
    interests: ['Chess', 'Hiking'],
    references: [{ name: 'Ann Lee', title: 'CTO', company: 'Acme', email: 'ann@acme.com', phone: '1' }],
    customSections: [{ key: 'cs-1a2b3c4d', title: 'Patents', entries: [{ heading: 'US123', subheading: '', startDate: '', endDate: '', location: '', description: '', achievements: ['Granted'] }] }],
    sectionOrder: ['custom:cs-1a2b3c4d', 'projects', 'summary'],
    profileSettings: { technicalSkillsLayout: 'categorized', includeSoftSkills: true, includeStrengths: true },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const LISTS = ['experience', 'strengths', 'education', 'certifications', 'projects', 'languages', 'awards', 'publications', 'volunteering', 'courses', 'references'];

test('a stored profile round-trips through the draft: every row keyed in, every key out, bullets as text and back, every list named, blank rows dropped, the order kept', () => {
  const draft = loadFrontendModule('lib/profileDraft.ts');
  const stored = storedProfile();
  const asDraft = draft.draftFromProfile(stored);

  for (const list of LISTS) {
    assert.equal(asDraft[list].length, stored[list].length, list);
    for (const row of asDraft[list]) assert.match(row.key, /^row-\d+$/, `${list} rows are keyed`);
  }
  assert.equal(asDraft.experience[0].achievementsText, 'Shipped it\nKept it up');
  assert.equal(asDraft.projects[0].achievementsText, 'Cut query time by 40%');
  assert.equal(asDraft.volunteering[0].achievementsText, 'Taught 30 kids');
  assert.deepEqual(asDraft.interests, ['Chess', 'Hiking']);
  assert.deepEqual(asDraft.customSections.map((section) => [section.key, section.title, section.entries[0].achievementsText]), [['cs-1a2b3c4d', 'Patents', 'Granted']]);
  // The order as stored; null for a profile that stores none.
  assert.deepEqual(asDraft.sectionOrder, ['custom:cs-1a2b3c4d', 'projects', 'summary']);
  assert.equal(draft.draftFromProfile({ ...stored, sectionOrder: [] }).sectionOrder, null);
  assert.equal(draft.draftFromProfile({ ...stored, sectionOrder: undefined }).sectionOrder, null);
  assert.equal(draft.draftFromProfile(null).sectionOrder, null);

  // Rows opened and left blank, in a list of every kind and in a custom section.
  const withBlanks = {
    ...asDraft,
    experience: [...asDraft.experience, draft.emptyEntry('experience')],
    projects: [...asDraft.projects, draft.emptyEntry('projects')],
    languages: [...asDraft.languages, draft.emptyEntry('languages')],
    strengths: [...asDraft.strengths, draft.emptyEntry('strengths')],
    customSections: asDraft.customSections.map((section) => ({ ...section, entries: [...section.entries, draft.emptyEntry('custom')] })),
  };
  for (const kind of ['experience', 'education', 'certifications', 'strengths', 'projects', 'volunteering', 'awards', 'publications', 'courses', 'languages', 'references', 'custom']) {
    assert.equal(draft.isBlankEntry(draft.emptyEntry(kind)), true, `a new ${kind} row is blank`);
  }
  assert.equal(draft.isBlankEntry(asDraft.experience[0]), false);
  assert.equal(draft.isBlankEntry({ key: 'k', title: '  ', achievementsText: '\n', skills: [] }), true);

  const payload = draft.draftToPayload(withBlanks, {}, ['Languages']);
  for (const list of [...LISTS, 'interests', 'customSections', 'sectionOrder', 'skills', 'skillCategories', 'softSkills']) {
    assert.ok(Array.isArray(payload[list]), `${list} is named in a save`);
  }
  for (const list of LISTS) {
    assert.equal(payload[list].length, stored[list].length, `${list}: the blank row is not sent`);
    for (const row of payload[list]) {
      assert.equal('key' in row, false, `${list} rows lose their key`);
      assert.equal('achievementsText' in row, false, `${list} rows send achievements, not text`);
    }
  }
  assert.deepEqual(payload.experience[0].achievements, ['Shipped it', 'Kept it up']);
  assert.deepEqual(payload.experience[0].skills, ['Go']);
  assert.deepEqual(payload.projects[0], stored.projects[0]);
  assert.deepEqual(payload.volunteering[0], stored.volunteering[0]);
  // What the editor does not show travels with the row.
  assert.equal(payload.education[0].gpa, '3.9');
  assert.equal(payload.certifications[0].credentialId, 'X1');
  assert.deepEqual(payload.customSections, stored.customSections);
  assert.deepEqual(payload.sectionOrder, ['custom:cs-1a2b3c4d', 'projects', 'summary']);
  // A draft following its template sends [] - what clears a stored order.
  assert.deepEqual(draft.draftToPayload({ ...asDraft, sectionOrder: null }, {}, []).sectionOrder, []);
  // Every list is named even when empty.
  const empty = draft.draftToPayload(draft.draftFromProfile(null), {}, []);
  for (const list of [...LISTS, 'interests', 'customSections']) assert.deepEqual(empty[list], [], list);

  // And the server keeps what was arranged: the order and the custom keys.
  const { normalizeProfilePayload } = require('../dist/services/profileService');
  const saved = normalizeProfilePayload(payload);
  assert.deepEqual(saved.sectionOrder, ['custom:cs-1a2b3c4d', 'projects', 'summary']);
  assert.deepEqual(saved.customSections.map((section) => section.key), ['cs-1a2b3c4d']);
  assert.deepEqual(saved.projects, stored.projects);
  assert.deepEqual(saved.interests, ['Chess', 'Hiking']);
  assert.equal('sectionOrder' in normalizeProfilePayload(empty), false, '[] clears to absent');
});

test('the draft helpers: find, change, remove and add a row, count a section, add and remove a section', () => {
  const draft = loadFrontendModule('lib/profileDraft.ts');
  const asDraft = draft.draftFromProfile(storedProfile());
  const roleKey = asDraft.experience[0].key;
  const customKey = asDraft.customSections[0].entries[0].key;

  assert.equal(draft.findEntry(asDraft, { kind: 'experience', key: roleKey }).title, 'Engineer');
  assert.equal(draft.findEntry(asDraft, { kind: 'experience', key: 'nope' }), null);
  assert.equal(draft.findEntry(asDraft, { kind: 'custom', sectionKey: 'cs-1a2b3c4d', key: customKey }).heading, 'US123');
  assert.equal(draft.findEntry(asDraft, { kind: 'custom', sectionKey: 'cs-gone', key: customKey }), null);

  const changed = draft.replaceEntry(asDraft, { kind: 'experience', key: roleKey }, { title: 'Lead', key: 'tampered' });
  assert.equal(changed.experience[0].title, 'Lead');
  assert.equal(changed.experience[0].key, roleKey, 'a row keeps its key');
  const changedCustom = draft.replaceEntry(asDraft, { kind: 'custom', sectionKey: 'cs-1a2b3c4d', key: customKey }, { heading: 'US456' });
  assert.equal(changedCustom.customSections[0].entries[0].heading, 'US456');

  assert.equal(draft.removeEntry(asDraft, { kind: 'experience', key: roleKey }).experience.length, 0);
  assert.equal(draft.removeEntry(asDraft, { kind: 'custom', sectionKey: 'cs-1a2b3c4d', key: customKey }).customSections[0].entries.length, 0);
  const added = draft.appendEntry(asDraft, { kind: 'languages' }, draft.emptyEntry('languages'));
  assert.equal(added.languages.length, 2);
  assert.deepEqual(draft.entriesOf(added, { kind: 'languages' }), added.languages);

  assert.equal(draft.entryCount(asDraft, 'summary'), 1);
  assert.equal(draft.entryCount({ ...asDraft, summary: ' ' }, 'summary'), 0);
  assert.equal(draft.entryCount(asDraft, 'skills'), 2);
  assert.equal(draft.entryCount(asDraft, 'softSkills'), 1);
  assert.equal(draft.entryCount(asDraft, 'interests'), 2);
  assert.equal(draft.entryCount(asDraft, 'experience'), 1);
  assert.equal(draft.entryCount(asDraft, 'custom:cs-1a2b3c4d'), 1);
  assert.equal(draft.entryCount(asDraft, 'custom:gone'), 0);
  assert.equal(draft.entryCount(asDraft, 'bogus'), 0);

  // Adding a section: the shown order becomes the stored one, with the new section last.
  const shown = ['summary', 'experience', 'education'];
  assert.deepEqual(draft.addSectionKind(asDraft, 'awards', shown).sectionOrder, ['summary', 'experience', 'education', 'awards']);
  assert.deepEqual(draft.addSectionKind(asDraft, 'summary', shown).sectionOrder, ['experience', 'education', 'summary']);
  const withCustom = draft.addCustomSection(asDraft, 'cs-feedbeef', 'Talks', shown);
  assert.deepEqual(withCustom.sectionOrder, ['summary', 'experience', 'education', 'custom:cs-feedbeef']);
  assert.deepEqual(withCustom.customSections.at(-1), { key: 'cs-feedbeef', title: 'Talks', entries: [] });
  // Removing one: out of the order and its content with it.
  const removedKind = draft.removeSection(asDraft, 'projects', [...shown, 'projects']);
  assert.deepEqual(removedKind.sectionOrder, shown);
  assert.deepEqual(removedKind.projects, []);
  const removedCustom = draft.removeSection(asDraft, 'custom:cs-1a2b3c4d', [...shown, 'custom:cs-1a2b3c4d']);
  assert.deepEqual(removedCustom.sectionOrder, shown);
  assert.deepEqual(removedCustom.customSections, []);
  assert.deepEqual(draft.removeSection(asDraft, 'interests', ['interests']).interests, []);

  // Whether the template prints a section: by kind, 'custom' for a custom one.
  const template = { printsSections: ['summary', 'experience', 'projects', 'custom'] };
  assert.equal(draft.templatePrintsSection(template, 'projects'), true);
  assert.equal(draft.templatePrintsSection(template, 'languages'), false);
  assert.equal(draft.templatePrintsSection(template, 'custom:cs-1a2b3c4d'), true);
  assert.equal(draft.templatePrintsSection({ printsSections: ['summary'] }, 'custom:cs-1'), false);
});

// -- Write with AI ------------------------------------------------------------ //

test("the editor's Write with AI helpers: the task, the route's own refusal, a request the route reads, the answer, the count line", () => {
  useTempStorage('frontend-editor-helpers-bullets');
  const draft = loadFrontendModule('lib/profileDraft.ts');
  const bullets = require('../dist/services/entryBullets');

  assert.equal(draft.MAX_TAILORED_BULLETS, bullets.MAX_ENTRY_BULLETS);
  assert.equal(draft.bulletsTask(''), 'write');
  assert.equal(draft.bulletsTask('\n  \n'), 'write');
  assert.equal(draft.bulletsTask('Shipped it'), 'improve');

  // The blocker is the route's `entry-incomplete` refusal: null exactly when
  // the route reads the entry, its sentence otherwise.
  const rows = {
    experience: [
      { title: 'Engineer', company: '' },
      { title: '', company: 'Acme' },
      { title: ' ', company: '' },
      {},
    ],
    project: [{ name: 'Lakehouse', role: '' }, { name: '', role: 'Lead' }, { name: '  ' }],
    volunteering: [{ role: 'Mentor', organization: '' }, { role: '', organization: 'Code Club' }, { role: '', organization: '' }],
  };
  for (const [kind, cases] of Object.entries(rows)) {
    for (const row of cases) {
      let refusal = null;
      try {
        bullets.readEntryForBullets(kind, row);
      } catch (error) {
        assert.equal(error.code, 'entry-incomplete');
        refusal = error.message;
      }
      assert.equal(draft.bulletsBlocker(kind, row), refusal, `${kind} ${JSON.stringify(row)}`);
    }
  }

  // The request: the fields that name the entry by kind, the rest as typed,
  // five facts about the person and never a contact detail; the route reads
  // it as it reads the test fixture.
  const person = {
    name: ' Sam Chen ',
    title: 'Engineer',
    totalYearsExperience: '7',
    summary: 'Builds things.',
    skills: ['Go', 'AWS'],
    contact: { email: 'never@sent' },
  };
  const role = {
    key: 'row-1',
    title: 'Engineer',
    company: 'Acme',
    startDate: '2020',
    endDate: 'Present',
    location: 'Remote',
    description: 'd',
    achievementsText: 'Shipped it\n\n Kept it up ',
    skills: ['Go'],
  };
  const request = draft.bulletsRequestFor('experience', role, person, 'improve', '  Lead with the numbers  ');
  assert.deepEqual(request, {
    kind: 'experience',
    entry: {
      title: 'Engineer',
      company: 'Acme',
      startDate: '2020',
      endDate: 'Present',
      location: 'Remote',
      description: 'd',
      achievements: ['Shipped it', 'Kept it up'],
      skills: ['Go'],
    },
    profile: { name: 'Sam Chen', title: 'Engineer', totalYearsExperience: 7, summary: 'Builds things.', skills: ['Go', 'AWS'] },
    task: 'improve',
    instructions: 'Lead with the numbers',
  });
  assert.doesNotMatch(JSON.stringify(request), /never@sent|"key"/);
  const read = bullets.readEntryForBullets(request.kind, request.entry);
  assert.equal(read.title, 'Engineer');
  assert.equal(read.organization, 'Acme');
  assert.deepEqual(read.bullets, ['Shipped it', 'Kept it up']);
  assert.equal(bullets.readBulletsTask(request.task, read), 'improve');
  assert.deepEqual(bullets.readProfileForBullets(request.profile), request.profile);

  const project = draft.bulletsRequestFor('project', { key: 'r', name: 'Lakehouse', role: 'Lead', achievementsText: '' }, { ...person, totalYearsExperience: '' }, 'write', '');
  assert.deepEqual(project.entry, { name: 'Lakehouse', role: 'Lead', startDate: '', endDate: '', location: '', description: '', achievements: [], skills: [] });
  assert.equal('instructions' in project, false, 'no note, no field');
  assert.equal('totalYearsExperience' in project.profile, false);
  assert.equal(bullets.readEntryForBullets('project', project.entry).organization, 'Lead');
  const volunteering = draft.bulletsRequestFor('volunteering', { role: 'Mentor', organization: 'Code Club', achievementsText: '' }, person, 'write', '');
  assert.deepEqual([volunteering.entry.role, volunteering.entry.organization], ['Mentor', 'Code Club']);
  assert.equal(bullets.readEntryForBullets('volunteering', volunteering.entry).organization, 'Code Club');

  // The answer: strings only, trimmed, at most eight - the route never sends more.
  assert.deepEqual(draft.readBullets({ bullets: [' A ', '', 'B', 3, null] }), ['A', 'B']);
  assert.deepEqual(draft.readBullets({ bullets: Array.from({ length: 10 }, (_, i) => `b${i}`) }).length, 8);
  assert.deepEqual(draft.readBullets({}), []);
  assert.deepEqual(draft.readBullets(null), []);
  assert.deepEqual(draft.readBullets('bullets'), []);

  assert.equal(draft.bulletCountNote(''), null);
  assert.match(draft.bulletCountNote('One'), /^1 bullet\. .*at most 8/);
  assert.match(draft.bulletCountNote(Array.from({ length: 8 }, () => 'x').join('\n')), /^8 bullets\. /);
  assert.match(draft.bulletCountNote(Array.from({ length: 9 }, () => 'x').join('\n')), /^9 bullets\. .*at most 8 of them/);
});

// -- the Profiles pages: the template chooser and the cards ------------------ //

/*
 * lib/profileGallery.ts: the chooser's filters (a copy of the server's
 * categories), what a template's details say, the link from the chooser to
 * the editor and back, a card's "Edited ... ago", and what Duplicate and
 * Download hand the server - each run against the server's own code.
 */

const gallery = loadFrontendModule('lib/profileGallery.ts');
const SHIPPED_TEMPLATES = path.join(__dirname, '..', 'static', 'templates');

/** The built-in template files as shipped - not the saved ones an administrator may have beside them. */
function builtInTemplateFiles() {
  return fs
    .readdirSync(SHIPPED_TEMPLATES)
    .filter((file) => file.endsWith('.json'))
    .filter((file) => !JSON.parse(fs.readFileSync(path.join(SHIPPED_TEMPLATES, file), 'utf8')).source);
}

test("the chooser's categories are the server's, and its pills show only the ones some template is filed under", () => {
  const { TEMPLATE_CATEGORIES } = require('../dist/config/templateCategories');
  assert.deepEqual([...gallery.TEMPLATE_CATEGORIES], [...TEMPLATE_CATEGORIES]);
  for (const filter of ['all', ...TEMPLATE_CATEGORIES]) {
    assert.equal(typeof gallery.TEMPLATE_FILTER_LABELS[filter], 'string', filter);
  }
  assert.equal(gallery.TEMPLATE_FILTER_LABELS.all, 'All Templates');

  const templates = [{ id: 'a', category: 'modern' }, { id: 'b' }, { id: 'c', category: 'simple' }, { id: 'd', category: 'modern' }];
  assert.deepEqual(gallery.templateFilters(templates), ['all', 'simple', 'modern'], 'the server\'s order, no empty pill');
  assert.deepEqual(gallery.templateFilters([]), ['all']);
  assert.deepEqual(gallery.templatesForFilter(templates, 'all').map((template) => template.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(gallery.templatesForFilter(templates, 'modern').map((template) => template.id), ['a', 'd']);
  assert.deepEqual(gallery.templatesForFilter(templates, 'creative'), []);

  const shipped = builtInTemplateFiles().map((file) => JSON.parse(fs.readFileSync(path.join(SHIPPED_TEMPLATES, file), 'utf8')));
  assert.deepEqual(gallery.templateFilters(shipped), ['all', ...TEMPLATE_CATEGORIES], 'every pill has a built-in');
});

test('the details say only what the template does, and every template prints both layouts', async () => {
  assert.equal('startingLayout' in gallery, false, 'no template starts a profile on a layout of its own');

  assert.deepEqual(
    gallery.templateFeatures({
      supportsSoftSkills: true,
      supportsStrengths: true,
      printsSections: ['summary', 'experience', 'projects', 'languages', 'custom'],
      nativeSectionOrder: ['summary', 'experience', 'education'],
    }),
    [
      'A4 page, print-ready PDF',
      'Technical skills grouped under headings, or as one list',
      'Soft skills and strengths sections',
      'Projects, languages, awards and sections of your own',
      'Sections in the order you arrange them',
      'Switch to another template any time',
    ]
  );
  const only = (flags) =>
    gallery.templateFeatures({ supportsSoftSkills: false, supportsStrengths: false, printsSections: [], nativeSectionOrder: [], ...flags });
  assert.deepEqual(only({}), [
    'A4 page, print-ready PDF',
    'Technical skills grouped under headings, or as one list',
    'Switch to another template any time',
  ]);
  assert.ok(only({ supportsSoftSkills: true }).includes('A soft skills section'));
  assert.ok(!only({ supportsSoftSkills: true }).includes('A strengths section'));
  assert.ok(only({ supportsStrengths: true }).includes('A strengths section'));
  assert.ok(!only({ supportsStrengths: true }).includes('A soft skills section'));
  // One section of its own is no order to arrange; the added kinds need both.
  assert.ok(!only({ nativeSectionOrder: ['experience'] }).includes('Sections in the order you arrange them'));
  assert.ok(!only({ printsSections: ['projects'] }).includes('Projects, languages, awards and sections of your own'));

  // Every built-in, as the server reads it: each draws the added sections and
  // reorders, so its details say both - and none carries a list of layouts.
  const { staticDir } = useTempStorage('frontend-editor-helpers-gallery');
  fs.mkdirSync(path.join(staticDir, 'templates'), { recursive: true });
  for (const file of builtInTemplateFiles()) {
    fs.copyFileSync(path.join(SHIPPED_TEMPLATES, file), path.join(staticDir, 'templates', file));
  }
  const { getAllTemplates } = require('../dist/extractors/templateExtractor');
  const templates = await getAllTemplates();
  assert.equal(templates.length, builtInTemplateFiles().length);
  for (const template of templates) {
    const features = gallery.templateFeatures(template);
    assert.ok(features.includes('Technical skills grouped under headings, or as one list'), template.id);
    assert.ok(features.includes('Projects, languages, awards and sections of your own'), template.id);
    assert.ok(features.includes('Sections in the order you arrange them'), template.id);
    assert.equal('skillsLayouts' in template, false, template.id);
  }

  // The layouts the editor and the viewers offer are the server's own.
  const { isTechnicalSkillsLayout } = require('../dist/services/profileService');
  const draft = loadFrontendModule('lib/profileDraft.ts');
  assert.deepEqual([...draft.ALL_SKILLS_LAYOUTS], ['categorized', 'flat']);
  assert.ok(draft.ALL_SKILLS_LAYOUTS.every((layout) => isTechnicalSkillsLayout(layout)));
  assert.equal(isTechnicalSkillsLayout('sideways'), false);
  assert.deepEqual(Object.keys(draft.LAYOUT_LABELS).sort(), [...draft.ALL_SKILLS_LAYOUTS].sort());
});

test("a template's gallery page is asked for in either layout, by one path both viewers use", () => {
  assert.equal(gallery.templatePreviewPath('navy-rule', 'flat'), '/api/templates/navy-rule/preview?layout=flat');
  assert.equal(gallery.templatePreviewPath('navy-rule'), '/api/templates/navy-rule/preview?layout=categorized');
  assert.equal(gallery.templatePreviewPath('my template', 'categorized'), '/api/templates/my%20template/preview?layout=categorized');

  // The chooser's details and Admin -> Templates' View both draw the switch
  // and frame the page through it; neither builds the address by hand, and
  // Use this template carries the layout shown.
  const chooser = fs.readFileSync(path.join(SRC, 'components', 'profile', 'TemplateChooser.tsx'), 'utf8');
  const viewer = fs.readFileSync(path.join(SRC, 'app', 'admin', 'templates', 'page.tsx'), 'utf8');
  for (const [name, source] of [['TemplateChooser.tsx', chooser], ['admin/templates/page.tsx', viewer]]) {
    assert.ok(source.includes('templatePreviewPath('), `${name} frames the page through templatePreviewPath`);
    assert.ok(source.includes('aria-label="Technical skills"'), `${name} draws the Grouped / Plain switch`);
    assert.ok(source.includes('aria-pressed={layout === value}'), `${name}: the switch says which is on`);
    assert.equal(source.includes('/api/templates/${'), false, `${name} builds a template address by hand`);
  }
  assert.ok(chooser.includes('onUse(template, layout)'), 'Use this template carries the layout shown');
  assert.match(
    viewer,
    /role="group"\s+aria-label="Technical skills"[^>]*onClick=\{\(event\) => event\.stopPropagation\(\)\}/,
    "the viewer's switch keeps its clicks from the overlay, which closes on any click"
  );

  // Each layout in a frame of its own: a loaded frame sent to another address
  // adds a browser-history entry per press, and Back then turned the page back
  // under the switch (test/e2e/skills-layouts.js presses it and counts).
  const thumb = fs.readFileSync(path.join(SRC, 'components', 'profile', 'PageThumb.tsx'), 'utf8');
  assert.match(thumb, /<iframe\s+key=\{src\b/, "the details' page frame is keyed by its address");
  assert.match(viewer, /<iframe\s+key=\{previewUrl\}/, "the viewer's frame is keyed by its address");
  // A dialog like the details: Escape for the top one and the one scroll lock.
  assert.ok(viewer.includes('useDialogLayer(true, onClose)'), 'the viewer joins the dialog stack');
});

test("the chooser's link to the editor reads back as the same choice, and a template not offered shows the chooser again", () => {
  const offered = [{ id: 'classic-serif' }, { id: 'navy-rule' }];
  const read = (href) => {
    const url = new URL(href, 'http://localhost');
    assert.equal(url.pathname, gallery.NEW_PROFILE_PATH);
    return gallery.readStartChoice({ template: url.searchParams.get('template'), layout: url.searchParams.get('layout') }, offered);
  };

  assert.equal(gallery.startProfileHref('classic-serif'), '/admin/profiles/new?template=classic-serif');
  assert.equal(gallery.startProfileHref('navy-rule', 'flat'), '/admin/profiles/new?template=navy-rule&layout=flat');
  for (const [id, layout] of [['classic-serif', 'categorized'], ['classic-serif', 'flat'], ['navy-rule', 'categorized'], ['navy-rule', 'flat']]) {
    assert.deepEqual(read(gallery.startProfileHref(id, layout)), { templateId: id, layout });
  }
  // Every template prints both layouts: the one asked for is the one it starts with.
  assert.deepEqual(read('/admin/profiles/new?template=navy-rule&layout=flat'), { templateId: 'navy-rule', layout: 'flat' });
  assert.deepEqual(read('/admin/profiles/new?template=navy-rule'), { templateId: 'navy-rule', layout: 'categorized' });
  assert.deepEqual(read('/admin/profiles/new?template=classic-serif&layout=sideways'), { templateId: 'classic-serif', layout: 'categorized' });
  // No template, or one not offered (disabled or deleted since): the chooser.
  assert.equal(read('/admin/profiles/new'), null);
  assert.equal(read('/admin/profiles/new?template=gone'), null);
  assert.equal(read('/admin/profiles/new?template=gone&layout=flat'), null);
  assert.equal(read('/admin/profiles/new?template=Classic-Serif'), null, 'an id is matched as its file carries it');
  // `template=` alone starts with none, in the layout asked for.
  assert.deepEqual(read(gallery.START_WITHOUT_TEMPLATE_HREF), { templateId: '', layout: 'categorized' });
  assert.deepEqual(read('/admin/profiles/new?template=&layout=flat'), { templateId: '', layout: 'flat' });
  assert.deepEqual(read('/admin/profiles/new?template=%20%20'), { templateId: '', layout: 'categorized' });

  // The editor's first draft is a blank one on that template and layout, and its save sends them.
  const draft = loadFrontendModule('lib/profileDraft.ts');
  const started = draft.draftForNewProfile({ templateId: 'navy-rule', layout: 'flat' });
  assert.equal(started.preferredTemplate, 'navy-rule');
  assert.equal(started.settings.technicalSkillsLayout, 'flat');
  assert.deepEqual(
    { ...started, preferredTemplate: '', settings: { ...started.settings, technicalSkillsLayout: 'categorized' } },
    draft.draftFromProfile(null),
    'nothing else differs from a blank profile'
  );
  assert.equal(draft.draftForNewProfile({ templateId: '', layout: 'categorized' }).preferredTemplate, '');

  useTempStorage('frontend-editor-helpers-start');
  const { normalizeProfilePayload } = require('../dist/services/profileService');
  const saved = normalizeProfilePayload(draft.draftToPayload(started, {}, []));
  assert.equal(saved.preferredTemplate, 'navy-rule');
  assert.equal(saved.profileSettings.technicalSkillsLayout, 'flat');
});

test('a card says when its profile was edited the way FlowCV does, and leaves an older date to the page', () => {
  const now = Date.parse('2026-10-19T12:00:00.000Z');
  const at = (ms) => new Date(now - ms).toISOString();
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  assert.equal(gallery.editedAgo(at(0), now), 'Edited just now');
  assert.equal(gallery.editedAgo(at(59_000), now), 'Edited just now');
  assert.equal(gallery.editedAgo(at(MINUTE), now), 'Edited 1 minute ago');
  assert.equal(gallery.editedAgo(at(59 * MINUTE), now), 'Edited 59 minutes ago');
  assert.equal(gallery.editedAgo(at(HOUR), now), 'Edited 1 hour ago');
  assert.equal(gallery.editedAgo(at(6 * HOUR + 59 * MINUTE), now), 'Edited 6 hours ago');
  assert.equal(gallery.editedAgo(at(DAY), now), 'Edited 1 day ago');
  assert.equal(gallery.editedAgo(at(7 * DAY - 1), now), 'Edited 6 days ago');
  assert.equal(gallery.editedAgo(at(7 * DAY), now), null, 'a week or more: the date');
  assert.equal(gallery.editedAgo(new Date(now + 5 * MINUTE).toISOString(), now), 'Edited just now', 'a clock behind the server');
  for (const unreadable of ['', undefined, 'not a time']) assert.equal(gallery.editedAgo(unreadable, now), null);
});

test("Duplicate sends a profile's whole content as a new one, without its id, template or switch; Download is a file Import JSON takes back", () => {
  useTempStorage('frontend-editor-helpers-duplicate');
  const { normalizeProfilePayload } = require('../dist/services/profileService');
  const { buildImportedProfiles } = require('../dist/services/profileImport');
  const original = storedProfile();
  const stored = {
    ...original,
    disabled: true,
    profileSettings: { ...original.profileSettings, resumeFileNameTemplate: '{{profile_name}}_cv', ai: { modelId: 'gone' } },
  };

  const body = gallery.duplicateProfileBody(stored, {});
  for (const key of ['id', 'createdAt', 'updatedAt', 'preferredTemplate', 'disabled']) assert.equal(key in body, false, key);
  assert.deepEqual(body.profileSettings.ai, {}, 'the model choice as it may be saved');
  assert.equal(body.profileSettings.resumeFileNameTemplate, '{{profile_name}}_cv');
  assert.deepEqual(stored.profileSettings.ai, { modelId: 'gone' }, 'the profile itself is not changed');

  const copy = normalizeProfilePayload(body);
  for (const key of ['name', 'title', 'summary', 'skills', 'softSkills', 'projects', 'languages', 'interests', 'customSections', 'sectionOrder']) {
    assert.deepEqual(copy[key], stored[key], key);
  }
  assert.deepEqual(copy.experience[0].achievements, stored.experience[0].achievements);
  assert.equal(copy.preferredTemplate, '', 'drawn with default until one is chosen');
  assert.equal(copy.disabled, false);
  assert.equal(copy.profileSettings.includeStrengths, true);
  assert.equal(copy.profileSettings.resumeFileNameTemplate, '{{profile_name}}_cv');

  assert.equal(gallery.profileFileName({ name: 'Sam Chen' }), 'sam-chen.json');
  assert.equal(gallery.profileFileName({ name: '  José  Núñez / PM ' }), 'josé-núñez-pm.json');
  assert.equal(gallery.profileFileName({ name: '李雷' }), '李雷.json');
  assert.equal(gallery.profileFileName({ name: '' }), 'profile.json');
  assert.equal(gallery.profileFileName({ name: '???' }), 'profile.json');
  assert.ok(gallery.profileFileName({ name: 'x'.repeat(200) }).length <= 65);

  const text = gallery.profileFileText(stored);
  assert.ok(text.endsWith('\n'));
  const [imported] = buildImportedProfiles(JSON.parse(text), { idExists: () => false, newId: () => 'fresh' });
  assert.equal(imported.profile.id, stored.id, 'the id is kept while it is free');
  assert.deepEqual(imported.profile.projects, stored.projects);
  assert.deepEqual(imported.profile.sectionOrder, stored.sectionOrder);
  const [again] = buildImportedProfiles(JSON.parse(text), { idExists: () => true, newId: () => 'fresh' });
  assert.equal(again.profile.id, 'fresh', 'and never overwrites one');
});
