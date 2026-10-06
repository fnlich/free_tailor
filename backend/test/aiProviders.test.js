const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';

const { useAdminEmails, useTempStorage } = require('./helpers');

/**
 * Model PROVIDERS (owner decisions P1, P2): an administrator adds a provider of
 * a type at a location of its own - a sign-in folder, optionally a binary -
 * with its own `concurrency_max_requests`. The first of each type is the
 * built-in one, with the type's id, configured from `.env` unless an
 * administrator sets a value, which wins. Every path is checked; a folder is
 * never shared by two providers of one type.
 */

const providers = require('../dist/config/aiProviders');
const config = require('../dist/config/aiModelConfig');

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ai-providers-${name}-`));
}

function executable(dir, name = 'claude') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\necho 1.0\n');
  fs.chmodSync(file, 0o755);
  return file;
}

function fresh(name) {
  const storage = useTempStorage(`ai-providers-${name}`);
  config.invalidateSettingsCache();
  providers.resetProviderSnapshotForTests();
  return storage;
}

test('every type has its built-in provider first, with the type id, whatever the row holds', () => {
  const list = providers.normalizeStoredProviders([
    { id: 'prv-0000000a', type: 'codex-cli', label: 'Codex two', homeDir: '/srv/codex-two', concurrency_max_requests: 3 },
    { id: 'claude-cli', type: 'claude-cli', concurrency_max_requests: 9 },
    { id: 'prv-0000000b', type: 'claude-cli', label: 'Claude two', homeDir: '/srv/claude-two' },
    { id: 'prv-0000000c', type: 'claude-web', homeDir: '/x' },
    { id: 'not-an-id', type: 'claude-cli', homeDir: '/x' },
    { id: 'prv-0000000d', type: 'claude-cli', label: 'No folder' },
    { id: 'codex-cli', type: 'claude-cli' },
  ]);
  assert.deepEqual(
    list.map((entry) => entry.id),
    ['claude-cli', 'prv-0000000b', 'codex-cli', 'prv-0000000a', 'gemini-cli'],
    'grouped by type in catalog order, built-in first; a retired type, a bad id, an added one with no folder and a built-in under another type are dropped'
  );
  assert.equal(list[0].concurrency_max_requests, 9, 'a built-in keeps what an administrator set');
  assert.equal(list[2].label, 'Codex (Subscription)', 'a built-in nobody named is named after its type');
});

test("a built-in provider reads today's .env, and an administrator's value wins - the payload says which", () => {
  const env = {
    AI_CLI_BIN: '/opt/claude/bin/claude',
    CLAUDE_CONFIG_DIR: '/srv/claude-home',
    AI_CLI_CONCURRENCY: '6',
    CODEX_HOME: '/srv/codex-home',
    AI_GEMINI_HOME: '/srv/gemini-home',
    AI_GEMINI_CONCURRENCY: '3',
  };
  const resolved = providers.resolveProviders([], env);
  const byId = Object.fromEntries(resolved.map((entry) => [entry.id, entry]));

  assert.equal(byId['claude-cli'].binaryPath, '/opt/claude/bin/claude');
  assert.equal(byId['claude-cli'].homeDir, '/srv/claude-home');
  assert.equal(byId['claude-cli'].concurrency_max_requests, 6);
  assert.deepEqual(byId['claude-cli'].sources, { homeDir: 'env', binaryPath: 'env', concurrency_max_requests: 'env' });
  assert.equal(byId['codex-cli'].binaryPath, 'codex');
  assert.equal(byId['codex-cli'].homeDir, '/srv/codex-home');
  assert.deepEqual(byId['codex-cli'].sources, { homeDir: 'env', binaryPath: 'default', concurrency_max_requests: 'default' });
  assert.equal(byId['codex-cli'].concurrency_max_requests, 4);
  assert.equal(byId['gemini-cli'].homeDir, path.resolve('/srv/gemini-home'));
  assert.equal(byId['gemini-cli'].concurrency_max_requests, 3);
  assert.deepEqual(byId['gemini-cli'].envDefaults, {
    homeDir: path.resolve('/srv/gemini-home'),
    binaryPath: 'gemini',
    concurrency_max_requests: 3,
  });

  // An administrator's values win, and `.env`'s stay on the payload beside them.
  const overridden = providers.resolveProviders(
    [{ id: 'claude-cli', type: 'claude-cli', homeDir: '/srv/other-home', binaryPath: '/usr/local/bin/claude', concurrency_max_requests: 2 }],
    env
  )[0];
  assert.equal(overridden.homeDir, '/srv/other-home');
  assert.equal(overridden.binaryPath, '/usr/local/bin/claude');
  assert.equal(overridden.concurrency_max_requests, 2);
  assert.deepEqual(overridden.sources, { homeDir: 'admin', binaryPath: 'admin', concurrency_max_requests: 'admin' });
  assert.deepEqual(overridden.envDefaults, { homeDir: '/srv/claude-home', binaryPath: '/opt/claude/bin/claude', concurrency_max_requests: 6 });

  // An added provider with no binary of its own runs the type's.
  const added = providers.resolveProviders(
    [{ id: 'prv-0000000e', type: 'claude-cli', label: 'Two', homeDir: '/srv/two', concurrency_max_requests: 1 }],
    env
  )[1];
  assert.equal(added.binaryPath, '/opt/claude/bin/claude');
  assert.equal(added.sources.binaryPath, 'type');
  assert.equal(added.envDefaults, null);
});

test('paths are checked: absolute, existing, the right kind, executable, outside the app', () => {
  const app = tempDir('app');
  const outside = tempDir('outside');
  const home = path.join(outside, 'claude-two');
  fs.mkdirSync(home);
  const binary = executable(outside);
  const notExecutable = path.join(outside, 'plain');
  fs.writeFileSync(notExecutable, 'x');
  fs.chmodSync(notExecutable, 0o644);
  const insideApp = path.join(app, 'claude-home');
  fs.mkdirSync(insideApp);
  const context = { providers: providers.resolveProviders([], {}), appDirectories: [app] };
  const add = (body) => providers.buildNewProvider({ type: 'claude-cli', label: 'Two', homeDir: home, ...body }, context);
  const refused = (body, code) =>
    assert.throws(() => add(body), (error) => error instanceof providers.AIProviderInputError && error.code === code, code);

  const ok = add({ binaryPath: binary, concurrency_max_requests: '2' });
  assert.match(ok.id, /^prv-[0-9a-f]{8}$/);
  assert.equal(ok.concurrency_max_requests, 2);
  assert.equal(ok.binaryPath, binary);

  refused({ homeDir: 'relative/home' }, 'path-not-absolute');
  refused({ homeDir: '~/claude' }, 'path-not-absolute');
  refused({ homeDir: path.join(outside, 'missing') }, 'path-missing');
  refused({ homeDir: binary }, 'not-a-directory');
  refused({ homeDir: '' }, 'home-required');
  refused({ homeDir: insideApp }, 'path-inside-app');
  refused({ homeDir: app }, 'path-inside-app');
  refused({ binaryPath: 'claude' }, 'path-not-absolute');
  refused({ binaryPath: path.join(outside, 'nope') }, 'path-missing');
  refused({ binaryPath: home }, 'not-a-file');
  refused({ binaryPath: notExecutable }, 'not-executable');
  refused({ binaryPath: executable(app) }, 'path-inside-app');
  refused({ type: 'claude-web' }, 'bad-type');
  refused({ label: '  ' }, 'label-required');
  refused({ label: 'Claude (Subscription)' }, 'label-in-use');
  for (const bad of [0, 33, 2.5, '4.5', 'x', -1, true]) refused({ concurrency_max_requests: bad }, 'bad-concurrency');

  // A symlink into the app is the app.
  const link = path.join(outside, 'link-to-app');
  fs.symlinkSync(insideApp, link);
  refused({ homeDir: link }, 'path-inside-app');
});

test('a folder already used by another provider of the type is refused; another type may use it', () => {
  const shared = tempDir('shared');
  const context = {
    providers: providers.resolveProviders(
      [{ id: 'prv-0000000f', type: 'claude-cli', label: 'One', homeDir: shared, concurrency_max_requests: 1 }],
      {}
    ),
    appDirectories: [],
  };
  assert.throws(
    () => providers.buildNewProvider({ type: 'claude-cli', label: 'Two', homeDir: `${shared}/` }, context),
    (error) => error.code === 'home-in-use' && error.status === 409
  );
  assert.ok(providers.buildNewProvider({ type: 'codex-cli', label: 'Codex', homeDir: shared }, context));

  // The built-in with no folder set signs in at the CLI's own default; naming
  // that folder for an added one is the same folder.
  const home = tempDir('homedir');
  fs.mkdirSync(path.join(home, '.claude'));
  assert.throws(
    () =>
      providers.buildNewProvider(
        { type: 'claude-cli', label: 'Default again', homeDir: path.join(home, '.claude') },
        { ...context, deps: { ...providers.defaultProviderPathDeps(), homedir: () => home } }
      ),
    (error) => error.code === 'home-in-use'
  );
});

test('providers are kept in the settings row: added, edited, overridden, cleared, switched off, removed', async () => {
  fresh('settings');
  const home = tempDir('home');
  const created = await config.createAIProvider({ type: 'claude-cli', label: 'Claude two', homeDir: home, concurrency_max_requests: 2 });
  const id = created.provider.id;
  assert.equal(created.provider.homeVariable, 'CLAUDE_CONFIG_DIR');
  assert.deepEqual(
    created.providers.map((entry) => entry.id),
    ['claude-cli', id, 'codex-cli', 'gemini-cli']
  );
  const admin = await config.getAdminAppSettings();
  assert.equal(admin.aiProviders.find((entry) => entry.id === id).label, 'Claude two', 'on the admin payload');
  const user = await config.getUserAppSettings();
  assert.equal('aiProviders' in user, false, 'and never on an ordinary account\'s');

  // The built-in's own values: an override, then cleared back to .env.
  const overridden = await config.updateAIProvider('claude-cli', { concurrency_max_requests: 9 });
  assert.equal(overridden.provider.concurrency_max_requests, 9);
  assert.equal(overridden.provider.sources.concurrency_max_requests, 'admin');
  const cleared = await config.updateAIProvider('claude-cli', { concurrency_max_requests: '' });
  assert.equal(cleared.provider.sources.concurrency_max_requests, 'default');
  assert.equal(cleared.provider.concurrency_max_requests, 4);

  // The row stores only what an administrator set: an untouched built-in is
  // not in it, so a later .env edit still reaches it.
  const { readSettingRaw } = require('./helpers');
  const stored = JSON.parse(readSettingRaw(process.env.DB_DIR, 'app-settings')).aiProviders;
  assert.deepEqual(stored.map((entry) => entry.id), [id]);

  await assert.rejects(() => config.updateAIProvider(id, { type: 'codex-cli' }), (error) => error.code === 'type-fixed');
  await assert.rejects(() => config.updateAIProvider(id, { homeDir: null }), (error) => error.code === 'home-required');
  await assert.rejects(() => config.updateAIProvider('prv-ffffffff', {}), (error) => error.status === 404);
  await assert.rejects(() => config.deleteAIProvider('claude-cli'), (error) => error.code === 'built-in' && error.status === 409);

  const removed = await config.deleteAIProvider(id);
  assert.deepEqual(removed.providers.map((entry) => entry.id), ['claude-cli', 'codex-cli', 'gemini-cli']);
});

test('a type with every provider switched off runs nothing, and the last runnable one cannot be switched off', async () => {
  fresh('switched-off');
  const home = tempDir('two');
  const { provider } = await config.createAIProvider({ type: 'claude-cli', label: 'Two', homeDir: home });
  await config.updateAIProvider('claude-cli', { enabled: false });
  let settings = await config.getAIModelSettings();
  assert.equal(config.isProviderEnabled('claude-cli', settings), true, 'another Claude provider still runs the type');

  await config.updateAIProvider(provider.id, { enabled: false });
  settings = await config.getAIModelSettings();
  assert.equal(config.isProviderEnabled('claude-cli', settings), false, 'none left: the type is off');
  const runnable = (await config.getUserAppSettings()).models.map((model) => model.id);
  assert.equal(runnable.some((id) => id.startsWith('claude-cli')), false, 'and its models are not offered');

  // Every other type off too: the last provider standing is refused.
  await config.updateAIProvider('codex-cli', { enabled: false });
  await assert.rejects(
    () => config.updateAIProvider('gemini-cli', { enabled: false }),
    (error) => error.code === 'nothing-left' && error.status === 409
  );
});

/* ------------------------------------------------------------------ routes */

async function serveAdmin(name) {
  fresh(name);
  useAdminEmails('admin@example.com');
  const users = require('../dist/database/userRepository');
  const admin = users.createUser({ email: 'admin@example.com' });
  const user = users.createUser({ email: 'user@example.com' });
  const tokens = { admin: users.createSession(admin.id), user: users.createSession(user.id) };

  const ai = require('../dist/services/ai/index');
  ai.resetRegistryForTests();
  const stub = (id, ok = true) => () => ({
    id,
    capabilities: { id, label: 'stub', temperature: false, maxOutputTokens: false, nativeJsonMode: 'none', systemBlocks: true, maxConcurrency: 1 },
    defaultModelName: () => 'default',
    health: async () => ({ ok, detail: ok ? `${id} ready` : `${id} signed out`, checkedAt: new Date().toISOString() }),
    complete: async () => {
      throw new Error('not here');
    },
  });
  for (const id of ['claude-cli', 'codex-cli', 'gemini-cli']) ai.registerAdapter(id, stub(id));

  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/admin/ai', require('../dist/routes/aiHealth').default);
  const server = app.listen(0);
  const call = async (who, method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/ai${route}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    ai,
    stub,
    call,
    close: () => {
      server.close();
      ai.resetRegistryForTests();
      require('../dist/services/queue/index').resetGenerationQueueForTests();
    },
  };
}

test('the provider routes: add, edit, check, remove - administrators only, refusals by name', async (t) => {
  const s = await serveAdmin('routes');
  t.after(s.close);
  const home = tempDir('route-home');

  assert.equal((await s.call('user', 'GET', '/providers')).status, 403);
  assert.equal((await s.call('user', 'POST', '/providers', { type: 'claude-cli', label: 'x', homeDir: home })).status, 403);

  const bad = await s.call('admin', 'POST', '/providers', { type: 'claude-cli', label: 'Two', homeDir: 'relative' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'path-not-absolute');
  assert.equal(bad.body.field, 'homeDir');

  const added = await s.call('admin', 'POST', '/providers', {
    type: 'claude-cli',
    label: 'Claude two',
    homeDir: home,
    concurrency_max_requests: 2,
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const id = added.body.provider.id;
  assert.equal(added.body.provider.homeDir, home);

  const edited = await s.call('admin', 'PUT', `/providers/${id}`, { concurrency_max_requests: 4, label: 'Claude, team B' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.provider.concurrency_max_requests, 4);
  assert.equal(edited.body.moved, 0);

  const checked = await s.call('admin', 'POST', `/providers/${id}/check`);
  assert.equal(checked.status, 200);
  assert.equal(checked.body.provider.ok, true);
  assert.equal(checked.body.provider.detail, 'claude-cli ready', "an added provider without a stub of its own is answered by its type's");

  const health = await s.call('admin', 'GET', '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(
    health.body.providers.map((card) => [card.id, card.type, card.builtIn]),
    [
      ['claude-cli', 'claude-cli', true],
      [id, 'claude-cli', false],
      ['codex-cli', 'codex-cli', true],
      ['gemini-cli', 'gemini-cli', true],
    ],
    'one card per provider'
  );
  const card = health.body.providers.find((entry) => entry.id === id);
  assert.equal(card.concurrency_max_requests, 4);
  assert.equal(card.ready, true);
  assert.deepEqual(Object.keys(health.body.outagesByProvider).sort(), ['claude-cli', 'codex-cli', 'gemini-cli', id].sort());

  assert.equal((await s.call('admin', 'DELETE', '/providers/claude-cli')).body.code, 'built-in');
  const removed = await s.call('admin', 'DELETE', `/providers/${id}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.providers.some((entry) => entry.id === id), false);
  assert.equal((await s.call('admin', 'DELETE', `/providers/${id}`)).status, 404);
});

test('the health card is per provider: one signed out, the other serving', async (t) => {
  const s = await serveAdmin('health');
  t.after(s.close);
  const home = tempDir('health-home');
  const added = await s.call('admin', 'POST', '/providers', { type: 'claude-cli', label: 'Claude two', homeDir: home });
  const id = added.body.provider.id;
  // The added provider's own stub: signed out.
  s.ai.registerAdapter(id, s.stub(id, false));

  const health = await s.call('admin', 'GET', '/health');
  const builtIn = health.body.providers.find((card) => card.id === 'claude-cli');
  const second = health.body.providers.find((card) => card.id === id);
  assert.equal(builtIn.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.detail, `${id} signed out`);
});

test('a provider building a resume cannot be removed; switched off, its waiting work moves', async (t) => {
  const s = await serveAdmin('busy');
  t.after(s.close);
  const home = tempDir('busy-home');
  const added = await s.call('admin', 'POST', '/providers', { type: 'claude-cli', label: 'Claude two', homeDir: home, concurrency_max_requests: 1 });
  const id = added.body.provider.id;
  await s.call('admin', 'PUT', '/providers/claude-cli', { concurrency_max_requests: 1 });

  const queueModule = require('../dist/services/queue/index');
  const queue = queueModule.getGenerationQueue();
  const kind = 'provider-busy-test';
  const running = new Map();
  queueModule.registerTaskRunner(kind, (payload, assignment) =>
    new Promise((resolve) => running.set(payload.label, { resolve, on: assignment.queue }))
  );
  const task = (label) => ({
    queue: 'claude-cli',
    label: { profileId: label, profileName: label, companyName: 'Acme', role: '' },
    kind,
    payload: { label },
  });
  await queue.refreshCapacity();
  // Placed by free capacity, ties to the built-in: a and c on it, b and d on the added one.
  queue.submit(['a', 'b', 'c', 'd'].map(task));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(running.get('b').on, id);
  assert.deepEqual([queue.stats()[id].running, queue.stats()[id].queued], [1, 1]);

  const busy = await s.call('admin', 'DELETE', `/providers/${id}`);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, 'provider-busy');
  assert.equal(busy.body.running, 1);

  const off = await s.call('admin', 'PUT', `/providers/${id}`, { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.moved, 1, 'its waiting resume moved to the other Claude provider');
  assert.equal(queue.stats()['claude-cli'].queued, 2);
  assert.equal(queue.stats()[id].running, 1, 'what it was building, it finishes');

  // Its slot freeing takes nothing new; the built-in works through the rest.
  running.get('b').resolve({});
  running.get('a').resolve({});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(running.get('c').on, 'claude-cli');
  running.get('c').resolve({});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(running.get('d').on, 'claude-cli');
  running.get('d').resolve({});
});

test('a settings save keeps every added provider, and ignores a provider list it is sent', async () => {
  fresh('settings-save');
  const { readSettingRaw } = require('./helpers');
  const { provider } = await config.createAIProvider({ type: 'claude-cli', label: 'Two', homeDir: tempDir('kept') });

  // Admin -> Settings -> General saves the whole row; the providers are not
  // on that page, and a save must not take them with it.
  await config.updateAppSettings({ requireThreeDSecure: true });
  assert.ok((await config.getAdminAppSettings()).aiProviders.some((entry) => entry.id === provider.id), 'still listed');
  const stored = () => JSON.parse(readSettingRaw(process.env.DB_DIR, 'app-settings')).aiProviders;
  assert.deepEqual(stored().map((entry) => entry.id), [provider.id], 'and still stored');

  // Nor may a settings save ADD one: a list there would skip every path,
  // folder and limit check the provider routes make.
  await config.updateAppSettings({
    requireThreeDSecure: false,
    aiProviders: [{ id: 'prv-00000001', type: 'claude-cli', label: 'Root', homeDir: '/', concurrency_max_requests: 32 }],
  });
  assert.deepEqual(stored().map((entry) => entry.id), [provider.id], 'the list sent is not read');
  assert.deepEqual(
    (await config.getAdminAppSettings()).aiProviders.map((entry) => entry.id),
    ['claude-cli', provider.id, 'codex-cli', 'gemini-cli']
  );
});

test('an edit is checked like an add: the binary, the folder, and a folder another provider signs in at', async () => {
  const storage = fresh('edit-checks');
  const outside = tempDir('edit');
  const first = path.join(outside, 'first');
  const second = path.join(outside, 'second');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  await config.createAIProvider({ type: 'claude-cli', label: 'One', homeDir: first });
  const { provider } = await config.createAIProvider({ type: 'claude-cli', label: 'Two', homeDir: second });
  const plain = path.join(outside, 'plain');
  fs.writeFileSync(plain, 'x');
  fs.chmodSync(plain, 0o644);
  const inDb = path.join(storage.dbDir, 'claude-home');
  fs.mkdirSync(inDb);
  const refused = (body, code) =>
    assert.rejects(() => config.updateAIProvider(provider.id, body), (error) => error.code === code, code);

  await refused({ binaryPath: 'claude' }, 'path-not-absolute');
  await refused({ binaryPath: plain }, 'not-executable');
  await refused({ homeDir: 'relative/home' }, 'path-not-absolute');
  await refused({ homeDir: inDb }, 'path-inside-app');
  await refused({ homeDir: `${first}/` }, 'home-in-use');
  // The built-in's folder, set by an administrator, is as taken as an added one's.
  const builtInHome = path.join(outside, 'built-in');
  fs.mkdirSync(builtInHome);
  await config.updateAIProvider('claude-cli', { homeDir: builtInHome });
  await refused({ homeDir: builtInHome }, 'home-in-use');

  const binary = executable(outside);
  const edited = await config.updateAIProvider(provider.id, { binaryPath: binary });
  assert.equal(edited.provider.binaryPath, binary, 'a good binary is taken');
});

test("the app's own directories are the real ones: the checkout, DB_DIR, the static and output directories, Gemini's work and state", async () => {
  const storage = fresh('app-directories');
  const output = tempDir('output');
  const { geminiCliStateDir, geminiCliWorkdir } = require('../dist/services/ai/providers/geminiCli/options');
  const directories = config.listAppDirectories({ outputBaseDir: output });
  for (const [what, dir] of [
    ['the checkout', path.resolve(__dirname, '..', '..')],
    ['DB_DIR', storage.dbDir],
    ['the static directory', require('../dist/config/staticPaths').getStaticDir()],
    ['the output directory', output],
    ["Gemini's work directory", geminiCliWorkdir(process.env)],
    ["Gemini's state directory", geminiCliStateDir(process.env)],
  ]) {
    assert.ok(directories.includes(path.resolve(dir)), `${what} (${dir}) is one: ${JSON.stringify(directories)}`);
  }

  // And an add is refused under each of them - not only under a list a test made up.
  for (const base of [storage.dbDir, storage.staticDir]) {
    const home = path.join(base, 'claude-home');
    fs.mkdirSync(home);
    await assert.rejects(
      () => config.createAIProvider({ type: 'claude-cli', label: `Inside ${path.basename(base)}`, homeDir: home }),
      (error) => error.code === 'path-inside-app'
    );
  }
});
