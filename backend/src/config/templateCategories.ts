import type { TemplateCategory } from '../types/template';

/**
 * The styles the new-profile template chooser files a template under, as
 * FlowCV's does: Simple (one column, plain rules), Modern (a sidebar or a
 * coloured band), Creative (colour, cards, a timeline). A built-in names its
 * own in its JSON (`category`); a saved template may carry one too, and a
 * template without one is listed under All only. Pure, so the reader, the
 * importer and the tests share the one list.
 */
export const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = ['simple', 'modern', 'creative'];

export function isTemplateCategory(value: unknown): value is TemplateCategory {
  return typeof value === 'string' && (TEMPLATE_CATEGORIES as readonly string[]).includes(value);
}
