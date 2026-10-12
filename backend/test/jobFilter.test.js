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

test('the filter judges the facts the job analysis read, with no prompt call of its own', () => {
  // Owner decision J8: the filter makes no AI read of its own. Its facts are
  // the analysis's second call (O1), and the verdict is code over them.
  const analysis = {
    jobMeta: { title: 'Senior Engineer', seniority: 'senior', industry: '', department: '' },
    salary: { min: 180000, max: 220000, currency: null, period: 'annual', raw: null },
    filter: {
      jobType: 'remote',
      onsiteInterview: 'no',
      companyCategory: 'saas',
      clearanceRequired: 'none',
      region: 'us',
      usState: '',
      seniority: 'senior',
    },
  };
  const facts = jobFilter.jobFilterAnalysisOf(analysis);
  assert.deepEqual(facts, {
    jobType: 'remote',
    onsiteInterview: 'no',
    companyCategory: 'saas',
    seniority: 'senior',
    clearanceRequired: 'none',
    // No currency: the facts prompt asks for none, and none is inferred.
    salary: '180,000 - 220,000 / annual',
    region: 'us',
    usState: '',
  });
  assert.deepEqual(jobFilter.evaluateJobFilterAnalysis(facts), { result: 'Pass', reason: null });

  // Seniority is the facts call's: only its list has intern, director and VP.
  // The keyword analysis's own word (here "unknown", its list's) is not read.
  const vp = jobFilter.jobFilterAnalysisOf({
    ...analysis,
    jobMeta: { ...analysis.jobMeta, seniority: 'unknown' },
    filter: { ...analysis.filter, seniority: 'vp' },
  });
  assert.deepEqual(jobFilter.evaluateJobFilterAnalysis(vp), { result: 'Fail', reason: 'vp' });
  const saysNothing = jobFilter.jobFilterAnalysisOf({
    ...analysis,
    jobMeta: { ...analysis.jobMeta, seniority: 'lead' },
    filter: { ...analysis.filter, seniority: 'not_specified' },
  });
  assert.equal(saysNothing.seniority, 'not_specified', "the facts call's word wins, even 'not specified'");

  // An analysis stored before the facts call has no filter.seniority: its
  // jobMeta.seniority was asked in the facts call's words, and is read instead.
  const { seniority: _none, ...olderFacts } = analysis.filter;
  const lead = jobFilter.jobFilterAnalysisOf({ ...analysis, filter: olderFacts, jobMeta: { ...analysis.jobMeta, seniority: 'lead' } });
  assert.deepEqual(jobFilter.evaluateJobFilterAnalysis(lead), { result: 'Fail', reason: 'lead' });

  // An older analysis with no filter facts is judged on none, like a page
  // with nothing on it: not passed by default.
  const bare = jobFilter.jobFilterAnalysisOf({ jobMeta: { title: '', seniority: '' } });
  assert.equal(jobFilter.evaluateJobFilterAnalysis(bare).result, 'Fail');

  assert.equal(jobFilter.buildJobFilterPrompt, undefined, 'no prompt is built here: the gate runs the facts call');
  assert.equal(jobFilter.evaluateJobContentAgainstFilter, undefined, 'and the filter makes no model call of its own');
});

test('a facts answer judged through the job analysis keeps the old verdicts: an unknown clearance fails, as it did', () => {
  const { parseJobFacts, parseJobAnalysisKeywords, composeJobAnalysis } = require('../dist/services/resumeService');
  // The facts call's answer (top-level snake_case) -> its parser -> the one
  // analysis -> the facts the filter reads -> the verdict.
  const keywords = parseJobAnalysisKeywords(
    JSON.stringify({ jobMeta: { title: 'Engineer', seniority: 'unknown', industry: '', department: '' } }),
    'A posting.'
  );
  const verdict = (facts, seniority = 'senior') =>
    evaluateJobFilterAnalysis(
      jobFilter.jobFilterAnalysisOf(
        composeJobAnalysis(
          keywords,
          parseJobFacts(
            JSON.stringify({ job_field: 'backend', job_type: 'remote', onsite_interview: 'no', company_category: 'saas', region: 'us', seniority, ...facts })
          )
        )
      )
    );

  for (const clearance of ['TS/SCI', 'Top Secret/SCI', 'TS-SCI', 'top secret', 'secret', 'required', 'yes', 'DoD Secret', 'Secret clearance', true, 42]) {
    assert.deepEqual(verdict({ clearance_required: clearance }), { result: 'Fail', reason: 'clearance_required' }, String(clearance));
  }
  for (const clearance of ['none', 'not_specified', 'Not specified', '', null, false]) {
    assert.deepEqual(verdict({ clearance_required: clearance }), { result: 'Pass', reason: null }, String(clearance));
  }
  // Left out, as the prompt defines it: "no mention at all" is none.
  assert.deepEqual(verdict({}), { result: 'Pass', reason: null });
  // "TS/SCI" is the list's own word once its slash is folded.
  const { normalizeFilterFacts } = require('../dist/services/jobAnalysis/facts');
  assert.equal(normalizeFilterFacts({ clearanceRequired: 'TS/SCI' }).clearanceRequired, 'ts_sci');
  assert.equal(normalizeFilterFacts({ clearance_required: 'Top Secret/SCI' }).clearanceRequired, 'ts_sci');

  // Job types spelled another way: on site fails as on_site, fully remote is remote.
  assert.deepEqual(verdict({ job_type: 'onsite', clearance_required: 'none' }), { result: 'Fail', reason: 'on_site' });
  assert.deepEqual(verdict({ job_type: 'Fully Remote', clearance_required: 'none' }), { result: 'Pass', reason: null });
  assert.deepEqual(verdict({ job_type: 'Remote (US)', clearance_required: 'none' }), { result: 'Fail', reason: 'job_type_not_specified' });

  // The two answers the old filter's tests read, through the new path: still Fail.
  assert.equal(verdict({ job_type: 'full-time', company_category: 'healthcare', clearance_required: 'no' }).result, 'Fail');
  assert.equal(verdict({ job_type: 'contract', onsite_interview: false, company_category: 'defense', clearance_required: true }, 'staff').result, 'Fail');
  // And a VP, an intern and a director are judged on the facts call's seniority.
  for (const seniority of ['vp', 'VP', 'intern', 'Director']) {
    assert.equal(verdict({ clearance_required: 'none' }, seniority).result, 'Fail', seniority);
  }
  // A word off its list is not specified, which passes - it never fails a posting by accident.
  assert.deepEqual(verdict({ clearance_required: 'none' }, 'Chief Wizard'), { result: 'Pass', reason: null });
});
