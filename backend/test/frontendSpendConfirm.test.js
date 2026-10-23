const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ts = require('typescript');

/**
 * The question asked before anything spends credit - the owner's alert, with
 * "Do not show again" (frontend/src/lib/spendConfirm.ts): when it is asked,
 * per kind of action and per browser; what it says the action costs; and that
 * every place that spends credit goes through it. Loaded the way
 * frontendHelpers.test.js loads its modules: transpiled with the backend's
 * TypeScript, importing nothing at runtime.
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

const spend = loadFrontendModule('lib/spendConfirm.ts');

/** A Map-backed Storage, so each test sees exactly what was written. */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/** Storage that throws on every call, as a blocked or private window's does. */
const throwingStorage = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('SecurityError');
  },
  removeItem() {
    throw new Error('SecurityError');
  },
};

const estimate = (overrides = {}) => ({ costMilli: 161, balanceMilli: 3_977, exempt: false, chargedOn: null, ...overrides });

// LF whatever the checkout wrote: on a CRLF one (git's autocrlf, the owner's
// Windows machine) a search for '\n  };\n' finds nothing, and a handler cut at
// "not found" ran to the end of the file, so its checks passed on the code of
// every handler after it.
const read = (relative) => fs.readFileSync(path.join(SRC, relative), 'utf8').replace(/\r\n/g, '\n');

/** A `const <name> = ...` handler of a page, up to the `};` that closes it at the component's indent. */
function handlerSource(source, name) {
  const start = source.indexOf(`const ${name} = `);
  assert.ok(start >= 0, `${name} is in the page`);
  const body = source.slice(start);
  const end = body.indexOf('\n  };\n');
  assert.ok(end > 0, `${name} ends where a handler does`);
  return body.slice(0, end);
}

test('"Do not show again" is remembered per kind of action, under keys of its own, and never under the old one', () => {
  assert.deepEqual([...spend.SPEND_KINDS], ['order', 'immediate', 'subscription']);
  assert.deepEqual(spend.SPEND_SKIP_KEYS, {
    order: 'freeTailor.spendConfirm.order.skip',
    immediate: 'freeTailor.spendConfirm.immediate.skip',
    subscription: 'freeTailor.spendConfirm.subscription.skip',
  });

  // The Generate Immediately confirm's older key is not read: a browser that
  // ticked it then is asked again, once, now that the confirm names the cost.
  const old = memoryStorage({ 'freeTailor.immediateConfirm.skip': '1' });
  assert.equal(spend.confirmSkipped('immediate', old), false);
  assert.doesNotMatch(read('lib/spendConfirm.ts').replace(/\/\*[\s\S]*?\*\//g, ''), /freeTailor\.immediateConfirm\.skip/);

  const browser = memoryStorage();
  for (const kind of spend.SPEND_KINDS) assert.equal(spend.confirmSkipped(kind, browser), false, kind);
  spend.skipConfirm('order', browser);
  assert.equal(spend.confirmSkipped('order', browser), true);
  // Ticking it on an order does not stop Generate Immediately or a subscription asking.
  assert.equal(spend.confirmSkipped('immediate', browser), false);
  assert.equal(spend.confirmSkipped('subscription', browser), false);
  assert.equal(browser.map.get('freeTailor.spendConfirm.order.skip'), '1');
});

test('storage that cannot be read keeps asking, and a flag that cannot be written is simply not remembered', () => {
  for (const kind of spend.SPEND_KINDS) {
    assert.equal(spend.confirmSkipped(kind, null), false);
    assert.equal(spend.confirmSkipped(kind, throwingStorage), false);
    assert.doesNotThrow(() => spend.skipConfirm(kind, throwingStorage));
    assert.doesNotThrow(() => spend.skipConfirm(kind, null));
  }
  // Anything but '1' is not a tick.
  assert.equal(spend.confirmSkipped('order', memoryStorage({ 'freeTailor.spendConfirm.order.skip': 'true' })), false);
});

test('who is asked: Generate Immediately always; an order or a subscription only when it takes credit, or might', () => {
  const cases = [
    // [what it costs, asked for an order / a subscription, asked for Generate Immediately]
    [estimate(), true, true],
    [estimate({ costMilli: null }), true, true], // could not be worked out: asked, never charged silently
    [estimate({ costMilli: 0 }), false, true], // free: Generate Immediately still carries the tab warning
    [estimate({ exempt: true }), false, true], // an administrator is never charged
    [estimate({ exempt: true, costMilli: null }), false, true],
    [estimate({ chargedOn: '2026-11-18T10:00:00.000Z', costMilli: 9_990 }), true, true], // taken at renewal
  ];
  for (const [given, spends, immediate] of cases) {
    assert.equal(spend.spendAlertNeeded(given), spends, JSON.stringify(given));
    assert.equal(spend.confirmNeeded('order', given), spends, JSON.stringify(given));
    assert.equal(spend.confirmNeeded('subscription', given), spends, JSON.stringify(given));
    assert.equal(spend.confirmNeeded('immediate', given), immediate, JSON.stringify(given));
  }
});

test('what the confirm says it costs: free, exempt, not known, later, now - and short, which blocks Proceed', () => {
  assert.deepEqual(spend.spendFigures(estimate({ exempt: true })), {
    state: 'exempt',
    costMilli: 161,
    balanceAfterMilli: null,
    shortMilli: 0,
    blocks: false,
  });
  assert.deepEqual(spend.spendFigures(estimate({ costMilli: null })), {
    state: 'unknown',
    costMilli: null,
    balanceAfterMilli: null,
    shortMilli: 0,
    blocks: false,
  });
  assert.deepEqual(spend.spendFigures(estimate({ costMilli: 0 })), {
    state: 'free',
    costMilli: 0,
    balanceAfterMilli: 3_977,
    shortMilli: 0,
    blocks: false,
  });
  // Now: the balance after, to the thousandth.
  assert.deepEqual(spend.spendFigures(estimate()), {
    state: 'now',
    costMilli: 161,
    balanceAfterMilli: 3_816,
    shortMilli: 0,
    blocks: false,
  });
  // Exactly the balance is not short.
  assert.equal(spend.spendFigures(estimate({ costMilli: 3_977 })).blocks, false);
  // Short now: Proceed would only be refused (402), so it is blocked.
  assert.deepEqual(spend.spendFigures(estimate({ costMilli: 161, balanceMilli: 50 })), {
    state: 'now',
    costMilli: 161,
    balanceAfterMilli: -111,
    shortMilli: 111,
    blocks: true,
  });
  // The balance not known: nothing to block on - the server decides.
  assert.equal(spend.spendFigures(estimate({ balanceMilli: null })).blocks, false);
  // Later - a switch at renewal, keeping a subscription: never blocks now, but says how short it is.
  const later = spend.spendFigures(estimate({ chargedOn: '2026-11-18T10:00:00.000Z', costMilli: 9_990, balanceMilli: 3_000 }));
  assert.deepEqual(later, { state: 'later', costMilli: 9_990, balanceAfterMilli: null, shortMilli: 6_990, blocks: false });
});

test("owner decision B4's question is kept word for word for Generate Immediately", () => {
  assert.equal(
    spend.IMMEDIATE_WARNING,
    'If you close the tab or the network drops, the run can be stopped. Would you like to proceed?'
  );
  // The dialog says it, and "Do not show again" - not the old "Don't show again".
  const dialog = read('components/SpendConfirm.tsx');
  assert.match(dialog, /\{IMMEDIATE_WARNING\}/);
  assert.match(dialog, />\s*Do not show again\s*</);
  assert.doesNotMatch(dialog, /Don(?:'|&apos;)t show again/);
  // Mounted only while open, so the box starts unticked every time.
  assert.match(dialog, /const dialog = open \? \(\s*<SpendConfirm/);
});

test('every way to spend credit asks first: Build Resumes runs and orders, and subscription changes', () => {
  const builder = read('app/page.tsx');
  // The old confirm, its skip key and its state are gone.
  assert.equal(fs.existsSync(path.join(SRC, 'components/ImmediateRunConfirm.tsx')), false);
  assert.doesNotMatch(builder, /ImmediateRunConfirm|withImmediateConfirm|confirmsImmediate|pendingImmediate/);
  assert.doesNotMatch(read('lib/immediateRun.ts'), /SKIP_IMMEDIATE_CONFIRM_KEY|confirmsImmediate|skipImmediateConfirm/);

  // One gate, and every run handler goes through it: the header's Generate
  // Immediately and Order, the one preview, the sheet panel. Nothing calls a
  // run straight from a press. (A run builds one profile, so there is no
  // multi-profile preview to finalise any more.)
  assert.match(builder, /const spend = useSpendConfirm\(\);/);
  assert.match(builder, /void spend\.ask\(/);
  assert.doesNotMatch(builder, /handleFinalizeGenerateMultiple|finalizeMultiple/);
  for (const [handler, run] of [
    ['handleGenerate', "runManual('immediate')"],
    ['handleOrderManual', "runManual('order')"],
    ['handleFinalizeGenerate', 'finalizeSingle()'],
    ['handleSheetRun', 'runSheet(kind, request, skippedNote, jobs.length)'],
  ]) {
    const source = handlerSource(builder, handler);
    assert.match(source, /confirmSpend\(/, `${handler} asks first`);
    assert.ok(source.includes(`() => void ${run}`), `${handler} starts ${run} only from the confirm`);
  }
  // A run is started from nowhere else.
  assert.equal((builder.match(/void runManual\(/g) ?? []).length, 2);
  assert.equal((builder.match(/void runSheet\(/g) ?? []).length, 1);

  // Finalising previews is quoted as it will be charged: with the content
  // the submission carries as well as each token. The server charges content
  // whose token has expired (a day on), or has none, at least the dearer
  // tailoring mode (the floor), so a quote sent the tokens alone priced the
  // cheaper mode the page names.
  for (const handler of ['handleFinalizeGenerate']) {
    const source = handlerSource(builder, handler);
    assert.match(source, /tailoredContentByResumeId:/, `${handler} quotes with the previewed content`);
    assert.match(source, /previewTokenByResumeId:/, `${handler} quotes with the preview tokens`);
  }

  // The confirm's "could not be worked out" sentence names the builder mode
  // whose price a resume is taken at, and no model: a model has no price.
  const confirmSource = read('components/SpendConfirm.tsx');
  const unknownCase = confirmSource.slice(confirmSource.indexOf("case 'unknown':"), confirmSource.indexOf("case 'later':"));
  assert.ok(unknownCase.includes('price per resume of the builder mode you chose'), 'the unknown-cost sentence names the mode');
  assert.doesNotMatch(unknownCase, /\bmodel\b/i, 'the unknown-cost sentence names no model');

  // While the confirm prices a run nothing is open yet: the run buttons wait,
  // and say why, rather than ignore a press in silence.
  assert.match(builder, /const runBusy = isGenerating \|\| spend\.pending;/);
  for (const button of [
    'onClick={handleGenerate}\n                    disabled={runBusy}',
    'onClick={handleOrderManual}\n                    disabled={spend.pending}',
  ]) {
    assert.ok(builder.includes(button), button);
  }
  assert.match(builder, /busy=\{runBusy\}\s+onRowsChange=\{setSheetJobCount\}/);
  assert.match(builder, /pricing=\{spend\.pending\}/);
  assert.match(builder, /isGenerating=\{runBusy\}[\s\S]{0,200}generationStep=\{runStep\}/);

  // The Subscription page: buy, switch and keep go through the confirm, kind
  // subscription - a purchase priced by `buyQuestion`, which asks about one
  // the unused days cover too (test/frontendSubscription.test.js).
  const page = read('app/settings/subscription/page.tsx');
  assert.equal((page.match(/kind: 'subscription'/g) ?? []).length, 3);
  for (const call of ['subscriptionApi.subscribe(', 'subscriptionApi.downgrade(', 'subscriptionApi.resume(']) {
    assert.equal(page.split(call).length - 1, 1, call);
  }
  assert.match(page, /price: async \(\) => buyQuestion\(tier, action, view, Date\.now\(\)\)/);
});
