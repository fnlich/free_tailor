const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh } = require('./helpers');

test('shouldSkipExistingFilterRow skips rows without a job link', () => {
  const { shouldSkipExistingFilterRow } = loadFresh('../dist/routes/jobs');

  assert.equal(
    shouldSkipExistingFilterRow({
      jobLink: '',
      existingAnalysisValues: ['', ''],
    }),
    true
  );
});

test('shouldSkipExistingFilterRow skips rows that already contain a Pass result', () => {
  const { shouldSkipExistingFilterRow } = loadFresh('../dist/routes/jobs');

  assert.equal(
    shouldSkipExistingFilterRow({
      jobLink: 'https://jobs.example.com/123',
      existingAnalysisValues: ['Pass', ''],
    }),
    true
  );
});

test('shouldSkipExistingFilterRow skips rows that already contain a Fail result and reason', () => {
  const { shouldSkipExistingFilterRow } = loadFresh('../dist/routes/jobs');

  assert.equal(
    shouldSkipExistingFilterRow({
      jobLink: 'https://jobs.example.com/123',
      existingAnalysisValues: ['Fail', 'healthcare'],
    }),
    true
  );
});

test('shouldSkipExistingFilterRow keeps partially-filled output rows eligible for reprocessing', () => {
  const { shouldSkipExistingFilterRow } = loadFresh('../dist/routes/jobs');

  assert.equal(
    shouldSkipExistingFilterRow({
      jobLink: 'https://jobs.example.com/123',
      existingAnalysisValues: ['Fail', ''],
    }),
    false
  );
});
