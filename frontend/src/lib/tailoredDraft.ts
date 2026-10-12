/**
 * The builder's "Manual Edits (JSON)" box: what it holds, and what it sends.
 *
 * A tailored resume comes back from the server whole, but most of it is worked
 * out again every time it is sent back (services/resumeService.ts
 * `parseTailoredResumeContent`): the title is the profile's headline with the
 * kind of role composed onto it, each role's company, title, dates and place
 * come from the profile, a role's description is always empty, and the skill
 * lists, the Soft Skills section and Strengths are derived from `skillGroups`
 * and the profile. An edit to any of those was silently undone. So what the
 * box offers to change is only what an edit can change - the summary, each
 * role's bullets, the skill groups, the cover letter, and the title (which
 * counts only while the profile has no headline). Each role also carries its
 * company, title and dates, but only to say which role its bullets are: the
 * server restores all three from the profile whatever the box says, and the
 * note under it says so. The dates stay because the server tells two stints
 * under one company and title apart by them (tailorContract.ts
 * `closestStint`): without them, an answer listing the stints newest first
 * over a profile typed oldest first came back with each stint's bullets under
 * the other's dates. A role's place identifies nothing, so it is not shown.
 *
 * Imports nothing at runtime (types only), so
 * backend/test/frontendTailoring.test.js runs it, against the server's own
 * parse.
 */

import type { SkillGroup, TailoredContent, TailoredContentEdit } from './api';

/** The line under the box. */
export const TAILORED_DRAFT_NOTE =
  'Skills are edited in skillGroups (the soft-skill group is marked "soft": true); the skill lists, Soft Skills and Strengths are worked out from it and from the profile. The title is rebuilt from the profile\'s headline when it has one, and a role\'s company, title and dates only say which role its bullets belong to: they print as the profile has them.';

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function skillGroupsOf(value: unknown): SkillGroup[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((group): group is Record<string, unknown> => typeof group === 'object' && group !== null && !Array.isArray(group))
    .map((group) => ({
      category: text(group.category),
      skills: strings(group.skills),
      ...(group.soft === true ? { soft: true as const } : {}),
    }));
}

/**
 * The editable part of a tailored resume, in the box's order. A content from
 * before skill groups (none) shows an empty list, which the server reads as
 * "the profile's own skills".
 */
export function tailoredEditOf(content: TailoredContent | TailoredContentEdit): TailoredContentEdit {
  const experience = Array.isArray(content.experience) ? content.experience : [];
  return {
    title: text(content.title),
    summary: text(content.summary),
    experience: experience.map((role) => ({
      title: text(role?.title),
      company: text(role?.company),
      startDate: text(role?.startDate),
      endDate: text(role?.endDate),
      achievements: strings(role?.achievements),
    })),
    skillGroups: skillGroupsOf(content.skillGroups),
    ...(typeof content.coverLetter === 'string' ? { coverLetter: content.coverLetter } : {}),
  };
}

/** The box's text for a content the server answered: its editable part, pretty-printed. '' for none. */
export function tailoredDraftOf(content: TailoredContent | TailoredContentEdit | null | undefined): string {
  return content ? JSON.stringify(tailoredEditOf(content), null, 2) : '';
}

/**
 * The box's text read back: the edit to send, or the sentence that says why
 * it cannot be. Blank is no edit (`content` null, no error). Only one JSON
 * object is an edit - an array or a bare value would reach the server as
 * something its parse refuses, and a refusal there reads like a stale
 * analysis to the page.
 */
export function readTailoredDraft(value: string): { content: TailoredContentEdit | null; error: string } {
  if (!value.trim()) return { content: null, error: '' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { content: null, error: 'Invalid JSON. Fix errors before updating the preview.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { content: null, error: 'The edits must be one JSON object, like the one shown.' };
  }
  return { content: tailoredEditOf(parsed as TailoredContentEdit), error: '' };
}
