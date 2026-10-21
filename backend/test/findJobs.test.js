const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, storeJobAnalysis, useAdminEmails, useTempStorage } = require('./helpers');

/**
 * Find Jobs' routes (routes/jobs.ts, /api/jobs/lake...) over HTTP, as a user,
 * an administrator and a reporter:
 *
 *  - what a row carries is an ALLOWLIST (services/jobLake/findJobs.ts): a
 *    user's never names who reported a job, what they were paid, how often it
 *    was seen, its hash or its sync; an administrator's adds who reported it
 *    and how it came in;
 *  - the list filters' shapes - a repeated key, `field[]=`, never an object -
 *    and their caps, the keywords' 25 words in all among them, read by the
 *    one reader Admin -> Job Lake uses; Requested by refused to anybody but
 *    an administrator;
 *  - an export's ids and a list filter's values read in one pass, refused at
 *    the first that cannot be taken: a million of them is never compared
 *    pair by pair;
 *  - keywords ORed end to end, the company suggestions, one job's details,
 *    the export's cap from the environment, a reporter refused every route;
 *  - an export on an install with no Google Sheets: the jobs are looked up
 *    first, then the sheet's own sentence.
 *
 * No Google call is made: the account sheet's client says Sheets is not set
 * up, so even a mistake here cannot reach the owner's real credentials.
 */

const DAY = 24 * 60 * 60 * 1000;

const NOT_HERE = async () => {
  throw new Error('no Google in these tests');
};

async function serve(name) {
  useTempStorage(`find-jobs-${name}`);
  useAdminEmails('admin@example.com');
  const express = require('express');
  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  const accountSheet = loadFresh('../dist/services/sheets/accountSheet');
  accountSheet.setSheetsClientForTests({
    async isConfigured() {
      return false;
    },
    checkCredential: NOT_HERE,
    createSpreadsheet: NOT_HERE,
    formatJobSheetTab: NOT_HERE,
    addSheetTabWithHeaders: NOT_HERE,
    shareSpreadsheetWithEmail: NOT_HERE,
    hasPersonalGrant: NOT_HERE,
    getSpreadsheetVisibility: NOT_HERE,
    setSpreadsheetVisibility: NOT_HERE,
    listSheetTabs: NOT_HERE,
    readRanges: NOT_HERE,
  });
  loadFresh('../dist/services/sheets/jobSheetTarget');
  loadFresh('../dist/services/sheets/jobExport');
  loadFresh('../dist/services/jobLake/findJobs');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const jobs = loadFresh('../dist/routes/jobs');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/jobs', jobs.default);
  const server = app.listen(0);
  const port = server.address().port;

  const admin = users.createUser({ email: 'admin@example.com' });
  const user = users.createUser({ email: 'user@example.com' });
  const reporter = users.createUser({ email: 'rita@example.com', name: 'Rita', role: 'reporter' });
  const other = users.createUser({ email: 'otto@example.com', name: 'Otto', role: 'reporter' });
  const tokens = Object.fromEntries(
    [['admin', admin], ['user', user], ['reporter', reporter]].map(([key, account]) => [key, users.createSession(account.id)])
  );
  return {
    admin,
    user,
    reporter,
    other,
    call: async (who, method, path, body) => {
      const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
    close() {
      server.close();
    },
  };
}

/** A lake job from a stored analysis of its own, reported by `by`, `daysAgo` days back. */
function lakeJob(h, { company, field, title, jobType, industry, clearance = 'none', words, by, daysAgo }) {
  const lakeService = require('../dist/services/jobLake/index');
  const analyses = require('../dist/database/jobAnalysisRepository');
  const id = storeJobAnalysis(
    {
      jobField: field,
      industry,
      jobMeta: { title, seniority: 'senior', industry: '', department: '' },
      salary: { min: 100000, max: 150000, currency: 'USD', period: 'annual', raw: null },
      filter: {
        jobType,
        onsiteInterview: 'not_specified',
        companyCategory: 'other',
        clearanceRequired: clearance,
        region: 'us',
        usState: '',
      },
    },
    {
      jobDescription: `${company} is hiring: ${words}.`,
      jobLink: `https://jobs.example.com/${encodeURIComponent(company)}/${field}`,
      companyName: company,
    }
  );
  const merged = lakeService.mergeIntoLake(
    lakeService.lakeJobFromAnalysis(analyses.getJobAnalysisById(id), 'report', { company }),
    by.id,
    { reward: false, now: Date.now() - daysAgo * DAY }
  );
  assert.equal(merged.status, 'added', company);
  return { lakeId: merged.lakeId, analysisId: id };
}

function seed(h) {
  return {
    openai: lakeJob(h, { company: 'OpenAI, Inc.', field: 'backend', title: 'Inference Engineer', jobType: 'remote', industry: 'technology', words: 'Kubernetes and GPUs', by: h.reporter, daysAgo: 4 }),
    globex: lakeJob(h, { company: 'Globex', field: 'frontend', title: 'React Developer', jobType: 'hybrid', industry: 'finance', words: 'React, TypeScript, design systems', by: h.other, daysAgo: 3 }),
    initech: lakeJob(h, { company: 'Initech', field: 'devops', title: 'Site Reliability', jobType: 'on_site', industry: 'finance', clearance: 'secret', words: 'pager duty and kubernetes clusters', by: h.reporter, daysAgo: 2 }),
    openaiFrontend: lakeJob(h, { company: 'Open AI LLC', field: 'frontend', title: 'Web Engineer', jobType: 'remote', industry: 'technology', words: 'a web console', by: h.admin, daysAgo: 1 }),
  };
}

const companies = (body) => body.rows.map((row) => row.company);

const USER_ROW_KEYS = [
  'analysisId', 'clearance', 'company', 'id', 'industry', 'industryLabel', 'jobFieldId', 'jobFieldLabel', 'jobType',
  'jobTypeLabel', 'salary', 'title', 'updatedAt', 'url',
];
/** What the lake holds and no builder is shown: the reward and its rate, the seen count, the hash and the sync. */
const NEVER = ['reward', 'seenCount', 'lastSeenAt', 'jobHash', 'hashVersion', 'companyKey', 'createdAt', 'sheetSyncedAt', 'history'];

test("a row is the allowlist: a user's names no reporter, no reward, no hash; an administrator's adds who reported it", async (t) => {
  const h = await serve('rows');
  t.after(() => h.close());
  const seeded = seed(h);

  const mine = await h.call('user', 'GET', '/jobs/lake');
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.deepEqual(companies(mine.body), ['Open AI LLC', 'Initech', 'Globex', 'OpenAI, Inc.'], 'newest first');
  assert.equal(mine.body.total, 4);
  for (const row of mine.body.rows) assert.deepEqual(Object.keys(row).sort(), USER_ROW_KEYS, row.company);
  const initech = mine.body.rows.find((row) => row.company === 'Initech');
  assert.deepEqual(
    [initech.jobFieldLabel, initech.jobTypeLabel, initech.clearance, initech.industryLabel, initech.analysisId],
    ['DevOps', 'Onsite', true, 'Finance', seeded.initech.analysisId]
  );
  assert.deepEqual(mine.body.options, {
    jobTypes: require('../dist/services/jobAnalysis/facts').listJobTypesForClient(),
    industries: require('../dist/config/industries').listIndustriesForClient(),
  });
  assert.equal(mine.body.exportMaxRows, 200);
  const text = JSON.stringify(mine.body);
  for (const key of [...NEVER, 'requestedBy', 'requester', 'source']) assert.ok(!text.includes(`"${key}"`), key);
  assert.ok(!text.includes(h.reporter.id) && !text.includes('rita@example.com'), 'no reporter, by id or email');

  const theirs = await h.call('admin', 'GET', '/jobs/lake');
  assert.equal(theirs.status, 200);
  for (const row of theirs.body.rows) {
    assert.deepEqual(Object.keys(row).sort(), [...USER_ROW_KEYS, 'requestedBy', 'requester', 'source'].sort(), row.company);
  }
  const reported = theirs.body.rows.find((row) => row.company === 'Initech');
  assert.deepEqual(
    [reported.requestedBy, reported.requester, reported.source],
    [h.reporter.id, { id: h.reporter.id, email: 'rita@example.com', name: 'Rita' }, 'report']
  );
  for (const key of NEVER) assert.ok(!JSON.stringify(theirs.body).includes(`"${key}"`), key);

  // One job's details: the row and the posting's text, nothing more - no history.
  const detail = await h.call('user', 'GET', `/jobs/lake/${seeded.globex.lakeId}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(Object.keys(detail.body), ['entry']);
  assert.deepEqual(Object.keys(detail.body.entry).sort(), [...USER_ROW_KEYS, 'jobDescription'].sort());
  assert.equal(detail.body.entry.jobDescription, 'Globex is hiring: React, TypeScript, design systems.');
  const adminDetail = await h.call('admin', 'GET', `/jobs/lake/${seeded.globex.lakeId}`);
  assert.equal(adminDetail.body.entry.requester.email, 'otto@example.com');
  for (const junk of ['abc', '0', '-1', '1.5', '9999999', '12345678901234567890']) {
    const missing = await h.call('user', 'GET', `/jobs/lake/${junk}`);
    assert.deepEqual([missing.status, missing.body.error], [404, 'That job was not found in the lake.'], junk);
  }
});

test('the list filters take several values - repeated keys or key[] - each matching any; one box one value; Requested by is an administrator\'s', async (t) => {
  const h = await serve('filters');
  t.after(() => h.close());
  seed(h);
  const list = async (who, query) => h.call(who, 'GET', `/jobs/lake?${query}`);

  // A list: repeated keys, or key[]; each value any of them.
  assert.deepEqual(companies((await list('user', 'field=backend&field=devops')).body), ['Initech', 'OpenAI, Inc.']);
  assert.deepEqual(companies((await list('user', 'field[]=backend&field[]=devops')).body), ['Initech', 'OpenAI, Inc.']);
  assert.deepEqual(companies((await list('user', 'jobType=remote&jobType=on_site&industry=finance')).body), ['Initech']);
  assert.deepEqual(companies((await list('user', 'industry=finance&industry=technology&jobType=hybrid')).body), ['Globex']);
  assert.deepEqual(companies((await list('user', 'company=openai&company=Globex%20Corp')).body), ['Open AI LLC', 'Globex', 'OpenAI, Inc.']);
  assert.deepEqual(companies((await list('user', 'company=OpenAI%2C%20Inc.')).body), ['Open AI LLC', 'OpenAI, Inc.'], 'a comma is one company, never two');
  // Keywords: any of them, and the words of one together.
  assert.deepEqual(companies((await list('user', 'q=kubernetes&q=react')).body), ['Initech', 'Globex', 'OpenAI, Inc.']);
  assert.deepEqual(companies((await list('user', 'q=kubernetes%20clusters')).body), ['Initech']);
  assert.deepEqual(companies((await list('user', 'q=kubernetes%20clusters&q=web%20console')).body), ['Open AI LLC', 'Initech']);
  assert.equal((await list('user', 'q=react&q=gpus&limit=1')).body.total, 2, 'the count is of every match');
  // A value left empty is no filter.
  assert.equal((await list('user', 'requestedBy=&q=&field=')).body.total, 4);

  // Requested by: an administrator's, by role first.
  for (const query of [`requestedBy=${h.reporter.id}`, `requestedBy[]=${h.reporter.id}`, 'requestedBy[x]=y']) {
    const refused = await list('user', query);
    assert.deepEqual([refused.status, refused.body.code, refused.body.error], [403, 'not-an-admin', 'Only an administrator can filter jobs by who requested them.'], query);
  }
  assert.deepEqual(companies((await list('admin', `requestedBy=${h.reporter.id}`)).body), ['Initech', 'OpenAI, Inc.']);
  assert.deepEqual(companies((await list('admin', `requestedBy=${h.reporter.id}&requestedBy=${h.other.id}`)).body), ['Initech', 'Globex', 'OpenAI, Inc.']);

  // What is refused, in the reader's words.
  const many = (key, count) => Array.from({ length: count }, (_, n) => `${key}=value${n}`).join('&');
  const words = (count) => Array.from({ length: count }, (_, n) => `w${n}`).join('%20');
  const tooManyWords = 'Search for at most 25 words in all, across the keywords.';
  for (const [who, query, message] of [
    ['user', 'field[x]=backend', 'A filter value must be text.'],
    ['user', 'company[a]=x&company[b]=y', 'A filter value must be text.'],
    ['user', 'field=backend&field=astrology', 'That job field is not one of the list.'],
    ['user', 'jobType=remote&jobType=sometimes', 'That job type is not one of the list.'],
    ['user', 'industry=finance&industry=piracy', 'That industry is not one of the list.'],
    ['user', 'clearance=true&clearance=false', 'Clearance takes one value.'],
    ['user', 'salaryMin=1&salaryMin=2', 'Salary from takes one value.'],
    ['user', 'salaryMax[]=2', 'Salary to takes one value.'],
    ['user', 'updatedFrom=2026-10-01&updatedFrom=2026-10-02', 'Updated from takes one value.'],
    ['user', 'updatedTo[a]=2026-10-01', 'Updated to takes one value.'],
    ['user', many('q', 11), 'Search for at most 10 keywords at a time.'],
    // The keywords' words in all, as the index splits them: one keyword, or several.
    ['user', `q=${words(26)}`, tooManyWords],
    ['user', `q=${words(13)}&q=${words(13)}x`, tooManyWords],
    ['user', `q=${Array.from({ length: 26 }, (_, n) => `w${n}`).join('.')}`, tooManyWords],
    // A letter the index's tokenizer reads as a mark splits a word: 26 one-letter words, not one.
    ['user', `q=${encodeURIComponent(Array.from({ length: 26 }, () => 'a').join('ᦰ'))}`, tooManyWords],
    // And no keyword is longer than 100 characters, whatever it splits into.
    ['user', `q=${'a'.repeat(101)}`, 'A keyword can be at most 100 characters.'],
    ['user', many('company', 26), 'Choose at most 25 companies.'],
    ['admin', many('requestedBy', 26), 'Choose at most 25 people under Requested by.'],
  ]) {
    const refused = await list(who, query);
    assert.deepEqual([refused.status, refused.body.error], [400, message], query.slice(0, 80));
  }
  // At the caps, and repeats counted once.
  assert.equal((await list('user', many('q', 10))).status, 200);
  assert.equal((await list('user', `q=${words(25)}`)).status, 200);
  assert.equal((await list('user', `q=${words(13)}&q=${words(12)}x`)).status, 200);
  assert.equal((await list('user', `${many('company', 25)}&company=value0`)).status, 200);
});

test("an export's ids and a list filter's values are read once and refused at the first that cannot be taken - never compared pair by pair", () => {
  useTempStorage('find-jobs-one-pass');
  const { readLakeIds } = loadFresh('../dist/services/jobLake/findJobs');
  const { readLakeFilters, LAKE_FILTER_SENTENCES } = loadFresh('../dist/services/jobLake/filters');
  /** A million items, counting how many of them are read. */
  const counted = (item) => {
    const read = { items: 0 };
    const list = new Proxy(
      Array.from({ length: 1_000_000 }, (_, n) => item(n)),
      {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) read.items += 1;
          return Reflect.get(target, key, receiver);
        },
      }
    );
    return { list, read };
  };
  const refusal = (fn) => {
    try {
      fn();
      return null;
    } catch (error) {
      return { status: error.status, code: error.code, message: error.message };
    }
  };

  // A million different ids: refused at the 201st, the rest never looked at.
  const ids = counted((n) => n + 1);
  assert.deepEqual(refusal(() => readLakeIds(ids.list, 200)), {
    status: 400,
    code: 'too-many-jobs',
    message: 'Export at most 200 jobs at a time.',
  });
  assert.equal(ids.read.items, 201);
  // A million of one id is one job; a bad item is refused where it stands.
  assert.deepEqual(readLakeIds(Array.from({ length: 1_000_000 }, () => 7), 200), [7]);
  assert.equal(refusal(() => readLakeIds([1, 2, 'x', 3], 2))?.message, 'Each job is named by its number in the lake.');
  assert.equal(refusal(() => readLakeIds([1, 2, 3, 'x'], 2))?.code, 'too-many-jobs');

  // The open lists stop at their cap, the closed ones at the first value off the list.
  const keywords = counted((n) => `keyword ${n}`);
  assert.equal(refusal(() => readLakeFilters({ q: keywords.list }, { requestedBy: false }))?.message, LAKE_FILTER_SENTENCES.tooManyKeywords);
  assert.equal(keywords.read.items, 11);
  const fields = counted((n) => `astrology-${n}`);
  assert.equal(refusal(() => readLakeFilters({ field: fields.list }, { requestedBy: false }))?.message, LAKE_FILTER_SENTENCES.field);
  assert.equal(fields.read.items, 1);
  const industries = counted((n) => (n === 0 ? 'finance' : `piracy-${n}`));
  assert.equal(refusal(() => readLakeFilters({ industry: industries.list }, { requestedBy: true }))?.message, LAKE_FILTER_SENTENCES.industry);
  assert.equal(industries.read.items, 2);
  assert.deepEqual(readLakeFilters({ company: Array.from({ length: 1_000_000 }, () => 'Acme') }, { requestedBy: false }), {
    companies: ['Acme'],
  });
});

test('the company suggestions, the cap the page selects up to, and a reporter refused every route', async (t) => {
  const h = await serve('companies');
  t.after(() => {
    h.close();
    delete process.env.JOB_LAKE_EXPORT_MAX_ROWS;
  });
  seed(h);
  const suggest = async (query) => (await h.call('user', 'GET', `/jobs/lake/companies?${query}`)).body;
  assert.deepEqual(await suggest('prefix=open'), { companies: [{ name: 'Open AI LLC', jobs: 2 }] }, 'one company, its newest spelling');
  assert.deepEqual(await suggest('prefix=I'), { companies: [{ name: 'Initech', jobs: 1 }] });
  assert.deepEqual(await suggest('prefix=&limit=5'), { companies: [] });
  assert.deepEqual(await suggest('prefix[]=open'), { companies: [] }, 'a list is no prefix');
  assert.deepEqual((await suggest('prefix=o&limit=99')).companies.length, 1);
  assert.equal((await h.call('user', 'GET', '/jobs/lake/companies?prefix=g&limit=abc')).status, 200);

  process.env.JOB_LAKE_EXPORT_MAX_ROWS = '7';
  assert.equal((await h.call('user', 'GET', '/jobs/lake')).body.exportMaxRows, 7, 'read at every request');

  for (const [method, path, body] of [
    ['GET', '/jobs/lake'],
    ['GET', '/jobs/lake/companies?prefix=o'],
    ['GET', '/jobs/lake/1'],
    ['POST', '/jobs/lake/export', { ids: [1] }],
  ]) {
    const refused = await h.call('reporter', method, path, body);
    assert.deepEqual([refused.status, refused.body.code], [403, 'role-not-allowed'], `${method} ${path}`);
  }
});

test('an export with no Google Sheets on the server: the jobs are looked up first, then the sheet says it is not there', async (t) => {
  const h = await serve('no-sheets');
  t.after(() => h.close());
  const seeded = seed(h);
  const none = await h.call('user', 'POST', '/jobs/lake/export', { ids: [99999] });
  assert.deepEqual([none.status, none.body.code], [404, 'jobs-not-found']);
  const refused = await h.call('user', 'POST', '/jobs/lake/export', { ids: [seeded.globex.lakeId] });
  assert.equal(refused.status, 503, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "Job sheets aren't available right now. Please contact your administrator.");
  assert.equal('detail' in refused.body, false, "the cause is an administrator's to read");
  const asAdmin = await h.call('admin', 'POST', '/jobs/lake/export', { ids: [seeded.globex.lakeId] });
  assert.equal(asAdmin.status, 503);
  assert.match(asAdmin.body.detail, /Google Sheets is not configured on this server/);
});
