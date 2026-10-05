const assert = require('node:assert/strict');
const test = require('node:test');

// Pure functions only: the filter's verdict is code over a job analysis.

const jobFilter = require('../dist/services/jobFilter');
const {
  evaluateJobFilterAnalysis,
  getEmptyJobFilterAnalysis,
  normalizeJobFilterAnalysis,
  stringifySalary,
} = jobFilter;

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

test('the filter judges the facts the job analysis read, with no prompt of its own', () => {
  // Owner decision J8: the filter's own AI read is gone. The one analysis of
  // a posting asks for the same facts, and the verdict is code over them.
  const analysis = {
    jobMeta: { title: 'Senior Engineer', seniority: 'senior', industry: '', department: '' },
    salary: { min: 180000, max: 220000, currency: 'USD', period: 'annual', raw: null },
    filter: {
      jobType: 'remote',
      onsiteInterview: 'no',
      companyCategory: 'saas',
      clearanceRequired: 'none',
      region: 'us',
      usState: '',
    },
  };
  const facts = jobFilter.jobFilterAnalysisOf(analysis);
  assert.deepEqual(facts, {
    jobType: 'remote',
    onsiteInterview: 'no',
    companyCategory: 'saas',
    seniority: 'senior',
    clearanceRequired: 'none',
    salary: 'USD 180,000 - 220,000 / annual',
    region: 'us',
    usState: '',
  });
  assert.deepEqual(jobFilter.evaluateJobFilterAnalysis(facts), { result: 'Pass', reason: null });

  // Seniority is the analysis's jobMeta.seniority, which the filter's rules read.
  const lead = jobFilter.jobFilterAnalysisOf({ ...analysis, jobMeta: { ...analysis.jobMeta, seniority: 'lead' } });
  assert.deepEqual(jobFilter.evaluateJobFilterAnalysis(lead), { result: 'Fail', reason: 'lead' });

  // An older analysis with no filter facts is judged on none, like a page
  // with nothing on it: not passed by default.
  const bare = jobFilter.jobFilterAnalysisOf({ jobMeta: { title: '', seniority: '' } });
  assert.equal(jobFilter.evaluateJobFilterAnalysis(bare).result, 'Fail');

  assert.equal(jobFilter.buildJobFilterPrompt, undefined, 'the filter prompt is retired');
  assert.equal(jobFilter.evaluateJobContentAgainstFilter, undefined, 'and so is its own model call');
});

test('a model answer judged through the job analysis keeps the old verdicts: an unknown clearance fails, as it did', () => {
  const { normalizeJobAnalysisResponse } = require('../dist/services/resumeService');
  // answer -> the analysis's normaliser -> the facts the filter reads -> the verdict.
  const verdict = (filter, seniority = 'senior') =>
    evaluateJobFilterAnalysis(
      jobFilter.jobFilterAnalysisOf(
        normalizeJobAnalysisResponse(
          {
            jobMeta: { title: 'Engineer', seniority, industry: '', department: '' },
            jobField: 'backend',
            filter: { jobType: 'remote', onsiteInterview: 'no', companyCategory: 'saas', region: 'us', ...filter },
          },
          'A posting.'
        )
      )
    );

  for (const clearance of ['TS/SCI', 'Top Secret/SCI', 'TS-SCI', 'top secret', 'secret', 'required', 'yes', 'DoD Secret', 'Secret clearance', true, 42]) {
    assert.deepEqual(verdict({ clearanceRequired: clearance }), { result: 'Fail', reason: 'clearance_required' }, String(clearance));
  }
  for (const clearance of ['none', 'not_specified', 'Not specified', '', null, false]) {
    assert.deepEqual(verdict({ clearanceRequired: clearance }), { result: 'Pass', reason: null }, String(clearance));
  }
  // Left out, as the prompt defines it: "no mention at all" is none.
  assert.deepEqual(verdict({}), { result: 'Pass', reason: null });
  // "TS/SCI" is the list's own word once its slash is folded.
  const { normalizeFilterFacts } = require('../dist/services/jobAnalysis/facts');
  assert.equal(normalizeFilterFacts({ clearanceRequired: 'TS/SCI' }).clearanceRequired, 'ts_sci');
  assert.equal(normalizeFilterFacts({ clearanceRequired: 'Top Secret/SCI' }).clearanceRequired, 'ts_sci');

  // Job types spelled another way: on site fails as on_site, fully remote is remote.
  assert.deepEqual(verdict({ jobType: 'onsite', clearanceRequired: 'none' }), { result: 'Fail', reason: 'on_site' });
  assert.deepEqual(verdict({ jobType: 'Fully Remote', clearanceRequired: 'none' }), { result: 'Pass', reason: null });
  assert.deepEqual(verdict({ jobType: 'Remote (US)', clearanceRequired: 'none' }), { result: 'Fail', reason: 'job_type_not_specified' });

  // The two answers the old filter's tests read, through the new path: still Fail.
  assert.equal(verdict({ jobType: 'full-time', companyCategory: 'healthcare', clearanceRequired: 'no' }).result, 'Fail');
  assert.equal(verdict({ jobType: 'contract', onsiteInterview: false, companyCategory: 'defense', clearanceRequired: true }, 'staff').result, 'Fail');
  // And a VP is judged on the analysis's seniority.
  assert.deepEqual(verdict({ clearanceRequired: 'none' }, 'vp'), { result: 'Fail', reason: 'vp' });
});
