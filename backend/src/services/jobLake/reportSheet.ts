import {
  a1Range,
  batchGetValues,
  batchUpdateSpreadsheet,
  DUPLICATE_ROW_COLOR,
  inspectJobSheetTab,
  isJobSheetTab,
  JOB_SHEET_COLUMNS,
  JOB_SHEET_FIRST_DATA_ROW,
  rowBackgroundRequest,
  verifyJobSheetTab,
  type JobSheetTabInspection,
  type VerifiedJobSheetTab,
} from '../../integrations/googleSheets';
import { rowRuns, sameCompany, sameLink } from '../sheets/analysisColumns';

/**
 * The reporter's own job sheet, as the Job Data Lake reads and marks it.
 *
 * Read: a job tab's rows - Company, Job Title, Job Link and Job Description
 * (C:F) - in one call. Nothing the lake did to a row is read back: whether a
 * row's posting was reported before is the database's (`job_reports`, by the
 * posting's analysis), which follows the posting to whichever row it is in.
 * The row's protected analysis cells are read by the submission step
 * (services/jobAnalysis/submit.ts), as for any build.
 *
 * Marked, once per run and after the analysis write-backs: a duplicate's
 * whole row painted red (`repeatCell`, background only) - a posting that was
 * a duplicate the first time included - all of the run's rows in one
 * `:batchUpdate`, and only the rows that still hold the posting reported from
 * them (company and link read again first: rows can be sorted or deleted
 * meanwhile). Nothing is written into a row's cells: the lake's outcome is on
 * the page, and in the database.
 */

/** The Google calls the reporter run makes, as a seam the tests drive with a fake. */
export type ReportSheetsClient = {
  inspectTab(spreadsheetId: string, tabName: string): Promise<JobSheetTabInspection>;
  /** `known`: the inspection the caller just made, so the verify does not read the tab again. */
  verifyTab(spreadsheetId: string, tabName: string, known?: JobSheetTabInspection): Promise<VerifiedJobSheetTab>;
  readRanges(spreadsheetId: string, ranges: string[]): Promise<string[][][]>;
  batchUpdate(spreadsheetId: string, requests: Array<Record<string, unknown>>): Promise<void>;
};

const realClient: ReportSheetsClient = {
  inspectTab: (spreadsheetId, tabName) => inspectJobSheetTab(spreadsheetId, tabName),
  // A tab that is not a job tab is not touched (re-headered, protected) by a report run.
  verifyTab: (spreadsheetId, tabName, known) => verifyJobSheetTab(spreadsheetId, tabName, known),
  readRanges: (spreadsheetId, ranges) => batchGetValues(spreadsheetId, ranges),
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
};

/** Whether a row holds anything at all - an empty row inside a range is not a job, and is not counted. */
export function rowHoldsAJob(row: Pick<SheetReportRow, 'company' | 'link' | 'jobDescription'>): boolean {
  return Boolean(row.company.trim() || row.link.trim() || row.jobDescription.trim());
}

/**
 * Rows `fromRow`..`toRow` of a job tab: Company, Job Title, Job Link and Job
 * Description (C:F), in one call. What a row's posting became is in
 * `job_reports`, which a sorted, moved or pasted-over row cannot leave
 * behind it - nothing in the sheet says it.
 */
export async function readReportRows(
  spreadsheetId: string,
  tabName: string,
  fromRow: number,
  toRow: number
): Promise<SheetReportRow[]> {
  const [identity = []] = await client.readRanges(spreadsheetId, [
    a1Range(tabName, fromRow, toRow, JOB_SHEET_COLUMNS.company, JOB_SHEET_COLUMNS.jobDescription),
  ]);
  const rows: SheetReportRow[] = [];
  const at = (cells: string[] | undefined, column: number) => String(cells?.[column - JOB_SHEET_COLUMNS.company] ?? '').trim();
  for (let row = fromRow; row <= toRow; row += 1) {
    const cells = identity[row - fromRow];
    rows.push({
      row,
      company: at(cells, JOB_SHEET_COLUMNS.company),
      title: at(cells, JOB_SHEET_COLUMNS.jobTitle),
      link: at(cells, JOB_SHEET_COLUMNS.jobLink),
      jobDescription: String(cells?.[JOB_SHEET_COLUMNS.jobDescription - JOB_SHEET_COLUMNS.company] ?? ''),
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

/** A row to paint red, with what it said when it was read for the run - checked again before painting. */
export type DuplicateRowPaint = {
  row: number;
  company: string;
  link: string;
};

export type DuplicatePaintReport = { painted: number; skipped: number };

/**
 * Paints the run's duplicate rows red, in at most two calls: read the rows'
 * Company and Job Link (C:E) again, then ONE `:batchUpdate` of background-only
 * `repeatCell`s.
 *
 * A row whose company or link no longer match is skipped: somebody sorted or
 * deleted rows since it was read, and the paint belongs to the posting, not
 * to the row number. Its posting is in the lake regardless, and a later run
 * finds it reported, from the database, and pays nothing twice.
 */
export async function paintDuplicateRows(
  spreadsheetId: string,
  tabName: string,
  gid: number,
  rows: DuplicateRowPaint[]
): Promise<DuplicatePaintReport> {
  const report: DuplicatePaintReport = { painted: 0, skipped: 0 };
  const entries = [...rows].filter((entry) => entry.row >= JOB_SHEET_FIRST_DATA_ROW).sort((a, b) => a.row - b.row);
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

  const paint: Array<Record<string, unknown>> = [];
  const done = new Set<number>();
  for (const entry of entries) {
    const now = current.get(entry.row);
    if (done.has(entry.row)) continue;
    if (!now || !sameCompany(now.company, entry.company) || (entry.link && !sameLink(now.link, entry.link))) {
      report.skipped += 1;
      console.warn(
        `[lake] Row ${entry.row} of "${tabName}" in ${spreadsheetId} no longer holds ${entry.company || 'the reported posting'} ` +
          '(rows were sorted or deleted since); it is not painted.'
      );
      continue;
    }
    done.add(entry.row);
    paint.push(rowBackgroundRequest(gid, entry.row, DUPLICATE_ROW_COLOR));
  }

  if (paint.length > 0) {
    await client.batchUpdate(spreadsheetId, paint);
    report.painted = paint.length;
  }
  return report;
}
