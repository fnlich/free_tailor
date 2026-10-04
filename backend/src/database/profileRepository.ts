import { describeProfileLimit, resolveAccountPlan } from '../config/accountPlans';
import { Profile } from '../types/profile';
import type { UserAccount } from '../types/account';
import { DocumentTable } from './documentTable';
import { getDb } from './sqlite';
import { PublicError } from '../middleware/publicError';

/**
 * Profiles, scoped to the account that owns them.
 *
 * The scoping is done HERE rather than in the routes. There are seven places a
 * profile is read - the builder, the batch queue, the importer, three admin
 * pages, the resume service - and a check per call site is a check somebody
 * will forget on the eighth. A repository that cannot return another account's
 * profile without being asked to is the version that stays correct.
 */

const profiles = new DocumentTable<Profile>('profiles', (profile) => ({
  name: profile.name,
  disabled: profile.disabled ? 1 : 0,
  // Written on every save, so the indexed column and the JSON never disagree.
  owner_id: profile.ownerId ?? '',
}));

/**
 * Who is asking.
 *
 * `null` means nobody - a background job, a migration, a script. That reads
 * EVERYTHING, and is spelled out at each call site rather than being the
 * default, so an unscoped read is a decision somebody made rather than an
 * argument they forgot.
 */
export type Viewer = UserAccount | null;

function canSee(viewer: Viewer, profile: Profile): boolean {
  if (viewer === null) return true;
  if (viewer.role === 'admin') return true;
  return Boolean(profile.ownerId) && profile.ownerId === viewer.id;
}

export type ListOptions = {
  includeDisabled?: boolean;
  /**
   * Admins see every account's profiles when this is set.
   *
   * Off by default, which matters: an admin is also an ordinary user with their
   * own profiles, and the builder showing them everybody's would be unusable.
   * The admin pages set it; the builder does not.
   */
  allOwners?: boolean;
};

export function listProfilesFor(viewer: Viewer, options: ListOptions = {}): Profile[] {
  const all = profiles.list();
  const visible = all.filter((profile) => {
    if (viewer === null) return true;
    if (viewer.role === 'admin' && options.allOwners) return true;
    return Boolean(profile.ownerId) && profile.ownerId === viewer.id;
  });
  return options.includeDisabled ? visible : visible.filter((profile) => !profile.disabled);
}

/**
 * Every profile, whoever owns it.
 *
 * For the paths that have no viewer to scope by: the queue rebuilding a task
 * from a stored row, and the startup checks. Named so that reading a call site
 * makes it obvious the scoping was skipped on purpose.
 */
export function listAllProfilesUnscoped(options: { includeDisabled?: boolean } = {}): Profile[] {
  return listProfilesFor(null, options);
}

export function getProfileFor(viewer: Viewer, id: string): Profile | null {
  const profile = profiles.get(id);
  if (!profile) return null;
  return canSee(viewer, profile) ? profile : null;
}

/** Unscoped read, for the queue and the migrations. */
export function getProfile(id: string): Profile | null {
  return profiles.get(id);
}

export function hasProfile(id: string): boolean {
  return profiles.has(id);
}

export function saveProfile(profile: Profile): Profile {
  return profiles.save(profile);
}

/** Saves a batch as one unit, so an import either lands whole or not at all. */
export function saveProfiles(batch: Profile[]): Profile[] {
  return profiles.saveAll(batch);
}

/**
 * Deletes a profile and the Bid Assistant answers written for it, together.
 *
 * Those answers are keyed by profile id alone, and an id can come back: the
 * Bid Assistant creates a profile with an id the client chose, and an import
 * keeps any id that is free. So an answer that outlived its profile was read,
 * and could be deleted, as its own by whichever account next took that id.
 * Both delete routes come through here, which is why it is done here.
 *
 * Plain SQL rather than through bidAssistant/database: that module takes its
 * connection when it is first loaded and creates its tables as it loads, and
 * the answers table exists only once it has. Without it there is nothing to
 * delete. The orphans an earlier build left are swept when it loads.
 */
export function deleteProfile(id: string): boolean {
  const db = getDb();
  return db.transaction(() => {
    const deleted = profiles.delete(id);
    const hasAnswers = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'answers'")
      .get();
    if (deleted && hasAnswers) {
      db.prepare('DELETE FROM answers WHERE profile_id = ?').run(id);
    }
    return deleted;
  })();
}

/* ------------------------------------------------------------- the plan cap */

/**
 * How many profiles an account holds.
 *
 * Counted in SQL against the indexed column rather than by listing and
 * filtering: this runs on every account read, and the account page asks for it
 * on every load.
 *
 * DISABLED PROFILES COUNT. A profile that is switched off still occupies a
 * slot, because it is still there to be switched back on - not counting it
 * would make the limit meaningless the moment somebody worked out that
 * disabling is free.
 */
export function countProfilesForOwner(ownerId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM profiles WHERE owner_id = ?')
    .get(ownerId) as { n: number };
  return row.n;
}

/**
 * When a run selects no profile the caller has. About their own profiles and
 * groups, so it stays specific - and says where to fix it in pages they have.
 */
export const NO_MATCHING_PROFILES =
  "No matching profiles. Add a profile on the Profiles page, or check the group's members.";

export class ProfileLimitError extends PublicError {
  readonly limit: number;
  readonly used: number;
  readonly planLabel: string;

  constructor(planLabel: string, limit: number, used: number) {
    super(
      `The ${planLabel} plan allows ${limit} profile${limit === 1 ? '' : 's'} and this account has ` +
        `${used}. Delete one, or ask an administrator to move the account to a larger plan.`,
      // 402: the plan, not the request, is what is short - the same status a
      // run refused for want of credits answers.
      { status: 402, code: 'profile-limit', extra: { limit } }
    );
    this.name = 'ProfileLimitError';
    this.limit = limit;
    this.used = used;
    this.planLabel = planLabel;
  }
}

/**
 * Refuses a new profile that would put the account over its plan.
 *
 * Called before a create, never before an update: an account moved DOWN a plan
 * keeps the profiles it already has. Deleting somebody's work because an admin
 * changed a dropdown would be the wrong way round - they lose the ability to
 * add, not the things they made.
 *
 * Admins are exempt. They can already change any account's plan, so a limit on
 * them is a formality that only gets in the way of fixing somebody else's.
 */
export function assertCanAddProfile(account: UserAccount, adding = 1): void {
  if (account.role === 'admin') return;

  const plan = resolveAccountPlan(account.plan);
  if (plan.profileLimit === null) return;

  const used = countProfilesForOwner(account.id);
  if (used + adding <= plan.profileLimit) return;

  throw new ProfileLimitError(plan.label, plan.profileLimit, used);
}

/**
 * The old unscoped list, kept only where a viewer genuinely does not exist.
 *
 * Deprecated rather than deleted so that the remaining call sites are visible
 * in one search, and so a new one is an obvious thing to question in review.
 *
 * @deprecated Use `listProfilesFor` with the request's viewer.
 */
export function listProfiles(options: { includeDisabled?: boolean } = {}): Profile[] {
  return listAllProfilesUnscoped(options);
}
