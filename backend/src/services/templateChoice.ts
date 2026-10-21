import type { Profile } from '../types/profile';
import type { Template } from '../types/template';
import { PublicError } from '../middleware/publicError';
import { getAllTemplates, getTemplateById } from '../extractors/templateExtractor';

/**
 * Which template a resume is drawn with - ONE answer for the live profile
 * preview, `/resume/preview`, `/resume/preview-all` and the queue.
 *
 * It was two copies (the resume routes and the queue task) that already
 * agreed, and the preview would have been a third. Three copies of a fallback
 * rule are three chances for the preview to show one template and the PDF to
 * print another.
 */

/** The template every install ships and every fallback ends at. */
export const FALLBACK_TEMPLATE_ID = 'default';

export interface TemplateChoiceOptions {
  /**
   * Let a disabled REQUESTED template through. For an administrator previewing
   * a template they have taken out of circulation; nothing that writes a file
   * passes it, so a disabled template is never printed.
   */
  allowDisabledRequested?: boolean;
}

/**
 * The template for this profile: the one requested, else the profile's own
 * `preferredTemplate`, else `default` - the first of those that exists and is
 * enabled. Failing all three, the first enabled template there is (newest
 * first, as the list is served), so a resume is never refused while anything
 * can draw it; `null` only when no template is enabled at all.
 *
 * Every template prints both Technical Skills layouts, so the layout plays no
 * part in the choice.
 */
export async function resolveTemplateForProfile(
  profile: Pick<Profile, 'preferredTemplate'>,
  requestedTemplateId?: string,
  options: TemplateChoiceOptions = {}
): Promise<Template | null> {
  const requested = typeof requestedTemplateId === 'string' ? requestedTemplateId.trim() : '';
  const candidateIds = [
    requested,
    typeof profile.preferredTemplate === 'string' ? profile.preferredTemplate.trim() : '',
    FALLBACK_TEMPLATE_ID,
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);

  for (const candidateId of candidateIds) {
    const template = await getTemplateById(candidateId);
    if (!template) continue;
    if (!template.disabled || (options.allowDisabledRequested === true && candidateId === requested)) return template;
  }

  return (await getAllTemplates()).find((template) => !template.disabled) ?? null;
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
