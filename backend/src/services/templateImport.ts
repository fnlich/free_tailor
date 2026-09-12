import type { ManualTemplateConfigStored, Template } from '../types/template';

/**
 * Reading an uploaded template file.
 *
 * The same shape of problem as `profileImport`, and solved the same way, for
 * the same reason: the JSON the export button produces should go back in
 * without being edited first. Three things stopped that.
 *
 * A file holding MORE THAN ONE template was refused outright. That is the file
 * anyone with a set of templates has, and the one an "export all" produces.
 *
 * A file with no `sections` was refused, though nothing at render time reads
 * that field - it is metadata, and demanding it turned a hand-written template
 * into an error over a list the importer can work out for itself.
 *
 * And `manualConfig` was cast to its type unchecked, so a file with a string
 * where a number belonged was stored and only failed later, in the editor, on a
 * template that looked fine in the list.
 */

/** A guard against a misdirected file, not a policy. */
export const MAX_TEMPLATES_PER_IMPORT = 50;

/** The keys a document may carry a list of templates under. */
const LIST_KEYS = ['templates', 'items', 'data'] as const;

/**
 * How short a template's HTML may be before it is not a template.
 *
 * A real one is thousands of characters. This only has to catch the file that
 * is a different kind of JSON with an `htmlContent` string in it.
 */
const MIN_HTML_LENGTH = 100;

export class TemplateImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateImportError';
  }
}

export type ImportedTemplate = {
  template: Template;
  /** True when the file's own id was free and has been kept. */
  keptId: boolean;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function readTemplateImportDocument(document: unknown): unknown[] {
  if (Array.isArray(document)) return document;

  if (!isPlainObject(document)) {
    throw new TemplateImportError(
      'That file is not a template. Expected a JSON object, a list of them, or { "templates": [ ... ] }.'
    );
  }

  for (const key of LIST_KEYS) {
    if (Array.isArray(document[key])) return document[key] as unknown[];
  }

  return [document];
}

/** Where an entry sits in the file, for an error someone can act on. */
function describePosition(index: number, total: number, name?: unknown): string {
  const where = total === 1 ? 'That file' : `Template ${index + 1} of ${total}`;
  return isNonEmptyString(name) ? `${where} ("${name.trim()}")` : where;
}

/**
 * The sections a template renders, worked out from its own markup.
 *
 * Only consulted when the file names none. It is a list nothing reads at render
 * time - the markup decides what is drawn - so guessing it wrong costs a label
 * in the admin list, while demanding it costs the import.
 */
export function inferTemplateSections(html: string): string[] {
  const probes: Array<[string, RegExp]> = [
    ['summary', /\{\{[#\w\s]*summary\b/],
    ['experience', /\{\{[#\w\s]*experience\b/],
    ['skills', /\{\{[#\w\s]*(skillCategories|hardSkills|skills)\b/],
    ['education', /\{\{[#\w\s]*education\b/],
    ['certifications', /\{\{[#\w\s]*certifications\b/],
    ['strengths', /\{\{[#\w\s]*strengths\b/],
  ];
  const found = probes.filter(([, probe]) => probe.test(html)).map(([section]) => section);
  // Never empty: an empty list is the thing the old check refused over, and a
  // template whose markup names no known section still renders whatever it has.
  return found.length > 0 ? found : ['summary', 'experience', 'skills', 'education'];
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function readStyle(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? { ...value } : undefined;
}

/**
 * Checks `manualConfig` rather than casting it.
 *
 * What this config drives is the visual editor, and the editor trusts its
 * types: a font size that arrived as the string "9pt" reaches an arithmetic
 * comparison and produces a template that renders as a blank page. Casting made
 * that a problem for whoever opened the template next, with nothing linking it
 * back to the import.
 *
 * Unrecognised keys are dropped rather than refused. A config written by a
 * newer build is still a usable template in this one, and the editor rewrites
 * the whole object when it next saves.
 */
export function normalizeManualConfig(value: unknown): ManualTemplateConfigStored | undefined {
  if (!isPlainObject(value)) return undefined;
  const name = isNonEmptyString(value.name) ? value.name.trim() : '';
  if (!name) return undefined;

  // Coerced rather than refused, because "9pt" is what a person writes when the
  // field is a font size and it plainly means 9. What must not survive is the
  // STRING: it reaches an arithmetic comparison in the editor and renders a
  // blank page - a problem for whoever opens the template next, with nothing
  // linking it back to the import. Anything that is not a number at all
  // (`true`, an object, "large") is dropped so the editor's own default wins.
  const number = (raw: unknown): number | undefined => {
    const parsed = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const color = (raw: unknown): string | undefined =>
    isNonEmptyString(raw) && /^#?[0-9a-z(),.%\s-]+$/i.test(raw.trim()) ? raw.trim() : undefined;

  const config: ManualTemplateConfigStored = {
    name,
    columns: value.columns === 2 ? 2 : 1,
  };
  if (isNonEmptyString(value.description)) config.description = value.description.trim();
  const accentColor = color(value.accentColor);
  if (accentColor) config.accentColor = accentColor;
  const bodyColor = color(value.bodyColor);
  if (bodyColor) config.bodyColor = bodyColor;
  const bodyFontSizePt = number(value.bodyFontSizePt);
  if (bodyFontSizePt) config.bodyFontSizePt = bodyFontSizePt;
  const titleFontSizePt = number(value.titleFontSizePt);
  if (titleFontSizePt) config.titleFontSizePt = titleFontSizePt;

  const sectionOrder = readStringList(value.sectionOrder);
  if (sectionOrder.length > 0) config.sectionOrder = sectionOrder;
  const leftSectionOrder = readStringList(value.leftSectionOrder);
  if (leftSectionOrder.length > 0) config.leftSectionOrder = leftSectionOrder;
  const rightSectionOrder = readStringList(value.rightSectionOrder);
  if (rightSectionOrder.length > 0) config.rightSectionOrder = rightSectionOrder;

  const nameStyle = readStyle(value.nameStyle);
  if (nameStyle) config.nameStyle = nameStyle;
  const headerTitleStyle = readStyle(value.headerTitleStyle);
  if (headerTitleStyle) config.headerTitleStyle = headerTitleStyle;
  const contactStyle = readStyle(value.contactStyle);
  if (contactStyle) config.contactStyle = contactStyle;

  if (isPlainObject(value.sectionStyles)) {
    const sectionStyles: Record<string, Record<string, Record<string, unknown>>> = {};
    for (const [section, roles] of Object.entries(value.sectionStyles)) {
      if (!isPlainObject(roles)) continue;
      const kept: Record<string, Record<string, unknown>> = {};
      for (const [role, style] of Object.entries(roles)) {
        if (isPlainObject(style)) kept[role] = { ...style };
      }
      if (Object.keys(kept).length > 0) sectionStyles[section] = kept;
    }
    if (Object.keys(sectionStyles).length > 0) config.sectionStyles = sectionStyles;
  }

  return config;
}

function assertLooksLikeTemplate(
  entry: unknown,
  index: number,
  total: number
): Record<string, unknown> {
  if (!isPlainObject(entry)) {
    throw new TemplateImportError(`${describePosition(index, total)} is not a JSON object.`);
  }
  const where = describePosition(index, total, entry.name);

  if (!isNonEmptyString(entry.name)) {
    throw new TemplateImportError(
      `${where} has no "name". Every template needs one - it is what the list shows.`
    );
  }

  if (!isNonEmptyString(entry.htmlContent)) {
    throw new TemplateImportError(
      `${where} has no "htmlContent". That field holds the template's markup, and without it there ` +
        'is nothing to render. Check that this is a template file and not something else that ' +
        'happens to be JSON.'
    );
  }

  if (entry.htmlContent.length < MIN_HTML_LENGTH) {
    throw new TemplateImportError(
      `${where} has an "htmlContent" of only ${entry.htmlContent.length} characters, which is too ` +
        'short to be a resume layout.'
    );
  }

  return entry;
}

/** An ISO timestamp the file can be trusted to have meant. */
function readTimestamp(value: unknown): string | null {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value)) ? value : null;
}

/** Ids are used in URLs and as storage keys, so only this alphabet survives. */
export function normalizeImportedTemplateId(value: unknown): string {
  return isNonEmptyString(value) ? value.trim().replace(/[^a-zA-Z0-9\-_]/g, '-') : '';
}

/**
 * Turns an uploaded document into templates ready to save.
 *
 * Validates EVERY entry before building any of them, so a file with one bad
 * template in the middle imports nothing rather than leaving the admin list
 * half updated and the person guessing which half.
 */
export function buildImportedTemplates(
  document: unknown,
  options: { idExists: (id: string) => boolean; newId: () => string; overrideId?: string }
): ImportedTemplate[] {
  const entries = readTemplateImportDocument(document);

  if (entries.length === 0) {
    throw new TemplateImportError('That file has no templates in it.');
  }

  if (entries.length > MAX_TEMPLATES_PER_IMPORT) {
    throw new TemplateImportError(
      `That file holds ${entries.length} templates; ${MAX_TEMPLATES_PER_IMPORT} is the most one ` +
        'import may carry.'
    );
  }

  // An id named by the caller is for ONE template. Applying it to each entry of
  // a list would have every one overwrite the last and import a single
  // template, silently, under a name from the middle of the file.
  if (options.overrideId && entries.length > 1) {
    throw new TemplateImportError(
      `That file holds ${entries.length} templates, so it cannot be imported under one chosen id. ` +
        'Import it without naming an id, or split the file.'
    );
  }

  const validated = entries.map((entry, index) =>
    assertLooksLikeTemplate(entry, index, entries.length)
  );

  const now = new Date().toISOString();
  const claimed = new Set<string>();

  return validated.map((entry) => {
    const requested = normalizeImportedTemplateId(options.overrideId ?? entry.id);
    const keptId = Boolean(requested) && !options.idExists(requested) && !claimed.has(requested);
    const id = keptId ? requested : options.newId();
    claimed.add(id);

    const htmlContent = entry.htmlContent as string;
    const sections = readStringList(entry.sections);
    const manualConfig = normalizeManualConfig(entry.manualConfig);

    return {
      keptId,
      template: {
        id,
        name: (entry.name as string).trim(),
        description: isNonEmptyString(entry.description) ? entry.description.trim() : '',
        disabled: typeof entry.disabled === 'boolean' ? entry.disabled : false,
        htmlContent,
        cssContent: typeof entry.cssContent === 'string' ? entry.cssContent : '',
        sections: sections.length > 0 ? sections : inferTemplateSections(htmlContent),
        // The template's own history is a fact about it and survives;
        // `updatedAt` does not, because this row was written just now.
        createdAt: readTimestamp(entry.createdAt) ?? now,
        updatedAt: now,
        ...(manualConfig ? { manualConfig } : {}),
      },
    };
  });
}
