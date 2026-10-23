import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { PublicError } from '../middleware/publicError';
import type { Profile } from '../types/profile';
import { Resume } from '../types/resume';
import type { UserAccount } from '../types/account';
import { DocumentTable } from './documentTable';
import {
  adoptAsDefaultIfNone,
  deleteAnswersFor,
  fileUnfiledResumes,
  inTreeTransaction,
  ownProfile,
  placeNewResume,
  repointDefaultAfterLeaving,
  ResumeNotFoundError,
  type PlacementAccount,
} from './profileTree';
import { getDb } from './sqlite';

/**
 * Resumes, scoped to the account that owns them.
 *
 * The scoping is done HERE rather than in the routes. There are seven places a
 * resume is read - the builder, the batch queue, the importer, three admin
 * pages, the resume service - and a check per call site is a check somebody
 * will forget on the eighth. A repository that cannot return another account's
 * resume without being asked to is the version that stays correct.
 *
 * It is also where a resume is FILED. Every resume belongs to exactly one
 * profile (the person) of its own account, and only this module and
 * profileRepository write that (database/profileTree.ts describes the tree):
 * a create places the resume, an edit keeps the placement of the row as it is
 * stored at that moment, and only Move changes it. A `profileId` that arrives
 * in a request body is never read - the builders (`buildNewResume`,
 * `buildUpdatedResume`) do not carry it - and every write here is ONE
 * IMMEDIATE transaction on ONE connection.
 */

const resumes = new DocumentTable<Resume>('resumes', (resume) => ({
  name: resume.name,
  disabled: resume.disabled ? 1 : 0,
  // Written on every save, so the indexed columns and the JSON never disagree.
  owner_id: resume.ownerId ?? '',
  profile_id: resume.profileId ?? null,
}));

/** 409 `resume-id-taken`: a create or an import named an id another resume already holds. */
export class ResumeIdTakenError extends PublicError {
  constructor() {
    super('A resume with this id already exists.', { status: 409, code: 'resume-id-taken' });
    this.name = 'ResumeIdTakenError';
  }
}

/**
 * Who is asking.
 *
 * `null` means nobody - a background job, a migration, a script. That reads
 * EVERYTHING, and is spelled out at each call site rather than being the
 * default, so an unscoped read is a decision somebody made rather than an
 * argument they forgot.
 */
export type Viewer = UserAccount | null;

function canSee(viewer: Viewer, resume: Resume): boolean {
  if (viewer === null) return true;
  if (viewer.role === 'admin') return true;
  return Boolean(resume.ownerId) && resume.ownerId === viewer.id;
}

export type ListOptions = {
  includeDisabled?: boolean;
  /**
   * Admins see every account's resumes when this is set.
   *
   * Off by default, which matters: an admin is also an ordinary user with their
   * own resumes, and the builder showing them everybody's would be unusable.
   * The admin pages set it; the builder does not.
   */
  allOwners?: boolean;
};

export function listResumesFor(viewer: Viewer, options: ListOptions = {}): Resume[] {
  const all = resumes.list();
  const visible = all.filter((resume) => {
    if (viewer === null) return true;
    if (viewer.role === 'admin' && options.allOwners) return true;
    return Boolean(resume.ownerId) && resume.ownerId === viewer.id;
  });
  return options.includeDisabled ? visible : visible.filter((resume) => !resume.disabled);
}

/**
 * Every resume, whoever owns it.
 *
 * For the paths that have no viewer to scope by: the queue rebuilding a task
 * from a stored row, and the startup checks. Named so that reading a call site
 * makes it obvious the scoping was skipped on purpose.
 */
export function listAllResumesUnscoped(options: { includeDisabled?: boolean } = {}): Resume[] {
  return listResumesFor(null, options);
}

export function getResumeFor(viewer: Viewer, id: string): Resume | null {
  const resume = resumes.get(id);
  if (!resume) return null;
  return canSee(viewer, resume) ? resume : null;
}

/** Unscoped read, for the queue. */
export function getResume(id: string): Resume | null {
  return resumes.get(id) ?? null;
}

export function hasResume(id: string): boolean {
  return resumes.has(id);
}

type StoredRow = { owner_id: string | null; profile_id: string | null };

/** The tree's view of a stored resume: who owns it and which profile it is filed under. */
function readStoredRow(db: Database.Database, id: string): StoredRow | undefined {
  return db.prepare('SELECT owner_id, profile_id FROM resumes WHERE id = ?').get(id) as StoredRow | undefined;
}

/** The account a raw write is placed for: the resume's own owner, never limited (the limit is for people making profiles). */
function placementAccountFor(ownerId: string): PlacementAccount {
  return { id: ownerId, role: 'user', subscription: 'default' };
}

/** One raw write, in the caller's transaction: see `saveResume`. */
function saveRawIn(db: Database.Database, resume: Resume): Resume {
  const ownerId = resume.ownerId ?? '';
  let stored = readStoredRow(db, resume.id);

  // A stored row filed under no valid profile is filed - with the owner's other
  // old resumes - by the NAME STORED on it, before the body's name can decide:
  // the same rule as saveEditedResume, so one person's old resumes stay one
  // profile however the whole-record edit renames this one.
  if (stored && ownerId && (!stored.profile_id || !ownProfile(db, ownerId, stored.profile_id))) {
    fileUnfiledResumes(db, ownerId);
    stored = readStoredRow(db, resume.id) ?? stored;
  }

  // An existing row keeps its placement - while that is still a profile of the
  // owner it is being saved with.
  let profile: Profile | null = stored?.profile_id ? ownProfile(db, ownerId, stored.profile_id) : null;

  if (!profile) {
    // A new row (or one never filed): on the profile it names when that is one
    // of its owner's, else by the placement rule. Never counted, never refused.
    const named = resume.profileId ? ownProfile(db, ownerId, resume.profileId) : null;
    profile = named ?? placeNewResume(db, placementAccountFor(ownerId), resume.name, undefined, { countLimit: false }).profile;
    adoptAsDefaultIfNone(db, profile, resume.id);
  }

  return resumes.save({ ...resume, profileId: profile.id }, db);
}

/**
 * Writes a resume as given. The raw writer, for tests and seeding and the Bid
 * Assistant's whole-record edit; the product's creates go through
 * `createResumes` and its edits through `saveEditedResume`.
 *
 * It places a NEW row at once, so no writer leaves a resume unfiled: on the
 * `profileId` it carries when that is a profile of the same owner, else by the
 * placement rule (the owner's oldest profile named for the person, else a new
 * one) - and it never counts the profile limit. A row that already exists
 * keeps the placement it has stored, whatever this document says.
 */
export function saveResume(resume: Resume): Resume {
  return inTreeTransaction((db) => saveRawIn(db, resume));
}

/** Saves a batch as one unit, so an import either lands whole or not at all. */
export function saveResumes(batch: Resume[]): Resume[] {
  if (batch.length === 0) return [];
  return inTreeTransaction((db) => batch.map((resume) => saveRawIn(db, resume)));
}

/**
 * What a create made: the resumes, as saved, and the profiles it had to make
 * for people who had none (in the order they were made).
 */
export type CreatedResumes = { resumes: Resume[]; createdProfiles: Profile[] };

/**
 * EVERY create of a resume: the builder's, an import's, an upload's and the
 * Bid Assistant's. ONE IMMEDIATE transaction that
 *
 *  1. files the account's old unfiled resumes first (so the limit below is
 *     counted against the profiles they make);
 *  2. checks every id is free - 409 `resume-id-taken`, never an overwrite -
 *     and gives a requested id of `new` (the chooser's address) a fresh one;
 *  3. places each resume (database/profileTree.ts `placeNewResume`): the
 *     request's `profileId`, which must be the account's own, else the
 *     account's oldest profile named for the person, else a new profile -
 *     and ONLY a new profile counts the profile limit (402 `profile-limit`,
 *     with the person's name, and nothing of the whole batch written);
 *  4. adopts the resume as the profile's default when it has none;
 *  5. saves it, owned by the account.
 *
 * A later entry of one batch sees the profile made for an earlier one, so two
 * resumes of one person share one new profile. Administrators are exempt from
 * the limit; they place into their own profiles like anyone.
 */
export function createResumesWithProfiles(
  account: UserAccount,
  built: Resume[],
  options: { profileId?: string } = {}
): CreatedResumes {
  if (built.length === 0) return { resumes: [], createdProfiles: [] };

  return inTreeTransaction((db) => {
    fileUnfiledResumes(db, account.id);

    const claimed = new Set<string>();
    const ids = built.map((resume) => {
      const id = resume.id === 'new' ? randomUUID() : resume.id;
      if (claimed.has(id) || resumes.has(id, db)) throw new ResumeIdTakenError();
      claimed.add(id);
      return id;
    });

    const saved: Resume[] = [];
    const createdProfiles: Profile[] = [];
    built.forEach((resume, index) => {
      const id = ids[index];
      const { profile, created } = placeNewResume(db, account, resume.name, options.profileId, { countLimit: true });
      if (created) createdProfiles.push(profile);
      adoptAsDefaultIfNone(db, profile, id);
      saved.push(resumes.save({ ...resume, id, ownerId: account.id, profileId: profile.id }, db));
    });
    return { resumes: saved, createdProfiles };
  });
}

/** `createResumesWithProfiles` for a caller that wants only the resumes. */
export function createResumes(account: UserAccount, built: Resume[], options: { profileId?: string } = {}): Resume[] {
  return createResumesWithProfiles(account, built, options).resumes;
}

/**
 * EVERY edit of a stored resume. The row is read again INSIDE the transaction:
 *
 * - gone (deleted since the caller looked), or owned by somebody else now (its
 *   id was reused) - 404 `resume-not-found`. Never an upsert: the old save
 *   recreated a resume that had just been deleted;
 * - otherwise the owner and the profile come from the STORED row, so a Move
 *   that landed between the caller's read and this save is not undone, and a
 *   body cannot hand the resume to someone else.
 *
 * `expectedOwnerId` is the owner the caller read the resume with. A stored
 * resume that was never filed is filed first, so an edit never leaves one
 * behind.
 */
export function saveEditedResume(built: Resume, expectedOwnerId: string | undefined): Resume {
  return inTreeTransaction((db) => {
    let row = readStoredRow(db, built.id);
    if (!row || (row.owner_id ?? '') !== (expectedOwnerId ?? '')) throw new ResumeNotFoundError();
    const ownerId = row.owner_id ?? '';

    if (!row.profile_id || !ownProfile(db, ownerId, row.profile_id)) {
      fileUnfiledResumes(db, ownerId);
      row = readStoredRow(db, built.id) ?? row;
    }

    const { profileId: _ignored, ownerId: _ignoredOwner, ...content } = built;
    return resumes.save(
      {
        ...content,
        ...(ownerId ? { ownerId } : {}),
        ...(row.profile_id ? { profileId: row.profile_id } : {}),
      },
      db
    );
  });
}

/** How many resumes an account holds. Resumes are never limited; this is for the account pages and tests. */
export function countResumesForOwner(ownerId: string, db: Database.Database = getDb()): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM resumes WHERE owner_id = ?').get(ownerId) as { n: number };
  return row.n;
}

/**
 * Deletes a resume, the Bid Assistant answers written for it, and - when it
 * was its profile's default - re-points that default, together.
 *
 * Those answers are keyed by resume id alone, and an id can come back: the
 * Bid Assistant creates a resume with an id the client chose, and an import
 * keeps any id that is free. So an answer that outlived its resume was read,
 * and could be deleted, as its own by whichever account next took that id.
 * Both delete routes come through here, which is why it is done here. The
 * answers are deleted in plain SQL (profileTree.ts `deleteAnswersFor`).
 */
export function deleteResume(id: string): boolean {
  return inTreeTransaction((db) => {
    const row = readStoredRow(db, id);
    if (!row) return false;
    const deleted = resumes.delete(id, db);
    if (deleted) {
      deleteAnswersFor(db, [id]);
      if (row.profile_id) repointDefaultAfterLeaving(db, row.owner_id ?? '', row.profile_id);
    }
    return deleted;
  });
}

/**
 * When a run names a profile (a person) that holds no enabled resume. About
 * the caller's own profile, so it stays specific - and says where to fix it in
 * a page they have.
 *
 * The cap on how many profiles an account may keep is database/profileLimit.ts's.
 */
export const NO_PROFILES_TO_BUILD =
  'That profile has no enabled resume to build. Add or enable a resume on its page.';

/**
 * The old unscoped list, kept only where a viewer genuinely does not exist.
 *
 * Deprecated rather than deleted so that the remaining call sites are visible
 * in one search, and so a new one is an obvious thing to question in review.
 *
 * @deprecated Use `listResumesFor` with the request's viewer.
 */
export function listResumes(options: { includeDisabled?: boolean } = {}): Resume[] {
  return listAllResumesUnscoped(options);
}
