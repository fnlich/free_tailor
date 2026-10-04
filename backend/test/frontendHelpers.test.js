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
