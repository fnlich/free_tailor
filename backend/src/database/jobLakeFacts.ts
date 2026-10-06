import type Database from 'better-sqlite3';
import { analysisFactsOf, type AnalysisFacts } from '../services/jobAnalysis/facts';

/**
 * The Job Data Lake's job type, clearance and industry (v6) for rows written
 * before this build knew them, and the record of who reported what
 * (`job_reports`) for the reports those rows hold.
 *
 * A lake row stores the three facts beside its job field; this build writes
 * them on every insert, replacement and history copy (jobLakeRepository.ts).
 * A row an older build wrote has them NULL - every row on the first start of
 * this build, and any written while an older build was rolled back to. Each
 * is filled here from the row's own stored analysis, through the same pure
 * functions every other reader uses (services/jobAnalysis/facts.ts): an
 * analysis made before the prompt asked for an industry has its industry
 * derived from what it already holds. NO MODEL IS ASKED, and nothing is
 * written into an analysis: a posting is analysed once, ever. A row whose
 * analysis is gone or unreadable gets the facts of an analysis that says
 * nothing - '' / 0 / `not_specified` - so it is never visited again.
 *
 * The reports those rows hold are recorded at the same time, so a reporter
 * reporting one of their earlier postings again is told "reported before"
 * rather than paid or counted twice: a report-sourced row's current version
 * (outcome `replaced` when the row has history, else `added`) and each of
 * its earlier versions (`added` for the first, `replaced` after), oldest
 * first, `INSERT OR IGNORE` on the one-per-account-and-analysis index - so
 * the first report of a posting is the one kept. Duplicates an older build
 * saw left no row behind, and are not recorded.
 *
 * Except over a record whose lake row is GONE: an older build's delete takes
 * the row and its history and leaves the records, which it does not know.
 * When that build then took the same report again as a new row, the record
 * still naming the deleted one would win the INSERT OR IGNORE, and this
 * build's delete of the new row (which deletes the records naming IT) could
 * never forget the report. So the seed first drops that account's record of
 * the posting when, and only when, its row is gone (DROP_STALE_REPORT_SQL,
 * one seek). Any other such record is left: no reader counts it
 * (jobLakeRepository's findJobReports and mergeIntoLake), and the merge drops
 * it when it is met - a sweep of them all here would read the whole table at
 * every start.
 *
 * Also a lake row an older build REPLACED: that build copied the old version
 * into history without these columns (NULL there) and overwrote the row
 * without touching them, so the row still carries its previous version's
 * facts. A history row found NULL here marks its lake row for the same
 * refill, from the analysis the row holds now.
 *
 * Every start, by condition and not by a marker - rows whose facts are NULL,
 * found on the partial idx_job_lake_facts_missing and
 * idx_job_lake_history_facts_missing - so a rollback and a second upgrade heal
 * themselves, and a start with nothing to fill reads two empty indexes, never
 * either table (test/jobLakeStore.test.js pins both reads' plans). In batches
 * of BATCH rows, each in its own IMMEDIATE transaction
 * (facts and records together); a second process opening the file at the
 * same moment computes the same values. Never fatal: a batch that fails is
 * rolled back, logged, and tried again at the next start.
 *
 * In getDb() rather than the numbered chain, which waits at 003 for an
 * administrator; and run on the connection being opened, before it is
 * registered - so nothing here may reach for getDb() or a repository.
 */

const BATCH = 500;

/* ------------------------------------------------- the pinned statements -- */
// Exported so test/jobLakeStore.test.js runs EXPLAIN QUERY PLAN on exactly
// these: each must read its partial index, never walk the table by rowid.

/** Earlier versions whose facts are NULL, after `id`, with their analyses: on idx_job_lake_history_facts_missing. */
export const HISTORY_TO_FILL_SQL = `SELECT h.id, h.lake_id, h.analysis_id, h.requested_by, h.source, h.job_hash, h.reward_milli,
       h.version_at, a.analysis_json
  FROM job_lake_history h LEFT JOIN job_analyses a ON a.id = h.analysis_id
 WHERE h.job_type IS NULL AND h.id > ?
 ORDER BY h.id LIMIT ?`;

const LAKE_COLUMNS =
  'l.id, l.analysis_id, l.requested_by, l.source, l.job_hash, l.reward_milli, l.updated_at, l.report_ref, a.analysis_json';

/** Lake rows whose facts are NULL, after `id`, with their analyses: on idx_job_lake_facts_missing. */
export const LAKE_TO_FILL_SQL = `SELECT ${LAKE_COLUMNS}
  FROM job_lake l LEFT JOIN job_analyses a ON a.id = l.analysis_id
 WHERE l.job_type IS NULL AND l.id > ?
 ORDER BY l.id LIMIT ?`;

/** An account's record of a posting whose lake row is gone, before the seed records it again: one seek. */
export const DROP_STALE_REPORT_SQL = `DELETE FROM job_reports
 WHERE account_id = ? AND analysis_id = ? AND lake_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM job_lake l WHERE l.id = job_reports.lake_id)`;

export type LakeFactsReport = {
  /** Lake rows whose facts were filled (or refilled after an older build's replacement). */
  lakeRows: number;
  /** Earlier versions whose facts were filled. */
  historyRows: number;
  /** Reports recorded in job_reports from those rows. */
  reportsRecorded: number;
};

type HistoryCandidate = {
  id: number;
  lake_id: number;
  analysis_id: string | null;
  requested_by: string | null;
  source: string;
  job_hash: string;
  reward_milli: number | null;
  version_at: string;
  analysis_json: string | null;
};

type LakeCandidate = {
  id: number;
  analysis_id: string | null;
  requested_by: string | null;
  source: string;
  job_hash: string;
  reward_milli: number | null;
  updated_at: string;
  report_ref: string | null;
  analysis_json: string | null;
};

function tableColumns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
}

/** The facts of a stored analysis's JSON; those of an analysis that says nothing when it is gone or unreadable. */
export function factsFromAnalysisJson(json: string | null | undefined): AnalysisFacts {
  if (typeof json !== 'string') return analysisFactsOf(null);
  try {
    const parsed: unknown = JSON.parse(json);
    return analysisFactsOf(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null);
  } catch {
    return analysisFactsOf(null);
  }
}

/** `<spreadsheet>:<row>:<tab>` (jobLakeRepository's reportRefOf) back into its parts, or nulls. */
function sheetRowOf(reportRef: string | null): { spreadsheetId: string | null; tabName: string | null; row: number | null } {
  const match = typeof reportRef === 'string' ? /^([^:]+):(\d+):([\s\S]*)$/.exec(reportRef) : null;
  if (!match) return { spreadsheetId: null, tabName: null, row: null };
  return { spreadsheetId: match[1], tabName: match[3], row: Number(match[2]) };
}

export function fillLakeFacts(db: Database.Database): LakeFactsReport | null {
  const report: LakeFactsReport = { lakeRows: 0, historyRows: 0, reportsRecorded: 0 };
  try {
    const lakeColumns = tableColumns(db, 'job_lake');
    const historyColumns = tableColumns(db, 'job_lake_history');
    const reportColumns = tableColumns(db, 'job_reports');
    const needed = ['job_type', 'clearance', 'industry'];
    if (
      !needed.every((column) => lakeColumns.has(column) && historyColumns.has(column)) ||
      !reportColumns.has('analysis_id')
    ) {
      console.warn(
        "[lake] The lake's job type, clearance and industry columns are missing, so they could not be filled in; " +
          'trying again at the next start.'
      );
      return null;
    }

    const setHistoryFacts = db.prepare('UPDATE job_lake_history SET job_type = ?, clearance = ?, industry = ? WHERE id = ?');
    const setLakeFacts = db.prepare('UPDATE job_lake SET job_type = ?, clearance = ?, industry = ? WHERE id = ?');
    const record = db.prepare(
      `INSERT OR IGNORE INTO job_reports
         (account_id, analysis_id, outcome, lake_id, job_hash, reward_milli, spreadsheet_id, tab_name, row_number, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const dropStale = db.prepare(DROP_STALE_REPORT_SQL);
    /** Records a report, over this account's record of the posting only when that names a row that is gone. */
    const recordReport = (accountId: string | null, analysisId: string | null, ...rest: unknown[]): number => {
      dropStale.run(accountId, analysisId);
      return record.run(accountId, analysisId, ...rest).changes;
    };
    const earlierVersion = db.prepare('SELECT 1 FROM job_lake_history WHERE lake_id = ? AND id < ? LIMIT 1');
    const anyVersion = db.prepare('SELECT 1 FROM job_lake_history WHERE lake_id = ? LIMIT 1');
    const isReport = (row: { source: string; requested_by: string | null; analysis_id: string | null }) =>
      row.source === 'report' && Boolean(row.requested_by) && Boolean(row.analysis_id);

    // Earlier versions first: the first report of a posting is the one a
    // record keeps, and a NULL here names the lake rows an older build replaced.
    const replacedByOlderBuild = new Set<number>();
    const nextHistory = db.prepare(HISTORY_TO_FILL_SQL);
    for (let after = 0; ; ) {
      const rows = nextHistory.all(after, BATCH) as HistoryCandidate[];
      if (rows.length === 0) break;
      db.transaction(() => {
        for (const row of rows) {
          const facts = factsFromAnalysisJson(row.analysis_json);
          setHistoryFacts.run(facts.jobType, facts.clearance ? 1 : 0, facts.industry, row.id);
          replacedByOlderBuild.add(row.lake_id);
          if (isReport(row)) {
            const outcome = earlierVersion.get(row.lake_id, row.id) ? 'replaced' : 'added';
            report.reportsRecorded += recordReport(
              row.requested_by, row.analysis_id, outcome, row.lake_id, row.job_hash, row.reward_milli ?? 0,
              null, null, null, row.version_at
            );
          }
        }
      }).immediate();
      report.historyRows += rows.length;
      after = rows[rows.length - 1].id;
    }

    const fillLakeRows = (rows: LakeCandidate[]) => {
      db.transaction(() => {
        for (const row of rows) {
          const facts = factsFromAnalysisJson(row.analysis_json);
          setLakeFacts.run(facts.jobType, facts.clearance ? 1 : 0, facts.industry, row.id);
          if (isReport(row)) {
            const sheetRow = sheetRowOf(row.report_ref);
            report.reportsRecorded += recordReport(
              row.requested_by, row.analysis_id, anyVersion.get(row.id) ? 'replaced' : 'added', row.id, row.job_hash,
              row.reward_milli ?? 0, sheetRow.spreadsheetId, sheetRow.tabName, sheetRow.row, row.updated_at
            );
          }
        }
      }).immediate();
      report.lakeRows += rows.length;
    };

    const nextLake = db.prepare(LAKE_TO_FILL_SQL);
    for (let after = 0; ; ) {
      const rows = nextLake.all(after, BATCH) as LakeCandidate[];
      if (rows.length === 0) break;
      for (const row of rows) replacedByOlderBuild.delete(row.id);
      fillLakeRows(rows);
      after = rows[rows.length - 1].id;
    }

    // The rows an older build replaced, whose facts are not NULL but its
    // previous version's: refilled from the analysis they hold now.
    const replaced = [...replacedByOlderBuild];
    const byId = db.prepare(
      `SELECT ${LAKE_COLUMNS} FROM job_lake l LEFT JOIN job_analyses a ON a.id = l.analysis_id WHERE l.id = ?`
    );
    for (let start = 0; start < replaced.length; start += BATCH) {
      const rows = replaced
        .slice(start, start + BATCH)
        .map((id) => byId.get(id) as LakeCandidate | undefined)
        .filter((row): row is LakeCandidate => row !== undefined);
      if (rows.length > 0) fillLakeRows(rows);
    }

    if (report.lakeRows > 0 || report.historyRows > 0) {
      console.log(
        `[lake] Filled in job type, clearance and industry for ${report.lakeRows} lake row(s) and ` +
          `${report.historyRows} earlier version(s), from their stored analyses - no model was asked - and ` +
          `recorded ${report.reportsRecorded} report(s) of them.`
      );
    }
    return report;
  } catch (error) {
    console.error(
      "[lake] Could not fill in the lake's job type, clearance and industry; the rows not yet filled show them " +
        'blank, and the next start tries again.',
      error
    );
    return null;
  }
}
