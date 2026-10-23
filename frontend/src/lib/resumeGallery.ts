/**
 * What the Profiles pages decide with no React in them, in the order a new
 * resume meets them, after FlowCV's: the template chooser's filters, a
 * template's gallery page in either Technical Skills layout, what the detail
 * dialog says a template does, the link from the chooser to the editor (and
 * reading it back), and, on the list, how a card says when its resume was
 * edited, what Duplicate sends and what Download saves.
 *
 * Imports types only, so backend/test/frontendEditorHelpers.test.js can run it
 * beside the server's config/templateCategories.ts and resume import.
 */
import type {
  AiPreferences,
  CreateResumeDTO,
  Resume,
  TechnicalSkillsLayout,
  Template,
  TemplateCategory,
} from './api';

// ------------------------------------------------------------ the chooser

/** The server's categories, in its order (config/templateCategories.ts; drift-tested). */
export const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = ['simple', 'modern', 'creative'];

export type TemplateFilter = 'all' | TemplateCategory;

export const TEMPLATE_FILTER_LABELS: Record<TemplateFilter, string> = {
  all: 'All Templates',
  simple: 'Simple',
  modern: 'Modern',
  creative: 'Creative',
};

/**
 * The chooser's filter pills: All, then each category some offered template
 * is filed under, so no pill ever shows an empty grid. A template with no
 * category - one an administrator saved - is under All only.
 */
export function templateFilters(templates: ReadonlyArray<Pick<Template, 'category'>>): TemplateFilter[] {
  return ['all', ...TEMPLATE_CATEGORIES.filter((category) => templates.some((template) => template.category === category))];
}

export function templatesForFilter<T extends Pick<Template, 'category'>>(templates: readonly T[], filter: TemplateFilter): T[] {
  return filter === 'all' ? [...templates] : templates.filter((template) => template.category === filter);
}

/**
 * A template's gallery page: the sample person, tailored, in either Technical
 * Skills layout - every template prints both, so the chooser's details and
 * Admin -> Templates' View switch between them. A path on the API's origin,
 * for a frame's `src` (lib/api.ts `getApiOrigin`); Grouped unless asked.
 */
export function templatePreviewPath(templateId: string, layout: TechnicalSkillsLayout = 'categorized'): string {
  return `/api/templates/${encodeURIComponent(templateId)}/preview?layout=${layout}`;
}

/**
 * What the detail dialog lists under a template's name: only what its own
 * record says it does, in FlowCV's short lines. The four flags are the
 * server's, worked out from the markup on every read.
 */
export function templateFeatures(
  template: Pick<Template, 'supportsSoftSkills' | 'supportsStrengths' | 'printsSections' | 'nativeSectionOrder'>
): string[] {
  // Every template prints both layouts; the details' Grouped / Plain switch shows each.
  const features = ['A4 page, print-ready PDF', 'Technical skills grouped under headings, or as one list'];

  const soft = template.supportsSoftSkills;
  const strengths = template.supportsStrengths;
  if (soft && strengths) features.push('Soft skills and strengths sections');
  else if (soft) features.push('A soft skills section');
  else if (strengths) features.push('A strengths section');

  const prints = template.printsSections;
  if (prints.includes('projects') && prints.includes('custom')) {
    features.push('Projects, languages, awards and sections of your own');
  }
  if (template.nativeSectionOrder.length > 1) features.push('Sections in the order you arrange them');

  features.push('Switch to another template any time');
  return features;
}

// ------------------------------------------------- from the chooser to the editor

export const NEW_RESUME_PATH = '/admin/resumes/new';

/**
 * The editor for a new resume on a template, as a link the chooser goes to:
 * a reload keeps the choice, and Back returns to the chooser. The layout is
 * the one the details were showing when Use this template was pressed, named
 * only when it is not the default.
 */
export function startResumeHref(
  templateId: string,
  layout: TechnicalSkillsLayout = 'categorized',
  profileId?: string | null
): string {
  const query = new URLSearchParams({ template: templateId });
  if (layout === 'flat') query.set('layout', 'flat');
  const profile = typeof profileId === 'string' ? profileId.trim() : '';
  if (profile) query.set('profile', profile);
  return `${NEW_RESUME_PATH}?${query.toString()}`;
}

/** Starting with no template: `default` draws it until one is chosen in Customize. */
export const START_WITHOUT_TEMPLATE_HREF = `${NEW_RESUME_PATH}?template=`;

/** The same, filed under a profile: `?template=&profile=<id>`; with none, START_WITHOUT_TEMPLATE_HREF. */
export function startWithoutTemplateHref(profileId?: string | null): string {
  const profile = typeof profileId === 'string' ? profileId.trim() : '';
  if (!profile) return START_WITHOUT_TEMPLATE_HREF;
  return `${START_WITHOUT_TEMPLATE_HREF}&profile=${encodeURIComponent(profile)}`;
}

export interface StartChoice {
  /** '' when the person started without one. */
  templateId: string;
  layout: TechnicalSkillsLayout;
}

/**
 * What /admin/resumes/new's address asks for, checked against the templates
 * on offer. Null shows the chooser: no `template` at all, or one that is not
 * offered (disabled or deleted since the link was made). `template=` with
 * nothing after it starts without one. The layout is Plain when the address
 * says `flat`, else Grouped - every template prints both.
 */
export function readStartChoice(
  params: { template: string | null; layout: string | null },
  templates: ReadonlyArray<Pick<Template, 'id'>>
): StartChoice | null {
  if (params.template === null) return null;
  const layout: TechnicalSkillsLayout = params.layout === 'flat' ? 'flat' : 'categorized';
  const id = params.template.trim();
  if (!id) return { templateId: '', layout };
  const template = templates.find((candidate) => candidate.id === id);
  return template ? { templateId: template.id, layout } : null;
}

// ------------------------------------------------------------- the cards

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * A card's "Edited 6 hours ago", FlowCV's line. Null for a week or more, or a
 * time that does not read: the page prints the date there instead (formatDate,
 * which every page shares). A time ahead of this clock is "just now".
 */
export function editedAgo(updatedAt: string | undefined, now: number): string | null {
  const at = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  if (Number.isNaN(at)) return null;
  const elapsed = Math.max(0, now - at);
  const ago = (count: number, unit: string) => `Edited ${count} ${unit}${count === 1 ? '' : 's'} ago`;
  if (elapsed < MINUTE_MS) return 'Edited just now';
  if (elapsed < HOUR_MS) return ago(Math.floor(elapsed / MINUTE_MS), 'minute');
  if (elapsed < DAY_MS) return ago(Math.floor(elapsed / HOUR_MS), 'hour');
  if (elapsed < 7 * DAY_MS) return ago(Math.floor(elapsed / DAY_MS), 'day');
  return null;
}

/**
 * Duplicate's body: a resume's whole content and settings as a new
 * resume's, without what makes it this one - its id, its times, whether it
 * is switched off, the profile it is filed under (the caller names the
 * profile with `?profileId=`) and its derived keywords. It KEEPS the template:
 * any resume may use any template.
 * `ai` is the model choice as a new resume may save it (lib/resumeModelChoice.ts
 * `savableModelChoice`: one no longer offered goes back to the app default).
 */
export function duplicateResumeBody(resume: Resume, ai: AiPreferences): CreateResumeDTO {
  const { id, createdAt, updatedAt, disabled, profileId, matchKeywords, resumeSettings, ...content } = resume;
  void [id, createdAt, updatedAt, disabled, profileId, matchKeywords];
  return { ...content, resumeSettings: { ...(resumeSettings ?? {}), ai } };
}

/**
 * Download's file name: the resume's name in lower case, words joined by
 * hyphens, letters and digits of any script kept. Import JSON reads the file
 * back as a resume.
 */
export function resumeExportFileName(resume: Pick<Resume, 'name'>): string {
  const base = (resume.name ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return `${base || 'resume'}.json`;
}

/**
 * Download's file: the resume as the server holds it less what is the server's
 * bookkeeping - the profile it is filed under and its derived keywords - which
 * is a file Import JSON takes (an import stores none of them).
 */
export function resumeExportText(resume: Resume): string {
  const { profileId, matchKeywords, ...document } = resume;
  void [profileId, matchKeywords];
  return `${JSON.stringify(document, null, 2)}\n`;
}
