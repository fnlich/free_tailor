import fs from 'fs/promises';
import path from 'path';
import { Profile } from '../types/profile';
import {
  DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE,
  DEFAULT_RESUME_FILE_NAME_TEMPLATE,
  outputDateText,
  renderOutputFileNameTemplate,
  renderOutputPrefix,
  renderOutputSuffix,
  resolveStoredFilePath,
  sanitizePathSegment,
} from './outputStorage';
import { getOutputStorageSettings } from '../config/aiModelConfig';
import { envOutputPathSuffix } from '../config/settingDefaults';

/** Today, as `{{date}}` spells it before sanitizing. */
export function getCurrentDateFolder(): string {
  return outputDateText(new Date());
}

/**
 * The account's own value for `{{user_email}}`: its email, else `unknown`.
 *
 * The EMAIL rather than the display name: it reads less prettily and is far
 * more likely to be distinct, since a display name is neither unique nor
 * required. It is the same identity the account's spreadsheet is titled with.
 *
 * It is NOT a unique key and must not be treated as one. `sanitizePathSegment`
 * lowercases and collapses every non-alphanumeric run, so `john.smith@acme.com`
 * and `john-smith@acme.com` both become `john_smith_acme_com`. This folder is
 * for a person reading the tree; the order number the prefix must hold is
 * what actually keeps two runs' files apart.
 */
export function accountFolderName(
  account: { name?: string | null; email?: string | null } | null | undefined
): string {
  const email = typeof account?.email === 'string' ? account.email.trim() : '';
  return email || 'unknown';
}

function normalizeSourceRowNumber(value: unknown): string {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return '';
  }
  return String(value);
}

export interface GeneratedPathInfo {
  /** The folder under the output folder, '/'-separated: the rendered prefix, then the rendered suffix. */
  relativeBase: string;
  absoluteDir: string;
  /** What a written file's recorded path starts with: `relativeBase`, relative to the output folder. */
  storagePathBase: string;
  profileSlug: string;
  resumeFileStem: string;
  coverLetterFileStem: string;
  roleSlug: string;
}

export function getResumeOutputFilename(pathInfo: GeneratedPathInfo, extension: 'pdf' | 'docx'): string {
  return `${pathInfo.resumeFileStem || pathInfo.profileSlug}.${extension}`;
}

export function getCoverLetterOutputFilename(pathInfo: GeneratedPathInfo, extension: 'pdf' | 'docx'): string {
  return `${pathInfo.coverLetterFileStem || `${pathInfo.profileSlug}_cover_letter`}.${extension}`;
}

/**
 * Where ONE run files its resumes, fixed when it was submitted
 * (routes/generation.ts, onto every task's payload).
 *
 * Plain strings for the same reason a task names its profile by id: the
 * payload is written to SQLite and replayed after a restart, and a place
 * worked out again from settings edited in the meantime - a new prefix, a new
 * output folder, an account's new folder path, or midnight passing - would put
 * the second half of a run somewhere the first half is not, outside the folder
 * its order recorded (`orders.output_root` = `baseDir` + `prefix`).
 */
export type RunOutputPlace = {
  /** The output folder, absolute, as it was at submission. */
  baseDir: string;
  /** The administrator's prefix, rendered for this run: relative to `baseDir`, '/'-separated. */
  prefix: string;
  /** The submitter's own folder path at submission, validated: rendered per resume, after the role is known. */
  suffix: string;
  /** The day the run was placed, YYYY-MM-DD: what the suffix's `{{date}}` renders. */
  date: string;
  /** For the file NAME templates' `{{account name}}` and `{{order number}}`. */
  accountName: string;
  orderNumber: string;
};

/**
 * How a build is filed.
 *
 * `output` is the run's place (every queued resume has one). Without it - a
 * script, a test - the settings in effect are used, with `unknown` for the
 * account and the order: nothing the routes queue is filed that way.
 */
export type GeneratedPathOptions = {
  sourceRowNumber?: number;
  output?: RunOutputPlace;
};

async function currentPlace(): Promise<RunOutputPlace> {
  const { outputBaseDir, outputPathPrefix } = await getOutputStorageSettings();
  const date = getCurrentDateFolder();
  return {
    baseDir: outputBaseDir,
    prefix: renderOutputPrefix(outputPathPrefix, { user_email: 'unknown', order_number: 'unknown', date }),
    suffix: envOutputPathSuffix().value,
    date,
    accountName: 'unknown',
    orderNumber: 'unknown',
  };
}

export async function getGeneratedOutputPath(
  profile: Profile,
  companyName: string,
  role: string,
  options: GeneratedPathOptions = {}
): Promise<GeneratedPathInfo> {
  const place = options.output ?? (await currentPlace());
  if (!place.baseDir) {
    throw new Error('Output base directory is not configured.');
  }
  const profileSlug = sanitizePathSegment(profile.name) || 'unknown';
  const roleSlug = sanitizePathSegment(role || 'resume') || 'resume';
  const rowNumber = normalizeSourceRowNumber(options.sourceRowNumber);

  // The run's prefix as it was rendered when the run was placed, then this
  // resume's own folders: a missing value is an `unknown` folder, a missing
  // role included - the role has already fallen back to the posting's title
  // where the analysis read one (resolveTaskRole).
  const suffix = renderOutputSuffix(place.suffix, {
    date: place.date,
    profile_name: profile.name || '',
    company_name: companyName || '',
    role: role || '',
    row_number: rowNumber,
  });
  const relativeBase = [place.prefix, suffix].filter(Boolean).join('/');

  const fileNameVariables = {
    date: place.date,
    accountName: place.accountName || 'unknown',
    orderNumber: place.orderNumber || 'unknown',
    profileName: profile.name || 'unknown',
    companyName: companyName || 'unknown',
    rowNumber,
    jobTitle: role || 'resume',
  };
  const resumeFileStem = renderOutputFileNameTemplate(
    profile.profileSettings?.resumeFileNameTemplate || DEFAULT_RESUME_FILE_NAME_TEMPLATE,
    fileNameVariables,
    DEFAULT_RESUME_FILE_NAME_TEMPLATE
  );
  const coverLetterFileStem = renderOutputFileNameTemplate(
    profile.profileSettings?.coverLetterFileNameTemplate || DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE,
    fileNameVariables,
    DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE
  );

  return {
    relativeBase,
    absoluteDir: path.join(place.baseDir, ...relativeBase.split('/')),
    storagePathBase: relativeBase,
    profileSlug,
    resumeFileStem,
    coverLetterFileStem,
    roleSlug,
  };
}

/** `file` relative to `base`, '/'-separated as stored paths are, or null outside it. */
function storedSpellingOf(base: string, file: string): string | null {
  const relative = path.relative(base, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join('/');
}

/**
 * A path a download route was asked for, resolved - with every spelling the
 * ownership check must ask the order rows about.
 *
 * The file system answers to many spellings of one file. `a//b`, `./a/b`,
 * `a/./b` and `x/../a/b` (and `%2E/a/b`, which Express decodes before a route
 * sees it) all open `a/b`, because `resolveStoredFilePath` drops empty segments
 * and resolves dot ones; the order rows record it once, as `a/b`. Asking them
 * about the RAW parameter therefore let every other spelling through as "a path
 * no order claims" - another account's resume, served. So the question is
 * asked of what the server will actually open:
 *
 *  - the path relative to the output directory, '/'-separated, with empty and
 *    dot segments resolved: the shape every stored path already has;
 *  - the same through the operating system's own realpath (fs/promises'
 *    `realpath` is the NATIVE one), which on Windows and macOS gives back the
 *    names as they are on disk - so a change of case, an 8.3 short name, a
 *    trailing dot or another Unicode normalisation of one name is not a new
 *    path - and everywhere follows symlinks. Left out when the real file lies
 *    outside the output directory, where no order writes.
 *
 * `absolutes` are the same file as absolute paths - as opened, and as the
 * operating system names it - for the run folders (`orders.output_root`),
 * which are recorded absolute so that a later output folder or prefix does
 * not move them.
 *
 * Null when the path is empty, leaves the output directory, or names no file.
 */
export async function resolveGeneratedFile(
  requested: string
): Promise<{ absolute: string; spellings: string[]; absolutes: string[] } | null> {
  const normalizedValue = requested.replace(/\\/g, '/').trim();
  if (!normalizedValue) return null;

  const { outputBaseDir } = await getOutputStorageSettings();
  const absolute = resolveStoredFilePath(outputBaseDir, normalizedValue);
  if (!absolute) return null;
  const base = path.resolve(outputBaseDir);

  let realBase: string;
  let realFile: string;
  try {
    if (!(await fs.stat(absolute)).isFile()) return null;
    [realBase, realFile] = await Promise.all([fs.realpath(base), fs.realpath(absolute)]);
  } catch {
    return null;
  }

  const spellings = [storedSpellingOf(base, absolute), storedSpellingOf(realBase, realFile)].filter(
    (spelling): spelling is string => spelling !== null
  );
  if (spellings.length === 0) return null;
  return { absolute, spellings: [...new Set(spellings)], absolutes: [...new Set([absolute, realFile])] };
}

export async function getGeneratedFilePath(relativePathValue: string): Promise<string | null> {
  const normalizedValue = relativePathValue.replace(/\\/g, '/').trim();
  if (!normalizedValue) {
    return null;
  }

  const { outputBaseDir } = await getOutputStorageSettings();
  const resolved = resolveStoredFilePath(outputBaseDir, normalizedValue);

  if (!resolved) {
    return null;
  }

  try {
    await fs.access(resolved);
    return resolved;
  } catch {
    return null;
  }
}
