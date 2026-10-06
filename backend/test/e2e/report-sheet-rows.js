/*
 * The rows of today's tab that stub-report-sheets.js serves and report-run.js
 * reads back, in one place - and the earlier reports the script records for
 * its reporter before the run, which name two of those rows' postings.
 *
 * "Reported before" is the database's word, not the sheet's: a run skips a
 * row when its posting is stored and the reporter has a record of reporting
 * it (`job_reports`), wherever the row is. Nothing in the sheet decides it, so
 * the stub writes no Lake Status for those rows; `seedEarlierReports` records
 * the reports through the lake's own merge, the way an earlier run would
 * have, in the database the server shares.
 *
 * Today's tab, row by row (B Company, C Job Title, D Job Link, E Job
 * Description):
 *
 *   2  Acme Corp    a posting           -> Added
 *   3  ACME, Inc.   another posting     -> Duplicate: the same company in the
 *                                          same field, once normalised - red
 *   4  Globex LLC   a third posting     -> Added
 *   5  Initech      reported by this reporter before, and added then
 *                                       -> Reported before (Added), skipped
 *   6  (no company) a posting           -> Skipped
 *   7  Umbrella     no description, and a `javascript:` link that must never
 *                   become an anchor   -> Skipped
 *   8  Hooli        reported before, a duplicate then (the lake had Hooli's
 *                   job from a merge)  -> Reported before (Duplicate),
 *                                          skipped and painted red again
 *   9  Acme Corp    row 2's posting again -> Duplicate of the row above, red
 */

const path = require('path');

const posting = (what) =>
  `${what}: a senior backend engineer to build TypeScript services on Node.js for a SaaS platform, owning APIs end to end.`;

const INITECH = { company: 'Initech', title: 'Engineer', link: 'https://initech.example/jobs/4', jd: posting('Initech') };
const HOOLI = { company: 'Hooli', title: 'Staff Engineer', link: 'https://hooli.example/jobs/8', jd: posting('Hooli two') };
/** Hooli's other posting, merged into the lake from a build before the reporter reported theirs. */
const HOOLI_MERGED = { company: 'Hooli', link: 'https://hooli.example/jobs/1', jd: posting('Hooli one') };

/** Today's tab from row 2, columns A..E. */
function todayRows() {
  return [
    ['1', 'Acme Corp', 'Backend Engineer', 'https://acme.example/jobs/1', posting('Acme one')],
    ['2', 'ACME, Inc.', 'Platform Engineer', 'https://acme.example/jobs/2', posting('Acme two')],
    ['3', 'Globex LLC', 'API Engineer', 'https://globex.example/careers/7', posting('Globex')],
    ['4', INITECH.company, INITECH.title, INITECH.link, INITECH.jd],
    ['5', '', 'Engineer with no company', '', posting('Nameless')],
    ['6', 'Umbrella', 'Engineer', 'javascript:alert(1)', ''],
    ['7', HOOLI.company, HOOLI.title, HOOLI.link, HOOLI.jd],
    ['8', 'Acme Corp', 'Backend Engineer', 'https://acme.example/jobs/1', posting('Acme one')],
  ];
}

/** A stored analysis, as the gate would have stored it, with the facts the lake records from it. */
function analysisOf(jd, facts) {
  return {
    jobMeta: { title: 'Engineer', seniority: 'senior', industry: '', department: '' },
    skills: { technical: ['TypeScript'], required: [], preferred: [], tools: [], soft: [], technologies: [] },
    technologies: [],
    protocols: [],
    methodologies: [],
    architecturePatterns: [],
    responsibilities: ['services'],
    domainKnowledge: [],
    softSkills: [],
    keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
    jobField: 'backend',
    salary: null,
    filter: {
      jobType: 'not_specified',
      onsiteInterview: 'not_specified',
      companyCategory: 'other',
      clearanceRequired: 'none',
      region: 'us',
      usState: '',
      ...facts.filter,
    },
    ...(facts.industry ? { industry: facts.industry } : {}),
    sourceJobDescription: jd,
  };
}

/**
 * Records what an earlier run would have: the reporter reported Initech (added,
 * not paid - the rate was unset then) and Hooli's second posting (a duplicate
 * of the Hooli job an administrator merged in). Through the lake's own merge,
 * in the database the server reads.
 */
function seedEarlierReports(dist, { reporterId, adminId }) {
  const repository = require(path.join(dist, 'database', 'jobAnalysisRepository'));
  const identity = require(path.join(dist, 'services', 'jobAnalysis', 'identity'));
  const lake = require(path.join(dist, 'services', 'jobLake', 'index'));
  const store = (job, facts, createdBy) =>
    repository.insertJobAnalysisIfAbsent({
      contentHash: identity.contentHash(job.jd),
      linkKey: identity.linkKey(job.link),
      jobLink: job.link,
      analysis: analysisOf(job.jd, facts),
      modelId: '',
      promptHash: '',
      source: 'ai',
      createdBy,
      companyName: job.company,
    }).row;

  const initech = store(INITECH, { industry: 'finance', filter: { jobType: 'hybrid', clearanceRequired: 'secret' } }, reporterId);
  const hooliMerged = store(HOOLI_MERGED, { filter: { jobType: 'on_site' } }, adminId);
  const hooli = store(HOOLI, { filter: { jobType: 'on_site' } }, reporterId);
  return {
    initech: lake.mergeIntoLake(lake.lakeJobFromAnalysis(initech, 'report', { company: INITECH.company, title: INITECH.title, url: INITECH.link }), reporterId, { reward: false }),
    hooliMerged: lake.mergeIntoLake(lake.lakeJobFromAnalysis(hooliMerged, 'merge', { company: HOOLI_MERGED.company }), adminId, { reward: false }),
    hooli: lake.mergeIntoLake(lake.lakeJobFromAnalysis(hooli, 'report', { company: HOOLI.company, title: HOOLI.title, url: HOOLI.link }), reporterId, { reward: false }),
  };
}

module.exports = { posting, todayRows, seedEarlierReports, INITECH, HOOLI };
