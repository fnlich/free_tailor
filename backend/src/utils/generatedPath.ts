import fs from 'fs/promises';
import path from 'path';
import { Profile } from '../types/profile';
import {
  DEFAULT_COMPANY_FOLDER_NAME_TEMPLATE,
  DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE,
  DEFAULT_RESUME_FILE_NAME_TEMPLATE,
  renderOutputFolderNameTemplate,
  renderOutputFileNameTemplate,
  renderOutputPathTemplate,
  resolveStoredFilePath,
  sanitizePathSegment,
} from './outputStorage';
import { getOutputStorageSettings } from '../config/aiModelConfig';

/** The day an order's files are filed under, and the tree's second segment. */
export function getCurrentDateFolder(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The account's own segment of the output tree.
 *
 * The EMAIL rather than the display name: it reads less prettily and is far
 * more likely to be distinct, since a display name is neither unique nor
 * required. It is the same identity the account's spreadsheet is titled with.
 *
 * It is NOT a unique key and must not be treated as one. `sanitizePathSegment`
 * lowercases and collapses every non-alphanumeric run, so `john.smith@acme.com`
 * and `john-smith@acme.com` both become `john_smith_acme_com`. This segment is
 * for a person reading the tree; the order number a level below is what
 * actually keeps two orders' files apart.
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
  relativeBase: string;
  absoluteDir: string;
  storagePathBase: string;
  profileSlug: string;
  resumeFileStem: string;
  coverLetterFileStem: string;
  companyFolderName: string;
  roleSlug: string;
}

export function getResumeOutputFilename(pathInfo: GeneratedPathInfo, extension: 'pdf' | 'docx'): string {
  return `${pathInfo.resumeFileStem || pathInfo.profileSlug}.${extension}`;
}

export function getCoverLetterOutputFilename(pathInfo: GeneratedPathInfo, extension: 'pdf' | 'docx'): string {
  return `${pathInfo.coverLetterFileStem || `${pathInfo.profileSlug}_cover_letter`}.${extension}`;
}

/**
 * How a build may override where it is filed.
 *
 * `pathTemplate` exists for orders, which use the fixed
 * `ORDER_OUTPUT_PATH_TEMPLATE` rather than the administrator's setting - see
 * the comment on that constant for why. `accountName` fills the account
 * segment; it is optional because a script or a test has no account in scope,
 * and an absent one renders as `unknown` like any other empty segment.
 */
export type GeneratedPathOptions = {
  sourceRowNumber?: number;
  accountName?: string;
  /** The order's number, which is what makes an ordered path unique. */
  orderNumber?: string;
  pathTemplate?: string;
};

export async function getGeneratedOutputPath(
  profile: Profile,
  companyName: string,
  role: string,
  options: GeneratedPathOptions = {}
): Promise<GeneratedPathInfo> {
  const { outputBaseDir, outputPathTemplate } = await getOutputStorageSettings();
  const profileSlug = sanitizePathSegment(profile.name) || 'unknown';
  const roleSlug = sanitizePathSegment(role || 'resume') || 'resume';
  const rowNumber = normalizeSourceRowNumber(options.sourceRowNumber);
  const baseTemplateVariables = {
    date: getCurrentDateFolder(),
    accountName: options.accountName || 'unknown',
    orderNumber: options.orderNumber || 'unknown',
    profileName: profile.name || 'unknown',
    companyName: companyName || 'unknown',
    rowNumber,
    jobTitle: role || 'resume',
  };
  const companyFolderName = renderOutputFolderNameTemplate(
    profile.profileSettings?.companyFolderNameTemplate || DEFAULT_COMPANY_FOLDER_NAME_TEMPLATE,
    baseTemplateVariables,
    DEFAULT_COMPANY_FOLDER_NAME_TEMPLATE
  );
  const pathTemplateVariables = {
    ...baseTemplateVariables,
    companyName: companyFolderName,
  };
  const relativeBase = renderOutputPathTemplate(
    options.pathTemplate || outputPathTemplate,
    pathTemplateVariables
  );
  const resumeFileStem = renderOutputFileNameTemplate(
    profile.profileSettings?.resumeFileNameTemplate || DEFAULT_RESUME_FILE_NAME_TEMPLATE,
    baseTemplateVariables,
    DEFAULT_RESUME_FILE_NAME_TEMPLATE
  );
  const coverLetterFileStem = renderOutputFileNameTemplate(
    profile.profileSettings?.coverLetterFileNameTemplate || DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE,
    baseTemplateVariables,
    DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE
  );
  if (!outputBaseDir) {
    throw new Error('Output base directory is not configured.');
  }

  const absoluteDir = path.join(outputBaseDir, ...relativeBase.split('/'));
  const storagePathBase = relativeBase;

  return {
    relativeBase,
    absoluteDir,
    storagePathBase,
    profileSlug,
    resumeFileStem,
    coverLetterFileStem,
    companyFolderName,
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
 * Null when the path is empty, leaves the output directory, or names no file.
 */
export async function resolveGeneratedFile(
  requested: string
): Promise<{ absolute: string; spellings: string[] } | null> {
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
  return { absolute, spellings: [...new Set(spellings)] };
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
