import {
  cellIsForPosting,
  isAppOwnedSheet,
  parseAnalysisCell,
  queueAnalysisWriteBack,
  readAnalysisRows,
  sameCompany,
  sameLink,
} from '../sheets/analysisColumns';
import {
  analysisMatchesPosting,
  findStoredAnalysis,
  getOrCreateAnalysis,
  loadAnalysis,
  normalizeSheetAnalysis,
  type StoredJobAnalysis,
} from './gate';
import { postingKeysOf } from './identity';

/**
 * A batch's analyses, resolved ONCE PER JOB at submission - before the jobs
 * are fanned out into one task per profile - so every profile's task carries
 * the same `analysisId` (PLAN check 1, rows 2 and 7).
 *
 * Nothing here asks a model: a submission answers at once. A job is given the
 * analysis it already has - its sheet row's own (sheet first, P7), the one
 * the page named, or the stored one of its posting - and a job with none is
 * analysed by its first task through the same gate, the other profiles'
 * tasks waiting for that one call (services/queue/resumeTask.ts).
 */

/** Where a job came from in an app sheet, carried on the job so its first analysis can be written back there. */
export type SheetRowRef = {
  spreadsheetId: string;
  tabName: string;
  row: number;
  /**
   * True when the row's Analysis cell was empty at submission, or held the
   * program's analysis of ANOTHER posting (the row's was replaced, or rows
   * were sorted under the protected columns): it is filled, or put right,
   * once its posting is analysed.
   */
  writeBack: boolean;
};

/** The parts of a submitted job this reads and fills in. */
export type SubmittedJob = {
  companyName: string;
  jobDescription: string;
  jobLink?: string;
  /** Validated against the store by the caller; filled in here when the posting is already analysed. */
  analysisId?: string;
  sourceRowNumber?: number;
  sheetRow?: SheetRowRef;
};

export type SheetSource = { spreadsheetId: string; tabName: string };

export type SubmitAnalysisReport = {
  /** Jobs that start with an analysis. */
  resolved: number;
  /** Of those, the ones whose analysis came from their sheet row's own cell. */
  fromSheet: number;
  /** Batched reads of the sheet: one per run, or none. */
  sheetReads: number;
  /** Rows whose cells were queued to be filled from the store. */
  writeBacks: number;
};

/** The write-back for a job whose row is waiting for one, once its analysis is known. */
export function writeBackFor(job: SubmittedJob, stored: StoredJobAnalysis): boolean {
  const row = job.sheetRow;
  if (!row?.writeBack) return false;
  return queueAnalysisWriteBack({
    spreadsheetId: row.spreadsheetId,
    tabName: row.tabName,
    row: row.row,
    companyName: job.companyName,
    ...(job.jobLink ? { jobLink: job.jobLink } : {}),
    jobDescription: job.jobDescription,
    stored,
  });
}

export async function resolveAnalysesAtSubmit(
  jobs: SubmittedJob[],
  options: { sheet?: SheetSource | null; requestedBy?: string | null }
): Promise<SubmitAnalysisReport> {
  const report: SubmitAnalysisReport = { resolved: 0, fromSheet: 0, sheetReads: 0, writeBacks: 0 };
  const requestedBy = options.requestedBy ?? null;

  // Sheet first: one batched read of the submitted rows, when the sheet is the
  // app's own. Its cells come from Google, never from the request.
  const sheet = options.sheet && isAppOwnedSheet(options.sheet.spreadsheetId) ? options.sheet : null;
  const sheetJobs = sheet ? jobs.filter((job) => typeof job.sourceRowNumber === 'number' && job.sourceRowNumber > 1) : [];
  if (sheet && sheetJobs.length > 0) {
    const read = await readAnalysisRows(
      sheet.spreadsheetId,
      sheet.tabName,
      sheetJobs.map((job) => job.sourceRowNumber!)
    );
    report.sheetReads = 1;
    // A tab the person laid out for themselves: none of its cells is the
    // program's, and none is written. Its postings are found in the store.
    for (const job of read.jobTab ? sheetJobs : []) {
      const row = job.sourceRowNumber!;
      const cells = read.rows.get(row);
      if (!cells) continue;
      // The row must still be this job: the page read it a moment ago, but a
      // row can be sorted away in between, and a row that is somebody else's
      // posting is neither read from nor written to.
      if (!sameCompany(cells.company, job.companyName) || (job.jobLink && !sameLink(cells.link, job.jobLink))) {
        console.warn(
          `[analysis] Sheet row ${row} of "${sheet.tabName}" no longer matches ${job.companyName}; its analysis ` +
            'cells are neither used nor written.'
        );
        continue;
      }
      // The sheet's link identifies the posting as well as the page's copy
      // of it would - better, since the server read it.
      if (!job.jobLink && cells.link.trim()) job.jobLink = cells.link.trim();
      const cell = parseAnalysisCell(cells.analysisCell);
      const posting = postingKeysOf({ jd: job.jobDescription, link: job.jobLink });
      // Written for the posting in the row now - or left by the one before it.
      const forPosting = cellIsForPosting(cell, posting);
      job.sheetRow = {
        spreadsheetId: sheet.spreadsheetId,
        tabName: sheet.tabName,
        row,
        writeBack: cell.state === 'empty' || (Boolean(cell.analysisId) && !forPosting),
      };
      if (cell.state === 'empty') continue;

      if (!read.trusted) {
        console.warn(
          `[analysis] Sheet row ${row}'s Analysis cell is not used: the protection of "${sheet.tabName}" was not ` +
            'confirmed intact in this run. The store answers for it instead.'
        );
        continue;
      }
      if (cell.state !== 'ok') {
        console.warn(
          `[analysis] Sheet row ${row}'s Analysis cell is ${cell.state === 'truncated' ? 'cut short' : 'unreadable'}; ` +
            `falling back to the store${cell.analysisId ? ` (it names ${cell.analysisId})` : ''}.`
        );
      }
      if (!forPosting) {
        if (cell.state === 'ok') {
          console.warn(
            `[analysis] Sheet row ${row}'s Analysis cell was not written for the posting in the row now${
              cell.analysisId ? ` (it names ${cell.analysisId})` : ''
            } - the row's posting was replaced, or rows were sorted; it is not used, and is replaced once the ` +
              "row's own posting is analysed."
          );
        }
        continue;
      }
      const stored = await getOrCreateAnalysis({
        jd: job.jobDescription,
        link: job.jobLink,
        sheetRow: {
          row,
          ...(cell.analysisId ? { analysisId: cell.analysisId } : {}),
          ...(cell.state === 'ok' && cell.posting ? { posting: cell.posting } : {}),
          ...(cell.state === 'ok'
            ? { analysis: normalizeSheetAnalysis(cell.analysis, job.jobDescription) ?? undefined }
            : {}),
        },
        requestedBy,
        storedOnly: true,
      });
      if (stored) {
        job.analysisId = stored.id;
        if (cell.state === 'ok') report.fromSheet += 1;
      }
    }
  }

  for (const job of jobs) {
    if (job.analysisId) {
      // Named by the page: written back only when it IS this posting's.
      const named = loadAnalysis(job.analysisId);
      if (named && job.sheetRow?.writeBack && analysisMatchesPosting(named, { jd: job.jobDescription, link: job.jobLink })) {
        if (writeBackFor(job, named)) report.writeBacks += 1;
      }
      report.resolved += 1;
      continue;
    }
    const stored = findStoredAnalysis({ jd: job.jobDescription, link: job.jobLink });
    if (!stored) continue;
    job.analysisId = stored.id;
    report.resolved += 1;
    if (writeBackFor(job, stored)) report.writeBacks += 1;
  }
  return report;
}
