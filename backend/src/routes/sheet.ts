import { Router, type Request, type Response } from 'express';

import { isAdmin, requireAccount } from '../middleware/auth';
import { isPublicError, sendPublicError } from '../middleware/publicError';
import { describeAccountSheet, setAccountSheetVisibility } from '../services/sheets/accountSheet';

/**
 * The signed-in account's own spreadsheet.
 *
 * There is no id in the path, and none is read from the body: every route here
 * acts on `req.user` and nothing else. That is deliberate and it is the lesson
 * from the batch routes, which took an id, trusted it, and let any signed-in
 * user read somebody else's work. An id parameter here would be the same hole
 * with a different noun.
 *
 * Every role, a reporter included: their own job sheet is where the jobs they
 * report come from (owner decision A3, Settings > Job Sheet).
 */

const router = Router();
router.use(requireAccount);

/**
 * What an ordinary account holder is told, and what an administrator is.
 *
 * This route is `requireAccount`, so the reader is usually somebody who cannot act
 * on the answer. Naming `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` at them is noise at
 * best; the admin version is the one that says what to change.
 */
const NOT_CONFIGURED_ADMIN =
  'Google Sheets is not set up on this server. Add a service account key ' +
  '(GOOGLE_SERVICE_ACCOUNT_KEY_PATH) and enable the Sheets and Drive APIs for its project.';
const NOT_CONFIGURED =
  'Job sheets are not set up on this server yet. An administrator has to connect Google Sheets ' +
  'before this page can show you one.';

/**
 * Every failure here, through the one helper every other route uses.
 *
 * A refusal about THIS account's spreadsheet - the refusal to go private while
 * the owner has no grant of their own, a tab that is not there - is public and
 * keeps its own status. A Google refusal says only what the reader can act on,
 * with Google's reason as `detail` for an administrator and the log. Anything
 * else is Google being unreachable, as far as the reader is concerned: a 502.
 */
function fail(req: Request, res: Response, error: unknown): void {
  sendPublicError(req, res, error, 'Could not reach Google Sheets', isPublicError(error) ? undefined : 502);
}

/**
 * The sheet, allocating it if this is the first anyone has asked.
 *
 * Allocation happens in the background at sign-in, so most of the time this is
 * a read. Doing it here too is what covers the account whose sign-in ran while
 * Google was down, and the one that predates the feature entirely.
 *
 * `?recheck=1` - sent by the Job Sheet page alone - looks at a recorded tab
 * name clash again (`describeAccountSheet`); without it a clash is reported
 * from the stored row, since the shell asks this on every page load.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const state = await describeAccountSheet(req.user!, { recheck: req.query.recheck === '1' });
    if (!state.configured) {
      res.json({
        configured: false,
        message: isAdmin(req) ? NOT_CONFIGURED_ADMIN : NOT_CONFIGURED,
        defaultTab: state.defaultTab,
        tempTab: state.tempTab,
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
