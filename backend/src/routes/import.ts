import { Router, Request, Response } from 'express';
import { requireUser } from '../middleware/auth';
import { fetchGoogleSheetsRange, GoogleSheetsRequestError } from '../integrations/googleSheets';
import { SheetAccessError } from '../services/sheets/accountSheet';
import { resolveAddressableSheet } from '../services/sheets/accountSheet';
import { adminAllowedSheetIds } from '../services/sheets/jobSheetTarget';

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
    const spreadsheetId = await resolveAddressableSheet(
      req.user!,
      body.sheetId,
      await adminAllowedSheetIds(req.user!)
    );

    const result = await fetchGoogleSheetsRange({ ...body, sheetId: spreadsheetId });
    res.json(result);
  } catch (error) {
    const statusCode =
      error instanceof SheetAccessError
        ? error.status
        : error instanceof GoogleSheetsRequestError
          ? error.statusCode
          : 500;
    res.status(statusCode).json({
      error: error instanceof Error ? error.message : 'Failed to import Google Sheets data',
    });
  }
});

export default router;
