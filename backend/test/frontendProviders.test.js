const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

// Every seat is a stub here. Set before any dist module loads.
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';

const ts = require('typescript');

const { useAdminEmails, useTempStorage } = require('./helpers');

/**
 * The browser's half of model PROVIDERS (owner decisions P1-P4): the
 * Providers section of Admin -> Models, the per-provider cards on Settings ->
 * General, and the provider an administrator sees on an order's page.
 *
 * The frontend has no test runner, so lib/providerDisplay.ts is transpiled
 * with the backend's own TypeScript and run from here. It imports nothing at
 * runtime, which this loader enforces. Two kinds of claim:
 *
 *  - MIRRORS of a server rule, run against the server's compiled code over the
 *    same inputs: the types and their sign-in variables, the `.env` names a
 *    built-in reads, the limit's range and the sentence refusing it, the name
 *    and path checks the form makes before sending (every one the server's own
 *    refusal, word for word and on the same field), which types can run, and
 *    the shape of what the routes send - read through the page's normaliser
 *    without losing a field.
 *  - DECISIONS with no React in them: what a save sends (only what changed, so
 *    an untouched `.env` value stays `.env`'s), which box a refusal belongs
 *    to, where each value came from, how a provider's state reads - a hold,
 *    switched off, locked - and that the built-in one cannot be removed.
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

const display = loadFrontendModule('lib/providerDisplay.ts');

/**
 * lib/api.ts itself, for the one rule of it this suite holds to the server
 * (`isProviderOffered`). It imports other frontend modules at runtime, so it
 * gets a loader that follows relative imports - and nothing else - the way
 * frontendRoles.test.js loads it. Run, not copied: a copy of the rule in the
 * test passed however the page's own function drifted.
 */
function loadFrontendWithImports(relative, seen = new Map()) {
  const file = path.join(SRC, relative);
  if (seen.has(file)) return seen.get(file).exports;
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  });
  const module = { exports: {} };
  seen.set(file, module);
  const resolve = (specifier) => {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
      throw new Error(`${relative} imports ${specifier} at runtime; only frontend modules are followed`);
    }
    const base = path.relative(SRC, path.join(path.dirname(file), specifier));
    const candidate = ['.ts', '.tsx'].map((ext) => `${base}${ext}`).find((name) => fs.existsSync(path.join(SRC, name)));
    if (!candidate) throw new Error(`${relative}: cannot resolve ${specifier}`);
    return loadFrontendWithImports(candidate, seen);
  };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, resolve);
  return module.exports;
}

const api = loadFrontendWithImports('lib/api.ts');
const server = require('../dist/config/aiProviders');
const config = require('../dist/config/aiModelConfig');
const catalog = require('../dist/config/providerCatalog');

/** A filesystem where every absolute path exists: a folder, or an executable file when it ends in a binary's name. */
function fakeDeps(platform) {
  return {
    platform,
    stat: (filePath) => ({
      isDirectory: () => !/(claude|codex|gemini)(\.cmd)?$/.test(filePath),
      isFile: () => /(claude|codex|gemini)(\.cmd)?$/.test(filePath),
    }),
    realpath: (filePath) => filePath,
    isExecutable: () => true,
    homedir: () => (platform === 'win32' ? 'C:\\Users\\server' : '/home/server'),
  };
}

/** What the server says to a body: null when it takes it, else `{ code, field, message }`. */
function serverRefusal(run) {
  try {
    run();
    return null;
  } catch (error) {
    if (!(error instanceof server.AIProviderInputError)) throw error;
    return { code: error.code, field: error.field ?? null, message: error.message };
  }
}

/** The providers as the admin payload sends them, through the page's normaliser. */
function adminProviders(stored = [], env = {}) {
  return server.resolveProviders(stored, env).map(server.toAdminProvider).map(display.normalizeAdminProvider);
}

function contextFor(stored, platform = 'linux') {
  return { providers: server.resolveProviders(stored, {}), appDirectories: [], deps: fakeDeps(platform) };
}

/* ------------------------------------------------------------- the copies */

test("the page's copies of the server's provider tables agree with it", () => {
  assert.deepEqual([...display.PROVIDER_TYPES], [...catalog.AI_PROVIDER_IDS], 'the types, in catalog order');
  assert.deepEqual({ ...display.PROVIDER_HOME_VARIABLES }, { ...server.PROVIDER_HOME_VARIABLE });
  assert.deepEqual(
    JSON.parse(JSON.stringify(display.BUILT_IN_PROVIDER_ENV)),
    JSON.parse(JSON.stringify(server.BUILT_IN_PROVIDER_ENV)),
    'the .env line a value "From .env" names'
  );
  assert.equal(display.PROVIDER_CONCURRENCY_MIN, server.PROVIDER_CONCURRENCY_MIN);
  assert.equal(display.PROVIDER_CONCURRENCY_MAX, server.PROVIDER_CONCURRENCY_MAX);
});

test('every hold kind a seat records has a name on the page', () => {
  // Read off the unions in the sources: a kind added to a seat and not here
  // would read "Held (thatKind)" on the one card meant to say what is wrong.
  const kinds = new Set();
  for (const [file, name] of [
    ['src/services/ai/providers/claudeCli/limits.ts', 'OutageKind'],
    ['src/services/ai/providers/geminiCli/classify.ts', 'GeminiHoldKind'],
    ['src/services/ai/providers/codexCli/limits.ts', 'CodexHoldKind'],
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const union = source.match(new RegExp(`export type ${name} = ([^;]+);`));
    assert.ok(union, `${name} is declared in ${file}`);
    for (const kind of union[1].matchAll(/'([^']+)'/g)) kinds.add(kind[1]);
  }
  assert.ok(kinds.size >= 3);
  for (const kind of kinds) assert.ok(display.HOLD_KIND_LABELS[kind], `a label for the hold kind "${kind}"`);
});

test("the limit box reads concurrency_max_requests exactly as the server does, refusing in its words", () => {
  const inputs = ['1', '4', '32', ' 7 ', '07', '0', '33', '-1', '4.5', '1e1', 'four', '', ' ', '99999999999999999999', '+3', '0x10'];
  for (const input of inputs) {
    const client = display.readConcurrencyDraft(input);
    let accepted = null;
    const refused = serverRefusal(() => {
      accepted = server.readProviderConcurrency(input);
    });
    assert.equal(client.ok, refused === null, `"${input}": the page and the server agree whether it is a limit`);
    if (client.ok) assert.equal(client.value, accepted, `"${input}" reads as the same number`);
    else assert.equal(client.message, refused.message, `"${input}" is refused in the server's words`);
  }
});

/* ---------------------------------------------------------------- the form */

test('every problem the Add form finds is the refusal the server makes, on the same field', () => {
  const existing = [
    { id: 'prv-0000000a', type: 'claude-cli', label: 'Team B', homeDir: '/srv/team-b', concurrency_max_requests: 2, enabled: true },
  ];
  const providers = adminProviders(existing);
  const good = { type: 'claude-cli', label: 'Team C', homeDir: '/srv/team-c', binaryPath: '', concurrency_max_requests: '', enabled: true };

  // One fault each, so the server - which stops at its first - and the page,
  // which lists them all, are comparing the same thing.
  const cases = [
    { label: '' },
    { label: '   ' },
    { label: 'x'.repeat(81) },
    { label: 'team b' },
    { homeDir: '' },
    { type: 'codex-cli', homeDir: '' },
    { type: 'gemini-cli', homeDir: '' },
    { homeDir: 'relative/folder' },
    { homeDir: '~/claude' },
    { binaryPath: './claude' },
    { concurrency_max_requests: '0' },
    { concurrency_max_requests: '33' },
    { concurrency_max_requests: '2.5' },
  ];

  for (const platform of ['linux', 'win32']) {
    for (const change of cases) {
      const draft = { ...good, ...change };
      const problems = display.providerDraftProblems(draft, null, providers);
      const fields = Object.keys(problems);
      assert.equal(fields.length, 1, `${JSON.stringify(change)}: exactly one problem (${JSON.stringify(problems)})`);
      const refused = serverRefusal(() => server.buildNewProvider(display.addProviderBody(draft), contextFor(existing, platform)));
      assert.ok(refused, `${platform}: the server refuses ${JSON.stringify(change)} too`);
      assert.equal(refused.field, fields[0], `${JSON.stringify(change)}: on the same box`);
      assert.equal(problems[fields[0]], refused.message, `${JSON.stringify(change)}: in the same words`);
    }
  }

  // And what it lets through, the server takes, as it was typed.
  const clean = display.providerDraftProblems(
    { ...good, binaryPath: '/opt/claude/claude', concurrency_max_requests: ' 3 ' },
    null,
    providers
  );
  assert.deepEqual(clean, {});
  const body = display.addProviderBody({ ...good, binaryPath: '/opt/claude/claude', concurrency_max_requests: ' 3 ' });
  assert.deepEqual(body, {
    type: 'claude-cli',
    label: 'Team C',
    homeDir: '/srv/team-c',
    binaryPath: '/opt/claude/claude',
    concurrency_max_requests: 3,
    enabled: true,
  });
  const created = server.buildNewProvider(body, contextFor(existing));
  assert.equal(created.homeDir, '/srv/team-c');
  assert.equal(created.concurrency_max_requests, 3);

  // An empty binary and limit are left out: the type's.
  const bare = display.addProviderBody(good);
  assert.equal('binaryPath' in bare, false);
  assert.equal('concurrency_max_requests' in bare, false);
});

test('a path the page cannot judge is left to the server, which names it on the same box', () => {
  // The page does not know the server's platform: a Windows path is absolute
  // somewhere, so it is sent - and a Linux server refuses it by name.
  assert.equal(display.looksAbsolute('C:\\claude-b'), true);
  assert.equal(display.looksAbsolute('\\\\host\\share'), true);
  assert.equal(display.looksAbsolute('/srv/claude-b'), true);
  assert.equal(display.looksAbsolute('claude-b'), false);
  const draft = { type: 'claude-cli', label: 'Win', homeDir: 'C:\\claude-b', binaryPath: '', concurrency_max_requests: '', enabled: true };
  assert.deepEqual(display.providerDraftProblems(draft, null, []), {});
  const refused = serverRefusal(() => server.buildNewProvider(display.addProviderBody(draft), contextFor([], 'linux')));
  assert.equal(refused.code, 'path-not-absolute');
  assert.equal(display.refusalField({ error: refused.message, code: refused.code, field: refused.field }), 'homeDir');
  assert.equal(serverRefusal(() => server.buildNewProvider(display.addProviderBody(draft), contextFor([], 'win32'))), null);
});

test('the Edit form starts from what an administrator set, and a save sends only what changed', () => {
  const stored = [
    { id: 'claude-cli', type: 'claude-cli', label: 'Claude (Subscription)', concurrency_max_requests: 9, enabled: true },
    { id: 'prv-0000000a', type: 'claude-cli', label: 'Team B', homeDir: '/srv/team-b', concurrency_max_requests: 2, enabled: true },
  ];
  const env = { CLAUDE_CONFIG_DIR: '/srv/claude-env', AI_CLI_CONCURRENCY: '6' };
  const [builtIn, added] = adminProviders(stored, env);

  // A built-in: empty boxes are ".env", the limit is the one set here.
  const builtInDraft = display.draftFromProvider(builtIn);
  assert.deepEqual(
    { homeDir: builtInDraft.homeDir, binaryPath: builtInDraft.binaryPath, limit: builtInDraft.concurrency_max_requests },
    { homeDir: '', binaryPath: '', limit: '9' }
  );
  assert.deepEqual(display.editProviderBody(builtIn, builtInDraft), {}, 'untouched: nothing is sent, so .env stays in charge');
  assert.deepEqual(display.providerDraftProblems(builtInDraft, builtIn, [builtIn, added]), {});

  // Clearing the limit puts .env's back.
  const cleared = display.editProviderBody(builtIn, { ...builtInDraft, concurrency_max_requests: '' });
  assert.deepEqual(cleared, { concurrency_max_requests: '' });
  const builtInStored = server.normalizeStoredProviders(stored)[0];
  const afterClear = server.applyProviderEdit(builtInStored, cleared, contextFor(stored));
  const resolved = server.resolveProviders([afterClear], env).find((entry) => entry.id === 'claude-cli');
  assert.equal(resolved.concurrency_max_requests, 6);
  assert.equal(resolved.sources.concurrency_max_requests, 'env');

  // A built-in's name may be emptied: it is its type's again.
  const renamed = display.editProviderBody(builtIn, { ...builtInDraft, label: '' });
  assert.deepEqual(renamed, { label: '' });
  assert.deepEqual(display.providerDraftProblems({ ...builtInDraft, label: '' }, builtIn, [builtIn, added]), {});
  assert.equal(server.applyProviderEdit(builtInStored, renamed, contextFor(stored)).label, 'Claude (Subscription)');

  // An added provider: its own folder and limit, which it keeps.
  const addedDraft = display.draftFromProvider(added);
  assert.deepEqual(
    { homeDir: addedDraft.homeDir, limit: addedDraft.concurrency_max_requests },
    { homeDir: '/srv/team-b', limit: '2' }
  );
  assert.deepEqual(display.editProviderBody(added, addedDraft), {});
  assert.deepEqual(display.editProviderBody(added, { ...addedDraft, concurrency_max_requests: '02' }), {}, 'the same number, spelt otherwise');
  assert.deepEqual(display.editProviderBody(added, { ...addedDraft, concurrency_max_requests: '5', label: ' Team B2 ' }), {
    label: 'Team B2',
    concurrency_max_requests: 5,
  });

  const addedStored = server.normalizeStoredProviders(stored)[1];
  for (const change of [{ homeDir: '' }, { concurrency_max_requests: '' }, { label: '' }, { label: 'claude (subscription)' }]) {
    const draft = { ...addedDraft, ...change };
    const problems = display.providerDraftProblems(draft, added, [builtIn, added]);
    const body = display.editProviderBody(added, draft);
    const refused = serverRefusal(() => server.applyProviderEdit(addedStored, body, contextFor(stored)));
    assert.ok(refused, `the server refuses ${JSON.stringify(change)} on an added provider`);
    assert.deepEqual(problems, { [refused.field]: refused.message }, `${JSON.stringify(change)}: the page says what the server would`);
  }
});

test('a refusal is pinned to the box the server names, and one about the whole provider to none', () => {
  assert.equal(display.refusalField({ code: 'path-missing', field: 'homeDir' }), 'homeDir');
  assert.equal(display.refusalField({ code: 'not-executable', field: 'binaryPath' }), 'binaryPath');
  assert.equal(display.refusalField({ code: 'bad-concurrency', field: 'concurrency_max_requests' }), 'concurrency_max_requests');
  assert.equal(display.refusalField({ code: 'home-in-use', field: 'homeDir' }), 'homeDir');
  assert.equal(display.refusalField({ code: 'provider-busy', running: 1 }), null);
  assert.equal(display.refusalField({ code: 'built-in' }), null);
  assert.equal(display.refusalField({ field: 'somethingElse' }), null);
  assert.equal(display.refusalField(null), null);
});

test("the form's sign-in commands are the README's, at the folder typed", () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');
  for (const [type, folder] of [
    ['claude-cli', '/srv/claude-team-b'],
    ['codex-cli', '/srv/codex-team-b'],
    ['gemini-cli', '/srv/gemini-team-b'],
  ]) {
    const command = display.signInCommand(type, folder);
    assert.ok(readme.includes(command), `the README shows ${command}`);
    assert.ok(command.startsWith(`${display.PROVIDER_HOME_VARIABLES[type]}=`), 'and it sets the variable the server sets');
  }
  assert.equal(display.signInCommand('claude-cli', '  '), 'CLAUDE_CONFIG_DIR=<folder> claude auth login');
});

/* --------------------------------------------------------- reading a row */

test('where each value came from reads as the .env line, this page, or the default', () => {
  const env = { AI_CLI_BIN: '/opt/claude/bin/claude', AI_CODEX_CONCURRENCY: '3' };
  const stored = [
    { id: 'gemini-cli', type: 'gemini-cli', homeDir: '/srv/gemini-admin' },
    { id: 'prv-0000000b', type: 'codex-cli', label: 'Codex B', homeDir: '/srv/codex-b', concurrency_max_requests: 2 },
  ];
  const byId = Object.fromEntries(adminProviders(stored, env).map((entry) => [entry.id, entry]));
  assert.equal(display.sourceNote(byId['claude-cli'], 'binaryPath'), 'From .env (AI_CLI_BIN)');
  assert.equal(display.sourceNote(byId['claude-cli'], 'homeDir'), 'Not set');
  assert.equal(display.sourceNote(byId['claude-cli'], 'concurrency_max_requests'), 'Default');
  assert.equal(display.sourceNote(byId['codex-cli'], 'concurrency_max_requests'), 'From .env (AI_CODEX_CONCURRENCY)');
  assert.equal(display.sourceNote(byId['codex-cli'], 'binaryPath'), 'Default, found on PATH');
  assert.equal(display.sourceNote(byId['gemini-cli'], 'homeDir'), 'Set here');
  assert.equal(display.sourceNote(byId['prv-0000000b'], 'binaryPath'), "The built-in Codex provider's");
  assert.equal(display.sourceNote(byId['prv-0000000b'], 'homeDir'), 'Set here');
  assert.equal(display.describeHomeDir(byId['claude-cli']), "The CLI's own default folder");
  assert.equal(display.describeHomeDir(byId['gemini-cli']), '/srv/gemini-admin');

  assert.match(display.emptyMeans(byId['gemini-cli'], 'homeDir', byId['gemini-cli']), /not set/);
  assert.equal(
    display.emptyMeans(byId['claude-cli'], 'binaryPath', byId['claude-cli']),
    "Empty uses /opt/claude/bin/claude (AI_CLI_BIN, or the CLI's name on PATH)."
  );
  assert.equal(
    display.emptyMeans(null, 'concurrency_max_requests', byId['codex-cli']),
    "Empty takes 3, the type's limit from .env (AI_CODEX_CONCURRENCY) or its default."
  );
});

test("a provider's state: locked, switched off, held, signed out, busy, ready", () => {
  const [builtIn] = adminProviders();
  const card = (over = {}) =>
    display.normalizeProviderCard({
      ...builtIn,
      summary: '',
      ok: true,
      detail: 'Signed in.',
      warning: null,
      authMethod: 'oauth_token',
      checkedAt: '2026-10-05T10:00:00.000Z',
      ready: true,
      held: null,
      outages: [],
      queue: { queued: 0, running: 0, width: 4, serving: true },
      concurrency: { limit: 4, inFlight: 0, queued: 0 },
      ...over,
    });

  assert.deepEqual(display.providerStatus({ ...builtIn, locked: true, lockReason: 'Not here.' }, card()), {
    tone: 'grey',
    label: 'Locked',
    detail: 'Not here.',
    until: null,
  });
  assert.equal(display.providerStatus({ ...builtIn, enabled: false }, card()).label, 'Switched off');
  assert.equal(display.providerStatus(builtIn, null, { loading: true }).label, 'Checking');
  assert.equal(display.providerStatus(builtIn, null, { failed: true }).label, 'Unknown');

  const signedOut = display.providerStatus(
    builtIn,
    card({ ok: true, ready: false, held: { kind: 'auth', reason: 'The sign-in expired.', until: '2026-10-05T10:30:00.000Z' } })
  );
  assert.deepEqual(signedOut, { tone: 'red', label: 'Signed out', detail: 'The sign-in expired.', until: '2026-10-05T10:30:00.000Z' });
  assert.equal(
    display.providerStatus(builtIn, card({ ready: false, held: { kind: 'rateLimited', reason: 'Window spent.', until: 'x' } })).label,
    'Usage limit reached'
  );
  assert.equal(display.providerStatus(builtIn, card({ held: { kind: 'brandNew', reason: 'r', until: '' } })).label, 'Held (brandNew)');
  assert.deepEqual(display.providerStatus(builtIn, card({ ok: false, ready: false, detail: 'Not signed in.' })), {
    tone: 'red',
    label: 'Not ready',
    detail: 'Not signed in.',
    until: null,
  });
  assert.equal(display.providerStatus(builtIn, card({ warning: 'Window 90% used.' })).tone, 'amber');
  assert.deepEqual(display.providerStatus(builtIn, card()), { tone: 'green', label: 'Ready', detail: 'Signed in.', until: null });

  assert.equal(display.describeLane({ queued: 2, running: 1, width: 4, serving: true }), '1 building, 2 waiting');
  assert.equal(display.describeLane({ queued: 0, running: 0, width: 4, serving: true }), '');
  assert.equal(display.describeLane(null), '');
});

test('the built-in provider is marked and cannot be removed; moved work and removal read plainly', () => {
  const [builtIn, , codex] = adminProviders([
    { id: 'prv-0000000a', type: 'claude-cli', label: 'Team B', homeDir: '/srv/team-b', concurrency_max_requests: 2 },
  ]);
  const added = adminProviders([
    { id: 'prv-0000000a', type: 'claude-cli', label: 'Team B', homeDir: '/srv/team-b', concurrency_max_requests: 2 },
  ])[1];
  assert.equal(builtIn.builtIn, true);
  assert.equal(codex.builtIn, true);
  assert.equal(display.canRemove(builtIn), false);
  assert.equal(display.canRemove(added), true);
  assert.equal(
    display.removeQuestion(added),
    'Remove the provider "Team B"? Resumes waiting on it move to another Claude provider. Its sign-in folder on the server is left as it is.'
  );
  assert.equal(display.describeMoved(0, 'claude-cli'), '');
  assert.equal(display.describeMoved(1, 'claude-cli'), '1 waiting resume moved to another Claude provider.');
  assert.equal(display.describeMoved(3, 'gemini-cli'), '3 waiting resumes moved to another Gemini provider.');
  assert.equal(display.describeMoved('3', 'gemini-cli'), '');
});

test("an order's page names the provider that built a resume, for whoever the server tells", () => {
  assert.equal(
    display.describeRanOn({ id: 'claude-cli', label: 'Claude (Subscription)', type: 'claude-cli' }),
    'Built on Claude (Subscription)'
  );
  assert.equal(display.describeRanOn({ id: 'prv-12345678', label: 'Team B', type: 'claude-cli' }), 'Built on Team B (Claude)');
  assert.equal(display.describeRanOn({ id: 'prv-12345678', label: 'prv-12345678', type: 'codex-cli' }), 'Built on prv-12345678 (Codex)');
  assert.equal(display.describeRanOn({ id: 'prv-12345678', label: 'prv-12345678', type: null }), 'Built on prv-12345678');
  assert.equal(display.describeRanOn(null), '');
  assert.equal(display.describeRanOn(undefined), '');
});

test("Settings' type rows sum up their providers' cards", () => {
  const cards = [
    { type: 'claude-cli', ready: true, detail: 'Signed in.', warning: null },
    { type: 'claude-cli', ready: false, detail: 'Not signed in.', warning: null },
    { type: 'codex-cli', ready: true, detail: 'Logged in.', warning: 'Old CLI.' },
  ];
  assert.equal(
    display.describeTypeHealth(cards, 'claude-cli'),
    '1 of 2 Claude providers can take work now. Each has its own card above; add, change or remove them on Models.'
  );
  assert.equal(display.describeTypeHealth(cards, 'codex-cli'), 'Logged in. Old CLI.');
  assert.equal(display.describeTypeHealth(cards, 'gemini-cli'), 'No status reported.');
});

test('the per-provider holds on Settings read an added provider by its own id', () => {
  const { seatHolds } = loadFrontendModule('lib/seatHolds.ts');
  const hold = { scope: '*', reason: 'Signed out.', expiresAt: '2026-10-05T10:30:00.000Z' };
  const health = { subscription: { seat: null, outages: [] }, outagesByProvider: { 'claude-cli': [], 'prv-0000000a': [hold] } };
  assert.deepEqual(seatHolds(health, 'prv-0000000a'), [hold]);
  assert.deepEqual(seatHolds(health, 'claude-cli'), []);
});

/* ------------------------------------------------- against a real settings row */

function fresh(name) {
  const storage = useTempStorage(`frontend-providers-${name}`);
  config.invalidateSettingsCache();
  server.resetProviderSnapshotForTests();
  return storage;
}

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `frontend-providers-${name}-`));
}

test('the page offers a type exactly when the server can run it - a type whose every provider is off is not', async () => {
  fresh('offer');
  const { provider } = await config.createAIProvider({ type: 'claude-cli', label: 'Team B', homeDir: tempDir('team-b') });

  const agree = async (when) => {
    const admin = await config.getAdminAppSettings();
    const settings = await config.getAIModelSettings();
    const providers = display.normalizeAdminProviders(admin.aiProviders);
    for (const type of catalog.AI_PROVIDER_IDS) {
      // The page's own function, over what the admin payload carries.
      const offered = api.isProviderOffered(
        { providerLocks: admin.providerLocks, aiProviders: providers },
        type,
        admin.providersEnabled
      );
      assert.equal(offered, config.isProviderEnabled(type, settings), `${when}: ${type}`);
    }
  };

  await agree('every provider on');
  await config.updateAIProvider('claude-cli', { enabled: false });
  await agree('the built-in Claude provider off, the added one on');
  await config.updateAIProvider(provider.id, { enabled: false });
  await agree('every Claude provider off');
  assert.equal(display.hasEnabledProviderOfType([], 'claude-cli'), true, 'an older server sent no list: nothing is concluded from it');
});

async function serveAdmin(name) {
  fresh(name);
  useAdminEmails('admin@example.com');
  const users = require('../dist/database/userRepository');
  const admin = users.createUser({ email: 'admin@example.com' });
  const token = users.createSession(admin.id);

  const ai = require('../dist/services/ai/index');
  ai.resetRegistryForTests();
  const stub = (id) => () => ({
    id,
    capabilities: { id, label: 'stub', temperature: false, maxOutputTokens: false, nativeJsonMode: 'none', systemBlocks: true, maxConcurrency: 1 },
    defaultModelName: () => 'default',
    health: async () => ({ ok: true, detail: `${id} ready`, checkedAt: new Date().toISOString() }),
    complete: async () => {
      throw new Error('not here');
    },
  });
  for (const id of catalog.AI_PROVIDER_IDS) ai.registerAdapter(id, stub(id));

  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/admin/ai', require('../dist/routes/aiHealth').default);
  const listener = app.listen(0);
  const call = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/admin/ai${route}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    call,
    close: () => {
      listener.close();
      ai.resetRegistryForTests();
      require('../dist/services/queue/index').resetGenerationQueueForTests();
    },
  };
}

test("the page reads every field the provider routes send, and pins each refusal to the server's box", async (t) => {
  const s = await serveAdmin('routes');
  t.after(s.close);

  // A refusal of what was typed, through the route: the page's box for it.
  const relative = await s.call('POST', '/providers', { type: 'claude-cli', label: 'Two', homeDir: 'relative' });
  assert.equal(relative.status, 400);
  assert.equal(display.refusalField(relative.body), 'homeDir');
  const draftProblems = display.providerDraftProblems(
    { type: 'claude-cli', label: 'Two', homeDir: 'relative', binaryPath: '', concurrency_max_requests: '', enabled: true },
    null,
    []
  );
  assert.equal(draftProblems.homeDir, relative.body.error, 'and the page would have said the same before sending it');

  const added = await s.call(
    'POST',
    '/providers',
    display.addProviderBody({
      type: 'codex-cli',
      label: 'Codex B',
      homeDir: tempDir('codex-b'),
      binaryPath: '',
      concurrency_max_requests: '3',
      enabled: true,
    })
  );
  assert.equal(added.status, 201, JSON.stringify(added.body));

  // Everything the routes send, read without losing a field: the normaliser
  // returns what the server sent, key for key.
  const listed = await s.call('GET', '/providers');
  for (const raw of listed.body.providers) {
    assert.deepEqual(display.normalizeAdminProvider(raw), raw, `${raw.id} reads as sent`);
  }
  const health = await s.call('GET', '/health');
  for (const raw of health.body.providers) {
    const card = display.normalizeProviderCard(raw);
    const { capabilities: _capabilities, ...rest } = raw;
    assert.deepEqual(card, rest, `${raw.id}'s card reads as sent`);
  }
  const checked = await s.call('POST', `/providers/${added.body.provider.id}/check`);
  assert.equal(display.normalizeProviderCard(checked.body.provider).id, added.body.provider.id);

  // A built-in cannot be removed - the page offers no button, and the server
  // refuses one anyway, about the provider as a whole.
  const builtIn = await s.call('DELETE', '/providers/claude-cli');
  assert.equal(builtIn.status, 409);
  assert.equal(display.refusalField(builtIn.body), null);
  assert.equal(display.canRemove(display.normalizeAdminProvider(listed.body.providers[0])), false);
});

/* ------------------------------------------------------- where it may appear */

test('only administrator pages reach the provider routes', () => {
  // Folders and binaries on the server: the routes refuse everybody else, and
  // no page an ordinary account opens even asks.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        const relative = path.relative(SRC, full).split(path.sep).join('/');
        // An import of the client, or a request to the routes written out.
        if (/from ['"](@\/lib\/aiProviders|\.\.?\/(lib\/)?aiProviders)['"]|['"`]\/admin\/ai\/providers/.test(text)) {
          if (!relative.startsWith('app/admin/') && relative !== 'lib/aiProviders.ts') offenders.push(relative);
        }
      }
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, []);
});
