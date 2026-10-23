import type { Resume } from '../types/resume';

/**
 * The rules of profiles (people) and their resumes that need no database.
 *
 * Pure on purpose, and the only place they live: the repository places a
 * resume with them, the routes name a profile with them, the dashboard's
 * summary and the builder's choice of a default read them, and a rule written
 * twice drifts. A leaf module (types only), so the tests load it by itself.
 */

/** What a profile with no name is called - and the name a resume with none is filed under. */
export const UNTITLED_PROFILE_NAME = 'Untitled Profile';

/** The longest a profile's name may be, in characters. */
export const MAX_PROFILE_NAME_LENGTH = 100;

/** A name with its spacing made one way: Unicode NFC, trimmed, every run of whitespace one space. */
function tidy(name: unknown): string {
  return typeof name === 'string' ? name.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
}

/** Characters as a person counts them: an emoji or a letter with a combining mark is one, not two. */
function lengthOf(text: string): number {
  return Array.from(text).length;
}

/**
 * Who a name is, for deciding whether two resumes are one person's: NFC,
 * trimmed, inner whitespace collapsed, lower-cased. A blank name and the
 * normaliser's default 'Untitled Profile' share one key, so resumes nobody
 * named end up together instead of one profile each.
 *
 * It is the key of the name a profile would be GIVEN (`profileNameForPerson`,
 * cut to the longest a profile name may be), so a resume whose name is longer
 * than that still finds the profile that was made for it: the profile stores
 * the cut name, and a key of the full name could never match it.
 */
export function personKey(name: unknown): string {
  return profileNameForPerson(name).toLowerCase();
}

/**
 * The name of a profile made for a person: their name as written, tidied and
 * cut to the longest a profile name may be, or 'Untitled Profile' when blank.
 */
export function profileNameForPerson(name: unknown): string {
  const tidied = tidy(name);
  if (!tidied) return UNTITLED_PROFILE_NAME;
  return lengthOf(tidied) > MAX_PROFILE_NAME_LENGTH
    ? Array.from(tidied).slice(0, MAX_PROFILE_NAME_LENGTH).join('').trim()
    : tidied;
}

export type ProfileNameRefusal = {
  ok: false;
  code: 'profile-name-required' | 'profile-name-too-long';
  message: string;
};

/**
 * A name somebody typed for a profile: the tidied name, or the sentence and
 * code to refuse it with. Blank (or not text at all) is `profile-name-required`;
 * more than 100 characters is `profile-name-too-long`, never cut quietly - a
 * name the person did not choose would be a surprise on a card.
 */
export function readProfileName(value: unknown): { ok: true; name: string } | ProfileNameRefusal {
  const name = tidy(value);
  if (!name) {
    return { ok: false, code: 'profile-name-required', message: 'Give the profile a name.' };
  }
  if (lengthOf(name) > MAX_PROFILE_NAME_LENGTH) {
    return {
      ok: false,
      code: 'profile-name-too-long',
      message: `A profile name can be at most ${MAX_PROFILE_NAME_LENGTH} characters.`,
    };
  }
  return { ok: true, name };
}

/** What the default rules need to know about a resume. */
export type ResumeMember = { id: string; disabled?: boolean; createdAt: string };

/** Oldest first; a date nobody can read sorts last, and ties go to the lower id, so the answer never depends on row order. */
export function oldestFirst<T extends { id: string; createdAt: string }>(members: readonly T[]): T[] {
  const time = (member: T) => {
    const parsed = Date.parse(member.createdAt);
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
  };
  return [...members].sort((left, right) => {
    const a = time(left);
    const b = time(right);
    if (a !== b) return a < b ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/** The oldest enabled resume, else the oldest; null when there are none. */
function oldestEnabledElseOldest(members: readonly ResumeMember[]): string | null {
  const ordered = oldestFirst(members);
  const enabled = ordered.find((member) => !member.disabled);
  return (enabled ?? ordered[0])?.id ?? null;
}

/**
 * The resume Fully Tailor starts from: the profile's chosen default while it
 * is an ENABLED resume of the profile, else the oldest enabled resume, else
 * the oldest. Disabling the chosen one therefore writes nothing - the choice
 * is kept, and enabling it again brings it back.
 */
export function effectiveDefaultResumeId(
  chosen: string | null | undefined,
  members: readonly ResumeMember[]
): string | null {
  const stored = chosen ? members.find((member) => member.id === chosen) : undefined;
  if (stored && !stored.disabled) return stored.id;
  return oldestEnabledElseOldest(members);
}

/**
 * The default a profile is given when the one it had has left (deleted, or
 * moved to another profile): the oldest enabled resume, else the oldest;
 * null when none is left, and the profile then stores none.
 */
export function repointedDefaultResumeId(members: readonly ResumeMember[]): string | null {
  return oldestEnabledElseOldest(members);
}

/**
 * What a resume is called where there are several of one person's: its
 * headline, unless that is empty or the normaliser's default 'Professional';
 * else the name printed on it, unless that is blank; else 'Untitled resume'.
 */
export function resumeLabelOf(resume: Pick<Resume, 'title' | 'name'>): string {
  const headline = tidy(resume.title);
  if (headline && headline !== 'Professional') return headline;
  const name = tidy(resume.name);
  return name || 'Untitled resume';
}
