import { buildNewProfile } from './profileService';
import type { CreateProfileDTO, Profile } from '../types/profile';

/**
 * Reading an uploaded profile file.
 *
 * The normalizer in profileService is deliberately forgiving - it coerces
 * whatever it is handed and never throws, because every field it fills is one
 * the admin form may legitimately have left out. That is exactly wrong for an
 * upload: hand it a package.json and it returns a perfectly valid "Untitled
 * Profile / Professional" with nothing in it, saved without complaint. So the
 * file is GATED here first, and only then normalized. Everything this module
 * rejects, it rejects with a sentence naming which entry was wrong and why.
 */

/** A guard against a misdirected file, not a policy. */
export const MAX_PROFILES_PER_IMPORT = 50;

/** The keys a document may carry a list of profiles under. */
const LIST_KEYS = ['profiles', 'items', 'data'] as const;

/**
 * A field whose presence means "this object is meant to be a profile".
 *
 * Checked so that a JSON file with a `name` and nothing else - a package.json,
 * a lockfile, half the config files on a developer's machine - is refused
 * instead of becoming an empty profile called "my-app".
 */
const PROFILE_FIELDS = [
  'title',
  'contact',
  'summary',
  'experience',
  'strengths',
  'skills',
  'education',
  'certifications',
  'profileSettings',
  'totalYearsExperience',
  'preferredTemplate',
] as const;

/** Carries a message written for the person who chose the file. */
export class ProfileImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileImportError';
  }
}

export type ImportedProfile = {
  profile: Profile;
  /**
   * True when the file's own id was free and has been kept.
   *
   * Worth reporting: a backup restored into an empty install keeps its ids, so
   * the groups that reference those profiles still resolve. Restored into an
   * install that already has them, every id is new - which is the other half
   * of the promise, that an import never overwrites a profile you have.
   */
  keptId: boolean;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The profile objects inside an uploaded document.
 *
 * Three shapes, because all three are things a person actually has in a file:
 * one profile as exported from `GET /api/profiles/:id`, a bare array of them,
 * and a wrapper object with the array under `profiles`.
 */
export function readProfileImportDocument(document: unknown): unknown[] {
  if (Array.isArray(document)) {
    return document;
  }

  if (!isPlainObject(document)) {
    throw new ProfileImportError(
      'That file is not a profile. Expected a JSON object, a list of them, or { "profiles": [ ... ] }.'
    );
  }

  for (const key of LIST_KEYS) {
    if (Array.isArray(document[key])) {
      return document[key] as unknown[];
    }
  }

  return [document];
}

/** Where an entry sits in the file, for an error someone can act on. */
function describePosition(index: number, total: number): string {
  return total === 1 ? 'That file' : `Profile ${index + 1} of ${total}`;
}

function assertLooksLikeProfile(entry: unknown, index: number, total: number): Record<string, unknown> {
  const where = describePosition(index, total);

  if (!isPlainObject(entry)) {
    throw new ProfileImportError(`${where} is not a JSON object.`);
  }

  if (!isNonEmptyString(entry.name)) {
    throw new ProfileImportError(
      `${where} has no "name". Every profile needs one, and importing without it would only ` +
        'produce a profile called "Untitled Profile".'
    );
  }

  if (!PROFILE_FIELDS.some((field) => typeof entry[field] !== 'undefined')) {
    throw new ProfileImportError(
      `${where} has a name but none of the fields a profile is made of (${PROFILE_FIELDS.slice(0, 4).join(', ')}, ...). ` +
        'Check that this is a profile file and not something else that happens to be JSON.'
    );
  }

  return entry;
}

/** An ISO timestamp the file can be trusted to have meant. */
function readTimestamp(value: unknown): string | null {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value)) ? value : null;
}

/**
 * Turns an uploaded document into profiles ready to save.
 *
 * Validates EVERY entry before building any of them, so a file with one bad
 * profile in the middle imports nothing rather than leaving the caller half
 * done and guessing which half.
 */
export function buildImportedProfiles(
  document: unknown,
  options: { idExists: (id: string) => boolean; newId: () => string }
): ImportedProfile[] {
  const entries = readProfileImportDocument(document);

  if (entries.length === 0) {
    throw new ProfileImportError('That file has no profiles in it.');
  }

  if (entries.length > MAX_PROFILES_PER_IMPORT) {
    throw new ProfileImportError(
      `That file holds ${entries.length} profiles; ${MAX_PROFILES_PER_IMPORT} is the most one import may carry.`
    );
  }

  const validated = entries.map((entry, index) => assertLooksLikeProfile(entry, index, entries.length));

  const now = new Date().toISOString();
  const claimed = new Set<string>();

  return validated.map((entry) => {
    // An id is kept only while it is free - never reused, so an import cannot
    // overwrite a profile that is already here. `claimed` covers the same id
    // appearing twice within one file, which would otherwise have the second
    // entry overwrite the first inside a single import.
    const requested = isNonEmptyString(entry.id) ? entry.id.trim() : '';
    const keptId = Boolean(requested) && !options.idExists(requested) && !claimed.has(requested);
    const id = keptId ? requested : options.newId();
    claimed.add(id);

    const built = buildNewProfile(entry as CreateProfileDTO, id);

    return {
      keptId,
      profile: {
        ...built,
        // The profile's own history is a fact about the profile and survives;
        // `updatedAt` does not, because this row was written just now and the
        // list is ordered by it.
        createdAt: readTimestamp(entry.createdAt) ?? built.createdAt,
        updatedAt: now,
      },
    };
  });
}
