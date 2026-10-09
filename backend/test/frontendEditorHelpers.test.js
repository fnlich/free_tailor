const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ts = require('typescript');

/**
 * The profile editor's and the builder's decisions that need no browser:
 * the preview's scale width (the shake), what an unticked section keeps, the
 * sample-text notice and placeholders, and which running batch the builder
 * picks back up. Loaded the way frontendHelpers.test.js loads its modules:
 * transpiled with the backend's TypeScript, importing nothing at runtime.
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
