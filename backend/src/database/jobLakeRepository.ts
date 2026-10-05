import { isJobFieldId, jobFieldLabel } from '../config/jobFields';
import { readStoredReportRateMilli } from '../config/reportRate';
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
   * The sheet row a reporter's run read the job from (`reportRefOf`), or
   * null - a merge has none. Only a report from this SAME row can be
   * `already`; from anywhere else, the same posting is a duplicate.
   */
  reportRef?: string | null;
};

/**
 * The reference a report run stores for one of its rows: the spreadsheet, the
 * row and the tab. Compared whole, never parsed - the spreadsheet id has no
 * `:` and the row is digits, so the tab goes last, whatever it contains.
 */
export function reportRefOf(spreadsheetId: string, tabName: string, row: number): string {
  return `${spreadsheetId}:${row}:${tabName}`;
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
   * The SAME report again - the row within the window is this very posting
   * (same analysis), reported by this same account from the same sheet row:
   * a run re-reading a row whose Lake Status never reached the sheet.
   * Nothing moves, and the row is what it was the first time, not a
   * duplicate of itself. The same posting pasted into another row, tab or
   * day's sheet is a `duplicate`, like any other report of the job.
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
  report_ref?: string | null;
};

type HistoryRow = Omit<LakeRow, 'company_key' | 'created_at' | 'updated_at' | 'last_seen_at' | 'sheet_synced_at' | 'report_ref'> & {
  lake_id: number;
  version_at: string;
  replaced_at: string;
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
};

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
};

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
  };
}

/** Every column but the description: what a list carries. */
const LIST_COLUMNS =
  'id, job_hash, hash_version, company, company_key, job_field_id, title, salary_min, salary_max, ' +
  'salary_currency, salary_period, salary_raw, job_url, analysis_id, requested_by, source, created_at, ' +
  'updated_at, seen_count, last_seen_at, sheet_synced_at, reward_milli, reward_rate_milli, ' +
  'reward_revoked_milli, reward_revoked_at';

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
 * transaction with the reward that pays for it:
 *
 *  - no identity (unclassified, or no company): nothing is written;
 *  - no row with the job's hash: INSERTED -> `added`, paid;
 *  - a row added or last replaced within the window: `seen_count` and
 *    `last_seen_at` move -> `duplicate`, not paid (or `already`, below);
 *  - an older row: its content goes to `job_lake_history`, the row takes the
 *    new job - `requested_by`, `updated_at` and the reward move, the outbox
 *    is opened again so the admin sheet gets a NEW line - -> `replaced`,
 *    which counts as added, paid.
 *
 * `already`: within the window, the row is this very posting (the same
 * analysis) from this same account AND the same sheet row (`reportRef`) - a
 * re-run of rows whose Lake Status was never written. Nothing moves; it is
 * not a duplicate of itself. Anything less - the same posting on another
 * row, or no row at all - is a duplicate.
 *
 * The reward's ledger row is keyed `job-lake:<id>:<updated_at>`: a replaced
 * row pays again, the same version never twice. The analysis it came from is
 * marked merged in the same transaction, so the merge tab stops offering it.
 */
export function mergeIntoLake(job: LakeJob, requestedBy: string | null, policy: LakePolicy): MergeOutcome {
  const identity = lakeIdentity(job.company, job.jobFieldId);
  if (!identity) {
    return {
      // Unclassified first: that is final, while a missing company is the
      // reporter's to fill in and report again.
      status: isJobFieldId(job.jobFieldId) ? 'no-company' : 'unclassified',
      lakeId: null,
      jobHash: null,
      seenCount: 0,
      rewardMilli: 0,
      rewardRateMilli: null,
    };
  }

  const db = getDb();
  const nowIso = new Date(policy.now).toISOString();
  const windowStartIso = new Date(policy.now - policy.windowDays * DAY_MS).toISOString();
  const values = {
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
    report_ref: typeof job.reportRef === 'string' && job.reportRef ? job.reportRef : null,
  };

  return db.transaction((): MergeOutcome => {
    const existing = db.prepare(FIND_BY_HASH_SQL).get(identity.hash) as LakeRow | undefined;
    const markMerged = () => {
      if (job.analysisId) markJobAnalysisMerged(job.analysisId, nowIso);
    };

    if (!existing) {
      const inserted = db
        .prepare(
          `INSERT INTO job_lake (
             job_hash, hash_version, company, company_key, job_field_id, title,
             salary_min, salary_max, salary_currency, salary_period, salary_raw,
             job_url, job_description, analysis_id, requested_by, source, report_ref,
             created_at, updated_at, seen_count, last_seen_at
           ) VALUES (
             @job_hash, @hash_version, @company, @company_key, @job_field_id, @title,
             @salary_min, @salary_max, @salary_currency, @salary_period, @salary_raw,
             @job_url, @job_description, @analysis_id, @requested_by, @source, @report_ref,
             @now, @now, 1, @now
           ) ON CONFLICT (job_hash) DO NOTHING`
        )
        .run({ ...values, now: nowIso });
      if (inserted.changes === 0) {
        // Unreachable under the IMMEDIATE lock, which no other writer can
        // hold between the read above and this insert; if it ever is
        // reached, the row that won is this job's and this report a duplicate.
        const winner = db.prepare(FIND_BY_HASH_SQL).get(identity.hash) as LakeRow;
        return sawAgain(winner);
      }
      const lakeId = Number(inserted.lastInsertRowid);
      markMerged();
      return { status: 'added', lakeId, jobHash: identity.hash, seenCount: 1, ...pay(lakeId, nowIso) };
    }

    if (existing.updated_at >= windowStartIso) {
      markMerged();
      if (
        job.analysisId &&
        values.report_ref &&
        existing.analysis_id === job.analysisId &&
        existing.requested_by === requestedBy &&
        existing.report_ref === values.report_ref
      ) {
        return {
          status: 'already',
          lakeId: existing.id,
          jobHash: identity.hash,
          seenCount: existing.seen_count,
          rewardMilli: 0,
          rewardRateMilli: null,
        };
      }
      return sawAgain(existing);
    }

    // Older than the window: this report is the job now.
    db.prepare(
      `INSERT INTO job_lake_history (
         lake_id, job_hash, hash_version, company, job_field_id, title,
         salary_min, salary_max, salary_currency, salary_period, salary_raw,
         job_url, job_description, analysis_id, requested_by, source, version_at, seen_count,
         reward_milli, reward_rate_milli, reward_revoked_milli, reward_revoked_at, replaced_at
       )
       SELECT id, job_hash, hash_version, company, job_field_id, title,
              salary_min, salary_max, salary_currency, salary_period, salary_raw,
              job_url, job_description, analysis_id, requested_by, source, updated_at, seen_count,
              reward_milli, reward_rate_milli, reward_revoked_milli, reward_revoked_at, @now
         FROM job_lake WHERE id = @id`
    ).run({ id: existing.id, now: nowIso });
    db.prepare(
      `UPDATE job_lake SET
         hash_version = @hash_version, company = @company, company_key = @company_key,
         job_field_id = @job_field_id, title = @title,
         salary_min = @salary_min, salary_max = @salary_max, salary_currency = @salary_currency,
         salary_period = @salary_period, salary_raw = @salary_raw,
         job_url = @job_url, job_description = @job_description, analysis_id = @analysis_id,
         requested_by = @requested_by, source = @source, report_ref = @report_ref,
         updated_at = @now, seen_count = 1, last_seen_at = @now, sheet_synced_at = NULL,
         reward_milli = 0, reward_rate_milli = NULL, reward_revoked_milli = 0, reward_revoked_at = NULL
       WHERE id = @id`
    ).run({ ...values, id: existing.id, now: nowIso });
    markMerged();
    return { status: 'replaced', lakeId: existing.id, jobHash: identity.hash, seenCount: 1, ...pay(existing.id, nowIso) };

    function sawAgain(row: LakeRow): MergeOutcome {
      db.prepare('UPDATE job_lake SET seen_count = seen_count + 1, last_seen_at = ? WHERE id = ?').run(nowIso, row.id);
      return {
        status: 'duplicate',
        lakeId: row.id,
        jobHash: identity!.hash,
        seenCount: row.seen_count + 1,
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
        note: `${values.company} - ${jobFieldLabel(values.job_field_id)} (job #${lakeId}, ${formatMoney(rateMilli)} per job)`,
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
  }).immediate();
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

export type LakeQuery = {
  /** Free text over company, title and description (FTS5), every word a prefix. */
  text?: string;
  /** A company as typed: compared after normalising, exactly as the hash compares it. */
  company?: string;
  jobFieldId?: string;
  /** A salary range: rows whose stated range reaches it. Rows stating no salary are left out. */
  salaryMin?: number;
  salaryMax?: number;
  requestedBy?: string;
  /** ISO times, inclusive. */
  updatedFrom?: string;
  updatedTo?: string;
  limit: number;
  offset: number;
};

/**
 * Free text as an FTS5 query that cannot be a syntax error: split where the
 * index's tokenizer splits (anything not a letter or a digit - so `node.js`
 * is `node` and `js`, as it was indexed), every word quoted and made a
 * prefix, all of them required. Null when there is no word to look for.
 */
export function ftsQuery(text: string): string | null {
  const words = text
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 12);
  return words.length > 0 ? words.map((word) => `"${word}"*`).join(' ') : null;
}

/** The WHERE clause and its values for a query, on the indexes the plans test pins. */
function whereOf(query: LakeQuery, companyKey: string | null): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.jobFieldId) {
    clauses.push('job_field_id = ?');
    params.push(query.jobFieldId);
  }
  if (companyKey !== null) {
    clauses.push('company_key = ?');
    params.push(companyKey);
  }
  if (query.requestedBy) {
    clauses.push('requested_by = ?');
    params.push(query.requestedBy);
  }
  if (query.updatedFrom) {
    clauses.push('updated_at >= ?');
    params.push(query.updatedFrom);
  }
  if (query.updatedTo) {
    clauses.push('updated_at <= ?');
    params.push(query.updatedTo);
  }
  if (query.salaryMin !== undefined) {
    clauses.push('COALESCE(salary_max, salary_min) >= ?');
    params.push(query.salaryMin);
  }
  if (query.salaryMax !== undefined) {
    clauses.push('COALESCE(salary_min, salary_max) <= ?');
    params.push(query.salaryMax);
  }
  const match = query.text ? ftsQuery(query.text) : null;
  if (match) {
    clauses.push('id IN (SELECT rowid FROM job_lake_fts WHERE job_lake_fts MATCH ?)');
    params.push(match);
  }
  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/**
 * A page of the lake, newest first, and how many rows match. A company that
 * normalises to nothing matches nothing, rather than everything.
 */
export function queryLake(query: LakeQuery): { rows: LakeEntry[]; total: number } {
  let companyKey: string | null = null;
  if (query.company !== undefined && query.company.trim()) {
    companyKey = normaliseCompany(query.company);
    if (!companyKey) return { rows: [], total: 0 };
  }
  const where = whereOf(query, companyKey);
  const db = getDb();
  const rows = (where.sql
    ? db
        .prepare(`SELECT ${LIST_COLUMNS} FROM job_lake ${where.sql} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...where.params, query.limit, query.offset)
    : db.prepare(LIST_DEFAULT_SQL).all(query.limit, query.offset)) as LakeRow[];
  const total = (db.prepare(`SELECT COUNT(*) AS total FROM job_lake ${where.sql}`).get(...where.params) as { total: number })
    .total;
  return { rows: rows.map(toEntry), total };
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
 * Deletes a lake row and its history, optionally revoking its current
 * reward in the same transaction. The job can be reported again afterwards,
 * as a new one. The analysis it came from stays merged.
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
    db.prepare('DELETE FROM job_lake WHERE id = ?').run(id);
    return { deleted: toEntry(row), revoke };
  }).immediate();
}
