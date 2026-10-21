import { jobLakeExportMaxRows } from '../../config/operational';
import { getLakeEntriesByIds, type LakeEntry, type LakeFacts } from '../../database/jobLakeRepository';
import { PublicError } from '../../middleware/publicError';
import type { UserAccount } from '../../types/account';
import type { JobSalary } from '../../types/template';
import { DEFAULT_TAB } from '../sheets/accountSheet';
import { appendJobRows, type JobExportRow } from '../sheets/jobExport';
import { lakeAnalysisCells } from './index';
import type { Requester } from './requesters';

/**
 * Find Jobs (/jobs): the Job Data Lake, for everybody who builds resumes.
 *
 * What a row carries is an explicit ALLOWLIST - never a spread of the lake's
 * own entry, which holds what a builder must not see: the reward a reporter
 * was paid and its rate, how often the job was seen, its hash and key, when
 * it reached the admin sheet. A user's row is the job and its facts and the
 * analysis it came from; an administrator's adds who reported it
 * (`requestedBy`, `requester`) and how it came in (`source`) - nobody else
 * learns which reporter found a job.
 *
 * Export into Sheet (`exportLakeJobs`) appends the jobs a person picked to
 * the All tab of their OWN job sheet, each with its six analysis cells, so a
 * build from those rows reads its analysis there and asks no model again.
 */

/** A lake job as Find Jobs lists it. */
export type FindJobsRow = {
  id: number;
  company: string;
  title: string;
  url: string;
  jobFieldId: string;
  jobFieldLabel: string;
  salary: JobSalary | null;
  updatedAt: string;
  /** The posting's stored analysis, which an order of the job builds on; null when the store has none on record. */
  analysisId: string | null;
} & LakeFacts & {
    /** An administrator's row only. */
    requestedBy?: string | null;
    requester?: Requester;
    source?: 'report' | 'merge';
  };

/** One job's details: its row and the posting's text. */
export type FindJobsDetail = FindJobsRow & { jobDescription: string };

/**
 * The row Find Jobs shows: the allowlist, plus who reported it when
 * `requesterOf` is given - an administrator's view.
 */
export function findJobsRow(entry: LakeEntry, requesterOf: ((id: string | null) => Requester) | null): FindJobsRow {
  const row: FindJobsRow = {
    id: entry.id,
    company: entry.company,
    title: entry.title,
    url: entry.url,
    jobFieldId: entry.jobFieldId,
    jobFieldLabel: entry.jobFieldLabel,
    salary: entry.salary,
    jobType: entry.jobType,
    jobTypeLabel: entry.jobTypeLabel,
    clearance: entry.clearance,
    industry: entry.industry,
    industryLabel: entry.industryLabel,
    updatedAt: entry.updatedAt,
    analysisId: entry.analysisId,
  };
  if (!requesterOf) return row;
  return { ...row, requestedBy: entry.requestedBy, requester: requesterOf(entry.requestedBy), source: entry.source };
}

/** The same, with the posting's text: what Details shows. */
export function findJobsDetail(entry: LakeEntry, requesterOf: ((id: string | null) => Requester) | null): FindJobsDetail {
  return { ...findJobsRow(entry, requesterOf), jobDescription: entry.jobDescription ?? '' };
}

/** What Export into Sheet did. */
export type LakeExportResult = {
  /** Rows written into All. */
  exported: number;
  /** Jobs left out as already in All: the same link, or the same company and title. */
  skippedDuplicates: number;
  /** Jobs asked for that are no longer in the lake. */
  missing: number;
  /** `All`. */
  tabName: string;
  /** A link that opens the tab. */
  tabUrl: string;
  /** The rows written, first to last (equal, and nothing written, when every job was there already). */
  startRow: number;
  endRow: number;
  /** The cap in effect (JOB_LAKE_EXPORT_MAX_ROWS). */
  maxRows: number;
};

/**
 * The lake ids an export names, each once: a list of whole numbers (or their
 * digits), refused when empty, when an item is not one, and when there are
 * more than `max` - never cut, so nobody's selection is quietly halved.
 *
 * Read in ONE pass, repeats found in a Set, and refused the moment a
 * `max + 1`-th different id turns up: the body may be megabytes of ids, and
 * comparing each with every one before it held the server for minutes.
 */
export function readLakeIds(input: unknown, max: number): number[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new PublicError('Choose the jobs to export.', { status: 400 });
  }
  const ids = new Set<number>();
  for (const item of input) {
    const id =
      typeof item === 'number' ? item : typeof item === 'string' && /^\d{1,15}$/.test(item.trim()) ? Number(item.trim()) : Number.NaN;
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new PublicError('Each job is named by its number in the lake.', { status: 400 });
    }
    ids.add(id);
    if (ids.size > max) {
      throw new PublicError(`Export at most ${max} jobs at a time.`, {
        status: 400,
        code: 'too-many-jobs',
        extra: { maxRows: max },
      });
    }
  }
  return [...ids];
}

/**
 * Export into Sheet: the lake jobs `idsInput` names, newest first, appended
 * to the All tab of `account`'s own job sheet (`appendJobRows` - no
 * spreadsheet or tab is read from the request), each with its analysis
 * cells. A job already in All is skipped, and one gone from the lake since
 * the page listed it is counted as `missing`.
 */
export async function exportLakeJobs(account: UserAccount, idsInput: unknown): Promise<LakeExportResult> {
  const maxRows = jobLakeExportMaxRows();
  const ids = readLakeIds(idsInput, maxRows);
  const entries = getLakeEntriesByIds(ids);
  if (entries.length === 0) {
    throw new PublicError('None of those jobs is in the lake any more.', { status: 404, code: 'jobs-not-found' });
  }
  const rows: JobExportRow[] = entries.map((entry) => {
    const analysis = lakeAnalysisCells(entry);
    return {
      company: entry.company,
      title: entry.title,
      link: entry.url,
      description: entry.jobDescription ?? '',
      ...(analysis ? { analysis } : {}),
    };
  });
  const result = await appendJobRows(account, DEFAULT_TAB, rows);
  console.log(
    `[lake] ${account.email} exported ${result.rowsWritten} of ${ids.length} selected job(s) into "${result.tabName}" of ` +
      `${result.spreadsheetId}${result.skippedDuplicates ? ` (${result.skippedDuplicates} there already)` : ''}.`
  );
  return {
    exported: result.rowsWritten,
    skippedDuplicates: result.skippedDuplicates,
    missing: ids.length - entries.length,
    tabName: result.tabName,
    tabUrl: result.tabUrl,
    startRow: result.startRow,
    endRow: result.endRow,
    maxRows,
  };
}
