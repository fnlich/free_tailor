import {
  a1Range,
  ANALYSIS_FIRST_COLUMN,
  ANALYSIS_LAST_COLUMN,
  batchGetValues,
  batchUpdateValuesRaw,
  JOB_SHEET_COLUMNS,
  JOB_SHEET_HEADERS,
  protectionTrusted,
  verifyJobSheetTab,
  type VerifiedJobSheetTab,
} from '../../integrations/googleSheets';
import { jobFieldLabel } from '../../config/jobFields';
import { getUserBySheetId } from '../../database/userRepository';
import { getJobAnalysisById, type StoredJobAnalysis } from '../../database/jobAnalysisRepository';
import { formatSalary } from '../jobAnalysis/facts';
import { linkKey, postingKeysOf, samePosting, type PostingKeys } from '../jobAnalysis/identity';

/**
 * The six analysis columns of an app sheet (owner decision J5): Job Field,
 * Salary, Job Hash, Analyzed At, Lake Status, Analysis - after Filter Reason,
 * protected so only the server's own Google identity can edit them.
 *
 * Two directions:
 *
 *  - READ, at a batch's submission (`readAnalysisRows`): one batched read of
 *    the submitted rows' identity and analysis cells, after the tab's
 *    protection is verified. A row whose Analysis cell is filled skips the
 *    analysis altogether (P7), and what the next stage uses is the analysis
 *    READ FROM THE SHEET - but only when the protection was found intact in
 *    this run (a protection that had to be put back is restored with the
 *    Analysis column cleared, see `verifyJobSheetTab`), and only when the cell
 *    was written for the posting the row holds NOW: a row's posting can be
 *    replaced, or rows sorted under the protected columns, and the cell left
 *    behind is another posting's analysis (`cellIsForPosting`).
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
 * only the tabs laid out as job tabs (`isJobSheetTab`): sheet mode reads any
 * tab, and a tab the person made for themselves keeps its header and its
 * columns. An administrator's shared sources keep analyses in the database
 * only.
 */

/** Google's limit on one cell. The Analysis cell is cut to fit, with a marker. */
export const ANALYSIS_CELL_LIMIT = 50_000;
export const ANALYSIS_TRUNCATED_MARKER = ' ...[cut at 50,000 characters]';

/** The version of the Analysis cell's JSON shape. */
const CELL_VERSION = 1;

/**
 * The Google calls this module makes, as a seam - the tests drive the read,
 * the trust rule and the write-back against a fake, with no network.
 */
export type AnalysisSheetsClient = {
  verifyTab(spreadsheetId: string, tabName: string): Promise<VerifiedJobSheetTab>;
  readRanges(spreadsheetId: string, ranges: string[]): Promise<string[][][]>;
  writeRaw(spreadsheetId: string, data: Array<{ range: string; values: Array<Array<string | number | null>> }>): Promise<void>;
};

const realClient: AnalysisSheetsClient = {
  // Only a job tab is touched: a tab the person made is not re-headered or protected.
  verifyTab: (spreadsheetId, tabName) =>
    verifyJobSheetTab(spreadsheetId, tabName, JOB_SHEET_HEADERS, undefined, { onlyJobTabs: true }),
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
 * The Analysis cell: the stored analysis as JSON, naming its stored row so a
 * later read can find the row even when the cell had to be cut, and the keys
 * of the posting it was made for (its text hash and link key), so a read can
 * tell it from a cell left by the posting that sat in the row before - even
 * on an install whose store never saw the row it names. Without the posting's
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
 * The six cells, Job Field to Analysis. Job Hash and Lake Status are `null`,
 * which leaves whatever is in them alone: they are the lake's to fill.
 */
export function analysisColumnValues(stored: StoredJobAnalysis): Array<string | null> {
  return [
    jobFieldLabel(stored.jobFieldId),
    formatSalary(stored.analysis.salary),
    null,
    stored.createdAt,
    null,
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
 * Whether an Analysis cell was written for one of these postings (their keys,
 * `postingKeysOf`): the stored analysis it names is theirs, by link or by
 * text - or, for a cell naming a row this store lacks, the posting keys it
 * records are. A cell that can be tied to no posting is nobody's.
 *
 * What stops a row from being built on the analysis of the posting that sat
 * in it before: the protected columns cannot be cleared by the person, and a
 * replaced or re-sorted row keeps them.
 */
export function cellIsForPosting(cell: ParsedAnalysisCell, ...postings: Array<Partial<PostingKeys>>): boolean {
  if (cell.state === 'empty') return false;
  if (cell.analysisId) {
    const named = getJobAnalysisById(cell.analysisId);
    if (named) return postings.some((posting) => samePosting({ hash: named.contentHash, link: named.linkKey }, posting));
  }
  if (cell.state !== 'ok' || !cell.posting) return false;
  const recorded = cell.posting;
  return postings.some((posting) => samePosting(recorded, posting));
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
 * consecutive rows, B:D and K:P. Never throws: a sheet that cannot be read is a
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
        `[sheets] "${tabName}" in ${spreadsheetId} is not laid out as a job tab; its own columns are left as they ` +
          'are, and its postings are analysed from the store instead.'
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

export type WriteBackReport = { written: number; skipped: number; failed: number };

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
let flushing: Promise<WriteBackReport> = Promise.resolve({ written: 0, skipped: 0, failed: 0 });

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
  const report: WriteBackReport = { written: 0, skipped: 0, failed: 0 };
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

  // All six analysis cells, not only Analysis: on a tab an older build made,
  // the first two of them were spare columns somebody may have typed into,
  // and a row holding anything there is left as it is rather than written over.
  const runs = rowRuns(entries.map((entry) => entry.row));
  const ranges = runs.flatMap(([from, to]) => [
    a1Range(tabName, from, to, JOB_SHEET_COLUMNS.company, JOB_SHEET_COLUMNS.jobLink),
    a1Range(tabName, from, to, ANALYSIS_FIRST_COLUMN, ANALYSIS_LAST_COLUMN),
  ]);
  const grids = await client.readRanges(spreadsheetId, ranges);
  const analysisOffset = JOB_SHEET_COLUMNS.analysis - ANALYSIS_FIRST_COLUMN;
  // What may hold somebody's own text: Job Field, Salary and Analyzed At. Not
  // Job Hash and Lake Status - the Job Data Lake is their only writer, and
  // writes them before a row has any analysis (a Skipped row) or when this
  // write failed (its status still lands) - and this write leaves them as
  // they are. Counting them would leave such a row without its analysis
  // cells for good.
  const personal = new Set(
    [JOB_SHEET_COLUMNS.jobField, JOB_SHEET_COLUMNS.salary, JOB_SHEET_COLUMNS.analyzedAt].map(
      (column) => column - ANALYSIS_FIRST_COLUMN
    )
  );
  const current = new Map<number, { company: string; link: string; cell: ParsedAnalysisCell; others: boolean }>();
  runs.forEach(([from, to], runIndex) => {
    for (let row = from; row <= to; row += 1) {
      const identity = grids[runIndex * 2]?.[row - from] ?? [];
      const analysisCells = grids[runIndex * 2 + 1]?.[row - from] ?? [];
      current.set(row, {
        company: identity[0] ?? '',
        link: identity[JOB_SHEET_COLUMNS.jobLink - JOB_SHEET_COLUMNS.company] ?? '',
        cell: parseAnalysisCell(analysisCells[analysisOffset]),
        others: analysisCells.some((cell, index) => personal.has(index) && String(cell ?? '').trim() !== ''),
      });
    }
  });

  const data: Array<{ range: string; values: Array<Array<string | number | null>> }> = [];
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
    let values = analysisColumnValues(entry.stored);
    if (now.cell.state === 'empty') {
      if (now.others) {
        // Something the program did not write - a note in what an older
        // build left as a spare column - is left as it is.
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
      // The program's cells for the posting that sat in this row before:
      // replaced whole, the lake's two emptied with them.
      values = values.map((value) => value ?? '');
      console.log(
        `[sheets] Row ${entry.row} of "${tabName}" in ${spreadsheetId} held the analysis of another posting ` +
          `(${now.cell.analysisId}); writing ${entry.companyName}'s over it.`
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

/** Tests share one process: queued rows, the timer and what was settled are forgotten. */
export function resetAnalysisWriteBacksForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  pending.clear();
  settled.clear();
  flushing = Promise.resolve({ written: 0, skipped: 0, failed: 0 });
}
