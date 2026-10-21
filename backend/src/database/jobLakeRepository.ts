import { industryLabel, isIndustryId, NOT_SPECIFIED_INDUSTRY_ID } from '../config/industries';
import { isJobFieldId, jobFieldLabel } from '../config/jobFields';
import { readStoredReportRateMilli } from '../config/reportRate';
import { jobTypeLabel, type JobTypeId } from '../services/jobAnalysis/facts';
import { lakeIdentity, normaliseCompany } from '../services/jobLake/identity';
import type { JobSalary, JobSalaryPeriod } from '../types/template';
import { formatMoney } from '../utils/money';
import { payJobReportReward, revokeJobReportReward, type JobRewardOutcome } from './creditRepository';
import { markJobAnalysisMerged } from './jobAnalysisRepository';
import { getDb } from './sqlite';

/**
 * The Job Data Lake's tables: `job_lake`, `job_lake_history` and the full-text
 * index over them (database/sqlite.ts). The ONE writer of all three.
 *
 * `mergeIntoLake` is the only way in, for the reporter run and the
 * administrator's merge alike, and the duplicate decision is made HERE, on
 * the database alone (owner decision J10): one seek on the UNIQUE `job_hash`
 * index inside an IMMEDIATE transaction - never a sheet, which is only ever
 * told the outcome afterwards. So two reporters adding the same job at the
 * same moment, in one process or two, get one `added` and one `duplicate`.
 *
 * It also keeps `job_reports`, the record of every posting each account
 * reported and what became of it the first time: written in that same
 * transaction, and read there first, so the same account reporting the same
 * posting again - from any row, any tab - is `already`, paid and counted once.
 *
 * Every amount is an integer count of thousandths of a dollar.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** What `mergeIntoLake` is handed: a job as reported, values as they were, plus the analysis it came from. */
export type LakeJob = {
  company: string;
  /** The analysis's job field id (`unclassified` included: such a job is never merged). */
  jobFieldId: string;
  title: string;
  salary: JobSalary | null;
  url: string;
  jobDescription: string;
  /** The stored analysis it came from, marked merged in the same transaction. */
  analysisId: string | null;
  /** `report` from the reporter run, `merge` from an administrator's merge. */
  source: 'report' | 'merge';
  /**
   * The analysis's job type, clearance and industry (services/jobAnalysis/
   * facts.ts `analysisFactsOf`), stored on the row for the lake's columns and
   * filters - never the caller's own.
   */
  jobType: JobTypeId;
  clearance: boolean;
  industry: string;
  /**
   * The sheet row a reporter's run read the job from, or null - a merge has
   * none. Kept on the report's record; it decides nothing: a posting this
   * account reported before is `already` from whichever row it is reported
   * again.
   */
  reportedFrom?: SheetRowRef | null;
};

export type SheetRowRef = { spreadsheetId: string; tabName: string; row: number };

/* ------------------------------------------------------- the report record -- */

/** What became of a posting the first time an account reported it. */
export type JobReportOutcome = 'added' | 'replaced' | 'duplicate' | 'unclassified';

/** The words a page and a sheet show for each, as "Reported before (Added)". */
export const JOB_REPORT_OUTCOME_LABELS: Readonly<Record<JobReportOutcome, string>> = Object.freeze({
  added: 'Added',
  replaced: 'Replaced',
  duplicate: 'Duplicate',
  unclassified: 'Unclassified',
});

const REPORT_OUTCOMES = new Set<string>(Object.keys(JOB_REPORT_OUTCOME_LABELS));

export type JobReport = {
  id: number;
  accountId: string;
  analysisId: string;
  outcome: JobReportOutcome;
  /** The lake row it reached; null when it reached none (unclassified). */
  lakeId: number | null;
  jobHash: string | null;
  /** What it paid, in thousandths of a dollar. */
  rewardMilli: number;
  /** Where it was first reported from, when that is known. */
  spreadsheetId: string | null;
  tabName: string | null;
  row: number | null;
  createdAt: string;
};

type JobReportRow = {
  id: number;
  account_id: string;
  analysis_id: string;
  outcome: string;
  lake_id: number | null;
  job_hash: string | null;
  reward_milli: number | null;
  spreadsheet_id: string | null;
  tab_name: string | null;
  row_number: number | null;
  created_at: string;
};

function toJobReport(row: JobReportRow): JobReport {
  return {
    id: row.id,
    accountId: row.account_id,
    analysisId: row.analysis_id,
    // A word this build does not know (a later build's) reads as the plainest outcome.
    outcome: REPORT_OUTCOMES.has(row.outcome) ? (row.outcome as JobReportOutcome) : 'added',
    lakeId: row.lake_id,
    jobHash: row.job_hash,
    rewardMilli: row.reward_milli ?? 0,
    spreadsheetId: row.spreadsheet_id,
    tabName: row.tab_name,
    row: row.row_number,
    createdAt: row.created_at,
  };
}

/**
 * How the merge is decided and paid, resolved by the caller
 * (services/jobLake/index.ts) from the settings:
 */
export type LakePolicy = {
  /** "Now", as epoch ms - the tests' fake clock. */
  now: number;
  /** The duplicate window in effect, in days (J2b). */
  windowDays: number;
  /**
   * Null: nobody is paid (the admin merge, J6). Otherwise the requester is
   * paid, if a reporter, their own rate else `globalRateMilli`, cut to what
   * `dailyCapMilli` leaves of today (UTC).
   */
  reward: { globalRateMilli: number; dailyCapMilli: number | null } | null;
};

export type MergeStatus =
  /** A new lake row. Paid, when rewarded. */
  | 'added'
  /** An older row (outside the window) replaced by this job: counts as ADDED. Paid, when rewarded. */
  | 'replaced'
  /** A row added or replaced within the window: seen_count bumped, nothing paid. Red in the sheet. */
  | 'duplicate'
  /**
   * The SAME report again: this account reported this very posting (the same
   * analysis) before - from this row or any other, this tab or another, a row
   * it has been moved to since - and `job_reports` says so. Nothing moves:
   * no seen_count, no reward, no record. `priorOutcome` is what became of it
   * the first time. Another account's report of the posting is a duplicate,
   * like any other report of the job.
   */
  | 'already'
  /** No job field from the list: never merged, never paid (J3). */
  | 'unclassified'
  /** No company left to compare once normalised: never merged, never paid (J2a). */
  | 'no-company';

export type MergeOutcome = {
  status: MergeStatus;
  lakeId: number | null;
  jobHash: string | null;
  /** The row's seen_count after this report. */
  seenCount: number;
  /** What this report paid, in thousandths: 0 unless added or replaced and rewarded. */
  rewardMilli: number;
  /** The rate the reward was worked out at, snapshotted; null when no reporter was paid. */
  rewardRateMilli: number | null;
  /** Why the reward is less than the rate, when it is. */
  rewardShort?: JobRewardOutcome['short'];
  /** The requester's balance after a reward, when one was attempted. */
  balanceMilli?: number;
  /** For `already`: what became of the posting the first time this account reported it. */
  priorOutcome?: JobReportOutcome;
};

/* --------------------------------------------------------------- rows -- */

type LakeRow = {
  id: number;
  job_hash: string;
  hash_version: number;
  company: string;
  company_key: string;
  job_field_id: string;
  title: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: string | null;
  salary_raw: string | null;
  job_url: string;
  job_description?: string;
  analysis_id: string | null;
  requested_by: string | null;
  source: string;
  created_at: string;
  updated_at: string;
  seen_count: number;
  last_seen_at: string | null;
  sheet_synced_at: string | null;
  reward_milli: number;
  reward_rate_milli: number | null;
  reward_revoked_milli: number;
  reward_revoked_at: string | null;
  job_type: string | null;
  clearance: number | null;
  industry: string | null;
};

type HistoryRow = Omit<LakeRow, 'company_key' | 'created_at' | 'updated_at' | 'last_seen_at' | 'sheet_synced_at'> & {
  lake_id: number;
  version_at: string;
  replaced_at: string;
};

/** A row's job type, clearance and industry, with the words a page shows for them. */
export type LakeFacts = {
  /** 'remote' | 'hybrid' | 'on_site', or '' when the posting does not say. */
  jobType: JobTypeId;
  /** Remote, Hybrid, Onsite, or ''. */
  jobTypeLabel: string;
  /** Whether the posting requires a clearance. */
  clearance: boolean;
  /** A config/industries.ts id, or `not_specified`. */
  industry: string;
  /** The industry's label; '' for `not_specified`. */
  industryLabel: string;
};

export type LakeReward = {
  milli: number;
  rateMilli: number | null;
  revokedMilli: number;
  revokedAt: string | null;
};

export type LakeEntry = {
  id: number;
  jobHash: string;
  hashVersion: number;
  company: string;
  companyKey: string;
  jobFieldId: string;
  jobFieldLabel: string;
  title: string;
  salary: JobSalary | null;
  url: string;
  /** Only on a single row's read: the list leaves the description out. */
  jobDescription?: string;
  analysisId: string | null;
  requestedBy: string | null;
  source: 'report' | 'merge';
  createdAt: string;
  updatedAt: string;
  seenCount: number;
  lastSeenAt: string | null;
  sheetSyncedAt: string | null;
  reward: LakeReward;
} & LakeFacts;

export type LakeHistoryEntry = {
  id: number;
  lakeId: number;
  jobHash: string;
  company: string;
  jobFieldId: string;
  jobFieldLabel: string;
  title: string;
  salary: JobSalary | null;
  url: string;
  jobDescription: string;
  analysisId: string | null;
  requestedBy: string | null;
  source: 'report' | 'merge';
  /** When this version was added (the row's updated_at then). */
  versionAt: string;
  seenCount: number;
  reward: LakeReward;
  replacedAt: string;
} & LakeFacts;

const SALARY_PERIODS = new Set(['annual', 'monthly', 'weekly', 'daily', 'hourly']);

function salaryOf(row: Pick<LakeRow, 'salary_min' | 'salary_max' | 'salary_currency' | 'salary_period' | 'salary_raw'>): JobSalary | null {
  if (row.salary_min === null && row.salary_max === null && !row.salary_raw) return null;
  return {
    min: row.salary_min,
    max: row.salary_max,
    currency: row.salary_currency,
    period: row.salary_period && SALARY_PERIODS.has(row.salary_period) ? (row.salary_period as JobSalaryPeriod) : null,
    raw: row.salary_raw,
  };
}

const JOB_TYPES = new Set(['remote', 'hybrid', 'on_site', '']);

/**
 * Every row is written with all three (`mergeIntoLake`), so a value that is
 * not one of them - a hand-edited row - reads as the posting saying nothing.
 */
function factsOf(row: Pick<LakeRow, 'job_type' | 'clearance' | 'industry'>): LakeFacts {
  const jobType = typeof row.job_type === 'string' && JOB_TYPES.has(row.job_type) ? (row.job_type as JobTypeId) : '';
  const industry = isIndustryId(row.industry) ? row.industry : NOT_SPECIFIED_INDUSTRY_ID;
  return {
    jobType,
    jobTypeLabel: jobTypeLabel(jobType),
    clearance: typeof row.clearance === 'number' && row.clearance !== 0,
    industry,
    industryLabel: industryLabel(industry),
  };
}

function rewardOf(row: Pick<LakeRow, 'reward_milli' | 'reward_rate_milli' | 'reward_revoked_milli' | 'reward_revoked_at'>): LakeReward {
  return {
    milli: row.reward_milli ?? 0,
    rateMilli: row.reward_rate_milli,
    revokedMilli: row.reward_revoked_milli ?? 0,
    revokedAt: row.reward_revoked_at,
  };
}

function toEntry(row: LakeRow): LakeEntry {
  return {
    id: row.id,
    jobHash: row.job_hash,
    hashVersion: row.hash_version,
    company: row.company,
    companyKey: row.company_key,
    jobFieldId: row.job_field_id,
    jobFieldLabel: jobFieldLabel(row.job_field_id),
    title: row.title,
    salary: salaryOf(row),
    url: row.job_url,
    ...(row.job_description !== undefined ? { jobDescription: row.job_description } : {}),
    analysisId: row.analysis_id,
    requestedBy: row.requested_by,
    source: row.source === 'merge' ? 'merge' : 'report',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    seenCount: row.seen_count,
    lastSeenAt: row.last_seen_at,
    sheetSyncedAt: row.sheet_synced_at,
    reward: rewardOf(row),
    ...factsOf(row),
  };
}

function toHistory(row: HistoryRow): LakeHistoryEntry {
  return {
    id: row.id,
    lakeId: row.lake_id,
    jobHash: row.job_hash,
    company: row.company,
    jobFieldId: row.job_field_id,
    jobFieldLabel: jobFieldLabel(row.job_field_id),
    title: row.title,
    salary: salaryOf(row),
    url: row.job_url,
    jobDescription: row.job_description ?? '',
    analysisId: row.analysis_id,
    requestedBy: row.requested_by,
    source: row.source === 'merge' ? 'merge' : 'report',
    versionAt: row.version_at,
    seenCount: row.seen_count,
    reward: rewardOf(row),
    replacedAt: row.replaced_at,
    ...factsOf(row),
  };
}

/** Every column but the description: what a list carries. */
const LIST_COLUMNS =
  'id, job_hash, hash_version, company, company_key, job_field_id, title, salary_min, salary_max, ' +
  'salary_currency, salary_period, salary_raw, job_url, analysis_id, requested_by, source, created_at, ' +
  'updated_at, seen_count, last_seen_at, sheet_synced_at, reward_milli, reward_rate_milli, ' +
  'reward_revoked_milli, reward_revoked_at, job_type, clearance, industry';

/* ------------------------------------------------- the pinned statements -- */
// Exported so test/jobLakeStore.test.js runs EXPLAIN QUERY PLAN on exactly
// these: a schema edit that turned one into a scan fails it.

/** The duplicate check: one seek on idx_job_lake_hash. */
export const FIND_BY_HASH_SQL = 'SELECT * FROM job_lake WHERE job_hash = ?';
/** The admin page's default view: newest first, read in idx_job_lake_updated's order. */
export const LIST_DEFAULT_SQL = `SELECT ${LIST_COLUMNS} FROM job_lake ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`;
/** The admin sheet's outbox, on the partial idx_job_lake_unsynced. */
export const UNSYNCED_SQL = `SELECT ${LIST_COLUMNS} FROM job_lake WHERE sheet_synced_at IS NULL ORDER BY id LIMIT ?`;
/** A row's earlier versions, on idx_job_lake_history_lake. */
export const HISTORY_SQL = 'SELECT * FROM job_lake_history WHERE lake_id = ? ORDER BY id DESC';
/** Whether an account reported a posting before: one seek on idx_job_reports_account_analysis. */
export const FIND_JOB_REPORT_SQL = 'SELECT * FROM job_reports WHERE account_id = ? AND analysis_id = ?';
/** The reports that reached a lake row, for its delete: on idx_job_reports_lake. */
export const DELETE_LAKE_REPORTS_SQL = 'DELETE FROM job_reports WHERE lake_id = ?';

/* ----------------------------------------------------------- the merge -- */

/** Midnight UTC of the day `at` falls on: where the daily cap starts counting. */
export function utcDayStart(at: number): string {
  const day = new Date(at);
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())).toISOString();
}

function salaryColumns(salary: JobSalary | null) {
  return {
    salary_min: salary?.min ?? null,
    salary_max: salary?.max ?? null,
    salary_currency: salary?.currency ?? null,
    salary_period: salary?.period ?? null,
    salary_raw: salary?.raw ?? null,
  };
}

/** One line, trimmed and bounded: what a lake row stores of a value somebody typed into a sheet. */
function line(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/**
 * Adds a job to the lake, or says why it did not - in ONE IMMEDIATE
 * transaction with the reward that pays for it and the record of the report:
 *
 *  - a REPORT (source `report`, an account and an analysis) of a posting this
 *    account reported before, as `job_reports` has it: `already`, with what
 *    became of it then (`priorOutcome`) - nothing moves, nothing is paid,
 *    from whichever row, tab or sheet it comes again;
 *  - no identity (unclassified, or no company): nothing is written to the
 *    lake;
 *  - no row with the job's hash: INSERTED -> `added`, paid;
 *  - a row added or last replaced within the window: `seen_count` and
 *    `last_seen_at` move -> `duplicate`, not paid;
 *  - an older row: its content goes to `job_lake_history`, the row takes the
 *    new job - `requested_by`, `updated_at`, the facts and the reward move,
 *    the outbox is opened again so the admin sheet gets a NEW line - ->
 *    `replaced`, which counts as added, paid.
 *
 * A report decided added, replaced, duplicate or unclassified is recorded in
 * `job_reports`, once per account and analysis; one with no company is not -
 * the reporter fills the company in and reports it again.
 *
 * The reward's ledger row is keyed `job-lake:<id>:<updated_at>`: a replaced
 * row pays again, the same version never twice. The analysis it came from is
 * marked merged in the same transaction, so the merge tab stops offering it.
 */
export function mergeIntoLake(job: LakeJob, requestedBy: string | null, policy: LakePolicy): MergeOutcome {
  const identity = lakeIdentity(job.company, job.jobFieldId);
  // Unclassified first: that is final, while a missing company is the
  // reporter's to fill in and report again.
  const unmerged: MergeStatus = isJobFieldId(job.jobFieldId) ? 'no-company' : 'unclassified';
  const nothing = (status: MergeStatus): MergeOutcome => ({
    status,
    lakeId: null,
    jobHash: null,
    seenCount: 0,
    rewardMilli: 0,
    rewardRateMilli: null,
  });
  const report =
    job.source === 'report' && requestedBy && job.analysisId ? { accountId: requestedBy, analysisId: job.analysisId } : null;
  if (!identity && !report) return nothing(unmerged);

  const db = getDb();
  const nowIso = new Date(policy.now).toISOString();
  const windowStartIso = new Date(policy.now - policy.windowDays * DAY_MS).toISOString();
  const from = job.reportedFrom ?? null;
  const values = identity
    ? {
        job_hash: identity.hash,
        hash_version: identity.hashVersion,
        company: line(job.company, 300),
        company_key: identity.companyKey,
        job_field_id: identity.jobFieldId,
        title: line(job.title, 300),
        ...salaryColumns(job.salary),
        job_url: line(job.url, 2000),
        job_description: typeof job.jobDescription === 'string' ? job.jobDescription : '',
        analysis_id: job.analysisId,
        requested_by: requestedBy,
        source: job.source,
        // The analysis's facts, never the caller's; a caller that has none
        // stores those of an analysis that says nothing.
        job_type: typeof job.jobType === 'string' && JOB_TYPES.has(job.jobType) ? job.jobType : '',
        clearance: job.clearance === true ? 1 : 0,
        industry: isIndustryId(job.industry) ? job.industry : NOT_SPECIFIED_INDUSTRY_ID,
      }
    : null;

  return db.transaction((): MergeOutcome => {
    if (report) {
      const prior = reportedBefore(report.accountId, report.analysisId);
      if (prior) {
        const seen =
          prior.lakeId === null
            ? undefined
            : (db.prepare('SELECT seen_count FROM job_lake WHERE id = ?').get(prior.lakeId) as { seen_count: number } | undefined);
        return {
          status: 'already',
          lakeId: prior.lakeId,
          jobHash: prior.jobHash,
          seenCount: seen?.seen_count ?? 0,
          rewardMilli: 0,
          rewardRateMilli: null,
          priorOutcome: prior.outcome,
        };
      }
    }
    const outcome = values ? decide(values) : nothing(unmerged);
    if (report && outcome.status !== 'no-company' && outcome.status !== 'already') {
      db.prepare(
        `INSERT OR IGNORE INTO job_reports
           (account_id, analysis_id, outcome, lake_id, job_hash, reward_milli, spreadsheet_id, tab_name, row_number, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        report.accountId,
        report.analysisId,
        outcome.status,
        outcome.lakeId,
        outcome.jobHash,
        outcome.rewardMilli,
        from?.spreadsheetId ?? null,
        from?.tabName ?? null,
        from?.row ?? null,
        nowIso
      );
    }
    return outcome;
  }).immediate();

  /** This account's earlier report of the posting, if any. Deleting a lake row deletes the reports that reached it. */
  function reportedBefore(accountId: string, analysisId: string): JobReport | null {
    const row = db.prepare(FIND_JOB_REPORT_SQL).get(accountId, analysisId) as JobReportRow | undefined;
    return row ? toJobReport(row) : null;
  }

  function decide(row: NonNullable<typeof values>): MergeOutcome {
    const existing = db.prepare(FIND_BY_HASH_SQL).get(row.job_hash) as LakeRow | undefined;
    const markMerged = () => {
      if (job.analysisId) markJobAnalysisMerged(job.analysisId, nowIso);
    };

    if (!existing) {
      const inserted = db
        .prepare(
          `INSERT INTO job_lake (
             job_hash, hash_version, company, company_key, job_field_id, title,
             salary_min, salary_max, salary_currency, salary_period, salary_raw,
             job_url, job_description, analysis_id, requested_by, source,
             job_type, clearance, industry,
             created_at, updated_at, seen_count, last_seen_at
           ) VALUES (
             @job_hash, @hash_version, @company, @company_key, @job_field_id, @title,
             @salary_min, @salary_max, @salary_currency, @salary_period, @salary_raw,
             @job_url, @job_description, @analysis_id, @requested_by, @source,
             @job_type, @clearance, @industry,
             @now, @now, 1, @now
           ) ON CONFLICT (job_hash) DO NOTHING`
        )
        .run({ ...row, now: nowIso });
      if (inserted.changes === 0) {
        // Unreachable under the IMMEDIATE lock, which no other writer can
        // hold between the read above and this insert; if it ever is
        // reached, the row that won is this job's and this report a duplicate.
        const winner = db.prepare(FIND_BY_HASH_SQL).get(row.job_hash) as LakeRow;
        return sawAgain(winner);
      }
      const lakeId = Number(inserted.lastInsertRowid);
      markMerged();
      return { status: 'added', lakeId, jobHash: row.job_hash, seenCount: 1, ...pay(lakeId, nowIso) };
    }

    if (existing.updated_at >= windowStartIso) {
      markMerged();
      return sawAgain(existing);
    }

    // Older than the window: this report is the job now.
    db.prepare(
      `INSERT INTO job_lake_history (
         lake_id, job_hash, hash_version, company, job_field_id, title,
         salary_min, salary_max, salary_currency, salary_period, salary_raw,
         job_url, job_description, analysis_id, requested_by, source, version_at, seen_count,
         reward_milli, reward_rate_milli, reward_revoked_milli, reward_revoked_at,
         job_type, clearance, industry, replaced_at
       )
       SELECT id, job_hash, hash_version, company, job_field_id, title,
              salary_min, salary_max, salary_currency, salary_period, salary_raw,
              job_url, job_description, analysis_id, requested_by, source, updated_at, seen_count,
              reward_milli, reward_rate_milli, reward_revoked_milli, reward_revoked_at,
              job_type, clearance, industry, @now
         FROM job_lake WHERE id = @id`
    ).run({ id: existing.id, now: nowIso });
    db.prepare(
      `UPDATE job_lake SET
         hash_version = @hash_version, company = @company, company_key = @company_key,
         job_field_id = @job_field_id, title = @title,
         salary_min = @salary_min, salary_max = @salary_max, salary_currency = @salary_currency,
         salary_period = @salary_period, salary_raw = @salary_raw,
         job_url = @job_url, job_description = @job_description, analysis_id = @analysis_id,
         requested_by = @requested_by, source = @source,
         job_type = @job_type, clearance = @clearance, industry = @industry,
         updated_at = @now, seen_count = 1, last_seen_at = @now, sheet_synced_at = NULL,
         reward_milli = 0, reward_rate_milli = NULL, reward_revoked_milli = 0, reward_revoked_at = NULL
       WHERE id = @id`
    ).run({ ...row, id: existing.id, now: nowIso });
    markMerged();
    return { status: 'replaced', lakeId: existing.id, jobHash: row.job_hash, seenCount: 1, ...pay(existing.id, nowIso) };

    function sawAgain(seen: LakeRow): MergeOutcome {
      db.prepare('UPDATE job_lake SET seen_count = seen_count + 1, last_seen_at = ? WHERE id = ?').run(nowIso, seen.id);
      return {
        status: 'duplicate',
        lakeId: seen.id,
        jobHash: row.job_hash,
        seenCount: seen.seen_count + 1,
        rewardMilli: 0,
        rewardRateMilli: null,
      };
    }

    /** The reward for the version just written, when this merge pays one - inside this transaction. */
    function pay(lakeId: number, versionAt: string): Pick<MergeOutcome, 'rewardMilli' | 'rewardRateMilli' | 'rewardShort' | 'balanceMilli'> {
      if (!policy.reward || !requestedBy) return { rewardMilli: 0, rewardRateMilli: null };
      const own = db.prepare('SELECT report_rate_milli FROM users WHERE id = ?').get(requestedBy) as
        | { report_rate_milli: unknown }
        | undefined;
      const rateMilli = readStoredReportRateMilli(own?.report_rate_milli) ?? policy.reward.globalRateMilli;
      const outcome = payJobReportReward({
        userId: requestedBy,
        rateMilli,
        dailyCapMilli: policy.reward.dailyCapMilli,
        dayStartIso: utcDayStart(policy.now),
        at: versionAt,
        idempotencyKey: `job-lake:${lakeId}:${versionAt}`,
        refId: String(lakeId),
        note: `${row.company} - ${jobFieldLabel(row.job_field_id)} (job #${lakeId}, ${formatMoney(rateMilli)} per job)`,
      });
      if (outcome.short === 'not-a-reporter') {
        return { rewardMilli: 0, rewardRateMilli: null, rewardShort: outcome.short };
      }
      db.prepare('UPDATE job_lake SET reward_milli = ?, reward_rate_milli = ? WHERE id = ?').run(
        outcome.paidMilli,
        rateMilli,
        lakeId
      );
      return {
        rewardMilli: outcome.paidMilli,
        rewardRateMilli: rateMilli,
        ...(outcome.short ? { rewardShort: outcome.short } : {}),
        balanceMilli: outcome.balance,
      };
    }
  }
}

/** `findJobReports`' read of `count` postings: seeks on idx_job_reports_account_analysis. */
export function findJobReportsSql(count: number): string {
  return `SELECT * FROM job_reports WHERE account_id = ? AND analysis_id IN (${Array.from({ length: count }, () => '?').join(', ')})`;
}

/**
 * The reports an account made of these postings (by analysis id), one each.
 * Store only: what the reporter run skips as reported before, and what Report
 * Jobs' preview says of a row.
 */
export function findJobReports(accountId: string, analysisIds: readonly string[]): Map<string, JobReport> {
  const found = new Map<string, JobReport>();
  const ids = [...new Set(analysisIds.filter((id) => typeof id === 'string' && id))];
  if (!accountId || ids.length === 0) return found;
  const db = getDb();
  for (let start = 0; start < ids.length; start += 500) {
    const chunk = ids.slice(start, start + 500);
    const rows = db.prepare(findJobReportsSql(chunk.length)).all(accountId, ...chunk) as JobReportRow[];
    for (const row of rows) found.set(row.analysis_id, toJobReport(row));
  }
  return found;
}

/* ------------------------------------------------------------- reading -- */

export function getLakeEntry(id: number): LakeEntry | null {
  const row = getDb().prepare('SELECT * FROM job_lake WHERE id = ?').get(id) as LakeRow | undefined;
  return row ? toEntry(row) : null;
}

export function findLakeEntryByHash(hash: string): LakeEntry | null {
  const row = getDb().prepare(FIND_BY_HASH_SQL).get(hash) as LakeRow | undefined;
  return row ? toEntry(row) : null;
}

export function listLakeHistory(lakeId: number): LakeHistoryEntry[] {
  return (getDb().prepare(HISTORY_SQL).all(lakeId) as HistoryRow[]).map(toHistory);
}

/* ------------------------------------------------------ the lake's search -- */

/**
 * What the lake is searched by: Admin -> Job Lake's Search and its Push to
 * Google Sheet, and Find Jobs - read the one way for all three by
 * services/jobLake/filters.ts. The six list filters take several values each,
 * and a job matching ANY value of a filter passes it; every filter given must
 * pass. An empty list is no filter.
 */
export type LakeFilters = {
  /**
   * Full text over company, title and description (FTS5): a job matching ANY
   * keyword is a hit, and a keyword of several words needs every one of them,
   * each a prefix - one of one or two characters a whole word (`ftsQuery`).
   */
  keywords?: readonly string[];
  /** Companies as typed: compared after normalising, exactly as the hash compares them. */
  companies?: readonly string[];
  /** Job field ids (`unclassified` is accepted, and no lake row has it). */
  jobFieldIds?: readonly string[];
  /** Account ids: who reported each job (or whose build produced it, for a merge). */
  requestedBy?: readonly string[];
  /** Job types as stored: 'remote', 'hybrid', 'on_site', or '' for "the posting does not say". */
  jobTypes?: readonly JobTypeId[];
  /** config/industries.ts ids, `not_specified` included. */
  industries?: readonly string[];
  /** A salary range: rows whose stated range reaches it. Rows stating no salary are left out. */
  salaryMin?: number;
  salaryMax?: number;
  /** ISO times, inclusive. */
  updatedFrom?: string;
  updatedTo?: string;
  /** Whether the posting requires a clearance. */
  clearance?: boolean;
};

/** A page of a search. */
export type LakeQuery = LakeFilters & { limit: number; offset: number };

/**
 * The most words a search's keywords hold in all - every Full text chip
 * together. Each word is a term FTS5 looks up, and the work of a match grows
 * with them: ten keywords of twelve one-letter words held the server for
 * seconds on a lake of 20,000 jobs. The reader refuses a search past it
 * (services/jobLake/filters.ts); `ftsQuery` never asks for more, whoever
 * calls it.
 */
export const LAKE_KEYWORD_MAX_WORDS = 25;

/**
 * A word shorter than this is matched whole, never as the start of a longer
 * one: `"go"` finds Go where `"go"*` also found Google and good - and a short
 * prefix is the costly term, read across every word of the index that starts
 * so (one hundred and twenty one-letter prefixes took seconds; as whole words,
 * milliseconds).
 */
const LAKE_PREFIX_MIN_LENGTH = 3;

/**
 * The most characters (code points) one keyword holds. The reader refuses a
 * longer one, so a drift between KEYWORD_SEPARATORS and the tokenizer - a
 * later Unicode or SQLite - can never turn one keyword into hundreds of index
 * terms.
 */
export const LAKE_KEYWORD_MAX_LENGTH = 100;

/**
 * Where the index's tokenizer (`unicode61 remove_diacritics 2`) splits text:
 * anything not a letter or a digit, and the 21 code points JavaScript calls
 * letters that SQLite's table still calls marks - the New Tai Lue signs
 * U+19B0-U+19C0 and U+19C8-U+19C9, and the Vedic signs U+1CF2-U+1CF3. Kept
 * inside a word, `a<U+19B0>c` counted as one word and reached FTS5 as a
 * one-letter prefix. jobLakeStore.test.js sweeps every letter and digit
 * through the real tokenizer to hold this to it.
 */
const KEYWORD_SEPARATORS = /(?:[^\p{L}\p{N}]|[ᦰ-ᧀᧈᧉᳲᳳ])+/u;

/**
 * A keyword's words, split where the index's tokenizer splits
 * (KEYWORD_SEPARATORS - so `node.js` is `node` and `js`, as it was indexed),
 * after NFKC: what `ftsQuery` looks for, and what LAKE_KEYWORD_MAX_WORDS
 * counts.
 */
export function keywordWords(keyword: string): string[] {
  return typeof keyword === 'string' ? keyword.normalize('NFKC').split(KEYWORD_SEPARATORS).filter(Boolean) : [];
}

/**
 * Keywords as an FTS5 query that cannot be a syntax error. Each keyword's
 * words (`keywordWords`) are quoted - a word of three characters or more made
 * a prefix, a shorter one matched whole - and ALL required; several keywords
 * are ORed - `("machine"* "learn"*) OR ("rust"*)` - FTS5's implicit AND
 * binding tighter than OR, and a quoted `"NOT"*` being a word, never an
 * operator. The same keyword twice, case aside, is asked once. At most
 * LAKE_KEYWORD_MAX_WORDS words in all: the rest are not asked. Null when
 * there is no word to look for.
 */
export function ftsQuery(keywords: readonly string[]): string | null {
  const groups: string[] = [];
  const seen = new Set<string>();
  let room = LAKE_KEYWORD_MAX_WORDS;
  for (const keyword of keywords) {
    const words = keywordWords(keyword).slice(0, room);
    if (words.length === 0) continue;
    const group = words.map((word) => ([...word].length < LAKE_PREFIX_MIN_LENGTH ? `"${word}"` : `"${word}"*`)).join(' ');
    if (seen.has(group.toLowerCase())) continue;
    seen.add(group.toLowerCase());
    groups.push(group);
    room -= words.length;
    if (room <= 0) break;
  }
  if (groups.length === 0) return null;
  return groups.length === 1 ? groups[0] : groups.map((group) => `(${group})`).join(' OR ');
}

/**
 * The most values of one column a read takes as merge arms. The companies are
 * capped at 25 by the reader, so they always drive; more job fields than this
 * ride along on the walk of idx_job_lake_updated instead.
 */
export const LAKE_MERGE_MAX_ARMS = 25;

/** One statement and its values, in order. */
export type LakeRead = { sql: string; params: unknown[] };

type Clause = { sql: string; params: unknown[] };

/** `column = ?` for one value, `column IN (?, ...)` for several. */
function oneOf(column: string, values: readonly unknown[]): Clause {
  return values.length === 1
    ? { sql: `${column} = ?`, params: [values[0]] }
    : { sql: `${column} IN (${values.map(() => '?').join(', ')})`, params: [...values] };
}

function distinct<T>(values: readonly T[] | undefined): T[] {
  return [...new Set(values ?? [])];
}

/** The keyword hits, matched once, for every arm of a read to test membership in. */
const LAKE_HITS_CTE = 'WITH lake_hits(id) AS MATERIALIZED (SELECT rowid FROM job_lake_fts WHERE job_lake_fts MATCH ?)';

/**
 * The two statements a search runs - a page of rows, newest first, and how
 * many match - built so the lake is never sorted whole. Exported so
 * test/jobLakeStore.test.js runs EXPLAIN QUERY PLAN on exactly these. Null
 * when the filters match nothing without asking: companies asked for, none of
 * which normalises to anything.
 *
 *  - No filter: exactly LIST_DEFAULT_SQL (PUSH_DEFAULT_SQL `withDescription`),
 *    read off idx_job_lake_updated in its order.
 *  - A DRIVER: the companies when there are any, else 1 to
 *    LAKE_MERGE_MAX_ARMS job fields. One value is a seek on its
 *    `(column, updated_at)` index, read in order; several are one SELECT per
 *    value joined by UNION ALL and ordered as a whole, which SQLite runs as a
 *    `MERGE (UNION ALL)` of those ordered seeks - never a TEMP B-TREE. The
 *    other indexed filters ride inside each arm as `+job_field_id` and
 *    `+requested_by`, so neither can pull an arm off its driving index.
 *  - No driver (no company, and no field or more than 25): the read walks
 *    idx_job_lake_updated in order, the fields as `+job_field_id IN (...)` -
 *    unless Requested by narrows it, which seeks idx_job_lake_requested_by and
 *    sorts the named people's rows alone, as one person always did.
 *  - The job type, clearance and industry have no index: tested on each row
 *    the read reaches, in its order.
 *  - Keywords are a MATERIALIZED CTE - the FTS5 match, once - tested on each
 *    row as `+id IN (...)`: a membership test, so a common keyword never turns
 *    the read into a sort of every one of its hits.
 *  - The count is one plain statement, the driver as `=` or `IN` and the
 *    keywords as a plain `id IN (...)`: it has no ORDER BY, so any seek does.
 *
 * Values in order: the keyword match, each arm's own, then the page.
 */
export function lakeReadSql(
  filters: LakeFilters,
  page: { limit: number; offset?: number; withDescription?: boolean }
): { rows: LakeRead; count: LakeRead } | null {
  const offset = page.offset ?? 0;
  const asked = (filters.companies ?? []).filter((company) => typeof company === 'string' && company.trim() !== '');
  const companyKeys = distinct(asked.map((company) => normaliseCompany(company)).filter(Boolean));
  // "OpenAI, Inc." alone finds Open AI LLC; "!!!" alone finds nothing, rather than everything.
  if (asked.length > 0 && companyKeys.length === 0) return null;
  const fields = distinct(filters.jobFieldIds);
  const requesters = distinct(filters.requestedBy);
  const jobTypes = distinct(filters.jobTypes);
  const industries = distinct(filters.industries);
  const match = filters.keywords ? ftsQuery(filters.keywords) : null;

  const driver =
    companyKeys.length > 0
      ? { column: 'company_key', values: companyKeys }
      : fields.length > 0 && fields.length <= LAKE_MERGE_MAX_ARMS
        ? { column: 'job_field_id', values: fields }
        : null;

  // What every arm tests besides its driver - and the same for the count, every column plain there.
  const arm: Clause[] = [];
  const counted: Clause[] = [];
  const both = (clause: Clause) => {
    arm.push(clause);
    counted.push(clause);
  };
  if (fields.length > 0 && driver?.column !== 'job_field_id') {
    arm.push(oneOf('+job_field_id', fields));
    counted.push(oneOf('job_field_id', fields));
  }
  if (requesters.length > 0) {
    arm.push(oneOf(driver ? '+requested_by' : 'requested_by', requesters));
    counted.push(oneOf('requested_by', requesters));
  }
  if (filters.updatedFrom) both({ sql: 'updated_at >= ?', params: [filters.updatedFrom] });
  if (filters.updatedTo) both({ sql: 'updated_at <= ?', params: [filters.updatedTo] });
  if (filters.salaryMin !== undefined) both({ sql: 'COALESCE(salary_max, salary_min) >= ?', params: [filters.salaryMin] });
  if (filters.salaryMax !== undefined) both({ sql: 'COALESCE(salary_min, salary_max) <= ?', params: [filters.salaryMax] });
  if (jobTypes.length > 0) both(oneOf('job_type', jobTypes));
  if (filters.clearance !== undefined) both({ sql: 'clearance = ?', params: [filters.clearance ? 1 : 0] });
  if (industries.length > 0) both(oneOf('industry', industries));
  if (match) {
    arm.push({ sql: '+id IN (SELECT id FROM lake_hits)', params: [] });
    counted.push({ sql: 'id IN (SELECT rowid FROM job_lake_fts WHERE job_lake_fts MATCH ?)', params: [match] });
  }

  if (!driver && arm.length === 0) {
    return {
      rows: page.withDescription
        ? offset > 0
          ? { sql: `${PUSH_DEFAULT_SQL} OFFSET ?`, params: [page.limit, offset] }
          : { sql: PUSH_DEFAULT_SQL, params: [page.limit] }
        : { sql: LIST_DEFAULT_SQL, params: [page.limit, offset] },
      count: { sql: 'SELECT COUNT(*) AS total FROM job_lake', params: [] },
    };
  }

  const columns = page.withDescription ? `${LIST_COLUMNS}, job_description` : LIST_COLUMNS;
  const where = (clauses: Clause[]) => clauses.map((clause) => clause.sql).join(' AND ');
  const values = (clauses: Clause[]) => clauses.flatMap((clause) => clause.params);
  const arms = driver ? driver.values.map((value) => [{ sql: `${driver.column} = ?`, params: [value] }, ...arm]) : [arm];
  const rows: LakeRead = {
    sql:
      `${match ? `${LAKE_HITS_CTE} ` : ''}` +
      arms.map((clauses) => `SELECT ${columns} FROM job_lake WHERE ${where(clauses)}`).join(' UNION ALL ') +
      ' ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?',
    params: [...(match ? [match] : []), ...arms.flatMap(values), page.limit, offset],
  };
  const total = [...(driver ? [oneOf(driver.column, driver.values)] : []), ...counted];
  return { rows, count: { sql: `SELECT COUNT(*) AS total FROM job_lake WHERE ${where(total)}`, params: values(total) } };
}

/**
 * A page of the lake, newest first, and how many rows match - on the
 * statements `lakeReadSql` builds.
 */
export function queryLake(query: LakeQuery): { rows: LakeEntry[]; total: number } {
  const read = lakeReadSql(query, { limit: query.limit, offset: query.offset });
  if (!read) return { rows: [], total: 0 };
  const db = getDb();
  const rows = db.prepare(read.rows.sql).all(...read.rows.params) as LakeRow[];
  const total = (db.prepare(read.count.sql).get(...read.count.params) as { total: number }).total;
  return { rows: rows.map(toEntry), total };
}

/**
 * Push to Google Sheet's read with no filter: newest first, read off
 * idx_job_lake_updated in its order like the page's default view, one row
 * past the cap so the push can tell the cap was reached. Every column, the
 * description included - the push writes it. Exported for the plan test.
 */
export const PUSH_DEFAULT_SQL = `SELECT ${LIST_COLUMNS}, job_description FROM job_lake ORDER BY updated_at DESC, id DESC LIMIT ?`;

export type LakePushRows = {
  /** At most `cap` rows, newest first (`updated_at`, then id), each with its description. */
  rows: LakeEntry[];
  /** Every row the filters match, the cap or not. */
  matched: number;
  /** True when more rows matched than `cap`: `rows` holds the newest `cap` of them. */
  capped: boolean;
};

/**
 * The rows Push to Google Sheet writes: the same filters as the admin page's
 * list (`lakeReadSql`, so a push holds exactly what Search showed), newest
 * first, at most `cap`. Read as `cap + 1` - the extra row only says the cap
 * was reached - with the count in the same read transaction, so the two agree.
 */
export function listLakeForPush(filters: LakeFilters, cap: number): LakePushRows {
  // A whole count from the caller (the operational setting); anything else reads as one row.
  const limit = Number.isSafeInteger(cap) && cap > 0 ? cap : 1;
  const read = lakeReadSql(filters, { limit: limit + 1, withDescription: true });
  if (!read) return { rows: [], matched: 0, capped: false };
  const db = getDb();
  return db.transaction((): LakePushRows => {
    const rows = db.prepare(read.rows.sql).all(...read.rows.params) as LakeRow[];
    const matched = (db.prepare(read.count.sql).get(...read.count.params) as { total: number }).total;
    return { rows: rows.slice(0, limit).map(toEntry), matched, capped: rows.length > limit };
  })();
}

/**
 * Find Jobs' read of the jobs a person picked (Export into Sheet): every
 * column, the description included, newest first - a rowid seek per id, the
 * sort over those rows alone, which the export's cap bounds. Exported for the
 * plan test.
 */
export function lakeEntriesByIdsSql(count: number): string {
  return (
    `SELECT ${LIST_COLUMNS}, job_description FROM job_lake WHERE id IN (${Array.from({ length: count }, () => '?').join(', ')}) ` +
    'ORDER BY updated_at DESC, id DESC'
  );
}

/** The lake rows these ids name, newest first, each with its description; an id no row has is left out. */
export function getLakeEntriesByIds(ids: readonly number[]): LakeEntry[] {
  const wanted = distinct(ids.filter((id) => Number.isSafeInteger(id) && id > 0));
  if (wanted.length === 0) return [];
  const db = getDb();
  const rows: LakeRow[] = [];
  for (let start = 0; start < wanted.length; start += 500) {
    const chunk = wanted.slice(start, start + 500);
    rows.push(...(db.prepare(lakeEntriesByIdsSql(chunk.length)).all(...chunk) as LakeRow[]));
  }
  // Several reads are each in order; the whole is put in it too.
  if (wanted.length > 500) {
    rows.sort((a, b) => (a.updated_at === b.updated_at ? b.id - a.id : a.updated_at < b.updated_at ? 1 : -1));
  }
  return rows.map(toEntry);
}

/**
 * The companies whose key starts with a typed prefix, for Find Jobs' Company
 * box: one range seek on idx_job_lake_company_updated, grouped in the index's
 * order, stopped at the limit - each key once, with its newest row's spelling
 * (SQLite's bare column beside a single MAX()) and how many jobs it has.
 * Exported for the plan test.
 */
export const LAKE_COMPANY_PREFIX_SQL =
  'SELECT company_key, company, MAX(updated_at) AS latest, COUNT(*) AS jobs FROM job_lake ' +
  'WHERE company_key >= ? AND company_key < ? GROUP BY company_key ORDER BY company_key LIMIT ?';

/** The same, for a prefix with no upper bound (one ending in U+10FFFF): filtered by the prefix afterwards. */
const LAKE_COMPANY_FROM_SQL =
  'SELECT company_key, company, MAX(updated_at) AS latest, COUNT(*) AS jobs FROM job_lake ' +
  'WHERE company_key >= ? GROUP BY company_key ORDER BY company_key LIMIT ?';

/**
 * The first key past every key that starts with `key`: its last code point
 * one higher (the surrogates skipped, which no well-formed text holds).
 * SQLite compares text as UTF-8 bytes, which is code-point order, so
 * `[key, bound)` is exactly the keys with that prefix. Null past U+10FFFF.
 */
export function prefixUpperBound(key: string): string | null {
  const points = [...key];
  const last = points.pop();
  if (last === undefined) return null;
  let next = (last.codePointAt(0) ?? 0) + 1;
  if (next >= 0xd800 && next <= 0xdfff) next = 0xe000;
  if (next > 0x10ffff) return null;
  return points.join('') + String.fromCodePoint(next);
}

export type LakeCompanySuggestion = { name: string; jobs: number };

/**
 * Up to `limit` companies in the lake whose normalised name starts with the
 * normalised `typed` - "open" finds OpenAI, Inc. - in key order, each named
 * the way its newest job spells it. Nothing for text that normalises to
 * nothing.
 */
export function suggestLakeCompanies(typed: string, limit: number): LakeCompanySuggestion[] {
  const key = typeof typed === 'string' ? normaliseCompany(typed) : '';
  const max = Number.isSafeInteger(limit) && limit > 0 ? limit : 10;
  if (!key) return [];
  const upper = prefixUpperBound(key);
  const db = getDb();
  type Found = { company_key: string; company: string; jobs: number };
  const found = (
    upper === null
      ? (db.prepare(LAKE_COMPANY_FROM_SQL).all(key, max) as Found[]).filter((row) => row.company_key.startsWith(key))
      : (db.prepare(LAKE_COMPANY_PREFIX_SQL).all(key, upper, max) as Found[])
  );
  return found.map((row) => ({ name: row.company, jobs: row.jobs }));
}

/** How many jobs an account has in the lake now (rows whose current version it reported or produced). */
export function countLakeEntriesBy(accountId: string): number {
  return (
    getDb().prepare('SELECT COUNT(*) AS total FROM job_lake WHERE requested_by = ?').get(accountId) as { total: number }
  ).total;
}

export function countLakeEntries(): number {
  return (getDb().prepare('SELECT COUNT(*) AS total FROM job_lake').get() as { total: number }).total;
}

/* -------------------------------------------------------------- outbox -- */

/** Rows whose current version is not in the admin sheet yet, oldest first. */
export function listUnsyncedLakeEntries(limit: number): LakeEntry[] {
  return (getDb().prepare(UNSYNCED_SQL).all(limit) as LakeRow[]).map(toEntry);
}

export function countUnsyncedLakeEntries(): number {
  return (
    getDb().prepare('SELECT COUNT(*) AS total FROM job_lake WHERE sheet_synced_at IS NULL').get() as { total: number }
  ).total;
}

/**
 * Records that these versions reached the admin sheet. Each by its
 * `updated_at` too: a row replaced while its old version was being appended
 * stays unsynced, so the new version gets its own line next time.
 */
export function markLakeEntriesSynced(entries: Array<Pick<LakeEntry, 'id' | 'updatedAt'>>, at: string): number {
  const db = getDb();
  const mark = db.prepare('UPDATE job_lake SET sheet_synced_at = ? WHERE id = ? AND updated_at = ? AND sheet_synced_at IS NULL');
  return db.transaction(() => entries.reduce((count, entry) => count + mark.run(at, entry.id, entry.updatedAt).changes, 0))();
}

/** Every row back into the outbox: a new admin sheet must hold the whole lake. */
export function reopenLakeOutbox(): number {
  return getDb().prepare('UPDATE job_lake SET sheet_synced_at = NULL WHERE sheet_synced_at IS NOT NULL').run().changes;
}

/* ----------------------------------------------------- revoke and delete -- */

export type RevokeOutcome = {
  /** False when there was nothing to revoke: no reward, revoked already, or no such row. */
  revoked: boolean;
  /** What actually came off the balance: never more than it held. */
  takenMilli: number;
  rewardMilli: number;
  userId: string | null;
  balanceMilli: number | null;
};

function revokeInTransaction(id: number, actorId: string, at: string): RevokeOutcome {
  const db = getDb();
  const row = db.prepare('SELECT * FROM job_lake WHERE id = ?').get(id) as LakeRow | undefined;
  if (!row || row.reward_milli <= 0 || row.reward_revoked_at || !row.requested_by) {
    return { revoked: false, takenMilli: 0, rewardMilli: row?.reward_milli ?? 0, userId: row?.requested_by ?? null, balanceMilli: null };
  }
  const outcome = revokeJobReportReward({
    userId: row.requested_by,
    amountMilli: row.reward_milli,
    idempotencyKey: `job-lake-revoke:${row.id}:${row.updated_at}`,
    refId: String(row.id),
    actorId,
    note: `${row.company} - ${jobFieldLabel(row.job_field_id)} (job #${row.id})`,
  });
  db.prepare('UPDATE job_lake SET reward_revoked_milli = ?, reward_revoked_at = ? WHERE id = ?').run(
    outcome.takenMilli,
    at,
    row.id
  );
  return { revoked: true, takenMilli: outcome.takenMilli, rewardMilli: row.reward_milli, userId: row.requested_by, balanceMilli: outcome.balance };
}

/**
 * Takes back the reward the row's CURRENT version paid, once - clamped at
 * the reporter's balance. A replaced version's reward stays paid: it was for
 * a job the lake accepted then.
 */
export function revokeLakeReward(id: number, actorId: string, at = new Date().toISOString()): RevokeOutcome {
  const db = getDb();
  return db.transaction(() => revokeInTransaction(id, actorId, at)).immediate();
}

/**
 * Deletes a lake row, its history and the reports that reached it
 * (`job_reports`), optionally revoking its current reward in the same
 * transaction. The job can be reported again afterwards, as a new one - by
 * the reporters who reported it too, whose records went with it. The
 * analysis it came from stays merged.
 */
export function deleteLakeEntry(
  id: number,
  options: { revokeReward: boolean; actorId: string; at?: string }
): { deleted: LakeEntry | null; revoke: RevokeOutcome | null } {
  const db = getDb();
  const at = options.at ?? new Date().toISOString();
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM job_lake WHERE id = ?').get(id) as LakeRow | undefined;
    if (!row) return { deleted: null, revoke: null };
    const revoke = options.revokeReward ? revokeInTransaction(id, options.actorId, at) : null;
    db.prepare('DELETE FROM job_lake_history WHERE lake_id = ?').run(id);
    db.prepare(DELETE_LAKE_REPORTS_SQL).run(id);
    db.prepare('DELETE FROM job_lake WHERE id = ?').run(id);
    return { deleted: toEntry(row), revoke };
  }).immediate();
}
