import { Template } from '../types/template';
import type { TechnicalSkillsLayout } from '../types/profile';
import { DocumentTable } from './documentTable';

/**
 * Editable overrides for built-in (static) templates. Only presentation fields
 * can be changed; the HTML always comes from the static template file.
 *
 * `skillsLayouts` is an administrator reclassifying a built-in - saying a
 * design the shipped file offers for both layouts should be offered for one,
 * or the reverse. `data` is a JSON column, so a new field needs no schema
 * change; a row written before it simply has none and the file's list stands.
 */
export type TemplateOverride = {
  id: string;
  name?: string;
  description?: string;
  disabled?: boolean;
  skillsLayouts?: TechnicalSkillsLayout[];
  createdAt: string;
  updatedAt: string;
};

const templates = new DocumentTable<Template>('templates', (template) => ({
  name: template.name,
  disabled: template.disabled ? 1 : 0,
}));

const overrides = new DocumentTable<TemplateOverride>('template_overrides', (override) => ({
  name: override.name ?? '',
  disabled: override.disabled ? 1 : 0,
}));

export function listStoredTemplates(): Template[] {
  return templates.list();
}

export function getStoredTemplate(id: string): Template | null {
  return templates.get(id);
}

export function hasStoredTemplate(id: string): boolean {
  return templates.has(id);
}

export function saveStoredTemplate(template: Template): Template {
  // The capability flags are worked out from the markup on every read. Stored,
  // they would only be a second copy that goes stale the next time the HTML is
  // rebuilt, so they are never written.
  const { supportsSoftSkills: _soft, supportsStrengths: _strengths, ...stored } = template;
  return templates.save(stored as Template);
}

export function deleteStoredTemplate(id: string): boolean {
  return templates.delete(id);
}

export function getTemplateOverride(id: string): TemplateOverride | null {
  return overrides.get(id);
}

export function saveTemplateOverride(override: TemplateOverride): TemplateOverride {
  return overrides.save(override);
}
