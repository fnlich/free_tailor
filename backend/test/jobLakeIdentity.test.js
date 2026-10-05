const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const identity = require('../dist/services/jobLake/identity');

/**
 * The Job Data Lake's identity of a job (owner decision J2a): the company,
 * compared after NFKC, lower case, punctuation and a trailing legal suffix
 * dropped and every space removed, and the job field by its stable id -
 * SHA-256 of the versioned pair. The plan's own cases first.
 */

test("the owner's cases: OpenAI, Inc. = Open AI LLC = openai, and Acme Corp is not Acme Labs", () => {
  const { normaliseCompany, jobHash } = identity;
  assert.equal(normaliseCompany('OpenAI, Inc.'), 'openai');
  assert.equal(normaliseCompany('Open AI LLC'), 'openai');
  assert.equal(normaliseCompany('openai'), 'openai');
  assert.equal(jobHash('OpenAI, Inc.', 'backend'), jobHash('Open AI LLC', 'backend'));
  assert.equal(jobHash('Open AI LLC', 'backend'), jobHash('openai', 'backend'));

  assert.equal(normaliseCompany('Acme Corp'), 'acme');
  assert.equal(normaliseCompany('Acme Labs'), 'acmelabs');
  assert.notEqual(jobHash('Acme Corp', 'backend'), jobHash('Acme Labs', 'backend'));
});

test('every step of the normalisation, each on its own', () => {
  const { normaliseCompany } = identity;
  // NFKC: full-width letters are the plain ones.
  assert.equal(normaliseCompany('ＡＣＭＥ Inc'), 'acme');
  // Symbols go before NFKC would spell ™ as TM.
  assert.equal(normaliseCompany('Acme™ Corporation'), 'acme');
  assert.equal(normaliseCompany('Acme® Ltd.'), 'acme');
  // A full stop or apostrophe joins; any other mark separates.
  assert.equal(normaliseCompany('Foo S.A.'), 'foo');
  assert.equal(normaliseCompany("Macy's, Inc."), 'macys');
  assert.equal(normaliseCompany('Acme,Inc.'), 'acme');
  assert.equal(normaliseCompany('AT&T'), 'att');
  // Multi-word suffixes, and suffixes stacked on each other.
  assert.equal(normaliseCompany('Acme Pty Ltd'), 'acme');
  assert.equal(normaliseCompany('Acme Holdings Co., Ltd.'), 'acmeholdings');
  assert.equal(normaliseCompany('Siemens GmbH & Co. KG'), 'siemens');
  assert.equal(normaliseCompany('Globex Company'), 'globex');
  assert.equal(normaliseCompany('Initech PLC'), 'initech');
  // A suffix is a whole trailing word: "Visa" keeps its "sa", "Cisco" its "co".
  assert.equal(normaliseCompany('Visa'), 'visa');
  assert.equal(normaliseCompany('Cisco'), 'cisco');
  // Never stripped to nothing.
  assert.equal(normaliseCompany('Company'), 'company');
  assert.equal(normaliseCompany('Inc.'), 'inc');
  // Spaces and case, wherever they are.
  assert.equal(normaliseCompany('  open   ai  '), 'openai');
  // Nothing left is nothing.
  assert.equal(normaliseCompany('  '), '');
  assert.equal(normaliseCompany('!!!'), '');
  assert.equal(normaliseCompany(null), '');
  assert.equal(normaliseCompany(42), '');
});

test('the hash is SHA-256 of the versioned pair, and the version travels with it', () => {
  const found = identity.lakeIdentity('OpenAI, Inc.', 'backend');
  const expected = crypto.createHash('sha256').update('v1\u0000openai\u0000backend', 'utf8').digest('hex');
  assert.equal(identity.JOB_LAKE_HASH_VERSION, 1);
  assert.deepEqual(found, { hash: expected, hashVersion: 1, companyKey: 'openai', jobFieldId: 'backend' });
  assert.match(found.hash, /^[0-9a-f]{64}$/);
  // The field is part of it: the same company in another field is another job.
  assert.notEqual(identity.jobHash('OpenAI', 'backend'), identity.jobHash('OpenAI', 'frontend'));
});

test('no company, or no field from the list, is no identity: never merged, never paid', () => {
  assert.equal(identity.lakeIdentity('', 'backend'), null);
  assert.equal(identity.lakeIdentity('...', 'backend'), null);
  assert.equal(identity.lakeIdentity('Acme', 'unclassified'), null);
  assert.equal(identity.lakeIdentity('Acme', 'not-a-field'), null);
  assert.equal(identity.lakeIdentity('Acme', ''), null);
  assert.equal(identity.jobHash('Acme', 'unclassified'), null);
});
