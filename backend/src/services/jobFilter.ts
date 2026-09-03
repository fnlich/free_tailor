import type { AIProvider } from '../types/template';
import { extractJSON } from '../utils/json';
import { createPromptCompletion } from './claude';
import { renderPrompt } from './promptService';

export const JOB_FILTER_PROVIDER: AIProvider = 'openrouter';
export const JOB_FILTER_PROMPT_ID = 'filter-google-sheet-job';
export const JOB_FILTER_MIN_CONTENT_LENGTH = 50;

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

export async function buildJobFilterPrompt(jobContent: string, jobLink = ''): Promise<string> {
  const normalizedContent = jobContent.trim();
  if (!normalizedContent) {
    throw new Error('Job content is required.');
  }

  const normalizedLink = jobLink.trim();
  return renderPrompt(JOB_FILTER_PROMPT_ID, {
    jobContent: normalizedContent,
    jobDescription: normalizedContent,
    jobLink: normalizedLink,
  });
}

export async function evaluateJobContentAgainstFilter(input: {
  jobContent: string;
  jobLink?: string;
  provider?: AIProvider;
}): Promise<JobFilterAnalysis> {
  const jobContent = normalizeText(input.jobContent);
  if (jobContent.length < JOB_FILTER_MIN_CONTENT_LENGTH) {
    return getEmptyJobFilterAnalysis();
  }

  const prompt = await buildJobFilterPrompt(jobContent, input.jobLink);
  const responseText = await createPromptCompletion({
    promptId: JOB_FILTER_PROMPT_ID,
    prompt,
    fallbackProvider: input.provider || JOB_FILTER_PROVIDER,
    maxTokens: 500,
    temperature: 0,
    responseFormat: 'json',
  });
  const responseJson = JSON.parse(extractJSON(responseText)) as unknown;
  return normalizeJobFilterAnalysis(responseJson);
}
