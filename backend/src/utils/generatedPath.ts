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
 * The EMAIL rather than the display name, which reads less prettily and is the
 * right call anyway: `users.email` is `NOT NULL UNIQUE` and a display name is
 * neither, so two people called "John Smith" would otherwise file into one
 * directory. It is the same identity the account's spreadsheet is titled with.
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
