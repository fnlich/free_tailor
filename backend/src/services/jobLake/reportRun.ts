import { randomUUID } from 'crypto';
import { readBalanceMilli } from '../../database/creditRepository';
import { PublicError, publicItemError } from '../../middleware/publicError';
import type { UserAccount } from '../../types/account';
import { getOrCreateAnalysis, loadAnalysis, type StoredJobAnalysis } from '../jobAnalysis/gate';
import { resolveAnalysesAtSubmit, writeBackFor, type SubmittedJob } from '../jobAnalysis/submit';
import { flushAnalysisWriteBacks } from '../sheets/analysisColumns';
import { ensureAccountSheet, resolveAddressableSheet } from '../sheets/accountSheet';
import { requestAdminLakeSync } from './adminSheet';
import { reportRefOf } from '../../database/jobLakeRepository';
import { lakeJobFromAnalysis, mergeIntoLake, type MergeOutcome } from './index';
import {
  inspectReportTab,
  LAKE_STATUS_TEXT,
  lakeStatusIsRowsOwn,
  lastRowInGrid,
  readReportRows,
  reportSheetsClient,
  rowHoldsAJob,
  writeLakeStatuses,
  type LakeStatusText,
  type LakeStatusWrite,
  type SheetReportRow,
} from './reportSheet';

/**
 * A reporter's run (Phase 7, `/report`): rows of their OWN job sheet added to
 * the Job Data Lake, in the background, with progress a page polls.
 *
 * For each row, in this order:
 *
 *  1. skipped outright when its Lake Status says it was reported already
 *     beside the Analysis cell of the posting in the row now
 *     (`lakeStatusIsRowsOwn`) - so a run over the same rows again pays
 *     nothing and analyses nothing, while a row whose posting was replaced
 *     under another posting's status is reported like any other;
 *  2. its analysis through the ONE gate, sheet first (Phase 6): the row's own
 *     protected Analysis cell, else the stored analysis of the posting, else
 *     ONE model call - an already analysed posting costs no AI call - and a
 *     new analysis written back into the row's analysis cells once;
 *  3. its lake identity - the row's company and the analysis's job field -
 *     and `mergeIntoLake` with the reward: added, replaced (counts as added)
 *     or duplicate, decided on the database alone and paid in the same
 *     transaction (J7, J10).
 *
 * Analyses run a few at a time; merges run strictly in row order, so the
 * earlier of two rows with the same job is the one added and the later the
 * one painted red. Once every row is through, the analysis write-backs are
 * flushed, then each row's Job Hash and Lake Status written and its
 * duplicates painted - one batched call each - and the admin sheet's sync is
 * started for whatever was added.
 *
 * Idempotent: a row whose status never reached the sheet (a crash, a failed
 * write) is read again next time, finds its analysis stored and its lake row
 * its own - reported from this very row (`already`, by the row's
 * `reportRefOf`): no AI call, no second reward, and it is marked Added. The
 * same posting on ANOTHER row, in this run or a later one, is a duplicate.
 *
 * Runs live in memory: one per account at a time, the last one kept an hour
 * after it ends so a reloaded page finds its summary. A restart loses a run
 * in progress - what it merged is in the database, and re-running the same
 * rows finishes the rest.
 */

/** No more rows than this in one run. */
export const MAX_REPORT_RUN_ROWS = 500;
/** Postings analysed at once: the seats have their own limits, this only keeps a long run moving. */
const ANALYSIS_CONCURRENCY = 3;
/** How long a finished run stays readable. */
const RUN_RETENTION_MS = 60 * 60 * 1000;

export type ReportRowStatus =
  | 'pending'
  | 'added'
  | 'replaced'
  | 'duplicate'
  | 'unclassified'
  | 'skipped'
  | 'failed'
  | 'already-reported';

export type ReportRowOutcome = {
  row: number;
  company: string;
  title: string;
  status: ReportRowStatus;
  /** What the run wrote into the row's Lake Status cell (null: nothing - pending, failed, or reported before). */
  lakeStatus: LakeStatusText | null;
  jobHash: string | null;
  lakeId: number | null;
  /** What this row paid, in thousandths of a dollar. */
  rewardMilli: number;
  /** Why a row was skipped or failed, in words for the reporter. */
  reason: string | null;
};

export type ReportRunSummary = {
  /** Jobs the lake accepted from this run: added plus replaced (a replacement counts as added). */
  added: number;
  /** Rows the run took to the lake: every row holding a job, less those whose Lake Status said reported. */
  total: number;
  duplicates: number;
  unclassified: number;
  replaced: number;
  skipped: number;
  failed: number;
  /**
   * Rows reported before: their Lake Status said so (not in `total`), or the
   * lake found the job already added by this account from this same row and
   * posting - a status that never reached the sheet, written now (in `total`).
   */
  alreadyReported: number;
  /** What the run paid, in thousandths of a dollar. */
  earnedMilli: number;
  /** The reporter's balance when the run ended. */
  balanceMilli: number;
  /** False when the Lake Status cells could not be written; the lake has the jobs regardless. */
  sheetUpdated: boolean;
};

export type ReportRunView = {
  id: string;
  state: 'running' | 'finished' | 'failed';
  spreadsheetId: string;
  tabName: string;
  fromRow: number;
  toRow: number;
  startedAt: string;
  finishedAt: string | null;
  progress: { total: number; done: number };
  rows: ReportRowOutcome[];
  summary: ReportRunSummary | null;
  /** Why the run stopped, in words for the reporter, when it failed. */
  error: string | null;
};

type ReportRun = ReportRunView & { accountId: string };

const runs = new Map<string, ReportRun>();
const latestByAccount = new Map<string, string>();

function view(run: ReportRun): ReportRunView {
  const { accountId: _account, ...rest } = run;
  return { ...rest, rows: rest.rows.map((row) => ({ ...row })), progress: { ...rest.progress } };
}

function forgetOldRuns(now: number): void {
  for (const [id, run] of runs) {
    if (run.state !== 'running' && run.finishedAt && now - Date.parse(run.finishedAt) > RUN_RETENTION_MS) {
      runs.delete(id);
      if (latestByAccount.get(run.accountId) === id) latestByAccount.delete(run.accountId);
    }
  }
}

/** A run of this account's, or null - another account's run is nobody else's business. */
export function getReportRun(accountId: string, runId: string): ReportRunView | null {
  const run = runs.get(runId);
  return run && run.accountId === accountId ? view(run) : null;
}

/** The account's latest run, running or kept after it ended, or null. */
export function currentReportRun(accountId: string): ReportRunView | null {
  forgetOldRuns(Date.now());
  const id = latestByAccount.get(accountId);
  const run = id ? runs.get(id) : undefined;
  return run ? view(run) : null;
}

/** The rows a run is asked for, checked: a tab, and From/To within a sheet's data and the cap. */
export function readRunRange(body: unknown): { tabName: string; fromRow: number; toRow: number } {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const tabName = typeof input.tabName === 'string' ? input.tabName.trim() : '';
  if (!tabName || tabName.length > 100) throw new PublicError('Choose the tab of your sheet to report from.', { status: 400 });
  const whole = (value: unknown) =>
    typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  const fromRow = whole(input.fromRow);
  const toRow = whole(input.toRow);
  if (!Number.isSafeInteger(fromRow) || !Number.isSafeInteger(toRow) || fromRow < 2 || toRow < fromRow) {
    throw new PublicError('Give the rows to report as From and To row numbers, from row 2 (row 1 is the header).', {
      status: 400,
    });
  }
  if (toRow - fromRow + 1 > MAX_REPORT_RUN_ROWS) {
    throw new PublicError(`Report at most ${MAX_REPORT_RUN_ROWS} rows at a time.`, { status: 400 });
  }
  return { tabName, fromRow, toRow };
}

/** The reporter's own spreadsheet - never one named by the request. */
export async function ownSpreadsheetId(account: UserAccount): Promise<string> {
  const state = await ensureAccountSheet(account);
  return resolveAddressableSheet(account, undefined, [], state);
}

/**
 * Starts a run over rows `fromRow`..`toRow` of `tabName` in the account's own
 * sheet and answers at once with its first view; the work goes on in the
 * background. Refused while the account has a run going.
 */
export async function startReportRun(
  account: UserAccount,
  range: { tabName: string; fromRow: number; toRow: number }
): Promise<ReportRunView> {
  const latest = currentReportRun(account.id);
  if (latest?.state === 'running') {
    throw new PublicError('A report run is already going for your sheet. Wait for it to finish first.', {
      status: 409,
      code: 'run-in-progress',
      extra: { runId: latest.id },
    });
  }
  const spreadsheetId = await ownSpreadsheetId(account);
  const run: ReportRun = {
    id: `rep_${randomUUID()}`,
    accountId: account.id,
    state: 'running',
    spreadsheetId,
    tabName: range.tabName,
    fromRow: range.fromRow,
    toRow: range.toRow,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    progress: { total: 0, done: 0 },
    rows: [],
    summary: null,
    error: null,
  };
  runs.set(run.id, run);
  latestByAccount.set(account.id, run.id);
  // The promise is kept for the tests (`waitForReportRun`); nothing else awaits it.
  inFlight.set(run.id, executeRun(run, account));
  return view(run);
}

const inFlight = new Map<string, Promise<void>>();

/** Resolves when the run has ended. For the tests. */
export async function waitForReportRun(runId: string): Promise<ReportRunView | null> {
  await inFlight.get(runId);
  const run = runs.get(runId);
  return run ? view(run) : null;
}

function outcomeRow(row: SheetReportRow, status: ReportRowStatus, reason: string | null = null): ReportRowOutcome {
  return {
    row: row.row,
    company: row.company,
    title: row.title,
    status,
    lakeStatus: null,
    jobHash: null,
    lakeId: null,
    rewardMilli: 0,
    reason,
  };
}

/** The reason a row with no analysis was skipped. */
function noAnalysisReason(row: SheetReportRow): string {
  return row.jobDescription.trim()
    ? 'The job description is too short to read a job field from.'
    : 'The row has no job description to read.';
}

async function executeRun(run: ReportRun, account: UserAccount): Promise<void> {
  try {
    await runRows(run, account);
    run.state = 'finished';
  } catch (error) {
    run.state = 'failed';
    run.error = publicItemError(error, 'The report run could not finish', `report run ${run.id}`);
  } finally {
    run.finishedAt = new Date().toISOString();
    inFlight.delete(run.id);
  }
}

async function runRows(run: ReportRun, account: UserAccount): Promise<void> {
  const sheets = reportSheetsClient();
  // Read once, writing nothing: a tab the person laid out for themselves is
  // refused before anything in it is touched.
  const tab = await inspectReportTab(run.spreadsheetId, run.tabName);
  if (!tab.jobTab) {
    throw new PublicError(
      `"${run.tabName}" is not laid out as a job sheet tab, so it cannot be reported from. Choose one of the dated tabs of your job sheet.`,
      { status: 409 }
    );
  }
  // Then verified, on that same read: the protection over the analysis
  // columns goes on (or is put back) before anything is read from them or
  // written into them, and an older build's twelve-column grid is grown so
  // K:P can be read at all.
  const verified = await sheets.verifyTab(run.spreadsheetId, run.tabName, tab.inspection);
  const toRow = lastRowInGrid(tab, run.toRow);

  const sheetRows =
    toRow < run.fromRow
      ? []
      : (await readReportRows(run.spreadsheetId, run.tabName, run.fromRow, toRow)).filter(rowHoldsAJob);
  const candidates: SheetReportRow[] = [];
  for (const row of sheetRows) {
    if (lakeStatusIsRowsOwn(row)) {
      run.rows.push({ ...outcomeRow(row, 'already-reported', `Reported before (${row.lakeStatus}).`), jobHash: row.jobHash || null });
    } else {
      candidates.push(row);
      run.rows.push(outcomeRow(row, 'pending'));
    }
  }
  run.rows.sort((a, b) => a.row - b.row);
  run.progress.total = candidates.length;

  // Sheet first, through Phase 6's submission step: one batched read of the
  // rows' protected analysis cells, a row whose cell (or whose posting in
  // the store) has an analysis is given it with no model call, and a row
  // waiting for one is marked to be written back once it has one.
  const jobs: SubmittedJob[] = candidates.map((row) => ({
    companyName: row.company,
    jobDescription: row.jobDescription,
    ...(row.link ? { jobLink: row.link } : {}),
    sourceRowNumber: row.row,
  }));
  await resolveAnalysesAtSubmit(jobs, {
    sheet: { spreadsheetId: run.spreadsheetId, tabName: run.tabName },
    requestedBy: account.id,
  });

  const analyses = analyseWithLimit(jobs, account.id);
  const statusWrites: LakeStatusWrite[] = [];
  const addedThisRun = new Set<number>();
  let earnedMilli = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const row = candidates[index];
    const outcome = run.rows.find((entry) => entry.row === row.row)!;
    const result = await analyses[index];
    if (result.error) {
      outcome.status = 'failed';
      outcome.reason = result.error;
    } else if (!result.stored) {
      outcome.status = 'skipped';
      outcome.reason = noAnalysisReason(row);
      outcome.lakeStatus = LAKE_STATUS_TEXT.skipped;
    } else {
      try {
        const merged = mergeIntoLake(
          lakeJobFromAnalysis(result.stored, 'report', {
            company: row.company,
            title: row.title,
            url: row.link,
            reportRef: reportRefOf(run.spreadsheetId, run.tabName, row.row),
          }),
          account.id,
          { reward: true }
        );
        applyMerge(outcome, merged, addedThisRun);
        earnedMilli += merged.rewardMilli;
      } catch (error) {
        // The merge and its reward are one transaction, so nothing of this
        // row moved: it keeps no status and the next run tries it again.
        outcome.status = 'failed';
        outcome.reason = publicItemError(error, 'The job could not be added to the lake', `report row ${row.row}`);
      }
    }
    if (outcome.lakeStatus) {
      statusWrites.push({
        row: row.row,
        company: row.company,
        link: row.link,
        jobHash: outcome.jobHash,
        status: outcome.lakeStatus,
        red: outcome.status === 'duplicate',
      });
    }
    run.progress.done += 1;
  }

  // The analysis cells first (their write leaves Job Hash and Lake Status
  // alone, but replacing another posting's cells empties them), then the
  // lake's two, so the lake's are the last word.
  let sheetUpdated = true;
  try {
    await flushAnalysisWriteBacks();
    await writeLakeStatuses(run.spreadsheetId, run.tabName, verified.gid, statusWrites);
  } catch (error) {
    sheetUpdated = false;
    console.warn(
      `[lake] Report run ${run.id}: the Lake Status cells of "${run.tabName}" could not be written; the jobs are in ` +
        'the lake regardless, and a run over the same rows marks them without paying again.',
      error
    );
  }

  const count = (status: ReportRowStatus) => run.rows.filter((row) => row.status === status).length;
  run.summary = {
    added: count('added') + count('replaced'),
    total: candidates.length,
    duplicates: count('duplicate'),
    unclassified: count('unclassified'),
    replaced: count('replaced'),
    skipped: count('skipped'),
    failed: count('failed'),
    alreadyReported: count('already-reported'),
    earnedMilli,
    balanceMilli: readBalanceMilli(account.id),
    sheetUpdated,
  };
  if (addedThisRun.size > 0) requestAdminLakeSync(`report run ${run.id}`);
}

/** A merge's outcome on the row's line, and the Lake Status it writes. */
function applyMerge(outcome: ReportRowOutcome, merged: MergeOutcome, addedThisRun: Set<number>): void {
  outcome.jobHash = merged.jobHash;
  outcome.lakeId = merged.lakeId;
  outcome.rewardMilli = merged.rewardMilli;
  switch (merged.status) {
    case 'added':
    case 'replaced':
      outcome.status = merged.status;
      outcome.lakeStatus = merged.status === 'added' ? LAKE_STATUS_TEXT.added : LAKE_STATUS_TEXT.replaced;
      if (merged.lakeId !== null) addedThisRun.add(merged.lakeId);
      return;
    case 'already':
      // This very row, reported by an earlier run whose status never reached
      // the sheet. Not counted as added again: this run added nothing and
      // paid nothing.
      outcome.status = 'already-reported';
      outcome.lakeStatus = LAKE_STATUS_TEXT.added;
      outcome.reason = 'Added by an earlier run of yours.';
      return;
    case 'duplicate':
      outcome.status = 'duplicate';
      outcome.lakeStatus = LAKE_STATUS_TEXT.duplicate;
      outcome.reason =
        merged.lakeId !== null && addedThisRun.has(merged.lakeId)
          ? 'The same job is on a row above.'
          : 'The job lake already has this job.';
      return;
    case 'unclassified':
      outcome.status = 'unclassified';
      outcome.lakeStatus = LAKE_STATUS_TEXT.unclassified;
      outcome.reason = 'The posting fits none of the job fields.';
      return;
    case 'no-company':
      outcome.status = 'skipped';
      outcome.lakeStatus = LAKE_STATUS_TEXT.skipped;
      outcome.reason = 'The row has no company name.';
      return;
  }
}

type AnalysisResult = { stored: StoredJobAnalysis | null; error?: string };

/**
 * Every job's analysis, at most `ANALYSIS_CONCURRENCY` at a time, each
 * through the gate. A job the submission step resolved reads it from the
 * store; one it did not is analysed once, and written back to its row the
 * way a queued build's first task writes it.
 */
function analyseWithLimit(jobs: SubmittedJob[], accountId: string): Array<Promise<AnalysisResult>> {
  let active = 0;
  const waiting: Array<() => void> = [];
  const slot = async () => {
    if (active >= ANALYSIS_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
  };
  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };

  return jobs.map(async (job): Promise<AnalysisResult> => {
    const named = job.analysisId ? loadAnalysis(job.analysisId) : null;
    if (named) return { stored: named };
    await slot();
    try {
      const stored = await getOrCreateAnalysis({
        jd: job.jobDescription,
        link: job.jobLink,
        requestedBy: accountId,
        company: job.companyName,
      });
      if (stored) {
        job.analysisId = stored.id;
        try {
          writeBackFor(job, stored);
        } catch (error) {
          console.warn('[lake] Could not queue the write-back of a reported row\'s analysis.', error);
        }
      }
      return { stored };
    } catch (error) {
      return {
        stored: null,
        error: publicItemError(error, 'The job could not be analysed', `report row ${job.sourceRowNumber}`),
      };
    } finally {
      release();
    }
  });
}

/** Tests share one process: every run is forgotten. */
export function resetReportRunsForTests(): void {
  runs.clear();
  latestByAccount.clear();
  inFlight.clear();
}
