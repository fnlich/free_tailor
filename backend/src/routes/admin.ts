import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import {
  BROWSER_CHAT_SITE_IDS,
  createAIModel,
  deleteAIModel,
  getAdminAppSettings,
  listAdminAIModels,
  updateAIModel,
  updateAppSettings,
} from '../config/aiModelConfig';
import { getProviderLabel } from '../config/providerCatalog';
import { fetchGoogleSheetsRange, GoogleSheetsRequestError, updateGoogleSheetsRange } from '../integrations/googleSheets';
import { probeDebugBrowser } from '../services/debugBrowser';
import { getTabPoolStats } from '../services/ai/providers/browserChat/pool';
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
    const statusCode = error instanceof GoogleSheetsRequestError ? error.statusCode : 500;
    res.status(statusCode).json({
      error: error instanceof Error ? error.message : 'Failed to fetch Google Sheets data',
    });
  }
});

router.put('/google-sheets/range', requireAdmin, async (req: Request, res: Response) => {
  try {
    const result = await updateGoogleSheetsRange(req.body ?? {});
    res.json(result);
  } catch (error) {
    const statusCode = error instanceof GoogleSheetsRequestError ? error.statusCode : 500;
    res.status(statusCode).json({
      error: error instanceof Error ? error.message : 'Failed to update Google Sheets data',
    });
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

/**
 * The state of the browsers the free chat providers drive.
 *
 * READ-ONLY. There used to be a `POST /browser/debug/start` beside this that
 * spawned Chrome on the server; it is gone, and with it every path by which an
 * HTTP request could start a BROWSER. Operators run `npm run browser:debug`
 * instead.
 *
 * Not "start a process" - that would be false, and the distinction is worth
 * keeping honest: `POST /browse-output-directory` in this same router still
 * execFiles a native directory dialog. What is gone is the ability to launch
 * the thing that holds the operator's signed-in accounts.
 *
 * CHEAP ON PURPOSE: every reading here is a loopback DevTools HTTP probe, which
 * opens no page and drives nothing. The deeper question - is that tab actually
 * SIGNED IN - is the provider health check's to answer, and the admin UI
 * already asks `GET /ai/health` for it on the same page load. Calling it again
 * from here would run the page-driving probe twice per load and make this
 * endpoint as slow as that one; measured, it took this from milliseconds to
 * over two minutes. So this reports what is REGISTERED and what is REACHABLE,
 * and the caller pairs it with the health it already has.
 */
router.get('/browser/debug', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const settings = await getAdminAppSettings();
    const browsers = await Promise.all(
      settings.browserChatEndpoints.map(async (entry) => ({
        siteId: entry.siteId,
        port: entry.port,
        status: await probeDebugBrowser(entry.port),
      }))
    );

    const platforms = BROWSER_CHAT_SITE_IDS.map((siteId) => {
      const registered = browsers.filter((row) => row.siteId === siteId);
      const running = registered.filter((row) => row.status.running);
      const withTab = running.filter(
        (row) => row.status.sites.find((site) => site.id === siteId)?.open
      );
      return {
        id: siteId,
        label: getProviderLabel(siteId),
        registeredPorts: registered.map((row) => row.port),
        runningPorts: running.map((row) => row.port),
        tabPorts: withTab.map((row) => row.port),
      };
    });

    res.json({ browsers, platforms, queues: getTabPoolStats() });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Could not check the debug browsers',
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
