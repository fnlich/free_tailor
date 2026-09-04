import fs from 'fs/promises';
import path from 'path';
import pdf from 'pdf-parse';
import { extractTemplateFromPDF } from '../services/claude';
import { Template } from '../types/template';
import { v4 as uuidv4 } from 'uuid';
import { getStaticTemplatesDir } from '../config/staticPaths';
import {
  deleteStoredTemplate,
  getStoredTemplate,
  getTemplateOverride,
  hasStoredTemplate,
  listStoredTemplates,
  saveStoredTemplate,
  saveTemplateOverride,
} from '../database/templateRepository';

const UPLOADS_DIR = path.join(__dirname, '../../uploads');

async function ensureUploadsDir() {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
}

export async function extractAndSaveTemplate(
  pdfBuffer: Buffer,
  templateName: string,
  originalFilename: string
): Promise<Template> {
  await ensureUploadsDir();

  // Parse PDF to extract text
  const pdfData = await pdf(pdfBuffer);
  const pdfText = pdfData.text;

  if (!pdfText || pdfText.trim().length < 50) {
    throw new Error('Could not extract sufficient text from PDF');
  }

  // Save the original PDF
  const pdfId = uuidv4();
  const pdfPath = path.join(UPLOADS_DIR, `${pdfId}.pdf`);
  await fs.writeFile(pdfPath, pdfBuffer);

  // Use Claude to extract template
  const { html, css, sections } = await extractTemplateFromPDF(pdfText, templateName);

  // Create template object
  const template: Template = {
    id: uuidv4(),
    name: templateName,
    description: `Template extracted from ${originalFilename}`,
    htmlContent: html,
    cssContent: css || '',
    sections,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  saveStoredTemplate(template);

  return template;
}

function normalizeTemplateRecord(id: string, parsed: unknown): Template | null {
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const htmlContent = typeof record.htmlContent === 'string' ? record.htmlContent : '';
  if (!htmlContent.trim()) {
    return null;
  }

  const sections = Array.isArray(record.sections)
    ? record.sections.filter((section): section is string => typeof section === 'string')
    : [];
  const updatedAt =
    typeof record.updatedAt === 'string' && record.updatedAt.trim()
      ? record.updatedAt
      : typeof record.createdAt === 'string' && record.createdAt.trim()
        ? record.createdAt
        : new Date(0).toISOString();
  const createdAt =
    typeof record.createdAt === 'string' && record.createdAt.trim()
      ? record.createdAt
      : updatedAt;

  return {
    id,
    name: typeof record.name === 'string' && record.name.trim() ? record.name : id,
    description: typeof record.description === 'string' ? record.description : '',
    disabled: typeof record.disabled === 'boolean' ? record.disabled : false,
    htmlContent,
    cssContent: typeof record.cssContent === 'string' ? record.cssContent : '',
    sections,
    createdAt,
    updatedAt,
    ...(record.manualConfig && typeof record.manualConfig === 'object'
      ? { manualConfig: record.manualConfig as Template['manualConfig'] }
      : {}),
  };
}

function normalizeTemplateId(id: string): string {
  return id.replace(/\.json$/, '');
}

function applyTemplateOverride(template: Template): Template {
  const override = getTemplateOverride(template.id);
  if (!override) return template;
  return {
    ...template,
    ...(typeof override.name === 'string' && override.name.trim() ? { name: override.name } : {}),
    ...(typeof override.description === 'string' ? { description: override.description } : {}),
    ...(typeof override.disabled === 'boolean' ? { disabled: override.disabled } : {}),
    updatedAt: override.updatedAt,
  };
}

/** Reads one built-in template shipped as a static JSON file. */
async function readStaticTemplate(id: string): Promise<Template | null> {
  const templatePath = path.join(getStaticTemplatesDir(), `${id}.json`);
  try {
    const content = await fs.readFile(templatePath, 'utf-8');
    const template = normalizeTemplateRecord(id, JSON.parse(content));
    if (!template) {
      console.warn(`Static template "${id}" is invalid and cannot be rendered`);
      return null;
    }
    return applyTemplateOverride({ ...template, isBuiltIn: true });
  } catch {
    return null;
  }
}

async function listStaticTemplates(): Promise<Template[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(getStaticTemplatesDir());
  } catch {
    return [];
  }

  const templates: Template[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const template = await readStaticTemplate(normalizeTemplateId(entry));
    if (template) templates.push(template);
  }
  return templates;
}

export async function isBuiltInTemplate(id: string): Promise<boolean> {
  return (await readStaticTemplate(normalizeTemplateId(id))) !== null;
}

export async function getAllTemplates(): Promise<Template[]> {
  const staticTemplates = await listStaticTemplates();
  const staticIds = new Set(staticTemplates.map((template) => template.id));
  const storedTemplates = listStoredTemplates()
    .filter((template) => !staticIds.has(template.id))
    .map((template) => normalizeTemplateRecord(template.id, template))
    .filter((template): template is Template => template !== null);

  return [...staticTemplates, ...storedTemplates].sort((a, b) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export async function getTemplateById(id: string): Promise<Template | null> {
  const normalizedId = normalizeTemplateId(id);
  const staticTemplate = await readStaticTemplate(normalizedId);
  if (staticTemplate) {
    return staticTemplate;
  }

  const stored = getStoredTemplate(normalizedId);
  if (!stored) return null;

  const template = normalizeTemplateRecord(normalizedId, stored);
  if (!template) {
    console.warn(`Template "${normalizedId}" is invalid and cannot be rendered`);
    return null;
  }
  return template;
}

export async function updateTemplate(id: string, updates: Partial<Pick<Template, 'disabled' | 'name' | 'description'>>): Promise<Template | null> {
  const template = await getTemplateById(id);
  if (!template) return null;

  const updatedAt = new Date().toISOString();
  if (template.isBuiltIn) {
    const existing = getTemplateOverride(template.id);
    saveTemplateOverride({
      ...(existing ?? { id: template.id, createdAt: updatedAt }),
      ...updates,
      updatedAt,
    });
    return getTemplateById(template.id);
  }

  const updated: Template = {
    ...template,
    ...updates,
    updatedAt,
  };
  saveStoredTemplate(updated);
  return updated;
}

export async function uploadJsonTemplate(
  jsonBuffer: Buffer,
  options?: { overrideId?: string }
): Promise<Template> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBuffer.toString('utf-8'));
  } catch (e) {
    throw new Error('Invalid JSON: ' + (e instanceof Error ? e.message : 'Parse error'));
  }

  const obj = parsed as Record<string, unknown>;
  if (!obj || typeof obj !== 'object') {
    throw new Error('Template must be a JSON object');
  }

  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  const htmlContent = typeof obj.htmlContent === 'string' ? obj.htmlContent : '';
  const sections = Array.isArray(obj.sections) ? obj.sections.filter((s): s is string => typeof s === 'string') : [];

  if (!name) throw new Error('Template must have a "name" field');
  if (!htmlContent || htmlContent.length < 100) {
    throw new Error('Template must have "htmlContent" with valid HTML');
  }
  if (sections.length === 0) {
    throw new Error('Template must have a "sections" array');
  }

  let id = typeof obj.id === 'string' ? normalizeTemplateId(obj.id).trim() : '';
  if (options?.overrideId) id = normalizeTemplateId(options.overrideId).trim();
  id = id.replace(/[^a-zA-Z0-9\-_]/g, '-');
  if (!id || (await isBuiltInTemplate(id)) || hasStoredTemplate(id)) {
    id = `u-${uuidv4().slice(0, 8)}`;
  }

  const now = new Date().toISOString();
  const template: Template = {
    id,
    name,
    description: typeof obj.description === 'string' ? obj.description.trim() : '',
    disabled: typeof obj.disabled === 'boolean' ? obj.disabled : false,
    htmlContent,
    cssContent: typeof obj.cssContent === 'string' ? obj.cssContent : '',
    sections,
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : now,
    updatedAt: now,
    ...(obj.manualConfig && typeof obj.manualConfig === 'object'
      ? { manualConfig: obj.manualConfig as Template['manualConfig'] }
      : {}),
  };

  saveStoredTemplate(template);
  return template;
}

export async function deleteTemplate(id: string): Promise<boolean> {
  return deleteStoredTemplate(normalizeTemplateId(id));
}

export interface ElementStyle {
  color: string;
  fontSizePt: number;
  fontFamily: string;
  fontWeight: 'normal' | 'bold';
}

export interface ManualTemplateConfig {
  name: string;
  description?: string;
  columns: 1 | 2;
  accentColor: string;
  bodyColor: string;
  bodyFontSizePt: number;
  titleFontSizePt: number;
  /** For 1 column: order of all sections. For 2 columns: ignored. */
  sectionOrder?: string[];
  /** For 2 columns: order of sections in left column (summary, experience) */
  leftSectionOrder?: string[];
  /** For 2 columns: order of sections in right column (hardSkills, education) */
  rightSectionOrder?: string[];
  /** Header: person name */
  nameStyle?: Partial<ElementStyle>;
  /** Header: professional title */
  headerTitleStyle?: Partial<ElementStyle>;
  /** Header: contact info (phone, email, etc.) */
  contactStyle?: Partial<ElementStyle>;
  /** Main title (name) and section titles */
  titleStyle?: Partial<ElementStyle>;
  /** Job title or degree */
  subTitleStyle?: Partial<ElementStyle>;
  /** Body text: summary, description, paragraphs */
  paragraphStyle?: Partial<ElementStyle>;
  /** Per-section, per-element overrides: sectionId -> elementId -> { color, fontSizePt, fontFamily?, fontWeight? } */
  sectionStyles?: Record<string, Record<string, { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: string }>>;
}

const MANUAL_SECTIONS = ['summary', 'experience', 'hardSkills', 'education'] as const;

/** Default split when switching to 2 columns; any section can go in either column */
const DEFAULT_LEFT = ['summary', 'experience'] as const;
const DEFAULT_RIGHT = ['hardSkills', 'education'] as const;

function buildManualTemplateHTML(config: ManualTemplateConfig): string {
  const {
    accentColor,
    bodyColor,
    bodyFontSizePt,
    titleFontSizePt,
    sectionOrder = [],
    leftSectionOrder = [],
    rightSectionOrder = [],
    columns = 1,
    nameStyle,
    headerTitleStyle,
    contactStyle,
    titleStyle,
    subTitleStyle,
    paragraphStyle,
    sectionStyles = {},
  } = config;

  const ELEMENT_TO_CLASS: Record<string, string> = {
    sectionTitle: '.section-title',
    paragraph: '.summary',
    jobTitle: '.job-title',
    companyLine: '.company-line',
    description: '.description',
    achievements: '.achievements',
    skillText: '.skill-box',
    degree: '.degree',
    institution: '.institution',
    date: '.edu-date',
  };
  const accent = accentColor || '#1e40af';
  const body = bodyColor || '#000';
  const bodyPt = bodyFontSizePt || 9;
  const titlePt = titleFontSizePt || 24;

  const name = {
    color: nameStyle?.color ?? accent,
    size: nameStyle?.fontSizePt ?? titlePt,
    font: nameStyle?.fontFamily || "Calibri, 'Segoe UI', Arial, sans-serif",
    weight: nameStyle?.fontWeight ?? 'bold',
  };
  const headerTitle = {
    color: headerTitleStyle?.color ?? accent,
    size: headerTitleStyle?.fontSizePt ?? bodyPt + 1,
    font: headerTitleStyle?.fontFamily || "Calibri, 'Segoe UI', Arial, sans-serif",
    weight: headerTitleStyle?.fontWeight ?? 'bold',
  };
  const contact = {
    color: contactStyle?.color ?? '#333',
    size: contactStyle?.fontSizePt ?? bodyPt - 1,
    font: contactStyle?.fontFamily || "Calibri, 'Segoe UI', Arial, sans-serif",
    weight: contactStyle?.fontWeight ?? 'normal',
  };
  const t = {
    color: titleStyle?.color ?? accent,
    size: titleStyle?.fontSizePt ?? titlePt,
    font: titleStyle?.fontFamily || "Calibri, 'Segoe UI', Arial, sans-serif",
    weight: titleStyle?.fontWeight ?? 'bold',
  };
  const st = {
    color: subTitleStyle?.color ?? accent,
    size: subTitleStyle?.fontSizePt ?? bodyPt + 1,
    font: subTitleStyle?.fontFamily || "Calibri, 'Segoe UI', Arial, sans-serif",
    weight: subTitleStyle?.fontWeight ?? 'bold',
  };
  const p = {
    color: paragraphStyle?.color ?? body,
    size: paragraphStyle?.fontSizePt ?? bodyPt,
    font: paragraphStyle?.fontFamily || "Calibri, 'Segoe UI', Arial, sans-serif",
    weight: paragraphStyle?.fontWeight ?? 'normal',
  };

  const orderedSections = sectionOrder.filter((s) => MANUAL_SECTIONS.includes(s as typeof MANUAL_SECTIONS[number]));
  if (orderedSections.length === 0) {
    orderedSections.push(...MANUAL_SECTIONS);
  }

  const leftOrder =
    columns === 2 && leftSectionOrder.length > 0
      ? leftSectionOrder.filter((s) => MANUAL_SECTIONS.includes(s as typeof MANUAL_SECTIONS[number]))
      : [...DEFAULT_LEFT];
  const rightOrder =
    columns === 2 && rightSectionOrder.length > 0
      ? rightSectionOrder.filter((s) => MANUAL_SECTIONS.includes(s as typeof MANUAL_SECTIONS[number]))
      : [...DEFAULT_RIGHT];

  const getBlockForSection = (section: string): string => {
    const dataSection = ` data-section="${section}"`;
    switch (section) {
      case 'summary':
        return `
      <div class="section"${dataSection}>
        <div class="section-title">Summary</div>
        <div class="summary">{{summary}}</div>
      </div>`;
      case 'experience':
        return `
      <div class="section"${dataSection}>
        <div class="section-title">Experience</div>
        {{#each experience}}
        <div class="experience-item">
          <div class="job-title">{{title}}</div>
          <div class="company-line">
            <span>{{company}}</span>
            <span>{{startDate}} - {{endDate}}{{#if location}} | {{location}}{{/if}}</span>
          </div>
          <div class="description">{{description}}</div>
          <ul class="achievements">
            {{#each achievements}}
            <li>{{this}}</li>
            {{/each}}
          </ul>
        </div>
        {{/each}}
      </div>`;
      case 'hardSkills':
        return `
      <div class="section"${dataSection}>
        <div class="section-title">Hard Skills</div>
        <div class="skills-grid">
          {{#if hardSkills.length}}
          {{#each hardSkills}}
          <div class="skill-box">{{this}}</div>
          {{/each}}
          {{else}}
          {{#each skills}}
          <div class="skill-box">{{this}}</div>
          {{/each}}
          {{/if}}
        </div>
      </div>`;
      case 'education':
        return `
      <div class="section"${dataSection}>
        <div class="section-title">Education</div>
        {{#each education}}
        <div class="education-item">
          <div class="degree">{{degree}}</div>
          <div class="institution">{{institution}}</div>
          <div class="edu-date">{{startDate}} - {{endDate}}{{#if location}} | {{location}}{{/if}}</div>
        </div>
        {{/each}}
      </div>`;
      default:
        return '';
    }
  };

  const sectionBlocks =
    columns === 1
      ? orderedSections.map(getBlockForSection).filter(Boolean)
      : [];
  const leftBlocks = columns === 2 ? leftOrder.map(getBlockForSection).filter(Boolean) : [];
  const rightBlocks = columns === 2 ? rightOrder.map(getBlockForSection).filter(Boolean) : [];

  const mainContent =
    columns === 2
      ? `<div class="main-container">
    <div class="left-column">${leftBlocks.join('\n')}</div>
    <div class="right-column">${rightBlocks.join('\n')}</div>
  </div>`
      : `<div class="main-content">${sectionBlocks.join('\n')}</div>`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    @page { margin: 0.3in; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: ${p.font};
      font-size: ${p.size}pt;
      line-height: 1.25;
      color: ${p.color};
      font-weight: ${p.weight};
      margin: 0;
      padding: 0;
    }
    .header {
      text-align: center;
      margin-bottom: 8px;
      border-bottom: 2px solid ${accent};
      padding-bottom: 8px;
    }
    .name {
      font-size: ${name.size}pt;
      font-weight: ${name.weight};
      font-family: ${name.font};
      color: ${name.color};
      margin-bottom: 2px;
    }
    .title {
      font-size: ${headerTitle.size}pt;
      font-weight: ${headerTitle.weight};
      font-family: ${headerTitle.font};
      color: ${headerTitle.color};
      margin-bottom: 4px;
    }
    .contact {
      font-size: ${contact.size}pt;
      font-family: ${contact.font};
      color: ${contact.color};
      display: flex;
      justify-content: center;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    .contact-item { display: flex; align-items: center; gap: 3px; }
    .contact-icon { color: ${accent}; }
    .contact a { color: ${contact.color}; text-decoration: none; }
    .main-container { display: flex; gap: 15px; }
    .left-column { flex: 0 0 62%; }
    .right-column { flex: 0 0 35%; }
    .section { margin-bottom: 8px; }
    .section-title {
      font-size: ${t.size}pt;
      font-weight: ${t.weight};
      font-family: ${t.font};
      color: ${t.color};
      text-transform: uppercase;
      border-bottom: 1px solid ${accent};
      padding-bottom: 2px;
      margin-bottom: 5px;
    }
    .summary { font-size: ${p.size}pt; font-family: ${p.font}; color: ${p.color}; font-weight: ${p.weight}; line-height: 1.3; text-align: justify; }
    .experience-item { margin-bottom: 8px; }
    .job-title { font-weight: ${st.weight}; font-size: ${st.size}pt; font-family: ${st.font}; color: ${st.color}; }
    .company-line {
      display: flex;
      justify-content: space-between;
      font-size: ${p.size}pt;
      font-family: ${p.font};
      color: #555;
      margin-bottom: 2px;
    }
    .description { font-size: ${p.size}pt; font-family: ${p.font}; color: ${p.color}; font-weight: ${p.weight}; margin-bottom: 3px; line-height: 1.3; }
    .achievements { margin: 0; padding-left: 14px; font-size: ${p.size - 0.5}pt; font-family: ${p.font}; color: ${p.color}; }
    .achievements li { margin-bottom: 1px; line-height: 1.25; }
    .skills-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px 8px;
    }
    .skill-box {
      font-size: ${p.size - 1}pt;
      font-family: ${p.font};
      color: ${p.color};
      padding: 2px 0;
      border-bottom: 1px solid #ddd;
      text-align: center;
    }
    .education-item { margin-bottom: 6px; }
    .degree { font-weight: ${st.weight}; font-size: ${st.size}pt; font-family: ${st.font}; color: ${st.color}; }
    .institution { font-size: ${p.size - 1}pt; font-family: ${p.font}; color: #555; }
    .edu-date { font-size: ${p.size - 1}pt; font-family: ${p.font}; color: #777; }
    ${Object.entries(sectionStyles)
      .map(([sectionId, elements]) =>
        Object.entries(elements)
          .map(([elementId, style]) => {
            const cls = ELEMENT_TO_CLASS[elementId];
            if (!cls || (!style.color && style.fontSizePt == null && !style.fontFamily && !style.fontWeight)) return '';
            const parts: string[] = [];
            if (style.color) parts.push(`color: ${style.color}`);
            if (style.fontSizePt != null) parts.push(`font-size: ${style.fontSizePt}pt`);
            if (style.fontFamily) parts.push(`font-family: ${style.fontFamily}`);
            if (style.fontWeight) parts.push(`font-weight: ${style.fontWeight}`);
            return parts.length ? `[data-section="${sectionId}"] ${cls} { ${parts.join('; ')} }` : '';
          })
          .filter(Boolean)
          .join('\n    ')
      )
      .filter(Boolean)
      .join('\n    ')}
  </style>
</head>
<body>
  <div class="header">
    <div class="name">{{name}}</div>
    <div class="title">{{title}}</div>
    <div class="contact">
      <span class="contact-item"><span class="contact-icon">📞</span> {{contact.phone}}</span>
      <span class="contact-item"><span class="contact-icon">✉</span> {{contact.email}}</span>
      {{#if contact.linkedinHref}}<span class="contact-item"><span class="contact-icon">🔗</span> <a href="{{contact.linkedinHref}}">{{contact.linkedinDisplay}}</a></span>{{/if}}
      <span class="contact-item"><span class="contact-icon">📍</span> {{contact.location}}</span>
    </div>
  </div>
${mainContent}
</body>
</html>`;
}

export async function createManualTemplate(config: ManualTemplateConfig): Promise<Template> {
  const sectionOrder = config.sectionOrder?.length
    ? config.sectionOrder.filter((s) => MANUAL_SECTIONS.includes(s as typeof MANUAL_SECTIONS[number]))
    : [...MANUAL_SECTIONS];

  const fullConfig = {
    ...config,
    sectionOrder,
    leftSectionOrder: config.leftSectionOrder,
    rightSectionOrder: config.rightSectionOrder,
    accentColor: config.accentColor || '#1e40af',
    bodyColor: config.bodyColor || '#000',
    bodyFontSizePt: config.bodyFontSizePt ?? 9,
    titleFontSizePt: config.titleFontSizePt ?? 24,
  };

  const template: Template = {
    id: `m-${uuidv4().slice(0, 8)}`,
    name: config.name.trim() || 'Manual Template',
    description: config.description?.trim() || 'Manually styled template',
    htmlContent: buildManualTemplateHTML(fullConfig),
    cssContent: '',
    sections: sectionOrder,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    manualConfig: fullConfig as Template['manualConfig'],
  };

  saveStoredTemplate(template);

  return template;
}

export async function updateManualTemplate(id: string, config: ManualTemplateConfig): Promise<Template | null> {
  const template = await getTemplateById(id);
  if (!template) return null;
  if (!template.id.startsWith('m-')) {
    throw new Error('Only manual templates can be updated');
  }

  const sectionOrder = config.sectionOrder?.length
    ? config.sectionOrder.filter((s) => MANUAL_SECTIONS.includes(s as typeof MANUAL_SECTIONS[number]))
    : [...MANUAL_SECTIONS];

  const fullConfig = {
    ...config,
    sectionOrder,
    leftSectionOrder: config.leftSectionOrder,
    rightSectionOrder: config.rightSectionOrder,
    accentColor: config.accentColor || '#1e40af',
    bodyColor: config.bodyColor || '#000',
    bodyFontSizePt: config.bodyFontSizePt ?? 9,
    titleFontSizePt: config.titleFontSizePt ?? 24,
  };

  const updated: Template = {
    ...template,
    name: config.name.trim() || template.name,
    description: config.description?.trim() ?? template.description,
    htmlContent: buildManualTemplateHTML(fullConfig),
    sections: sectionOrder,
    updatedAt: new Date().toISOString(),
    manualConfig: fullConfig as Template['manualConfig'],
  };

  saveStoredTemplate(updated);
  return updated;
}
