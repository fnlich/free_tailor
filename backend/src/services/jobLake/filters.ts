import { isIndustryId } from '../../config/industries';
import { isJobFieldId } from '../../config/jobFields';
import {
  keywordWords,
  LAKE_KEYWORD_MAX_LENGTH,
  LAKE_KEYWORD_MAX_WORDS,
  type LakeFilters,
} from '../../database/jobLakeRepository';
import { PublicError } from '../../middleware/publicError';
import { listJobTypesForClient, type JobTypeId } from '../jobAnalysis/facts';

export { LAKE_KEYWORD_MAX_LENGTH, LAKE_KEYWORD_MAX_WORDS } from '../../database/jobLakeRepository';

/**
 * The lake's filters, read and checked ONE way for every route that searches
 * it: Admin -> Job Lake's list (GET /api/admin/job-lake, a query string) and
 * its Push to Google Sheet (POST /push, a JSON body), and Find Jobs (GET
 * /api/jobs/lake). So a push holds exactly the rows Search showed, and a value
 * one refuses, the others refuse in the same words.
 *
 * Six filters take SEVERAL values - Full text (`q`), Company, Job field,
 * Requested by, Job type and Industry - and a job matching ANY of a filter's
 * values passes it. Each takes one string, the same key repeated
 * (`?field=a&field=b`, which Express's query parser hands over as an array),
 * `field[]=a`, or a JSON array of strings. Each value is trimmed, an empty one
 * dropped, a repeat dropped; a comma is never split on here ("OpenAI, Inc." is
 * one company). The rest - the dates, the salary and Clearance - take one
 * value, and refuse a list. A list is judged value by value as it is read, so
 * the first value that cannot be taken is the one refused.
 *
 * Full text's keywords hold at most LAKE_KEYWORD_MAX_WORDS words in all, as
 * the index splits them: a search's work grows with its words, and before the
 * cap one search of ten keywords could hold the server for seconds. And no
 * keyword is longer than LAKE_KEYWORD_MAX_LENGTH characters.
 *
 * Requested by is an administrator's filter: anybody else naming it is
 * refused (403 `not-an-admin`) - Find Jobs never shows who reported a job.
 */

/** The most values the open-ended lists take in one search; the closed lists are bounded by their own. */
export const LAKE_FILTER_MAX_VALUES = Object.freeze({ company: 25, q: 10, requestedBy: 25 });

/** Every refusal of the reader, by name, for the pages that say them first. */
export const LAKE_FILTER_SENTENCES = Object.freeze({
  requestedByAdminOnly: 'Only an administrator can filter jobs by who requested them.',
  tooManyKeywords: `Search for at most ${LAKE_FILTER_MAX_VALUES.q} keywords at a time.`,
  tooManyWords: `Search for at most ${LAKE_KEYWORD_MAX_WORDS} words in all, across the keywords.`,
  keywordTooLong: `A keyword can be at most ${LAKE_KEYWORD_MAX_LENGTH} characters.`,
  tooManyCompanies: `Choose at most ${LAKE_FILTER_MAX_VALUES.company} companies.`,
  tooManyRequesters: `Choose at most ${LAKE_FILTER_MAX_VALUES.requestedBy} people under Requested by.`,
  notText: 'A filter value must be text.',
  field: 'That job field is not one of the list.',
  jobType: 'That job type is not one of the list.',
  industry: 'That industry is not one of the list.',
  clearance: 'Clearance must be true or false.',
  notFound: 'That job was not found in the lake.',
});

/** The single filters' names as the form labels them: what "<Label> takes one value." says. */
const SINGLE_LABELS = {
  updatedFrom: 'Updated from',
  updatedTo: 'Updated to',
  salaryMin: 'Salary from',
  salaryMax: 'Salary to',
  clearance: 'Clearance',
} as const;

type SingleFilter = keyof typeof SINGLE_LABELS;

const JOB_TYPE_FILTERS = new Set(listJobTypesForClient().map((option) => option.id));

function refuse(message: string): never {
  throw new PublicError(message, { status: 400 });
}

/**
 * What a list filter takes: at most `max` values (the open-ended lists,
 * refused past it in `tooMany`), or only the values `allowed` (the closed
 * ones, any other refused in `notAllowed`).
 */
type ListRule = { max: number; tooMany: string } | { allowed: (value: string) => boolean; notAllowed: string };

/**
 * A list filter's values: one string, or a list of strings - each trimmed,
 * empty ones and repeats dropped. A finite number or a boolean on its own (a
 * JSON body) reads as its text, as a single filter's does. A list holding
 * anything but text, or an object (`field[x]=a`), is refused.
 *
 * ONE pass, each value judged as it is read - repeats found in a Set, the
 * value past the cap or off the list refused right there - so a body of a
 * million values costs a look at each, never a comparison of every pair.
 */
function filterValues(raw: unknown, rule: ListRule): string[] {
  if (raw === undefined || raw === null) return [];
  const items: readonly unknown[] =
    typeof raw === 'string' || (typeof raw === 'number' && Number.isFinite(raw)) || typeof raw === 'boolean'
      ? [String(raw)]
      : Array.isArray(raw)
        ? raw
        : refuse(LAKE_FILTER_SENTENCES.notText);
  const values = new Set<string>();
  for (const item of items) {
    if (typeof item !== 'string') refuse(LAKE_FILTER_SENTENCES.notText);
    const value = item.trim();
    if (!value || values.has(value)) continue;
    if ('allowed' in rule && !rule.allowed(value)) refuse(rule.notAllowed);
    values.add(value);
    if ('max' in rule && values.size > rule.max) refuse(rule.tooMany);
  }
  return [...values];
}

/** Whether a list filter was named with anything in it - before its values are judged. */
function present(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'string') return raw.trim() !== '';
  if (Array.isArray(raw)) return raw.some((item) => typeof item !== 'string' || item.trim() !== '');
  return true;
}

/**
 * A single filter's value as text: a string trimmed, and - for a JSON body -
 * a finite number or a boolean as the text the query string would carry for
 * it. A list or an object is refused: one box, one value.
 */
function oneValue(source: Record<string, unknown>, name: SingleFilter): string {
  const value = source[name];
  if (typeof value === 'string') return value.trim();
  if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') return String(value);
  if (value !== undefined && value !== null && typeof value === 'object') refuse(`${SINGLE_LABELS[name]} takes one value.`);
  return '';
}

/** A filter's number, or undefined when absent; a 400 for anything else. */
function readNumber(value: string, label: string): number | undefined {
  if (value === '') return undefined;
  const number = /^\d+(\.\d+)?$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) refuse(`${label} must be a number.`);
  return number;
}

/** A date or a time; a bare date is the start of that day (UTC) for `from`, its end for `to`. */
function readTime(text: string, label: string, end: boolean): string | undefined {
  if (!text) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const at = Date.parse(dateOnly ? `${text}T${end ? '23:59:59.999' : '00:00:00.000'}Z` : text);
  if (!Number.isFinite(at)) refuse(`${label} must be a date, like 2026-10-05.`);
  return new Date(at).toISOString();
}

/**
 * The filters of a query string or a JSON body, checked in this order - each
 * filter as it is read: Full text (how many keywords, then how long each
 * is, then how many words in all), Company, Requested by (who may name it, then how many), Job field,
 * the salary range, the dates, Job type, Clearance, Industry.
 * `requestedBy: true` for an administrator's route.
 */
export function readLakeFilters(source: Record<string, unknown>, options: { requestedBy: boolean }): LakeFilters {
  const filters: LakeFilters = {};

  const keywords = filterValues(source.q, { max: LAKE_FILTER_MAX_VALUES.q, tooMany: LAKE_FILTER_SENTENCES.tooManyKeywords });
  if (keywords.some((keyword) => [...keyword].length > LAKE_KEYWORD_MAX_LENGTH)) {
    refuse(LAKE_FILTER_SENTENCES.keywordTooLong);
  }
  if (keywords.reduce((words, keyword) => words + keywordWords(keyword).length, 0) > LAKE_KEYWORD_MAX_WORDS) {
    refuse(LAKE_FILTER_SENTENCES.tooManyWords);
  }
  if (keywords.length > 0) filters.keywords = keywords;

  const companies = filterValues(source.company, {
    max: LAKE_FILTER_MAX_VALUES.company,
    tooMany: LAKE_FILTER_SENTENCES.tooManyCompanies,
  });
  if (companies.length > 0) filters.companies = companies;

  if (!options.requestedBy && present(source.requestedBy)) {
    throw new PublicError(LAKE_FILTER_SENTENCES.requestedByAdminOnly, { status: 403, code: 'not-an-admin' });
  }
  const requesters = filterValues(source.requestedBy, {
    max: LAKE_FILTER_MAX_VALUES.requestedBy,
    tooMany: LAKE_FILTER_SENTENCES.tooManyRequesters,
  });
  if (requesters.length > 0) filters.requestedBy = requesters;

  const fields = filterValues(source.field, {
    allowed: (field) => field === 'unclassified' || isJobFieldId(field),
    notAllowed: LAKE_FILTER_SENTENCES.field,
  });
  if (fields.length > 0) filters.jobFieldIds = fields;

  const salaryMin = readNumber(oneValue(source, 'salaryMin'), 'The lowest salary');
  const salaryMax = readNumber(oneValue(source, 'salaryMax'), 'The highest salary');
  if (salaryMin !== undefined) filters.salaryMin = salaryMin;
  if (salaryMax !== undefined) filters.salaryMax = salaryMax;
  const from = readTime(oneValue(source, 'updatedFrom'), 'Updated from', false);
  const to = readTime(oneValue(source, 'updatedTo'), 'Updated to', true);
  if (from) filters.updatedFrom = from;
  if (to) filters.updatedTo = to;

  // The three facts: job types (`not_specified` for a posting that does not
  // say), a clearance as true or false, industry ids (`not_specified` too).
  const jobTypes = filterValues(source.jobType, {
    allowed: (jobType) => JOB_TYPE_FILTERS.has(jobType),
    notAllowed: LAKE_FILTER_SENTENCES.jobType,
  });
  if (jobTypes.length > 0) {
    filters.jobTypes = [...new Set(jobTypes.map((jobType) => (jobType === 'not_specified' ? '' : jobType) as JobTypeId))];
  }
  const clearance = oneValue(source, 'clearance');
  if (clearance) {
    if (clearance !== 'true' && clearance !== 'false') refuse(LAKE_FILTER_SENTENCES.clearance);
    filters.clearance = clearance === 'true';
  }
  const industries = filterValues(source.industry, { allowed: isIndustryId, notAllowed: LAKE_FILTER_SENTENCES.industry });
  if (industries.length > 0) filters.industries = industries;

  return filters;
}

/** A lake row's number from a path - `/lake/42` - or 404, as a row that is not there. */
export function readLakeId(raw: unknown): number {
  const id = typeof raw === 'string' && /^\d{1,15}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new PublicError(LAKE_FILTER_SENTENCES.notFound, { status: 404 });
  }
  return id;
}
