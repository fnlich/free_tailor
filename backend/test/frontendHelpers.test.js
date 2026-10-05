const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ts = require('typescript');

/**
 * Small pure helpers the frontend pages decide things with, tested from here
 * because the frontend has no test runner (the `scraperForm.test.js` pattern):
 * each module is transpiled with the backend's own TypeScript and must import
 * nothing at runtime - type imports are erased.
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

// -- the account subscriptions --------------------------------------------- //

test("the frontend ranks the subscriptions in the backend's order", () => {
  // A copy, because the shell decides what to draw before any request. A copy
  // that drifted would offer a door the API then refuses, or hide one it opens.
  const frontend = loadFrontendModule('lib/subscriptions.ts');
  const backend = require('../dist/config/accountSubscriptions');
  assert.deepEqual([...frontend.SUBSCRIPTION_ORDER], backend.listSubscriptions().map((tier) => tier.id));

  const values = [...backend.SUBSCRIPTION_IDS, 'premium-ultra', undefined, null, ''];
  for (const value of values) {
    for (const minimum of backend.SUBSCRIPTION_IDS) {
      assert.equal(
        frontend.subscriptionAtLeast(value, minimum),
        backend.subscriptionAtLeast(value, minimum),
        `${value} vs ${minimum}`
      );
    }
  }
});

test("the builder's multi-profile lock is the backend's: Premium and up, administrators exempt", () => {
  const frontend = loadFrontendModule('lib/subscriptions.ts');
  const backendTiers = require('../dist/config/accountSubscriptions');
  const { hasSubscription } = require('../dist/middleware/auth');
  assert.equal(frontend.MULTI_PROFILE_SUBSCRIPTION, backendTiers.MULTI_PROFILE_SUBSCRIPTION);

  const tiers = [...backendTiers.SUBSCRIPTION_IDS, 'premium-ultra', undefined];
  for (const role of ['admin', 'user', 'reporter', undefined]) {
    for (const subscription of tiers) {
      const account = { role, subscription };
      for (const minimum of backendTiers.SUBSCRIPTION_IDS) {
        assert.equal(
          frontend.hasSubscription(account, minimum),
          hasSubscription(account, minimum),
          `${role}/${subscription} vs ${minimum}`
        );
      }
      assert.equal(
        frontend.canBuildForManyProfiles(account),
        hasSubscription(account, backendTiers.MULTI_PROFILE_SUBSCRIPTION)
      );
    }
  }
  assert.equal(frontend.hasSubscription(null, 'default'), false);
  assert.equal(frontend.canBuildForManyProfiles({ role: 'user', subscription: 'default' }), false);
  assert.equal(frontend.canBuildForManyProfiles({ role: 'admin', subscription: 'default' }), true);

  // The administrator's default target applies - except to an account that
  // supports one profile, which starts on Single whatever the default says.
  for (const selection of ['single', 'all', 'group']) {
    assert.equal(frontend.startingResumeSelection(selection, true), selection);
    assert.equal(frontend.startingResumeSelection(selection, false), 'single');
  }
});

// -- the admin Settings seat cards ------------------------------------------ //

test("each seat's card shows that seat's own holds, Gemini's included", () => {
  const { seatHolds } = loadFrontendModule('lib/seatHolds.ts');
  const claudeHold = { scope: 'sonnet', reason: 'usage limit', expiresAt: '2026-10-04T13:00:00.000Z' };
  const geminiHold = { scope: '*', reason: 'Manual authorization is required', expiresAt: '2026-10-04T13:30:00.000Z' };
  const health = {
    subscription: { seat: {}, outages: [claudeHold] },
    outagesByProvider: { 'claude-cli': [claudeHold], 'gemini-cli': [geminiHold] },
  };

  assert.deepEqual(seatHolds(health, 'gemini-cli'), [geminiHold]);
  assert.deepEqual(seatHolds(health, 'claude-cli'), [claudeHold]);
  assert.deepEqual(seatHolds(health, 'codex-cli'), []);
  assert.deepEqual(seatHolds(null, 'gemini-cli'), []);

  // A server too old to send the map: Claude's own list still shows on
  // Claude's card, and is never credited to another seat.
  const older = { subscription: { seat: {}, outages: [claudeHold] } };
  assert.deepEqual(seatHolds(older, 'claude-cli'), [claudeHold]);
  assert.deepEqual(seatHolds(older, 'gemini-cli'), []);
});


// -- the builder's multi-profile previews ----------------------------------- //

test('the ready-preview key changes only when the set of ready previews does', () => {
  const { readyPreviewKey } = loadFrontendModule('lib/builderPreviews.ts');
  const previews = [
    { profileId: 'a', tailoredContent: { summary: 'x' } },
    { profileId: 'b' },
    { profileId: 'c', tailoredContent: { summary: 'y' } },
  ];
  assert.equal(readyPreviewKey(previews), 'a,c');
  // A keystroke in the JSON editor makes a new array of new objects with the
  // same ready set: the key is the same, so the price is not asked for again.
  const edited = previews.map((preview) => ({ ...preview, draft: `${preview.profileId}!` }));
  assert.notEqual(edited, previews);
  assert.equal(readyPreviewKey(edited), readyPreviewKey(previews));
  // Clearing one preview's content does change it.
  assert.equal(readyPreviewKey([previews[0], previews[1], { profileId: 'c' }]), 'a');
  // And the form's reset, a fresh empty array each time, is always the same.
  assert.equal(readyPreviewKey([]), readyPreviewKey([]));
});

test('after finalising, only the previews that did not become a resume are left to finalise again', () => {
  const { keepUnbuiltPreviews } = loadFrontendModule('lib/builderPreviews.ts');
  const previews = [{ profileId: 'a' }, { profileId: 'b' }, { profileId: 'c' }];
  assert.deepEqual(keepUnbuiltPreviews(previews, ['b']), [{ profileId: 'b' }]);
  assert.deepEqual(keepUnbuiltPreviews(previews, []), []);
});

// -- the profile form's model choice ---------------------------------------- //

test('a profile keeps a stored model that is only unavailable for now, through a save of anything else', () => {
  const { savableModelChoice } = loadFrontendModule('lib/profileModel.ts');
  const offered = { modelsLoaded: true, offeredIds: ['claude-cli-sonnet'] };

  // Stored, and unticked by an administrator since: sent back as it was. The
  // server accepts an unchanged choice and runs the default until it returns.
  assert.deepEqual(
    savableModelChoice({ modelId: 'claude-cli-opus' }, { ...offered, storedModelId: 'claude-cli-opus' }),
    { modelId: 'claude-cli-opus' }
  );
  // A choice on offer is sent as it is.
  assert.deepEqual(
    savableModelChoice({ modelId: 'claude-cli-sonnet' }, { ...offered, storedModelId: 'claude-cli-opus' }),
    { modelId: 'claude-cli-sonnet' }
  );
  // An unavailable choice that is NOT the stored one - a new profile, an
  // import - would be refused by the server, so it is saved as "inherit".
  assert.deepEqual(savableModelChoice({ modelId: 'claude-cli-opus' }, offered), {});
  assert.deepEqual(
    savableModelChoice({ modelId: 'claude-cli-opus' }, { ...offered, storedModelId: 'gemini-cli-auto' }),
    {}
  );
  // Before the list has loaded nothing is judged, and "inherit" stays inherit.
  assert.deepEqual(
    savableModelChoice({ modelId: 'claude-cli-opus' }, { modelsLoaded: false, offeredIds: [] }),
    { modelId: 'claude-cli-opus' }
  );
  assert.deepEqual(savableModelChoice({}, offered), {});
});

// -- Admin -> Models: the blank form and display names ---------------------- //

function modelsSettings(aiModels) {
  const seat = (provider, values) => ({ provider, label: provider, models: values.map((value) => ({ value, label: value })) });
  return {
    aiModels,
    providerModelOptions: [
      seat('claude-cli', ['sonnet', 'opus', 'haiku', 'fable']),
      seat('codex-cli', ['default', 'gpt-6-luna']),
      seat('gemini-cli', ['auto', 'pro']),
    ],
  };
}

const record = (id, provider, modelName, name = id) => ({ id, provider, modelName, name });

test('a blank Add Model form never starts on a model name another record has', () => {
  const { blankDraftChoice, firstModelName } = loadFrontendModule('app/admin/models/modelDraft.ts');

  // The seeds take three Claude names: the fourth is offered.
  const seeded = modelsSettings([
    record('claude-cli-sonnet', 'claude-cli', 'sonnet'),
    record('claude-cli-opus', 'claude-cli', 'opus'),
    record('claude-cli-haiku', 'claude-cli', 'haiku'),
  ]);
  assert.deepEqual(blankDraftChoice(seeded), { provider: 'claude-cli', modelName: 'fable' });

  // Every Claude name taken: the next seat with a free one, not "Sonnet
  // (already added)" preselected and disabled.
  const claudeFull = modelsSettings([...seeded.aiModels, record('fable', 'claude-cli', 'FABLE')]);
  assert.deepEqual(blankDraftChoice(claudeFull), { provider: 'codex-cli', modelName: 'default' });
  // And a switch onto the full seat chooses nothing, for the placeholder.
  assert.equal(firstModelName(claudeFull, 'claude-cli', null), '');
  // Editing one of them, its own name is free to keep.
  assert.equal(firstModelName(claudeFull, 'claude-cli', 'claude-cli-sonnet'), 'sonnet');

  // Nothing free anywhere: the first seat, nothing chosen.
  const allFull = modelsSettings([
    ...claudeFull.aiModels,
    record('c1', 'codex-cli', 'default'),
    record('c2', 'codex-cli', 'gpt-6-luna'),
    record('g1', 'gemini-cli', 'auto'),
    record('g2', 'gemini-cli', 'pro'),
  ]);
  assert.deepEqual(blankDraftChoice(allFull), { provider: 'claude-cli', modelName: '' });
  assert.deepEqual(blankDraftChoice(null), { provider: 'claude-cli', modelName: '' });
});

test('the form names the record that already has a display name, trimmed and in any case', () => {
  const { displayNameOwner } = loadFrontendModule('app/admin/models/modelDraft.ts');
  const settings = modelsSettings([record('claude-cli-sonnet', 'claude-cli', 'sonnet', 'Claude Sonnet')]);
  assert.equal(displayNameOwner(settings, '  claude SONNET ', null)?.id, 'claude-cli-sonnet');
  assert.equal(displayNameOwner(settings, 'Claude Sonnet', 'claude-cli-sonnet'), null, 'its own name');
  assert.equal(displayNameOwner(settings, 'Claude Sonnet 2', null), null);
  assert.equal(displayNameOwner(settings, '   ', null), null);
});

// -- the card/crypto return page's poll ------------------------------------- //

test('the payment poll is 2 s for two minutes, then 20 s', () => {
  const { FAST_POLL_MS, SLOW_AFTER_MS, SLOW_POLL_MS, pollDelay } = loadFrontendModule('lib/paymentPoll.ts');
  assert.equal(FAST_POLL_MS, 2_000);
  assert.equal(SLOW_AFTER_MS, 120_000);
  assert.equal(SLOW_POLL_MS, 20_000);

  assert.equal(pollDelay(0), 2_000);
  assert.equal(pollDelay(119_999), 2_000);
  // The same moment the waiting copy changes to say what to do.
  assert.equal(pollDelay(120_000), 20_000);
  assert.equal(pollDelay(3_600_000), 20_000);

  // An hour of a crypto invoice from one tab: 60 looks, then 174, where the
  // fixed two-second interval made 1,800.
  let elapsed = 0;
  let looks = 0;
  while (elapsed < 3_600_000) {
    elapsed += pollDelay(elapsed);
    looks += 1;
  }
  assert.equal(looks, 60 + 174);
});

test('polling stops on a settled or vanished payment and continues on a transient failure', () => {
  const { keepPolling } = loadFrontendModule('lib/paymentPoll.ts');
  assert.equal(keepPolling('pending'), true);
  assert.equal(keepPolling('retry'), true, 'offline or a restart is worth asking again');
  assert.equal(keepPolling('settled'), false);
  // A 404 - no such payment, or not this account's - used to count as "still
  // pending" and was asked about every two seconds for as long as the tab lived.
  assert.equal(keepPolling('gone'), false);
});

// -- the builder following a running batch ---------------------------------- //

test("the builder follows its run until the server says it is over: empty attaches slow down, only a 404 stops it", () => {
  const { MAX_IDLE_REATTACHES, REATTACH_MS, SLOW_REATTACH_MS, nextAttach } = loadFrontendModule('lib/batchFollow.ts');
  assert.equal(MAX_IDLE_REATTACHES, 20);
  assert.ok(SLOW_REATTACH_MS > REATTACH_MS);

  // A healthy long batch behind a proxy that cuts it every minute: every
  // attach opens with a snapshot, so it is followed at full speed however
  // long it runs.
  let state = { idleInARow: 0, stop: false, delayMs: 0 };
  for (let attach = 0; attach < 200; attach += 1) {
    state = nextAttach(state.idleInARow, { delivered: 1, gone: false });
    assert.equal(state.stop, false);
    assert.equal(state.delayMs, REATTACH_MS);
  }
  assert.equal(state.idleInARow, 0);

  // A network that is down: attaches that bring nothing never give up - the
  // run is still the server's, and the lease's grace can be ten minutes, so a
  // page that stopped here stopped downloading resumes still being built. It
  // slows to one attach every SLOW_REATTACH_MS from the twentieth on.
  state = { idleInARow: 0, stop: false, delayMs: 0 };
  for (let attach = 1; attach < MAX_IDLE_REATTACHES; attach += 1) {
    state = nextAttach(state.idleInARow, { delivered: 0, gone: false });
    assert.equal(state.stop, false, `attach ${attach}`);
    assert.equal(state.delayMs, REATTACH_MS, `attach ${attach}`);
  }
  for (let attach = 0; attach < 500; attach += 1) {
    state = nextAttach(state.idleInARow, { delivered: 0, gone: false });
    assert.equal(state.stop, false);
    assert.equal(state.delayMs, SLOW_REATTACH_MS);
  }

  // The network comes back: one attach that delivered and the pace is back.
  const reset = nextAttach(state.idleInARow, { delivered: 3, gone: false });
  assert.deepEqual(reset, { idleInARow: 0, stop: false, delayMs: REATTACH_MS });

  // A 404 - restarted or expired - stops it at once, delivered or not.
  assert.equal(nextAttach(0, { delivered: 0, gone: true }).stop, true);
  assert.equal(nextAttach(0, { delivered: 5, gone: true }).stop, true);
});

// -- the Profiles list: which template a profile is drawn with -------------- //

test('the Profiles list names the template a profile is drawn with, as the server picks it', () => {
  const { drawnTemplate } = loadFrontendModule('lib/profileDraft.ts');
  const template = (id, skillsLayouts) => ({ id, name: id, skillsLayouts });
  const templates = [
    template('forest-chips', ['categorized']),
    template('default', ['categorized', 'flat']),
    template('ink-ledger', ['categorized', 'flat']),
  ];
  const plain = (preferredTemplate) => ({ preferredTemplate, profileSettings: { technicalSkillsLayout: 'flat' } });
  const ids = ({ stored, drawn }) => [stored?.id ?? null, drawn?.id ?? null];

  // An administrator made Forest Chips Grouped-only after a Plain profile chose it.
  assert.deepEqual(ids(drawnTemplate(templates, plain('forest-chips'))), ['forest-chips', 'default']);
  assert.equal(drawnTemplate(templates, plain('forest-chips')).layout, 'flat');
  // Fits: drawn with its own.
  assert.deepEqual(ids(drawnTemplate(templates, plain('ink-ledger'))), ['ink-ledger', 'ink-ledger']);
  assert.deepEqual(
    ids(drawnTemplate(templates, { preferredTemplate: 'forest-chips', profileSettings: {} })),
    ['forest-chips', 'forest-chips']
  );
  // None named: default, which is "stored" in the sense of what it renders with.
  assert.deepEqual(ids(drawnTemplate(templates, plain(undefined))), ['default', 'default']);
  // One no longer offered.
  assert.deepEqual(ids(drawnTemplate(templates, plain('gone'))), [null, 'default']);
  // No default offering the layout: the first template that does.
  const noDefault = [template('forest-chips', ['categorized']), template('ink-ledger', ['flat'])];
  assert.deepEqual(ids(drawnTemplate(noDefault, plain('forest-chips'))), ['forest-chips', 'ink-ledger']);
  // Nothing prints it at all: the choice as it is, as the server does.
  assert.deepEqual(ids(drawnTemplate([template('forest-chips', ['categorized'])], plain('forest-chips'))), [
    'forest-chips',
    'forest-chips',
  ]);
});
