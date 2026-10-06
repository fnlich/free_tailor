const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');

/**
 * Every saved template is a JSON file in `static/templates`, beside the
 * built-ins - not a row in the database.
 *
 *   - import, PDF extraction and the manual builder each write `<id>.json`
 *     with a `source`; an edit rewrites the file and a delete removes it;
 *   - a file WITHOUT `source` is a built-in: never deleted or overwritten from
 *     here, and its edits still go to `template_overrides`;
 *   - an id is checked before any path is built: `../`, upper case, reserved
 *     device names and a built-in's id are refused;
 *   - a write goes through a temporary file and a rename, and a failed one
 *     answers the generic sentence with a ref and leaves nothing behind;
 *   - an older database's `templates` rows are written out once at boot.
 *
 * PDF parsing and the model behind an extraction are stubbed: what is under
 * test is where the template lands, not how it was read.
 */

// Before anything loads templateExtractor: an extraction parses a real PDF
// and asks a model, neither of which is this file's business.
require.cache[require.resolve('pdf-parse')] = {
  id: require.resolve('pdf-parse'),
  filename: require.resolve('pdf-parse'),
  loaded: true,
  exports: async () => ({ text: 'A resume with plenty of text in it, enough to count as a real document.' }),
};

const { captureErrorLog, loadFresh, useAdminEmails, useTempStorage } = require('./helpers');

/** A frontend module that imports nothing at runtime, as frontendHelpers.test.js loads one. */
function loadFrontendModule(relative) {
  const ts = require('typescript');
  const file = path.join(__dirname, '..', '..', 'frontend', 'src', relative);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, (specifier) => {
    throw new Error(`${relative} imports ${specifier}; it is meant to import nothing at runtime`);
  });
  return module.exports;
}

const SHIPPED = path.join(__dirname, '..', 'static');
const HTML =
  '<div class="resume">{{name}}{{#if summary}}<p>{{summary}}</p>{{/if}}' +
  '{{#each experience}}<h3>{{title}}</h3>{{/each}}{{#each skillCategories}}<b>{{category}}</b>{{/each}}</div>';

function seeded(name) {
  const storage = useTempStorage(`template-files-${name}`);
  fs.cpSync(path.join(SHIPPED, 'templates'), path.join(storage.staticDir, 'templates'), { recursive: true });
  fs.cpSync(path.join(SHIPPED, 'skills'), path.join(storage.staticDir, 'skills'), { recursive: true });
  return { ...storage, templatesDir: path.join(storage.staticDir, 'templates') };
}

function readFile(dir, id) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
}

function leftovers(dir) {
  return fs.readdirSync(dir).filter((name) => !name.endsWith('.json'));
}

async function serve(name) {
  const storage = seeded(name);
  useAdminEmails('admin@example.com');
  const users = loadFresh('../dist/database/userRepository');
  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  const tokens = { admin: users.createSession(admin.id), alice: users.createSession(alice.id) };

  const resumeService = require('../dist/services/resumeService');
  resumeService.extractTemplateFromPDF = async () => ({ html: HTML, css: '.resume{}', sections: ['summary'] });

  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/templates', loadFresh('../dist/routes/templates').default);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/templates`;
  const call = async (who, method, route, body) => {
    const isForm = body instanceof FormData;
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${tokens[who]}`,
        ...(body && !isForm ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: isForm ? body : JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: response.status, body: parsed };
  };
  return { ...storage, call, close: () => server.close() };
}

function jsonUpload(document) {
  const form = new FormData();
  form.append('template', new Blob([JSON.stringify(document)], { type: 'application/json' }), 'templates.json');
  return form;
}

function pdfUploadForm() {
  const form = new FormData();
  form.append('pdf', new Blob(['%PDF-1.4 stub'], { type: 'application/pdf' }), 'Resume.pdf');
  form.append('name', 'From a PDF');
  return form;
}

const MANUAL = { name: 'Built Here', columns: 1, accentColor: '#123456', bodyColor: '#000', bodyFontSizePt: 9, titleFontSizePt: 20 };

/* ------------------------------------------------------- the three sources */

test('import, extraction and the manual builder each write <id>.json with its source', async () => {
  const server = await serve('sources');
  try {
    const imported = await server.call(
      'admin',
      'POST',
      '/upload-json',
      jsonUpload([
        { id: 'Team_Layout', name: 'Team Layout', htmlContent: HTML.padEnd(150, ' ') },
        { name: 'No Id', htmlContent: HTML.padEnd(150, ' ') },
      ])
    );
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    const [kept, minted] = imported.body.templates;
    // Folded into the file alphabet: Windows and macOS would see `Team_Layout`
    // and `team_layout` as one file.
    assert.equal(kept.id, 'team-layout');
    assert.match(minted.id, /^u-[0-9a-f]{8}$/);
    for (const template of imported.body.templates) {
      const file = readFile(server.templatesDir, template.id);
      assert.equal(file.source, 'uploaded');
      assert.equal(file.id, template.id);
      assert.equal(template.source, 'uploaded');
      assert.equal(template.isBuiltIn, undefined);
    }

    const extracted = await server.call('admin', 'POST', '/upload', pdfUploadForm());
    assert.equal(extracted.status, 201, JSON.stringify(extracted.body));
    assert.match(extracted.body.id, /^[0-9a-f-]{36}$/);
    assert.equal(readFile(server.templatesDir, extracted.body.id).source, 'extracted');

    const manual = await server.call('admin', 'POST', '/create-manual', MANUAL);
    assert.equal(manual.status, 201);
    assert.match(manual.body.id, /^m-[0-9a-f]{8}$/);
    const manualFile = readFile(server.templatesDir, manual.body.id);
    assert.equal(manualFile.source, 'manual');
    assert.equal(manualFile.manualConfig.accentColor, '#123456');

    // Derived from the markup on every read, so never written.
    for (const id of [kept.id, extracted.body.id, manual.body.id]) {
      const file = readFile(server.templatesDir, id);
      assert.equal('supportsStrengths' in file, false);
      assert.equal('supportsSoftSkills' in file, false);
      assert.equal('isBuiltIn' in file, false);
    }

    // Listed for everybody, beside the built-ins, and nothing in the table.
    const listed = await server.call('alice', 'GET', '/');
    const ids = listed.body.map((template) => template.id);
    for (const id of [kept.id, minted.id, extracted.body.id, manual.body.id, 'default']) assert.ok(ids.includes(id), id);
    assert.equal(listed.body.find((template) => template.id === 'default').isBuiltIn, true);
    const db = new Database(path.join(server.dbDir, 'free_tailor.db'), { readonly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM templates').get().n, 0, 'no row written');
    } finally {
      db.close();
    }
    assert.deepEqual(leftovers(server.templatesDir), [], 'no temporary file left');
  } finally {
    server.close();
  }
});

test('an edit rewrites the file, a delete removes it, and a built-in stays as shipped', async () => {
  const server = await serve('edit-delete');
  try {
    const manual = (await server.call('admin', 'POST', '/create-manual', MANUAL)).body;
    const renamed = await server.call('admin', 'PATCH', `/${manual.id}`, { name: 'Renamed', disabled: true });
    assert.equal(renamed.status, 200);
    let file = readFile(server.templatesDir, manual.id);
    assert.equal(file.name, 'Renamed');
    assert.equal(file.disabled, true);
    assert.equal(file.source, 'manual', 'an edit keeps where it came from');

    const rebuilt = await server.call('admin', 'PUT', `/${manual.id}/update-manual`, { ...MANUAL, accentColor: '#abcdef' });
    assert.equal(rebuilt.status, 200);
    file = readFile(server.templatesDir, manual.id);
    assert.equal(file.manualConfig.accentColor, '#abcdef');
    assert.match(file.htmlContent, /#abcdef/);

    const deleted = await server.call('admin', 'DELETE', `/${manual.id}`);
    assert.equal(deleted.status, 200);
    assert.equal(fs.existsSync(path.join(server.templatesDir, `${manual.id}.json`)), false);
    assert.equal((await server.call('admin', 'GET', `/${manual.id}`)).status, 404);

    // A built-in: never deleted, and an edit goes to its override row while
    // the shipped file stays byte for byte as it was.
    const before = fs.readFileSync(path.join(server.templatesDir, 'navy-gold.json'), 'utf8');
    const refused = await server.call('admin', 'DELETE', '/navy-gold');
    assert.equal(refused.status, 400);
    const patched = await server.call('admin', 'PATCH', '/navy-gold', { name: 'Navy, renamed' });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.name, 'Navy, renamed');
    assert.equal(patched.body.isBuiltIn, true);
    assert.equal(fs.readFileSync(path.join(server.templatesDir, 'navy-gold.json'), 'utf8'), before);
    const { getTemplateOverride } = require('../dist/database/templateRepository');
    assert.equal(getTemplateOverride('navy-gold').name, 'Navy, renamed');

    // Only administrators change templates at all.
    assert.equal((await server.call('alice', 'POST', '/create-manual', MANUAL)).status, 403);
  } finally {
    server.close();
  }
});

/* --------------------------------------------------------------- the ids */

test('an id that is no file name, or a built-in\'s, is refused before any path is built', async () => {
  const { staticDir, templatesDir } = seeded('ids');
  const { saveStoredTemplate, deleteStoredTemplate, getStoredTemplate } = require('../dist/database/templateRepository');
  const { getTemplateById } = require('../dist/extractors/templateExtractor');
  const { normalizeImportedTemplateId } = require('../dist/services/templateImport');
  const base = { name: 'X', description: '', htmlContent: HTML, cssContent: '', sections: [], createdAt: 'x', updatedAt: 'x' };

  for (const id of ['../evil', '..', 'a/b', 'a\\b', 'Upper', 'under_score', 'con', 'nul', 'lpt1', '', '-lead', 'x'.repeat(101)]) {
    assert.throws(() => saveStoredTemplate({ ...base, id }), { name: 'TemplateStoreError' }, JSON.stringify(id));
  }
  assert.equal(fs.existsSync(path.join(staticDir, 'evil.json')), false);
  assert.equal(fs.existsSync(path.join(path.dirname(staticDir), 'evil.json')), false);

  // A built-in's id: refused, and the shipped file untouched.
  const shipped = fs.readFileSync(path.join(templatesDir, 'default.json'), 'utf8');
  assert.throws(() => saveStoredTemplate({ ...base, id: 'default' }), /never overwritten/);
  assert.equal(deleteStoredTemplate('default'), false);
  assert.equal(fs.readFileSync(path.join(templatesDir, 'default.json'), 'utf8'), shipped);

  // A traversal finds nothing, rather than a file somewhere else.
  assert.equal(await getTemplateById('../templates/default'), null);
  assert.equal(getStoredTemplate('../default'), null);
  assert.equal(deleteStoredTemplate('../default'), false);

  // An import's ids are folded to what a file may carry, or minted afresh.
  assert.equal(normalizeImportedTemplateId('My Template_v2'), 'my-template-v2');
  assert.equal(normalizeImportedTemplateId('  --Odd--  '), 'odd');
  assert.equal(normalizeImportedTemplateId('CON'), '');
  assert.equal(normalizeImportedTemplateId('../..'), '');
  assert.deepEqual(leftovers(templatesDir), []);
});

test('a lookup folds case and underscores, so a profile naming an older import still finds it', async () => {
  const { templatesDir } = seeded('fold');
  const { saveStoredTemplate } = require('../dist/database/templateRepository');
  const { getTemplateById } = require('../dist/extractors/templateExtractor');
  saveStoredTemplate({ id: 'my-template', name: 'Mine', description: '', htmlContent: HTML, cssContent: '', sections: [], createdAt: 'x', updatedAt: 'x' });
  assert.equal((await getTemplateById('My_Template')).id, 'my-template');
  assert.equal((await getTemplateById('my-template.json')).id, 'my-template');
  assert.ok(fs.existsSync(path.join(templatesDir, 'my-template.json')));
});

/* --------------------------------------------------------- failed writes */

test('a templates directory that cannot be written gives the generic error with a ref, and leaves no .tmp', async () => {
  const server = await serve('unwritable');
  // Root ignores permission bits, so the refusals are injected at the calls a
  // read-only directory refuses: creating the scratch file (EROFS), and - for
  // a write that got that far - the rename over the old file.
  const realOpen = fs.openSync;
  const realRename = fs.renameSync;
  const refuse = (code) => Object.assign(new Error(`${code}: refused, ${server.templatesDir}`), { code });
  try {
    fs.openSync = (target, ...rest) => {
      if (String(target).endsWith('.tmp')) throw refuse('EROFS');
      return realOpen(target, ...rest);
    };
    const { result: created, lines } = await captureErrorLog(() => server.call('admin', 'POST', '/create-manual', MANUAL));
    assert.equal(created.status, 500);
    assert.match(created.body.error, /^Template could not be saved\. Please try again, or contact your administrator\.$/);
    assert.match(created.body.ref, /^ERR-[0-9A-F]{6}$/);
    assert.match(created.body.detail, /EROFS/, 'an administrator is told the cause');
    assert.ok(lines.some((line) => line.includes(created.body.ref) && line.includes('EROFS')), 'and it is logged under the ref');
    fs.openSync = realOpen;

    // Got as far as the scratch file, then the rename was refused: the
    // scratch file is removed, and the template that was there is unchanged.
    const manual = (await server.call('admin', 'POST', '/create-manual', MANUAL)).body;
    const before = fs.readFileSync(path.join(server.templatesDir, `${manual.id}.json`), 'utf8');
    fs.renameSync = () => {
      throw refuse('EIO');
    };
    const { result: patched } = await captureErrorLog(() => server.call('admin', 'PATCH', `/${manual.id}`, { name: 'Never' }));
    fs.renameSync = realRename;
    assert.equal(patched.status, 500);
    assert.match(patched.body.error, /^Template could not be saved\./);
    assert.equal(fs.readFileSync(path.join(server.templatesDir, `${manual.id}.json`), 'utf8'), before);
    assert.deepEqual(leftovers(server.templatesDir), []);

    // An import that fails halfway takes back what it wrote: all or nothing.
    let opened = 0;
    fs.openSync = (target, ...rest) => {
      if (String(target).endsWith('.tmp') && ++opened === 2) throw refuse('ENOSPC');
      return realOpen(target, ...rest);
    };
    const { result: imported } = await captureErrorLog(() =>
      server.call(
        'admin',
        'POST',
        '/upload-json',
        jsonUpload([
          { id: 'first-of-two', name: 'A', htmlContent: HTML.padEnd(150, ' ') },
          { id: 'second-of-two', name: 'B', htmlContent: HTML.padEnd(150, ' ') },
        ])
      )
    );
    fs.openSync = realOpen;
    assert.equal(imported.status, 500);
    assert.equal(fs.existsSync(path.join(server.templatesDir, 'first-of-two.json')), false);
    assert.deepEqual(leftovers(server.templatesDir), []);
  } finally {
    fs.openSync = realOpen;
    fs.renameSync = realRename;
    server.close();
  }
});

test('the startup line says whether saved templates can be written', () => {
  const { staticDir, templatesDir } = seeded('probe');
  const { describeTemplatesDirectory } = loadFresh('../dist/database/templateFiles');
  const ok = describeTemplatesDirectory();
  assert.equal(ok.level, 'log');
  assert.ok(ok.line.startsWith(`Templates: ${templatesDir}`));
  assert.match(ok.line, /writable/);
  assert.deepEqual(leftovers(templatesDir), [], 'the probe cleans up after itself');

  // A template copied in by hand under a name no id can have is not offered,
  // and the startup line says so by name rather than at the first listing.
  fs.copyFileSync(path.join(templatesDir, 'default.json'), path.join(templatesDir, 'Company_Brand.json'));
  const named = describeTemplatesDirectory();
  assert.equal(named.level, 'warn');
  assert.match(named.line, /writable\)\. Not offered/);
  assert.match(named.line, /Company_Brand\.json/);
  assert.match(named.line, /company-brand\.json/);
  fs.unlinkSync(path.join(templatesDir, 'Company_Brand.json'));

  // A FILE where the directory should be: no user, root included, can write there.
  fs.rmSync(templatesDir, { recursive: true });
  fs.writeFileSync(templatesDir, 'not a directory');
  const blocked = describeTemplatesDirectory();
  assert.equal(blocked.level, 'warn');
  assert.match(blocked.line, /is NOT writable/);
  assert.match(blocked.line, /Built-in templates still render/);
  void staticDir;
});

test('a scratch file a stopped process left is swept once it is old, and nothing else is', () => {
  const { templatesDir } = seeded('sweep');
  const { sweepTemplateScratchFiles } = loadFresh('../dist/database/templateFiles');
  const stale = path.join(templatesDir, 'm-1a2b3c4d.json.4242-0a1b2c3d.tmp');
  const fresh = path.join(templatesDir, 'm-1a2b3c4d.json.4243-0a1b2c3e.tmp');
  const probe = path.join(templatesDir, '.write-probe-4242-0a1b2c3d.tmp');
  const notOurs = path.join(templatesDir, 'notes.tmp');
  for (const file of [stale, fresh, probe, notOurs]) fs.writeFileSync(file, '{');
  const hourAgo = (Date.now() - 60 * 60_000) / 1000;
  for (const file of [stale, probe, notOurs]) fs.utimesSync(file, hourAgo, hourAgo);

  assert.equal(sweepTemplateScratchFiles(), 2);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(probe), false);
  assert.ok(fs.existsSync(fresh), 'a save still running may own it');
  assert.ok(fs.existsSync(notOurs), 'only names this store writes');
  assert.ok(fs.existsSync(path.join(templatesDir, 'default.json')));
});

/* ----------------------------------------------------- the one-time move */

function legacyRow(id, extra = {}) {
  const now = '2025-01-01T00:00:00.000Z';
  return {
    id,
    name: `Legacy ${id}`,
    description: 'From the table',
    htmlContent: HTML,
    cssContent: '',
    sections: ['summary'],
    supportsStrengths: false,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

/** A database as the previous build left it: a `templates` table with rows in it. */
function writeLegacyDatabase(dbDir, rows) {
  const db = new Database(path.join(dbDir, 'free_tailor.db'));
  try {
    db.exec(`CREATE TABLE templates (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    const insert = db.prepare(
      'INSERT INTO templates (id, name, disabled, data, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)'
    );
    for (const row of rows) insert.run(row.id, row.name, JSON.stringify(row), row.createdAt, row.updatedAt);
  } finally {
    db.close();
  }
}

test('an older database\'s templates are moved to files once, and the rows are kept', async () => {
  const { dbDir, templatesDir } = seeded('move');
  const shippedDefault = fs.readFileSync(path.join(templatesDir, 'default.json'), 'utf8');
  writeLegacyDatabase(dbDir, [
    legacyRow('3f2a9c1e-0000-4000-8000-000000000001', { name: 'Uploaded PDF', description: 'Template extracted from cv.pdf' }),
    legacyRow('m-1a2b3c4d', { manualConfig: { name: 'M', columns: 1 } }),
    legacyRow('Team_Layout'),
    // Hidden behind the built-in of the same id all along; the file wins.
    legacyRow('default', { name: 'An old copy' }),
    legacyRow('bad id/../x'),
  ]);

  const { lines } = await startQuietly();

  const uploaded = readFile(templatesDir, '3f2a9c1e-0000-4000-8000-000000000001');
  assert.equal(uploaded.source, 'uploaded');
  assert.equal(uploaded.name, 'Uploaded PDF');
  assert.equal('supportsStrengths' in uploaded, false, 'a derived flag a row carried is not written');
  assert.equal(readFile(templatesDir, 'm-1a2b3c4d').source, 'manual');
  assert.equal(readFile(templatesDir, 'team-layout').name, 'Legacy Team_Layout');
  assert.equal(fs.readFileSync(path.join(templatesDir, 'default.json'), 'utf8'), shippedDefault, 'a built-in is never overwritten');
  assert.ok(lines.some((line) => line.includes('"default"') && /built-in/.test(line)), 'the clash is said');

  let marker;
  const db = new Database(path.join(dbDir, 'free_tailor.db'), { readonly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM templates').get().n, 5, 'the rows stay, as a backup');
    marker = JSON.parse(db.prepare("SELECT value FROM schema_meta WHERE key = 'templates_moved_to_files'").get().value);
  } finally {
    db.close();
  }
  assert.equal(marker.complete, true);
  // An id no file can carry is filed under a fresh one rather than lost: the
  // older build served that row by its exact id.
  const [[teamFrom, teamTo], [badFrom, badTo]] = marker.renamed;
  assert.deepEqual([teamFrom, teamTo], ['Team_Layout', 'team-layout']);
  assert.equal(badFrom, 'bad id/../x');
  assert.match(badTo, /^u-[0-9a-f]{8}$/);
  assert.equal(readFile(templatesDir, badTo).name, 'Legacy bad id/../x');
  assert.deepEqual(marker.moved.sort(), ['3f2a9c1e-0000-4000-8000-000000000001', 'm-1a2b3c4d', 'team-layout', badTo].sort());
  assert.deepEqual(marker.kept.map((kept) => kept.id), ['default']);
  assert.ok(lines.some((line) => line.includes('"bad id/../x"') && line.includes(`${badTo}.json`)), 'the rename is said');

  // Anything still naming an old id gets the same template.
  const { getTemplateById } = loadFresh('../dist/extractors/templateExtractor');
  assert.equal((await getTemplateById('Team_Layout')).name, 'Legacy Team_Layout');
  assert.equal((await getTemplateById('bad id/../x')).name, 'Legacy bad id/../x');
  assert.equal((await getTemplateById('m-1a2b3c4d')).source, 'manual');

  // Once: a template deleted after the move does not come back at the next start.
  fs.unlinkSync(path.join(templatesDir, 'm-1a2b3c4d.json'));
  loadFresh('../dist/database/sqlite').getDb();
  assert.equal(fs.existsSync(path.join(templatesDir, 'm-1a2b3c4d.json')), false);
  assert.deepEqual(leftovers(templatesDir), []);
});

test('a move that cannot write tries again at the next start', async () => {
  const { dbDir, staticDir, templatesDir } = seeded('move-retry');
  writeLegacyDatabase(dbDir, [legacyRow('u-0000aaaa')]);
  // The templates "directory" is a file: nothing can be written into it.
  const aside = path.join(staticDir, 'templates-aside');
  fs.renameSync(templatesDir, aside);
  fs.writeFileSync(templatesDir, '');

  await captureErrorLog(async () => {
    const warn = console.warn;
    console.warn = (...args) => console.error(...args);
    try {
      loadFresh('../dist/database/sqlite').getDb();
    } finally {
      console.warn = warn;
    }
  });
  // Recorded, but as not finished: the row that failed is tried again.
  assert.equal(readMarker(dbDir).complete, false);
  assert.deepEqual(readMarker(dbDir).failed.map((failed) => failed.id), ['u-0000aaaa']);

  fs.rmSync(templatesDir);
  fs.renameSync(aside, templatesDir);
  loadFresh('../dist/database/sqlite').getDb();
  assert.equal(readFile(templatesDir, 'u-0000aaaa').source, 'uploaded');
  assert.equal(readMarker(dbDir).complete, true);
});

/** Profiles as an older build stored them: one JSON document per row. */
function writeLegacyProfiles(dbDir, profiles) {
  const db = new Database(path.join(dbDir, 'free_tailor.db'));
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    const insert = db.prepare(
      'INSERT INTO profiles (id, name, disabled, data, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)'
    );
    const at = '2025-03-01T00:00:00.000Z';
    for (const profile of profiles) {
      const document = { name: profile.id, title: 'Engineer', createdAt: at, updatedAt: at, ...profile };
      insert.run(profile.id, document.name, JSON.stringify(document), at, at);
    }
  } finally {
    db.close();
  }
}

function readMarker(dbDir) {
  const db = new Database(path.join(dbDir, 'free_tailor.db'), { readonly: true });
  try {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'templates_moved_to_files'").get();
    return row ? JSON.parse(row.value) : null;
  } finally {
    db.close();
  }
}

async function startQuietly() {
  return captureErrorLog(async () => {
    const warn = console.warn;
    const log = console.log;
    console.warn = (...args) => console.error(...args);
    console.log = (...args) => console.error(...args);
    try {
      loadFresh('../dist/database/sqlite').getDb();
    } finally {
      console.warn = warn;
      console.log = log;
    }
  });
}

/** A row the older build's importer could have stored, drawn with a design of its own. */
function designRow(id, design, createdAt) {
  return legacyRow(id, { name: `Design ${design}`, htmlContent: `${HTML}<p>${design}</p>`, createdAt, updatedAt: createdAt });
}

test('an older spelling that folds onto a taken id keeps its own design, and its profiles are changed to name it', async () => {
  const { dbDir, templatesDir } = seeded('move-fold-clash');
  const shipped = {
    default: fs.readFileSync(path.join(templatesDir, 'default.json'), 'utf8'),
    'navy-rule': fs.readFileSync(path.join(templatesDir, 'navy-rule.json'), 'utf8'),
  };
  // Every id here is one the older importer kept as a JSON file gave it. The
  // created order decides nothing: an exact id keeps its own file either way.
  const designs = {
    Team_Layout: designRow('Team_Layout', 'UPPER-TEAM', '2025-01-01T00:00:00.000Z'),
    'team-layout': designRow('team-layout', 'EXACT-TEAM', '2025-02-01T00:00:00.000Z'),
    'my-template': designRow('my-template', 'EXACT-MINE', '2025-01-01T00:00:00.000Z'),
    My_Template: designRow('My_Template', 'UPPER-MINE', '2025-02-01T00:00:00.000Z'),
    Navy_Rule: designRow('Navy_Rule', 'UPLOADED-NAVY', '2025-01-03T00:00:00.000Z'),
    Default: designRow('Default', 'UPLOADED-DEFAULT', '2025-01-04T00:00:00.000Z'),
    _draft: designRow('_draft', 'DRAFT', '2025-01-05T00:00:00.000Z'),
    '-copy--Classic': designRow('-copy--Classic', 'COPY', '2025-01-06T00:00:00.000Z'),
  };
  writeLegacyDatabase(dbDir, Object.values(designs));
  const spellings = Object.keys(designs);
  writeLegacyProfiles(
    dbDir,
    spellings.map((spelling, index) => ({ id: `p${index}`, preferredTemplate: spelling }))
  );

  const { lines } = await startQuietly();

  for (const id of ['default', 'navy-rule']) {
    assert.equal(fs.readFileSync(path.join(templatesDir, `${id}.json`), 'utf8'), shipped[id], `${id} is never overwritten`);
  }
  const marker = readMarker(dbDir);
  assert.equal(marker.complete, true);
  assert.deepEqual(marker.kept, [], 'nothing is left behind');
  assert.equal(marker.repointedProfiles, 6);
  const renamed = new Map(marker.renamed);
  assert.deepEqual([...renamed.keys()].sort(), ['-copy--Classic', 'Default', 'My_Template', 'Navy_Rule', 'Team_Layout', '_draft']);
  for (const to of renamed.values()) assert.match(to, /^u-[0-9a-f]{8}$/);
  assert.equal(readFile(templatesDir, 'team-layout').name, 'Design EXACT-TEAM', 'the exact id keeps its own file');
  assert.equal(readFile(templatesDir, 'my-template').name, 'Design EXACT-MINE');
  assert.ok(lines.some((line) => line.includes('"Navy_Rule"') && line.includes(`${renamed.get('Navy_Rule')}.json`)));

  const { getProfile } = require('../dist/database/profileRepository');
  const { getTemplateById, getAllTemplates } = loadFresh('../dist/extractors/templateExtractor');
  const { resolveTemplateForProfile } = loadFresh('../dist/services/templateChoice');
  const { drawnTemplate, templatesUsedByOthers } = loadFrontendModule('lib/profileDraft.ts');
  const offered = await getAllTemplates();

  const profiles = [];
  for (const [index, spelling] of spellings.entries()) {
    const design = designs[spelling].name;
    const profile = getProfile(`p${index}`);
    profiles.push(profile);
    // The stored profile now names the file - its own id when it had one.
    assert.equal(profile.preferredTemplate, renamed.get(spelling) ?? spelling, spelling);
    // The server draws every profile with the design the older build did.
    assert.equal((await resolveTemplateForProfile(profile)).name, design, spelling);
    // So does anything still naming the old spelling: a queued resume, a page left open.
    assert.equal((await getTemplateById(spelling)).name, design, `${spelling} by its old spelling`);
    // And the editor and the Profiles list, which compare ids as they are, agree.
    const { stored, drawn } = drawnTemplate(offered, profile);
    assert.equal(stored && stored.name, design, `${spelling} in the frontend`);
    assert.equal(drawn && drawn.name, design);
  }
  // One template per profile still holds: each is taken under the id offered.
  const used = templatesUsedByOthers(profiles);
  for (const template of offered.filter((t) => !t.isBuiltIn)) assert.ok(used[template.id], template.id);

  // A page left open from before the upgrade saves the old spelling: it is
  // stored under the id the template is filed under now.
  const { buildUpdatedProfile } = require('../dist/services/profileService');
  assert.equal(buildUpdatedProfile(profiles[4], { preferredTemplate: 'Navy_Rule' }).preferredTemplate, renamed.get('Navy_Rule'));
  assert.equal(buildUpdatedProfile(profiles[4], { preferredTemplate: 'Some_Other' }).preferredTemplate, 'some-other');
  assert.equal(buildUpdatedProfile(profiles[4], { preferredTemplate: 'navy-rule' }).preferredTemplate, 'navy-rule');
  assert.deepEqual(leftovers(templatesDir), []);
});

test('a move that could not write one row retries only that row: a template deleted or edited since stays so', async () => {
  const { dbDir, templatesDir } = seeded('move-per-row');
  writeLegacyDatabase(dbDir, [legacyRow('keep-me'), legacyRow('edit-me'), legacyRow('blocked')]);
  // Something at blocked.json that cannot be read as a file: that row fails.
  fs.mkdirSync(path.join(templatesDir, 'blocked.json'));

  await startQuietly();
  let marker = readMarker(dbDir);
  assert.equal(marker.complete, false);
  assert.deepEqual(marker.failed.map((failed) => failed.id), ['blocked']);
  assert.deepEqual(marker.moved.sort(), ['edit-me', 'keep-me']);

  // Meanwhile an administrator deletes one moved template and edits another.
  fs.unlinkSync(path.join(templatesDir, 'keep-me.json'));
  const edited = { ...readFile(templatesDir, 'edit-me'), name: 'Edited since', htmlContent: `${HTML}<p>edited</p>`, updatedAt: '2025-06-01T00:00:00.000Z' };
  fs.writeFileSync(path.join(templatesDir, 'edit-me.json'), JSON.stringify(edited));
  fs.rmdirSync(path.join(templatesDir, 'blocked.json'));

  const { lines } = await startQuietly();
  assert.equal(readFile(templatesDir, 'blocked').source, 'uploaded', 'the failed row is moved now');
  assert.equal(fs.existsSync(path.join(templatesDir, 'keep-me.json')), false, 'a deleted template does not come back');
  assert.equal(readFile(templatesDir, 'edit-me').name, 'Edited since', 'an edit survives');
  assert.ok(!lines.some((line) => /left in the database/.test(line)), lines.join('\n'));
  marker = readMarker(dbDir);
  assert.equal(marker.complete, true);
  assert.deepEqual(marker.failed, []);
  assert.deepEqual(marker.moved.sort(), ['blocked', 'edit-me', 'keep-me']);
});

test('with its record deleted the move runs again: a row changed since replaces its file, and nothing is written twice', async () => {
  const { dbDir, templatesDir } = seeded('move-again');
  writeLegacyDatabase(dbDir, [
    legacyRow('m-0000aaaa', { manualConfig: { name: 'M', columns: 1 } }),
    legacyRow('u-0000bbbb'),
    designRow('Team_Layout', 'UPPER-TEAM', '2025-01-01T00:00:00.000Z'),
    designRow('Navy_Rule', 'UPLOADED-NAVY', '2025-01-02T00:00:00.000Z'),
  ]);
  await startQuietly();
  const first = readMarker(dbDir);
  const files = () => fs.readdirSync(templatesDir).sort();
  const before = files();

  // An older build, run in between, changed a row: the operator deletes the
  // record so this build moves it forward (README, "Rolling back this release").
  const db = new Database(path.join(dbDir, 'free_tailor.db'));
  try {
    const row = JSON.parse(db.prepare("SELECT data FROM templates WHERE id = 'm-0000aaaa'").get().data);
    const changed = { ...row, name: 'Changed under the older build', updatedAt: '2025-07-01T00:00:00.000Z' };
    db.prepare("UPDATE templates SET data = ?, updated_at = ? WHERE id = 'm-0000aaaa'").run(JSON.stringify(changed), changed.updatedAt);
    db.prepare("DELETE FROM schema_meta WHERE key = 'templates_moved_to_files'").run();
  } finally {
    db.close();
  }

  await startQuietly();
  assert.equal(readFile(templatesDir, 'm-0000aaaa').name, 'Changed under the older build');
  assert.deepEqual(files(), before, 'the renamed rows find the files they were given, rather than writing copies');
  assert.deepEqual(readMarker(dbDir).renamed, first.renamed, 'and are given the same ids');
});

test('a profile still naming an older spelling is read under the id its template is filed under now', async () => {
  const { dbDir, templatesDir } = seeded('read-current-id');
  writeLegacyDatabase(dbDir, [designRow('Navy_Rule', 'UPLOADED-NAVY', '2025-01-02T00:00:00.000Z')]);
  await startQuietly();
  const navyTo = new Map(readMarker(dbDir).renamed).get('Navy_Rule');
  // A built-in an operator copied in by hand as Company_Brand.json, then
  // renamed as the startup line asks.
  fs.copyFileSync(path.join(templatesDir, 'default.json'), path.join(templatesDir, 'company-brand.json'));

  // Rows the move never saw: a restored backup's, a hand edit's.
  const db = new Database(path.join(dbDir, 'free_tailor.db'));
  try {
    const at = '2025-03-01T00:00:00.000Z';
    const insert = db.prepare(
      'INSERT INTO profiles (id, name, disabled, data, created_at, updated_at, owner_id) VALUES (?, ?, 0, ?, ?, ?, ?)'
    );
    for (const [id, preferredTemplate] of [['late-navy', 'Navy_Rule'], ['late-brand', 'Company_Brand'], ['plain', 'navy-rule'], ['gone', '../x']]) {
      insert.run(id, id, JSON.stringify({ id, name: id, preferredTemplate, ownerId: 'o1', createdAt: at, updatedAt: at }), at, at, 'o1');
    }
  } finally {
    db.close();
  }

  const { getProfile, listAllProfilesUnscoped } = require('../dist/database/profileRepository');
  assert.equal(getProfile('late-navy').preferredTemplate, navyTo, 'the uploaded design, not the shipped navy-rule');
  assert.equal(getProfile('late-brand').preferredTemplate, 'company-brand');
  assert.equal(getProfile('plain').preferredTemplate, 'navy-rule');
  assert.equal(getProfile('gone').preferredTemplate, '../x', 'no template id at all is left to fall back as before');
  const listed = Object.fromEntries(listAllProfilesUnscoped().map((profile) => [profile.id, profile.preferredTemplate]));
  assert.equal(listed['late-navy'], navyTo);
  assert.equal(listed['late-brand'], 'company-brand');
});
