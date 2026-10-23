import { isBuildMode, type BuildMode } from './buildModes';

/**
 * What a run builds, and in which files - the choices every page that starts
 * a run makes the same way (Build Resumes' manual and sheet modes, and Find
 * Jobs' order), with no React in them.
 *
 * A run builds exactly ONE profile (a person) on every subscription, in one of
 * three build modes (Choose Suitable Resume, Partial Tailor, Fully Tailor), so
 * there is no target kind to derive and no lock to apply: the page keeps the
 * profile chosen and the mode chosen, and asks this file where each starts and
 * what is still missing. The server is the real check (400
 * `one-profile-per-run`, 404 `profile-not-found`, 400 `no-profiles-to-build`).
 *
 * The one runtime import is ./buildModes, so backend/test loads this with a
 * resolving loader (frontendHelpers.test.js).
 */

type ProfileLike = { id: string };

/**
 * The profile a page starts on: the administrator's default profile
 * (Settings -> General) while it is among the profiles offered, else the
 * first offered, else none.
 */
export function startingProfileId(
  settings: { defaultProfileId: string },
  profiles: ReadonlyArray<ProfileLike>
): string | null {
  if (settings.defaultProfileId && profiles.some((profile) => profile.id === settings.defaultProfileId)) {
    return settings.defaultProfileId;
  }
  return profiles[0]?.id ?? null;
}

/** Why a run cannot start for this profile yet, as the sentence to show; null when it can. */
export function profileBlocker(profileId: string | null, profiles: ReadonlyArray<ProfileLike>): string | null {
  if (profiles.length === 0) return 'No profile has an enabled resume to build.';
  if (!profileId) return 'Please select a profile.';
  return profiles.some((profile) => profile.id === profileId) ? null : 'Selected profile could not be found.';
}

/** The mode a page starts on: the administrator's default, 'partial' for anything unknown. */
export function startingBuildMode(settings: { defaultBuildMode: BuildMode }): BuildMode {
  return isBuildMode(settings.defaultBuildMode) ? settings.defaultBuildMode : 'partial';
}

/**
 * The line under the mode cards: which resume a run will build. Fully Tailor
 * builds the profile's default resume (`defaultLabel` is its headline label,
 * when the page has it); the other two choose among the profile's enabled
 * resumes, which with a single one is no choice at all.
 */
export function buildModeNote(
  mode: BuildMode,
  profile: { name: string; enabledResumeCount: number } | null,
  defaultLabel?: string | null
): string {
  if (mode === 'full') {
    return defaultLabel && profile
      ? `Builds ${defaultLabel}, ${profile.name}'s default resume, for every job.`
      : "Builds the profile's default resume for every job.";
  }
  if (profile && profile.enabledResumeCount === 1) {
    return `${profile.name} has one resume, so every job builds it.`;
  }
  return 'For each job, the resume whose keywords match the posting best.';
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
