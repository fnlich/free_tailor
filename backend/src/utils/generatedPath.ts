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
  absoluteDir: string;
  /**
   * The folder under the output folder, '/'-separated: the rendered prefix,
   * then the rendered suffix. What a written file's recorded path starts with.
   */
  storagePathBase: string;
  profileSlug: string;
  resumeFileStem: string;
  coverLetterFileStem: string;
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
  /** For the file NAME templates' `{{user_email}}` and `{{order_number}}`. */
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
  const storagePathBase = [place.prefix, suffix].filter(Boolean).join('/');

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
    absoluteDir: path.join(place.baseDir, ...storagePathBase.split('/')),
    storagePathBase,
    profileSlug,
    resumeFileStem,
    coverLetterFileStem,
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

/**
 * The output folder a run's files were written under, worked out from the
 * run's recorded folder (`orders.output_root`, `<output folder>/<rendered
 * prefix>`) and one of its recorded paths (`<rendered prefix>/<folder
 * path>/<file>`, relative to that output folder): the root less the trailing
 * folders the path begins with - as many as match, at most. Null when they
 * share none, or the path names no folder at all.
 *
 * A run keeps the output folder it was placed in (`RunOutputPlace.baseDir`),
 * so an administrator moving the output folder must not move where its files
 * are looked for - neither a run built before the change nor one still queued
 * then, which goes on writing where it began.
 */
export function runBaseDir(outputRoot: string | null | undefined, recorded: string): string | null {
  if (!outputRoot) return null;
  const root = path.resolve(outputRoot);
  const rootSegments = root.split(path.sep).filter(Boolean);
  const pathSegments = recorded.replace(/\\/g, '/').split('/').filter(Boolean);
  const same = (a: string, b: string) => a === b || a.toLowerCase() === b.toLowerCase();
  for (let count = Math.min(rootSegments.length - 1, pathSegments.length - 1); count >= 1; count -= 1) {
    const tail = rootSegments.slice(rootSegments.length - count);
    if (tail.every((segment, index) => same(segment, pathSegments[index]))) {
      let base = root;
      for (let step = 0; step < count; step += 1) base = path.dirname(base);
      return base;
    }
  }
  return null;
}

/**
 * A recorded file of a run, found on disk: under the run's own output folder
 * first (`runBaseDir`), then under the one in effect - where an administrator
 * who moved the old tree across put it. Each through the traversal guard
 * every download uses, so a doctored row cannot reach outside the folder it
 * is resolved under. `baseDir` is the folder it was found under. Null when it
 * is in neither.
 */
export async function resolveRunFile(
  relativePathValue: string,
  outputRoot?: string | null
): Promise<{ absolute: string; baseDir: string } | null> {
  const normalizedValue = relativePathValue.replace(/\\/g, '/').trim();
  if (!normalizedValue) {
    return null;
  }

  const { outputBaseDir } = await getOutputStorageSettings();
  const bases = [runBaseDir(outputRoot, normalizedValue), outputBaseDir ? path.resolve(outputBaseDir) : null].filter(
    (base, index, all): base is string => Boolean(base) && all.indexOf(base) === index
  );
  for (const baseDir of bases) {
    const resolved = resolveStoredFilePath(baseDir, normalizedValue);
    if (!resolved) continue;
    try {
      await fs.access(resolved);
      return { absolute: resolved, baseDir };
    } catch {
      // Not under this one; the next, if any.
    }
  }
  return null;
}

/** `resolveRunFile`'s path alone: what the download routes open. */
export async function getGeneratedFilePath(
  relativePathValue: string,
  outputRoot?: string | null
): Promise<string | null> {
  return (await resolveRunFile(relativePathValue, outputRoot))?.absolute ?? null;
}
