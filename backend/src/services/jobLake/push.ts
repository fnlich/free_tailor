import { jobLakePushMaxRows } from '../../config/operational';
import { getJobAnalysisById } from '../../database/jobAnalysisRepository';
import { listLakeForPush, type LakeEntry, type LakeFilters } from '../../database/jobLakeRepository';
import {
  a1Range,
  batchUpdateSpreadsheet,
  batchUpdateValuesRaw,
  inspectJobSheetTab,
  isJobSheetTab,
  JOB_SHEET_FIRST_DATA_ROW,
  JOB_SHEET_HEADERS,
  jobRowLayoutRequests,
  verifyJobSheetTab,
  type JobSheetTabInspection,
  type SheetCellValue,
  type VerifiedJobSheetTab,
} from '../../integrations/googleSheets';
import { PublicError } from '../../middleware/publicError';
import type { UserAccount } from '../../types/account';
import {
  describeConflict,
  ensureAccountSheet,
  resolveAddressableSheet,
  sheetDateSerial,
  sheetDateText,
  TEMP_TAB,
} from '../sheets/accountSheet';
import { analysisColumnValues, descriptionCell, forgetTabWriteBacks } from '../sheets/analysisColumns';

/**
 * Push to Google Sheet (Admin -> Job Lake, owner decision L1): the lake jobs
 * a filter matches - the same filters as the page's Search - written into the
 * PUSHING administrator's own Temp For AI tab, replacing what it held. Never
 * another account's sheet, never another tab: the spreadsheet is the one
 * `ensureAccountSheet` allocated to the administrator, and the tab is named
 * here, not by the request.
 *
 * In order, refusing before anything is written:
 *
 *  1. one push per administrator at a time (409 `push-in-progress`);
 *  2. the administrator's sheet, its two tabs checked with Google
 *     (`verifyTab`), so a Temp For AI deleted or renamed since is put back -
 *     and a tab of the person's own that holds the name is refused with the
 *     Job Sheet page's own clash sentence (409 `tab-name-clash`);
 *  3. Temp For AI read once, and refused unless it is a job tab (409
 *     `not-job-tab`: its row 1 is not the job header) - then verified on that
 *     read, so its protection over G:L is in place before anything is written
 *     under it;
 *  4. ONE `:batchUpdate`: the grid grown to hold every row, A:L of every row
 *     below the header emptied - values AND background, so a duplicate's red
 *     paint does not stay on a row that now holds another job - and the rows
 *     laid out again (21 px, clipped, the Date column a date). Never the
 *     header, never a column past L;
 *  5. the rows, newest first, written RAW in chunks of at most
 *     `PUSH_WRITE_MAX_ROWS` rows and about `PUSH_WRITE_MAX_BYTES` each.
 *
 * Each row is A:L of the job layout: Date (the day the lake row was added or
 * last replaced, in SHEET_TIMEZONE, as a real date), NO(DATE) (1, 2, 3 ...
 * down the rows of each day), Company, Job Title, Job Link, Job Description
 * (cut at Google's 50,000 characters, with the Analysis cell's marker -
 * analysisColumns.ts's `descriptionCell`), and the six analysis cells exactly
 * as a build's write-back puts them there (`analysisColumnValues`) for the
 * row's stored analysis - blank when it has none. So a build from Temp For AI
 * reads each row's analysis from its own Analysis cell, which names the
 * stored analysis of that very posting, and asks no model (sheet first, P7) -
 * a cut description included, with no link to tie it: the cut copy is
 * matched to the analysis the cell names exactly as it was cut
 * (`isAnalysisOfPosting`).
 *
 * The rows are at most JOB_LAKE_PUSH_MAX_ROWS, the newest; the answer says
 * how many matched and whether the cap cut them.
 */

/** No more rows than this in one values write. */
export const PUSH_WRITE_MAX_ROWS = 200;
/**
 * And about this much JSON in one: a row can carry a 50,000-character
 * description and an Analysis cell as long, and Google refuses a request
 * body past a few megabytes. One row bigger than this still goes, alone.
 */
export const PUSH_WRITE_MAX_BYTES = 1_500_000;

/** The Google calls a push makes, as a seam the tests drive with a fake. */
export type LakePushSheetsClient = {
  inspectTab(spreadsheetId: string, tabName: string): Promise<JobSheetTabInspection>;
  /** `known`: the inspection just made, so the verify does not read the tab again. */
  verifyTab(spreadsheetId: string, tabName: string, known?: JobSheetTabInspection): Promise<VerifiedJobSheetTab>;
  batchUpdate(spreadsheetId: string, requests: Array<Record<string, unknown>>): Promise<void>;
  writeRaw(spreadsheetId: string, data: Array<{ range: string; values: SheetCellValue[][] }>): Promise<void>;
};

const realClient: LakePushSheetsClient = {
  inspectTab: (spreadsheetId, tabName) => inspectJobSheetTab(spreadsheetId, tabName),
  // Only a job tab is touched: one that is not is refused before this is reached.
  verifyTab: (spreadsheetId, tabName, known) => verifyJobSheetTab(spreadsheetId, tabName, known),
  batchUpdate: (spreadsheetId, requests) => batchUpdateSpreadsheet(spreadsheetId, requests),
  writeRaw: (spreadsheetId, data) => batchUpdateValuesRaw(spreadsheetId, data),
};

let client: LakePushSheetsClient = realClient;

/** Swaps the Google calls for a fake; call with no argument to put the real ones back. */
export function setLakePushSheetsClientForTests(next?: LakePushSheetsClient): void {
  client = next ?? realClient;
}

export type LakePushResult = {
  /** Rows written into Temp For AI. */
  pushed: number;
  /** Lake jobs the filters matched, before the cap. */
  matched: number;
  /** True when more matched than `maxRows`: the newest `maxRows` were pushed. */
  capped: boolean;
  /** The cap in effect (JOB_LAKE_PUSH_MAX_ROWS). */
  maxRows: number;
  /** `Temp For AI`. */
  tabName: string;
  /** A link that opens the tab. */
  tabUrl: string;
};

/** The administrators with a push going, by account id. */
const pushing = new Set<string>();

/** Why Temp For AI cannot take a push although its name is the app's: its row 1 is not the job header. */
export function tempTabNotJobTabSentence(): string {
  return (
    `"${TEMP_TAB}" in your job sheet is not laid out as a job tab any more (its first row is not the job header), ` +
    `so nothing was pushed into it. Rename or delete that tab in Google Sheets, then push again: a new ${TEMP_TAB} ` +
    'tab is added.'
  );
}

function notJobTab(): PublicError {
  return new PublicError(tempTabNotJobTabSentence(), { status: 409, code: 'not-job-tab' });
}

/**
 * Writes the lake jobs `filters` match into `admin`'s own Temp For AI tab,
 * replacing what it held, and says what it did. The caller is an
 * administrator (routes/jobLake.ts is behind requireAdmin).
 */
export async function pushLakeToSheet(admin: UserAccount, filters: LakeFilters): Promise<LakePushResult> {
  if (pushing.has(admin.id)) {
    throw new PublicError('A push to your Temp For AI tab is already going. Wait for it to finish first.', {
      status: 409,
      code: 'push-in-progress',
    });
  }
  pushing.add(admin.id);
  try {
    return await push(admin, filters);
  } finally {
    pushing.delete(admin.id);
  }
}

async function push(admin: UserAccount, filters: LakeFilters): Promise<LakePushResult> {
  // The administrator's own sheet, its two tabs looked at with Google: a
  // push is several calls deep anyway, and one to a tab deleted since would
  // fail after the clear.
  const state = await ensureAccountSheet(admin, { verifyTab: true });
  const spreadsheetId = await resolveAddressableSheet(admin, undefined, state);
  if (!state.tempTabUrl) {
    throw new PublicError(describeConflict([TEMP_TAB], 'push again').message, { status: 409, code: 'tab-name-clash' });
  }

  const inspection = await client.inspectTab(spreadsheetId, TEMP_TAB);
  if (!isJobSheetTab(inspection)) throw notJobTab();
  const verified = await client.verifyTab(spreadsheetId, TEMP_TAB, inspection);
  if (verified.jobTab === false) throw notJobTab();
  const gid = verified.gid;

  const maxRows = jobLakePushMaxRows();
  const { rows, matched, capped } = listLakeForPush(filters, maxRows);
  const values = pushRowValues(rows);

  // ONE call before any value: room for every row, A:L below the header
  // emptied (values and paint), the rows laid out.
  const requests: Array<Record<string, unknown>> = [];
  const needed = JOB_SHEET_FIRST_DATA_ROW - 1 + values.length;
  let gridRows = inspection.rowCount;
  if (gridRows !== undefined && gridRows < needed) {
    requests.push({ appendDimension: { sheetId: gid, dimension: 'ROWS', length: needed - gridRows } });
    gridRows = needed;
  }
  // A grid of the header alone has no data row to empty, and Google refuses
  // a range that starts past its last row.
  if (gridRows === undefined || gridRows >= JOB_SHEET_FIRST_DATA_ROW) requests.push(clearDataRowsRequest(gid));
  requests.push(...jobRowLayoutRequests(gid));
  await client.batchUpdate(spreadsheetId, requests);
  // What the analysis write-backs settled in this tab is about rows that are gone.
  forgetTabWriteBacks(spreadsheetId, TEMP_TAB);

  let row = JOB_SHEET_FIRST_DATA_ROW;
  for (const chunk of pushChunks(values)) {
    const range = a1Range(TEMP_TAB, row, row + chunk.length - 1, 1, JOB_SHEET_HEADERS.length);
    await client.writeRaw(spreadsheetId, [{ range, values: chunk }]);
    row += chunk.length;
  }

  console.log(
    `[lake] ${admin.email} pushed ${values.length} of ${matched} matching job(s) into "${TEMP_TAB}" of ${spreadsheetId}` +
      `${capped ? ` (cut at JOB_LAKE_PUSH_MAX_ROWS=${maxRows})` : ''}.`
  );
  return {
    pushed: values.length,
    matched,
    capped,
    maxRows,
    tabName: TEMP_TAB,
    tabUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${gid}`,
  };
}

/**
 * Empties A:L of every row below the header - the values and the background,
 * nothing else of the format, never the header row and never a column past L
 * (a person's own columns there stay as they are). No end row: the whole grid.
 */
export function clearDataRowsRequest(gid: number): Record<string, unknown> {
  return {
    updateCells: {
      range: {
        sheetId: gid,
        startRowIndex: JOB_SHEET_FIRST_DATA_ROW - 1,
        startColumnIndex: 0,
        endColumnIndex: JOB_SHEET_HEADERS.length,
      },
      fields: 'userEnteredValue,userEnteredFormat.backgroundColor',
    },
  };
}

/**
 * The A:L values of each lake row, in the order given (newest first). NO(DATE)
 * counts each day's rows from 1 down the sheet; the Date is the day of
 * `updated_at` as the job sheet's own dates are, in SHEET_TIMEZONE, sent as
 * the serial number the column's date format shows.
 */
export function pushRowValues(entries: LakeEntry[]): SheetCellValue[][] {
  const perDay = new Map<string, number>();
  return entries.map((entry) => {
    const day = sheetDateText(new Date(entry.updatedAt));
    const no = (perDay.get(day) ?? 0) + 1;
    perDay.set(day, no);
    const stored = entry.analysisId ? getJobAnalysisById(entry.analysisId) : null;
    const analysis: SheetCellValue[] = stored ? analysisColumnValues(stored) : ['', '', '', '', '', ''];
    return [
      sheetDateSerial(day) ?? day,
      no,
      entry.company,
      entry.title,
      entry.url,
      descriptionCell(entry.jobDescription ?? ''),
      ...analysis,
    ];
  });
}

/** The rows in writes of at most PUSH_WRITE_MAX_ROWS rows and about PUSH_WRITE_MAX_BYTES of JSON. */
export function pushChunks(rows: SheetCellValue[][]): SheetCellValue[][][] {
  const chunks: SheetCellValue[][][] = [];
  let current: SheetCellValue[][] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8');
    if (current.length > 0 && (current.length >= PUSH_WRITE_MAX_ROWS || bytes + size > PUSH_WRITE_MAX_BYTES)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Tests share one process: a push left marked would refuse the next test's. */
export function resetLakePushForTests(): void {
  pushing.clear();
}
