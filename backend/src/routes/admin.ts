import { Router, Request, Response } from 'express';
import { generateToken, validatePassword, invalidateToken, authMiddleware } from '../middleware/auth';
import {
  createAIModel,
  deleteAIModel,
  getAdminAppSettings,
  listAdminAIModels,
  updateAIModel,
  updateAppSettings,
} from '../config/aiModelConfig';
import { fetchGoogleSheetsRange, GoogleSheetsRequestError, updateGoogleSheetsRange } from '../integrations/googleSheets';
import {
  DebugBrowserError,
  assertUsablePort,
  probeDebugBrowser,
  startDebugBrowser,
} from '../services/debugBrowser';
import { isChatSiteId, type ChatSiteId } from '../services/ai/providers/browserChat/sites';
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
 * The debug browser the chat providers attach to.
 *
 * Behind `authMiddleware` like everything else here, and that matters more for
 * these two than for the rest of this file: `start` launches a process on the
 * server. What it may launch is not open-ended - the executable is resolved by
 * this app, the URLs are its own two chat sites, and the only value taken from
 * the request is a port that is validated to an integer in range before it
 * reaches an argv array. See `services/debugBrowser.ts`.
 */
router.get('/browser/debug', authMiddleware, async (req: Request, res: Response) => {
  try {
    const settings = await getAdminAppSettings();
    const requested = req.query.port;
    const port =
      typeof requested === 'string' && requested.trim()
        ? assertUsablePort(requested)
        : settings.browserChatDebugPort;
    res.json(await probeDebugBrowser(port));
  } catch (error) {
    if (error instanceof DebugBrowserError) {
      res.status(400).json({ error: error.message, hint: error.hint });
      return;
    }
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Could not check the debug browser',
    });
  }
});

router.post('/browser/debug/start', authMiddleware, async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { port?: unknown; siteIds?: unknown; save?: unknown };
    const port = assertUsablePort(
      typeof body.port === 'undefined'
        ? (await getAdminAppSettings()).browserChatDebugPort
        : body.port
    );

    // Ids only, and only the two this app knows. The URL is looked up from the
    // site table rather than accepted, so this endpoint cannot be used to point
    // a browser at an arbitrary address.
    const siteIds = Array.isArray(body.siteIds)
      ? (body.siteIds.filter(isChatSiteId) as ChatSiteId[])
      : undefined;

    const result = await startDebugBrowser({ port, siteIds });

    // Saved by default, because a port you started a browser on and a port the
    // providers attach to that disagree is the single most confusing state this
    // feature can be left in.
    let settings = await getAdminAppSettings();
    if (body.save !== false && settings.browserChatDebugPort !== port) {
      settings = await updateAppSettings({ browserChatDebugPort: port });
      // Nothing to tear down here on purpose. The adapter keys its held
      // connection on the endpoint and swaps it when that changes, so the next
      // call attaches to the browser just started - whereas disposing from here
      // would cut off a turn that is in flight against the OLD port, which is a
      // real request somebody is waiting on.
    }

    res.json({ ...result, settings });
  } catch (error) {
    if (error instanceof DebugBrowserError) {
      res.status(400).json({ error: error.message, hint: error.hint });
      return;
    }
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Could not start the debug browser',
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
