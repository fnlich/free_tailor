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
 *   - a fresh database has no `templates` table at all.
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

    // Listed for everybody, beside the built-ins, and no table to put them in.
    const listed = await server.call('alice', 'GET', '/');
    const ids = listed.body.map((template) => template.id);
    for (const id of [kept.id, minted.id, extracted.body.id, manual.body.id, 'default']) assert.ok(ids.includes(id), id);
    assert.equal(listed.body.find((template) => template.id === 'default').isBuiltIn, true);
    const db = new Database(path.join(server.dbDir, 'free_tailor.db'), { readonly: true });
    try {
      assert.equal(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'templates'").get(),
        undefined,
        'a fresh database has no templates table'
      );
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

test('a lookup takes an id as its file carries it - no folding of case or underscores', async () => {
  const { templatesDir } = seeded('ids-as-they-are');
  const { saveStoredTemplate } = require('../dist/database/templateRepository');
  const { getTemplateById } = require('../dist/extractors/templateExtractor');
  saveStoredTemplate({ id: 'my-template', name: 'Mine', description: '', htmlContent: HTML, cssContent: '', sections: [], createdAt: 'x', updatedAt: 'x' });
  assert.equal((await getTemplateById('my-template')).id, 'my-template');
  assert.equal((await getTemplateById(' my-template.json ')).id, 'my-template', 'the file name, trimmed');
  assert.equal(await getTemplateById('My_Template'), null, 'an older spelling finds nothing');
  assert.equal(await getTemplateById('../my-template'), null, 'no path is built from a non-id');
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
