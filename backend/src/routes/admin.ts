import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import {
  createAIModel,
  deleteAIModel,
  getAdminAppSettings,
  listAdminAIModels,
  updateAIModel,
  updateAppSettings,
} from '../config/aiModelConfig';
import {
  ANALYSIS_FIRST_COLUMN,
  ANALYSIS_LAST_COLUMN,
  analysisProtectionHit,
  fetchGoogleSheetsRange,
  inspectJobSheetTab,
  isJobSheetTab,
  toColumnLetters,
  updateGoogleSheetsRange,
} from '../integrations/googleSheets';
import { PublicError, sendPublicError } from '../middleware/publicError';
import { resolveAddressableSheet } from '../services/sheets/accountSheet';
import { previewOutputPrefix } from '../services/outputPath';
import { openNativeDirectoryPicker } from '../utils/nativeDirectoryPicker';

const router = Router();

// Get admin settings (protected)
router.get('/settings', requireAdmin, async (req: Request, res: Response) => {
  try {
    const settings = await getAdminAppSettings();
    res.json(settings);
  } catch (error) {
    // Through sendPublicError, not a bare 500: it swallowed the cause, so a
    // settings row that does not parse left the administrator - the one
    // person who can fix it - with no ref, no detail and nothing in the log.
    sendPublicError(req, res, error, 'Failed to load settings');
  }
});

router.post('/browse-output-directory', requireAdmin, async (req: Request, res: Response) => {
  try {
    const currentPath = typeof req.body?.currentPath === 'string' ? req.body.currentPath : undefined;
    const result = await openNativeDirectoryPicker(currentPath);
    res.json(result);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Failed to open native folder picker',
    });
  }
});

/**
 * The range importer (Admin -> Google Sheets): reads and writes a range of
 * the administrator's OWN job sheet, and no other (owner decision S1 - the
 * saved shared sheets it used to open are gone). `sheetId` may name that
 * sheet; any other id is 404, as on every route that takes one.
 */
router.post('/google-sheets/range', requireAdmin, async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sheetId = await resolveAddressableSheet(req.user!, body.sheetId);
    const result = await fetchGoogleSheetsRange({ ...body, sheetId } as Parameters<typeof fetchGoogleSheetsRange>[0]);
    res.json(result);
  } catch (error) {
    // Admin-only, so the reader always gets Google's reason as `detail`.
    sendPublicError(req, res, error, 'Failed to fetch the Google Sheets data');
  }
});

/**
 * A column span read exactly as the write reads it (googleSheets.ts
 * `toPositiveInteger`), or null for anything the write refuses itself, with
 * its own 400 - so no spelling of a number is a column here and another there.
 */
function columnSpan(fromCol: unknown, toCol: unknown): { from: number; to: number } | null {
  const read = (value: unknown) => (typeof value === 'string' ? Number(value.trim()) : value);
  const from = read(fromCol);
  const to = read(toCol);
  if (typeof from !== 'number' || typeof to !== 'number' || !Number.isInteger(from) || !Number.isInteger(to)) return null;
  return { from, to };
}

const PROTECTED_JOB_COLUMNS =
  'Columns G to L of a job tab are written by the app only (Job Field, Salary, Job Type, Clearance, ' +
  'Industry, Analysis). Choose a range within columns A to F.';

router.put('/google-sheets/range', requireAdmin, async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sheetId = await resolveAddressableSheet(req.user!, body.sheetId);
    /*
     * Never into the program's analysis columns. The server's identity is the
     * protection's only editor, so a write through here is the one write a
     * person could make that the protection would let through. The six cells
     * are the program's: an Analysis cell written by it could only name a
     * stored analysis, used only when it is the row's posting (gate step 0),
     * and Job Field to Industry would show what was typed.
     *
     * Decided on the tab's PROTECTION, not on its row 1: row 1 is the
     * person's, so A1 changed (here, or by hand) makes a job tab "not a job
     * tab" for exactly as long as it takes to write L under a protection that
     * never moved, and a verify then finds it intact and trusts the cell. An
     * older build's daily tab keeps its K:P protection the same way. A job
     * tab's G-L are refused even before its protection exists - an empty tab
     * is about to become one. Anything that reaches past F is looked at.
     */
    const span = columnSpan(body.fromCol, body.toCol);
    if (span && span.to >= ANALYSIS_FIRST_COLUMN && typeof body.tabName === 'string' && body.tabName.trim()) {
      const tabName = body.tabName.trim();
      const tab = await inspectJobSheetTab(sheetId, tabName);
      if (isJobSheetTab(tab) && span.from <= ANALYSIS_LAST_COLUMN) {
        throw new PublicError(PROTECTED_JOB_COLUMNS, { status: 409, code: 'protected-columns' });
      }
      const hit = analysisProtectionHit(tab, span.from, span.to);
      if (hit) {
        throw new PublicError(
          hit.fromCol === ANALYSIS_FIRST_COLUMN && hit.toCol === ANALYSIS_LAST_COLUMN
            ? PROTECTED_JOB_COLUMNS
            : `Columns ${toColumnLetters(hit.fromCol)} to ${toColumnLetters(hit.toCol)} of "${tabName}" are the ` +
                "app's protected analysis columns, written by the app only. Choose a range outside them.",
          { status: 409, code: 'protected-columns' }
        );
      }
    }
    const result = await updateGoogleSheetsRange({ ...body, sheetId } as Parameters<typeof updateGoogleSheetsRange>[0]);
    res.json(result);
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to update the Google Sheets data');
  }
});

// Update admin settings (protected)
router.put('/settings', requireAdmin, async (req: Request, res: Response) => {
  try {
    const settings = await updateAppSettings(req.body ?? {});
    res.json(settings);
  } catch (error) {
    // A refusal that names its box (an output prefix: utils/outputStorage.ts
    // `OutputPathError`) says which, so the page can put the sentence under it.
    const field = (error as { field?: unknown } | null)?.field;
    const code = (error as { code?: unknown } | null)?.code;
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Failed to update settings',
      ...(typeof field === 'string' ? { field } : {}),
      ...(typeof code === 'string' ? { code } : {}),
    });
  }
});

/**
 * Where a resume would be filed with an output prefix not saved yet:
 * `{ outputPathPrefix? }` -> `{ path, problems, notes }`, the whole path under
 * the output folder with the default folder path after the prefix, drawn by
 * the function a run uses. A prefix that does not pass answers `path: null`
 * and the sentences a save would refuse it with. Without the field it is the
 * prefix in effect; `null`, what Reset to default gives.
 */
router.post('/output-path/preview', requireAdmin, async (req: Request, res: Response) => {
  try {
    res.json(
      await previewOutputPrefix(req.user!, (req.body ?? {}) as { outputPathPrefix?: unknown; outputBaseDir?: unknown })
    );
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to preview the output prefix');
  }
});

/**
 * A model create, edit or delete refused: 404 for a model that is not there,
 * else 400 with the sentence - and, when it is about one box of Admin ->
 * Models' dialog (config/aiModelConfig.ts `AIModelInputError`), `field`
 * naming it, so the page puts the sentence under that box.
 */
function sendModelRefusal(res: Response, error: unknown, fallback: string): void {
  const notFound = error instanceof Error && error.message === 'AI model not found.';
  const field = (error as { field?: unknown } | null)?.field;
  res.status(notFound ? 404 : 400).json({
    error: error instanceof Error ? error.message : fallback,
    ...(typeof field === 'string' ? { field } : {}),
  });
}

router.get('/models', requireAdmin, async (req: Request, res: Response) => {
  try {
    res.json({ models: await listAdminAIModels() });
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to load AI models');
  }
});

router.post('/models', requireAdmin, async (req: Request, res: Response) => {
  try {
    const settings = await createAIModel(req.body ?? {});
    res.status(201).json(settings);
  } catch (error) {
    sendModelRefusal(res, error, 'Failed to create AI model');
  }
});

router.put('/models/:id', requireAdmin, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const settings = await updateAIModel(req.params.id, req.body ?? {});
    res.json(settings);
  } catch (error) {
    sendModelRefusal(res, error, 'Failed to update AI model');
  }
});

router.delete('/models/:id', requireAdmin, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const settings = await deleteAIModel(req.params.id);
    res.json(settings);
  } catch (error) {
    sendModelRefusal(res, error, 'Failed to delete AI model');
  }
});

export default router;
