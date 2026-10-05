/**
 * Turning the rows read from a Google Sheet tab into the jobs a build runs on -
 * what the builder's sheet panel (components/SheetsSourcePanel.tsx) shows in its
 * preview table and then submits.
 *
 * Imports nothing at runtime, so the backend suite can test it
 * (backend/test/immediateRunHelpers.test.js, and frontendAnalysis.test.js for
 * the Analysis cell against the server's own reader). Columns arrive here as
 * OFFSETS into the loaded range; turning a typed letter into one is
 * lib/sheet.ts's `parseSpreadsheetColumnInput`, which the panel calls.
 */

/**
 * What a row's Analysis cell holds, in the server's words
 * (services/sheets/analysisColumns.ts `parseAnalysisCell`): nothing; an
 * analysis the build uses instead of analysing the posting; or something that
 * cannot be used as one - cut at Google's 50,000-character limit, or not this
 * program's JSON - which the server replaces with the stored analysis, else
 * one made when the row is built.
 */
export type SheetAnalysisState = 'empty' | 'ok' | 'truncated' | 'unparseable';

/**
 * Where the fields sit, per kind of sheet, as the columns a person reads.
 *
 * The account's own sheet is written BY this app, so its columns are known
 * exactly - `NO(DATE)`, `Company`, `Job Title`, `Job Link`, `Job Description`,
 * then columns a build has no use for, then the six the program alone writes
 * (integrations/googleSheets.ts `JOB_SHEET_HEADERS`): Job Field (K), Salary
 * (L), Job Hash, Analyzed At, Lake Status, Analysis (P) - letters
 * backend/test/frontendAnalysis.test.js holds to the server's
 * `JOB_SHEET_COLUMNS`. So B:E covers the job and row 2 is the first after
 * the header, and K:P is read beside it to
 * say which rows already hold their analysis - the protected Analysis cell is
 * what the server itself reads to skip analysing a row. Those three are not
 * editable here: the server reads column P whatever this page says.
 *
 * A saved source is somebody else's spreadsheet and keeps the D:G it always
 * had: a guess, editable under Advanced. It has no analysis columns - the
 * server neither reads nor writes analyses in a sheet it does not own - so its
 * rows are analysed (or found in the store) when built.
 */
export type SheetLayout = {
  fromRow: string;
  toRow: string;
  fromCol: string;
  toCol: string;
  company: string;
  jobTitle: string;
  jobLink: string;
  jobDescription: string;
  jobField: string;
  salary: string;
  analysis: string;
};

export const OWN_SHEET_LAYOUT: SheetLayout = {
  fromRow: '2',
  toRow: '11',
  fromCol: 'B',
  toCol: 'E',
  company: 'B',
  jobTitle: 'C',
  jobLink: 'D',
  jobDescription: 'E',
  jobField: 'K',
  salary: 'L',
  analysis: 'P',
};

export const SAVED_SOURCE_LAYOUT: SheetLayout = {
  fromRow: '1',
  toRow: '10',
  fromCol: 'D',
  toCol: 'G',
  company: 'D',
  jobTitle: '',
  jobLink: '',
  jobDescription: 'G',
  jobField: '',
  salary: '',
  analysis: '',
};

/** One job read from a sheet row. */
export type SheetJob = {
  companyName: string;
  jobTitle: string;
  jobDescription: string;
  /**
   * The row's job link when it is a web address, else ''. Shown, and sent with
   * the job: the server checks the row is still this posting before it reads
   * or writes the row's analysis cells.
   */
  jobLink: string;
  /**
   * The row's Analysis cell, as the server will read it; null when no
   * analysis column was read (another sheet than the account's own, whose
   * cells the server never trusts, or a range that leaves it out).
   */
  analysis: SheetAnalysisState | null;
  /** The row's Job Field and Salary cells - written with the Analysis cell - or ''. */
  jobField: string;
  salary: string;
  /** The row's number in the sheet, 1-based, so a run can name it. */
  sourceRowNumber: number;
};

/** Where each field sits, as an offset into the loaded range; null when not mapped. */
export type SheetColumnOffsets = {
  companyName: number | null;
  jobTitle: number | null;
  jobDescription: number | null;
  jobLink: number | null;
  analysis: number | null;
  jobField: number | null;
  salary: number | null;
};

/** The marker the server ends a cut Analysis cell with (`ANALYSIS_TRUNCATED_MARKER`). */
export const ANALYSIS_TRUNCATED_MARKER = ' ...[cut at 50,000 characters]';

/**
 * An Analysis cell's state, by the server's rules in the server's order: a
 * cell ending in the cut marker is cut, whatever it parses as; otherwise it
 * must be a JSON object carrying an `analysis` object.
 */
export function sheetAnalysisState(text: unknown): SheetAnalysisState {
  const cell = typeof text === 'string' ? text.trim() : '';
  if (!cell) return 'empty';
  if (cell.endsWith(ANALYSIS_TRUNCATED_MARKER.trim())) return 'truncated';
  try {
    const parsed = JSON.parse(cell) as { analysis?: unknown } | null;
    return parsed && typeof parsed === 'object' && parsed.analysis && typeof parsed.analysis === 'object'
      ? 'ok'
      : 'unparseable';
  } catch {
    return 'unparseable';
  }
}

/** How the preview table says what a row's build will do about its analysis. */
export type RowAnalysisNote = {
  label: string;
  tone: 'green' | 'amber' | 'grey';
  /** The longer sentence, for a title or a screen reader. */
  detail: string;
  /** True when the build takes the analysis from the row and asks no model. */
  skipsAnalysis: boolean;
};

export function describeRowAnalysis(state: SheetAnalysisState | null): RowAnalysisNote {
  if (state === 'ok') {
    return {
      label: 'Skips analysis',
      tone: 'green',
      detail: "Already analysed: the build uses this row's Analysis cell and asks no model.",
      skipsAnalysis: true,
    };
  }
  if (state === 'truncated' || state === 'unparseable') {
    return {
      label: 'Cell unreadable',
      tone: 'amber',
      detail:
        "This row's Analysis cell cannot be used, so the build uses the posting's stored analysis, or analyses it once.",
      skipsAnalysis: false,
    };
  }
  return {
    label: 'When built',
    tone: 'grey',
    detail: 'Analysed the first time any build needs it - once, and never again - unless it already was.',
    skipsAnalysis: false,
  };
}

/** How many of the jobs the server will build without analysing them - their row already holds the analysis. */
export function countSkippingAnalysis(jobs: readonly Pick<SheetJob, 'analysis'>[]): number {
  return jobs.filter((job) => job.analysis === 'ok').length;
}

/**
 * The row's link, only when it is an http(s) address. A cell is somebody's
 * typing - `javascript:` in a link cell must not become a link on this page.
 */
export function safeJobLink(value: string): string {
  const text = value.trim();
  if (!/^https?:\/\//i.test(text)) return '';
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

/**
 * The jobs in the loaded rows, and how many rows were skipped.
 *
 * A row needs a company and a job description - the two things a resume
 * cannot be built without - and one missing either is counted as skipped, not
 * guessed at: an empty row at the end of a range is the usual one. Throws the
 * sentence to show when the mapping cannot work at all or nothing is left.
 */
export function buildSheetJobs(
  values: readonly (readonly string[])[],
  startRow: number,
  columns: SheetColumnOffsets
): { jobs: SheetJob[]; skippedRows: number } {
  if (columns.companyName === null) throw new Error('Map a column to the company name.');
  if (columns.jobDescription === null) throw new Error('Map a column to the job description.');

  const cell = (row: readonly string[], offset: number | null) =>
    offset === null ? '' : String(row[offset] ?? '').trim();

  const jobs: SheetJob[] = [];
  let skippedRows = 0;
  values.forEach((row, index) => {
    const companyName = cell(row, columns.companyName);
    const jobDescription = cell(row, columns.jobDescription);
    if (!companyName || !jobDescription) {
      skippedRows += 1;
      return;
    }
    jobs.push({
      companyName,
      jobTitle: cell(row, columns.jobTitle),
      jobDescription,
      jobLink: safeJobLink(cell(row, columns.jobLink)),
      analysis: columns.analysis === null ? null : sheetAnalysisState(cell(row, columns.analysis)),
      jobField: cell(row, columns.jobField),
      salary: cell(row, columns.salary),
      sourceRowNumber: startRow + index,
    });
  });

  if (jobs.length === 0) {
    throw new Error('No jobs were found in those rows. Check the rows and the mapped columns.');
  }
  return { jobs, skippedRows };
}

/**
 * The loaded rows with a second read's columns put after them, row by row -
 * how the panel joins the account sheet's analysis columns (K:P, read on
 * their own) to the job columns it loaded. Each loaded row is padded to
 * `width` first, so the second read's columns sit at `width + n` whatever a
 * short row held. Rows the second read has none for get nothing appended.
 */
export function appendColumns(
  values: readonly (readonly string[])[],
  width: number,
  extra: readonly (readonly string[])[]
): string[][] {
  return values.map((row, index) => [
    ...Array.from({ length: width }, (_, column) => String(row[column] ?? '')),
    ...(extra[index] ?? []).map((cell) => String(cell ?? '')),
  ]);
}
