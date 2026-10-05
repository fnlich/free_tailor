import {
  a1Range,
  ANALYSIS_LAST_COLUMN,
  batchGetValues,
  batchUpdateSpreadsheet,
  batchUpdateValuesRaw,
  DUPLICATE_ROW_COLOR,
  inspectJobSheetTab,
  isJobSheetTab,
  JOB_SHEET_COLUMNS,
  JOB_SHEET_FIRST_DATA_ROW,
  JOB_SHEET_HEADERS,
  rowBackgroundRequest,
  verifyJobSheetTab,
  type JobSheetTabInspection,
  type VerifiedJobSheetTab,
} from '../../integrations/googleSheets';
import { cellIsForPosting, parseAnalysisCell, rowRuns, sameCompany, sameLink } from '../sheets/analysisColumns';
import { postingKeysOf } from '../jobAnalysis/identity';

/**
 * The reporter's own job sheet, as the Job Data Lake reads and marks it.
 *
 * Read: a tab's rows - Company, Job Title, Job Link and Job Description (B:E)
 * and the six protected analysis cells (K:P), of which the lake reads Job Hash
 * (M), Lake Status (O) and Analysis (P) - in one batched call. A Lake Status
 * counts only beside the Analysis cell of the posting in the row now
 * (`lakeStatusIsRowsOwn`): the protected cells outlive the row's posting.
 *
 * Written, once per run and after the analysis write-backs: each reported
 * row's Job Hash and Lake Status, RAW, only into the row that still holds
 * the posting reported from it (company and link read again first: rows can
 * be sorted or deleted meanwhile), and a duplicate's whole row painted red
 * (`repeatCell`), all of the run's rows in one `:batchUpdate`. Both cells sit
 * in the protected block, which the run's verify of the tab has put right
 * before anything is written; the program is their only writer.
 */

/** What a Lake Status cell says. */
export const LAKE_STATUS_TEXT = {
  added: 'Added',
  replaced: 'Replaced',
  duplicate: 'Duplicate',
  unclassified: 'Unclassified',
  skipped: 'Skipped',
} as const;

export type LakeStatusText = (typeof LAKE_STATUS_TEXT)[keyof typeof LAKE_STATUS_TEXT];

/**
 * The statuses that mean a row was reported, for good: a run skips such a
 * row. Not `Skipped` - that says why a row could not be reported THIS time
 * (no company, no description to read), and the next run tries it again once
 * the person has filled it in.
 */
const REPORTED = new Set<string>(['added', 'replaced', 'duplicate', 'unclassified']);

export function isReportedStatus(cell: unknown): boolean {
  return typeof cell === 'string' && REPORTED.has(cell.trim().toLowerCase());
}

/**
 * Whether a row was reported, for good - so a run skips it: its Lake Status
 * says so (`isReportedStatus`) AND its Analysis cell is the program's cell for
 * the posting in the row NOW. Both sit in the protected block, which the
 * person cannot clear, so a row whose posting was replaced in place - or rows
 * sorted under the protected columns - keeps another posting's status beside
 * a job the lake never saw; skipping on the status alone would skip that job
 * for good. The run writes the Analysis cell before the status (or finds it
 * written), so a row it reported always has both. One whose status landed
 * and whose Analysis cell did not is simply run again: its analysis is
 * stored, its lake row is its own (`already`), and nothing is paid twice.
 *
 * Not the Job Hash: it names a company and a job field, and the field of
 * the posting in the row now is not known until it is analysed.
 */
export function lakeStatusIsRowsOwn(row: Pick<SheetReportRow, 'lakeStatus' | 'analysisCell' | 'jobDescription' | 'link'>): boolean {
  if (!isReportedStatus(row.lakeStatus)) return false;
  return cellIsForPosting(parseAnalysisCell(row.analysisCell), postingKeysOf({ jd: row.jobDescription, link: row.link }));
}

/** The Google calls the reporter run makes, as a seam the tests drive with a fake. */
export type ReportSheetsClient = {
  inspectTab(spreadsheetId: string, tabName: string): Promise<JobSheetTabInspection>;
  /** `known`: the inspection the caller just made, so the verify does not read the tab again. */
  verifyTab(spreadsheetId: string, tabName: string, known?: JobSheetTabInspection): Promise<VerifiedJobSheetTab>;
  readRanges(spreadsheetId: string, ranges: string[]): Promise<string[][][]>;
  writeRaw(spreadsheetId: string, data: Array<{ range: string; values: Array<Array<string | number | null>> }>): Promise<void>;
  batchUpdate(spreadsheetId: string, requests: Array<Record<string, unknown>>): Promise<void>;
};

const realClient: ReportSheetsClient = {
  inspectTab: (spreadsheetId, tabName) => inspectJobSheetTab(spreadsheetId, tabName),
  // A tab the person made for themselves is not touched (re-headered, protected) by a report run.
  verifyTab: (spreadsheetId, tabName, known) =>
    verifyJobSheetTab(spreadsheetId, tabName, JOB_SHEET_HEADERS, known, { onlyJobTabs: true }),
  readRanges: (spreadsheetId, ranges) => batchGetValues(spreadsheetId, ranges),
  writeRaw: (spreadsheetId, data) => batchUpdateValuesRaw(spreadsheetId, data),
  batchUpdate: (spreadsheetId, requests) => batchUpdateSpreadsheet(spreadsheetId, requests),
};

let client: ReportSheetsClient = realClient;

/** Swaps the Google calls for a fake; call with no argument to put the real ones back. */
export function setReportSheetsClientForTests(next?: ReportSheetsClient): void {
  client = next ?? realClient;
}

export function reportSheetsClient(): ReportSheetsClient {
  return client;
}

export type SheetReportRow = {
  row: number;
  company: string;
  title: string;
  link: string;
  jobDescription: string;
  /** The Job Hash cell (M), as the sheet holds it: display only, never trusted for anything. */
  jobHash: string;
  /** The Lake Status cell (O). */
  lakeStatus: string;
  /** The Analysis cell (P), as text: what ties M and O to the posting in B:E. */
  analysisCell: string;
};

/** Whether a row holds anything at all - an empty row inside a range is not a job, and is not counted. */
export function rowHoldsAJob(row: Pick<SheetReportRow, 'company' | 'link' | 'jobDescription'>): boolean {
  return Boolean(row.company.trim() || row.link.trim() || row.jobDescription.trim());
}

/**
 * Rows `fromRow`..`toRow` of a tab: B:E and, when the grid has them, K:P, in
 * one call. A tab an older build made twelve columns wide has no K:P until a
 * verify grows it, and Google refuses a read past the grid, so such a tab's
 * analysis cells read as empty here.
 */
export async function readReportRows(
  spreadsheetId: string,
  tabName: string,
  fromRow: number,
  toRow: number,
  options: { columnCount?: number } = {}
): Promise<SheetReportRow[]> {
  const withAnalysis = options.columnCount === undefined || options.columnCount >= ANALYSIS_LAST_COLUMN;
  const ranges = [a1Range(tabName, fromRow, toRow, JOB_SHEET_COLUMNS.company, JOB_SHEET_COLUMNS.jobDescription)];
  if (withAnalysis) ranges.push(a1Range(tabName, fromRow, toRow, JOB_SHEET_COLUMNS.jobField, ANALYSIS_LAST_COLUMN));
  const [identity = [], analysis = []] = await client.readRanges(spreadsheetId, ranges);
  const rows: SheetReportRow[] = [];
  const at = (cells: string[] | undefined, column: number, first: number) => String(cells?.[column - first] ?? '').trim();
  for (let row = fromRow; row <= toRow; row += 1) {
    const cells = identity[row - fromRow];
    const lake = analysis[row - fromRow];
    rows.push({
      row,
      company: at(cells, JOB_SHEET_COLUMNS.company, JOB_SHEET_COLUMNS.company),
      title: at(cells, JOB_SHEET_COLUMNS.jobTitle, JOB_SHEET_COLUMNS.company),
      link: at(cells, JOB_SHEET_COLUMNS.jobLink, JOB_SHEET_COLUMNS.company),
      jobDescription: String(cells?.[JOB_SHEET_COLUMNS.jobDescription - JOB_SHEET_COLUMNS.company] ?? ''),
      jobHash: at(lake, JOB_SHEET_COLUMNS.jobHash, JOB_SHEET_COLUMNS.jobField),
      lakeStatus: at(lake, JOB_SHEET_COLUMNS.lakeStatus, JOB_SHEET_COLUMNS.jobField),
      analysisCell: at(lake, JOB_SHEET_COLUMNS.analysis, JOB_SHEET_COLUMNS.jobField),
    });
  }
  return rows;
}

export type ReportTab = {
  jobTab: boolean;
  columnCount: number;
  rowCount: number | null;
  gid: number;
  /** The read itself, for a verify that follows it. */
  inspection: JobSheetTabInspection;
};

/** A tab's layout, read without writing anything: whether it is a job tab, and how far its grid reaches. */
export async function inspectReportTab(spreadsheetId: string, tabName: string): Promise<ReportTab> {
  const inspection = await client.inspectTab(spreadsheetId, tabName);
  return {
    jobTab: isJobSheetTab(inspection),
    columnCount: inspection.columnCount,
    rowCount: inspection.rowCount ?? null,
    gid: inspection.gid,
    inspection,
  };
}

/** The last row of a range that exists in the tab: Google refuses a read past the grid. */
export function lastRowInGrid(tab: Pick<ReportTab, 'rowCount'>, toRow: number): number {
  return tab.rowCount !== null ? Math.min(toRow, tab.rowCount) : toRow;
}

export type LakeStatusWrite = {
  row: number;
  /** What the row said when it was read for the run - checked again before writing. */
  company: string;
  link: string;
  jobHash: string | null;
  status: LakeStatusText;
  /** Paint the row red: the job is a duplicate. */
  red: boolean;
};

export type LakeStatusReport = { written: number; skipped: number; painted: number };

/**
 * Writes the run's Job Hash and Lake Status cells and paints its duplicates,
 * in at most three calls: read the rows' company and link again, write the
 * cells (M:O, Analyzed At between them left as it is - a null), paint.
 *
 * A row whose company or link no longer match is skipped: somebody sorted or
 * deleted rows since it was read, and the status belongs to the posting, not
 * to the row number. Its posting is in the lake regardless, and its row reads
 * as not reported - a later run finds the job already there, from the
 * database, and pays nothing twice.
 */
export async function writeLakeStatuses(
  spreadsheetId: string,
  tabName: string,
  gid: number,
  writes: LakeStatusWrite[]
): Promise<LakeStatusReport> {
  const report: LakeStatusReport = { written: 0, skipped: 0, painted: 0 };
  const entries = [...writes].filter((entry) => entry.row >= JOB_SHEET_FIRST_DATA_ROW).sort((a, b) => a.row - b.row);
  if (entries.length === 0) return report;

  const runs = rowRuns(entries.map((entry) => entry.row));
  const grids = await client.readRanges(
    spreadsheetId,
    runs.map(([from, to]) => a1Range(tabName, from, to, JOB_SHEET_COLUMNS.company, JOB_SHEET_COLUMNS.jobLink))
  );
  const current = new Map<number, { company: string; link: string }>();
  runs.forEach(([from, to], index) => {
    for (let row = from; row <= to; row += 1) {
      const cells = grids[index]?.[row - from] ?? [];
      current.set(row, {
        company: String(cells[0] ?? ''),
        link: String(cells[JOB_SHEET_COLUMNS.jobLink - JOB_SHEET_COLUMNS.company] ?? ''),
      });
    }
  });

  const data: Array<{ range: string; values: Array<Array<string | number | null>> }> = [];
  const paint: Array<Record<string, unknown>> = [];
  const done = new Set<number>();
  for (const entry of entries) {
    const now = current.get(entry.row);
    if (done.has(entry.row) || !now || !sameCompany(now.company, entry.company) || (entry.link && !sameLink(now.link, entry.link))) {
      report.skipped += 1;
      if (!done.has(entry.row)) {
        console.warn(
          `[lake] Row ${entry.row} of "${tabName}" in ${spreadsheetId} no longer holds ${entry.company || 'the reported posting'} ` +
            '(rows were sorted or deleted since); its Lake Status is not written there.'
        );
      }
      continue;
    }
    done.add(entry.row);
    data.push({
      range: a1Range(tabName, entry.row, entry.row, JOB_SHEET_COLUMNS.jobHash, JOB_SHEET_COLUMNS.lakeStatus),
      values: [[entry.jobHash ?? '', null, entry.status]],
    });
    if (entry.red) paint.push(rowBackgroundRequest(gid, entry.row, DUPLICATE_ROW_COLOR));
  }

  await client.writeRaw(spreadsheetId, data);
  report.written = data.length;
  if (paint.length > 0) {
    await client.batchUpdate(spreadsheetId, paint);
    report.painted = paint.length;
  }
  return report;
}
