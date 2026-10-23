const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const Database = require('better-sqlite3');

const { loadFresh, useAdminEmails, useTempStorage } = require('./helpers');
const { resetEnvWarningsForTests } = require('../dist/config/envValue');
const {
  DEFAULT_OUTPUT_PATH_PREFIX,
  DEFAULT_OUTPUT_PATH_SUFFIX,
  MAX_OUTPUT_PATH_SEGMENTS,
  OUTPUT_PREFIX_TOKENS,
  OUTPUT_SUFFIX_TOKENS,
  outputSuffixNotes,
  renderOutputPath,
  renderOutputPrefix,
  renderOutputSuffix,
  validateOutputPrefix,
  validateOutputSuffix,
} = require('../dist/utils/outputStorage');

/**
 * Where a resume is filed (owner decisions O1-O4): `<output folder>/<the
 * administrator's prefix>/<the account's own folder path>/<file>`. The two
 * validators and the one renderer (utils/outputStorage.ts), the `.env`
 * defaults, the admin's save and preview, the account's routes, and migration
 * 10, which gives every run placed before its folder. Who may download a file
 * by that folder is test/orderFileAccess.test.js's.
 */

const problemsOf = (check) => (check.ok ? [] : check.problems);
const one = (check) => {
  assert.equal(check.ok, false, JSON.stringify(check));
  return check.problems.join(' ');
};

/* ---------------------------------------------------------- validators */

test('every token passes where it belongs, and the value comes back in one spelling', () => {
  assert.deepEqual([...OUTPUT_PREFIX_TOKENS], ['user_email', 'order_number', 'date']);
  assert.deepEqual([...OUTPUT_SUFFIX_TOKENS], ['date', 'profile_name', 'company_name', 'role', 'row_number']);

  assert.deepEqual(validateOutputPrefix(DEFAULT_OUTPUT_PATH_PREFIX), { ok: true, value: DEFAULT_OUTPUT_PATH_PREFIX });
  assert.deepEqual(validateOutputSuffix(DEFAULT_OUTPUT_PATH_SUFFIX), { ok: true, value: DEFAULT_OUTPUT_PATH_SUFFIX });
  assert.deepEqual(validateOutputPrefix('/{{date}}/u-{{user_email}}/{{order_number}}'), {
    ok: true,
    value: '/{{date}}/u-{{user_email}}/{{order_number}}',
  });
  assert.deepEqual(validateOutputSuffix('/{{date}}{{profile_name}}/{{row_number}}_{{company_name}}/{{role}}'), {
    ok: true,
    value: '/{{date}}{{profile_name}}/{{row_number}}_{{company_name}}/{{role}}',
  });
  // Leading and trailing slashes are optional, a backslash is a slash, and a
  // token may be padded inside its braces.
  assert.deepEqual(validateOutputPrefix('runs\\{{ order_number }}/'), { ok: true, value: '/runs/{{order_number}}' });
  assert.deepEqual(validateOutputSuffix('{{company_name}}'), { ok: true, value: '/{{company_name}}' });
});

test('an unknown token, the old spellings among them, is named', () => {
  assert.match(one(validateOutputSuffix('/{{account name}}/{{company_name}}')), /The folder path uses \{\{account name\}\}, which is not a token\./);
  assert.match(one(validateOutputSuffix('/{{company name}}')), /\{\{company name\}\}, which is not a token\. It may use \{\{date\}\}, \{\{profile_name\}\}, \{\{company_name\}\}, \{\{role\}\} and \{\{row_number\}\}\./);
  assert.match(one(validateOutputPrefix('/{{order number}}/{{order_number}}')), /The output prefix uses \{\{order number\}\}, which is not a token\. It may use \{\{user_email\}\}, \{\{order_number\}\} and \{\{date\}\}\./);
  assert.match(one(validateOutputSuffix('/{{DATE}}')), /\{\{DATE\}\}, which is not a token/);
  assert.match(one(validateOutputSuffix('/{{}}')), /\{\{\}\}, which is not a token/);
});

test("a token in the other half's place is refused as misplaced, saying whose it is", () => {
  assert.match(
    one(validateOutputPrefix('/{{order_number}}/{{role}}')),
    /The output prefix cannot use \{\{role\}\}: it belongs in each account's own folder path/
  );
  assert.match(
    one(validateOutputSuffix('/{{order_number}}/{{company_name}}')),
    /The folder path cannot use \{\{order_number\}\}: the administrator's output prefix places it/
  );
  assert.match(one(validateOutputSuffix('/{{user_email}}')), /cannot use \{\{user_email\}\}/);
  // {{date}} is both halves'.
  assert.equal(validateOutputPrefix('/{{date}}/{{order_number}}').ok, true);
  assert.equal(validateOutputSuffix('/{{date}}').ok, true);
});

test('the prefix holds {{order_number}} exactly once, as a folder of its own', () => {
  assert.match(one(validateOutputPrefix('/{{user_email}}/{{date}}')), /must contain \{\{order_number\}\} as a folder of its own, like \/\{\{user_email\}\}\/\{\{order_number\}\}/);
  assert.match(one(validateOutputPrefix('/{{order_number}}/{{order_number}}')), /uses \{\{order_number\}\} 2 times; it must use it exactly once/);
  assert.match(one(validateOutputPrefix('/run-{{order_number}}')), /In the output prefix, \{\{order_number\}\} must be a folder of its own, not part of "run-\{\{order_number\}\}"/);
  assert.match(one(validateOutputPrefix('/{{date}}{{order_number}}')), /not part of "\{\{date\}\}\{\{order_number\}\}"/);
  assert.match(one(validateOutputPrefix('')), /The output prefix is empty/);
});

test('no "." or ".." folder, no empty one, at most 8, no drive letter, no ~', () => {
  for (const validate of [validateOutputPrefix, validateOutputSuffix]) {
    const label = validate === validateOutputPrefix ? 'The output prefix' : 'The folder path';
    const base = validate === validateOutputPrefix ? '{{order_number}}' : '{{company_name}}';
    assert.match(one(validate(`/../${base}`)), new RegExp(`${label} cannot have a "\\.\\." folder\\.`));
    assert.match(one(validate(`/./${base}`)), new RegExp(`${label} cannot have a "\\." folder\\.`));
    assert.match(one(validate(`/a//${base}`)), new RegExp(`${label} has an empty folder \\(two slashes together\\)\\.`));
    const nine = Array.from({ length: MAX_OUTPUT_PATH_SEGMENTS + 1 }, (_, index) => (index === 0 ? base : `f${index}`)).join('/');
    assert.match(one(validate(nine)), new RegExp(`${label} has 9 folders; it may have at most 8\\.`));
    const eight = nine.split('/').slice(0, 8).join('/');
    assert.equal(validate(eight).ok, true, 'eight is allowed');
    assert.match(one(validate(`C:/x/${base}`)), new RegExp(`${label} cannot start with a drive letter \\("C:"\\)`));
    assert.match(one(validate(`/D:/${base}`)), /cannot start with a drive letter \("D:"\)/);
    assert.match(one(validate(`~/${base}`)), new RegExp(`${label} cannot start with "~"`));
    assert.match(one(validate(`/a{b/${base}`)), /has a stray "\{" or "\}" in "a\{b"/);
  }
  // Every problem is reported, not only the first.
  assert.equal(problemsOf(validateOutputSuffix('/../{{order_number}}/{{bogus}}')).length, 3);
  assert.match(one(validateOutputSuffix(42)), /The folder path must be text\./);
});

/* -------------------------------------------------------------- render */

test('a folder renders its values, then is sanitized whole; an empty one is `unknown`', () => {
  const values = {
    user_email: 'Jane.Doe@Example.com',
    order_number: 'FT-20261015-0001',
    date: '2026-10-15',
    profile_name: 'Jane Doe',
    company_name: 'Acme Inc.',
    role: 'Senior Engineer',
    row_number: '2',
  };
  // The owner's own example: two tokens in one folder are one folder.
  assert.equal(
    renderOutputPath('/{{user_email}}/{{order_number}}', '/{{date}}{{profile_name}}/{{company_name}}/{{role}}', values),
    'jane_doe_example_com/ft_20261015_0001/2026_10_15jane_doe/acme_inc/senior_engineer'
  );
  assert.equal(renderOutputPrefix('/out-{{date}}/{{order_number}}', values), 'out_2026_10_15/ft_20261015_0001');
  assert.equal(renderOutputSuffix('/{{row_number}}_{{company_name}}', values), '2_acme_inc');

  // No value adds a folder, climbs out of one or is read as a token again.
  assert.equal(
    renderOutputSuffix('/{{company_name}}/{{role}}', { company_name: '../../etc', role: 'a/b\\c {{date}}' }),
    'etc/a_b_c_date'
  );
  // An empty or missing value: the text around it stays; a folder left with
  // nothing is `unknown`.
  assert.equal(renderOutputSuffix('/{{role}}/{{row_number}}_{{company_name}}', { company_name: 'Acme' }), 'unknown/acme');
  assert.equal(renderOutputSuffix('/{{role}}', { role: '' }), 'unknown');
  // A Windows device name is escaped like any folder.
  assert.equal(renderOutputSuffix('/{{company_name}}', { company_name: 'CON' }), '_con');
  // An invalid template is never rendered.
  assert.throws(() => renderOutputPrefix('/{{role}}', values), (error) => error.field === 'outputPathPrefix' && error.status === 400);
});

test('a folder path without {{company_name}} is allowed, with a note on what it shares', () => {
  assert.deepEqual(outputSuffixNotes(DEFAULT_OUTPUT_PATH_SUFFIX), []);
  assert.equal(outputSuffixNotes('/{{date}}/{{profile_name}}').length, 1);
  assert.match(outputSuffixNotes('/{{date}}')[0], /Without \{\{company_name\}\}/);
});

/* ---------------------------------------------------------------- .env */

async function withEnv(values, fn) {
  const names = ['OUTPUT_PATH_PREFIX', 'OUTPUT_PATH_SUFFIX', 'OUTPUT_BASE_DIR'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, values);
  resetEnvWarningsForTests();
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    return await fn(warnings);
  } finally {
    console.warn = original;
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

test('a prefix or folder path .env sets that does not pass warns once, by name, and the default is used', async () => {
  const { envOutputPathPrefix, envOutputPathSuffix } = require('../dist/config/settingDefaults');
  await withEnv({ OUTPUT_PATH_PREFIX: '/{{user_email}}', OUTPUT_PATH_SUFFIX: '/../{{role}}' }, async (warnings) => {
    assert.deepEqual(envOutputPathPrefix(), { value: DEFAULT_OUTPUT_PATH_PREFIX, fromEnv: false });
    assert.deepEqual(envOutputPathSuffix(), { value: DEFAULT_OUTPUT_PATH_SUFFIX, fromEnv: false });
    envOutputPathPrefix();
    assert.equal(warnings.filter((line) => line.startsWith('[env] OUTPUT_PATH_PREFIX="/{{user_email}}" is refused: The output prefix must contain {{order_number}}')).length, 1, warnings.join('\n'));
    assert.equal(warnings.filter((line) => line.includes('OUTPUT_PATH_SUFFIX="/../{{role}}" is refused: The folder path cannot have a ".." folder.')).length, 1, warnings.join('\n'));
  });
  await withEnv({ OUTPUT_PATH_PREFIX: 'runs/{{order_number}}', OUTPUT_PATH_SUFFIX: '{{company_name}}/' }, async (warnings) => {
    assert.deepEqual(envOutputPathPrefix(), { value: '/runs/{{order_number}}', fromEnv: true });
    assert.deepEqual(envOutputPathSuffix(), { value: '/{{company_name}}', fromEnv: true });
    assert.deepEqual(warnings, []);
  });
});

/* -------------------------------------------------------------- routes */

async function serve(name) {
  const dirs = useTempStorage(`output-path-${name}`);
  useAdminEmails('boss@example.com');
  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  const config = loadFresh('../dist/config/aiModelConfig');
  loadFresh('../dist/services/outputPath');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const { saveResume } = loadFresh('../dist/database/resumeRepository');
  const { buildNewResume } = loadFresh('../dist/services/resumeDocument');

  const boss = users.createUser({ email: 'boss@example.com' });
  const jane = users.createUser({ email: 'Jane.Doe@Example.com' });
  const reporter = users.createUser({ email: 'reporter@example.com', role: 'reporter' });
  saveResume({
    ...buildNewResume(
      {
        name: 'Jane Main',
        title: 'Engineer',
        skills: [],
        contact: { email: 'j@example.com', phone: '1', location: 'X' },
        summary: 's',
        experience: [],
        strengths: [],
        education: [],
      },
      'p-jane'
    ),
    ownerId: jane.id,
  });

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/auth', loadFresh('../dist/routes/auth').default);
  app.use('/api/admin', loadFresh('../dist/routes/admin').default);
  app.use('/api/resume', loadFresh('../dist/routes/resume').default);
  const server = app.listen(0);
  const port = server.address().port;
  const tokens = {
    boss: users.createSession(boss.id),
    jane: users.createSession(jane.id),
    reporter: users.createSession(reporter.id),
  };
  return {
    ...dirs,
    users,
    config,
    jane,
    close: () => server.close(),
    call: async (who, method, url, body) => {
      const response = await fetch(`http://127.0.0.1:${port}/api${url}`, {
        method,
        headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not JSON - Express's own 404 page.
      }
      return { status: response.status, body: parsed };
    },
  };
}

const today = () => {
  const now = new Date();
  return `${now.getFullYear()}_${`${now.getMonth() + 1}`.padStart(2, '0')}_${`${now.getDate()}`.padStart(2, '0')}`;
};

test("an account's folder path: saved checked, read with its source, reset with '' or null", async () => {
  await withEnv({}, async () => {
    const server = await serve('account');
    try {
      let account = (await server.call('jane', 'GET', '/auth/account')).body.account;
      assert.equal(account.outputPathSuffix, null);
      assert.equal(account.outputPathSuffixSource, 'default');
      assert.equal(account.effectiveOutputPathSuffix, DEFAULT_OUTPUT_PATH_SUFFIX);
      assert.equal(account.defaultOutputPathSuffix, DEFAULT_OUTPUT_PATH_SUFFIX);

      const saved = await server.call('jane', 'PUT', '/auth/account', { outputPathSuffix: ' {{date}}{{profile_name}}/{{ company_name }}/ ' });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.account.outputPathSuffix, '/{{date}}{{profile_name}}/{{company_name}}', 'stored as it reads canonically');
      assert.equal(saved.body.account.outputPathSuffixSource, 'account');
      assert.equal(saved.body.account.effectiveOutputPathSuffix, '/{{date}}{{profile_name}}/{{company_name}}');
      assert.equal(server.users.getOutputPathSuffix(server.jane.id), '/{{date}}{{profile_name}}/{{company_name}}');

      const refused = await server.call('jane', 'PUT', '/auth/account', { outputPathSuffix: '/{{order_number}}/..' });
      assert.equal(refused.status, 400);
      assert.equal(refused.body.code, 'output-path-invalid');
      assert.equal(refused.body.field, 'outputPathSuffix');
      assert.match(refused.body.error, /cannot use \{\{order_number\}\}.*cannot have a "\.\." folder\./);
      assert.equal(server.users.getOutputPathSuffix(server.jane.id), '/{{date}}{{profile_name}}/{{company_name}}', 'nothing changed');

      assert.equal((await server.call('jane', 'PUT', '/auth/account', {})).status, 400, 'nothing to change');

      for (const reset of ['', null]) {
        await server.call('jane', 'PUT', '/auth/account', { outputPathSuffix: '/{{company_name}}' });
        account = (await server.call('jane', 'PUT', '/auth/account', { outputPathSuffix: reset })).body.account;
        assert.equal(account.outputPathSuffix, null, JSON.stringify(reset));
        assert.equal(account.outputPathSuffixSource, 'default');
        assert.equal(server.users.getOutputPathSuffix(server.jane.id), null);
      }

      // The name is still PATCH's, and its answer carries the same fields.
      const renamed = await server.call('jane', 'PATCH', '/auth/account', { name: 'Jane' });
      assert.equal(renamed.body.account.outputPathSuffixSource, 'default');
    } finally {
      server.close();
    }
  });

  // OUTPUT_PATH_SUFFIX is the default an account without its own follows.
  await withEnv({ OUTPUT_PATH_SUFFIX: '/{{company_name}}/{{role}}' }, async () => {
    const server = await serve('account-env');
    try {
      const account = (await server.call('jane', 'GET', '/auth/account')).body.account;
      assert.equal(account.outputPathSuffixSource, 'env');
      assert.equal(account.effectiveOutputPathSuffix, '/{{company_name}}/{{role}}');
      assert.equal(account.defaultOutputPathSuffix, '/{{company_name}}/{{role}}');
    } finally {
      server.close();
    }
  });
});

test("the preview draws the asker's own folder with the run's function, and says why it cannot", async () => {
  await withEnv({}, async () => {
    const server = await serve('preview');
    try {
      const own = await server.call('jane', 'POST', '/auth/output-path/preview', {});
      assert.equal(own.status, 200);
      const number = `ft_${today().split('_').join('')}_0001`;
      assert.deepEqual(own.body, {
        path: `/jane_doe_example_com/${number}/${today()}/jane_main/acme/software_engineer`,
        problems: [],
        notes: [],
      });

      const typed = await server.call('jane', 'POST', '/auth/output-path/preview', { outputPathSuffix: '/{{date}}{{profile_name}}/{{row_number}}' });
      assert.equal(typed.body.path, `/jane_doe_example_com/${number}/${today()}jane_main/2`);
      assert.equal(typed.body.notes.length, 1, 'no company: a note, not a refusal');

      const bad = await server.call('jane', 'POST', '/auth/output-path/preview', { outputPathSuffix: '/{{bogus}}' });
      assert.equal(bad.status, 200, 'asking is not saving');
      assert.equal(bad.body.path, null);
      assert.match(bad.body.problems[0], /\{\{bogus\}\}, which is not a token/);

      // '' is what Reset would give; the administrator's prefix leads it.
      await server.config.updateAppSettings({ outputPathPrefix: '/{{date}}/{{order_number}}' });
      const reset = await server.call('jane', 'POST', '/auth/output-path/preview', { outputPathSuffix: '' });
      assert.equal(reset.body.path, `/${today()}/${number}/${today()}/jane_main/acme/software_engineer`);

      // A builder without a resume sees the sample name.
      const boss = await server.call('boss', 'POST', '/auth/output-path/preview', {});
      assert.match(boss.body.path, /\/sample_profile\/acme\/software_engineer$/);
    } finally {
      server.close();
    }
  });
});

test('a reporter builds nothing: refused the folder path routes by role, and told nothing about it', async () => {
  const server = await serve('reporter');
  try {
    for (const [method, url, body] of [
      ['PUT', '/auth/account', { outputPathSuffix: '/{{company_name}}' }],
      ['POST', '/auth/output-path/preview', {}],
    ]) {
      const answer = await server.call('reporter', method, url, body);
      assert.equal(answer.status, 403, `${method} ${url}`);
      assert.equal(answer.body.code, 'role-not-allowed');
      assert.equal((await server.call(null, method, url, body)).status, 401);
    }
    const account = (await server.call('reporter', 'GET', '/auth/account')).body.account;
    for (const key of ['outputPathSuffix', 'outputPathSuffixSource', 'effectiveOutputPathSuffix', 'defaultOutputPathSuffix']) {
      assert.equal(key in account, false, key);
    }
  } finally {
    server.close();
  }
});

test("the builder asks for a role when THE ASKER's folder path files by it", async () => {
  await withEnv({}, async () => {
    const server = await serve('role-input');
    try {
      assert.equal((await server.call('jane', 'GET', '/resume/models')).body.outputPathUsesJobTitle, true, 'the default has {{role}}');
      await server.call('jane', 'PUT', '/auth/account', { outputPathSuffix: '/{{date}}/{{company_name}}' });
      assert.equal((await server.call('jane', 'GET', '/resume/models')).body.outputPathUsesJobTitle, false);
      assert.equal((await server.call('boss', 'GET', '/resume/models')).body.outputPathUsesJobTitle, true, "another account's is its own");
    } finally {
      server.close();
    }
  });
});

test("the administrator's prefix: refused by name with its field, previewed whole, reset with null", async () => {
  await withEnv({}, async () => {
    const server = await serve('admin-prefix');
    try {
      const refused = await server.call('boss', 'PUT', '/admin/settings', { outputPathPrefix: '/{{user_email}}/{{role}}' });
      assert.equal(refused.status, 400);
      assert.equal(refused.body.field, 'outputPathPrefix');
      assert.equal(refused.body.code, 'output-path-invalid');
      assert.match(refused.body.error, /cannot use \{\{role\}\}/);
      assert.match(refused.body.error, /must contain \{\{order_number\}\}/);

      const saved = await server.call('boss', 'PUT', '/admin/settings', { outputPathPrefix: 'runs/{{order_number}}' });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.outputPathPrefix, '/runs/{{order_number}}');
      assert.equal(saved.body.settingSources.outputPathPrefix, 'admin');
      assert.equal(saved.body.settingDefaults.outputPathPrefix, DEFAULT_OUTPUT_PATH_PREFIX);
      assert.equal('outputPathTemplate' in saved.body, false);
      const number = `ft_${today().split('_').join('')}_0001`;
      assert.equal('outputPathPreview' in saved.body, false, 'the preview is the route\'s to draw');
      const inEffect = await server.call('boss', 'POST', '/admin/output-path/preview', {});
      assert.equal(
        inEffect.body.path,
        path.join(saved.body.outputBaseDir, 'runs', number, today(), 'sample_profile', 'acme', 'software_engineer')
      );
      // An output folder typed but not saved yet: the preview follows the box.
      const draftFolder = path.join(saved.body.outputBaseDir, 'elsewhere');
      const drafted = await server.call('boss', 'POST', '/admin/output-path/preview', { outputBaseDir: draftFolder });
      assert.equal(drafted.body.path, path.join(draftFolder, 'runs', number, today(), 'sample_profile', 'acme', 'software_engineer'));

      const preview = await server.call('boss', 'POST', '/admin/output-path/preview', { outputPathPrefix: '/{{date}}/{{order_number}}' });
      assert.deepEqual(preview.body, {
        path: path.join(saved.body.outputBaseDir, today(), number, today(), 'sample_profile', 'acme', 'software_engineer'),
        problems: [],
        notes: [],
      });
      const bad = await server.call('boss', 'POST', '/admin/output-path/preview', { outputPathPrefix: '/x' });
      assert.equal(bad.body.path, null);
      assert.match(bad.body.problems[0], /must contain \{\{order_number\}\}/);
      const resetPreview = await server.call('boss', 'POST', '/admin/output-path/preview', { outputPathPrefix: null });
      assert.equal(resetPreview.body.path, path.join(saved.body.outputBaseDir, 'boss_example_com', number, today(), 'sample_profile', 'acme', 'software_engineer'));
      assert.equal((await server.call('jane', 'POST', '/admin/output-path/preview', {})).status, 403);

      const reset = await server.call('boss', 'PUT', '/admin/settings', { outputPathPrefix: null });
      assert.equal(reset.body.outputPathPrefix, DEFAULT_OUTPUT_PATH_PREFIX);
      assert.equal(reset.body.settingSources.outputPathPrefix, 'default');
    } finally {
      server.close();
    }
  });
});

/* ----------------------------------------------------- migration 10 */

test('migration 10 gives every older run the folder its recorded files name, once', () => {
  const dirs = useTempStorage('output-path-step-10');
  const { getDb } = loadFresh('../dist/database/sqlite');
  const db = getDb();
  const { ordersOutputRootStep } = require('../dist/database/migrations/ordersOutputRoot');
  const { runDataMigrations, SCHEMA_VERSION_KEY, LATEST_SCHEMA_VERSION } = require('../dist/database/migrations');
  assert.equal(ordersOutputRootStep.version, 10);
  assert.equal(LATEST_SCHEMA_VERSION, 10);

  const base = path.join(dirs.rootDir, 'out');
  db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('app-settings', ?, 'x') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    JSON.stringify({ outputBaseDir: base })
  );
  const order = (id, number, files) => {
    db.prepare(
      `INSERT INTO orders (id, number, user_id, label, total, state, created_at, updated_at, expires_at, kind)
       VALUES (?, ?, 'u1', '', 1, 'done', 'x', 'x', 'x', 'order')`
    ).run(id, number);
    db.prepare(
      `INSERT INTO order_items (id, order_id, seq, resume_id, resume_name, company_name, role, state, files, created_at, updated_at)
       VALUES (?, ?, 0, 'p', 'P', 'C', 'R', 'done', ?, 'x', 'x')`
    ).run(`${id}-item`, id, JSON.stringify(files));
  };
  // The old fixed tree: <account>/<date>/<order number>/<resume>/<company>/<file>.
  order('o-old', 'FT-20260920-0001', [{ kind: 'resume-pdf', path: 'bob_example_com/2026_09_20/ft_20260920_0001/bob/acme/Bob.pdf' }]);
  order('o-run', 'FT-RUN-20260920-0002', [{ kind: 'resume-pdf', path: 'bob_example_com/2026_09_20/ft_run_20260920_0002/bob/acme/Bob.pdf' }]);
  order('o-none', 'FT-20260920-0003', []);
  // A path that names no folder of its number - left alone, never guessed.
  order('o-odd', 'FT-20260920-0004', [{ kind: 'resume-pdf', path: 'somewhere/else/Bob.pdf' }]);
  db.prepare("UPDATE schema_meta SET value = '9' WHERE key = ?").run(SCHEMA_VERSION_KEY);

  const lines = [];
  const saved = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    runDataMigrations(db);
  } finally {
    console.log = saved;
  }
  const rootOf = (id) => db.prepare('SELECT output_root AS root FROM orders WHERE id = ?').get(id).root;
  assert.equal(rootOf('o-old'), path.join(base, 'bob_example_com', '2026_09_20', 'ft_20260920_0001'));
  assert.equal(rootOf('o-run'), path.join(base, 'bob_example_com', '2026_09_20', 'ft_run_20260920_0002'));
  assert.equal(rootOf('o-none'), null);
  assert.equal(rootOf('o-odd'), null);
  assert.ok(lines.some((line) => line.startsWith('[db] Migration 10 (orders-output-root) applied: 2 run(s) given the folder')), lines.join('\n'));
  assert.equal(db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(SCHEMA_VERSION_KEY).value, '10');

  // Idempotent: nothing more to give, and nothing given is changed.
  const again = ordersOutputRootStep.apply(db);
  assert.equal(again.ran, false);
  assert.equal(rootOf('o-old'), path.join(base, 'bob_example_com', '2026_09_20', 'ft_20260920_0001'));
});

test('migration 10 finds nothing on a fresh database, and waits for a column it lacks', () => {
  const { ordersOutputRootStep } = require('../dist/database/migrations/ordersOutputRoot');
  const empty = new Database(':memory:');
  assert.equal(ordersOutputRootStep.apply(empty).ran, false, 'no orders table');

  const old = new Database(':memory:');
  old.exec('CREATE TABLE orders (id TEXT PRIMARY KEY, number TEXT); CREATE TABLE order_items (id TEXT, order_id TEXT, seq INTEGER, files TEXT)');
  const outcome = ordersOutputRootStep.apply(old);
  assert.equal(outcome.deferred, true, 'the column is added at the next start, and the step runs then');
});

test('the two new columns reach a database that has the tables without them', () => {
  const dirs = useTempStorage('output-path-added-columns');
  const { getDb } = loadFresh('../dist/database/sqlite');
  const db = getDb();
  db.exec('ALTER TABLE users DROP COLUMN output_path_suffix');
  db.exec('DROP INDEX IF EXISTS idx_orders_output_root');
  db.exec('ALTER TABLE orders DROP COLUMN output_root');
  db.close();
  const reopened = loadFresh('../dist/database/sqlite').getDb();
  const columns = (table) => reopened.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
  assert.ok(columns('users').includes('output_path_suffix'));
  assert.ok(columns('orders').includes('output_root'));
  assert.ok(reopened.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_orders_output_root'").get());
  assert.ok(dirs.dbDir);
});

test('a task that carries no place is filed in its run folder, worked out from its order', async () => {
  await withEnv({}, async () => {
    const dirs = useTempStorage('output-path-place-of-run');
    loadFresh('../dist/database/sqlite');
    const users = loadFresh('../dist/database/userRepository');
    const orders = loadFresh('../dist/database/orderRepository');
    const config = loadFresh('../dist/config/aiModelConfig');
    const { placeOfPlacedRun } = loadFresh('../dist/services/outputPath');
    const base = path.join(dirs.rootDir, 'out');
    await config.updateAppSettings({ outputBaseDir: base });
    const bob = users.createUser({ email: 'bob@example.com' });
    users.setOutputPathSuffix(bob.id, '/{{company_name}}');
    const item = [{ seq: 0, resumeId: 'p', resumeName: 'Bob', companyName: 'Acme', role: 'SWE' }];
    const at = new Date('2026-09-20T12:00:00');

    // A run whose folder is recorded - by migration 10, from the old tree -
    // keeps writing there.
    const old = orders.createOrder(
      { userId: bob.id, batchId: 'bat_old', retentionDays: 5, outputRootFor: () => path.join(base, 'bob_example_com', '2026_09_20', 'ft_x') },
      item,
      at
    );
    assert.deepEqual(await placeOfPlacedRun('bat_old'), {
      baseDir: base,
      prefix: 'bob_example_com/2026_09_20/ft_x',
      suffix: '/{{company_name}}',
      date: '2026-09-20',
      accountName: 'bob@example.com',
      orderNumber: old.number,
    });

    // One with none: the prefix in effect, rendered for its own number and day.
    const bare = orders.createOrder({ userId: bob.id, batchId: 'bat_bare', retentionDays: 5 }, item, at);
    const place = await placeOfPlacedRun('bat_bare');
    assert.equal(place.prefix, `bob_example_com/${bare.number.toLowerCase().split('-').join('_')}`);
    assert.equal(await placeOfPlacedRun('bat_nobody'), null);
  });
});
