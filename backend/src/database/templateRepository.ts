import { Template } from '../types/template';
import { DocumentTable } from './documentTable';

/**
 * Editable overrides for built-in (static) templates. Only presentation fields
 * can be changed; the HTML always comes from the static template file.
 */
export type TemplateOverride = {
  id: string;
  name?: string;
  description?: string;
  disabled?: boolean;
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
  return templates.save(template);
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
