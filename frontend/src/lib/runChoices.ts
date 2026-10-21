import { startingResumeSelection } from './subscriptions';

/**
 * Who a run builds for, and in which files - the choices every page that
 * starts a run makes the same way (Build Resumes' manual and sheet modes, and
 * Find Jobs' order), with no React in them.
 *
 * A target is one of four kinds: the single profile chosen, the several
 * profiles chosen, every enabled profile, or the enabled members of a group.
 * All but the first build for more than one profile at once, which needs
 * Premium (owner decisions B1-B3): the page DERIVES the kind in effect from
 * the account (`targetInEffect`) rather than correcting a choice in an
 * effect, so a subscription that changes under an open page can never leave a
 * locked kind selected. The server is the real lock
 * (`assertProfileScopeAllowed`, 403 `subscription-too-low`). Several is Find
 * Jobs' order's (components/builder/ProfileTargets.tsx draws it only where a
 * page asks for it); the administrator's default target is never it.
 *
 * The one runtime import is lib/subscriptions.ts, so backend/test loads this
 * with a resolving loader (frontendHelpers.test.js).
 */

export type TargetKind = 'single' | 'several' | 'all' | 'group';

export const TARGET_KINDS: readonly TargetKind[] = ['single', 'several', 'all', 'group'];

/** The kinds the administrator's default target can name (Settings -> General): never Several. */
export type DefaultTargetKind = Exclude<TargetKind, 'several'>;

/** What is chosen for each kind; only the kind's own field is read - `profileIds` for Several. */
export type TargetChoice = { kind: TargetKind; profileId: string | null; profileIds?: readonly string[]; groupId: string };

type ProfileLike = { id: string };
type GroupLike = { id: string; profileIds: readonly string[] };

/** Whether a kind builds for more than one profile at once - Premium and up. */
export function isMultiProfileTarget(kind: TargetKind): boolean {
  return kind !== 'single';
}

/** The kind a run really takes: the one chosen, or Single for an account that builds for one profile at a time. */
export function targetInEffect(kind: TargetKind, manyProfiles: boolean): TargetKind {
  return manyProfiles ? kind : 'single';
}

/**
 * The profiles a target builds for, exactly as the run picks them: the
 * chosen one, the chosen several, every profile given (the page passes the
 * enabled ones), or the group's members among them - always in the order of
 * the profiles given. What the run's count, its quote and its request all
 * read, so none of them counts a profile the run would skip.
 */
export function targetProfiles<P extends ProfileLike>(
  choice: TargetChoice,
  profiles: readonly P[],
  groups: readonly GroupLike[]
): P[] {
  if (choice.kind === 'single') return profiles.filter((profile) => profile.id === choice.profileId);
  if (choice.kind === 'several') {
    const chosen = new Set(choice.profileIds ?? []);
    return profiles.filter((profile) => chosen.has(profile.id));
  }
  if (choice.kind === 'all') return [...profiles];
  const group = groups.find((entry) => entry.id === choice.groupId);
  return group ? profiles.filter((profile) => group.profileIds.includes(profile.id)) : [];
}

/** Why a target cannot run yet, as the sentence to show; null when it can. */
export function targetBlocker(
  choice: TargetChoice,
  profiles: readonly ProfileLike[],
  groups: readonly GroupLike[]
): string | null {
  if (choice.kind === 'single') {
    if (!choice.profileId) return 'Please select a profile.';
    return profiles.some((profile) => profile.id === choice.profileId) ? null : 'Selected profile could not be found.';
  }
  if (choice.kind === 'several') {
    if ((choice.profileIds ?? []).length === 0) return 'Please select the profiles to build for.';
    return targetProfiles(choice, profiles, groups).length > 0 ? null : 'Selected profiles could not be found.';
  }
  if (choice.kind === 'all') return profiles.length > 0 ? null : 'No profiles available for multi-profile generation.';
  const group = groups.find((entry) => entry.id === choice.groupId);
  if (!group) return 'Please select a group.';
  return targetProfiles(choice, profiles, groups).length > 0 ? null : 'Selected group has no enabled profiles.';
}

/**
 * The target a page starts on: the administrator's default target, profile
 * and group (Settings -> General), each only while it exists - except that an
 * account building for one profile at a time starts on Single whatever the
 * default says (`startingResumeSelection`).
 */
export function startingTarget(
  settings: { defaultResumeSelection: DefaultTargetKind; defaultProfileId: string; defaultGroupId: string },
  profiles: readonly ProfileLike[],
  groups: readonly GroupLike[],
  manyProfiles: boolean
): TargetChoice & { kind: DefaultTargetKind } {
  const kind = startingResumeSelection(settings.defaultResumeSelection, manyProfiles);
  const profileId = profiles.some((profile) => profile.id === settings.defaultProfileId)
    ? settings.defaultProfileId
    : profiles[0]?.id ?? null;
  const groupId =
    kind === 'group' && groups.some((group) => group.id === settings.defaultGroupId) ? settings.defaultGroupId : '';
  return { kind, profileId, groupId };
}

/** The files a run makes, as the administrator's builder defaults say: a PDF always, and DOCX where switched on. */
export function defaultRunFormat(settings: {
  defaultResumeDocxEnabled: boolean;
  defaultCoverLetterDocxEnabled: boolean;
}): { format: 'both' | 'pdf'; includeCoverLetterDocx: boolean } {
  return {
    format: settings.defaultResumeDocxEnabled ? 'both' : 'pdf',
    includeCoverLetterDocx: settings.defaultCoverLetterDocxEnabled,
  };
}
