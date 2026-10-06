/**
 * What the Job Filter page (app/jobs/filter/page.tsx) decides about a run's
 * answer: how each row's verdict reads, and the line above the table. The
 * filter writes nothing into the sheet any more - the page is where its
 * verdicts are read (owner decision S1) - so these are its only words for
 * them.
 *
 * Imports nothing at runtime, so backend/test/frontendJobSheet.test.js runs
 * it against the server's own rules (services/jobFilter.ts, routes/jobs.ts).
 */

/** A row of the run, as `POST /api/jobs/filter-google-sheet` answers it (lib/api.ts `JobFilterRowResult`). */
export type FilterRow = {
  result: 'Pass' | 'Fail' | null;
  reason: string;
  error?: string;
};

/**
 * The reasons the filter fails a posting for, as the server names them
 * (`evaluateJobFilterAnalysis`), in words. A reason the server adds later and
 * this page does not know yet is shown as its own word, never hidden.
 */
export const FILTER_REASON_LABELS: Readonly<Record<string, string>> = {
  hybrid: 'Hybrid, not remote',
  on_site: 'On site, not remote',
  job_type_not_specified: 'Does not say it is remote',
  onsite_interview: 'Asks for an on-site interview',
  healthcare: 'A healthcare company',
  fintech: 'A fintech company',
  defense_military: 'A defense or military company',
  intern: 'An internship',
  junior: 'A junior role',
  lead: 'A lead role',
  principal: 'A principal role',
  director: 'A director role',
  vp: 'A VP role',
  manager: 'A manager role',
  clearance_required: 'Needs a security clearance',
  not_us: 'Outside the US',
};

/** A failure reason in words: the label for a known one, else the server's word with its underscores as spaces. */
export function filterReasonLabel(reason: string): string {
  const code = reason.trim();
  if (!code) return '';
  return Object.prototype.hasOwnProperty.call(FILTER_REASON_LABELS, code)
    ? FILTER_REASON_LABELS[code]
    : code.replace(/_/g, ' ');
}

export type FilterRowNote = {
  /** The pill: Pass, Fail, or Not judged. */
  label: 'Pass' | 'Fail' | 'Not judged';
  tone: 'green' | 'red' | 'amber' | 'grey';
  /** Beside the pill: why it failed, why it was not judged, or nothing for a Pass. */
  detail: string;
};

/**
 * How a row's verdict reads. A row that failed to be judged (its page would
 * not open, the analysis failed) says the server's sentence, which carries
 * its `(Ref: ...)`; a row with no link to read says so in the server's words.
 */
export function describeFilterRow(row: FilterRow): FilterRowNote {
  if (row.result === 'Pass') return { label: 'Pass', tone: 'green', detail: '' };
  if (row.result === 'Fail') return { label: 'Fail', tone: 'red', detail: filterReasonLabel(row.reason) };
  if (row.error) return { label: 'Not judged', tone: 'amber', detail: row.error };
  return { label: 'Not judged', tone: 'grey', detail: row.reason.trim() };
}

/** The counts the line above the table gives. */
export function countFilterRows(rows: readonly FilterRow[]): { pass: number; fail: number; notJudged: number } {
  let pass = 0;
  let fail = 0;
  for (const row of rows) {
    if (row.result === 'Pass') pass += 1;
    else if (row.result === 'Fail') fail += 1;
  }
  return { pass, fail, notJudged: rows.length - pass - fail };
}

/** "2 pass, 3 fail, 1 not judged" - the parts that are not zero; "No job rows" when there are none. */
export function describeFilterCounts(rows: readonly FilterRow[]): string {
  if (rows.length === 0) return 'No job rows';
  const { pass, fail, notJudged } = countFilterRows(rows);
  const parts = [
    pass > 0 ? `${pass} pass` : '',
    fail > 0 ? `${fail} fail` : '',
    notJudged > 0 ? `${notJudged} not judged` : '',
  ].filter(Boolean);
  return parts.join(', ');
}

export type FilterRange = { ok: true; startRow: number; endRow?: number } | { ok: false; error: string };

/** A row number as typed: a whole number, 1 or more. */
function wholeRow(text: string): number | null {
  const value = text.trim();
  if (!/^\d+$/.test(value)) return null;
  const row = Number(value);
  return Number.isSafeInteger(row) && row >= 1 ? row : null;
}

/**
 * The rows a run is asked for, from the two boxes: From row (2 when empty -
 * row 1 is the header) and To row, which may be left empty for "to the last
 * job row" (the server finds it). Refused here in the words the boxes are
 * named by, and as the server refuses them.
 */
export function readFilterRange(input: { startRow: string; endRow: string }): FilterRange {
  const startRow = input.startRow.trim() === '' ? 2 : wholeRow(input.startRow);
  if (startRow === null) return { ok: false, error: 'From row must be a whole number, 1 or more.' };
  if (input.endRow.trim() === '') return { ok: true, startRow };
  const endRow = wholeRow(input.endRow);
  if (endRow === null) return { ok: false, error: 'To row must be a whole number, 1 or more, or empty for every row.' };
  if (endRow < startRow) return { ok: false, error: 'To row must be From row or a row after it.' };
  return { ok: true, startRow, endRow };
}
