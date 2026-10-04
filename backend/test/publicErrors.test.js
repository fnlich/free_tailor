const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

/** Every seat is unlocked here, whatever the machine running this says. Set before any dist module loads. */
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';

const { captureErrorLog, refAndLog, useAdminEmails, useTempStorage, writeStaticJson } = require('./helpers');

/**
 * What somebody who is not an administrator is told when something fails.
 *
 * The rule (middleware/publicError.ts): a message is specific only when it is
 * about the caller's own input, objects or entitlements and names nothing about
 * how the installation is run. Everything else is a generic sentence and a
 * `ref`, with the cause logged once under that ref - and an administrator
 * additionally gets the cause as `detail`. Each class below is checked both
 * ways: the generic sentence, a ref and no detail for an account holder; the
 * same sentence plus the detail for an administrator.
 *
 * Modules are required once rather than loaded fresh: the model settings and
 * the queue are cached in their modules, and a route holding one copy while the
 * test writes through another would read stale state.
 */

const config = require('../dist/config/aiModelConfig');
const publicError = require('../dist/middleware/publicError');
const { PUBLIC_AI_MESSAGE, AIProviderError } = require('../dist/services/ai/index');

const REF = /^ERR-[0-9A-F]{6}$/;

async function serve(name, mount) {
  const { staticDir, dbDir } = useTempStorage(`public-errors-${name}`);
  useAdminEmails('admin@example.com');
  config.invalidateSettingsCache();

  const users = require('../dist/database/userRepository');
  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  const tokens = { admin: users.createSession(admin.id), alice: users.createSession(alice.id) };

  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  mount(app);
  app.use(publicError.publicErrorHandler);
  const server = app.listen(0);
  const port = server.address().port;

  const call = async (who, method, route, body, raw) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}),
      },
      ...(raw !== undefined ? { body: raw } : body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: response.status, body: parsed, headers: response.headers };
  };
  return { call, close: () => server.close(), admin, alice, staticDir, dbDir };
}

/* --------------------------------------------------------------- the classes */

test('a public error says its own words to anybody; its detail is only for an administrator', () => {
  const plain = new publicError.PublicError('Job description must be at least 50 characters', { status: 400 });
  assert.deepEqual(publicError.publicFailure(plain, { admin: false }), {
    status: 400,
    body: { error: 'Job description must be at least 50 characters' },
  });

  const withDetail = new publicError.PublicError('Purchases are not available right now. Please contact your administrator.', {
    status: 503,
    code: 'purchases-unavailable',
    extra: { method: 'card' },
    detail: 'card purchases are not available: at 15000c per credit ...',
  });
  return captureErrorLog(() => {
    const asUser = publicError.publicFailure(withDetail, { admin: false, context: 'POST /api/payments/checkout' });
    const asAdmin = publicError.publicFailure(withDetail, { admin: true });
    return { asUser, asAdmin };
  }).then(({ result: { asUser, asAdmin }, lines }) => {
    assert.equal(asUser.status, 503);
    assert.equal(asUser.body.error, withDetail.message);
    assert.equal(asUser.body.code, 'purchases-unavailable');
    assert.equal(asUser.body.method, 'card', 'extra fields ride along');
    assert.match(asUser.body.ref, REF);
    assert.equal(asUser.body.detail, undefined);
    assert.equal(asAdmin.body.detail, withDetail.detail);
    const logged = lines.find((line) => line.includes(`[error ${asUser.body.ref}]`));
    assert.match(logged, /15000c per credit/, 'the cause is in the log under the ref');
    assert.match(logged, /POST \/api\/payments\/checkout/);
  });
});

test('anything that is not public is the generic sentence and a ref, never its own message', async () => {
  const raw = new Error("SQLITE_BUSY: database is locked (/data/db/free_tailor.db)");
  const { result, lines } = await captureErrorLog(() => ({
    asUser: publicError.publicFailure(raw, { admin: false, fallback: 'Failed to fetch groups' }),
    asAdmin: publicError.publicFailure(raw, { admin: true, fallback: 'Failed to fetch groups' }),
  }));
  assert.equal(result.asUser.status, 500);
  assert.equal(result.asUser.body.error, 'Failed to fetch groups. Please try again, or contact your administrator.');
  assert.match(result.asUser.body.ref, REF);
  assert.equal(result.asUser.body.detail, undefined);
  assert.doesNotMatch(JSON.stringify(result.asUser.body), /SQLITE|\/data\/db/);
  assert.equal(result.asAdmin.body.detail, raw.message);
  assert.match(lines.find((line) => line.includes(`[error ${result.asUser.body.ref}]`)), /SQLITE_BUSY/);

  // With nothing said about what failed, it is the plainest sentence there is.
  const quiet = await captureErrorLog(() => publicError.publicFailure('a thrown string', {}));
  assert.equal(quiet.result.body.error, 'Something went wrong. Please try again, or contact your administrator.');
});

test("body-parser's refusals are the request's, and never quote it", () => {
  const parse = Object.assign(new SyntaxError('Unexpected token } in JSON at position 12'), { type: 'entity.parse.failed' });
  assert.deepEqual(publicError.publicFailure(parse, { admin: false }), {
    status: 400,
    body: { error: 'The request could not be read.' },
  });
  const big = Object.assign(new Error('request entity too large'), { type: 'entity.too.large' });
  assert.deepEqual(publicError.publicFailure(big, { admin: false }), {
    status: 413,
    body: { error: 'That request is too large.' },
  });
  assert.equal(publicError.publicFailure(parse, { admin: true }).body.detail, parse.message);
});

test('a stored failure is the public sentence and a ref; an old raw one reads generically', async () => {
  const { result: stored, lines } = await captureErrorLog(() =>
    publicError.publicTaskError(
      new Error("EACCES: permission denied, mkdir '/data/generated/alice'"),
      'This resume could not be built',
      'task tsk_1'
    )
  );
  assert.match(stored, /^This resume could not be built\. Please try again, or contact your administrator\. \(Ref: ERR-[0-9A-F]{6}\)$/);
  assert.match(refAndLog(stored, lines).logged, /EACCES/);

  // An AI failure stores its public sentence, still with a ref.
  const ai = await captureErrorLog(() =>
    publicError.publicTaskError(new AIProviderError({ provider: 'codex-cli', kind: 'rateLimited' }), 'x')
  );
  assert.match(ai.result, new RegExp(`^${PUBLIC_AI_MESSAGE.busy.replace(/\./g, '\\.')} \\(Ref: ERR-`));

  // Reading: what this module wrote passes, and so do the fixed public texts;
  // anything else - a row from before - becomes the generic sentence.
  const read = (text) => publicError.publicStoredError(text, 'This resume could not be built');
  assert.equal(read(stored), stored);
  assert.equal(read('Cancelled before it started'), 'Cancelled before it started');
  assert.equal(read(`Cancelled after 2 attempt(s); last failure: ${stored}`), `Cancelled after 2 attempt(s); last failure: ${stored}`);
  assert.equal(
    read('The Claude CLI is not installed or is not on the server PATH. (spawn /usr/local/bin/claude ENOENT)'),
    'This resume could not be built. Please try again, or contact your administrator.'
  );
  assert.equal(
    read('Profile 7c9e6679-7425-40de-944b-e07fc1f90ae7 no longer exists, so this resume cannot be generated.'),
    'This resume could not be built. Please try again, or contact your administrator.'
  );
});

test('the user-actionable refusals the app already had are public, with their fields', () => {
  const { InsufficientCreditsError } = require('../dist/services/credits/errors');
  const { ProfileLimitError } = require('../dist/database/profileRepository');
  const { ModelUnavailableError, AiUnavailableError } = require('../dist/config/modelErrors');

  const credits = publicError.publicFailure(new InsufficientCreditsError(6, 2), { admin: false });
  assert.equal(credits.status, 402);
  assert.deepEqual(
    { code: credits.body.code, needed: credits.body.needed, balance: credits.body.balance },
    { code: 'insufficient-credits', needed: 6, balance: 2 }
  );
  assert.equal(credits.body.ref, undefined, 'the caller\'s own balance: nothing to look up');

  const limit = publicError.publicFailure(new ProfileLimitError('Free', 1, 1), { admin: false });
  assert.equal(limit.status, 402);
  assert.equal(limit.body.code, 'profile-limit');
  assert.equal(limit.body.limit, 1);

  return captureErrorLog(() => ({
    model: publicError.publicFailure(new ModelUnavailableError('"gpt-6-luna" is switched off.'), { admin: false }),
    none: publicError.publicFailure(new AiUnavailableError('every AI provider is locked (AI_LOCKED_PROVIDERS: ...)'), {
      admin: false,
    }),
  })).then(({ result }) => {
    assert.equal(result.model.status, 400);
    assert.equal(result.model.body.detail, undefined);
    assert.match(result.model.body.ref, REF);
    assert.equal(result.none.status, 503);
    assert.equal(result.none.body.error, "AI generation isn't available right now. Please contact your administrator.");
    assert.doesNotMatch(JSON.stringify(result.none.body), /AI_LOCKED_PROVIDERS/);
  });
});

/* ------------------------------------------------------------- over HTTP */

test('the last-resort handler answers generically, with a ref; an administrator also gets the cause', async () => {
  const server = await serve('handler', (app) => {
    app.get('/api/boom', () => {
      throw new Error('ENOENT: no such file or directory, open /srv/backend/static/templates/default.json');
    });
    app.post('/api/echo', (req, res) => res.json(req.body));
  });
  try {
    const { result: asUser, lines } = await captureErrorLog(() => server.call('alice', 'GET', '/api/boom'));
    assert.equal(asUser.status, 500);
    assert.equal(asUser.body.error, 'Something went wrong. Please try again, or contact your administrator.');
    assert.match(asUser.body.ref, REF);
    assert.equal(asUser.body.detail, undefined);
    assert.doesNotMatch(JSON.stringify(asUser.body), /ENOENT|\/srv/);
    assert.match(lines.find((line) => line.includes(`[error ${asUser.body.ref}]`)), /GET \/api\/boom/);

    const { result: asAdmin } = await captureErrorLog(() => server.call('admin', 'GET', '/api/boom'));
    assert.match(asAdmin.body.detail, /ENOENT/);

    // A body that is not JSON is the caller's 400, not the server's 500 - and
    // the parser's complaint, which quotes the body, is not repeated.
    const garbled = await server.call('alice', 'POST', '/api/echo', undefined, '{"half": ');
    assert.equal(garbled.status, 400);
    assert.deepEqual(garbled.body, { error: 'The request could not be read.' });
  } finally {
    server.close();
  }
});

test('an AI failure on a route is one public sentence; the seat, the command and the stderr are the administrator\'s', async () => {
  const server = await serve('ai-route', (app) => {
    app.use('/api/resume', require('../dist/routes/resume').default);
  });
  writeStaticJson(server.staticDir, 'prompts/analyze-job-description.json', {
    id: 'analyze-job-description',
    content: 'Analyse [[jobDescription]]',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    allowedVariables: [{ name: 'jobDescription' }],
  });
  const ai = require('../dist/services/ai/index');
  ai.resetRegistryForTests();
  ai.registerAdapter('claude-cli', () => ({
    id: 'claude-cli',
    capabilities: {
      id: 'claude-cli', label: 'stub', temperature: false, maxOutputTokens: false,
      nativeJsonMode: 'json-schema', systemBlocks: true, maxConcurrency: 4,
    },
    defaultModelName: () => 'sonnet',
    health: async () => ({ ok: true, detail: 'stub', checkedAt: new Date().toISOString() }),
    async complete() {
      throw new AIProviderError({
        provider: 'claude-cli',
        kind: 'auth',
        detail: 'Invalid API key - Please run /login (exit 1, /usr/local/bin/claude)',
        adminAction: 'Run `claude auth login` as the service user, or set AI_CLI_BIN.',
      });
    },
  }));
  const posting = { jobDescription: 'A remote engineering role building resume software for job seekers. '.repeat(2) };
  try {
    const { result: asUser, lines } = await captureErrorLog(() => server.call('alice', 'POST', '/api/resume/analyze', posting));
    assert.equal(asUser.status, 503);
    assert.deepEqual(Object.keys(asUser.body).sort(), ['code', 'error', 'ref']);
    assert.equal(asUser.body.error, PUBLIC_AI_MESSAGE.contactAdmin);
    assert.equal(asUser.body.code, 'ai-unavailable');
    assert.doesNotMatch(JSON.stringify(asUser.body), /claude|Claude|AI_CLI_BIN|login|\/usr/);
    assert.match(lines.find((line) => line.includes(`[error ${asUser.body.ref}]`)), /Invalid API key/);

    const { result: asAdmin } = await captureErrorLog(() => server.call('admin', 'POST', '/api/resume/analyze', posting));
    assert.equal(asAdmin.body.error, PUBLIC_AI_MESSAGE.contactAdmin, 'the same sentence');
    assert.match(asAdmin.body.detail, /claude auth login/);
    assert.match(asAdmin.body.detail, /Invalid API key/);
    assert.match(asAdmin.body.detail, /\[claude-cli: auth\]/);
  } finally {
    ai.resetRegistryForTests();
    server.close();
  }
});

test('the routes that leak an installation\'s workings are administrator-only', async () => {
  const server = await serve('gates', (app) => {
    app.use('/api/admin/ai', require('../dist/routes/aiHealth').default);
    app.use('/api/generation', require('../dist/routes/generation').default);
    app.use('/api/prompts', require('../dist/routes/prompts').default);
    app.use('/api/resume', require('../dist/routes/resume').default);
  });
  try {
    for (const [method, route, body] of [
      ['GET', '/api/admin/ai/health'],
      ['GET', '/api/generation/queues'],
      ['GET', '/api/prompts/models'],
      ['POST', '/api/prompts/validate', { content: 'x' }],
      ['POST', '/api/prompts/preview', { content: 'x' }],
      ['POST', '/api/resume/analyze-prompt-test', { jobDescription: 'x'.repeat(60) }],
    ]) {
      const refused = await server.call('alice', method, route, body);
      assert.equal(refused.status, 403, `${method} ${route}`);
      assert.equal(refused.body.code, 'not-an-admin', `${method} ${route}`);
    }
    const queues = await server.call('admin', 'GET', '/api/generation/queues');
    assert.equal(queues.status, 200);
  } finally {
    server.close();
  }
});

test('a prompt is a name to pick to anybody but an administrator', async () => {
  const server = await serve('prompt-view', (app) => {
    app.use('/api/prompts', require('../dist/routes/prompts').default);
  });
  writeStaticJson(server.staticDir, 'prompts/analyze-job-description.json', {
    id: 'analyze-job-description',
    content: 'Analyse [[jobDescription]] - SECRET PROMPT BODY',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    allowedVariables: [{ name: 'jobDescription' }],
    modelProvider: 'gemini-cli',
    modelName: 'flash',
  });
  try {
    const listed = await server.call('alice', 'GET', '/api/prompts');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.length > 0);
    for (const prompt of listed.body) {
      assert.deepEqual(
        Object.keys(prompt).filter((key) => !['id', 'name', 'featureKey'].includes(key)),
        [],
        `${prompt.id} carries only what the picker needs`
      );
    }
    assert.doesNotMatch(JSON.stringify(listed.body), /SECRET PROMPT BODY|gemini-cli|flash/);

    const one = await server.call('alice', 'GET', '/api/prompts/analyze-job-description');
    assert.equal(one.status, 200);
    assert.equal(one.body.content, undefined);

    const asAdmin = await server.call('admin', 'GET', '/api/prompts/analyze-job-description');
    assert.match(asAdmin.body.content, /SECRET PROMPT BODY/);
  } finally {
    server.close();
  }
});

test('the sign-in page learns which methods exist, not which settings are missing', async () => {
  const saved = { SMTP_HOST: process.env.SMTP_HOST, SMTP_USER: process.env.SMTP_USER, SMTP_PASS: process.env.SMTP_PASS };
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  const server = await serve('sign-in', (app) => {
    app.use('/api/auth', require('../dist/routes/auth').default);
  });
  try {
    const options = await server.call(null, 'GET', '/api/auth/options');
    assert.deepEqual(options.body.email, { available: false });
    assert.doesNotMatch(JSON.stringify(options.body), /SMTP_/);

    const { result: refused, lines } = await captureErrorLog(() =>
      server.call(null, 'POST', '/api/auth/email/request', { email: 'alice@example.com' })
    );
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error, "Sign-in isn't available right now. Please contact your administrator.");
    assert.equal(refused.body.code, 'sign-in-unavailable');
    assert.match(refused.body.ref, REF);
    assert.doesNotMatch(JSON.stringify(refused.body), /SMTP_|\.env/);
    assert.match(lines.find((line) => line.includes(`[error ${refused.body.ref}]`)), /SMTP_HOST/);

    // The caller's own mistakes stay specific.
    const typo = await server.call(null, 'POST', '/api/auth/email/request', { email: 'not an address' });
    assert.equal(typo.status, 400);
    assert.equal(typo.body.error, 'That does not look like an email address.');
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    server.close();
  }
});

/* --------------------------------------------------- stored errors on read */

test("an order item's stored failure reads generically to its owner; an administrator reads it as stored", async () => {
  const server = await serve('order-errors', (app) => {
    app.use('/api/orders', require('../dist/routes/orders').default);
  });
  const orders = require('../dist/database/orderRepository');
  const raw = 'The Claude CLI is not installed or is not on the server PATH. (spawn /usr/local/bin/claude ENOENT)';
  const safe = 'The AI request failed. Please try again. (Ref: ERR-0A1B2C)';
  const seed = (userId, batchId) => {
    const order = orders.createOrder({ userId, batchId, label: 'Run', retentionDays: 5 }, [
      { seq: 0, profileId: 'p1', profileName: 'Ada', companyName: 'Acme', role: 'SWE' },
      { seq: 1, profileId: 'p1', profileName: 'Ada', companyName: 'Globex', role: 'SWE' },
    ]);
    orders.recordItemOutcome(batchId, 0, { state: 'failed', taskId: 't0', error: raw, files: [] });
    orders.recordItemOutcome(batchId, 1, { state: 'failed', taskId: 't1', error: safe, files: [] });
    return order;
  };
  try {
    const mine = seed(server.alice.id, 'bat_alice');
    const asOwner = await server.call('alice', 'GET', `/api/orders/${mine.id}`);
    assert.equal(asOwner.status, 200);
    assert.equal(asOwner.body.items[0].error, 'This resume could not be built. Please try again, or contact your administrator.');
    assert.equal(asOwner.body.items[1].error, safe, 'written safe, so read as written');
    assert.doesNotMatch(JSON.stringify(asOwner.body), /Claude|ENOENT|\/usr/);

    const theirs = seed(server.admin.id, 'bat_admin');
    const asAdmin = await server.call('admin', 'GET', `/api/orders/${theirs.id}`);
    assert.equal(asAdmin.body.items[0].error, raw);
  } finally {
    server.close();
  }
});

test("a batch's stored failures, lanes and seats read generically to its owner", async () => {
  const server = await serve('batch-errors', (app) => {
    app.use('/api/generation', require('../dist/routes/generation').default);
  });
  const queueModule = require('../dist/services/queue/index');
  queueModule.resetGenerationQueueForTests();
  const raw = 'Profile 7c9e6679-7425-40de-944b-e07fc1f90ae7 no longer exists, so this resume cannot be generated.';
  const label = { profileId: 'p1', profileName: 'Ada', companyName: 'Acme', role: 'SWE' };
  const queue = queueModule.getGenerationQueue();
  queue.restore(
    { id: 'bat_old', label: 'Before the upgrade', jobCount: 2, shared: { ownerId: server.alice.id }, createdAt: Date.now() },
    [
      { id: 'tsk_a', seq: 0, state: 'failed', queue: 'cli', label, kind: 'resume', payload: {}, error: raw },
      { id: 'tsk_b', seq: 1, state: 'done', queue: 'cli', label: { ...label, companyName: 'Globex' }, kind: 'resume', payload: {}, value: {
        profileId: 'p1', profileName: 'Ada', companyName: 'Globex', role: 'SWE', tailored: true,
        unconfirmedHardSkills: [], unconfirmedSoftSkills: [],
      } },
    ]
  );
  try {
    const asOwner = await server.call('alice', 'GET', '/api/generation/batches/bat_old');
    assert.equal(asOwner.status, 200);
    const generic = 'This resume could not be built. Please try again, or contact your administrator.';
    assert.equal(asOwner.body.tasks[0].error, generic);
    assert.equal(asOwner.body.failures[0].error, generic);
    assert.doesNotMatch(JSON.stringify(asOwner.body), /no longer exists|7c9e6679/);

    const list = await server.call('alice', 'GET', '/api/generation/batches');
    assert.equal(list.body.queues, undefined, 'the lanes are the administrator\'s');
    assert.equal(list.body.batches[0].tasks[0].error, generic);

    const asAdmin = await server.call('admin', 'GET', '/api/generation/batches/bat_old');
    assert.equal(asAdmin.body.tasks[0].error, raw);
    assert.equal(asAdmin.body.failures[0].error, raw);
    assert.ok((await server.call('admin', 'GET', '/api/generation/batches')).body.queues);
  } finally {
    queueModule.resetGenerationQueueForTests();
    server.close();
  }
});

test("the Bid Assistant's own refusals stay specific; a duplicate label is a sentence, not a SQLite constraint", async () => {
  const server = await serve('bid-assistant', (app) => {
    const routes = require('../dist/routes/bidAssistant');
    app.use('/api/bid-assistant', routes.default ?? routes);
  });
  try {
    const missing = await server.call('alice', 'POST', '/api/bid-assistant/google-sheets', { sheetId: 'abc' });
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.body, { error: 'Label is required.' });

    const first = await server.call('alice', 'POST', '/api/bid-assistant/google-sheets', { label: 'Mine', sheetId: 'sheet-a' });
    assert.equal(first.status, 200);
    const again = await server.call('alice', 'POST', '/api/bid-assistant/google-sheets', { label: 'Mine', sheetId: 'sheet-b' });
    assert.equal(again.status, 409);
    assert.deepEqual(again.body, { error: 'A Google Sheet source with this label already exists.' });

    const range = await server.call('alice', 'POST', '/api/bid-assistant/google-sheets/1/import', { tabName: 'Jobs', fromRow: 0 });
    assert.equal(range.status, 400);
    assert.equal(range.body.error, 'From row must be a whole number greater than or equal to 1.');

    const nobody = await server.call('alice', 'GET', '/api/bid-assistant/profiles/no-such-profile');
    assert.equal(nobody.status, 404);
    assert.deepEqual(nobody.body, { error: 'Profile not found.' });
  } finally {
    server.close();
  }
});
