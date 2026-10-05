/**
 * How a page holds and shows a posting's ONE job analysis.
 *
 * The server analyses a posting once, ever (services/jobAnalysis/gate.ts):
 * the first request that needs it pays for one model call, and every later one
 * - this page again, another profile, another model, an order, the Job Filter -
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

/** The facts the Job Filter judges a posting on, read by the same one analysis. */
export type JobFilterFacts = {
  jobType: string;
  onsiteInterview: string;
  companyCategory: string;
  clearanceRequired: string;
  region: string;
  usState: string;
};

/** The parts of an analysis this module reads; the rest is the page's business. */
export type AnalysisFactsSource = {
  jobMeta?: { title?: string } | null;
  /** The job field's label, which the server sends beside its id. */
  jobFieldLabel?: string;
  salary?: JobSalary | null;
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
 * store) as one. Changing the company, the role, the profile or the model
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
 * What a page shows of an analysis: the posting's title, its job field's
 * label and its salary - each '' when the analysis has none. "Unclassified"
 * is a label like any other: it says the posting fits no field.
 */
export function analysisFacts(analysis: AnalysisFactsSource | null | undefined): {
  title: string;
  jobField: string;
  salary: string;
} {
  if (!analysis) return { title: '', jobField: '', salary: '' };
  const title = typeof analysis.jobMeta?.title === 'string' ? analysis.jobMeta.title.trim() : '';
  const jobField = typeof analysis.jobFieldLabel === 'string' ? analysis.jobFieldLabel.trim() : '';
  return { title, jobField, salary: formatSalary(analysis.salary ?? null) };
}
