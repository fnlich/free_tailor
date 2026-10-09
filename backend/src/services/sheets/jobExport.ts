import {
  a1Columns,
  a1Range,
  batchGetValues,
  batchUpdateSpreadsheet,
  batchUpdateValuesRaw,
  inspectJobSheetTab,
  isJobSheetTab,
  JOB_SHEET_COLUMNS,
  JOB_SHEET_FIRST_DATA_ROW,
  jobRowLayoutRequests,
  verifyJobSheetTab,
  type JobSheetTabInspection,
  type SheetCellValue,
} from '../../integrations/googleSheets';
import { PublicError } from '../../middleware/publicError';
import type { UserAccount } from '../../types/account';
import { notJobTabError, sheetDateOfCell, sheetDateSerial, sheetDateText } from './accountSheet';
import { descriptionCell } from './analysisColumns';
import { resolveJobSheetTarget } from './jobSheetTarget';

/**
 * Jobs appended to the caller's OWN job sheet - the tab named, else All - as
 * new rows after the last one used (`appendJobRows`). The writer the removed
 * job search exported with (owner decision F4), kept for the lake's export
 * into a sheet; no route calls it yet.
 *
 * Each row is Date (today, in SHEET_TIMEZONE, as a real date), NO(DATE) (1 +
 * the highest number already on today's rows, then on), Company, Job Title,
 * Job Link and Job Description - A to F, RAW - and, for a row that carries
 * them, the program's six analysis columns G to L (`analysisColumnValues` of
 * its stored analysis), in the same write. Never a column of the caller's
 * choosing. A tab that is not a job tab is refused before anything is read
 * (an empty one is laid out as one).
 *
 * ONE read of A:E gives the duplicate check, the first free row and the day's
 * numbering. Before every write its rows are read again (A:F): a row that is
 * no longer empty - somebody typed there, or another export landed - moves
 * the rest below it rather than being written over (409 `sheet-changed`
 * after five tries). Each write grows the grid when it has to and lays the
 * written rows out at 21 px, clipped (`jobRowLayoutRequests`). Exports to one
 * tab are serialised in this process.
 */

/** One job to append. */
export type JobExportRow = {
  company: string;
  title: string;
  link: string;
  /** The posting's text; cut to one cell as the push cuts it (`descriptionCell`), so a stored analysis still knows it. */
  description: string;
  /** G to L - six cells, `analysisColumnValues` of the row's stored analysis - or absent to write A to F only. */
  analysis?: SheetCellValue[];
};

/** A row as the duplicate check sees it: what is in C to E of the tab, or about to be. */
export type JobExportIdentity = { company: string; title: string; link: string };

export type JobExportOptions = {
  /**
   * The keys a row counts as already in the tab under: a row sharing any of
   * them with a row there - or with one written earlier in the same call - is
   * skipped. Default `companyDuplicateKeys`, a company once per tab.
   */
  duplicateKeys?: (row: JobExportIdentity) => string[];
};

export type JobExportResult = {
  spreadsheetId: string;
  spreadsheetTitle: string;
  tabName: string;
  tabUrl: string;
  /** Today, as the Date column reads it (MM/DD/YYYY in SHEET_TIMEZONE). */
  date: string;
  updatedRanges: string[];
  rowsWritten: number;
  startRow: number;
  endRow: number;
  firstNo: number | null;
  lastNo: number | null;
  /** Rows written with no job link. */
  unresolvedJobLinks: number;
  /** Rows skipped as already in the tab (`JobExportOptions.duplicateKeys`). */
  skippedDuplicates: number;
};

/** How many rows one write sends. */
const EXPORT_BATCH_SIZE = 50;
/** How often an export looks for free rows again before giving up on a sheet that keeps changing under it. */
const EXPORT_PLACE_ATTEMPTS = 5;
/** The six program columns, G to L. */
const ANALYSIS_CELL_COUNT = JOB_SHEET_COLUMNS.analysis - JOB_SHEET_COLUMNS.jobField + 1;

/** Exports in flight, one per tab at a time in this process: two would number and place their rows over each other. */
const exportLocks = new Map<string, Promise<unknown>>();

function serializeExport<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = exportLocks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  const settled = run.catch(() => undefined);
  exportLocks.set(key, settled);
  void settled.then(() => {
    if (exportLocks.get(key) === settled) exportLocks.delete(key);
  });
  return run;
}

/** A company as the duplicate check compares it: trimmed, single-spaced, lower case. */
function normalizeCompanyName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The default duplicate rule: `company:<name>`, so a company already in the tab is not exported again. None for no company. */
export function companyDuplicateKeys(row: Pick<JobExportIdentity, 'company'>): string[] {
  const company = normalizeCompanyName(row.company ?? '');
  return company ? [`company:${company}`] : [];
}

/** A sheet's used rows as an export reads them: where the next row goes, and how far today's numbering got. */
export type ExportPlace = { nextRow: number; lastNo: number };

/**
 * Where an export's rows go and how they are numbered, from ONE read of the
 * tab's columns: the first row after the last one holding anything, and the
 * highest NO(DATE) among the rows dated `today` (a Date cell read back in
 * any of the forms `sheetDateOfCell` knows; a NO that is not a whole number
 * counts for nothing).
 */
export function exportPlaceOf(grid: string[][], today: string): ExportPlace {
  let lastNo = 0;
  for (let index = JOB_SHEET_FIRST_DATA_ROW - 1; index < grid.length; index += 1) {
    const row = grid[index] ?? [];
    if (sheetDateOfCell(row[JOB_SHEET_COLUMNS.date - 1]) !== today) continue;
    const no = String(row[JOB_SHEET_COLUMNS.no - 1] ?? '').trim();
    if (/^\d{1,9}$/.test(no)) lastNo = Math.max(lastNo, Number(no));
  }
  return { nextRow: Math.max(JOB_SHEET_FIRST_DATA_ROW, grid.length + 1), lastNo };
}

/**
 * Appends `rows` to the caller's own sheet, tab `tabName` or All. Refuses a
 * tab that is not a job tab (409 `not-job-tab`), a sheet that is not the
 * caller's (404, `resolveJobSheetTarget`), and one that kept changing under
 * the write (409 `sheet-changed`). Google's own refusals are thrown as they
 * come (`GoogleSheetsRequestError`, public).
 */
export async function appendJobRows(
  account: UserAccount,
  tabName: unknown,
  rows: readonly JobExportRow[],
  options: JobExportOptions = {}
): Promise<JobExportResult> {
  // The caller's own sheet, verified: the export writes, and All may have
  // been deleted since the sheet was laid out.
  const target = await resolveJobSheetTarget(account, { tabName }, { verifyTab: true });
  const inspected = await inspectJobSheetTab(target.spreadsheetId, target.tabName);
  if (!isJobSheetTab(inspected)) throw notJobTabError(target.tabName, 'exported into');
  const verified = await verifyJobSheetTab(target.spreadsheetId, target.tabName, inspected);

  const written = await serializeExport(`${target.spreadsheetId}\u0000${target.tabName}`, () =>
    writeExportRows(target.spreadsheetId, target.tabName, verified.gid, inspected, rows, options.duplicateKeys ?? companyDuplicateKeys)
  );
  return {
    spreadsheetId: target.spreadsheetId,
    spreadsheetTitle: inspected.spreadsheetTitle ?? '',
    tabName: target.tabName,
    tabUrl: `https://docs.google.com/spreadsheets/d/${target.spreadsheetId}/edit#gid=${verified.gid}`,
    ...written,
  };
}

type ExportWriteReport = Omit<JobExportResult, 'spreadsheetId' | 'spreadsheetTitle' | 'tabName' | 'tabUrl'>;

async function writeExportRows(
  sheetId: string,
  tabName: string,
  gid: number,
  inspected: JobSheetTabInspection,
  jobs: readonly JobExportRow[],
  duplicateKeys: (row: JobExportIdentity) => string[]
): Promise<ExportWriteReport> {
  const today = sheetDateText();
  const serial = sheetDateSerial(today);
  // ONE read of A:E, at the moment of the write, so it is fresh.
  const [grid = []] = await batchGetValues(sheetId, [a1Columns(tabName, JOB_SHEET_COLUMNS.date, JOB_SHEET_COLUMNS.jobLink)]);
  let place = exportPlaceOf(grid, today);
  const seen = new Set<string>();
  for (const row of grid.slice(JOB_SHEET_FIRST_DATA_ROW - 1)) {
    const keys = duplicateKeys({
      company: String(row[JOB_SHEET_COLUMNS.company - 1] ?? ''),
      title: String(row[JOB_SHEET_COLUMNS.jobTitle - 1] ?? ''),
      link: String(row[JOB_SHEET_COLUMNS.jobLink - 1] ?? ''),
    });
    for (const key of keys) seen.add(key);
  }

  const report: ExportWriteReport = {
    date: today,
    updatedRanges: [],
    rowsWritten: 0,
    startRow: place.nextRow,
    endRow: place.nextRow,
    firstNo: null,
    lastNo: null,
    unresolvedJobLinks: 0,
    skippedDuplicates: 0,
  };
  const rows: JobExportRow[] = [];
  for (const job of jobs) {
    const identity = { company: job.company ?? '', title: job.title ?? '', link: (job.link ?? '').trim() };
    const keys = duplicateKeys(identity);
    if (keys.some((key) => seen.has(key))) {
      report.skippedDuplicates += 1;
      continue;
    }
    for (const key of keys) seen.add(key);
    rows.push({
      ...identity,
      // Google refuses a whole write for one cell past its limit; cut the way
      // the push cuts it, so a stored analysis still recognises the copy.
      description: descriptionCell(job.description ?? ''),
      ...(job.analysis ? { analysis: job.analysis } : {}),
    });
  }

  let gridRows = inspected.rowCount ?? null;
  for (let start = 0; start < rows.length; start += EXPORT_BATCH_SIZE) {
    const chunk = rows.slice(start, start + EXPORT_BATCH_SIZE);
    place = await claimFreeRows(sheetId, tabName, place, chunk.length, today, gridRows);
    const fromRow = place.nextRow;
    const toRow = fromRow + chunk.length - 1;

    // The grid first (a write past its last row is refused), then the
    // rows' layout, in one call; then the values, RAW.
    const layout: Array<Record<string, unknown>> = [];
    if (gridRows !== null && toRow > gridRows) {
      layout.push({ appendDimension: { sheetId: gid, dimension: 'ROWS', length: toRow - gridRows } });
      gridRows = toRow;
    }
    layout.push(...jobRowLayoutRequests(gid, fromRow, toRow));
    await batchUpdateSpreadsheet(sheetId, layout);

    // A to L when any row of the chunk carries its analysis (the others
    // leave G to L blank), else A to F.
    const withAnalysis = chunk.some((row) => row.analysis);
    const values: SheetCellValue[][] = chunk.map((row, index) => [
      serial ?? today,
      place.lastNo + index + 1,
      row.company,
      row.title,
      row.link,
      row.description,
      ...(withAnalysis ? analysisCells(row.analysis) : []),
    ]);
    const lastColumn = withAnalysis ? JOB_SHEET_COLUMNS.analysis : JOB_SHEET_COLUMNS.jobDescription;
    const range = a1Range(tabName, fromRow, toRow, JOB_SHEET_COLUMNS.date, lastColumn);
    await batchUpdateValuesRaw(sheetId, [{ range, values }]);

    if (report.rowsWritten === 0) {
      report.startRow = fromRow;
      report.firstNo = place.lastNo + 1;
    }
    report.updatedRanges.push(range);
    report.rowsWritten += chunk.length;
    report.endRow = toRow;
    report.lastNo = place.lastNo + chunk.length;
    report.unresolvedJobLinks += chunk.filter((row) => !row.link).length;
    place = { nextRow: toRow + 1, lastNo: place.lastNo + chunk.length };
  }
  return report;
}

/** A row's G to L: its six cells, padded or cut to six, or six blanks. */
function analysisCells(cells: SheetCellValue[] | undefined): SheetCellValue[] {
  return Array.from({ length: ANALYSIS_CELL_COUNT }, (_, index) => cells?.[index] ?? '');
}

/**
 * The rows a write is about to fill, read again (A:F) right before it: when
 * any holds something now - typed since the first read, or another export's -
 * the tab is read again (A:F, every row) and the rows move below its last
 * used one, the day's numbering going on from whatever is there now.
 */
async function claimFreeRows(
  sheetId: string,
  tabName: string,
  place: ExportPlace,
  count: number,
  today: string,
  gridRows: number | null
): Promise<ExportPlace> {
  let current = place;
  for (let attempt = 0; attempt < EXPORT_PLACE_ATTEMPTS; attempt += 1) {
    const lastRow = current.nextRow + count - 1;
    // Rows past the grid hold nothing, and Google refuses a read of them.
    const readTo = gridRows === null ? lastRow : Math.min(lastRow, gridRows);
    if (readTo < current.nextRow) return current;
    const [target = []] = await batchGetValues(sheetId, [
      a1Range(tabName, current.nextRow, readTo, JOB_SHEET_COLUMNS.date, JOB_SHEET_COLUMNS.jobDescription),
    ]);
    if (target.every((row) => (row ?? []).every((cell) => String(cell ?? '').trim() === ''))) return current;
    const [grid = []] = await batchGetValues(sheetId, [
      a1Columns(tabName, JOB_SHEET_COLUMNS.date, JOB_SHEET_COLUMNS.jobDescription),
    ]);
    const now = exportPlaceOf(grid, today);
    current = { nextRow: Math.max(now.nextRow, current.nextRow + 1), lastNo: Math.max(now.lastNo, current.lastNo) };
  }
  throw new PublicError(
    'Your job sheet kept changing while the jobs were being written, so the rest were not exported. Try again.',
    { status: 409, code: 'sheet-changed' }
  );
}
