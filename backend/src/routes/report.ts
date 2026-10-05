import { Router, type Request, type Response } from 'express';

import { jobRewardsSince, readBalanceMilli } from '../database/creditRepository';
import { countLakeEntriesBy, utcDayStart } from '../database/jobLakeRepository';
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
  lakeStatusIsRowsOwn,
  lastRowInGrid,
  readReportRows,
  rowHoldsAJob,
} from '../services/jobLake/reportSheet';
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
 *   GET  /tabs        the sheet's tabs, today's first
 *   GET  /rows        ?tab=&from=&to= - the rows, and which are reported already
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
          todayTab: state.todayTab,
          todayTabUrl: state.todayTabUrl ?? null,
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
    res.json(await listAddressableSheetTabs(req.user!, undefined, []));
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
    const rows =
      toRow < range.fromRow
        ? []
        : await readReportRows(spreadsheetId, range.tabName, range.fromRow, toRow, { columnCount: tab.columnCount });
    res.json({
      ...range,
      jobTab: true,
      rows: rows.filter(rowHoldsAJob).map((row) => ({
        row: row.row,
        company: row.company,
        title: row.title,
        link: row.link,
        descriptionLength: row.jobDescription.trim().length,
        jobHash: row.jobHash || null,
        lakeStatus: row.lakeStatus || null,
        // A run skips these: Added, Replaced, Duplicate or Unclassified already,
        // beside the Analysis cell of the posting in the row now - a status
        // left by the posting that sat in the row before does not count.
        reported: lakeStatusIsRowsOwn(row),
      })),
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
