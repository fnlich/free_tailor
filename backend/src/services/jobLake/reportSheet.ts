import {
  a1Range,
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
import { rowRuns, sameCompany, sameLink } from '../sheets/analysisColumns';

/**
 * The reporter's own job sheet, as the Job Data Lake reads and marks it.
 *
 * Read: a tab's rows - Company, Job Title, Job Link and Job Description (B:E)
 * - in one call. Nothing the lake wrote into a row is read back: whether a
 * row's posting was reported before is the database's (`job_reports`, by the
 * posting's analysis), which follows the posting to whichever row it is in.
 * The row's protected analysis cells are read by the submission step
 * (services/jobAnalysis/submit.ts), as for any build.
 *
 * Written, once per run and after the analysis write-backs: each reported
 * row's Job Hash and Lake Status - a row reported before gets what became of
 * its posting the first time - RAW, only into the row that still holds the
 * posting reported from it (company and link read again first: rows can be
 * sorted or deleted meanwhile), and a duplicate's whole row painted red
 * (`repeatCell`), a posting that was a duplicate the first time included,
 * all of the run's rows in one `:batchUpdate`. Both cells sit in the
 * protected block, which the run's verify of the tab has put right before
 * anything is written; the program is their only writer.
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
};

/** Whether a row holds anything at all - an empty row inside a range is not a job, and is not counted. */
export function rowHoldsAJob(row: Pick<SheetReportRow, 'company' | 'link' | 'jobDescription'>): boolean {
  return Boolean(row.company.trim() || row.link.trim() || row.jobDescription.trim());
}

/**
 * Rows `fromRow`..`toRow` of a tab: Company, Job Title, Job Link and Job
 * Description (B:E), in one call. The lake's own cells (Job Hash, Lake
 * Status) are written, never read: what a row's posting became is in
 * `job_reports`, which a sorted, moved or pasted-over row cannot leave
 * behind it.
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
