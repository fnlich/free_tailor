const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ts = require('typescript');

/**
 * The browser's half of Find Jobs (/jobs) that is not the lake's own words
 * (those are frontendJobLake.test.js's):
 *
 *  - the MultiSelect kit component's decisions (lib/multiSelect.ts): which
 *    options a typed filter leaves, choosing past a cap, typed text split
 *    into values, where the active option moves, what is announced;
 *  - who an Order Immediately builds for (lib/runChoices.ts): ONE profile in
 *    one of three build modes, on every subscription - the request the dialog
 *    sends is quoted by the real generation route for a Default account in
 *    each mode, and the list-of-profiles shape the old dialog sent is refused;
 *  - the pages as written: Build Resumes draws the cost line, the receipt,
 *    the profile select and the mode cards from the shared components rather
 *    than its own copies, and the order dialog sends an ORDER, only after the
 *    spend confirm, through the shared pieces.
 *
 * The frontend has no test runner, so the modules are transpiled with the
 * backend's TypeScript and loaded with a resolver that follows only other
 * pure frontend modules (the frontendHelpers pattern).
 */

const SRC = path.join(__dirname, '..', '..', 'frontend', 'src');
const cache = new Map();

function loadFile(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  });
  const module = { exports: {} };
  cache.set(file, module);
  const requireFrontend = (specifier) => {
    const base = specifier.startsWith('@/')
      ? path.join(SRC, specifier.slice(2))
      : specifier.startsWith('.')
        ? path.resolve(path.dirname(file), specifier)
        : null;
    const target = base && [`${base}.ts`, `${base}.tsx`].find((candidate) => fs.existsSync(candidate));
    if (!target) throw new Error(`${path.relative(SRC, file)} imports ${specifier}; these helpers import only other pure frontend modules`);
    return loadFile(target);
  };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, requireFrontend);
  return module.exports;
}

const multi = () => loadFile(path.join(SRC, 'lib', 'multiSelect.ts'));
const choices = () => loadFile(path.join(SRC, 'lib', 'runChoices.ts'));

/** A source file with its comments taken out, so a sentence about a thing is not mistaken for the thing. */
function codeOf(relative) {
  return fs
    .readFileSync(path.join(SRC, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

test('a MultiSelect filters its list by every word typed, and chooses up to its cap, each value once', () => {
  const ms = multi();
  const options = [
    { id: 'backend', label: 'Backend', group: 'Engineering' },
    { id: 'frontend', label: 'Frontend', group: 'Engineering' },
    { id: 'site-reliability-engineering', label: 'Site reliability engineering (SRE)', group: 'Operations' },
  ];
  assert.deepEqual(ms.matchingOptions(options, '').map((option) => option.id), ['backend', 'frontend', 'site-reliability-engineering']);
  assert.deepEqual(ms.matchingOptions(options, '  END ').map((option) => option.id), ['backend', 'frontend'], 'case and spaces aside');
  assert.deepEqual(ms.matchingOptions(options, 'reliability sre').map((option) => option.id), ['site-reliability-engineering'], 'every word');
  assert.deepEqual(ms.matchingOptions(options, 'site-reliab').map((option) => option.id), ['site-reliability-engineering'], 'the id too');
  assert.deepEqual(ms.matchingOptions(options, 'quantum'), []);

  assert.deepEqual(ms.toggleValue(['a'], 'b'), { values: ['a', 'b'], refused: false });
  assert.deepEqual(ms.toggleValue(['a', 'b'], 'a'), { values: ['b'], refused: false }, 'chosen already: un-chosen');
  assert.deepEqual(ms.toggleValue(['a', 'b'], 'c', 2), { values: ['a', 'b'], refused: true }, 'past the cap: nothing');
  assert.deepEqual(ms.toggleValue(['a', 'b'], 'b', 2), { values: ['a'], refused: false }, 'un-choosing is never refused');

  // Typed text: Full text splits on commas; Company never does.
  const split = /[,;\n]+/;
  assert.deepEqual(ms.addTypedValue(['Rust'], 'machine   learning, rust;Go\n', { split }), {
    values: ['Rust', 'machine learning', 'Go'],
    added: ['machine learning', 'Go'],
    full: false,
  });
  assert.deepEqual(ms.addTypedValue([], ' OpenAI,  Inc. '), { values: ['OpenAI, Inc.'], added: ['OpenAI, Inc.'], full: false });
  assert.deepEqual(ms.addTypedValue(['a'], 'b, c, d', { split, max: 2 }), { values: ['a', 'b'], added: ['b'], full: true });
  assert.deepEqual(ms.addTypedValue(['a'], '  ,; ', { split }), { values: ['a'], added: [], full: false });

  // The active option wraps, and there is none to move to in an empty list.
  assert.deepEqual([ms.nextActiveIndex(-1, 3, 1), ms.nextActiveIndex(0, 3, 1), ms.nextActiveIndex(2, 3, 1)], [0, 1, 0]);
  assert.deepEqual([ms.nextActiveIndex(-1, 3, -1), ms.nextActiveIndex(0, 3, -1), ms.nextActiveIndex(9, 3, 1)], [2, 2, 0]);
  assert.equal(ms.nextActiveIndex(0, 0, 1), -1);

  // Chosen from a list the typing filtered: the typing goes, the list is whole
  // again, and the active option is still the one chosen - Site reliability,
  // third in the whole list, never Backend, first, which stood where it stood.
  const filtered = ms.matchingOptions(options, 'sre');
  assert.equal(filtered[0].id, 'site-reliability-engineering');
  assert.equal(ms.activeAfterChoice(options, filtered[0].id, 0, 'sre', true), 2);
  assert.equal(ms.matchingOptions(options, '')[2].id, 'site-reliability-engineering');
  assert.equal(ms.activeAfterChoice(options, 'frontend', 1, '', true), 1, 'nothing typed: the list did not change');
  assert.equal(ms.activeAfterChoice(options, 'frontend', 0, 'fro', false), -1, "the server's matches go with the typing");

  // How far the list scrolls to show the active option: not at all when it is in view, up or down just enough.
  const view = { top: 100, bottom: 356 };
  assert.equal(ms.revealOffset(view, { top: 120, bottom: 156 }), 0);
  assert.equal(ms.revealOffset(view, { top: 340, bottom: 376 }), 20, 'below: down to its bottom edge');
  assert.equal(ms.revealOffset(view, { top: 64, bottom: 100 }), -36, 'above: up to its top edge');
  assert.equal(ms.revealOffset(view, { top: 90, bottom: 400 }), -10, 'taller than the list: its top first');

  assert.equal(ms.valueLabel(options, 'backend'), 'Backend');
  assert.equal(ms.valueLabel(options, 'Acme Corp'), 'Acme Corp', 'a typed value is its own label');
  assert.equal(ms.describeChange('Job field', [], ['backend'], options), 'Added Backend. Job field: 1 chosen.');
  assert.equal(ms.describeChange('Job field', ['backend', 'frontend'], ['frontend'], options), 'Removed Backend. Job field: 1 chosen.');
  assert.equal(ms.describeChange('Job field', ['backend'], [], options), 'Removed Backend. Job field: none chosen.');
  assert.equal(ms.describeChange('Job field', ['backend'], ['backend'], options), '');
  assert.equal(ms.fullSentence(25), 'You can choose at most 25 here.');
});

test("the MultiSelect component draws the combobox the e2e scripts and a screen reader expect, from the lib's decisions", () => {
  const source = codeOf('components/ui/MultiSelect.tsx');
  for (const piece of [
    /role="combobox"/,
    /aria-expanded=\{open\}/,
    /aria-controls=\{listId\}/,
    /aria-activedescendant=/,
    /role="listbox" aria-multiselectable="true"/,
    /role="option"/,
    /aria-selected=\{selected\}/,
    /data-option-label/,
    /aria-live="polite"/,
    /aria-label=\{`Remove \$\{text\}`\}/,
    /data-multiselect/,
    // Escape inside a dialog closes the list, never the dialog: the page's listener sits on the document too.
    /event\.nativeEvent\.stopImmediatePropagation\(\)/,
    /useDismissable\(open, close, root\)/,
    // The active option is scrolled into the list's own view - the list's scrollTop, never the page's.
    /box\.scrollTop \+= offset/,
  ]) {
    assert.match(source, piece, piece.source);
  }
  assert.doesNotMatch(source, /scrollIntoView/, 'which would move the page too');
  for (const helper of [
    'matchingOptions',
    'toggleValue',
    'addTypedValue',
    'nextActiveIndex',
    'activeAfterChoice',
    'revealOffset',
    'valueLabel',
    'describeChange',
  ]) {
    assert.match(source, new RegExp(`\\b${helper}\\(`), `MultiSelect uses ${helper}`);
  }
  // Its look is the kit's .tl-multiselect* rules - tokens, and no dark: variant or bare utility the shim names.
  assert.doesNotMatch(source, /\bdark:|\bbg-white\b|\btext-gray-|\bshadow\b|(?<![-\w])border(?![-\w])/);
  const css = fs.readFileSync(path.join(SRC, 'app', 'globals.css'), 'utf8');
  for (const rule of ['.tl-multiselect-box', '.tl-multiselect-chip', '.tl-multiselect-input', '.tl-multiselect-list', '.tl-multiselect-option']) {
    assert.ok(css.includes(`${rule} {`), rule);
  }
  assert.match(css, /html\.dark input\.tl-multiselect-input:not\(\[type='radio'\]\):not\(\[type='checkbox'\]\):not\(\[type='color'\]\)/);
  assert.ok(!css.includes('tl-nav-out'), 'the rail no longer has a row that leaves the app');
});

test("who an order builds for: one profile and each of the three modes is open to a Default account, and the server takes exactly what the dialog sends", async () => {
  const runChoices = choices();
  const { lakeOrderJobs } = loadFile(path.join(SRC, 'lib', 'jobLakeDisplay.ts'));
  const { BUILD_MODES } = loadFile(path.join(SRC, 'lib', 'buildModes.ts'));
  const backendModes = require('../dist/config/buildModes');
  assert.deepEqual([...BUILD_MODES], [...backendModes.BUILD_MODES]);

  // A served install with a Default account that has one profile of two resumes.
  const helpers = require('./helpers');
  const storage = helpers.useTempStorage('find-jobs-order-modes');
  const users = require('../dist/database/userRepository');
  const config = require('../dist/config/aiModelConfig');
  const { attachUser } = require('../dist/middleware/auth');
  const express = require('express');
  config.invalidateSettingsCache();
  const alice = users.createUser({ email: 'alice@example.com' });
  assert.equal(alice.subscription, 'default');
  assert.equal(alice.role, 'user');
  const resumeInput = (id, title) => ({
    id,
    name: 'Jane Doe',
    title,
    skills: [],
    contact: { email: 'jane@example.com', phone: '555-0100', location: 'Remote' },
    summary: 'A summary.',
    experience: [],
    strengths: [],
    education: [],
  });
  const seeded = helpers.seedProfileWithResumes(alice, 'Jane Doe', [
    resumeInput('jane-data', 'Data Engineer'),
    resumeInput('jane-backend', 'Backend Engineer'),
  ]);
  const analysisId = helpers.storeJobAnalysis({}, { jobDescription: 'A posting for the order dialog test.', jobLink: 'https://jobs.example.com/a/1' });
  await config.updateAppSettings({ suitablePriceUsd: '0.010', partialPriceUsd: '0.030', fullPriceUsd: '0.020' });

  const token = users.createSession(alice.id);
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/generation', require('../dist/routes/generation').default);
  const server = app.listen(0);
  const post = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/generation${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    // What the dialog starts on, from the lib's own choices: the first offered profile, the administrator's default mode.
    const summaries = [{ id: seeded.profileId }];
    assert.equal(runChoices.startingProfileId({ defaultProfileId: '' }, summaries), seeded.profileId);
    assert.equal(runChoices.profileBlocker(seeded.profileId, summaries), null);
    const { jobs } = lakeOrderJobs([
      { company: 'Acme', title: 'Backend Engineer', url: 'https://jobs.example.com/a/1', analysisId },
      { company: 'Ghost', title: 'Nothing', url: '', analysisId: null },
    ]);
    assert.equal(jobs.length, 1, 'a job with no stored analysis is left out, as the dialog says');

    // Every mode is open to a Default account: the request the dialog sends (a
    // profile, a mode, the jobs) is a quote the server answers, in that mode,
    // at that mode's price - never a 403 for the subscription.
    const prices = { suitable: 10, partial: 30, full: 20 };
    for (const mode of BUILD_MODES) {
      const request = { buildMode: mode, profileId: seeded.profileId, jobs };
      const quote = await post('/quote', request);
      assert.equal(quote.status, 200, `${mode}: ${JSON.stringify(quote.body)}`);
      assert.equal(quote.body.buildMode, mode);
      assert.equal(quote.body.resumes, 1);
      assert.equal(quote.body.costMilli, prices[mode], mode);
      assert.equal(quote.body.pricePerResumeMilli, prices[mode], mode);
    }

    // What the dialog no longer sends is what the server refuses: a list of profiles is not a profile.
    for (const retired of [{ profileIds: [seeded.profileId] }, { profileIds: [] }, { resumeIds: ['jane-data'] }]) {
      const refused = await post('/quote', { buildMode: 'partial', jobs, ...retired });
      assert.equal(refused.status, 400, JSON.stringify(retired));
      assert.equal(refused.body.code, 'one-profile-per-run', JSON.stringify(retired));
    }
    // A profile that is not the account's own is a 404, not a lock.
    const stranger = await post('/quote', { buildMode: 'partial', profileId: 'not-mine', jobs });
    assert.equal(stranger.status, 404);
    assert.equal(stranger.body.code, 'profile-not-found');
  } finally {
    server.close();
  }

  // The files an order makes follow the administrator's builder defaults.
  assert.deepEqual(runChoices.defaultRunFormat({ defaultResumeDocxEnabled: false, defaultCoverLetterDocxEnabled: true }), {
    format: 'pdf',
    includeCoverLetterDocx: true,
  });
  void storage;
});

test('Build Resumes and Find Jobs share the cost line, the receipt, the profile choice and the mode cards; the order dialog places an ORDER only after the spend confirm', () => {
  const builder = codeOf('app/page.tsx');
  assert.match(builder, /import CostLine, \{ type CreditShortfall \} from '@\/components\/builder\/CostLine';/);
  assert.match(builder, /import OrderReceipt, \{ placedOrderFrom, type PlacedOrder \} from '@\/components\/orders\/OrderReceipt';/);
  assert.doesNotMatch(builder, /function (CostLine|OrderReceipt)\b|const RECEIPT_POLL_MS/, 'no copy of its own');

  const dialog = codeOf('app/jobs/OrderJobsDialog.tsx');
  assert.match(dialog, /from '@\/components\/builder\/CostLine'/);
  // One profile and one mode, drawn by the same two components on both pages;
  // the several-profile targets and their lock are gone from both.
  for (const [name, source] of [['Build Resumes', builder], ['the order dialog', dialog]]) {
    assert.match(source, /import BuildModeChoice from '@\/components\/builder\/BuildModeChoice';/, name);
    assert.match(source, /import ProfileSelector from '@\/components\/ProfileSelector';/, name);
    assert.match(source, /<BuildModeChoice\b/, name);
    assert.match(source, /<ProfileSelector\b/, name);
    assert.doesNotMatch(source, /ProfileTargets/, `${name}: no several-profile targets`);
    assert.doesNotMatch(source, /selectedProfileIds|onProfileIdsChange|profileIds\b/, `${name}: one profileId, never a list`);
    assert.doesNotMatch(
      source,
      /canBuildForManyProfiles|isSubscriptionTooLow|describeTooLowRefusal|useLockedFeature|hasSubscription|subscriptionAtLeast/,
      `${name}: nothing on a run is locked`
    );
  }
  assert.equal(fs.existsSync(path.join(SRC, 'components', 'builder', 'ProfileTargets.tsx')), false);
  // The dialog's ids and radios, for the browser scripts; the order's own radio group.
  assert.match(dialog, /id="order-profile"/);
  assert.match(dialog, /name="orderBuildMode"/);
  // The profiles are loaded on every tier, with no gate in front of the read.
  assert.match(dialog, /profilesApi\.getAll\(\)/);
  // The request is one profile and one mode, and the quote key follows both.
  assert.match(dialog, /buildMode, profileId: profile\.id, jobs/);
  assert.match(dialog, /const quoteKey = request \? `\$\{request\.profileId\}\|\$\{jobs\.length\}\|\$\{modelId \?\? ''\}\|\$\{buildMode\}` : '';/);
  // The sentences the dialog says when it cannot offer a profile.
  assert.match(dialog, /Your profiles could not be loaded/);
  assert.match(dialog, /Loading your profiles\.\.\./);
  assert.match(dialog, /You have no profile with an enabled resume\. Add one under Profiles first\./);
  assert.match(dialog, /profileBlocker\(profileId, profiles\)/);
  // Why it cannot be placed is said where the cost line stands, not only in a tooltip.
  assert.match(dialog, /aria-live="polite" data-order-blocker/);
  assert.match(dialog, /placedOrderFrom\(/);
  assert.match(dialog, /mode: 'order'/);
  assert.doesNotMatch(dialog, /mode: 'immediate'|tabId/, 'an order, never a run tied to this tab');
  // Place order asks first - an Order, priced by the server's quote of this very order - and only then submits.
  const asked = /spend\.ask\(\{ kind: 'order', title: 'Order', price: \(\) => estimateRun\(body, fallback\) \}, \(\) => void place\(body\)\)/;
  assert.match(dialog, asked);
  assert.equal((dialog.match(/generationApi\.submit\(/g) ?? []).length, 1);
  assert.ok(dialog.indexOf('const place = async') < dialog.search(asked), 'submit lives in `place`, which only the confirm starts');
  // A run is never refused for the subscription any more; a 402 is the cost line's shortfall.
  assert.match(dialog, /isInsufficientCredits\(caught\)/);

  const page = codeOf('app/jobs/page.tsx');
  assert.match(page, /<OrderReceipt\b/);
  assert.match(page, /<OrderJobsDialog\b/);
  assert.match(page, /jobLakeApi\.exportToSheet\(/);
  assert.match(page, /void refresh\(\)/, "the top bar's balance moves after an order");

  // A dialog closed while its price is worked out starts nothing: the confirm hook drops a start for a page that has gone.
  const confirm = codeOf('components/SpendConfirm.tsx');
  const hook = confirm.slice(confirm.indexOf('export function useSpendConfirm'));
  assert.match(hook, /return \(\) => \{\s*mounted\.current = false;\s*\};/);
  assert.ok(
    hook.search(/if \(!mounted\.current\) \{/) > hook.indexOf('await request.price()') &&
      hook.search(/if \(!mounted\.current\) \{/) < hook.indexOf('start();', hook.indexOf('await request.price()')),
    'checked after the price, before anything starts'
  );
});

test("Find Jobs' table: no row can widen a column past its narrowest, and a control the Tab key reaches under the held Details is scrolled clear of it - a pressed or tapped one never", () => {
  // A catalogue label ("Telecommunications", "Localization and internationalization"), a long title, a stated
  // salary or an address once widened their columns, and an administrator's table scrolled sideways at 1440px.
  const page = codeOf('app/jobs/page.tsx');
  assert.match(page, /<span className="font-medium text-ink wrap-anywhere">\{row\.company\}<\/span>/);
  assert.match(page, /<td className="min-w-\d+ wrap-anywhere hyphens-auto">\{row\.jobFieldLabel\}<\/td>/);
  assert.match(page, /<td className="min-w-\d+ wrap-anywhere">\{formatSalary\(row\.salary\)/);
  assert.match(page, /<td className="min-w-\d+ wrap-anywhere hyphens-auto">\{cells\.industry/);
  assert.match(page, /className="block max-w-\d+ truncate"/, 'Requested by is cut to its column');
  assert.match(codeOf('components/jobLake/LakeCells.tsx'), /const wrap = children \? 'wrap-anywhere' : 'break-all';/, 'a title breaks inside a word');
  assert.match(page, /<div className="tl-table-box" onFocus=\{keepFocusClearOfStickyEnd\}>/);
  assert.match(page, /<td data-align="right" data-sticky-end>/);

  // The box 16..374, the held column from 287 (a 390px phone); 8px kept clear either side.
  const { stickyEndShift, STICKY_END_GAP_PX } = loadFile(path.join(SRC, 'lib', 'stickyColumn.ts'));
  assert.equal(STICKY_END_GAP_PX, 8);
  const box = { left: 16, right: 374 };
  assert.equal(stickyEndShift(box, 287, { left: 120, right: 260 }), 0, 'clear already: nothing moves');
  assert.equal(stickyEndShift(box, 287, { left: 250, right: 317 }), 317 - 279, 'half under the column: rightwards, 8px short of it');
  assert.equal(stickyEndShift(box, 377, { left: 378, right: 446 }), 446 - 369, 'wholly under it, as a Tab walk at 480px left a Title link');
  assert.equal(stickyEndShift(box, 287, { left: 100, right: 400 }), 100 - 24, 'wider than the room: its start at the left edge');
  assert.equal(stickyEndShift(box, 287, { left: -40, right: 30 }), -40 - 24, 'cut off at the left edge: leftwards');
  assert.equal(stickyEndShift(box, 287, { left: 24, right: 279 }), 0, 'exactly the room: nothing moves');

  // Only a focus the keyboard made moves the box. A mouse press or a tap focuses the control on its way
  // down, and a box moved then took a half-hidden checkbox or Title link out from under the pointer: the
  // click landed on the cell, and the box went unticked, the link unopened.
  const { keepFocusClearOfStickyEnd } = loadFile(path.join(SRC, 'lib', 'stickyColumn.ts'));
  /** The box's scrollLeft (100 before) once a control at `rect` in a row is focused. */
  const focusOn = (rect, { keyboard, inDetails = false }) => {
    const scrollBox = { scrollLeft: 100, getBoundingClientRect: () => box };
    const control = {
      matches: (selector) => selector === ':focus-visible' && keyboard,
      getBoundingClientRect: () => rect,
      closest: (selector) => (selector === 'tr' ? row : null),
    };
    const held = { contains: (node) => inDetails && node === control, getBoundingClientRect: () => ({ left: 287, right: 374 }) };
    const row = { querySelector: (selector) => (selector === ':scope > [data-sticky-end]' ? held : null) };
    keepFocusClearOfStickyEnd({ currentTarget: scrollBox, target: control });
    return scrollBox.scrollLeft;
  };
  const halfUnder = { left: 250, right: 317 };
  const cutAtLeft = { left: -40, right: 30 };
  assert.equal(focusOn(halfUnder, { keyboard: true }), 100 + (317 - 279), 'Tab or Shift+Tab to a control half under Details scrolls it clear');
  assert.equal(focusOn(cutAtLeft, { keyboard: true }), 100 + (-40 - 24), 'and to one cut off at the left edge, back to it');
  assert.equal(focusOn(halfUnder, { keyboard: false }), 100, 'a press or a tap on a control half under Details leaves the box where it is');
  assert.equal(focusOn(cutAtLeft, { keyboard: false }), 100, 'and on a checkbox cut off at the left edge');
  assert.equal(focusOn({ left: 300, right: 360 }, { keyboard: true, inDetails: true }), 100, 'Details itself never moves the box');
});
