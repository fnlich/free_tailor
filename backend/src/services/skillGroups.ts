import type { SkillGroup } from '../types/template';

export type { SkillGroup } from '../types/template';

/**
 * The model's Technical Skills block (`skillGroups`), read the same way by the
 * tailoring parse and by the render gate.
 *
 * One module and not two copies because the two must never disagree: the
 * parse decides which group is the soft-skill group and marks it, and the
 * render gate re-finds it on every render - content reaches the renderer
 * un-parsed (a held preview, a queued payload, `/resume/preview` with no
 * analysis), and a Soft Skills switch can flip between the preview and the
 * build. Pure: no library, no settings, no I/O, so either side can import it.
 *
 * The tailoring prompt promises the block "is printed exactly as you return
 * it. Nothing reorders it, merges it, spell-checks it or fills it out" - so
 * nothing here does. It only makes the shape safe to print.
 */

/**
 * The headings the soft-skill group may be given, one drawn per resume for
 * `[[softSkillGroupHeading]]`. Closed, so a group is recognised as the soft
 * one by its heading only when it is one of these: a technical group the
 * model happened to put last is never routed into a Soft Skills section.
 */
export const SOFT_SKILL_GROUP_HEADINGS = [
  'Soft Skills',
  'Professional Skills',
  'Interpersonal Skills',
  'Collaboration & Communication',
  'Working Style',
  'Core Competencies',
] as const;

/**
 * A safety bound, not a style rule: the prompt asks for 2-6 technical groups
 * and the soft-skill group, holding the candidate's own stack (ordinarily
 * 10-25 skills, under 30 for a long one), so these are never reached by an
 * answer that follows it. They stop a
 * runaway answer, or content a client sends back, from becoming a block that
 * fills the page.
 */
export const MAX_SKILL_GROUPS = 12;
export const MAX_SKILLS_PER_GROUP = 40;

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * The block as printable groups: strings only, each trimmed with its inner
 * whitespace collapsed, empty skills dropped, a group left with no skills
 * dropped, `soft` kept only when it is exactly `true`. A missing or
 * non-string heading reads as '' (a group with no heading). Nothing is
 * de-duplicated, re-spelled or reordered, and nothing is checked against the
 * skill library.
 */
export function sanitizeSkillGroups(value: unknown): SkillGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: SkillGroup[] = [];
  for (const entry of value) {
    if (groups.length >= MAX_SKILL_GROUPS) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const raw = entry as { category?: unknown; skills?: unknown; soft?: unknown };
    if (!Array.isArray(raw.skills)) continue;
    const skills = raw.skills
      .map(cleanText)
      .filter(Boolean)
      .slice(0, MAX_SKILLS_PER_GROUP);
    if (skills.length === 0) continue;
    groups.push({
      category: cleanText(raw.category),
      skills,
      ...(raw.soft === true ? { soft: true as const } : {}),
    });
  }
  return groups;
}

function sameHeading(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The index of the soft-skill group, or -1 when there is none. In order:
 *
 * 1. a group marked `soft: true` - the parse marks the one it found, and the
 *    mark survives a person editing its heading in the builder's JSON box;
 * 2. the group headed exactly the heading drawn for this resume
 *    (case-insensitive);
 * 3. the LAST group, but only when its heading is one of
 *    `SOFT_SKILL_GROUP_HEADINGS`.
 *
 * Never "simply the last group": an answer that left the soft group out, or
 * misspelled its heading, would otherwise send its last technical group into
 * the Soft Skills section.
 */
export function findSoftSkillGroup(groups: readonly SkillGroup[], heading?: string): number {
  const marked = groups.findIndex((group) => group.soft === true);
  if (marked !== -1) return marked;
  const drawn = cleanText(heading);
  if (drawn) {
    const named = groups.findIndex((group) => sameHeading(group.category, drawn));
    if (named !== -1) return named;
  }
  const last = groups.length - 1;
  if (last >= 0 && SOFT_SKILL_GROUP_HEADINGS.some((candidate) => sameHeading(groups[last].category, candidate))) {
    return last;
  }
  return -1;
}

/**
 * Every skill of the groups as one list - the Plain layout - in the order
 * written, a repeat (case-insensitive) kept only where it first appears.
 */
export function flattenSkillGroups(groups: readonly SkillGroup[]): string[] {
  const seen = new Set<string>();
  const flat: string[] = [];
  for (const group of groups) {
    for (const skill of group.skills) {
      const key = skill.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      flat.push(skill);
    }
  }
  return flat;
}
