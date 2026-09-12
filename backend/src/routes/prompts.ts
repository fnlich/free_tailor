import { Request, Response, Router } from 'express';
import { requireAdmin, requireUser } from '../middleware/auth';
import { listAvailableAIModelOptions } from '../config/aiModelConfig';
import { listPromptCategories } from '../config/promptCategories';
import {
  activatePrompt,
  createPrompt,
  deletePrompt,
  getPromptById,
  listPrompts,
  previewPrompt,
  updatePrompt,
  validatePromptDraft,
} from '../services/promptService';
import { PromptCreateInput, PromptPreviewInput, PromptUpdateInput } from '../types/prompt';

const router = Router();

/**
 * Reading a prompt needs an account; changing one needs an admin.
 *
 * Split because the prompts are shared: they are how EVERY account's resumes
 * are built, so one user editing the tailoring prompt changes what everybody
 * else gets. Reading stays open to users so the builder can show which prompt a
 * run will use.
 */
router.use(requireUser);

/**
 * The categories, so the page's headings are not a second copy of the list.
 *
 * Above `/:id`, or "categories" would be read as a prompt id.
 */
router.get('/categories', (_req: Request, res: Response) => {
  res.json({ categories: listPromptCategories() });
});

router.get('/', async (_req: Request, res: Response) => {
  try {
    const prompts = await listPrompts();
    res.json(prompts);
  } catch (error) {
    console.error('Error fetching prompts:', error);
    res.status(500).json({ error: 'Failed to fetch prompts' });
  }
});

router.post('/validate', async (req: Request, res: Response) => {
  try {
    const validation = await validatePromptDraft(req.body as PromptPreviewInput);
    res.json(validation);
  } catch (error) {
    console.error('Error validating prompt draft:', error);
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Failed to validate prompt',
    });
  }
});

router.post('/preview', async (req: Request, res: Response) => {
  try {
    const preview = await previewPrompt(req.body as PromptPreviewInput);
    res.json(preview);
  } catch (error) {
    console.error('Error generating prompt preview:', error);
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Failed to generate prompt preview',
    });
  }
});

router.get('/models', async (_req: Request, res: Response) => {
  try {
    res.json(await listAvailableAIModelOptions());
  } catch (error) {
    console.error('Error fetching prompt model options:', error);
    res.status(500).json({ error: 'Failed to fetch prompt model options' });
  }
});

router.get('/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const prompt = await getPromptById(req.params.id);
    if (!prompt) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }
    res.json(prompt);
  } catch (error) {
    console.error('Error fetching prompt:', error);
    res.status(500).json({ error: 'Failed to fetch prompt' });
  }
});

router.post('/', requireAdmin, async (req: Request, res: Response) => {
  try {
    const prompt = await createPrompt(req.body as PromptCreateInput);
    res.status(201).json(prompt);
  } catch (error) {
    console.error('Error creating prompt:', error);
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Failed to create prompt',
    });
  }
});

router.put('/:id', requireAdmin, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const prompt = await updatePrompt(req.params.id, req.body as PromptUpdateInput);
    if (!prompt) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }
    res.json(prompt);
  } catch (error) {
    console.error('Error updating prompt:', error);
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Failed to update prompt',
    });
  }
});

router.post('/:id/activate', requireAdmin, async (req: Request<{ id: string }>, res: Response) => {
  try {
    res.json(await activatePrompt(req.params.id));
  } catch (error) {
    console.error('Error activating prompt:', error);
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Failed to activate prompt',
    });
  }
});

router.delete('/:id', requireAdmin, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const deleted = await deletePrompt(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }
    res.json({ message: 'Prompt deleted successfully' });
  } catch (error) {
    console.error('Error deleting prompt:', error);
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Failed to delete prompt',
    });
  }
});

export default router;
