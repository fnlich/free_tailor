import {
  a1Range,
  ANALYSIS_FIRST_COLUMN,
  ANALYSIS_LAST_COLUMN,
  batchGetValues,
  batchUpdateValuesRaw,
  JOB_SHEET_COLUMNS,
  protectionTrusted,
  verifyJobSheetTab,
  type SheetCellValue,
  type VerifiedJobSheetTab,
} from '../../integrations/googleSheets';
import { industryLabel } from '../../config/industries';
import { jobFieldLabel } from '../../config/jobFields';
import { getUserBySheetId } from '../../database/userRepository';
import { getJobAnalysisById, type StoredJobAnalysis } from '../../database/jobAnalysisRepository';
import { clearanceRequiredOf, formatSalary, industryOf, jobTypeLabel, jobTypeOf } from '../jobAnalysis/facts';
import { contentHash, linkKey, postingKeysOf, samePosting, type PostingKeys } from '../jobAnalysis/identity';

/**
 * The six analysis columns of an app sheet's job tab, G to L (owner decision
 * S3): Job Field, Salary, Job Type, Clearance, Industry, Analysis - after the
 * six a person fills, protected so only the server's own Google identity can
 * edit them. The first five are the analysis's facts as a person reads them;
 * the Analysis cell is the whole analysis, which is what a later build reads
 * back instead of asking a model (P7).
 *
 * Two directions:
 *
 *  - READ, at a batch's submission (`readAnalysisRows`): one batched read of
 *    the submitted rows' identity and analysis cells, after the tab's
 *    protection is verified. A row whose Analysis cell names the stored
 *    analysis of the posting the row holds NOW skips the analysis altogether
 *    (P7), and the next stage uses that stored analysis - but only when the
 *    protection was found intact in this run (a protection that had to be put
 *    back is restored with the Analysis column cleared, see
 *    `verifyJobSheetTab`). A row's posting can be replaced, or rows sorted
 *    under the protected columns, and the cell left behind names another
 *    posting's analysis; a cell can name one this store never held. Neither
 *    is used (`cellIsForPosting`), and the cell's own content never is.
 *  - WRITE, once per row and posting (`queueAnalysisWriteBack`): when a row's
 *    posting is analysed - or found already analysed in the store - its cells
 *    are filled, batched with the other rows due in the same spreadsheet,
 *    values RAW. The row is read again first, and skipped when its company or
 *    link no longer match (somebody sorted or deleted rows since) or its
 *    Analysis cell already holds this posting's analysis (another task, or
 *    another process, wrote it). A cell the program wrote for ANOTHER posting
 *    is replaced - the program is the only writer of these cells, so it is
 *    the only thing that can put them right. Best-effort: a failure is logged
 *    and never fails a resume; the next run on the row finds the posting in
 *    the store and writes it then.
 *
 * Only the app's OWN sheets get any of this - a spreadsheet allocated to an
 * account, which the server's identity owns and can protect - and in them
 * only the job tabs (`isJobSheetTab`): any other tab - one the person made
 * for themselves - keeps its header and its columns, and is neither read for
 * an analysis nor written.
 */

/** Google's limit on one cell. The Analysis cell is cut to fit, with a marker. */
export const ANALYSIS_CELL_LIMIT = 50_000;
export const ANALYSIS_TRUNCATED_MARKER = ' ...[cut at 50,000 characters]';

/**
 * A posting's text as the program writes it into a sheet cell (Push to Google
 * Sheet's Job Description): whole, or cut at Google's limit with the Analysis
 * cell's marker. Never through the middle of a character spelled with two
 * code units (an emoji): half of one is not well-formed text, with no promise
 * of reading back as it was sent, and the cut copy must read back exactly as
 * cut - it is how a row with no link is known for its posting
 * (`isAnalysisOfPosting`).
 */
export function descriptionCell(text: string): string {
  if (text.length <= ANALYSIS_CELL_LIMIT) return text;
  let end = ANALYSIS_CELL_LIMIT - ANALYSIS_TRUNCATED_MARKER.length;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end) + ANALYSIS_TRUNCATED_MARKER;
}

/** The version of the Analysis cell's JSON shape. */
const CELL_VERSION = 1;

/**
 * The Google calls this module makes, as a seam - the tests drive the read,
 * the trust rule and the write-back against a fake, with no network.
 */
export type AnalysisSheetsClient = {
  verifyTab(spreadsheetId: string, tabName: string): Promise<VerifiedJobSheetTab>;
  readRanges(spreadsheetId: string, ranges: string[]): Promise<string[][][]>;
  writeRaw(spreadsheetId: string, data: Array<{ range: string; values: Array<Array<SheetCellValue>> }>): Promise<void>;
};

const realClient: AnalysisSheetsClient = {
  // Only a job tab is touched: any other tab is not re-headered, protected or cleared.
  verifyTab: (spreadsheetId, tabName) => verifyJobSheetTab(spreadsheetId, tabName),
  readRanges: (spreadsheetId, ranges) => batchGetValues(spreadsheetId, ranges),
  writeRaw: (spreadsheetId, data) => batchUpdateValuesRaw(spreadsheetId, data),
};

let client: AnalysisSheetsClient = realClient;

/** Swaps the Google calls for a fake; call with no argument to put the real ones back. */
export function setAnalysisSheetsClientForTests(next?: AnalysisSheetsClient): void {
  client = next ?? realClient;
}

/**
 * Whether a spreadsheet is one this app allocated to an account - and so owned
 * by the server's identity, which is what makes its protection mean anything.
 */
export function isAppOwnedSheet(spreadsheetId: unknown): boolean {
  return typeof spreadsheetId === 'string' && Boolean(spreadsheetId.trim()) && getUserBySheetId(spreadsheetId) !== null;
}

/* ------------------------------------------------------------- the cells -- */

/**
 * The Analysis cell: the stored analysis as JSON, naming its stored row - the
 * one thing a later read trusts it for (`cellIsForPosting`), and readable even
 * when the cell had to be cut - and the keys of the posting it was made for
 * (its text hash and link key), for a person, or a page, telling it from a
 * cell left by the posting that sat in the row before. Without the posting's
 * text, which is the row's own Job Description cell. The analysis goes last,
 * so a cut takes only the end of it.
 */
export function analysisCellText(stored: StoredJobAnalysis): string {
  const { sourceJobDescription: _text, ...analysis } = stored.analysis;
  const text = JSON.stringify({
    v: CELL_VERSION,
    id: stored.id,
    posting: { hash: stored.contentHash ?? null, link: stored.linkKey ?? null },
    jobField: stored.jobFieldId,
    analysis,
  });
  if (text.length <= ANALYSIS_CELL_LIMIT) return text;
  return text.slice(0, ANALYSIS_CELL_LIMIT - ANALYSIS_TRUNCATED_MARKER.length) + ANALYSIS_TRUNCATED_MARKER;
}

/**
 * The six cells, G to L: Job Field, Salary, Job Type (Remote, Hybrid, Onsite,
 * or '' when the posting does not say), Clearance as a real TRUE/FALSE (TRUE
 * for any clearance the posting requires, an unknown one included), Industry,
 * and the Analysis cell. Every one is written, so a row's six always come
 * from one analysis. The facts are worked out from the stored analysis as it
 * is read (`facts.ts`) - an analysis from before Industry existed is never
 * asked for it again.
 */
export function analysisColumnValues(stored: StoredJobAnalysis): SheetCellValue[] {
  return [
    jobFieldLabel(stored.jobFieldId),
    formatSalary(stored.analysis.salary),
    jobTypeLabel(jobTypeOf(stored.analysis)),
    clearanceRequiredOf(stored.analysis),
    industryLabel(industryOf(stored.analysis)),
    analysisCellText(stored),
  ];
}

export type ParsedAnalysisCell =
  | { state: 'empty' }
  | { state: 'ok'; analysisId?: string; posting?: Partial<PostingKeys>; analysis: Record<string, unknown> }
  | { state: 'truncated' | 'unparseable'; analysisId?: string };

/** The posting keys a cell records, or nothing for a cell that records none (or junk). */
function cellPosting(value: unknown): Partial<PostingKeys> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const hash = typeof source.hash === 'string' && /^[0-9a-f]{64}$/.test(source.hash) ? source.hash : null;
  const link = typeof source.link === 'string' && source.link ? source.link : null;
  return hash || link ? { hash, link } : undefined;
}

/** The stored row an Analysis cell names, read off its start - which survives the cell being cut. */
function namedId(text: string): string | undefined {
  const match = /^\{"v":\d+,"id":"([0-9a-fA-F-]{8,64})"/.exec(text);
  return match?.[1];
}

/**
 * What an Analysis cell holds: nothing, a usable analysis, or something that
 * cannot be used as one - cut at Google's limit, or not this program's JSON.
 * A cell that cannot be used still names its stored row when its start is
 * intact, so the store can answer for it without a model.
 */
export function parseAnalysisCell(text: unknown): ParsedAnalysisCell {
  const cell = typeof text === 'string' ? text.trim() : '';
  if (!cell) return { state: 'empty' };
  const analysisId = namedId(cell);
  if (cell.endsWith(ANALYSIS_TRUNCATED_MARKER.trim())) return { state: 'truncated', ...(analysisId ? { analysisId } : {}) };
  try {
    const parsed = JSON.parse(cell) as { v?: unknown; id?: unknown; posting?: unknown; analysis?: unknown };
    if (!parsed || typeof parsed !== 'object' || !parsed.analysis || typeof parsed.analysis !== 'object') {
      return { state: 'unparseable', ...(analysisId ? { analysisId } : {}) };
    }
    const posting = cellPosting(parsed.posting);
    return {
      state: 'ok',
      ...(typeof parsed.id === 'string' && parsed.id.trim() ? { analysisId: parsed.id.trim() } : {}),
      ...(posting ? { posting } : {}),
      analysis: parsed.analysis as Record<string, unknown>,
    };
  } catch {
    return { state: 'unparseable', ...(analysisId ? { analysisId } : {}) };
  }
}

/**
 * Whether an Analysis cell names the STORED analysis of one of these postings
 * (their keys, `postingKeysOf`), by link or by text - or by the cut copy of
 * its text a cell holds (`isAnalysisOfPosting`). Nothing else makes a
 * cell any posting's: a cell naming an analysis this store does not have -
 * another install's, a backup's, or text that only looks like the program's
 * (a formula spilled into the column, a row pasted in) - is nobody's, whatever
 * posting keys it records. Those keys are for a person reading the cell.
 *
 * What stops a row from being built on the analysis of the posting that sat
 * in it before: the protected columns cannot be cleared by the person, and a
 * replaced or re-sorted row keeps them.
 */
export function cellIsForPosting(cell: ParsedAnalysisCell, ...postings: Array<Partial<PostingKeys>>): boolean {
  if (cell.state === 'empty' || !cell.analysisId) return false;
  const named = getJobAnalysisById(cell.analysisId);
  if (!named) return false;
  return postings.some((posting) => isAnalysisOfPosting(named, posting));
}

/**
 * The text hash of a stored analysis's posting as a sheet cell holds it, when
 * a cell cannot hold it whole: a posting longer than Google's 50,000
 * characters goes into a cell cut, with the marker (`descriptionCell` - Push
 * to Google Sheet writes a lake job's description so), and the cut copy
 * hashes differently from the text the analysis was stored under. Null for a
 * posting a cell holds whole, whose own hash is the one to compare.
 */
export function cellCopyHash(stored: StoredJobAnalysis): string | null {
  const text = stored.analysis.sourceJobDescription ?? '';
  return text.length > ANALYSIS_CELL_LIMIT ? contentHash(descriptionCell(text)) : null;
}

/**
 * Whether a stored analysis is the one of this posting (its keys,
 * `postingKeysOf`): by link or by text, as the store's lookups match - or as
 * the cut copy of its text the program wrote into a sheet cell
 * (`cellCopyHash`), which a row with no link is known by and nothing else.
 * The copy is matched only exactly as cut: a cut description edited since is
 * another posting. Only ever asked of an analysis the caller already holds -
 * the one a row's cell names, or a page names - so it is never a way to FIND
 * an analysis: the store has no key for a cut copy.
 */
export function isAnalysisOfPosting(stored: StoredJobAnalysis, posting: Partial<PostingKeys>): boolean {
  if (samePosting({ hash: stored.contentHash, link: stored.linkKey }, posting)) return true;
  return Boolean(posting.hash) && posting.hash === cellCopyHash(stored);
}

/** Company names compared as a person would: case and spacing forgiven. */
export function sameCompany(a: unknown, b: unknown): boolean {
  const fold = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : '');
  return fold(a) === fold(b);
}

/** Two job links are the same link when their identities are, or both are empty. */
export function sameLink(a: unknown, b: unknown): boolean {
  const left = linkKey(a);
  const right = linkKey(b);
  if (left || right) return left === right;
  const raw = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  return raw(a) === raw(b);
}

/** Rows as runs of consecutive numbers, so a From/To selection is one range, not one per row. */
export function rowRuns(rows: number[]): Array<[number, number]> {
  const sorted = [...new Set(rows.filter((row) => Number.isInteger(row) && row > 0))].sort((a, b) => a - b);
  const runs: Array<[number, number]> = [];
  for (const row of sorted) {
    const last = runs[runs.length - 1];
    if (last && row === last[1] + 1) last[1] = row;
    else runs.push([row, row]);
  }
  return runs;
}

/* -------------------------------------------------------------- reading -- */

export type SheetRowCells = {
  row: number;
  company: string;
  link: string;
  /** The Analysis cell, as text. */
  analysisCell: string;
};

export type SheetAnalysisRead = {
  /** The verify of the tab, or null when it failed (and nothing in it is trusted). */
  verified: VerifiedJobSheetTab | null;
  /** True only when the protection was found intact in this run. */
  trusted: boolean;
  /**
   * False for a tab the app never laid out as a job tab: nothing in it was
   * read, and nothing is written into it. True when the verify said it is one,
   * or could not say (the write-back verifies again before it writes).
   */
  jobTab: boolean;
  rows: Map<number, SheetRowCells>;
};

/**
 * Verifies the tab, then reads the submitted rows' Company and Job Link and
 * their six analysis cells in ONE batched call - two ranges per run of
 * consecutive rows, C:E and G:L. Never throws: a sheet that cannot be read is a
 * run without sheet-first, and every row falls back to the store, then to one
 * analysis.
 */
export async function readAnalysisRows(spreadsheetId: string, tabName: string, rows: number[]): Promise<SheetAnalysisRead> {
  const result: SheetAnalysisRead = { verified: null, trusted: false, jobTab: true, rows: new Map() };
  const runs = rowRuns(rows);
  if (runs.length === 0) return result;

  try {
    result.verified = await client.verifyTab(spreadsheetId, tabName);
    result.trusted = protectionTrusted(result.verified);
    if (result.verified.jobTab === false) {
      result.jobTab = false;
      console.log(
        `[sheets] "${tabName}" in ${spreadsheetId} is not laid out as a job tab (a tab of the person's own); its ` +
          'columns are left as they are, and its postings are analysed from the store instead.'
      );
      return result;
    }
    forgetClearedTab(spreadsheetId, tabName, result.verified);
  } catch (error) {
    console.warn(
      `[sheets] Could not verify "${tabName}" in ${spreadsheetId} before reading its analysis cells; none of them ` +
        'is used in this run.',
      error
    );
  }

  try {
    const ranges = runs.flatMap(([from, to]) => [
      a1Range(tabName, from, to, JOB_SHEET_COLUMNS.company, JOB_SHEET_COLUMNS.jobLink),
      a1Range(tabName, from, to, ANALYSIS_FIRST_COLUMN, ANALYSIS_LAST_COLUMN),
    ]);
    const grids = await client.readRanges(spreadsheetId, ranges);
    runs.forEach(([from, to], runIndex) => {
      const identity = grids[runIndex * 2] ?? [];
      const analysis = grids[runIndex * 2 + 1] ?? [];
      for (let row = from; row <= to; row += 1) {
        const offset = row - from;
        const cells = identity[offset] ?? [];
        result.rows.set(row, {
          row,
          company: cells[JOB_SHEET_COLUMNS.company - JOB_SHEET_COLUMNS.company] ?? '',
          link: cells[JOB_SHEET_COLUMNS.jobLink - JOB_SHEET_COLUMNS.company] ?? '',
          analysisCell: analysis[offset]?.[JOB_SHEET_COLUMNS.analysis - ANALYSIS_FIRST_COLUMN] ?? '',
        });
      }
    });
  } catch (error) {
    console.warn(
      `[sheets] Could not read the analysis cells of "${tabName}" in ${spreadsheetId}; this run analyses from the ` +
        'store instead.',
      error
    );
    result.rows.clear();
    result.trusted = false;
  }
  return result;
}

/* ------------------------------------------------------------- writing -- */

export type WriteBackEntry = {
  spreadsheetId: string;
  tabName: string;
  row: number;
  /** What the row said when it was submitted - checked again before writing. */
  companyName: string;
  jobLink?: string;
  /** The row's posting text, when the caller has it: with the link, which posting a cell already there is for. */
  jobDescription?: string;
  stored: StoredJobAnalysis;
};

export type WriteBackReport = {
  written: number;
  skipped: number;
  failed: number;
  /** The spreadsheets a write failed in, so a caller can tell whether its own did. */
  failedSpreadsheets: string[];
};

/** How long a write-back waits for others in the same spreadsheet before it goes. */
const WRITE_BACK_DELAY_MS = 1_500;
/** No more rows than this in one call. */
const WRITE_BACK_MAX_ROWS = 100;

const pending = new Map<string, WriteBackEntry>();
/**
 * Rows written with an analysis, or found already holding it, in this process
 * - keyed on the row AND the analysis, so a sibling task never queues the same
 * one again, while a different posting that later lands in the row (a sort, a
 * replaced posting) is still written there. A row skipped because it had
 * become another posting's is not settled at all.
 */
const settled = new Set<string>();
/** More than this and the set starts again: it only spares Google a read, and every write re-reads its row. */
const SETTLED_LIMIT = 20_000;
let timer: NodeJS.Timeout | null = null;
let flushing: Promise<WriteBackReport> = Promise.resolve({ written: 0, skipped: 0, failed: 0, failedSpreadsheets: [] });

function tabKey(entry: Pick<WriteBackEntry, 'spreadsheetId' | 'tabName'>): string {
  return `${entry.spreadsheetId}\u0000${entry.tabName}\u0000`;
}

function rowKey(entry: Pick<WriteBackEntry, 'spreadsheetId' | 'tabName' | 'row'>): string {
  return `${tabKey(entry)}${entry.row}`;
}

function settledKey(entry: Pick<WriteBackEntry, 'spreadsheetId' | 'tabName' | 'row' | 'stored'>): string {
  return `${rowKey(entry)}\u0000${entry.stored.id}`;
}

function settle(entry: WriteBackEntry): void {
  if (settled.size >= SETTLED_LIMIT) settled.clear();
  settled.add(settledKey(entry));
}

/**
 * A verify that had to put the protection back cleared the tab's Analysis
 * column, so nothing in it is written any more: its rows are forgotten, and
 * the next run on each writes it again.
 */
function forgetClearedTab(spreadsheetId: string, tabName: string, verified: Pick<VerifiedJobSheetTab, 'protection'>): void {
  if (verified.protection !== 'missing' && verified.protection !== 'altered') return;
  const prefix = tabKey({ spreadsheetId, tabName });
  for (const key of settled) if (key.startsWith(prefix)) settled.delete(key);
}

/**
 * Forgets every row of a tab this process settled, and drops the write-backs
 * waiting for it: the tab's rows were replaced wholesale (Push to Google
 * Sheet), so what was settled there describes rows that are gone, and a row
 * that later holds the same posting again must still be written.
 */
export function forgetTabWriteBacks(spreadsheetId: string, tabName: string): void {
  const prefix = tabKey({ spreadsheetId, tabName });
  for (const key of settled) if (key.startsWith(prefix)) settled.delete(key);
  for (const key of pending.keys()) if (key.startsWith(prefix)) pending.delete(key);
}

/**
 * Asks for a row's analysis cells to be filled, once. Returns whether it was
 * queued: false for a sheet the app does not own, a row already waiting for a
 * write, or a row already settled with this analysis in this process (the
 * first task that obtained the analysis queued it; the others see it done).
 */
export function queueAnalysisWriteBack(entry: WriteBackEntry): boolean {
  if (!Number.isInteger(entry.row) || entry.row < 2) return false;
  if (!isAppOwnedSheet(entry.spreadsheetId)) return false;
  const key = rowKey(entry);
  if (pending.has(key) || settled.has(settledKey(entry))) return false;
  pending.set(key, entry);
  if (pending.size >= WRITE_BACK_MAX_ROWS) {
    void flushAnalysisWriteBacks();
  } else if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      void flushAnalysisWriteBacks();
    }, WRITE_BACK_DELAY_MS);
    // A pending write-back must not keep a stopping process alive.
    timer.unref?.();
  }
  return true;
}

/**
 * Writes everything queued, now. Spreadsheets one after another, each in at
 * most three calls whatever the number of rows: verify the tab (the
 * protection goes on before the first write), read the rows' identity and
 * Analysis cells, write the cells. Serialised with any flush already running.
 */
export function flushAnalysisWriteBacks(): Promise<WriteBackReport> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const batch = [...pending.values()];
  pending.clear();
  flushing = flushing.then(() => writeAll(batch));
  return flushing;
}

async function writeAll(entries: WriteBackEntry[]): Promise<WriteBackReport> {
  const report: WriteBackReport = { written: 0, skipped: 0, failed: 0, failedSpreadsheets: [] };
  const groups = new Map<string, WriteBackEntry[]>();
  for (const entry of entries) {
    const key = `${entry.spreadsheetId}\u0000${entry.tabName}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  for (const group of groups.values()) {
    for (let start = 0; start < group.length; start += WRITE_BACK_MAX_ROWS) {
      const slice = group.slice(start, start + WRITE_BACK_MAX_ROWS);
      try {
        const outcome = await writeGroup(slice);
        report.written += outcome.written;
        report.skipped += outcome.skipped;
      } catch (error) {
        report.failed += slice.length;
        const { spreadsheetId, tabName } = slice[0];
        if (!report.failedSpreadsheets.includes(spreadsheetId)) report.failedSpreadsheets.push(spreadsheetId);
        console.warn(
          `[sheets] Could not write the analysis of ${slice.length} row(s) back into "${tabName}" of ${spreadsheetId}; ` +
            'the analyses are stored, and the next run on these rows writes them.',
          error
        );
      }
    }
  }
  return report;
}

/** Whether a row's cell already holds the analysis of the entry's posting. */
function holdsEntrysAnalysis(cell: ParsedAnalysisCell, entry: WriteBackEntry): boolean {
  if (cell.state !== 'empty' && cell.analysisId === entry.stored.id) return true;
  return cellIsForPosting(
    cell,
    { hash: entry.stored.contentHash, link: entry.stored.linkKey },
    postingKeysOf({ jd: entry.jobDescription, link: entry.jobLink })
  );
}

async function writeGroup(unordered: WriteBackEntry[]): Promise<{ written: number; skipped: number }> {
  // Down the sheet, whichever task obtained its analysis first.
  const entries = [...unordered].sort((a, b) => a.row - b.row);
  const { spreadsheetId, tabName } = entries[0];
  // Before the first write into the tab: its protection is put back if it
  // went (clearing its Analysis cells), so what is about to be written is the
  // program's alone - and a tab that is not a job tab is not written at all.
  const verified = await client.verifyTab(spreadsheetId, tabName);
  if (verified.jobTab === false) {
    for (const entry of entries) settle(entry);
    return { written: 0, skipped: entries.length };
  }
  forgetClearedTab(spreadsheetId, tabName, verified);

  // All six analysis cells, not only Analysis: a row holding anything in G
  // to K while its Analysis cell is empty - anything but this posting's own
  // facts, which a protection repair clearing L leaves behind - was not
  // written by the program (it writes all six at once), and is left as it is
  // rather than written over: the protection was off when somebody typed it.
  const runs = rowRuns(entries.map((entry) => entry.row));
  const ranges = runs.flatMap(([from, to]) => [
    a1Range(tabName, from, to, JOB_SHEET_COLUMNS.company, JOB_SHEET_COLUMNS.jobLink),
    a1Range(tabName, from, to, ANALYSIS_FIRST_COLUMN, ANALYSIS_LAST_COLUMN),
  ]);
  const grids = await client.readRanges(spreadsheetId, ranges);
  const analysisOffset = JOB_SHEET_COLUMNS.analysis - ANALYSIS_FIRST_COLUMN;
  // What may hold somebody's own text: Job Field to Industry, G to K.
  const personal = new Set(
    [
      JOB_SHEET_COLUMNS.jobField,
      JOB_SHEET_COLUMNS.salary,
      JOB_SHEET_COLUMNS.jobType,
      JOB_SHEET_COLUMNS.clearance,
      JOB_SHEET_COLUMNS.industry,
    ].map((column) => column - ANALYSIS_FIRST_COLUMN)
  );
  const current = new Map<number, { company: string; link: string; cell: ParsedAnalysisCell; facts: string[] }>();
  runs.forEach(([from, to], runIndex) => {
    for (let row = from; row <= to; row += 1) {
      const identity = grids[runIndex * 2]?.[row - from] ?? [];
      const analysisCells = grids[runIndex * 2 + 1]?.[row - from] ?? [];
      current.set(row, {
        company: identity[0] ?? '',
        link: identity[JOB_SHEET_COLUMNS.jobLink - JOB_SHEET_COLUMNS.company] ?? '',
        cell: parseAnalysisCell(analysisCells[analysisOffset]),
        facts: [...personal].map((index) => String(analysisCells[index] ?? '').trim()),
      });
    }
  });
  /**
   * Somebody's own text in G to K: anything there that is not exactly what
   * this write would put there. The program's own five for this very posting
   * - left behind when a protection repair cleared L - are not.
   */
  const theirs = (facts: string[], values: SheetCellValue[]) =>
    facts.some((text, index) => text !== '' && text.toLowerCase() !== cellText(values[index]).toLowerCase());

  const data: Array<{ range: string; values: Array<Array<SheetCellValue>> }> = [];
  const done: WriteBackEntry[] = [];
  const writing = new Set<number>();
  let skipped = 0;
  for (const entry of entries) {
    const now = current.get(entry.row);
    if (!now || !sameCompany(now.company, entry.companyName) || (entry.jobLink && !sameLink(now.link, entry.jobLink))) {
      // Not settled: the posting that sits in the row now is written there
      // when a run obtains ITS analysis.
      skipped += 1;
      console.warn(
        `[sheets] Row ${entry.row} of "${tabName}" in ${spreadsheetId} is no longer ${entry.companyName}'s posting ` +
          '(rows were sorted or deleted since); its analysis is not written there.'
      );
      continue;
    }
    if (writing.has(entry.row)) {
      skipped += 1;
      continue;
    }
    const values = analysisColumnValues(entry.stored);
    if (now.cell.state === 'empty') {
      if (theirs(now.facts, values)) {
        // Something the program did not write - G to K filled with L empty
        // is never its own - is left as it is.
        skipped += 1;
        done.push(entry);
        continue;
      }
    } else if (holdsEntrysAnalysis(now.cell, entry)) {
      // Written already - by another task, another process.
      skipped += 1;
      done.push(entry);
      continue;
    } else if (!now.cell.analysisId) {
      // Not the program's JSON, in a tab whose protection could not be
      // confirmed: somebody's own text, not written over.
      skipped += 1;
      done.push(entry);
      continue;
    } else {
      // The program's cells for the posting that sat in this row before - or
      // cells in its shape naming an analysis this store never held: replaced
      // whole, by the analysis the store has for the row's posting.
      const known = getJobAnalysisById(now.cell.analysisId) !== null;
      console.log(
        `[sheets] Row ${entry.row} of "${tabName}" in ${spreadsheetId} held ${
          known ? 'the analysis of another posting' : 'an analysis this store does not have'
        } (${now.cell.analysisId}); writing ${entry.companyName}'s over it.`
      );
    }
    writing.add(entry.row);
    done.push(entry);
    data.push({
      range: a1Range(tabName, entry.row, entry.row, ANALYSIS_FIRST_COLUMN, ANALYSIS_LAST_COLUMN),
      values: [values],
    });
  }
  await client.writeRaw(spreadsheetId, data);
  // Settled only once Google took the write: a row whose write failed may be
  // queued again by the next task or run that obtains its analysis.
  for (const entry of done) settle(entry);
  return { written: data.length, skipped };
}

/** A cell value as a FORMATTED read gives it back: a boolean as TRUE / FALSE. */
function cellText(value: SheetCellValue | undefined): string {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return value === null || value === undefined ? '' : String(value).trim();
}

/** Tests share one process: queued rows, the timer and what was settled are forgotten. */
export function resetAnalysisWriteBacksForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  pending.clear();
  settled.clear();
  flushing = Promise.resolve({ written: 0, skipped: 0, failed: 0, failedSpreadsheets: [] });
}
