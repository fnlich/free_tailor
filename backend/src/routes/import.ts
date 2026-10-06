import { Router, Request, Response } from 'express';
import { requireUser } from '../middleware/auth';
import { fetchGoogleSheetsRange } from '../integrations/googleSheets';
import { sendPublicError } from '../middleware/publicError';
import { listAddressableSheetTabs, resolveAddressableSheet } from '../services/sheets/accountSheet';

const router = Router();
/**
 * Everything below needs a signed-in account.
 *
 * At the router rather than per route, so a route added later is protected by
 * default. Before v2 these were open, which was defensible with one user on one
 * machine and is not once profiles belong to people.
 */
router.use(requireUser);


/**
 * The tabs of the caller's own sheet, for the builder's sheet panel: `GET
 * /api/import/tabs` (`?sheetId=` may name it, and nothing else - any other
 * spreadsheet is 404, like everywhere else a sheet id is taken). Answers `{
 * spreadsheetId, tabs: [{ title, gid, layout }], defaultTab }` - `layout` is
 * `job`, `blank` or `other` from the tab's row 1, and `defaultTab` is All
 * when it is a job tab (see `listAddressableSheetTabs`).
 *
 * The rows of the chosen tab are then read with `POST /` below, naming
 * `tabName` and the row and column range.
 */
router.get('/tabs', async (req: Request, res: Response) => {
  try {
    res.json(await listAddressableSheetTabs(req.user!, req.query.sheetId));
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to list the Google Sheet tabs');
  }
});

/**
 * Reads a range out of a spreadsheet the caller is allowed to address.
 *
 * The body used to be forwarded whole, spreadsheet id and all. That was safe
 * while the service account could only open sheets an administrator had shared
 * with it; it stopped being safe the moment the service account started OWNING
 * every account's spreadsheet, because then this route would fetch anybody's
 * for anybody who knew the id - and the id is in a URL that link-shared sheets
 * hand out. The id now goes through the same guard as the job routes.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Only the spreadsheet is resolved, deliberately: this endpoint is also how
    // the UI asks which tabs a spreadsheet HAS, so requiring a tab name would
    // defeat its main use.
    const spreadsheetId = await resolveAddressableSheet(req.user!, body.sheetId);

    const result = await fetchGoogleSheetsRange({ ...body, sheetId: spreadsheetId });
    res.json(result);
  } catch (error) {
    // The guard's refusals and Google's keep their own status and their public
    // sentence; Google's reason is an administrator's `detail`.
    sendPublicError(req, res, error, 'Failed to import the Google Sheets data');
  }
});

export default router;
