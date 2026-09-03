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

function getCurrentDateFolder(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
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

export async function getGeneratedOutputPath(
  profile: Profile,
  companyName: string,
  role: string,
  sourceRowNumber?: number
): Promise<GeneratedPathInfo> {
  const { outputBaseDir, outputPathTemplate } = await getOutputStorageSettings();
  const profileSlug = sanitizePathSegment(profile.name) || 'unknown';
  const roleSlug = sanitizePathSegment(role || 'resume') || 'resume';
  const rowNumber = normalizeSourceRowNumber(sourceRowNumber);
  const baseTemplateVariables = {
    date: getCurrentDateFolder(),
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
  const relativeBase = renderOutputPathTemplate(outputPathTemplate, pathTemplateVariables);
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
