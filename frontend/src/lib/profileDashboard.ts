import type { ProfileSummary, Resume, ResumeKeywords } from './api';

/*
 * The decisions of the Profiles pages (the dashboard at /admin/profiles and a
 * profile's page), with no React in them and no runtime import - types only -
 * so backend/test loads this file and runs it against the server.
 *
 * A profile is a PERSON and holds that person's resumes; a resume is one resume
 * document; the account is the signed-in user's own settings.
 */

/* ------------------------------------------------------------------ tabs */

/** The dashboard's two tabs: the people, and every resume of theirs in one list. */
export type DashboardTab = 'profiles' | 'resumes';

/** `?tab=resumes` is the second tab; anything else - a missing parameter, a typo - is the first. */
export function readDashboardTab(value: string | null | undefined): DashboardTab {
  return value === 'resumes' ? 'resumes' : 'profiles';
}

/** The address of a tab: the dashboard alone for Profiles, `?tab=resumes` for All resumes. */
export function dashboardHref(tab: DashboardTab): string {
  return tab === 'resumes' ? '/admin/profiles?tab=resumes' : '/admin/profiles';
}

/* ------------------------------------------------------------- the view */

export type ViewMode = 'grid' | 'list';

/** One key for the dashboard and a profile's page: the view is the person's, not the page's. */
export const VIEW_MODE_KEY = 'freeTailor.profiles.view';

/** Grid unless the stored value is exactly 'list'. A missing or throwing storage reads as grid. */
export function readViewMode(storage: Pick<Storage, 'getItem'> | null): ViewMode {
  try {
    return storage?.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

/** Remembers the view; a full, blocked or missing storage is not a failure. */
export function writeViewMode(storage: Pick<Storage, 'setItem'> | null, mode: ViewMode): void {
  try {
    storage?.setItem(VIEW_MODE_KEY, mode);
  } catch {
    // The view is a convenience: it just is not remembered.
  }
}

/* ------------------------------------------------------------ addresses */

/**
 * The pages drawn on the editor's desk, edge to edge under the top bar: the
 * dashboard, a profile's page and a resume's editor (or the new-resume
 * chooser). app/admin/layout.tsx gives exactly these a bare <main>.
 */
export function isProfilesDeskRoute(pathname: string): boolean {
  return /^\/admin\/(?:profiles(?:\/[^/]+)?|resumes\/[^/]+)\/?$/.test(pathname);
}

/** A profile's own page. */
export function profilePageHref(profileId: string): string {
  return '/admin/profiles/' + encodeURIComponent(profileId);
}

/** The chooser for a new resume, filed under a profile when one is named. */
export function newResumeHref(profileId?: string | null): string {
  const profile = readProfileParam(profileId);
  return profile ? '/admin/resumes/new?profile=' + encodeURIComponent(profile) : '/admin/resumes/new';
}

/** The `profile` parameter of the chooser and of a new resume's editor: a trimmed, non-empty id, else null. */
export function readProfileParam(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/* ---------------------------------------------------------------- labels */

function tidy(text: unknown): string {
  return typeof text === 'string' ? text.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
}

/**
 * What a resume is called where there are several of one person's: its
 * headline, unless that is empty or the normaliser's 'Professional'; else the
 * name printed on it; else 'Untitled resume'. The server's `resumeLabelOf`.
 */
export function resumeLabel(resume: { title?: string; name?: string }): string {
  const headline = tidy(resume.title);
  if (headline && headline !== 'Professional') return headline;
  return tidy(resume.name) || 'Untitled resume';
}

function count(n: number, noun: 'profile' | 'resume'): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** The dashboard's welcome line. */
export function describeHoldings(name: string, profileCount: number, resumeCount: number): string {
  const who = tidy(name);
  return `Welcome back${who ? `, ${who}` : ''}! You have ${count(profileCount, 'profile')} and ${count(resumeCount, 'resume')}.`;
}

/** The search's status line: how many of the tab's items the typed words keep. */
export function describeMatches(shown: number, total: number, noun: 'profile' | 'resume'): string {
  return `${shown} of ${total} ${noun}${total === 1 ? '' : 's'} match.`;
}

/**
 * The owner's wording for deleting a profile: it takes every resume in it, and
 * the warning says so before the press. A blank name reads 'Untitled Profile'.
 */
export function deleteProfileWording(name: string, resumeCount: number): { title: string; body: string; confirm: string } {
  const who = tidy(name) || 'Untitled Profile';
  if (resumeCount > 0) {
    return {
      title: `Delete ${who}?`,
      body: "You can't undo this. Every resume in this profile will be deleted with it and can't be recovered.",
      confirm: 'Delete profile and its resumes',
    };
  }
  return { title: `Delete ${who}?`, body: "This can't be undone.", confirm: 'Delete profile' };
}

/* ------------------------------------------------------ ordering, search */

function timeOf(text: string | undefined): number {
  const at = text ? Date.parse(text) : Number.NaN;
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

/** Newest edit first, then by id, so the order never depends on the order the server answered in. */
export function sortProfiles<T extends Pick<ProfileSummary, 'id' | 'lastEditedAt'>>(profiles: readonly T[]): T[] {
  return [...profiles].sort((a, b) => {
    const byTime = timeOf(b.lastEditedAt) - timeOf(a.lastEditedAt);
    if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Trimmed, case-insensitive substring of any field; an empty query keeps everything. */
export function matchesQuery(query: string, fields: ReadonlyArray<string | undefined>): boolean {
  const needle = tidy(query).toLowerCase();
  if (!needle) return true;
  return fields.some((field) => typeof field === 'string' && field.toLowerCase().includes(needle));
}

/** A profile matches by its name, or by the label or name of any of its resumes. */
export function filterProfiles(
  profiles: readonly ProfileSummary[],
  resumes: readonly Resume[],
  query: string
): ProfileSummary[] {
  return profiles.filter((profile) =>
    matchesQuery(query, [
      profile.name,
      ...resumes.filter((resume) => resume.profileId === profile.id).flatMap((resume) => [resumeLabel(resume), resume.name]),
    ])
  );
}

/** A resume matches by its label, its name or its profile's name. */
export function filterResumes(resumes: readonly Resume[], profiles: readonly ProfileSummary[], query: string): Resume[] {
  return resumes.filter((resume) =>
    matchesQuery(query, [
      resumeLabel(resume),
      resume.name,
      profiles.find((profile) => profile.id === resume.profileId)?.name,
    ])
  );
}

/* -------------------------------------------------------------- keywords */

/** The first `limit` (8) skills and technologies of a resume's keywords, and how many more there are. */
export function keywordPreview(keywords: ResumeKeywords | undefined, limit = 8): { shown: string[]; more: number } {
  const terms = keywords && Array.isArray(keywords.terms) ? keywords.terms : [];
  const cap = Math.max(0, Math.floor(limit));
  return { shown: terms.slice(0, cap), more: Math.max(0, terms.length - cap) };
}
