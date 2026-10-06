import { Router, type Request, type Response } from 'express';

import { jobRewardsSince, readBalanceMilli } from '../database/creditRepository';
import { countLakeEntriesBy, findJobReports, utcDayStart } from '../database/jobLakeRepository';
import { getReportRateMilli } from '../database/userRepository';
import { requireReporter } from '../middleware/auth';
import { PublicError, publicItemError, sendPublicError } from '../middleware/publicError';
import { readLakeSettings } from '../services/jobLake/settings';
import {
  currentReportRun,
  getReportRun,
  MAX_REPORT_RUN_ROWS,
  ownSpreadsheetId,
  readRunRange,
  startReportRun,
} from '../services/jobLake/reportRun';
import {
  inspectReportTab,
  lastRowInGrid,
  readReportRows,
  rowHoldsAJob,
} from '../services/jobLake/reportSheet';
import { findStoredAnalysis } from '../services/jobAnalysis/gate';
import { ensureAccountSheet, listAddressableSheetTabs } from '../services/sheets/accountSheet';

/**
 * Report Jobs (`/report`): a reporter adds job postings from their OWN job
 * sheet to the Job Data Lake and is paid for each one the lake accepts
 * (owner decisions A3, J7). An administrator may open it too, and is never
 * paid. A user, who builds resumes, is refused (`requireReporter`).
 *
 * No spreadsheet id is read from any request: every route acts on the
 * caller's own sheet, as /api/sheet does - the reporter picks a TAB and rows.
 *
 *   GET  /            what the page opens on: the sheet, the rate in effect, today's earnings, the latest run
 *   GET  /tabs        the sheet's tabs, each with its layout; All the default
 *   GET  /rows        ?tab=&from=&to= - the rows, and which this account reported before (and what became of them)
 *   POST /runs        { tabName, fromRow, toRow } -> 202 { run }: the background run
 *   GET  /runs/current  the latest run, or null
 *   GET  /runs/:id    one run of the caller's
 */

const router = Router();
router.use(requireReporter);

router.get('/', async (req: Request, res: Response) => {
  const account = req.user!;
  const settings = readLakeSettings();
  const own = getReportRateMilli(account.id);
  const now = Date.now();

  let sheet: Record<string, unknown>;
  try {
    const state = await ensureAccountSheet(account);
    sheet = state.configured
      ? {
          configured: true,
          spreadsheetId: state.spreadsheetId ?? null,
          spreadsheetUrl: state.spreadsheetUrl ?? null,
          defaultTab: state.defaultTab,
          defaultTabUrl: state.defaultTabUrl ?? null,
          tempTab: state.tempTab,
          tempTabUrl: state.tempTabUrl ?? null,
          conflict: state.conflict ?? null,
        }
      : {
          configured: false,
          message:
            'Job sheets are not set up on this server yet. An administrator has to connect Google Sheets before ' +
            'jobs can be reported.',
        };
  } catch (error) {
    sheet = { configured: true, error: publicItemError(error, 'Your job sheet could not be reached', 'report overview') };
  }

  res.json({
    sheet,
    // Only a reporter is paid; an administrator opening the page is told so.
    paid: account.role === 'reporter',
    rate: { rateMilli: own ?? settings.reportRateMilli, source: own === null ? 'global' : 'own' },
    dailyCapMilli: settings.dailyCapMilli,
    earnedTodayMilli: jobRewardsSince(account.id, utcDayStart(now)),
    balanceMilli: readBalanceMilli(account.id),
    lakeJobs: countLakeEntriesBy(account.id),
    maxRunRows: MAX_REPORT_RUN_ROWS,
    run: currentReportRun(account.id),
  });
});

router.get('/tabs', async (req: Request, res: Response) => {
  try {
    // Undefined: the caller's own spreadsheet, and only that.
    res.json(await listAddressableSheetTabs(req.user!, undefined));
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to list the tabs of your job sheet');
  }
});

router.get('/rows', async (req: Request, res: Response) => {
  try {
    const range = readRunRange({ tabName: req.query.tab, fromRow: req.query.from, toRow: req.query.to });
    const spreadsheetId = await ownSpreadsheetId(req.user!);
    const tab = await inspectReportTab(spreadsheetId, range.tabName);
    if (!tab.jobTab) {
      res.json({ ...range, jobTab: false, rows: [] });
      return;
    }
    // Google refuses a read past the grid; rows that do not exist hold nothing.
    const toRow = lastRowInGrid(tab, range.toRow);
    const rows = (
      toRow < range.fromRow ? [] : await readReportRows(spreadsheetId, range.tabName, range.fromRow, toRow)
    ).filter(rowHoldsAJob);
    // What a run would skip, from the database alone - exactly as the run
    // decides it: the posting is stored and this account reported it before,
    // and this is the first row of it in the range (a second row of the same
    // posting is merged, and is a duplicate). Store only: no model, no write.
    const storedIds = rows.map(
      (row) => findStoredAnalysis({ jd: row.jobDescription, link: row.link }, { readOnly: true })?.id ?? null
    );
    const reports = findJobReports(
      req.user!.id,
      storedIds.filter((id): id is string => id !== null)
    );
    const firstRowOf = new Set<string>();
    res.json({
      ...range,
      jobTab: true,
      rows: rows.map((row, index) => {
        const analysisId = storedIds[index];
        const prior = analysisId && !firstRowOf.has(analysisId) ? reports.get(analysisId) ?? null : null;
        if (analysisId && prior) firstRowOf.add(analysisId);
        return {
          row: row.row,
          company: row.company,
          title: row.title,
          link: row.link,
          descriptionLength: row.jobDescription.trim().length,
          // The lake row the posting reached the first time, when it did.
          jobHash: prior?.jobHash ?? null,
          reported: prior !== null,
          priorOutcome: prior?.outcome ?? null,
        };
      }),
    });
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to read the rows of your job sheet');
  }
});

router.post('/runs', async (req: Request, res: Response) => {
  try {
    const run = await startReportRun(req.user!, readRunRange(req.body));
    res.status(202).json({ run });
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to start the report run');
  }
});

router.get('/runs/current', (req: Request, res: Response) => {
  res.json({ run: currentReportRun(req.user!.id) });
});

router.get('/runs/:id', (req: Request<{ id: string }>, res: Response) => {
  const run = getReportRun(req.user!.id, req.params.id);
  if (!run) {
    const missing = new PublicError('That report run was not found.', { status: 404 });
    res.status(missing.status).json({ error: missing.message });
    return;
  }
  res.json({ run });
});

export default router;
