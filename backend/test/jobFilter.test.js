const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { loadFresh, makeTempDataDir } = require('./helpers');

const {
  evaluateJobFilterAnalysis,
  getEmptyJobFilterAnalysis,
  normalizeJobFilterAnalysis,
  stringifySalary,
} = require('../dist/services/jobFilter');

test('normalizeJobFilterAnalysis reads the new snake_case payload and keeps salary.raw', () => {
  assert.deepEqual(
    normalizeJobFilterAnalysis({
      job_type: 'full-time',
      onsite_interview: 'no',
      company_category: 'healthcare',
      seniority: 'senior',
      clearance_required: 'no',
      salary: {
        min: 180000,
        max: 220000,
        period: 'year',
        raw: '$180,000 - $220,000 base salary',
      },
      region: 'United States',
      us_state: 'CA',
    }),
    {
      jobType: 'full-time',
      onsiteInterview: 'no',
      companyCategory: 'healthcare',
      seniority: 'senior',
      clearanceRequired: 'no',
      salary: '$180,000 - $220,000 base salary',
      region: 'United States',
      usState: 'CA',
    }
  );
});

test('normalizeJobFilterAnalysis falls back to camelCase fields and stringifies salary ranges', () => {
  assert.deepEqual(
    normalizeJobFilterAnalysis({
      jobType: 'contract',
      onsiteInterview: false,
      companyCategory: 'defense',
      seniority: 'staff',
      clearanceRequired: true,
      salary: {
        min: '$90',
        max: '$110',
        period: 'hour',
      },
      region: 'United States',
      usState: null,
    }),
    {
      jobType: 'contract',
      onsiteInterview: 'false',
      companyCategory: 'defense',
      seniority: 'staff',
      clearanceRequired: 'true',
      salary: '$90 - $110 / hour',
      region: 'United States',
      usState: '',
    }
  );
});

test('stringifySalary returns an empty string for missing salary data', () => {
  assert.equal(stringifySalary(null), '');
  assert.equal(stringifySalary({ min: null, max: null, period: null, raw: null }), '');
});

test('getEmptyJobFilterAnalysis returns blank sheet-safe values', () => {
  assert.deepEqual(getEmptyJobFilterAnalysis(), {
    jobType: '',
    onsiteInterview: '',
    companyCategory: '',
    seniority: '',
    clearanceRequired: '',
    salary: '',
    region: '',
    usState: '',
  });
});

test('evaluateJobFilterAnalysis returns Pass when every rule clears', () => {
  assert.deepEqual(
    evaluateJobFilterAnalysis({
      jobType: 'remote',
      onsiteInterview: 'no',
      companyCategory: 'saas',
      seniority: 'senior',
      clearanceRequired: 'none',
      salary: '$180,000 - $220,000',
      region: 'us',
      usState: '',
    }),
    {
      result: 'Pass',
      reason: null,
    }
  );
});

test('evaluateJobFilterAnalysis applies the rules in the requested order', () => {
  assert.deepEqual(
    evaluateJobFilterAnalysis({
      jobType: 'hybrid',
      onsiteInterview: 'yes',
      companyCategory: 'healthcare',
      seniority: 'intern',
      clearanceRequired: 'secret',
      salary: '',
      region: 'not_us',
      usState: 'CA',
    }),
    {
      result: 'Fail',
      reason: 'hybrid',
    }
  );
});

test('evaluateJobFilterAnalysis fails later conditions when earlier ones pass', () => {
  assert.deepEqual(
    evaluateJobFilterAnalysis({
      jobType: 'remote',
      onsiteInterview: 'yes',
      companyCategory: 'saas',
      seniority: 'senior',
      clearanceRequired: 'none',
      salary: '',
      region: 'us',
      usState: '',
    }),
    {
      result: 'Fail',
      reason: 'onsite_interview',
    }
  );
});

test('buildJobFilterPrompt renders the managed prompt with jobContent and legacy jobDescription support', async () => {
  const dataDir = makeTempDataDir('job-filter-prompt');
  process.env.TAILOR_DATA_DIR = dataDir;
  fs.mkdirSync(path.join(dataDir, 'prompts'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'prompts', 'filter-google-sheet-job.json'),
    `${JSON.stringify({
      id: 'filter-google-sheet-job',
      content: 'Analyze [[jobContent]] from [[jobLink]] and legacy [[jobDescription]].',
      createdAt: '2026-05-02T00:00:00.000Z',
      updatedAt: '2026-05-02T00:00:00.000Z',
      allowedVariables: [
        { name: 'jobContent' },
        { name: 'jobLink' },
        { name: 'jobDescription' },
      ],
    }, null, 2)}\n`
  );

  loadFresh('../dist/services/promptService');
  const { buildJobFilterPrompt } = loadFresh('../dist/services/jobFilter');
  assert.equal(
    await buildJobFilterPrompt('Remote role in the US.', 'https://jobs.example.com/1'),
    'Analyze Remote role in the US. from https://jobs.example.com/1 and legacy Remote role in the US..'
  );
});
