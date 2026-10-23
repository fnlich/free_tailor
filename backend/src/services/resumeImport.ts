import { buildNewResume } from './resumeDocument';
import type { CreateResumeDTO, Resume } from '../types/resume';
import { PublicError } from '../middleware/publicError';

/**
 * Reading an uploaded resume file.
 *
 * The normalizer in resumeDocument is deliberately forgiving - it coerces
 * whatever it is handed and never throws, because every field it fills is one
 * the admin form may legitimately have left out. That is exactly wrong for an
 * upload: hand it a package.json and it returns a perfectly valid "Untitled
 * Resume / Professional" with nothing in it, saved without complaint. So the
 * file is GATED here first, and only then normalized. Everything this module
 * rejects, it rejects with a sentence naming which entry was wrong and why.
 */

/** A guard against a misdirected file, not a policy. */
export const MAX_RESUMES_PER_IMPORT = 50;

/**
 * The keys a document may carry a list of resumes under.
 *
 * `profiles` is the list wrapper of the one input alias (owner decision D9): a
 * v4.1 list of records, made by hand, wrapped them under it. (A v4.1 Download
 * JSON file is a bare record, as `resumeExportText` writes one now; its alias is
 * the field `profileSettings`, below.) Read, and never written.
 */
const LIST_KEYS = ['resumes', 'profiles', 'items', 'data'] as const;

/**
 * A field whose presence means "this object is meant to be a resume".
 *
 * Checked so that a JSON file with a `name` and nothing else - a package.json,
 * a lockfile, half the config files on a developer's machine - is refused
 * instead of becoming an empty resume called "my-app".
 */
const RESUME_FIELDS = [
  'title',
  'contact',
  'summary',
  'experience',
  'strengths',
  'skills',
  // A file that groups its skills carries this instead of, or as well as, a
  // flat `skills` - so a resume whose only skills field is the grouped one
  // must still read as a resume.
  'skillCategories',
  // Its own field since the Soft Skills switch, so a file that lists only
  // those is still somebody's resume.
  'softSkills',
  'education',
  'certifications',
  // The other section kinds (config/sectionCatalogue.ts) and the order they
  // print in: a file holding only a person's projects is still their resume.
  'projects',
  'languages',
  'awards',
  'publications',
  'volunteering',
  'courses',
  'interests',
  'references',
  'customSections',
  'sectionOrder',
  'resumeSettings',
  // The v4.1 spelling of `resumeSettings` (D9), read by this file alone.
  'profileSettings',
  'totalYearsExperience',
  'preferredTemplate',
] as const;

/** Carries a message written for the person who chose the file. */
export class ResumeImportError extends PublicError {
  constructor(message: string) {
    super(message, { status: 400 });
    this.name = 'ResumeImportError';
  }
}

export type ImportedResume = {
  resume: Resume;
  /**
   * True when the file's own id was free and has been kept.
   *
   * Worth reporting: a backup restored into an empty install keeps its ids, so
   * the profiles that list those resumes still resolve. Restored into an
   * install that already has them, every id is new - which is the other half
   * of the promise, that an import never overwrites a resume you have.
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
 * The resume objects inside an uploaded document.
 *
 * Three shapes, because all three are things a person actually has in a file:
 * one resume as exported from `GET /api/resumes/:id`, a bare array of them,
 * and a wrapper object with the array under `resumes` (or, in a file exported
 * by v4.1, under `profiles` - see LIST_KEYS).
 */
export function readResumeImportDocument(document: unknown): unknown[] {
  if (Array.isArray(document)) {
    return document;
  }

  if (!isPlainObject(document)) {
    throw new ResumeImportError(
      'That file is not a resume. Expected a JSON object, a list of them, or { "resumes": [ ... ] }.'
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
  return total === 1 ? 'That file' : `Resume ${index + 1} of ${total}`;
}

function assertLooksLikeResume(entry: unknown, index: number, total: number): Record<string, unknown> {
  const where = describePosition(index, total);

  if (!isPlainObject(entry)) {
    throw new ResumeImportError(`${where} is not a JSON object.`);
  }

  if (!isNonEmptyString(entry.name)) {
    throw new ResumeImportError(
      `${where} has no "name". Every resume needs one, and importing without it would only ` +
        'produce a resume called "Untitled Profile".'
    );
  }

  if (!RESUME_FIELDS.some((field) => typeof entry[field] !== 'undefined')) {
    throw new ResumeImportError(
      `${where} has a name but none of the fields a resume is made of (${RESUME_FIELDS.slice(0, 4).join(', ')}, ...). ` +
        'Check that this is a resume file and not something else that happens to be JSON.'
    );
  }

  return entry;
}

/** What a v4.1 export file called a record's settings (D9). */
const V41_SETTINGS_KEY = 'profileSettings';

/**
 * The record with its settings under the current key.
 *
 * A v4.1 export carries them under the key above; the resume record has called
 * them `resumeSettings` since v4.2. The alias is read here and nowhere else,
 * and the built resume never carries the old key. When a file somehow names
 * both, the current one wins.
 */
function withCurrentSettingsKey(entry: Record<string, unknown>): Record<string, unknown> {
  if (typeof entry[V41_SETTINGS_KEY] === 'undefined') {
    return entry;
  }

  const { [V41_SETTINGS_KEY]: v41Settings, ...rest } = entry;
  return typeof rest.resumeSettings === 'undefined' ? { ...rest, resumeSettings: v41Settings } : rest;
}

/** An ISO timestamp the file can be trusted to have meant. */
function readTimestamp(value: unknown): string | null {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value)) ? value : null;
}

/**
 * Turns an uploaded document into resumes ready to save.
 *
 * Validates EVERY entry before building any of them, so a file with one bad
 * resume in the middle imports nothing rather than leaving the caller half
 * done and guessing which half.
 */
export function buildImportedResumes(
  document: unknown,
  options: { idExists: (id: string) => boolean; newId: () => string }
): ImportedResume[] {
  const entries = readResumeImportDocument(document);

  if (entries.length === 0) {
    throw new ResumeImportError('That file has no resumes in it.');
  }

  if (entries.length > MAX_RESUMES_PER_IMPORT) {
    throw new ResumeImportError(
      `That file holds ${entries.length} resumes; ${MAX_RESUMES_PER_IMPORT} is the most one import may carry.`
    );
  }

  const validated = entries.map((entry, index) =>
    withCurrentSettingsKey(assertLooksLikeResume(entry, index, entries.length))
  );

  const now = new Date().toISOString();
  const claimed = new Set<string>();

  return validated.map((entry) => {
    // An id is kept only while it is free - never reused, so an import cannot
    // overwrite a resume that is already here. `claimed` covers the same id
    // appearing twice within one file, which would otherwise have the second
    // entry overwrite the first inside a single import.
    const requested = isNonEmptyString(entry.id) ? entry.id.trim() : '';
    const keptId = Boolean(requested) && !options.idExists(requested) && !claimed.has(requested);
    const id = keptId ? requested : options.newId();
    claimed.add(id);

    const built = buildNewResume(entry as CreateResumeDTO, id);

    return {
      keptId,
      resume: {
        ...built,
        // The resume's own history is a fact about the resume and survives;
        // `updatedAt` does not, because this row was written just now and the
        // list is ordered by it.
        createdAt: readTimestamp(entry.createdAt) ?? built.createdAt,
        updatedAt: now,
      },
    };
  });
}
