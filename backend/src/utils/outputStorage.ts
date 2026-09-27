import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import os from 'os';

export const DEFAULT_GENERATED_RESUMES_DIR = path.join(__dirname, '..', '..', '..', 'generated');
export const DEFAULT_OUTPUT_PATH_TEMPLATE = '/{{profile name}}/{{date}}/{{company name}}/{{job title}}';
export const DEFAULT_RESUME_FILE_NAME_TEMPLATE = '{{profile name}}';
export const DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE = '{{profile name}}_cover_letter';
export const DEFAULT_COMPANY_FOLDER_NAME_TEMPLATE = '{{row number}}_{{company name}}';

/**
 * Where an ORDERED resume is filed, and why it is a constant rather than a
 * setting.
 *
 * `outputPathTemplate` above belongs to the administrator: they may rearrange
 * it whenever they like, and a manual build lands wherever it currently says.
 * An order cannot work that way. Its files are listed, downloaded, zipped and
 * eventually deleted by path, days after they were written - so a layout edited
 * between the build and the download would strand a live order's files and aim
 * the purge at a directory that no longer holds them.
 *
 * The account segment comes first because it makes every file an order owns
 * live under one directory per account, which is what lets the purge prune
 * emptied folders without ever walking into somebody else's tree.
 *
 * THE ORDER NUMBER IS WHAT MAKES A PATH UNIQUE, and it is here because nothing
 * else in the tree is. Account, date, profile and company are all repeatable:
 * import the same sheet twice in one afternoon and every segment matches, so
 * the second run would overwrite the first - leaving the first order listing
 * files whose contents belong to the second, and its earlier expiry deleting
 * files the second still offers. Worse, the account segment is sanitized, and
 * `john.smith@` and `john-smith@` sanitize to one string, so two DIFFERENT
 * accounts could land on one file. An order number is unique across the
 * install, which settles all of it in one segment.
 */
export const ORDER_OUTPUT_PATH_TEMPLATE =
  '/{{account name}}/{{date}}/{{order number}}/{{profile name}}/{{company name}}';

export type OutputTemplateVariables = {
  date: string;
  profileName: string;
  companyName: string;
  rowNumber?: string;
  jobTitle: string;
  /**
   * Optional because most callers have no account in scope - a script, a test,
   * the admin's template preview. Rendering an absent one gives `unknown`,
   * which is what every other empty segment already becomes.
   */
  accountName?: string;
  /** Set for an ordered build. Absent everywhere else, and then `unknown`. */
  orderNumber?: string;
};

const OUTPUT_TOKEN_ALIASES: Record<string, keyof OutputTemplateVariables> = {
  date: 'date',
  account: 'accountName',
  'account name': 'accountName',
  order: 'orderNumber',
  'order number': 'orderNumber',
  profile: 'profileName',
  'profile name': 'profileName',
  company: 'companyName',
  'company name': 'companyName',
  row: 'rowNumber',
  'row number': 'rowNumber',
  'sheet row': 'rowNumber',
  'source row': 'rowNumber',
  role: 'jobTitle',
  'job title': 'jobTitle',
};

/**
 * The MS-DOS device names Windows still reserves, at every directory level and
 * with any extension: `CON`, `nul.pdf` and `foo/AUX/bar` are all rejected by
 * the filesystem with EINVAL rather than created.
 *
 * A profile called "Aux" or a company called "Con" is rare but entirely legal,
 * and without this the failure surfaces as an unexplained write error deep in
 * generation. Applied on every platform, not just Windows, so a tree generated
 * on Linux stays portable when it is synced to a Windows machine and so both
 * platforms produce the same paths for the same inputs.
 */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

function escapeReservedName(value: string): string {
  if (!value) {
    return value;
  }
  // Windows matches the name before the FIRST dot, so "nul.tar.gz" is reserved.
  const stem = value.split('.')[0];
  return WINDOWS_RESERVED_NAME.test(stem) ? `_${value}` : value;
}

export function sanitizePathSegment(value: string): string {
  return escapeReservedName(
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  );
}

export function sanitizeFileNameStem(value: string): string {
  return escapeReservedName(
    value
      .trim()
      .replace(/[<>:"|?*\x00-\x1F]+/g, '_')
      .replace(/[/\\]+/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^[_. ]+|[_. ]+$/g, '')
  );
}

function expandUserPath(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function normalizeOutputBaseDir(value: unknown): string {
  const candidate = typeof value === 'string' && value.trim()
    ? expandUserPath(value.trim())
    : DEFAULT_GENERATED_RESUMES_DIR;
  return path.resolve(candidate);
}

export function validateOutputBaseDir(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Output base directory is required');
  }

  const normalized = normalizeOutputBaseDir(value);
  if (!path.isAbsolute(normalized)) {
    throw new Error('Output base directory must be an absolute path');
  }

  return normalized;
}

export async function ensureWritableOutputDir(value: string): Promise<string> {
  const normalized = validateOutputBaseDir(value);
  await fs.mkdir(normalized, { recursive: true });
  await fs.access(normalized, fsConstants.W_OK);
  return normalized;
}

export function normalizeOutputPathTemplate(value: unknown): string {
  const trimmed = typeof value === 'string' && value.trim()
    ? value.trim()
    : DEFAULT_OUTPUT_PATH_TEMPLATE;
  const withForwardSlashes = trimmed.replace(/\\/g, '/');
  const withLeadingSlash = withForwardSlashes.startsWith('/')
    ? withForwardSlashes
    : `/${withForwardSlashes}`;
  const compact = withLeadingSlash.replace(/\/{2,}/g, '/');
  if (compact.length > 1 && compact.endsWith('/')) {
    return compact.slice(0, -1);
  }
  return compact;
}

export function validateOutputPathTemplate(value: unknown): string {
  const normalized = normalizeOutputPathTemplate(value);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new Error('Output path template must contain at least one folder segment');
  }

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new Error('Output path template cannot contain "." or ".." segments');
    }

    for (const match of segment.matchAll(/\{\{\s*([^}]+)\s*\}\}/g)) {
      const tokenKey = match[1]?.trim().toLowerCase() || '';
      if (!OUTPUT_TOKEN_ALIASES[tokenKey]) {
        throw new Error(`Unsupported output path token "{{${match[1]}}}"`);
      }
    }
  }

  return normalized;
}

function assertSupportedOutputTokens(
  template: string,
  allowedAliases: Record<string, keyof OutputTemplateVariables> = OUTPUT_TOKEN_ALIASES
): void {
  for (const match of template.matchAll(/\{\{\s*([^}]+)\s*\}\}/g)) {
    const tokenKey = match[1]?.trim().toLowerCase() || '';
    if (!allowedAliases[tokenKey]) {
      throw new Error(`Unsupported output token "{{${match[1]}}}"`);
    }
  }
}

function resolveTemplateToken(
  rawToken: string,
  variables: OutputTemplateVariables,
  allowedAliases: Record<string, keyof OutputTemplateVariables> = OUTPUT_TOKEN_ALIASES
): string {
  const key = rawToken.trim().toLowerCase();
  const variableName = allowedAliases[key];
  if (!variableName) {
    throw new Error(`Unsupported output token "{{${rawToken}}}"`);
  }

  return variables[variableName] ?? '';
}

export function renderOutputPathTemplate(
  template: string,
  variables: OutputTemplateVariables
): string {
  const normalizedTemplate = validateOutputPathTemplate(template);
  const renderedSegments = normalizedTemplate
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const withTokenValues = segment.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, rawToken) =>
        resolveTemplateToken(rawToken, variables)
      );
      const sanitized = sanitizePathSegment(withTokenValues);
      return sanitized || 'unknown';
    });

  if (renderedSegments.length === 0) {
    throw new Error('Output path template did not produce a valid folder path');
  }

  return renderedSegments.join('/');
}

export function normalizeOutputFileNameTemplate(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim()
    ? value.trim().replace(/[/\\]+/g, ' ')
    : fallback;
}

export function normalizeOutputFolderNameTemplate(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim()
    ? value.trim().replace(/[/\\]+/g, ' ')
    : fallback;
}

export function validateOutputFileNameTemplate(value: unknown, fallback: string): string {
  const normalized = normalizeOutputFileNameTemplate(value, fallback);
  assertSupportedOutputTokens(normalized);

  const sample = renderOutputFileNameTemplate(normalized, {
    date: '2026-04-10',
    profileName: 'Jane Doe',
    companyName: 'Acme Inc',
    rowNumber: '12',
    jobTitle: 'Senior Engineer',
  }, fallback);

  if (!sample) {
    throw new Error('Output file name template must produce a valid file name');
  }

  return normalized;
}

const COMPANY_FOLDER_TOKEN_ALIASES: Record<string, keyof OutputTemplateVariables> = {
  company: 'companyName',
  'company name': 'companyName',
  row: 'rowNumber',
  'row number': 'rowNumber',
  'sheet row': 'rowNumber',
  'source row': 'rowNumber',
};

export function validateOutputFolderNameTemplate(value: unknown, fallback: string): string {
  const normalized = normalizeOutputFolderNameTemplate(value, fallback);
  assertSupportedOutputTokens(normalized, COMPANY_FOLDER_TOKEN_ALIASES);

  const sample = renderOutputFolderNameTemplate(normalized, {
    date: '2026-04-10',
    profileName: 'Jane Doe',
    companyName: 'Acme Inc',
    rowNumber: '12',
    jobTitle: 'Senior Engineer',
  }, fallback);

  if (!sample) {
    throw new Error('Output folder name template must produce a valid folder name');
  }

  return normalized;
}

export function renderOutputFileNameTemplate(
  template: string,
  variables: OutputTemplateVariables,
  fallback: string
): string {
  const normalizedTemplate = normalizeOutputFileNameTemplate(template, fallback);
  assertSupportedOutputTokens(normalizedTemplate);

  const rendered = normalizedTemplate
    .replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, rawToken) =>
      resolveTemplateToken(rawToken, variables)
    )
    .replace(/[/\\]+/g, ' ')
    .replace(/\.(pdf|docx)$/i, '');

  const sanitized = sanitizeFileNameStem(rendered);
  if (sanitized) {
    return sanitized;
  }

  if (normalizedTemplate === fallback) {
    return 'document';
  }

  return renderOutputFileNameTemplate(fallback, variables, fallback);
}

export function renderOutputFolderNameTemplate(
  template: string,
  variables: OutputTemplateVariables,
  fallback: string
): string {
  const normalizedTemplate = normalizeOutputFolderNameTemplate(template, fallback);
  assertSupportedOutputTokens(normalizedTemplate, COMPANY_FOLDER_TOKEN_ALIASES);

  const rendered = normalizedTemplate.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, rawToken) =>
    resolveTemplateToken(rawToken, variables, COMPANY_FOLDER_TOKEN_ALIASES)
  );

  const sanitized = sanitizePathSegment(rendered);
  if (sanitized) {
    return sanitized;
  }

  if (normalizedTemplate === fallback) {
    return 'unknown';
  }

  return renderOutputFolderNameTemplate(fallback, variables, fallback);
}

export function buildOutputPathPreview(template: string): string {
  return `/${renderOutputPathTemplate(template, {
    date: '2026-04-10',
    accountName: 'jane@example.com',
    orderNumber: 'FT-20260410-0001',
    profileName: 'Jane Doe',
    companyName: 'Acme Inc',
    rowNumber: '12',
    jobTitle: 'Senior Engineer',
  })}`;
}

export function outputPathTemplateUsesJobTitle(template: string): boolean {
  return /\{\{\s*(job title|role)\s*\}\}/i.test(normalizeOutputPathTemplate(template));
}

export function resolveStoredFilePath(baseDir: string, relativePathValue: string): string | null {
  const normalizedBaseDir = path.resolve(baseDir);
  const normalizedRelativePath = relativePathValue
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);

  if (normalizedRelativePath.length === 0) {
    return null;
  }

  const resolvedPath = path.resolve(normalizedBaseDir, ...normalizedRelativePath);
  if (resolvedPath !== normalizedBaseDir && !resolvedPath.startsWith(`${normalizedBaseDir}${path.sep}`)) {
    return null;
  }

  return resolvedPath;
}
