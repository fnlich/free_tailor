/**
 * How a page holds and shows a posting's ONE job analysis.
 *
 * The server analyses a posting once, ever (services/jobAnalysis/gate.ts):
 * the first request that needs it pays for one model call, and every later one
 * - this page again, another resume, another model, an order, the Job Filter -
 * is answered from the store. A page that already holds the analysis still
 * should not ask again: it sends the stored `analysisId` instead, which costs
 * the server one indexed read rather than a lookup by text, and cannot be
 * refused for a description that changed by a space.
 *
 * Imports nothing at runtime (types only), so the backend suite loads it
 * (backend/test/frontendAnalysis.test.js) and runs the copies below against
 * the server's own functions.
 */

export type JobSalaryPeriod = 'annual' | 'monthly' | 'weekly' | 'daily' | 'hourly';

/** What a posting STATES it pays - never inferred; null when it states nothing. */
export type JobSalary = {
  min: number | null;
  max: number | null;
  /** ISO 4217, upper case (`USD`), or null when the posting names none. */
  currency: string | null;
  period: JobSalaryPeriod | null;
  /** The posting's own words for it. */
  raw: string | null;
};

/**
 * The facts the Job Filter judges a posting on: the answer of the analysis's
 * second call (the Job Facts (Filter) prompt), made with it once.
 */
export type JobFilterFacts = {
  jobType: string;
  onsiteInterview: string;
  companyCategory: string;
  clearanceRequired: string;
  region: string;
  usState: string;
  /**
   * One of the facts prompt's seniority words, or `not_specified`. Absent on
   * an analysis made before the facts call read it - the filter then judges
   * `jobMeta.seniority` instead (`seniorityOf`).
   */
  seniority?: string;
};

/** The parts of an analysis this module reads; the rest is the page's business. */
export type AnalysisFactsSource = {
  jobMeta?: { title?: string; seniority?: string } | null;
  /** The job field's label, which the server sends beside its id. */
  jobFieldLabel?: string;
  salary?: JobSalary | null;
  filter?: Partial<JobFilterFacts> | null;
};

/** One analysis held by a page, with the posting it is the analysis of. */
export type HeldAnalysis<T> = {
  /** `postingKey` of the description (and link) it was made for. */
  posting: string;
  analysisId: string;
  analysis: T;
};

/**
 * The text that identifies a posting to the page: the description with every
 * run of whitespace one space and the ends trimmed - the server's own
 * normalisation (`normalizeJobDescriptionText`), so a description the server
 * would call the same posting is the same one here - and its link, when there
 * is one.
 */
export function normalizePostingText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function postingKey(jobDescription: string, jobLink = ''): string {
  return `${normalizePostingText(jobDescription)}\n${jobLink.trim()}`;
}

/** Holds the analysis `/resume/analyze` answered for this description. */
export function holdAnalysis<T extends { analysisId: string }>(
  analysis: T,
  jobDescription: string,
  jobLink = ''
): HeldAnalysis<T> {
  return { posting: postingKey(jobDescription, jobLink), analysisId: analysis.analysisId, analysis };
}

/**
 * The held analysis when it is the one for the description on the page now,
 * else null - edited text is another posting, and is analysed (or found in the
 * store) as one. Changing the company, the role, the resume or the model
 * changes nothing here: the analysis reads the posting, and only the posting.
 */
export function heldAnalysisFor<T>(
  held: HeldAnalysis<T> | null | undefined,
  jobDescription: string,
  jobLink = ''
): HeldAnalysis<T> | null {
  if (!held || !held.analysisId) return null;
  return held.posting === postingKey(jobDescription, jobLink) ? held : null;
}

/**
 * Whether a failed request that named a held analysis means the page should
 * let go of it: a 400, which is what the server answers for an `analysisId`
 * it has no row for ("That job analysis was not found"). Letting go is cheap
 * whatever the 400 was about - the next press asks /resume/analyze, which
 * finds a stored posting by its text without asking a model.
 */
export function dropsHeldAnalysis(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 400;
}

const AMOUNT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/**
 * A salary as one line: the posting's own words when it gave them, otherwise
 * the bounds with their currency and period ("USD 120,000 - 140,000 /
 * annual"). Empty when there is none. A copy of the server's `formatSalary`
 * (services/jobAnalysis/facts.ts), which writes the same line into a sheet's
 * Salary column - the page and the sheet say the same thing.
 */
export function formatSalary(salary: JobSalary | null | undefined): string {
  if (!salary) return '';
  if (salary.raw) return salary.raw;
  const bounds = [salary.min, salary.max]
    .filter((value): value is number => typeof value === 'number')
    .map((value) => AMOUNT.format(value));
  if (bounds.length === 0) return '';
  const range = bounds.join(' - ');
  return [salary.currency, range].filter(Boolean).join(' ') + (salary.period ? ` / ${salary.period}` : '');
}

/**
 * The words the server shows a job type by (services/jobAnalysis/facts.ts
 * `JOB_TYPE_LABELS`, which backend/test/frontendAnalysis.test.js holds this
 * to); any other value, `not_specified` included, shows nothing.
 */
export const JOB_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  remote: 'Remote',
  hybrid: 'Hybrid',
  on_site: 'Onsite',
});

function filterOf(analysis: AnalysisFactsSource | null | undefined): Partial<JobFilterFacts> | null {
  const filter = analysis?.filter;
  return filter && typeof filter === 'object' && !Array.isArray(filter) ? filter : null;
}

/**
 * The seniority word the Job Filter judges (services/jobFilter.ts
 * `jobFilterAnalysisOf`): the facts call's, else - on an analysis made before
 * the facts call read one - the analysis's own `jobMeta.seniority`. '' when
 * neither says.
 */
export function seniorityOf(analysis: AnalysisFactsSource | null | undefined): string {
  const facts = filterOf(analysis)?.seniority;
  const word = facts ?? analysis?.jobMeta?.seniority ?? '';
  return typeof word === 'string' ? word.trim() : '';
}

/** A seniority word as a page shows it: "Senior", "VP"; '' for one that says nothing (`not_specified`, `unknown`). */
export function seniorityLabel(word: string): string {
  const text = word.trim();
  const key = text.toLowerCase().replace(/[\s-]+/g, '_');
  if (!text || key === 'not_specified' || key === 'unknown') return '';
  if (key === 'vp') return 'VP';
  const spaced = text.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Whether the posting requires a clearance, as the server decides it
 * (facts.ts `clearanceRequiredOf`): required for every clearance it names,
 * an off-list word included, and not for `none` or `not_specified`. Null
 * when the analysis has no facts to say it with.
 */
export function clearanceRequiredOf(analysis: AnalysisFactsSource | null | undefined): boolean | null {
  const filter = filterOf(analysis);
  if (!filter) return null;
  const clearance = typeof filter.clearanceRequired === 'string' ? filter.clearanceRequired.trim() : '';
  return clearance !== '' && clearance !== 'none' && clearance !== 'not_specified';
}

/**
 * What a page shows of an analysis: the posting's title, its job field's
 * label, its salary, its job type, its seniority and whether it needs a
 * clearance - each '' when the analysis does not say. "Unclassified" is a
 * label like any other: it says the posting fits no field.
 */
export function analysisFacts(analysis: AnalysisFactsSource | null | undefined): {
  title: string;
  jobField: string;
  salary: string;
  jobType: string;
  seniority: string;
  clearance: string;
} {
  if (!analysis) return { title: '', jobField: '', salary: '', jobType: '', seniority: '', clearance: '' };
  const title = typeof analysis.jobMeta?.title === 'string' ? analysis.jobMeta.title.trim() : '';
  const jobField = typeof analysis.jobFieldLabel === 'string' ? analysis.jobFieldLabel.trim() : '';
  const jobTypeId = filterOf(analysis)?.jobType;
  const jobType = typeof jobTypeId === 'string' && Object.prototype.hasOwnProperty.call(JOB_TYPE_LABELS, jobTypeId) ? JOB_TYPE_LABELS[jobTypeId] : '';
  const required = clearanceRequiredOf(analysis);
  return {
    title,
    jobField,
    salary: formatSalary(analysis.salary ?? null),
    jobType,
    seniority: seniorityLabel(seniorityOf(analysis)),
    clearance: required === null ? '' : required ? 'Clearance required' : 'No clearance',
  };
}
