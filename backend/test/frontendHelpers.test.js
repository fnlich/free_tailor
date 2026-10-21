const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ts = require('typescript');

/**
 * Small pure helpers the frontend pages decide things with, tested from here
 * because the frontend has no test runner: each module is transpiled with the backend's own TypeScript and must import
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

// -- the locks ---------------------------------------------------------------- //

test("the lock's names and profile limits are the backend's catalogue", () => {
  const frontend = loadFrontendModule('lib/subscriptions.ts');
  const backend = require('../dist/config/accountSubscriptions');
  for (const tier of backend.listSubscriptions()) {
    assert.equal(frontend.SUBSCRIPTION_LABELS[tier.id], tier.label, tier.id);
    assert.equal(frontend.SUBSCRIPTION_PROFILE_LIMITS[tier.id], tier.profileLimit, tier.id);
  }
  assert.deepEqual(Object.keys(frontend.SUBSCRIPTION_LABELS), [...backend.SUBSCRIPTION_IDS]);
  assert.deepEqual(Object.keys(frontend.SUBSCRIPTION_PROFILE_LIMITS), [...backend.SUBSCRIPTION_IDS]);
});

test('a lock names what it is, the tier that unlocks it and the account\'s own, never a "plan"', () => {
  const { describeLock } = loadFrontendModule('lib/subscriptions.ts');
  const { MULTI_PROFILE_SUBSCRIPTION } = require('../dist/config/accountSubscriptions');

  const many = describeLock('many-profiles', { subscription: 'default' });
  assert.equal(many.title, 'Building for several profiles');
  assert.equal(many.needs, MULTI_PROFILE_SUBSCRIPTION);
  assert.equal(many.needsLabel, 'Premium');
  assert.equal(
    many.body,
    'Your Default subscription builds for one profile at a time. Premium and higher build for the profiles you choose, every profile, or a group of them, in one run.'
  );

  const groups = describeLock('groups', { subscription: 'default' });
  assert.equal(groups.title, 'Groups');
  assert.equal(groups.needs, 'premium');
  assert.equal(
    groups.body,
    'Groups need a Premium subscription or higher, and your account is on Default. A group is a set of profiles you build for together.'
  );
  // A stored tier this page does not know reads as Default, as the backend's `resolveSubscription` does.
  assert.equal(describeLock('groups', { subscription: 'premium-ultra' }).body, groups.body);

  // More profiles names the cheapest tier with room for one more.
  const cases = [
    [{ subscription: 'default', profilesUsed: 1 }, 'premium', 'The Default subscription allows 1 profile, and you have 1. Premium allows up to 5.'],
    [{ subscription: 'premium', profilesUsed: 5 }, 'premium-plus', 'The Premium subscription allows 5 profiles, and you have 5. Premium+ allows up to 25.'],
    [{ subscription: 'premium-plus', profilesUsed: 25 }, 'premium-max', 'The Premium+ subscription allows 25 profiles, and you have 25. Premium Max has no limit on profiles.'],
    // Kept above a lower limit after a lapse: still the tier with room for one more.
    [{ subscription: 'default', profilesUsed: 7 }, 'premium-plus', 'The Default subscription allows 1 profile, and you have 7. Premium+ allows up to 25.'],
  ];
  for (const [account, needs, body] of cases) {
    const lock = describeLock('more-profiles', account);
    assert.equal(lock.title, 'More profiles');
    assert.equal(lock.needs, needs, JSON.stringify(account));
    assert.equal(lock.body, body);
  }

  for (const feature of ['many-profiles', 'groups', 'more-profiles']) {
    const lock = describeLock(feature, { subscription: 'default', profilesUsed: 1 });
    assert.doesNotMatch(`${lock.title} ${lock.body}`, /\bplans?\b/i, feature);
  }
});

test("a lock for what the server refused is worded from the refusal, never from a session that is behind it", () => {
  const frontend = loadFrontendModule('lib/subscriptions.ts');
  const backend = require('../dist/config/accountSubscriptions');
  const { ProfileLimitError } = require('../dist/database/profileRepository');

  // 403 subscription-too-low for several profiles: the server holds the
  // account below Premium, which is Default - whatever tier the page's session
  // still says (a paid Premium that lapsed at renewal while the page was open).
  const tooLow = frontend.describeTooLowRefusal();
  assert.equal(tooLow.needs, backend.MULTI_PROFILE_SUBSCRIPTION);
  assert.equal(
    tooLow.body,
    'Your Default subscription builds for one profile at a time. Premium and higher build for the profiles you choose, every profile, or a group of them, in one run.'
  );
  assert.deepEqual(tooLow, frontend.describeLock('many-profiles', { subscription: 'default' }));

  // 402 profile-limit: its `limit` names the tier, as the backend's error
  // carries it, and the server counted at least that many.
  for (const tier of backend.listSubscriptions()) {
    if (tier.profileLimit === null) continue;
    assert.equal(frontend.tierWithProfileLimit(tier.profileLimit), tier.id);
    const refusal = new ProfileLimitError(tier.label, tier.profileLimit, tier.profileLimit);
    assert.equal(refusal.status, 402);
    assert.deepEqual(refusal.extra, { limit: tier.profileLimit });
  }
  assert.equal(frontend.tierWithProfileLimit(7), null);
  assert.equal(frontend.tierWithProfileLimit('5'), null);
  const cases = [
    // A profile added in another tab: the page had 4 of Premium's 5, the server counted 5.
    [{ limit: 5, used: 4 }, { subscription: 'premium' }, 'premium-plus', 'The Premium subscription allows 5 profiles, and you have 5. Premium+ allows up to 25.'],
    // The list read again after the refusal says 5.
    [{ limit: 5, used: 5 }, { subscription: 'premium' }, 'premium-plus', 'The Premium subscription allows 5 profiles, and you have 5. Premium+ allows up to 25.'],
    // A paid Premium that lapsed to Default under the page: the session still says Premium, with 3.
    [{ limit: 1, used: 3 }, { subscription: 'premium' }, 'premium', 'The Default subscription allows 1 profile, and you have 3. Premium allows up to 5.'],
    // A stale Premium+ session over a server-side Default with one profile.
    [{ limit: 1, used: 1 }, { subscription: 'premium-plus' }, 'premium', 'The Default subscription allows 1 profile, and you have 1. Premium allows up to 5.'],
    // No limit in the answer: the session's tier, and the page's own count.
    [{ used: 5 }, { subscription: 'premium' }, 'premium-plus', 'The Premium subscription allows 5 profiles, and you have 5. Premium+ allows up to 25.'],
  ];
  for (const [refusal, account, needs, body] of cases) {
    const lock = frontend.describeProfileLimitRefusal(refusal, account);
    assert.equal(lock.feature, 'more-profiles');
    assert.equal(lock.needs, needs, JSON.stringify(refusal));
    assert.equal(lock.body, body, JSON.stringify(refusal));
    // Never the tier the refusal was about, or one below it.
    const refusedTier = frontend.tierWithProfileLimit(refusal.limit) ?? account.subscription;
    assert.ok(
      frontend.SUBSCRIPTION_ORDER.indexOf(lock.needs) > frontend.SUBSCRIPTION_ORDER.indexOf(refusedTier),
      JSON.stringify(refusal)
    );
  }
});

// -- who a run builds for ------------------------------------------------------ //

/**
 * lib/runChoices.ts imports lib/subscriptions.ts at runtime and nothing else,
 * so it is loaded with that one module handed to it.
 */
function loadRunChoices() {
  const subscriptions = loadFrontendModule('lib/subscriptions.ts');
  const file = path.join(SRC, 'lib/runChoices.ts');
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  });
  const module = { exports: {} };
  const resolve = (specifier) => {
    if (specifier === './subscriptions') return subscriptions;
    throw new Error(`lib/runChoices.ts imports ${specifier}; it may import only ./subscriptions at runtime`);
  };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, resolve);
  return module.exports;
}

test('a run builds for the profile chosen, the several chosen, every profile, or the enabled members of a group - as the server is asked', () => {
  const choices = loadRunChoices();
  const profiles = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const groups = [
    { id: 'g1', profileIds: ['c', 'a', 'gone'] },
    { id: 'empty', profileIds: ['gone'] },
  ];
  const ids = (list) => list.map((profile) => profile.id);
  const choice = (kind, profileId = 'b', groupId = 'g1', profileIds = ['c', 'a']) => ({ kind, profileId, profileIds, groupId });

  assert.deepEqual(ids(choices.targetProfiles(choice('single'), profiles, groups)), ['b']);
  assert.deepEqual(ids(choices.targetProfiles(choice('all'), profiles, groups)), ['a', 'b', 'c']);
  // The page's order (newest first), never the group's; a member that is no longer enabled is left out.
  assert.deepEqual(ids(choices.targetProfiles(choice('group'), profiles, groups)), ['a', 'c']);
  assert.deepEqual(ids(choices.targetProfiles(choice('group', 'b', 'nope'), profiles, groups)), []);
  // Several: the ones chosen, in the page's order too; one no longer enabled is left out.
  assert.deepEqual(ids(choices.targetProfiles(choice('several'), profiles, groups)), ['a', 'c']);
  assert.deepEqual(ids(choices.targetProfiles(choice('several', 'b', 'g1', ['gone', 'b']), profiles, groups)), ['b']);
  assert.deepEqual(ids(choices.targetProfiles({ kind: 'several', profileId: 'b', groupId: '' }, profiles, groups)), []);

  assert.equal(choices.targetBlocker(choice('single'), profiles, groups), null);
  assert.equal(choices.targetBlocker(choice('single', null), profiles, groups), 'Please select a profile.');
  assert.equal(choices.targetBlocker(choice('single', 'x'), profiles, groups), 'Selected profile could not be found.');
  assert.equal(choices.targetBlocker(choice('several'), profiles, groups), null);
  assert.equal(choices.targetBlocker(choice('several', 'b', 'g1', []), profiles, groups), 'Please select the profiles to build for.');
  assert.equal(choices.targetBlocker(choice('several', 'b', 'g1', ['gone']), profiles, groups), 'Selected profiles could not be found.');
  assert.equal(choices.targetBlocker(choice('all'), [], groups), 'No profiles available for multi-profile generation.');
  assert.equal(choices.targetBlocker(choice('group', 'b', ''), profiles, groups), 'Please select a group.');
  assert.equal(choices.targetBlocker(choice('group', 'b', 'empty'), profiles, groups), 'Selected group has no enabled profiles.');

  // Only Single builds for one profile; the kind in effect is Single for an account that cannot build for several.
  assert.deepEqual(choices.TARGET_KINDS.map(choices.isMultiProfileTarget), [false, true, true, true]);
  for (const kind of choices.TARGET_KINDS) {
    assert.equal(choices.targetInEffect(kind, true), kind);
    assert.equal(choices.targetInEffect(kind, false), 'single');
  }
});

test("a page starts on the administrator's default target, profile and group - Single below Premium - and its files", async () => {
  const choices = loadRunChoices();
  const { hasSubscription } = require('../dist/middleware/auth');
  const { MULTI_PROFILE_SUBSCRIPTION } = require('../dist/config/accountSubscriptions');
  const profiles = [{ id: 'a' }, { id: 'b' }];
  const groups = [{ id: 'g1', profileIds: ['a'] }];
  const settings = { defaultResumeSelection: 'group', defaultProfileId: 'b', defaultGroupId: 'g1' };

  assert.deepEqual(choices.startingTarget(settings, profiles, groups, true), { kind: 'group', profileId: 'b', groupId: 'g1' });
  assert.deepEqual(choices.startingTarget(settings, profiles, groups, false), { kind: 'single', profileId: 'b', groupId: '' });
  // A default that no longer exists falls to the first profile, and to no group.
  assert.deepEqual(
    choices.startingTarget({ ...settings, defaultProfileId: 'gone', defaultGroupId: 'gone' }, profiles, groups, true),
    { kind: 'group', profileId: 'a', groupId: '' }
  );
  assert.deepEqual(choices.startingTarget({ ...settings, defaultResumeSelection: 'all' }, [], groups, true), {
    kind: 'all',
    profileId: null,
    groupId: '',
  });

  // The lock is the server's: a multi-profile target is exactly what it refuses below Premium.
  for (const subscription of ['default', 'premium']) {
    const account = { role: 'user', subscription };
    const many = hasSubscription(account, MULTI_PROFILE_SUBSCRIPTION);
    for (const kind of choices.TARGET_KINDS) {
      const inEffect = choices.targetInEffect(kind, many);
      assert.equal(choices.isMultiProfileTarget(inEffect) && !many, false, `${subscription}/${kind}`);
    }
  }

  assert.deepEqual(choices.defaultRunFormat({ defaultResumeDocxEnabled: true, defaultCoverLetterDocxEnabled: false }), {
    format: 'both',
    includeCoverLetterDocx: false,
  });
  assert.deepEqual(choices.defaultRunFormat({ defaultResumeDocxEnabled: false, defaultCoverLetterDocxEnabled: true }), {
    format: 'pdf',
    includeCoverLetterDocx: true,
  });
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

  // The map is the whole answer: a provider it does not name has no holds,
  // and the built-in Claude's own list is never read beside it.
  const unnamed = { subscription: { seat: {}, outages: [claudeHold] }, outagesByProvider: {} };
  assert.deepEqual(seatHolds(unnamed, 'claude-cli'), []);
  assert.deepEqual(seatHolds(unnamed, 'gemini-cli'), []);
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
  const template = (id) => ({ id, name: id });
  const templates = [template('forest-chips'), template('default'), template('ink-ledger')];
  const plain = (preferredTemplate) => ({ preferredTemplate, profileSettings: { technicalSkillsLayout: 'flat' } });
  const grouped = (preferredTemplate) => ({ preferredTemplate, profileSettings: {} });
  const ids = ({ stored, drawn }) => [stored?.id ?? null, drawn?.id ?? null];

  // Every template prints both layouts: a profile is drawn with its own, whatever its layout.
  for (const profile of [plain('forest-chips'), grouped('forest-chips')]) {
    assert.deepEqual(ids(drawnTemplate(templates, profile)), ['forest-chips', 'forest-chips']);
  }
  assert.equal('layout' in drawnTemplate(templates, plain('forest-chips')), false);
  // None named: default, which is "stored" in the sense of what it renders with.
  assert.deepEqual(ids(drawnTemplate(templates, plain(undefined))), ['default', 'default']);
  // One no longer offered: default.
  assert.deepEqual(ids(drawnTemplate(templates, plain('gone'))), [null, 'default']);
  // ...and with no default offered either, the first template, as the server takes it.
  const noDefault = [template('ink-ledger'), template('forest-chips')];
  assert.deepEqual(ids(drawnTemplate(noDefault, grouped('gone'))), [null, 'ink-ledger']);
  // Nothing offered at all.
  assert.deepEqual(ids(drawnTemplate([], plain('forest-chips'))), [null, null]);
});
