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
import { fetchGoogleSheetsRange, updateGoogleSheetsRange } from '../integrations/googleSheets';
import { sendPublicError } from '../middleware/publicError';
import { openNativeDirectoryPicker } from '../utils/nativeDirectoryPicker';

const router = Router();

/**
 * The shared-password login is gone.
 *
 * It never checked anything - `validatePassword` returned true for every input,
 * including an empty one - and there is nothing to keep now that accounts are
 * real. Answering 410 rather than 404 says which: a client that still posts
 * here is not asking for a route that never existed, it is using one that was
 * withdrawn, and the message points at the replacement.
 */
router.all(['/login', '/verify'], (_req: Request, res: Response) => {
  res.status(410).json({
    error:
      'This installation now signs in with a Google account or an emailed code. ' +
      'Use /api/auth/options, /api/auth/google or /api/auth/email/request instead.',
  });
});

/** Kept as an alias so an older client's logout still ends the session. */
router.post('/logout', (req: Request, res: Response) => {
  res.redirect(307, '/api/auth/logout');
  void req;
});

// Get admin settings (protected)
router.get(['/settings', '/ai-models'], requireAdmin, async (_req: Request, res: Response) => {
  try {
    const settings = await getAdminAppSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load settings' });
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

router.post('/google-sheets/range', requireAdmin, async (req: Request, res: Response) => {
  try {
    const result = await fetchGoogleSheetsRange(req.body ?? {});
    res.json(result);
  } catch (error) {
    // Admin-only, so the reader always gets Google's reason as `detail`.
    sendPublicError(req, res, error, 'Failed to fetch the Google Sheets data');
  }
});

router.put('/google-sheets/range', requireAdmin, async (req: Request, res: Response) => {
  try {
    const result = await updateGoogleSheetsRange(req.body ?? {});
    res.json(result);
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to update the Google Sheets data');
  }
});

// Update admin settings (protected)
router.put(['/settings', '/ai-models'], requireAdmin, async (req: Request, res: Response) => {
  try {
    const settings = await updateAppSettings(req.body ?? {});
    res.json(settings);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Failed to update settings',
    });
  }
});

router.get('/models', requireAdmin, async (_req: Request, res: Response) => {
  try {
    res.json({ models: await listAdminAIModels() });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load AI models' });
  }
});

router.post('/models', requireAdmin, async (req: Request, res: Response) => {
  try {
    const settings = await createAIModel(req.body ?? {});
    res.status(201).json(settings);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Failed to create AI model',
    });
  }
});

router.put('/models/:id', requireAdmin, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const settings = await updateAIModel(req.params.id, req.body ?? {});
    res.json(settings);
  } catch (error) {
    const statusCode = error instanceof Error && error.message === 'AI model not found.' ? 404 : 400;
    res.status(statusCode).json({
      error: error instanceof Error ? error.message : 'Failed to update AI model',
    });
  }
});

router.delete('/models/:id', requireAdmin, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const settings = await deleteAIModel(req.params.id);
    res.json(settings);
  } catch (error) {
    const statusCode = error instanceof Error && error.message === 'AI model not found.' ? 404 : 400;
    res.status(statusCode).json({
      error: error instanceof Error ? error.message : 'Failed to delete AI model',
    });
  }
});

export default router;
