import { Router, type Request, type Response } from 'express';

import { isAdmin, requireUser } from '../middleware/auth';
import { GoogleSheetsRequestError } from '../integrations/googleSheets';
import {
  describeAccountSheet,
  setAccountSheetVisibility,
  SheetAccessError,
} from '../services/sheets/accountSheet';

/**
 * The signed-in account's own spreadsheet.
 *
 * There is no id in the path, and none is read from the body: every route here
 * acts on `req.user` and nothing else. That is deliberate and it is the lesson
 * from the batch routes, which took an id, trusted it, and let any signed-in
 * user read somebody else's work. An id parameter here would be the same hole
 * with a different noun.
 */

const router = Router();
router.use(requireUser);

/**
 * What an ordinary account holder is told, and what an administrator is.
 *
 * This route is `requireUser`, so the reader is usually somebody who cannot act
 * on the answer. Naming `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` at them is noise at
 * best; the admin version is the one that says what to change.
 */
const NOT_CONFIGURED_ADMIN =
  'Google Sheets is not set up on this server. Add a service account key ' +
  '(GOOGLE_SERVICE_ACCOUNT_KEY_PATH) and enable the Sheets and Drive APIs for its project.';
const NOT_CONFIGURED =
  'Job sheets are not set up on this server yet. An administrator has to connect Google Sheets ' +
  'before this page can show you one.';

function fail(req: Request, res: Response, error: unknown): void {
  if (error instanceof SheetAccessError) {
    // Carries its own status and its own sentence - the refusal to go private
    // while the owner has no grant of their own is the one that matters. It is
    // about THIS account's spreadsheet, so everybody gets it.
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof GoogleSheetsRequestError) {
    // Pass Google's own status through. The 403 in particular carries the
    // "enable the Drive API" sentence, which is the actual fix.
    const status = error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 502;

    /*
     * The operator half is logged every time and sent only to an administrator.
     *
     * `error.detail` is the part that names a command to run in `backend/`, a
     * file on disk or an environment variable. Whoever is reading their own
     * Account page is usually not the person who can do any of that, and the
     * log is where it was always meant to go.
     */
    if (error.detail) console.error(`[sheets] ${error.message} ${error.detail}`);
    res.status(status).json({
      error: error.message,
      ...(error.detail && isAdmin(req) ? { detail: error.detail } : {}),
    });
    return;
  }
  console.error('[sheets] Sheet request failed.', error);
  res.status(502).json({ error: 'Could not reach Google Sheets. Try again in a moment.' });
}

/**
 * The sheet, allocating it if this is the first anyone has asked.
 *
 * Allocation happens in the background at sign-in, so most of the time this is
 * a read. Doing it here too is what covers the account whose sign-in ran while
 * Google was down, and the one that predates the feature entirely.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const state = await describeAccountSheet(req.user!);
    if (!state.configured) {
      res.json({
        configured: false,
        message: isAdmin(req) ? NOT_CONFIGURED_ADMIN : NOT_CONFIGURED,
        todayTab: state.todayTab,
      });
      return;
    }
    res.json(state);
  } catch (error) {
    fail(req, res, error);
  }
});

router.post('/visibility', async (req: Request, res: Response) => {
  const requested = req.body?.visibility;
  if (requested !== 'public' && requested !== 'private') {
    res.status(400).json({ error: 'visibility must be "public" or "private".' });
    return;
  }

  try {
    // Read back from Drive rather than echoing what was asked for, so the UI
    // shows what is true even if the change did not fully take.
    const visibility = await setAccountSheetVisibility(req.user!, requested);
    res.json({ visibility });
  } catch (error) {
    fail(req, res, error);
  }
});

export default router;
