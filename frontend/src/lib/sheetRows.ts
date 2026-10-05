/**
 * Turning the rows read from a Google Sheet tab into the jobs a build runs on -
 * what the builder's sheet panel (components/SheetsSourcePanel.tsx) shows in its
 * preview table and then submits.
 *
 * Imports nothing at runtime, so the backend suite can test it
 * (backend/test/immediateRunHelpers.test.js). Columns arrive here as OFFSETS
 * into the loaded range; turning a typed letter into one is lib/sheet.ts's
 * `parseSpreadsheetColumnInput`, which the panel calls.
 */

/** One job read from a sheet row. */
export type SheetJob = {
  companyName: string;
  jobTitle: string;
  jobDescription: string;
  /** The row's job link when it is a web address, else ''. Shown, never submitted yet. */
  jobLink: string;
  /**
   * Whether the row already carries an analysis: true or false when an
   * analysis column is mapped, null when none is (nothing to tell from).
   */
  analysed: boolean | null;
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
};

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
      analysed: columns.analysis === null ? null : cell(row, columns.analysis) !== '',
      sourceRowNumber: startRow + index,
    });
  });

  if (jobs.length === 0) {
    throw new Error('No jobs were found in those rows. Check the rows and the mapped columns.');
  }
  return { jobs, skippedRows };
}
