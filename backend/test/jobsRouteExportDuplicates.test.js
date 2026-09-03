const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh } = require('./helpers');

test('export duplicate keys are based on company name only', () => {
  const { buildExportRowDuplicateKeys } = loadFresh('../dist/routes/jobs');

  assert.deepEqual(
    buildExportRowDuplicateKeys({
      companyName: 'Acme Inc',
      jobTitle: 'Software Engineer',
      jobLink: 'https://example.com/jobs/1',
    }),
    ['company:acme inc']
  );

  assert.deepEqual(
    buildExportRowDuplicateKeys({
      companyName: '  Acme   Inc  ',
      jobTitle: 'Data Engineer',
      jobLink: 'https://example.com/jobs/2',
    }),
    ['company:acme inc']
  );

  assert.deepEqual(
    buildExportRowDuplicateKeys({
      companyName: '',
      jobTitle: 'Software Engineer',
      jobLink: 'https://example.com/jobs/3',
    }),
    []
  );
});
