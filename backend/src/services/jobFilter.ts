import { resolveAnalysisModel } from '../config/aiModelConfig';
import type { JobAnalysis } from '../types/template';
import { formatSalary } from './jobAnalysis/facts';

/**
 * The Job Filter's verdict on a posting: Pass, or Fail with the first rule it
 * broke - decided in CODE from the facts its one job analysis read.
 */


export type JobFilterAnalysis = {
  jobType: string;
  onsiteInterview: string;
  companyCategory: string;
  seniority: string;
  clearanceRequired: string;
  salary: string;
  region: string;
  usState: string;
};

export type JobFilterDecision = {
  result: 'Pass' | 'Fail';
  reason: string | null;
};

type JobFilterResponseLike = {
  job_type?: unknown;
  jobType?: unknown;
  onsite_interview?: unknown;
  onsiteInterview?: unknown;
  company_category?: unknown;
  companyCategory?: unknown;
  seniority?: unknown;
  clearance_required?: unknown;
  clearanceRequired?: unknown;
  salary?: unknown;
  region?: unknown;
  us_state?: unknown;
  usState?: unknown;
};

type JobFilterSalaryLike = {
  min?: unknown;
  max?: unknown;
  period?: unknown;
  raw?: unknown;
};

function normalizeText(value: unknown): string {
  if (typeof value === 'string') {
    return value.replace(/\s+/g, ' ').trim();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  return '';
}

function formatSalaryFromParts(parts: {
  min: string;
  max: string;
  period: string;
}): string {
  const { min, max, period } = parts;
  const range = min && max ? `${min} - ${max}` : min || max;

  if (!range) {
    return period;
  }

  return period ? `${range} / ${period}` : range;
}

export function stringifySalary(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return normalizeText(value);
  }

  if (!value || typeof value !== 'object') {
    return '';
  }

  const salary = value as JobFilterSalaryLike;
  const raw = normalizeText(salary.raw);
  if (raw) {
    return raw;
  }

  return formatSalaryFromParts({
    min: normalizeText(salary.min),
    max: normalizeText(salary.max),
    period: normalizeText(salary.period),
  });
}

export function getEmptyJobFilterAnalysis(): JobFilterAnalysis {
  return {
    jobType: '',
    onsiteInterview: '',
    companyCategory: '',
    seniority: '',
    clearanceRequired: '',
    salary: '',
    region: '',
    usState: '',
  };
}

export function normalizeJobFilterAnalysis(payload: unknown): JobFilterAnalysis {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Job filter response must be a JSON object.');
  }

  const source = payload as JobFilterResponseLike;
  return {
    jobType: normalizeText(source.job_type ?? source.jobType),
    onsiteInterview: normalizeText(source.onsite_interview ?? source.onsiteInterview),
    companyCategory: normalizeText(source.company_category ?? source.companyCategory),
    seniority: normalizeText(source.seniority),
    clearanceRequired: normalizeText(source.clearance_required ?? source.clearanceRequired),
    salary: stringifySalary(source.salary),
    region: normalizeText(source.region),
    usState: normalizeText(source.us_state ?? source.usState),
  };
}

function normalizeRuleValue(value: string): string {
  return value.trim().toLowerCase();
}

export function evaluateJobFilterAnalysis(analysis: JobFilterAnalysis): JobFilterDecision {
  const jobType = normalizeRuleValue(analysis.jobType);
  if (jobType === 'hybrid') {
    return { result: 'Fail', reason: 'hybrid' };
  }
  if (jobType === 'on_site') {
    return { result: 'Fail', reason: 'on_site' };
  }
  if (jobType === 'not_specified') {
    return { result: 'Fail', reason: 'job_type_not_specified' };
  }

  if (normalizeRuleValue(analysis.onsiteInterview) === 'yes') {
    return { result: 'Fail', reason: 'onsite_interview' };
  }

  const companyCategory = normalizeRuleValue(analysis.companyCategory);
  if (companyCategory === 'healthcare') {
    return { result: 'Fail', reason: 'healthcare' };
  }
  if (companyCategory === 'fintech') {
    return { result: 'Fail', reason: 'fintech' };
  }
  if (companyCategory === 'defense_military') {
    return { result: 'Fail', reason: 'defense_military' };
  }

  const seniority = normalizeRuleValue(analysis.seniority);
  if (seniority === 'intern') {
    return { result: 'Fail', reason: 'intern' };
  }
  if (seniority === 'junior') {
    return { result: 'Fail', reason: 'junior' };
  }
  if (seniority === 'lead') {
    return { result: 'Fail', reason: 'lead' };
  }
  if (seniority === 'principal') {
    return { result: 'Fail', reason: 'principal' };
  }
  if (seniority === 'director') {
    return { result: 'Fail', reason: 'director' };
  }
  if (seniority === 'vp') {
    return { result: 'Fail', reason: 'vp' };
  }
  if (seniority === 'manager') {
    return { result: 'Fail', reason: 'manager' };
  }

  const clearanceRequired = normalizeRuleValue(analysis.clearanceRequired);
  if (clearanceRequired !== 'none' && clearanceRequired !== 'not_specified') {
    return { result: 'Fail', reason: 'clearance_required' };
  }

  if (normalizeRuleValue(analysis.region) === 'not_us') {
    return { result: 'Fail', reason: 'not_us' };
  }

  return { result: 'Pass', reason: null };
}

/**
 * The facts the filter judges, read off the posting's ONE job analysis.
 *
 * The filter used to make an AI read of its own for these (a prompt of its
 * own, `filter-google-sheet-job`), on top of the analysis a build of the same
 * posting made. Now the analysis asks for them too (owner decision J8), so a
 * posting is read once whichever comes first - the filter, or a build - and
 * the verdict is code (`evaluateJobFilterAnalysis`) over what is stored.
 */
export function jobFilterAnalysisOf(analysis: JobAnalysis): JobFilterAnalysis {
  const facts = analysis.filter;
  return {
    jobType: facts?.jobType ?? '',
    onsiteInterview: facts?.onsiteInterview ?? '',
    companyCategory: facts?.companyCategory ?? '',
    seniority: analysis.jobMeta?.seniority ?? '',
    clearanceRequired: facts?.clearanceRequired ?? '',
    salary: formatSalary(analysis.salary),
    region: facts?.region ?? '',
    usState: facts?.usState ?? '',
  };
}

/**
 * The model a filter run's summary names: the analysis model, by the display
 * name an administrator gave it - the only name for a model an ordinary
 * account is shown. Rows judged on a posting analysed earlier name the model
 * that is analysing new postings now; the summary is about the run.
 */
export async function describeJobFilterModel(): Promise<{ modelLabel: string }> {
  const model = await resolveAnalysisModel();
  return { modelLabel: model.name };
}
