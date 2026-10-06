import {
  foldIndustryWord,
  INDUSTRY_ALIASES,
  industryFromText,
  isIndustryId,
  NOT_SPECIFIED_INDUSTRY_ID,
  NOT_SPECIFIED_WORDS,
  OTHER_INDUSTRY_ID,
  INDUSTRIES,
} from '../../config/industries';
import type { JobFilterFacts, JobSalary, JobSalaryPeriod } from '../../types/template';

/**
 * The facts a job analysis reads off a posting beside its keywords: what it
 * pays, and what the Job Filter judges it on. Pure functions over the model's
 * answer, so a value the analysis prompt never offered is stored as "not
 * specified" rather than as itself - bar a clearance, where "not specified"
 * would PASS a posting the filter exists to fail, so an off-list word is kept.
 */

/**
 * The words each filter fact may be; anything else is `not_specified` (`other`
 * for a category) - except a clearance, which fails closed (`normalizeClearance`).
 */
export const FILTER_FACT_VALUES = {
  jobType: ['remote', 'hybrid', 'on_site', 'not_specified'],
  onsiteInterview: ['yes', 'no', 'not_specified'],
  companyCategory: [
    'healthcare',
    'fintech',
    'consulting',
    'defense_military',
    'saas',
    'ecommerce',
    'cybersecurity',
    'ai_ml',
    'edtech',
    'govtech',
    'insurtech',
    'legaltech',
    'media_entertainment',
    'logistics',
    'energy',
    'enterprise_software',
    'other',
  ],
  clearanceRequired: ['none', 'public_trust', 'secret', 'top_secret', 'ts_sci', 'not_specified'],
  region: ['us', 'not_us', 'not_specified'],
} as const;

/** The seniority words `jobMeta.seniority` is asked for, which the filter also judges on. */
export const SENIORITY_VALUES = [
  'intern',
  'junior',
  'mid',
  'senior',
  'staff',
  'principal',
  'lead',
  'manager',
  'director',
  'vp',
  'not_specified',
] as const;

/** A word as the lists spell them: lower case, spaces, hyphens and slashes as underscores ("TS/SCI" is `ts_sci`). */
function enumWord(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/[\s/-]+/g, '_');
}

function oneOf(value: unknown, allowed: readonly string[], fallback: string, aliases: Record<string, string> = {}): string {
  const word = enumWord(value);
  const known = aliases[word] ?? word;
  return allowed.includes(known) ? known : fallback;
}

/** Spellings of a job type the list does not use, for the word it does. */
const JOB_TYPE_ALIASES: Record<string, string> = {
  onsite: 'on_site',
  in_office: 'on_site',
  in_person: 'on_site',
  fully_remote: 'remote',
};

/** The longest off-list clearance word kept as itself. */
const CLEARANCE_WORD_LIMIT = 60;

/**
 * Whether a posting needs a clearance, as the filter judges it - failing
 * CLOSED, as the filter's own read did: a clearance word the list does not
 * have ("Top Secret/SCI", "DoD Secret", "required", `true`) is kept as itself
 * (cut to a sane length), which the filter's rule fails, never folded into
 * `not_specified`, which it passes. Only nothing at all - the key left out,
 * null, an empty string, `false` - is `none`, which is what the prompt asks
 * for when the posting does not mention one.
 */
export function normalizeClearance(value: unknown): string {
  if (value === undefined || value === null || value === false) return 'none';
  if (value === true) return 'required';
  const word = enumWord(typeof value === 'number' ? String(value) : value);
  if (!word) return typeof value === 'string' ? 'none' : 'required';
  if (word === 'top_secret_sci') return 'ts_sci';
  return (FILTER_FACT_VALUES.clearanceRequired as readonly string[]).includes(word)
    ? word
    : word.slice(0, CLEARANCE_WORD_LIMIT);
}

/**
 * A seniority as the analysis states it: one of `SENIORITY_VALUES` when it is
 * one (case forgiven), otherwise the text as given - an analysis stored before
 * the vocabulary was fixed said "Staff" or "unknown", and those still read.
 */
export function normalizeSeniority(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  const word = enumWord(text);
  return (SENIORITY_VALUES as readonly string[]).includes(word) ? word : text;
}

/** A two-letter US state code, upper case, or '' for anything else (null included). */
function usStateCode(value: unknown): string {
  if (typeof value !== 'string') return '';
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : '';
}

function pick(source: Record<string, unknown>, camel: string, snake: string): unknown {
  return source[camel] ?? source[snake];
}

export function emptyFilterFacts(): JobFilterFacts {
  return {
    jobType: 'not_specified',
    onsiteInterview: 'not_specified',
    companyCategory: 'other',
    clearanceRequired: 'not_specified',
    region: 'not_specified',
    usState: '',
  };
}

/** The filter facts out of the model's `filter` object, either spelling of each key. */
export function normalizeFilterFacts(raw: unknown): JobFilterFacts {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyFilterFacts();
  const source = raw as Record<string, unknown>;
  const jobType = oneOf(pick(source, 'jobType', 'job_type'), FILTER_FACT_VALUES.jobType, 'not_specified', JOB_TYPE_ALIASES);
  return {
    jobType,
    onsiteInterview: oneOf(
      pick(source, 'onsiteInterview', 'onsite_interview'),
      FILTER_FACT_VALUES.onsiteInterview,
      'not_specified'
    ),
    companyCategory: oneOf(
      pick(source, 'companyCategory', 'company_category'),
      FILTER_FACT_VALUES.companyCategory,
      'other'
    ),
    clearanceRequired: normalizeClearance(pick(source, 'clearanceRequired', 'clearance_required')),
    region: oneOf(source.region, FILTER_FACT_VALUES.region, 'not_specified'),
    // A remote job has no state, whatever office the posting also mentions.
    usState: jobType === 'remote' ? '' : usStateCode(pick(source, 'usState', 'us_state')),
  };
}

const PERIODS: Record<string, JobSalaryPeriod> = {
  annual: 'annual',
  annually: 'annual',
  yearly: 'annual',
  year: 'annual',
  yr: 'annual',
  per_year: 'annual',
  monthly: 'monthly',
  month: 'monthly',
  per_month: 'monthly',
  weekly: 'weekly',
  week: 'weekly',
  per_week: 'weekly',
  daily: 'daily',
  day: 'daily',
  per_day: 'daily',
  hourly: 'hourly',
  hour: 'hourly',
  hr: 'hourly',
  per_hour: 'hourly',
};

/**
 * A salary bound as the model wrote it: a non-negative number, or a plain
 * numeral in a string (`"120,000"`, `"230k"`). Anything else - a word, a
 * range in one string, a negative - is no bound at all: the rule is that a
 * salary is only what the posting states, and a guess at what a string meant
 * is not that.
 */
function salaryBound(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const compact = value.replace(/[\s,$]/g, '');
  const match = /^(\d+(?:\.\d+)?)(k)?$/i.exec(compact);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  return match[2] ? amount * 1000 : amount;
}

/**
 * What a posting states it pays, or null when it states nothing.
 *
 * Every part is optional and checked on its own: bounds are numbers, the
 * currency an ISO code (`USD`), the period one of five words, `raw` the
 * posting's own text cut to 200 characters. A lower bound above the upper is
 * the two written the wrong way round, and is swapped.
 */
export function normalizeSalary(raw: unknown): JobSalary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  let min = salaryBound(source.min);
  let max = salaryBound(source.max);
  if (min !== null && max !== null && min > max) [min, max] = [max, min];
  const currencyText = typeof source.currency === 'string' ? source.currency.trim().toUpperCase() : '';
  const currency = /^[A-Z]{3}$/.test(currencyText) ? currencyText : null;
  const period = PERIODS[enumWord(source.period)] ?? null;
  const rawText = typeof source.raw === 'string' ? source.raw.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  if (min === null && max === null && !rawText) return null;
  return { min, max, currency, period, raw: rawText || null };
}

const AMOUNT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/**
 * A salary as one line of text, for the sheet's Salary cell: the posting's own
 * words when it gave them, otherwise the bounds with their currency and
 * period. Empty when there is no salary.
 */
export function formatSalary(salary: JobSalary | null | undefined): string {
  if (!salary) return '';
  if (salary.raw) return salary.raw;
  const bounds = [salary.min, salary.max].filter((value): value is number => value !== null).map((value) => AMOUNT.format(value));
  if (bounds.length === 0) return '';
  const range = bounds.join(' - ');
  return [salary.currency, range].filter(Boolean).join(' ') + (salary.period ? ` / ${salary.period}` : '');
}

/* ---------------------------------------------- job type, clearance, industry -- */

/**
 * The three facts a lake row and an app sheet show beside a job's field and
 * salary (v6): Job Type, Clearance and Industry. Pure functions of a stored
 * analysis, so every place that shows them - the lake's columns and filters,
 * the admin sheet, the job sheet's cells - derives the same value from the
 * same analysis, and an analysis stored before they existed is never asked
 * for them again: what it lacks is derived here, when it is read.
 */

/** A job type as a lake row stores it: the filter's word, '' when the posting does not say. */
export type JobTypeId = 'remote' | 'hybrid' | 'on_site' | '';

/** What a page and a sheet call each job type. */
export const JOB_TYPE_LABELS: Readonly<Record<Exclude<JobTypeId, ''>, string>> = Object.freeze({
  remote: 'Remote',
  hybrid: 'Hybrid',
  on_site: 'Onsite',
});

/** The job types as a page offers them for a filter; `not_specified` stands for ''. */
export function listJobTypesForClient(): Array<{ id: string; label: string }> {
  return [
    ...Object.entries(JOB_TYPE_LABELS).map(([id, label]) => ({ id, label })),
    { id: 'not_specified', label: 'Not specified' },
  ];
}

export function jobTypeLabel(id: unknown): string {
  return typeof id === 'string' && id in JOB_TYPE_LABELS ? JOB_TYPE_LABELS[id as keyof typeof JOB_TYPE_LABELS] : '';
}

function filterOf(analysis: unknown): JobFilterFacts {
  const source = analysis && typeof analysis === 'object' && !Array.isArray(analysis) ? (analysis as Record<string, unknown>) : {};
  return normalizeFilterFacts(source.filter);
}

/** Remote, hybrid or on site, as the analysis read it off the posting; '' when it does not say. */
export function jobTypeOf(analysis: unknown): JobTypeId {
  const jobType = filterOf(analysis).jobType;
  return jobType === 'remote' || jobType === 'hybrid' || jobType === 'on_site' ? jobType : '';
}

/**
 * Whether the posting REQUIRES a clearance: false only when the analysis says
 * none, or does not say - true for every clearance it names, an off-list word
 * included (`normalizeClearance` keeps those, failing closed, as the Job
 * Filter does). An analysis with no filter facts at all says nothing: false.
 */
export function clearanceRequiredOf(analysis: unknown): boolean {
  const clearance = filterOf(analysis).clearanceRequired;
  return clearance !== 'none' && clearance !== 'not_specified';
}

/**
 * An industry as the analysis prompt's list spells it: an id or a label
 * (case, spacing and `&` forgiven), a known short form ("fintech", "SaaS",
 * a company category), or free text naming one by keyword. Nothing, or a word
 * meaning "not stated", is `not_specified`; any other word is `other` - never
 * itself, so a stored industry is always one of the list.
 */
export function normalizeIndustry(value: unknown): string {
  if (typeof value !== 'string') return NOT_SPECIFIED_INDUSTRY_ID;
  const word = foldIndustryWord(value);
  if (!word || NOT_SPECIFIED_WORDS.has(word)) return NOT_SPECIFIED_INDUSTRY_ID;
  if (isIndustryId(word)) return word;
  const byLabel = INDUSTRIES.find((entry) => foldIndustryWord(entry.label) === word);
  if (byLabel) return byLabel.id;
  return INDUSTRY_ALIASES[word] ?? industryFromText(value) ?? OTHER_INDUSTRY_ID;
}

/**
 * The company categories of the filter facts (FILTER_FACT_VALUES) as
 * industries. `other` is not here: it says only that none of the categories
 * fit, so the free text is read instead.
 */
export const COMPANY_CATEGORY_INDUSTRY: Readonly<Record<string, string>> = Object.freeze({
  healthcare: 'healthcare',
  fintech: 'finance',
  consulting: 'consulting',
  defense_military: 'military',
  saas: 'technology',
  ecommerce: 'retail_ecommerce',
  cybersecurity: 'technology',
  ai_ml: 'technology',
  edtech: 'education',
  govtech: 'government',
  insurtech: 'insurance',
  legaltech: 'legal',
  media_entertainment: 'media_entertainment',
  logistics: 'logistics_transportation',
  energy: 'energy_utilities',
  enterprise_software: 'technology',
});

/**
 * A stored analysis's industry, in this order:
 *
 *   1. its own `industry`, whenever the analysis has the key - one made since
 *      the prompt asked for it, whatever it answered;
 *   2. otherwise (an analysis from before) its filter facts' company category;
 *   3. otherwise keywords in its free-text `jobMeta.industry`;
 *   4. otherwise `not_specified`.
 *
 * Never a model call: an older analysis's industry is worked out from what it
 * already holds, every time it is read, and nothing is written back into it.
 */
export function industryOf(analysis: unknown): string {
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) return NOT_SPECIFIED_INDUSTRY_ID;
  const source = analysis as Record<string, unknown>;
  if (source.industry !== undefined) return normalizeIndustry(source.industry);
  const category = COMPANY_CATEGORY_INDUSTRY[filterOf(analysis).companyCategory];
  if (category) return category;
  const meta = source.jobMeta && typeof source.jobMeta === 'object' ? (source.jobMeta as Record<string, unknown>) : {};
  return industryFromText(meta.industry) ?? NOT_SPECIFIED_INDUSTRY_ID;
}

/** The three facts at once, as a lake row stores them. */
export type AnalysisFacts = { jobType: JobTypeId; clearance: boolean; industry: string };

export function analysisFactsOf(analysis: unknown): AnalysisFacts {
  return { jobType: jobTypeOf(analysis), clearance: clearanceRequiredOf(analysis), industry: industryOf(analysis) };
}
