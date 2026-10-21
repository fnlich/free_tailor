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
 *  - who an Order Immediately builds for (lib/runChoices.ts) against the
 *    server's own lock (`assertProfileScopeAllowed`): every target the dialog
 *    leaves open to a Default account is one the server takes, and every
 *    locked one would be refused for more than one profile;
 *  - the pages as written: Build Resumes draws the cost line and the receipt
 *    from the shared components rather than its own copies, and the order
 *    dialog sends an ORDER, only after the spend confirm, through the shared
 *    pieces.
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

test("who an order builds for: every target left open to a Default account is one the server takes, every locked one it refuses", () => {
  const runChoices = choices();
  const { assertProfileScopeAllowed } = require('../dist/middleware/auth');
  const profiles = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
  const groups = [{ id: 'g1', profileIds: ['p1', 'p3'] }, { id: 'g2', profileIds: ['p2'] }];
  const accounts = {
    default: { role: 'user', subscription: 'default' },
    premium: { role: 'user', subscription: 'premium' },
    admin: { role: 'admin', subscription: 'default' },
  };
  const refusedBy = (account, picked) => {
    try {
      assertProfileScopeAllowed(account, { profileIds: picked.map((profile) => profile.id), resolvedCount: picked.length });
      return null;
    } catch (error) {
      return error.code ?? error.message;
    }
  };
  const subscriptions = loadFile(path.join(SRC, 'lib', 'subscriptions.ts'));
  assert.deepEqual([...runChoices.TARGET_KINDS], ['single', 'several', 'all', 'group']);
  for (const [name, account] of Object.entries(accounts)) {
    const manyProfiles = subscriptions.canBuildForManyProfiles(account);
    for (const kind of runChoices.TARGET_KINDS) {
      for (const choice of [
        { kind, profileId: 'p2', profileIds: ['p3', 'p1'], groupId: 'g1' },
        { kind, profileId: 'p1', profileIds: ['p2'], groupId: 'g2' },
      ]) {
        const inEffect = { ...choice, kind: runChoices.targetInEffect(choice.kind, manyProfiles) };
        const picked = runChoices.targetProfiles(inEffect, profiles, groups);
        // What the dialog sends is always accepted: a Default account's locked choice is in effect its single profile.
        assert.equal(refusedBy(account, picked), null, `${name} ${JSON.stringify(choice)}`);
        // And what it locks really is locked: the choice as made, for more than one profile, is refused below Premium.
        const asMade = runChoices.targetProfiles(choice, profiles, groups);
        if (!manyProfiles && runChoices.isMultiProfileTarget(kind) && asMade.length > 1) {
          assert.equal(refusedBy(account, asMade), 'subscription-too-low', `${name} ${JSON.stringify(choice)}`);
        }
      }
    }
  }
  // The starting target is Build Resumes' own: the administrator's default, Single below Premium.
  const settings = { defaultResumeSelection: 'group', defaultProfileId: 'p2', defaultGroupId: 'g1' };
  assert.deepEqual(runChoices.startingTarget(settings, profiles, groups, true), { kind: 'group', profileId: 'p2', groupId: 'g1' });
  assert.deepEqual(runChoices.startingTarget(settings, profiles, groups, false), { kind: 'single', profileId: 'p2', groupId: '' });
  assert.deepEqual(runChoices.defaultRunFormat({ defaultResumeDocxEnabled: false, defaultCoverLetterDocxEnabled: true }), {
    format: 'pdf',
    includeCoverLetterDocx: true,
  });
});

test('Build Resumes and Find Jobs share the cost line, the receipt and the targets; the order dialog places an ORDER only after the spend confirm', () => {
  const builder = codeOf('app/page.tsx');
  assert.match(builder, /import CostLine, \{ type CreditShortfall \} from '@\/components\/builder\/CostLine';/);
  assert.match(builder, /import OrderReceipt, \{ placedOrderFrom, type PlacedOrder \} from '@\/components\/orders\/OrderReceipt';/);
  assert.doesNotMatch(builder, /function (CostLine|OrderReceipt)\b|const RECEIPT_POLL_MS/, 'no copy of its own');

  const dialog = codeOf('app/jobs/OrderJobsDialog.tsx');
  assert.match(dialog, /from '@\/components\/builder\/ProfileTargets'/);
  assert.match(dialog, /from '@\/components\/builder\/CostLine'/);
  // The order offers Several profiles; Build Resumes' sheet mode keeps its three cards.
  assert.match(dialog, /selectedProfileIds=\{target\.profileIds \?\? \[\]\}/);
  assert.match(dialog, /onProfileIdsChange=/);
  assert.doesNotMatch(builder, /selectedProfileIds=|onProfileIdsChange=/);
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
  // A refusal for the subscription opens the lock, worded from the refusal; a 402 is the cost line's shortfall.
  assert.match(dialog, /isSubscriptionTooLow\(caught\)\) \{\s*\/?\/?[^\n]*\n?\s*locked\.open\(describeTooLowRefusal\(\)\)/);
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
