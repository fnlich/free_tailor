import type Database from 'better-sqlite3';
import type { UserAccount } from '../types/account';
import type { Profile, ProfileSummary } from '../types/profile';
import { profileNameForPerson, readProfileName } from '../services/profileRules';
import { assertCanAddProfile } from './profileLimit';
import {
  anyProfile,
  deleteAnswersFor,
  ensureDefault,
  fileUnfiledResumes,
  inTreeTransaction,
  insertProfile,
  ProfileNotFoundError,
  ProfileRefusal,
  profileDocuments,
  repointDefaultAfterLeaving,
  ResumeNotFoundError,
  summarizeProfile,
  summarizeProfiles,
  writePlacement,
} from './profileTree';
import { getDb } from './sqlite';

/**
 * Profiles - the people - scoped the same way resumes are.
 *
 * A profile is a person, and holds that person's resumes: the resume points at
 * its profile (database/profileTree.ts describes the tree and the rules every
 * write here keeps), so what these functions answer about a profile's resumes
 * is counted from the resumes themselves and a reader cannot see more than the
 * resumes it may see. Every write is ONE IMMEDIATE transaction on ONE
 * connection, with the profile limit counted inside it.
 */

export type Viewer = UserAccount | null;

function canSee(viewer: Viewer, profile: Profile): boolean {
  if (viewer === null) return true;
  if (viewer.role === 'admin') return true;
  return Boolean(profile.ownerId) && profile.ownerId === viewer.id;
}

/** The profile in this transaction, if the viewer may see it; else 404, the same answer as for one that is not there. */
function visibleProfile(db: Database.Database, viewer: Viewer, id: string): Profile {
  const profile = anyProfile(db, id);
  if (!profile || !canSee(viewer, profile)) throw new ProfileNotFoundError();
  return profile;
}

/**
 * The stored profiles a viewer may see, as documents - for a reader that needs
 * the default resume's id and not the counts. No route calls it in F1; the
 * builder (F2) reads the default resume's id through it. The API's list is
 * `listProfileSummariesFor`.
 */
export function listProfilesFor(viewer: Viewer, options: { allOwners?: boolean } = {}): Profile[] {
  return profileDocuments.list().filter((profile) => {
    if (viewer === null) return true;
    if (viewer.role === 'admin' && options.allOwners) return true;
    return Boolean(profile.ownerId) && profile.ownerId === viewer.id;
  });
}

/**
 * The profiles a viewer may see, counted: newest edit first, then id. An
 * administrator's `allOwners` (and a viewer of nobody, a script) reads every
 * account's, each carrying its `ownerId`; anyone else reads their own.
 */
export function listProfileSummariesFor(viewer: Viewer, options: { allOwners?: boolean } = {}): ProfileSummary[] {
  const db = getDb();
  if (viewer === null || (viewer.role === 'admin' && options.allOwners)) {
    return summarizeProfiles(db, null, { includeOwner: true });
  }
  return summarizeProfiles(db, viewer.id);
}

/** One profile, counted; null when it is not there or not the viewer's. */
export function getProfileSummaryFor(viewer: Viewer, id: string): ProfileSummary | null {
  const db = getDb();
  const profile = anyProfile(db, id);
  if (!profile || !canSee(viewer, profile)) return null;
  return summarizeProfile(db, profile);
}

/** The ids a request named, each once, in order; anything that is not text is left out. */
function distinctIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Moves resumes into `target` inside the caller's transaction, all or nothing.
 *
 * Every resume must be one the viewer may see (else 404 `resume-not-found`)
 * and must belong to the profile's own account (else 409
 * `profile-owner-mismatch`, which only an administrator can reach). A resume
 * already in the target is not counted. A resume that moves keeps its
 * `updatedAt`: moving is not editing it. The profile each came from re-points
 * its default when the default left; the target gets one if it had none.
 */
function moveResumesInTransaction(
  db: Database.Database,
  viewer: UserAccount,
  target: Profile,
  resumeIds: readonly string[]
): { moved: number; sources: string[] } {
  const targetOwner = target.ownerId ?? '';

  const rows = resumeIds.map((id) => {
    const row = db.prepare('SELECT id, owner_id, profile_id, data FROM resumes WHERE id = ?').get(id) as
      | { id: string; owner_id: string | null; profile_id: string | null; data: string }
      | undefined;
    if (!row || (viewer.role !== 'admin' && row.owner_id !== viewer.id)) throw new ResumeNotFoundError();
    if ((row.owner_id ?? '') !== targetOwner) {
      throw new ProfileRefusal(
        'A resume can only move to a profile of the account it belongs to.',
        409,
        'profile-owner-mismatch'
      );
    }
    return row;
  });

  const sources = new Set<string>();
  let moved = 0;
  for (const row of rows) {
    if (row.profile_id === target.id) continue;
    if (row.profile_id) sources.add(row.profile_id);
    writePlacement(db, row.id, row.data, target.id);
    moved += 1;
  }

  for (const source of sources) {
    repointDefaultAfterLeaving(db, targetOwner, source);
  }
  ensureDefault(db, targetOwner, target.id);
  return { moved, sources: [...sources] };
}

/**
 * Makes a profile for the account, with the resumes it lists moved into it.
 *
 * The limit is counted here, inside the transaction, AFTER the account's old
 * resumes were filed - an account holding old resumes of three people already
 * has three profiles, and a fourth is refused. `name` blank is 'Untitled
 * Profile'. Administrators are exempt.
 */
export function createProfileFor(
  account: UserAccount,
  input: { name?: unknown; resumeIds?: unknown } = {}
): ProfileSummary {
  return inTreeTransaction((db) => {
    fileUnfiledResumes(db, account.id);
    assertCanAddProfile(account, db, 1);
    const profile = insertProfile(db, account.id, profileNameForPerson(input.name));
    const ids = distinctIds(input.resumeIds);
    if (ids.length > 0) {
      moveResumesInTransaction(db, account, profile, ids);
    }
    return summarizeProfile(db, anyProfile(db, profile.id) ?? profile);
  });
}

/**
 * Renames a profile and/or chooses its default resume. The default must be an
 * ENABLED resume of the profile: another profile's or a missing one is 400
 * `default-not-member`, a disabled one 409 `default-disabled`. A request that
 * changes neither is 400 `nothing-to-change`.
 */
export function updateProfileFor(
  viewer: Viewer,
  id: string,
  update: { name?: unknown; defaultResumeId?: unknown }
): ProfileSummary {
  return inTreeTransaction((db) => {
    const profile = visibleProfile(db, viewer, id);
    if (update.name === undefined && update.defaultResumeId === undefined) {
      throw new ProfileRefusal(
        'There is nothing to change: send a name or a default resume.',
        400,
        'nothing-to-change'
      );
    }

    const next: Profile = { ...profile };

    if (update.name !== undefined) {
      const name = readProfileName(update.name);
      if (!name.ok) throw new ProfileRefusal(name.message, 400, name.code);
      next.name = name.name;
    }

    if (update.defaultResumeId !== undefined) {
      const wanted = typeof update.defaultResumeId === 'string' ? update.defaultResumeId.trim() : '';
      const row = wanted
        ? (db
            .prepare('SELECT disabled FROM resumes WHERE id = ? AND owner_id = ? AND profile_id = ?')
            .get(wanted, profile.ownerId ?? '', profile.id) as { disabled: number } | undefined)
        : undefined;
      if (!row) {
        throw new ProfileRefusal("The default resume must be one of this profile's resumes.", 400, 'default-not-member');
      }
      if (row.disabled === 1) {
        throw new ProfileRefusal(
          'That resume is disabled, so it cannot be the default. Enable it first.',
          409,
          'default-disabled'
        );
      }
      next.defaultResumeId = wanted;
    }

    next.updatedAt = new Date().toISOString();
    profileDocuments.save(next, db);
    return summarizeProfile(db, next);
  });
}

/**
 * Moves resumes into a profile: `{ moved, profiles }` - the target and every
 * profile the resumes came from, counted after the move. All or nothing; see
 * `moveResumesInTransaction` for the rules. An empty list is 400
 * `nothing-to-move`.
 */
export function moveResumesIntoProfile(
  viewer: UserAccount,
  id: string,
  resumeIds: unknown
): { moved: number; profiles: ProfileSummary[] } {
  const ids = distinctIds(resumeIds);
  if (ids.length === 0) {
    throw new ProfileRefusal('Choose the resumes to move.', 400, 'nothing-to-move');
  }

  return inTreeTransaction((db) => {
    fileUnfiledResumes(db, viewer.id);
    const target = visibleProfile(db, viewer, id);
    const { moved, sources } = moveResumesInTransaction(db, viewer, target, ids);

    const profiles: ProfileSummary[] = [];
    for (const profileId of [target.id, ...sources]) {
      const profile = anyProfile(db, profileId);
      if (profile) profiles.push(summarizeProfile(db, profile));
    }
    return { moved, profiles };
  });
}

/**
 * Deletes a profile, every resume in it, and those resumes' Bid Assistant
 * answers - ONE transaction, so a resume added after the person was warned
 * goes with it (the rule is "all the resumes in the profile"), and nothing is
 * left filed under a profile that is gone. No count is asked for or echoed
 * back. Returns how many resumes went. Queued builds of those resumes fail as
 * they do for any deleted resume, and are refunded.
 */
export function deleteProfileFor(viewer: Viewer, id: string): { deletedResumes: number } {
  return inTreeTransaction((db) => {
    const profile = visibleProfile(db, viewer, id);
    const ownerId = profile.ownerId ?? '';
    const ids = (
      db.prepare('SELECT id FROM resumes WHERE owner_id = ? AND profile_id = ?').all(ownerId, profile.id) as Array<{
        id: string;
      }>
    ).map((row) => row.id);

    deleteAnswersFor(db, ids);
    db.prepare('DELETE FROM resumes WHERE owner_id = ? AND profile_id = ?').run(ownerId, profile.id);
    profileDocuments.delete(profile.id, db);
    return { deletedResumes: ids.length };
  });
}

