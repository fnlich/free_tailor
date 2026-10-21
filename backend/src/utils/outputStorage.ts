import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import os from 'os';
import { PublicError } from '../middleware/publicError';

export const DEFAULT_GENERATED_RESUMES_DIR = path.join(__dirname, '..', '..', '..', 'generated');
export const DEFAULT_RESUME_FILE_NAME_TEMPLATE = '{{profile_name}}';
export const DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE = '{{profile_name}}_cover_letter';

/**
 * Where a resume is filed: `<output folder>/<prefix>/<suffix>/<file name>`
 * (owner decisions O1-O4).
 *
 * The PREFIX is the administrator's (Admin -> Settings -> General,
 * `outputPathPrefix`, else `OUTPUT_PATH_PREFIX`, else this default) and is
 * the same for every account. It may use only `{{user_email}}`,
 * `{{order_number}}` and `{{date}}`, and it must hold `{{order_number}}`
 * exactly once, as a folder of its own: an order number is unique across the
 * install - account, date, profile and company all repeat, and the email is
 * sanitized for the file system, so `john.smith@` and `john-smith@` are one
 * folder - which makes every run's prefix a folder nobody else's files are
 * in. That folder, rendered under the output folder, is the run's
 * `orders.output_root`: what its files are claimed by when somebody asks to
 * download one (database/orderRepository.ts `ownersOfGeneratedFile`), however
 * the prefix is changed afterwards.
 *
 * The SUFFIX is each account's own (Settings -> Profile -> Resume files,
 * `users.output_path_suffix`, else `OUTPUT_PATH_SUFFIX`, else this default):
 * `{{date}}`, `{{profile_name}}`, `{{company_name}}`, `{{role}}` and
 * `{{row_number}}`, with literal text around them in a folder
 * (`/{{date}}{{profile_name}}` is one folder).
 *
 * The two are fixed for a run when it is submitted (the queue's payload
 * carries them, services/queue/resumeTask.ts), so a setting edited while it
 * runs cannot split one run between two trees. Each folder is rendered and
 * THEN sanitized as a whole (`sanitizePathSegment`), so no value - a company
 * called "../etc", a role with a slash - is ever more than one folder.
 *
 * The per-profile file NAME templates below read these spellings too, and the
 * older spaced ones (`{{profile name}}`) profiles may have stored.
 */
export const OUTPUT_PATH_TOKENS = [
  'user_email',
  'order_number',
  'date',
  'profile_name',
  'company_name',
  'role',
  'row_number',
] as const;

export type OutputPathToken = (typeof OUTPUT_PATH_TOKENS)[number];

/** What the administrator's prefix may use. */
export const OUTPUT_PREFIX_TOKENS: readonly OutputPathToken[] = ['user_email', 'order_number', 'date'];

/** What an account's own suffix may use. */
export const OUTPUT_SUFFIX_TOKENS: readonly OutputPathToken[] = [
  'date',
  'profile_name',
  'company_name',
  'role',
  'row_number',
];

export const DEFAULT_OUTPUT_PATH_PREFIX = '/{{user_email}}/{{order_number}}';
export const DEFAULT_OUTPUT_PATH_SUFFIX = '/{{date}}/{{profile_name}}/{{company_name}}/{{role}}';

/** The most folders a prefix or a suffix may have. */
export const MAX_OUTPUT_PATH_SEGMENTS = 8;

/** Which of the two a value is: decides its tokens, its rules and the words a refusal uses. */
export type OutputPathPart = 'prefix' | 'suffix';

/** The settings field each part is saved under, which a refusal names so a page can pin it. */
export const OUTPUT_PATH_FIELDS: Record<OutputPathPart, 'outputPathPrefix' | 'outputPathSuffix'> = {
  prefix: 'outputPathPrefix',
  suffix: 'outputPathSuffix',
};

/** Every value a path may be rendered with; an absent or empty one renders as nothing. */
export type OutputPathValues = Partial<Record<OutputPathToken, string>>;

/** A checked prefix or suffix: its canonical spelling, or every sentence about what is wrong with it. */
export type OutputPathCheck = { ok: true; value: string } | { ok: false; problems: string[] };

/**
 * A prefix or suffix refused: a 400 whose sentence is the validator's and
 * whose `field` names the box it came from (`outputPathPrefix` or
 * `outputPathSuffix`), so a page can put the sentence under it. Public: it
 * quotes only what the person typed and the tokens they may use.
 */
export class OutputPathError extends PublicError {
  readonly field: 'outputPathPrefix' | 'outputPathSuffix';

  constructor(part: OutputPathPart, problems: string[]) {
    const field = OUTPUT_PATH_FIELDS[part];
    super(problems.join(' '), { status: 400, code: 'output-path-invalid', extra: { field } });
    this.name = 'OutputPathError';
    this.field = field;
  }
}

const TOKEN_PATTERN = /\{\{([^{}]*)\}\}/g;

function isOutputPathToken(name: string): name is OutputPathToken {
  return (OUTPUT_PATH_TOKENS as readonly string[]).includes(name);
}

/** `{{a}}, {{b}} and {{c}}`, for a sentence. */
function listTokens(tokens: readonly OutputPathToken[]): string {
  const spelled = tokens.map((token) => `{{${token}}}`);
  return spelled.length > 1 ? `${spelled.slice(0, -1).join(', ')} and ${spelled[spelled.length - 1]}` : spelled[0];
}

const PART_LABEL: Record<OutputPathPart, string> = {
  prefix: 'The output prefix',
  suffix: 'The folder path',
};

/** The tokens each part allows, and why the others are not its. */
const PART_TOKENS: Record<OutputPathPart, readonly OutputPathToken[]> = {
  prefix: OUTPUT_PREFIX_TOKENS,
  suffix: OUTPUT_SUFFIX_TOKENS,
};

const MISPLACED_REASON: Record<OutputPathPart, string> = {
  prefix: "it belongs in each account's own folder path, which comes after the prefix",
  suffix: "the administrator's output prefix places it, before your folder path",
};

/**
 * One prefix or suffix, checked against its rules. Every problem is reported,
 * each a sentence naming the token or the folder at fault, so a page can show
 * them all at once; the value comes back in its canonical spelling - one
 * leading `/`, no trailing one, each token as `{{name}}`.
 */
function checkOutputPath(part: OutputPathPart, value: unknown): OutputPathCheck {
  const label = PART_LABEL[part];
  const allowed = PART_TOKENS[part];
  if (typeof value !== 'string') {
    return { ok: false, problems: [`${label} must be text.`] };
  }
  const text = value.trim().replace(/\\/g, '/');
  const problems: string[] = [];
  const say = (sentence: string): void => {
    if (!problems.includes(sentence)) problems.push(sentence);
  };

  if (/^\/?[A-Za-z]:/.test(text)) {
    say(`${label} cannot start with a drive letter ("${text.replace(/^\//, '').slice(0, 2)}"): it is a path inside the output folder.`);
  }
  if (/^\/?~/.test(text)) {
    say(`${label} cannot start with "~": it is a path inside the output folder.`);
  }

  // One leading and one trailing slash are optional; anything else empty is a
  // folder with no name.
  const inner = text.replace(/^\//, '').replace(/\/$/, '');
  if (!inner) {
    return {
      ok: false,
      problems: [
        part === 'prefix'
          ? `${label} is empty. It needs {{order_number}} as a folder of its own, like ${DEFAULT_OUTPUT_PATH_PREFIX}.`
          : `${label} is empty. Reset it to use the default instead.`,
      ],
    };
  }
  const segments = inner.split('/');
  if (segments.length > MAX_OUTPUT_PATH_SEGMENTS) {
    say(`${label} has ${segments.length} folders; it may have at most ${MAX_OUTPUT_PATH_SEGMENTS}.`);
  }

  let orderNumbers = 0;
  const canonical: string[] = [];
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) {
      say(`${label} has an empty folder (two slashes together).`);
      continue;
    }
    if (trimmed === '.' || trimmed === '..') {
      say(`${label} cannot have a "${trimmed}" folder.`);
      continue;
    }
    let tokensHere = 0;
    let orderHere = false;
    const spelled = trimmed.replace(TOKEN_PATTERN, (match, rawName: string) => {
      const name = rawName.trim();
      tokensHere += 1;
      if (!isOutputPathToken(name)) {
        say(`${label} uses ${match}, which is not a token. It may use ${listTokens(allowed)}.`);
        return match;
      }
      if (!allowed.includes(name)) {
        say(`${label} cannot use {{${name}}}: ${MISPLACED_REASON[part]}. It may use ${listTokens(allowed)}.`);
        return `{{${name}}}`;
      }
      if (name === 'order_number') {
        orderNumbers += 1;
        orderHere = true;
      }
      return `{{${name}}}`;
    });
    const literal = spelled.replace(TOKEN_PATTERN, '');
    if (/[{}]/.test(literal)) {
      say(`${label} has a stray "{" or "}" in "${trimmed}": write a token as {{name}}, like {{date}}.`);
    }
    if (orderHere && (tokensHere > 1 || literal.trim() !== '')) {
      say(`In ${label.charAt(0).toLowerCase()}${label.slice(1)}, {{order_number}} must be a folder of its own, not part of "${trimmed}".`);
    }
    canonical.push(spelled);
  }

  if (part === 'prefix') {
    if (orderNumbers === 0) {
      say(
        `${label} must contain {{order_number}} as a folder of its own, like ${DEFAULT_OUTPUT_PATH_PREFIX}: ` +
          "it is what keeps one run's files apart from every other's."
      );
    } else if (orderNumbers > 1) {
      say(`${label} uses {{order_number}} ${orderNumbers} times; it must use it exactly once.`);
    }
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: `/${canonical.join('/')}` };
}

/** The administrator's prefix, checked: see `checkOutputPath`. */
export function validateOutputPrefix(value: unknown): OutputPathCheck {
  return checkOutputPath('prefix', value);
}

/** An account's own suffix, checked: see `checkOutputPath`. */
export function validateOutputSuffix(value: unknown): OutputPathCheck {
  return checkOutputPath('suffix', value);
}

/** A prefix or suffix in its canonical spelling, or an `OutputPathError` carrying every problem. */
export function requireValidOutputPath(part: OutputPathPart, value: unknown): string {
  const check = checkOutputPath(part, value);
  if (!check.ok) throw new OutputPathError(part, check.problems);
  return check.value;
}

function renderSegments(part: OutputPathPart, template: string, values: OutputPathValues): string[] {
  const value = requireValidOutputPath(part, template);
  return value
    .slice(1)
    .split('/')
    .map((segment) => {
      // One pass: a value that itself reads like a token is text, never expanded again.
      const withValues = segment.replace(TOKEN_PATTERN, (_match, rawName: string) => {
        const name = rawName.trim() as OutputPathToken;
        return values[name] ?? '';
      });
      // Sanitized as ONE folder, after the values are in: `{{date}}{{profile_name}}`
      // is one folder, and no value can add another.
      return sanitizePathSegment(withValues) || 'unknown';
    });
}

/** A prefix rendered: `jane_doe_example_com/ft_20261015_0001`, relative and '/'-separated. Throws an `OutputPathError` for one that is not valid. */
export function renderOutputPrefix(prefix: string, values: OutputPathValues): string {
  return renderSegments('prefix', prefix, values).join('/');
}

/** A suffix rendered, relative and '/'-separated. Throws an `OutputPathError` for one that is not valid. */
export function renderOutputSuffix(suffix: string, values: OutputPathValues): string {
  return renderSegments('suffix', suffix, values).join('/');
}

/**
 * The whole folder a resume is written to, under the output folder: the
 * prefix's folders, then the suffix's, each sanitized after its values are
 * in, an empty one as `unknown`.
 */
export function renderOutputPath(prefix: string, suffix: string, values: OutputPathValues): string {
  return [...renderSegments('prefix', prefix, values), ...renderSegments('suffix', suffix, values)].join('/');
}

/** Whether a suffix files by role - which is when the builder offers its Role box. */
export function outputSuffixUsesRole(suffix: string): boolean {
  const check = validateOutputSuffix(suffix);
  return check.ok && /\{\{role\}\}/.test(check.value);
}

/**
 * A day as `{{date}}` spells it before sanitizing - YYYY-MM-DD in the
 * server's own time zone, as runs have always been filed (and as an order's
 * number is dated, database/dailySequence.ts).
 */
export function outputDateText(at: Date = new Date()): string {
  const year = at.getFullYear();
  const month = `${at.getMonth() + 1}`.padStart(2, '0');
  const day = `${at.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The values a preview renders with, so a person sees their own folder: their
 * email (the account folder), a sample order number and today's date, their
 * first profile's name, and a made-up job. Both previews - an account's folder
 * path and the administrator's prefix - use these, and only previews do.
 */
export function sampleOutputPathValues(
  options: { email?: string | null; profileName?: string | null; at?: Date } = {}
): OutputPathValues {
  const date = outputDateText(options.at);
  return {
    user_email: options.email?.trim() || 'jane.doe@example.com',
    order_number: `FT-${date.split('-').join('')}-0001`,
    date,
    profile_name: options.profileName?.trim() || 'Sample Profile',
    company_name: 'Acme',
    role: 'Software Engineer',
    row_number: '2',
  };
}

/**
 * What a valid suffix is worth knowing before it is saved, never a refusal.
 * One run builds every job for every profile chosen; with no
 * `{{company_name}}` in the folders, one profile's resumes for two companies
 * share a folder. Nothing is overwritten - a resume whose file name another
 * of the run already has gets a number (services/queue/runFiles.ts) - but
 * `Ada.pdf` and `Ada_2.pdf` do not say which company each is for.
 */
export function outputSuffixNotes(suffix: string): string[] {
  const check = validateOutputSuffix(suffix);
  if (!check.ok) return [];
  const notes: string[] = [];
  if (!/\{\{company_name\}\}/.test(check.value)) {
    notes.push(
      'Without {{company_name}}, the resumes one profile builds for different companies in one run share a ' +
        'folder, told apart only by a number after the file name unless the file names name the company.'
    );
  }
  return notes;
}

export type FileNameVariables = {
  date: string;
  profileName: string;
  companyName: string;
  rowNumber?: string;
  jobTitle: string;
  /** The account's email, for `{{user_email}}`; `unknown` when there is none. */
  accountName?: string;
  /** The run's order number, for `{{order_number}}`; `unknown` when there is none. */
  orderNumber?: string;
};

/**
 * The per-profile file NAME templates' tokens: the folder tokens' own
 * spellings (`{{profile_name}}`, `{{company_name}}`, `{{row_number}}`,
 * `{{role}}`, `{{date}}`, `{{user_email}}`, `{{order_number}}`), which the
 * profile editor offers, and the spellings profiles have always stored them in,
 * which still read. Not the folder rules above: a name is one file in the
 * folder the prefix and suffix chose.
 */
const FILE_NAME_TOKEN_ALIASES: Record<string, keyof FileNameVariables> = {
  date: 'date',
  user_email: 'accountName',
  order_number: 'orderNumber',
  profile_name: 'profileName',
  company_name: 'companyName',
  row_number: 'rowNumber',
  job_title: 'jobTitle',
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

/*
 * The file name templates are a profile's own fields, typed by its owner, so a
 * refusal of one is public: it quotes only what they wrote.
 */
function assertSupportedFileNameTokens(template: string): void {
  for (const match of template.matchAll(/\{\{\s*([^}]+)\s*\}\}/g)) {
    const tokenKey = match[1]?.trim().toLowerCase() || '';
    if (!FILE_NAME_TOKEN_ALIASES[tokenKey]) {
      throw new PublicError(`Unsupported output token "{{${match[1]}}}"`);
    }
  }
}

function resolveFileNameToken(rawToken: string, variables: FileNameVariables): string {
  const variableName = FILE_NAME_TOKEN_ALIASES[rawToken.trim().toLowerCase()];
  if (!variableName) {
    throw new PublicError(`Unsupported output token "{{${rawToken}}}"`);
  }
  return variables[variableName] ?? '';
}

export function normalizeOutputFileNameTemplate(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim()
    ? value.trim().replace(/[/\\]+/g, ' ')
    : fallback;
}

export function validateOutputFileNameTemplate(value: unknown, fallback: string): string {
  const normalized = normalizeOutputFileNameTemplate(value, fallback);
  assertSupportedFileNameTokens(normalized);

  const sample = renderOutputFileNameTemplate(normalized, {
    date: '2026-04-10',
    profileName: 'Jane Doe',
    companyName: 'Acme Inc',
    rowNumber: '12',
    jobTitle: 'Senior Engineer',
  }, fallback);

  if (!sample) {
    throw new PublicError('Output file name template must produce a valid file name');
  }

  return normalized;
}

export function renderOutputFileNameTemplate(
  template: string,
  variables: FileNameVariables,
  fallback: string
): string {
  const normalizedTemplate = normalizeOutputFileNameTemplate(template, fallback);
  assertSupportedFileNameTokens(normalizedTemplate);

  const rendered = normalizedTemplate
    .replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, rawToken) => resolveFileNameToken(rawToken, variables))
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
