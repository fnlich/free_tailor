const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { extractJSON } = require('../dist/utils/json');
const {
  ORDER_OUTPUT_PATH_TEMPLATE,
  buildOutputPathPreview,
  normalizeOutputBaseDir,
  normalizeOutputFolderNameTemplate,
  normalizeOutputPathTemplate,
  outputPathTemplateUsesJobTitle,
  renderOutputFolderNameTemplate,
  renderOutputFileNameTemplate,
  renderOutputPathTemplate,
  resolveStoredFilePath,
  sanitizeFileNameStem,
  sanitizePathSegment,
  validateOutputPathTemplate,
} = require('../dist/utils/outputStorage');

/**
 * A helper module no source imports is dead weight the suite keeps compiling
 * and testing: utils/array.ts outlived the library ordering it served by a
 * whole release, its only reader a test of its own. Read from the sources,
 * because tsc never deletes a module's old output from dist.
 */
test('every module under src/utils is imported by the code, not only by a test', () => {
  const src = path.join(__dirname, '..', 'src');
  const sources = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.ts$/.test(entry.name)) sources.push(full);
    }
  };
  walk(src);
  const utilsDir = path.join(src, 'utils');
  for (const file of fs.readdirSync(utilsDir).filter((name) => name.endsWith('.ts'))) {
    const stem = file.replace(/\.ts$/, '');
    const importers = sources.filter((source) => {
      if (path.dirname(source) === utilsDir && path.basename(source) === file) return false;
      const wanted = path.join(utilsDir, stem);
      return [...fs.readFileSync(source, 'utf8').matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)].some(
        (match) => path.resolve(path.dirname(source), match[1]) === wanted
      );
    });
    assert.ok(importers.length > 0, `src/utils/${file} is imported by nothing under src`);
  }
});

test('extractJSON reads direct JSON, fenced JSON, and balanced JSON inside text', () => {
  assert.equal(extractJSON('{"ok":true}'), '{"ok":true}');
  assert.equal(extractJSON('```json\n{"ok":true}\n```'), '{"ok":true}');
  assert.equal(extractJSON('prefix {"items":[{"name":"A"}]} suffix'), '{"items":[{"name":"A"}]}');
  assert.equal(extractJSON('answer: ["a", "b"]'), '["a", "b"]');
});

test('extractJSON throws when no parseable JSON exists', () => {
  assert.throws(() => extractJSON('not json'), /No valid JSON object/);
});

test('output path helpers normalize, render, and validate paths', () => {
  assert.equal(sanitizePathSegment(' Senior Engineer / Platform '), 'senior_engineer_platform');
  assert.equal(sanitizeFileNameStem(' Jane_Doe_Resume '), 'Jane_Doe_Resume');
  assert.equal(normalizeOutputPathTemplate('profile\\{{date}}//{{company}}/'), '/profile/{{date}}/{{company}}');
  assert.equal(validateOutputPathTemplate('/{{profile name}}/{{role}}'), '/{{profile name}}/{{role}}');
  assert.throws(() => validateOutputPathTemplate('/{{unknown}}'), /Unsupported output path token/);

  assert.equal(
    renderOutputPathTemplate('/{{profile name}}/{{company name}}/{{job title}}', {
      date: '2026-04-18',
      profileName: 'Jane Doe',
      companyName: 'Acme Inc.',
      rowNumber: '12',
      jobTitle: 'Senior Engineer',
    }),
    'jane_doe/acme_inc/senior_engineer'
  );
  assert.equal(
    renderOutputPathTemplate('/{{profile name}}/{{row number}}_{{company name}}', {
      date: '2026-04-18',
      profileName: 'Jane Doe',
      companyName: 'Acme Inc.',
      rowNumber: '12',
      jobTitle: 'Senior Engineer',
    }),
    'jane_doe/12_acme_inc'
  );

  assert.equal(buildOutputPathPreview('/{{date}}/{{company name}}'), '/2026_04_10/acme_inc');
  assert.equal(outputPathTemplateUsesJobTitle('/{{role}}'), true);
  assert.equal(outputPathTemplateUsesJobTitle('/{{company name}}'), false);
  assert.equal(
    renderOutputFileNameTemplate('{{profile name}}_Resume', {
      date: '2026-04-18',
      profileName: 'Jane Doe',
      companyName: 'Acme Inc.',
      jobTitle: 'Senior Engineer',
    }, '{{profile name}}'),
    'Jane_Doe_Resume'
  );
  assert.equal(normalizeOutputFolderNameTemplate('row\\{{company name}}', '{{company name}}'), 'row {{company name}}');
  assert.equal(
    renderOutputFolderNameTemplate('{{row number}}_{{company name}}', {
      date: '2026-04-18',
      profileName: 'Jane Doe',
      companyName: 'Acme Inc.',
      rowNumber: '12',
      jobTitle: 'Senior Engineer',
    }, '{{company name}}'),
    '12_acme_inc'
  );
  assert.throws(
    () => renderOutputFolderNameTemplate('{{job title}}', {
      date: '2026-04-18',
      profileName: 'Jane Doe',
      companyName: 'Acme Inc.',
      rowNumber: '12',
      jobTitle: 'Senior Engineer',
    }, '{{company name}}'),
    /Unsupported output token/
  );
});

test('resolveStoredFilePath keeps paths inside the configured base directory', () => {
  const base = path.join(process.cwd(), 'generated');

  assert.equal(normalizeOutputBaseDir(base), path.resolve(base));
  assert.equal(resolveStoredFilePath(base, 'jane/acme/resume.pdf'), path.join(base, 'jane', 'acme', 'resume.pdf'));
  assert.equal(resolveStoredFilePath(base, '../outside.pdf'), null);
  assert.equal(resolveStoredFilePath(base, ''), null);
});

// -- Cross-platform path safety --------------------------------------------- //

test('sanitizePathSegment escapes the device names Windows reserves', () => {
  // A company called "Con" or a profile called "Aux" is legal input, and the
  // filesystem refuses the directory with EINVAL rather than creating it.
  assert.equal(sanitizePathSegment('Con'), '_con');
  assert.equal(sanitizePathSegment('AUX'), '_aux');
  assert.equal(sanitizePathSegment('com1'), '_com1');
  assert.equal(sanitizePathSegment('lpt9'), '_lpt9');
  // Only the exact names, not anything containing them.
  assert.equal(sanitizePathSegment('Concorde'), 'concorde');
  assert.equal(sanitizePathSegment('Nuland'), 'nuland');
});

test('sanitizeFileNameStem escapes reserved names and Windows-illegal characters', () => {
  // Windows matches the name before the FIRST dot, extension irrelevant.
  assert.equal(sanitizeFileNameStem('nul.v2'), '_nul.v2');
  assert.equal(sanitizeFileNameStem('PRN'), '_PRN');
  assert.equal(sanitizeFileNameStem('Acme: Inc <2026>'), 'Acme_Inc_2026');
  assert.equal(sanitizeFileNameStem('a/b\\c'), 'a_b_c');
  // A trailing dot or space is silently stripped by Windows; strip it here so
  // the name on disk is the name that was asked for.
  assert.equal(sanitizeFileNameStem('report. '), 'report');
});

test('the account segment renders like any other, and is not required', () => {
  // Added for orders, which file under the account first so that one directory
  // holds everything one person ordered - which is what lets the retention
  // sweep prune emptied folders without walking into anybody else's tree.
  assert.equal(
    renderOutputPathTemplate(ORDER_OUTPUT_PATH_TEMPLATE, {
      date: '2026-04-18',
      accountName: 'Jane.Doe@Example.com',
      orderNumber: 'FT-20260418-0007',
      profileName: 'Jane Doe',
      companyName: 'Acme Inc.',
      rowNumber: '12',
      jobTitle: 'Senior Engineer',
    }),
    'jane_doe_example_com/2026_04_18/ft_20260418_0007/jane_doe/acme_inc'
  );

  // Optional, because a script and a test have no account in scope. An absent
  // one becomes `unknown` like every other empty segment rather than throwing
  // or collapsing the level away.
  assert.equal(
    renderOutputPathTemplate('/{{account name}}/{{company name}}', {
      date: '2026-04-18',
      profileName: 'Jane Doe',
      companyName: 'Acme Inc.',
      jobTitle: 'Senior Engineer',
    }),
    'unknown/acme_inc'
  );

  // And the short alias works the way `profile` and `company` already do.
  assert.equal(validateOutputPathTemplate('/{{account}}'), '/{{account}}');
  assert.throws(() => validateOutputPathTemplate('/{{accounts}}'), /Unsupported output path token/);
});

test('renderOutputPathTemplate produces a path that is legal on both platforms', () => {
  const rendered = renderOutputPathTemplate('/{{profile name}}/{{company name}}', {
    date: '2026-04-10',
    profileName: 'Jane Doe',
    companyName: 'CON',
    rowNumber: '12',
    jobTitle: 'Senior Engineer',
  });

  assert.equal(rendered, 'jane_doe/_con');
});
