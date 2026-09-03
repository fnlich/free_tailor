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
