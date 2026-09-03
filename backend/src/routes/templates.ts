import { Router, Request, Response } from 'express';
import multer from 'multer';
import { authMiddleware } from '../middleware/auth';
import {
  extractAndSaveTemplate,
  getAllTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
  createDefaultTemplate,
  createManualTemplate,
  updateManualTemplate,
  uploadJsonTemplate,
  type ManualTemplateConfig,
} from '../extractors/templateExtractor';
import { generateTemplatePreviewHTML } from '../generators/pdfGenerator';

const router = Router();

// Configure multer for PDF uploads
const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  },
});

// Configure multer for JSON template uploads
const uploadJson = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok =
      file.mimetype === 'application/json' ||
      file.mimetype === 'application/octet-stream' ||
      file.originalname?.toLowerCase().endsWith('.json');
    if (ok) cb(null, true);
    else cb(new Error('Only JSON files are allowed'));
  },
});

// Get all templates
router.get('/', async (req: Request, res: Response) => {
  try {
    // Ensure default template exists
    await createDefaultTemplate();

    const includeDisabled = req.query.includeDisabled === 'true';
    const templates = await getAllTemplates();
    const filtered = includeDisabled
      ? templates
      : templates.filter((t) => !t.disabled);
    res.json(filtered);
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

// Get template preview HTML (sample data)
router.get('/:id/preview', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const template = await getTemplateById(req.params.id);
    if (!template) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }
    const html = generateTemplatePreviewHTML(template);
    res.type('html').send(html);
  } catch (error) {
    console.error('Error generating template preview:', error);
    res.status(500).json({ error: 'Failed to generate preview' });
  }
});

// Get single template
router.get('/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const template = await getTemplateById(req.params.id);
    if (!template) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }
    res.json(template);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch template' });
  }
});

// Create manual template (protected)
router.post('/create-manual', authMiddleware, async (req: Request, res: Response) => {
  try {
    const config = req.body as ManualTemplateConfig & { name: string };
    if (!config?.name?.trim()) {
      res.status(400).json({ error: 'Template name is required' });
      return;
    }
    const template = await createManualTemplate({
      name: config.name,
      description: config.description,
      columns: config.columns === 2 ? 2 : 1,
      accentColor: config.accentColor || '#1e40af',
      bodyColor: config.bodyColor || '#000',
      bodyFontSizePt: config.bodyFontSizePt ?? 9,
      titleFontSizePt: config.titleFontSizePt ?? 24,
      sectionOrder: Array.isArray(config.sectionOrder) ? config.sectionOrder : [],
      leftSectionOrder: Array.isArray(config.leftSectionOrder) ? config.leftSectionOrder : [],
      rightSectionOrder: Array.isArray(config.rightSectionOrder) ? config.rightSectionOrder : [],
      nameStyle: config.nameStyle,
      headerTitleStyle: config.headerTitleStyle,
      contactStyle: config.contactStyle,
      titleStyle: config.titleStyle,
      subTitleStyle: config.subTitleStyle,
      paragraphStyle: config.paragraphStyle,
      sectionStyles: config.sectionStyles,
    });
    res.status(201).json(template);
  } catch (error) {
    console.error('Error creating manual template:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to create template',
    });
  }
});

// Upload JSON template (protected)
router.post('/upload-json', authMiddleware, uploadJson.single('template'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No JSON file uploaded' });
      return;
    }
    const template = await uploadJsonTemplate(req.file.buffer);
    res.status(201).json(template);
  } catch (error) {
    console.error('Error uploading JSON template:', error);
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Failed to upload template',
    });
  }
});

// Upload PDF and extract template (protected)
router.post('/upload', authMiddleware, uploadPdf.single('pdf'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No PDF file uploaded' });
      return;
    }

    const templateName = req.body.name || 'Untitled Template';

    const template = await extractAndSaveTemplate(
      req.file.buffer,
      templateName,
      req.file.originalname
    );

    res.status(201).json(template);
  } catch (error) {
    console.error('Error extracting template:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to extract template from PDF' 
    });
  }
});

// Update manual template (protected)
router.put('/:id/update-manual', authMiddleware, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const config = req.body as ManualTemplateConfig & { name: string };
    if (!config?.name?.trim()) {
      res.status(400).json({ error: 'Template name is required' });
      return;
    }
    const template = await updateManualTemplate(req.params.id, {
      name: config.name,
      description: config.description,
      columns: config.columns === 2 ? 2 : 1,
      accentColor: config.accentColor || '#1e40af',
      bodyColor: config.bodyColor || '#000',
      bodyFontSizePt: config.bodyFontSizePt ?? 9,
      titleFontSizePt: config.titleFontSizePt ?? 24,
      sectionOrder: Array.isArray(config.sectionOrder) ? config.sectionOrder : [],
      leftSectionOrder: Array.isArray(config.leftSectionOrder) ? config.leftSectionOrder : [],
      rightSectionOrder: Array.isArray(config.rightSectionOrder) ? config.rightSectionOrder : [],
      nameStyle: config.nameStyle,
      headerTitleStyle: config.headerTitleStyle,
      contactStyle: config.contactStyle,
      titleStyle: config.titleStyle,
      subTitleStyle: config.subTitleStyle,
      paragraphStyle: config.paragraphStyle,
      sectionStyles: config.sectionStyles,
    });
    if (!template) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }
    res.json(template);
  } catch (error) {
    console.error('Error updating manual template:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to update template',
    });
  }
});

// Update template (protected) - e.g. toggle disabled, name, description
router.patch('/:id', authMiddleware, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const { disabled, name, description } = req.body as { disabled?: boolean; name?: string; description?: string };
    const updates: { disabled?: boolean; name?: string; description?: string } = {};
    if (typeof disabled === 'boolean') updates.disabled = disabled;
    if (typeof name === 'string') updates.name = name.trim();
    if (typeof description === 'string') updates.description = description.trim();
    const updated = await updateTemplate(req.params.id, updates);
    if (!updated) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }
    res.json(updated);
  } catch (error) {
    console.error('Error updating template:', error);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

// Delete template (protected)
router.delete('/:id', authMiddleware, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const builtInTemplates = [
      'default', 'one-column', 'one-column-modern',
      'two-column-navy', 'one-column-emerald', 'one-column-violet', 'one-column-rose',
      'two-column-slate', 'one-column-amber', 'one-column-indigo', 'two-column-minimal',
      'one-column-serif', 'two-column-teal', 'one-column-coral', 'two-column-forest'
    ];
    if (builtInTemplates.includes(req.params.id)) {
      res.status(400).json({ error: 'Cannot delete built-in templates' });
      return;
    }

    const deleted = await deleteTemplate(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    res.json({ message: 'Template deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

export default router;
