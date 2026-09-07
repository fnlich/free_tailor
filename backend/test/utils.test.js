const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { moveCaseInsensitiveMatches, uniqueCaseInsensitive } = require('../dist/utils/array');
const { extractJSON } = require('../dist/utils/json');
const {
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

test('uniqueCaseInsensitive keeps the first item for each lowercase key', () => {
  assert.deepEqual(
    uniqueCaseInsensitive(['React', 'react', 'Node.js', 'NODE.JS', 'TypeScript']),
    ['React', 'Node.js', 'TypeScript']
  );
});

test('moveCaseInsensitiveMatches moves matching candidates in reverse scan order', () => {
  const candidates = ['React', 'Node.js', 'SQL', 'node.js'];
  const matched = [];

  moveCaseInsensitiveMatches(['NODE.JS'], candidates, matched);

  assert.deepEqual(candidates, ['React', 'SQL']);
  assert.deepEqual(matched, ['node.js', 'Node.js']);
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
