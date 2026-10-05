import type { Profile, TechnicalSkillsLayout } from '../types/profile';
import type { Template } from '../types/template';
import { PublicError } from '../middleware/publicError';
import { getAllTemplates, getTemplateById } from '../extractors/templateExtractor';
import { inferTemplateSkillsLayouts } from './templateImport';
import { getProfileTechnicalSkillsLayout } from './profileService';

/**
 * Which template a resume is drawn with - ONE answer for the live profile
 * preview, `/resume/preview`, `/resume/generate` and the queue.
 *
 * It was two copies (the resume routes and the queue task) that already
 * agreed, and the preview would have been a third. Three copies of a fallback
 * rule are three chances for the preview to show one template and the PDF to
 * print another.
 */

/** The template every install ships and every fallback ends at. It renders both layouts. */
export const FALLBACK_TEMPLATE_ID = 'default';

/** True when `template` lists `layout`; a template carrying no list is read off its markup. */
export function templateSupportsLayout(
  template: Pick<Template, 'skillsLayouts' | 'htmlContent'>,
  layout: TechnicalSkillsLayout
): boolean {
  const layouts =
    Array.isArray(template.skillsLayouts) && template.skillsLayouts.length > 0
      ? template.skillsLayouts
      : inferTemplateSkillsLayouts(template.htmlContent);
  return layouts.includes(layout);
}

export interface TemplateChoiceOptions {
  /**
   * Let a disabled REQUESTED template through. For an administrator previewing
   * a template they have taken out of circulation; nothing that writes a file
   * passes it, so a disabled template is never printed.
   */
  allowDisabledRequested?: boolean;
}

const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[templates] ${message}`);
}

/**
 * The template for this profile: the one requested, else the profile's own
 * `preferredTemplate`, else `default` - the first of those that is enabled AND
 * lists the profile's skills layout.
 *
 * It never fails a resume over the layout. An administrator can reclassify a
 * template after a profile chose it, and a profile can change layout while a
 * queued task still names its old template; refusing a paid generation for
 * either would be the app's mistake billed to the person. So when none of the
 * three fits, it takes the first enabled template that does list the layout,
 * and failing even that, the first enabled one of the three as it is - logged
 * once, so an operator can see a choice that no longer fits. `null` only when
 * no template is enabled at all, which is what it has always meant.
 */
export async function resolveTemplateForProfile(
  profile: Pick<Profile, 'id' | 'preferredTemplate' | 'profileSettings'>,
  requestedTemplateId?: string,
  options: TemplateChoiceOptions = {}
): Promise<Template | null> {
  const layout = getProfileTechnicalSkillsLayout(profile);
  const requested = typeof requestedTemplateId === 'string' ? requestedTemplateId.trim() : '';
  const candidateIds = [
    requested,
    typeof profile.preferredTemplate === 'string' ? profile.preferredTemplate.trim() : '',
    FALLBACK_TEMPLATE_ID,
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);

  const usable: Template[] = [];
  for (const candidateId of candidateIds) {
    const template = await getTemplateById(candidateId);
    if (!template) continue;
    const allowed = !template.disabled || (options.allowDisabledRequested === true && candidateId === requested);
    if (allowed) usable.push(template);
  }

  const fitting = usable.find((template) => templateSupportsLayout(template, layout));
  if (fitting) return fitting;

  const firstChoice = usable[0];
  const anyFitting = (await getAllTemplates()).find(
    (template) => !template.disabled && templateSupportsLayout(template, layout)
  );
  if (anyFitting) {
    if (firstChoice) {
      warnOnce(
        `layout:${profile.id}:${firstChoice.id}:${layout}`,
        `Profile ${profile.id} uses the ${layout} skills layout, which template "${firstChoice.id}" does not ` +
          `offer; drawing it with "${anyFitting.id}" instead.`
      );
    }
    return anyFitting;
  }

  if (firstChoice) {
    warnOnce(
      `nolayout:${firstChoice.id}:${layout}`,
      `No enabled template offers the ${layout} skills layout; drawing with "${firstChoice.id}" anyway.`
    );
  }
  return firstChoice ?? null;
}

/**
 * No enabled template to render with, not even the default. The fix is an
 * administrator's (Admin -> Templates), so the reader is told whom to ask and
 * the log gets a ref.
 */
export function noTemplateAvailable(): PublicError {
  return new PublicError('No resume template is available right now. Please contact your administrator.', {
    status: 503,
    detail: 'No enabled template was found, not even "default".',
  });
}
