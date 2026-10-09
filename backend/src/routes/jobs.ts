import { Router, Request, Response } from 'express';
import { requireUser } from '../middleware/auth';
import { publicItemError, sendPublicError } from '../middleware/publicError';
import {
  a1Columns,
  batchGetValues,
  GoogleSheetsRequestError,
  inspectJobSheetTab,
  isJobSheetTab,
  JOB_SHEET_COLUMNS,
  JOB_SHEET_FIRST_DATA_ROW,
} from '../integrations/googleSheets';
import { resolveJobSheetTarget } from '../services/sheets/jobSheetTarget';
import { notJobTabError } from '../services/sheets/accountSheet';
import {
  describeJobFilterModel,
  evaluateJobFilterAnalysis,
  getEmptyJobFilterAnalysis,
  jobFilterAnalysisOf,
} from '../services/jobFilter';
import { findStoredAnalysis, getOrCreateAnalysis } from '../services/jobAnalysis/gate';
import { attachCompanyName } from '../database/jobAnalysisRepository';
import { extractJobPageContent } from '../services/jobPageContent';

/**
 * The job routes over the caller's own job sheet: the Job Filter. (The Apify
 * job search and its export into the sheet were removed, owner decision F4;
 * the sheet writer it used is services/sheets/jobExport.ts.)
 *
 * Everything here needs an account that builds resumes - at the router rather
 * than per route, so a route added later is protected by default.
 */
const router = Router();
router.use(requireUser);

function toPositiveInteger(fieldName: string, value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new GoogleSheetsRequestError(400, `${fieldName} must be a positive whole number.`);
  }

  return parsed;
}

/** What one row's error line says, by the step it failed at. */
const ROW_STEP_FAILED = {
  open: 'Could not open the job page',
  judge: 'The AI could not analyse this job',
} as const;

/** One row of a Job Filter run, as the page shows it. */
type FilterRowResult = {
  row: number;
  company: string;
  title: string;
  link: string;
  /** The verdict; null for a row that was not judged - no job link, or it failed (`error`). */
  result: 'Pass' | 'Fail' | null;
  /** Why it failed the filter ('' for a pass), or why it was not judged. */
  reason: string;
  /** True when the posting was already analysed: no page fetched, no model asked. */
  reused: boolean;
  /** The row's failure, in words for the reader (with a ref), when it failed. */
  error?: string;
};

/**
 * The Job Filter over rows of the caller's OWN job sheet - the tab named,
 * else All; a job tab only. It READS the rows' Company, Job Title and Job
 * Link (C:E) in one call, judges every row with a link on its posting's one
 * job analysis (owner decision J8 - a posting already analysed costs no page
 * fetch and no model call; any other is fetched and analysed through the
 * gate, once), and answers each row's verdict to the page (`rows`).
 *
 * It writes NOTHING into the sheet - no verdict, no analysis cell (owner's
 * default). An analysis it made is in the store, and the next build from the
 * row finds it there and fills the row's analysis columns then.
 */
router.post('/filter-google-sheet', async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    // Reading only, so the stored layout is trusted: a tab Google no longer
    // has is refused by the read below, in Google's words.
    const { spreadsheetId: sheetId, tabName } = await resolveJobSheetTarget(req.user!, body);
    const startRow =
      body.startRow === undefined ? JOB_SHEET_FIRST_DATA_ROW : toPositiveInteger('startRow', body.startRow);
    const askedEnd = body.endRow === undefined ? null : toPositiveInteger('endRow', body.endRow);
    if (askedEnd !== null && askedEnd < startRow) {
      throw new GoogleSheetsRequestError(400, 'startRow must be less than or equal to endRow.');
    }

    // A job tab, read without writing anything: any other tab has other
    // columns where these are read from.
    const inspected = await inspectJobSheetTab(sheetId, tabName);
    if (!isJobSheetTab(inspected)) throw notJobTabError(tabName, 'filtered');

    // The filter makes no model call of its own (owner decision J8): each
    // row is judged on its posting's ONE job analysis, which the analysis
    // model makes when the posting has none yet. The summary names that model.
    const { modelLabel } = await describeJobFilterModel();

    // ONE read of C:E, whole columns (never past the grid): without an
    // explicit end, the rows run to the last one holding anything there.
    const [grid = []] = await batchGetValues(sheetId, [
      a1Columns(tabName, JOB_SHEET_COLUMNS.company, JOB_SHEET_COLUMNS.jobLink),
    ]);
    const endRow = askedEnd ?? grid.length;

    const summary = {
      spreadsheetId: sheetId,
      spreadsheetTitle: inspected.spreadsheetTitle ?? '',
      selectedTab: tabName,
      modelLabel,
      startRow,
      endRow,
    };
    if (endRow < startRow) {
      // An empty tab is not an error - a sheet nobody has exported into yet
      // is the ordinary first run - but it answers in the SAME shape as a
      // real run: the page renders every field.
      res.json({
        ...summary,
        scannedRows: 0,
        processedRows: 0,
        skippedRows: 0,
        scrapedRows: 0,
        reusedAnalyses: 0,
        errorRows: 0,
        rowErrors: [],
        rows: [],
        message: 'There are no job rows in that tab yet.',
      });
      return;
    }

    // A sheet filter is the longest-running AI loop in the app - one call per
    // row. Without this, closing the tab left it running to the end of the
    // sheet against the subscription window.
    const filterController = new AbortController();
    const filterSignal = filterController.signal;
    res.on('close', () => {
      if (!res.writableFinished) {
        filterController.abort();
      }
    });

    const cell = (cells: string[], column: number) => String(cells[column - JOB_SHEET_COLUMNS.company] ?? '').trim();
    let processedRows = 0;
    let skippedRows = 0;
    let scrapedRows = 0;
    let reusedAnalyses = 0;
    let errorRows = 0;
    const rowErrors: Array<{ row: number; message: string }> = [];
    const rows: FilterRowResult[] = [];

    for (let rowNumber = startRow; rowNumber <= endRow; rowNumber += 1) {
      const cells = grid[rowNumber - 1] ?? [];
      const company = cell(cells, JOB_SHEET_COLUMNS.company);
      const title = cell(cells, JOB_SHEET_COLUMNS.jobTitle);
      const jobLink = cell(cells, JOB_SHEET_COLUMNS.jobLink);
      if (!jobLink) {
        skippedRows += 1;
        // A row holding a job without a link is listed, unjudged; an empty row is not.
        if (company || title) {
          rows.push({ row: rowNumber, company, title, link: '', result: null, reason: 'The row has no job link to read.', reused: false });
        }
        continue;
      }

      // Which step a row failed at is what its one-line error says; the cause -
      // the job site's status, the seat's failure - is logged under the ref
      // the line carries.
      let step: keyof typeof ROW_STEP_FAILED = 'open';
      let reused = false;
      try {
        // A posting already analysed - by a build, a sheet run, an earlier
        // filter - is judged on that analysis, with no page fetch and no model.
        let stored = findStoredAnalysis({ link: jobLink });
        if (stored) {
          reused = true;
          reusedAnalyses += 1;
          // Found by its link: the company the lake's merge hashes it on, if nobody named one yet.
          if (!stored.companyName && company) attachCompanyName(stored.id, company);
        } else {
          const jobContent = await extractJobPageContent(jobLink);
          scrapedRows += 1;

          step = 'judge';
          stored = await getOrCreateAnalysis({
            jd: jobContent,
            link: jobLink,
            requestedBy: req.user?.id ?? null,
            company,
            signal: filterSignal,
          });
        }
        // A page with too little on it to analyse is judged on no facts at
        // all, as it always was.
        const decision = evaluateJobFilterAnalysis(
          stored ? jobFilterAnalysisOf(stored.analysis) : getEmptyJobFilterAnalysis()
        );
        rows.push({
          row: rowNumber,
          company,
          title,
          link: jobLink,
          result: decision.result,
          reason: decision.reason ?? '',
          reused,
        });
        processedRows += 1;
      } catch (error) {
        errorRows += 1;
        const message = publicItemError(error, ROW_STEP_FAILED[step], `job filter row ${rowNumber} (${step})`);
        rows.push({ row: rowNumber, company, title, link: jobLink, result: null, reason: '', reused, error: message });
        if (rowErrors.length < 20) {
          rowErrors.push({ row: rowNumber, message });
        }
      }
    }

    res.json({
      ...summary,
      scannedRows: endRow - startRow + 1,
      processedRows,
      skippedRows,
      scrapedRows,
      reusedAnalyses,
      errorRows,
      rowErrors,
      rows,
    });
  } catch (error) {
    // The sheet guard's own statuses, Google's refusals and "no model can run"
    // are public; anything else is generic.
    sendPublicError(req, res, error, 'Failed to filter the job sheet');
  }
});

export default router;
