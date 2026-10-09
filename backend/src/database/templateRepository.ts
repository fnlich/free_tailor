import { Template, type TemplateSource } from '../types/template';
import type { TechnicalSkillsLayout } from '../types/profile';
import { DocumentTable } from './documentTable';
import {
  isTemplateSource,
  listSavedTemplateFiles,
  readSavedTemplateFile,
  removeSavedTemplateFile,
  templateFileExists,
  templateFileId,
  writeTemplateFile,
} from './templateFiles';

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

const overrides = new DocumentTable<TemplateOverride>('template_overrides', (override) => ({
  name: override.name ?? '',
  disabled: override.disabled ? 1 : 0,
}));

/*
 * Saved templates - imported, extracted, manual - are FILES, in
 * `static/templates` beside the built-ins (see templateFiles.ts). These four
 * keep the signatures they had when they read a table, so nothing above this
 * module has to know where a template lives.
 */

export function listStoredTemplates(): Template[] {
  return listSavedTemplateFiles();
}

/** A saved template by id. Never a built-in. */
export function getStoredTemplate(id: string): Template | null {
  const fileId = templateFileId(id);
  return fileId ? readSavedTemplateFile(fileId) : null;
}

/**
 * Whether the id is TAKEN: any file of that id, saved or built-in, readable
 * or not. What an import asks before keeping a file's own id, so it can never
 * be handed one a save would then refuse.
 */
export function hasStoredTemplate(id: string): boolean {
  const fileId = templateFileId(id);
  return fileId ? templateFileExists(fileId) : false;
}

/**
 * Where a template without a stated source came from, for the callers and the
 * rows that predate the field: the manual builder's config is unmistakable,
 * and everything else was brought in from outside.
 */
export function inferTemplateSource(template: Pick<Template, 'manualConfig'>): TemplateSource {
  return template.manualConfig ? 'manual' : 'uploaded';
}

/**
 * Writes a saved template's file. Throws `TemplateStoreError` when it cannot
 * - an id no file may carry, a built-in's id, a directory it cannot write -
 * and a route answers that with the generic "could not be saved" sentence.
 *
 * The source is the template's own when it states one, else the one its file
 * already records (an edit made through a read that dropped it), else
 * inferred. The capability flags are never written: they are worked out from
 * the markup on every read, and stored they would only go stale.
 */
export function saveStoredTemplate(template: Template): Template {
  const source = isTemplateSource(template.source)
    ? template.source
    : (getStoredTemplate(template.id)?.source ?? inferTemplateSource(template));
  writeTemplateFile(template, source);
  const { supportsSoftSkills: _soft, supportsStrengths: _strengths, isBuiltIn: _builtIn, ...stored } = template;
  return { ...stored, source } as Template;
}

/** Removes a saved template's file. False for an unknown id, and for a built-in, which stays. */
export function deleteStoredTemplate(id: string): boolean {
  const fileId = templateFileId(id);
  return fileId ? removeSavedTemplateFile(fileId) : false;
}

export function getTemplateOverride(id: string): TemplateOverride | null {
  return overrides.get(id);
}

export function saveTemplateOverride(override: TemplateOverride): TemplateOverride {
  return overrides.save(override);
}
