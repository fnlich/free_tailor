/**
 * A profile is a PERSON, and holds that person's resumes.
 *
 * The stored document keeps no member list: a resume points at its profile
 * (`Resume.profileId`, mirrored to the column `resumes.profile_id`), so a resume
 * has exactly one profile by construction and nothing here can disagree with it.
 * Read only through `toProfile` (database/profileTree.ts), which keeps the known
 * keys below and so drops the member list an older build stored; the next write
 * drops it for good.
 */
export interface Profile {
  id: string;
  /** The account this profile belongs to. Absent on rows written before v2. */
  ownerId?: string;
  /** The person's name. A blank one is stored as 'Untitled Profile'. */
  name: string;
  /**
   * The resume Fully Tailor starts from. One of this profile's resumes, or
   * absent while it has none. The first resume in becomes it; a resume that
   * leaves (deleted, or moved out) re-points it to the oldest enabled one.
   * Disabling it writes nothing: the choice is kept, and the EFFECTIVE default
   * (services/profileRules.ts) skips disabled resumes in the meantime.
   */
  defaultResumeId?: string;
  createdAt: string;
  updatedAt: string;
}

/** What /api/profiles answers: a profile with its resumes counted, never listed. */
export interface ProfileSummary {
  id: string;
  name: string;
  /** Only in an administrator's `?allOwners=true` list. */
  ownerId?: string;
  createdAt: string;
  updatedAt: string;
  /** The later of this profile's own `updatedAt` and its newest resume's. */
  lastEditedAt: string;
  resumeCount: number;
  enabledResumeCount: number;
  /** The EFFECTIVE default (a disabled choice is skipped); null while the profile has no resume. */
  defaultResumeId: string | null;
  /** The stored choice, which may be a disabled resume; null while none is stored. */
  chosenDefaultResumeId: string | null;
}
