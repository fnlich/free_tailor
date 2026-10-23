import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { PublicError } from '../middleware/publicError';
import type { UserAccount } from '../types/account';
import type { Profile, ProfileSummary } from '../types/profile';
import {
  effectiveDefaultResumeId,
  personKey,
  profileNameForPerson,
  repointedDefaultResumeId,
  UNTITLED_PROFILE_NAME,
  type ResumeMember,
} from '../services/profileRules';
import { DocumentTable } from './documentTable';
import { assertCanAddProfile } from './profileLimit';
import { getDb } from './sqlite';

/**
 * The tree: profiles (people) and the resumes filed under them.
 *
 * A resume belongs to exactly one profile of its own account. The pointer is
 * `Resume.profileId` in the document, mirrored to the column
 * `resumes.profile_id` (the same pattern as `ownerId` / `owner_id`), and a
 * profile stores no member list - so a resume cannot be in two profiles, a
 * deleted resume leaves nothing behind to clean, and an id that comes back
 * (an import keeps a free id; the Bid Assistant takes the client's) can never
 * rejoin somebody else's profile.
 *
 * THE RULES THIS MODULE KEEPS, for every writer in the tree:
 *
 * - ONE connection, ONE IMMEDIATE transaction (`inTreeTransaction`). The write
 *   lock is taken before anything is read, so a decision made from a read
 *   (the profile limit, "is this id free", "which profile is this person's")
 *   is still true when the write lands, across processes as within one. Every
 *   helper takes the connection it runs on, and so does DocumentTable: a
 *   statement sent through a second connection from inside the transaction
 *   waits out the busy timeout and fails with SQLITE_BUSY. Nothing inside a
 *   transaction awaits.
 * - Placement is written here and in the repositories, never by a route and
 *   never from a request body. A `profileId` in a body is not read.
 * - `profiles` (the people) has no `disabled` column and must never gain one:
 *   the structural step (glossaryRename.ts) tells it from build 4.1's table of
 *   resumes of the same name by that column.
 */

/** The account a placement is made for; the limit reads its role and subscription. */
export type PlacementAccount = Pick<UserAccount, 'id' | 'role' | 'subscription'>;

// -- Refusals ---------------------------------------------------------------- //

/**
 * A refusal about profiles and their resumes, written for anybody (a
 * PublicError): the status, the machine-readable code a page branches on, and
 * any fields sent beside the sentence.
 */
export class ProfileRefusal extends PublicError {
  constructor(message: string, status: number, code: string, extra?: Record<string, unknown>) {
    super(message, { status, code, ...(extra ? { extra } : {}) });
    this.name = 'ProfileRefusal';
  }
}

/** 404 `profile-not-found`: no such profile, one that is not the caller's, or one deleted meanwhile. */
export class ProfileNotFoundError extends ProfileRefusal {
  constructor() {
    super('That profile was not found. It may have been deleted; reload the page.', 404, 'profile-not-found');
    this.name = 'ProfileNotFoundError';
  }
}

/** 404 `resume-not-found`: a resume that is gone, or not the caller's. Never a resurrection. */
export class ResumeNotFoundError extends ProfileRefusal {
  constructor() {
    super('One of those resumes was not found. It may have been deleted; reload the page.', 404, 'resume-not-found');
    this.name = 'ResumeNotFoundError';
  }
}

// -- Transactions ------------------------------------------------------------ //

/**
 * Runs `fn` in ONE IMMEDIATE transaction on the shared connection - or, inside
 * a transaction already open on it, in that one. `fn` must not await.
 */
export function inTreeTransaction<T>(fn: (db: Database.Database) => T): T {
  const db = getDb();
  return db.inTransaction ? fn(db) : db.transaction(() => fn(db)).immediate();
}

/** The same on a connection somebody already holds. */
function inTransactionOn<T>(db: Database.Database, fn: () => T): T {
  return db.inTransaction ? fn() : db.transaction(fn).immediate();
}

// -- The people --------------------------------------------------------------- //

/**
 * A profile as this build reads it: the known keys, and no others. The member
 * list an older build stored (`resumeIds` and the like) is not read, and the
 * next write of the profile drops it.
 */
export function toProfile(raw: unknown): Profile {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const ownerId = text(source.ownerId);
  const defaultResumeId = text(source.defaultResumeId).trim();
  return {
    id: text(source.id),
    ...(ownerId ? { ownerId } : {}),
    name: text(source.name).trim() ? text(source.name) : UNTITLED_PROFILE_NAME,
    ...(defaultResumeId ? { defaultResumeId } : {}),
    createdAt: text(source.createdAt),
    updatedAt: text(source.updatedAt),
  };
}

/** The table of people. Reads through `toProfile`; its indexed columns are the name and the owner. */
export const profileDocuments = new DocumentTable<Profile>(
  'profiles',
  (profile) => ({ name: profile.name, owner_id: profile.ownerId ?? '' }),
  toProfile
);

/** An account's profiles, oldest first: the order "the oldest profile for this person" is judged in. */
export const PROFILES_OF_OWNER_SQL = 'SELECT data FROM profiles WHERE owner_id = ? ORDER BY created_at, id';

export function profilesOfOwner(db: Database.Database, ownerId: string): Profile[] {
  const rows = db.prepare(PROFILES_OF_OWNER_SQL).all(ownerId) as Array<{ data: string }>;
  return rows.map((row) => toProfile(JSON.parse(row.data)));
}

/** One profile of this owner, or null: another account's profile is not found, administrators included. */
export function ownProfile(db: Database.Database, ownerId: string, profileId: string): Profile | null {
  const row = db.prepare('SELECT data FROM profiles WHERE id = ? AND owner_id = ?').get(profileId, ownerId) as
    | { data: string }
    | undefined;
  return row ? toProfile(JSON.parse(row.data)) : null;
}

/** One profile whoever owns it, or null. For a reader that has already decided the viewer may see it. */
export function anyProfile(db: Database.Database, profileId: string): Profile | null {
  return profileDocuments.get(profileId, db);
}

/**
 * The profile a create names with `?profileId=`: the query's value as text, or
 * undefined when it names none. A repeated parameter (or anything but text) is
 * 400 `bad-profile-id`.
 */
export function readRequestedProfileId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ProfileRefusal('Name one profile for the resume.', 400, 'bad-profile-id');
  }
  const id = value.trim();
  return id || undefined;
}

/** The caller's own profile, or 404 `profile-not-found`. For a check made before the work that would be wasted. */
export function requireOwnProfile(account: Pick<UserAccount, 'id'>, profileId: string, db: Database.Database = getDb()): Profile {
  const profile = ownProfile(db, account.id, profileId);
  if (!profile) throw new ProfileNotFoundError();
  return profile;
}

function createProfileRow(
  db: Database.Database,
  ownerId: string,
  name: string,
  times?: { createdAt: string; updatedAt: string }
): Profile {
  const now = new Date().toISOString();
  const profile: Profile = {
    id: randomUUID(),
    ...(ownerId ? { ownerId } : {}),
    name,
    createdAt: times?.createdAt ?? now,
    updatedAt: times?.updatedAt ?? now,
  };
  return profileDocuments.save(profile, db);
}

/** Makes a profile for a person, with no limit check: the caller counts it, or is filing and ignores it. */
export function insertProfile(db: Database.Database, ownerId: string, name: string): Profile {
  return createProfileRow(db, ownerId, name);
}

// -- The resumes of a profile ------------------------------------------------- //

/** A profile's resumes, for the default rules: the id, whether it is disabled and when it was made. */
export const MEMBERS_OF_SQL = 'SELECT id, disabled, created_at FROM resumes WHERE owner_id = ? AND profile_id = ?';

export function membersOf(db: Database.Database, ownerId: string, profileId: string): ResumeMember[] {
  const rows = db.prepare(MEMBERS_OF_SQL).all(ownerId, profileId) as Array<{
    id: string;
    disabled: number;
    created_at: string;
  }>;
  return rows.map((row) => ({ id: row.id, disabled: row.disabled === 1, createdAt: row.created_at }));
}

/** Whether a resume is, right now, one of this owner's profile's resumes. */
function isMember(db: Database.Database, ownerId: string, profileId: string, resumeId: string): boolean {
  return Boolean(
    db
      .prepare('SELECT 1 FROM resumes WHERE id = ? AND owner_id = ? AND profile_id = ?')
      .get(resumeId, ownerId, profileId)
  );
}

/**
 * Files a stored resume under a profile: the document's `profileId` and the
 * column, and nothing else. `updated_at` and the document's `updatedAt` do not
 * move - lists, thumbnails and the order a run builds in all key on them, and
 * filing or moving a resume has not edited it.
 */
export function writePlacement(db: Database.Database, resumeId: string, data: string, profileId: string): void {
  const document = JSON.parse(data) as Record<string, unknown>;
  document.profileId = profileId;
  db.prepare('UPDATE resumes SET data = ?, profile_id = ? WHERE id = ?').run(JSON.stringify(document), profileId, resumeId);
}

function saveProfileDocument(db: Database.Database, profile: Profile, keepTimes: boolean): Profile {
  return profileDocuments.save(keepTimes ? profile : { ...profile, updatedAt: new Date().toISOString() }, db);
}

/**
 * A resume is joining `profile`: when the profile has no valid default (none
 * stored, or one that is no longer one of its resumes), the joining resume
 * becomes it. "The first resume in is the default." Call it before the resume
 * is written, with the profile as read in this transaction; it writes the
 * profile only when the default changes. `keepTimes` leaves the profile's
 * `updatedAt` alone (filing old resumes is not an edit of the profile).
 */
export function adoptAsDefaultIfNone(
  db: Database.Database,
  profile: Profile,
  joiningResumeId: string,
  options: { keepTimes?: boolean } = {}
): Profile {
  const ownerId = profile.ownerId ?? '';
  if (profile.defaultResumeId && isMember(db, ownerId, profile.id, profile.defaultResumeId)) {
    return profile;
  }
  if (profile.defaultResumeId === joiningResumeId) return profile;
  return saveProfileDocument(db, { ...profile, defaultResumeId: joiningResumeId }, options.keepTimes === true);
}

/**
 * Resumes have just left a profile (deleted, or moved to another): when its
 * default was one of them, it is re-pointed to the oldest enabled resume left
 * (else the oldest), or cleared when none is left. Call it AFTER the resumes
 * have gone. Disabling a resume is not leaving: the choice stays.
 */
export function repointDefaultAfterLeaving(db: Database.Database, ownerId: string, profileId: string): void {
  const profile = ownProfile(db, ownerId, profileId);
  if (!profile) return;
  if (profile.defaultResumeId && isMember(db, ownerId, profile.id, profile.defaultResumeId)) return;

  const next = repointedDefaultResumeId(membersOf(db, ownerId, profile.id));
  if ((next ?? undefined) === profile.defaultResumeId) return;

  const { defaultResumeId: _gone, ...rest } = profile;
  saveProfileDocument(db, next ? { ...rest, defaultResumeId: next } : rest, false);
}

/**
 * Gives a profile a default when it has resumes and none valid - after resumes
 * moved in. The oldest enabled resume (else the oldest), as a re-point would.
 */
export function ensureDefault(db: Database.Database, ownerId: string, profileId: string): void {
  const profile = ownProfile(db, ownerId, profileId);
  if (!profile) return;
  if (profile.defaultResumeId && isMember(db, ownerId, profile.id, profile.defaultResumeId)) return;
  const next = repointedDefaultResumeId(membersOf(db, ownerId, profile.id));
  if (!next || next === profile.defaultResumeId) return;
  saveProfileDocument(db, { ...profile, defaultResumeId: next }, false);
}

/**
 * Deletes the Bid Assistant's answers written for these resumes.
 *
 * Those answers are keyed by resume id alone, and an id can come back, so an
 * answer that outlived its resume would be read - and could be deleted - as the
 * property of whichever account next took that id. Plain SQL rather than
 * through bidAssistant/database: that module opens its own connection as it
 * loads and creates its tables then, so the answers table exists only once it
 * has; without it there is nothing to delete. The orphans an earlier build
 * left are swept when it loads.
 */
export function deleteAnswersFor(db: Database.Database, resumeIds: readonly string[]): void {
  if (resumeIds.length === 0) return;
  const hasAnswers = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'answers'").get();
  if (!hasAnswers) return;
  const CHUNK = 500;
  for (let at = 0; at < resumeIds.length; at += CHUNK) {
    const chunk = resumeIds.slice(at, at + CHUNK);
    db.prepare(`DELETE FROM answers WHERE profile_id IN (${chunk.map(() => '?').join(', ')})`).run(...chunk);
  }
}

// -- Placement ----------------------------------------------------------------- //

export type Placement = { profile: Profile; created: boolean };

/**
 * Where a NEW resume goes, in the caller's transaction:
 *
 *  1. the profile the request names (`requestedProfileId`), which must be the
 *     account's own - an administrator's included - else 404;
 *  2. otherwise the account's OLDEST profile whose person key (NFC, trimmed,
 *     inner whitespace collapsed, lower-cased; a blank name and 'Untitled
 *     Profile' are one person) is the resume's name;
 *  3. otherwise a new profile named for the person.
 *
 * Only step 3 makes a profile, and only it counts the limit (`countLimit`):
 * adding a resume to a person who has a profile costs nothing, on any tier. A
 * refusal there names the person ("This resume is for ..., who has no profile
 * yet"). Filing old resumes and the raw writers pass `countLimit: false`.
 */
export function placeNewResume(
  db: Database.Database,
  account: PlacementAccount,
  personName: unknown,
  requestedProfileId: string | null | undefined,
  options: { countLimit: boolean }
): Placement {
  if (requestedProfileId) {
    const requested = ownProfile(db, account.id, requestedProfileId);
    if (!requested) throw new ProfileNotFoundError();
    return { profile: requested, created: false };
  }

  const key = personKey(personName);
  const existing = profilesOfOwner(db, account.id).find((profile) => personKey(profile.name) === key);
  if (existing) return { profile: existing, created: false };

  const name = profileNameForPerson(personName);
  if (options.countLimit) {
    assertCanAddProfile(account, db, 1, { forPerson: name });
  }
  return { profile: createProfileRow(db, account.id, name), created: true };
}

// -- Lazy filing ---------------------------------------------------------------- //

/**
 * An owner's resumes that are filed under no valid profile: none, or one that
 * is gone, or one of another account. Oldest first, so the oldest of a
 * person's resumes makes the profile and becomes its default.
 *
 * A row whose document is not JSON is left out here and in both checks below:
 * filing cannot place it (it would be skipped every time), and counting it
 * would keep "something to file" true for its owner for ever, so every profiles
 * route would take the write lock to find nothing.
 */
export const UNFILED_RESUMES_SQL =
  'SELECT r.id AS id FROM resumes r ' +
  'LEFT JOIN profiles p ON p.id = r.profile_id AND p.owner_id = r.owner_id ' +
  'WHERE r.owner_id = ? AND p.id IS NULL AND json_valid(r.data) ORDER BY r.created_at, r.id';

/**
 * Whether the owner has a resume with NO profile pointer - every resume a v4.1
 * database holds until its owner's first visit. A true index seek on
 * `idx_resumes_owner_profile` (owner_id = ? AND profile_id IS NULL): with nothing
 * to file this is the whole cost of the check, and it reads no row's document.
 */
export const HAS_UNFILED_RESUME_SQL =
  'SELECT 1 FROM resumes WHERE owner_id = ? AND profile_id IS NULL AND json_valid(data) LIMIT 1';

/**
 * Whether the owner has a resume whose pointer names no profile of the same
 * owner (a profile that is gone, or another account's). Only a hand edit makes
 * one - deleting a profile deletes its resumes - so this is the safety net, and
 * it is NOT a seek: it walks the owner's resumes in the covering index and
 * probes `profiles` by primary key for each. It runs only after the seek above
 * found nothing.
 */
export const HAS_DANGLING_RESUME_SQL =
  'SELECT 1 FROM resumes r ' +
  'LEFT JOIN profiles p ON p.id = r.profile_id AND p.owner_id = r.owner_id ' +
  'WHERE r.owner_id = ? AND r.profile_id IS NOT NULL AND p.id IS NULL AND json_valid(r.data) LIMIT 1';

function hasResumeToFile(db: Database.Database, ownerKey: string): boolean {
  return Boolean(db.prepare(HAS_UNFILED_RESUME_SQL).get(ownerKey) || db.prepare(HAS_DANGLING_RESUME_SQL).get(ownerKey));
}

function readableTime(value: unknown): string | null {
  return typeof value === 'string' && value && !Number.isNaN(Date.parse(value)) ? value : null;
}

/**
 * Files every resume of this owner that is filed under no valid profile -
 * lazily, instead of a data migration (owner decision: no migration).
 *
 * Each goes by the placement rule's second and third steps, oldest first, so
 * one person's resumes share one profile (a profile made earlier in the pass
 * is seen by the later ones) and the oldest becomes its default. It IGNORES
 * the profile limit: an account with old resumes of three people keeps all
 * three, and simply cannot add a fourth profile. It writes the document's
 * `profileId` and the column and nothing else; `updated_at` does not move.
 * A profile it makes takes the dates of the resume it was made for, so the
 * dashboard does not show every old person as edited just now.
 *
 * With nothing to file it is one index seek (and, after that, a walk of the
 * owner's resumes for a pointer to no profile - see HAS_DANGLING_RESUME_SQL)
 * and no write lock. Returns how many resumes it filed. An owner with no id (a row an older build left
 * ownerless) is never filed.
 */
export function fileUnfiledResumes(db: Database.Database, ownerKey: string): number {
  if (!ownerKey) return 0;
  if (!hasResumeToFile(db, ownerKey)) return 0;

  return inTransactionOn(db, () => {
    // Read again under the write lock: another process may have filed them.
    const pending = (db.prepare(UNFILED_RESUMES_SQL).all(ownerKey) as Array<{ id: string }>).map((row) => row.id);
    if (pending.length === 0) return 0;

    const profiles = profilesOfOwner(db, ownerKey);
    let filed = 0;

    for (const id of pending) {
      const row = db.prepare('SELECT name, data, created_at, updated_at FROM resumes WHERE id = ?').get(id) as
        | { name: string; data: string; created_at: string; updated_at: string }
        | undefined;
      if (!row) continue;
      try {
        JSON.parse(row.data);
      } catch {
        // A row that is not a document breaks every list already; it is left
        // as it is rather than failing everyone else's filing.
        continue;
      }

      // The key of the name a profile would be given, as placement compares it.
      const key = personKey(row.name);
      let profile = profiles.find((candidate) => personKey(candidate.name) === key);
      if (!profile) {
        const createdAt = readableTime(row.created_at) ?? new Date().toISOString();
        profile = createProfileRow(db, ownerKey, profileNameForPerson(row.name), {
          createdAt,
          updatedAt: readableTime(row.updated_at) ?? createdAt,
        });
        profiles.push(profile);
      }

      const adopted = adoptAsDefaultIfNone(db, profile, id, { keepTimes: true });
      if (adopted !== profile) {
        profiles[profiles.indexOf(profile)] = adopted;
      }
      writePlacement(db, id, row.data, profile.id);
      filed += 1;
    }

    return filed;
  });
}

/** `fileUnfiledResumes` on the shared connection, for the routes: the account's own resumes only. */
export function fileUnfiledResumesFor(account: Pick<UserAccount, 'id'>): number {
  return fileUnfiledResumes(getDb(), account.id);
}

// -- Summaries --------------------------------------------------------------------- //

/** Per profile: how many resumes, how many enabled, and when the newest was edited. */
export const SUMMARY_COUNTS_SQL =
  'SELECT profile_id, COUNT(*) AS n, SUM(CASE WHEN disabled = 0 THEN 1 ELSE 0 END) AS enabled, ' +
  'MAX(updated_at) AS last_edited FROM resumes WHERE owner_id = ? AND profile_id IS NOT NULL GROUP BY profile_id';

/** The same for every account (an administrator's `allOwners` list). */
const SUMMARY_COUNTS_ALL_SQL =
  'SELECT profile_id, COUNT(*) AS n, SUM(CASE WHEN disabled = 0 THEN 1 ELSE 0 END) AS enabled, ' +
  'MAX(updated_at) AS last_edited FROM resumes WHERE profile_id IS NOT NULL GROUP BY profile_id';

/** The resumes behind the effective default: only what the default rules read. */
export const SUMMARY_MEMBERS_SQL =
  'SELECT id, profile_id, disabled, created_at FROM resumes WHERE owner_id = ? AND profile_id IS NOT NULL';

const SUMMARY_MEMBERS_ALL_SQL =
  'SELECT id, profile_id, disabled, created_at FROM resumes WHERE profile_id IS NOT NULL';

function laterOf(first: string, second: string | null | undefined): string {
  if (!second) return first;
  if (!first) return second;
  const a = Date.parse(first);
  const b = Date.parse(second);
  if (Number.isNaN(a) || Number.isNaN(b)) return second > first ? second : first;
  return b > a ? second : first;
}

function newestEditFirst(left: ProfileSummary, right: ProfileSummary): number {
  const a = Date.parse(left.lastEditedAt);
  const b = Date.parse(right.lastEditedAt);
  if (!Number.isNaN(a) && !Number.isNaN(b) && a !== b) return a > b ? -1 : 1;
  if (left.lastEditedAt !== right.lastEditedAt) return left.lastEditedAt > right.lastEditedAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * The profiles of one owner (`owner` an id) or of every account (`null`), as
 * the API answers them: counted, never listing a resume. One GROUP BY
 * `profile_id` gives the counts and the newest edit; the effective default
 * (which skips a disabled choice) needs each profile's resumes, read in one
 * further query. Newest edit first, then id.
 *
 * `ownerId` is present on a summary only when `includeOwner` is set (an
 * administrator's `allOwners` list).
 */
export function summarizeProfiles(
  db: Database.Database,
  owner: string | null,
  options: { includeOwner?: boolean } = {}
): ProfileSummary[] {
  const profiles = owner === null ? profileDocuments.list(db) : profilesOfOwner(db, owner);
  if (profiles.length === 0) return [];

  const counts = (owner === null
    ? db.prepare(SUMMARY_COUNTS_ALL_SQL).all()
    : db.prepare(SUMMARY_COUNTS_SQL).all(owner)) as Array<{
    profile_id: string;
    n: number;
    enabled: number | null;
    last_edited: string | null;
  }>;
  const members = (owner === null
    ? db.prepare(SUMMARY_MEMBERS_ALL_SQL).all()
    : db.prepare(SUMMARY_MEMBERS_SQL).all(owner)) as Array<{
    id: string;
    profile_id: string;
    disabled: number;
    created_at: string;
  }>;

  const countsOf = new Map(counts.map((row) => [row.profile_id, row]));
  const membersByProfile = new Map<string, ResumeMember[]>();
  for (const member of members) {
    const list = membersByProfile.get(member.profile_id) ?? [];
    list.push({ id: member.id, disabled: member.disabled === 1, createdAt: member.created_at });
    membersByProfile.set(member.profile_id, list);
  }

  return profiles
    .map((profile): ProfileSummary => {
      const stats = countsOf.get(profile.id);
      const resumes = membersByProfile.get(profile.id) ?? [];
      return {
        id: profile.id,
        name: profile.name,
        ...(options.includeOwner ? { ownerId: profile.ownerId ?? '' } : {}),
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        lastEditedAt: laterOf(profile.updatedAt, stats?.last_edited),
        resumeCount: stats?.n ?? 0,
        enabledResumeCount: stats?.enabled ?? 0,
        defaultResumeId: effectiveDefaultResumeId(profile.defaultResumeId, resumes),
        chosenDefaultResumeId: profile.defaultResumeId ?? null,
      };
    })
    .sort(newestEditFirst);
}

/** One profile's summary, read in the caller's transaction or on the shared connection. */
export function summarizeProfile(
  db: Database.Database,
  profile: Profile,
  options: { includeOwner?: boolean } = {}
): ProfileSummary {
  const ownerId = profile.ownerId ?? '';
  const rows = db
    .prepare('SELECT id, disabled, created_at, updated_at FROM resumes WHERE owner_id = ? AND profile_id = ?')
    .all(ownerId, profile.id) as Array<{ id: string; disabled: number; created_at: string; updated_at: string }>;
  const members: ResumeMember[] = rows.map((row) => ({
    id: row.id,
    disabled: row.disabled === 1,
    createdAt: row.created_at,
  }));
  const lastEditedAt = rows.reduce((latest, row) => laterOf(latest, row.updated_at), profile.updatedAt);
  return {
    id: profile.id,
    name: profile.name,
    ...(options.includeOwner ? { ownerId } : {}),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    lastEditedAt,
    resumeCount: rows.length,
    enabledResumeCount: rows.filter((row) => row.disabled === 0).length,
    defaultResumeId: effectiveDefaultResumeId(profile.defaultResumeId, members),
    chosenDefaultResumeId: profile.defaultResumeId ?? null,
  };
}
