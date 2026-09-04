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
