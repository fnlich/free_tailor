import { listAdminAIModels, resolveRequestedAIModel } from '../config/aiModelConfig';
import { findProviderModelOption } from '../config/providerModels';
import type { AIProvider } from '../types/template';
import { extractJSON } from '../utils/json';
import { createPromptCompletion, resolvePromptExecutionConfig } from './ai';
import { renderPrompt } from './promptService';

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

export function buildJobFilterPromptValues(jobContent: string, jobLink = ''): Record<string, string> {
  return {
    jobContent,
    jobDescription: jobContent,
    jobLink: jobLink.trim(),
  };
}

/**
 * The model a sheet filter runs on, and the name it is reported by.
 *
 * The app default model - a record an administrator added under Admin ->
 * Models, and the one the settings page shows as the default - rather than a
 * seat on whatever its CLI defaults to, so the filter runs on a model somebody
 * chose and can be named by the name they gave it. The filter prompt's own
 * override (Admin -> Prompts) still wins, as it does for every prompt, read the
 * way the call itself will read it.
 *
 * `modelLabel` is the display name, which is the only name for a model an
 * ordinary account is shown: never a seat or a CLI model name. An override
 * names a provider and a model name rather than a record, so it is reported by
 * the record an administrator made for that pair. With no such record there
 * is no display name to give, and the CLI option's label IS a model name - so
 * anybody else is told only that an administrator chose it, and the option's
 * label goes in `adminModelLabel` for the routes to give administrators.
 */
export type JobFilterModel = {
  provider: AIProvider;
  modelName: string;
  modelLabel: string;
  /** Set only when no record names the override's model: its CLI option label. */
  adminModelLabel?: string;
};

/** What an ordinary account reads for a filter model no record names. */
export const JOB_FILTER_UNNAMED_MODEL = 'Chosen by your administrator';

export async function resolveJobFilterModel(): Promise<JobFilterModel> {
  const model = await resolveRequestedAIModel();
  const config = await resolvePromptExecutionConfig(JOB_FILTER_PROMPT_ID, model.provider, model.modelName);
  const modelName = config.modelName ?? model.modelName;
  if (config.provider === model.provider && modelName === model.modelName) {
    return { provider: model.provider, modelName, modelLabel: model.name };
  }

  const record = (await listAdminAIModels()).find(
    (entry) => entry.provider === config.provider && entry.modelName.toLowerCase() === modelName.toLowerCase()
  );
  if (record) return { provider: config.provider, modelName, modelLabel: record.name };
  return {
    provider: config.provider,
    modelName,
    modelLabel: JOB_FILTER_UNNAMED_MODEL,
    adminModelLabel: findProviderModelOption(config.provider, modelName)?.label ?? modelName,
  };
}

export async function evaluateJobContentAgainstFilter(input: {
  jobContent: string;
  jobLink?: string;
  /** What `resolveJobFilterModel` resolved, once per run rather than once per row. */
  provider: AIProvider;
  modelName: string;
  signal?: AbortSignal;
}): Promise<JobFilterAnalysis> {
  const jobContent = normalizeText(input.jobContent);
  if (jobContent.length < JOB_FILTER_MIN_CONTENT_LENGTH) {
    return getEmptyJobFilterAnalysis();
  }

  // Passing values rather than pre-rendered text is what lets the transport
  // put the prompt's instruction preamble in the system channel. This call
  // used to pass neither, which meant it also got no JSON-only instruction.
  const responseText = await createPromptCompletion({
    promptId: JOB_FILTER_PROMPT_ID,
    promptValues: buildJobFilterPromptValues(jobContent, input.jobLink),
    fallbackProvider: input.provider,
    fallbackModelName: input.modelName,
    maxTokens: 500,
    temperature: 0,
    responseFormat: 'json',
    signal: input.signal,
  });
  const responseJson = JSON.parse(extractJSON(responseText)) as unknown;
  return normalizeJobFilterAnalysis(responseJson);
}
