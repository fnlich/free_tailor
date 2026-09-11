import { Router, Request, Response } from 'express';
import { generateToken, validatePassword, invalidateToken, authMiddleware } from '../middleware/auth';
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

// Login
router.post('/login', (req: Request, res: Response) => {
  const { password } = req.body;

  if (!password) {
    res.status(400).json({ error: 'Password is required' });
    return;
  }

  if (!validatePassword(password)) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  const token = generateToken();
  res.json({ token, message: 'Login successful' });
});

// Logout
router.post('/logout', authMiddleware, (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    invalidateToken(token);
  }
  res.json({ message: 'Logout successful' });
});

// Verify token
router.get('/verify', authMiddleware, (req: Request, res: Response) => {
  res.json({ valid: true });
});

// Get admin settings (protected)
router.get(['/settings', '/ai-models'], authMiddleware, async (_req: Request, res: Response) => {
  try {
    const settings = await getAdminAppSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

router.post('/browse-output-directory', authMiddleware, async (req: Request, res: Response) => {
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

router.post('/google-sheets/range', authMiddleware, async (req: Request, res: Response) => {
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

router.put('/google-sheets/range', authMiddleware, async (req: Request, res: Response) => {
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
router.put(['/settings', '/ai-models'], authMiddleware, async (req: Request, res: Response) => {
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
 * spawned Chrome on the server; it is gone, and with it the only path by which
 * an HTTP request could start a desktop process here. Operators run
 * `npm run browser:debug` instead.
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
router.get('/browser/debug', authMiddleware, async (_req: Request, res: Response) => {
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

router.get('/models', authMiddleware, async (_req: Request, res: Response) => {
  try {
    res.json({ models: await listAdminAIModels() });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load AI models' });
  }
});

router.post('/models', authMiddleware, async (req: Request, res: Response) => {
  try {
    const settings = await createAIModel(req.body ?? {});
    res.status(201).json(settings);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Failed to create AI model',
    });
  }
});

router.put('/models/:id', authMiddleware, async (req: Request<{ id: string }>, res: Response) => {
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

router.delete('/models/:id', authMiddleware, async (req: Request<{ id: string }>, res: Response) => {
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
