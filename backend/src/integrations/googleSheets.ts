import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { PublicError } from '../middleware/publicError';

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

/**
 * Two scopes, asked for SEPARATELY - one token per API.
 *
 * Sharing is not a Sheets operation: a spreadsheet is a Drive file, so deciding
 * who may open it needs the `drive` scope and a different API host. Asking for
 * one and calling the other is the failure this comment exists to prevent - the
 * token is accepted, the Drive call returns 403, and the message blames the file
 * rather than the scope.
 *
 * They are minted separately rather than as one token carrying both, and that is
 * the important part: a project where Drive is unavailable would otherwise have
 * every call refused, including creating a spreadsheet that never needed Drive.
 * Split, a Drive problem can only break sharing.
 *
 * Old doc follows: sharing is not a Sheets operation.
 *
 * Creating a spreadsheet and writing to it needs `spreadsheets`. Deciding WHO
 * can open it is a Drive concept - a spreadsheet is a Drive file with a
 * permission list - so changing visibility needs `drive` and a different API
 * host. Asking for one and calling the other is the failure this comment exists
 * to prevent: the token is accepted, the Drive call returns 403, and the
 * message blames the file rather than the scope.
 *
 * The scope is requested at token time, so an existing deployment picks it up
 * on the next token refresh - but only once the Drive API is enabled for the
 * Cloud project the key belongs to.
 */
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60_000;

/**
 * The two credential shapes Google issues, and why both are supported.
 *
 * A SERVICE ACCOUNT authenticates as itself. That is the tidier arrangement and
 * it is what this started with - until the first real install hit the reason it
 * cannot work on a consumer project: a service account there has a Drive quota
 * of ZERO bytes, so it can authenticate perfectly and still not own a single
 * file. Creating a spreadsheet means owning one, so it fails with a 403 that
 * blames permissions and means storage.
 *
 * An AUTHORIZED USER is a refresh token a person granted once. The files then
 * belong to that person's Drive, which has room, and they can see them. It
 * needs no Workspace domain and no paid plan, which is why it is the path for
 * anybody running this on a personal Google account.
 *
 * Both are read from the same place and both end up as an access token; the
 * only difference is how that token is minted.
 */
type GoogleCredentialFile = {
  type?: string;
  // Service account.
  client_email?: string;
  private_key?: string;
  project_id?: string;
  // Authorized user.
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  // Both.
  token_uri?: string;
};

type LoadedCredentials =
  | {
      kind: 'service_account';
      clientEmail: string;
      privateKey: string;
      tokenUri: string;
    }
  | {
      kind: 'authorized_user';
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      tokenUri: string;
    };

type SpreadsheetMetadataResponse = {
  spreadsheetId: string;
  properties?: {
    title?: string;
  };
  sheets?: Array<{
    properties?: {
      title?: string;
      sheetId?: number;
      index?: number;
    };
  }>;
};

type GoogleColorApi = {
  red?: number;
  green?: number;
  blue?: number;
  alpha?: number | { value?: number };
};

type GoogleBorderApi = {
  style?: string;
  color?: GoogleColorApi;
};

type GoogleTextFormatApi = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontSize?: number;
  fontFamily?: string;
  foregroundColor?: GoogleColorApi;
};

type GoogleCellFormatApi = {
  backgroundColor?: GoogleColorApi;
  textFormat?: GoogleTextFormatApi;
  horizontalAlignment?: string;
  verticalAlignment?: string;
  wrapStrategy?: string;
  borders?: {
    top?: GoogleBorderApi;
    right?: GoogleBorderApi;
    bottom?: GoogleBorderApi;
    left?: GoogleBorderApi;
  };
};

type GoogleCellDataApi = {
  formattedValue?: string;
  effectiveFormat?: GoogleCellFormatApi;
};

type GoogleRowDataApi = {
  values?: GoogleCellDataApi[];
};

type GoogleDimensionMetadataApi = {
  pixelSize?: number;
};

type GoogleGridDataApi = {
  startRow?: number;
  startColumn?: number;
  rowData?: GoogleRowDataApi[];
  rowMetadata?: GoogleDimensionMetadataApi[];
  columnMetadata?: GoogleDimensionMetadataApi[];
};

type GoogleMergeRangeApi = {
  startRowIndex?: number;
  endRowIndex?: number;
  startColumnIndex?: number;
  endColumnIndex?: number;
};

type SpreadsheetGridResponse = {
  spreadsheetId: string;
  properties?: {
    title?: string;
  };
  sheets?: Array<{
    properties?: {
      title?: string;
      sheetId?: number;
      index?: number;
    };
    merges?: GoogleMergeRangeApi[];
    data?: GoogleGridDataApi[];
  }>;
};

type GoogleApiErrorResponse = {
  error?: string | {
    message?: string;
    status?: string;
  };
  error_description?: string;
};

type GoogleErrorDetail = {
  '@type'?: string;
  reason?: string;
  domain?: string;
  metadata?: Record<string, string>;
};

type GoogleApiStructuredError = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: GoogleErrorDetail[];
    errors?: Array<{ reason?: string; message?: string; domain?: string }>;
  };
};

/**
 * What the request was trying to do, said in words, from its own shape.
 *
 * Derived here rather than passed in from every call site: the pathname already
 * says it, and threading a label through a dozen callers would be a lot of
 * churn for a string only an error message reads.
 */
function describeOperation(pathname: string, method: string): string {
  const verb = (method || 'GET').toUpperCase();
  if (pathname.startsWith('/spreadsheets') && verb === 'POST' && !pathname.includes(':')) {
    return 'create a spreadsheet';
  }
  if (pathname.includes(':batchUpdate')) return 'change a spreadsheet';
  if (pathname.includes('/values/')) return verb === 'GET' ? 'read a range' : 'write a range';
  if (pathname.includes('/permissions')) {
    if (verb === 'DELETE') return 'withdraw access to a spreadsheet';
    return verb === 'GET' ? 'read who can open a spreadsheet' : 'share a spreadsheet';
  }
  if (pathname.startsWith('/files')) return 'reach a spreadsheet in Drive';
  return 'read a spreadsheet';
}

/**
 * Turns a Google failure into something that names its own remedy.
 *
 * THE PROBLEM THIS SOLVES. Google's `error.message` for a 403 is often the bare
 * string "The caller does not have permission", which is true of every possible
 * cause and useful for none of them. The body carries the actual reason in
 * `details[].reason` - whether an API is switched off, whether the token's
 * scopes were too narrow, whether the service account's Drive is full - plus,
 * for a disabled API, the exact console URL that enables it. All of that used to
 * be parsed away and thrown on the floor.
 *
 * An unrecognised reason still yields Google's own message: the point is to add
 * the remedy where we know it, never to replace a specific message with a guess.
 */
export function describeGoogleFailure(
  status: number,
  body: GoogleApiStructuredError | null,
  operation: string
): string {
  const base = body?.error?.message?.trim() || `Google refused the request (HTTP ${status}).`;

  const details = body?.error?.details ?? [];
  const legacy = body?.error?.errors ?? [];
  const reasons = new Set(
    [...details.map((d) => d.reason), ...legacy.map((e) => e.reason)].filter(
      (reason): reason is string => Boolean(reason)
    )
  );

  const disabled = details.find((detail) => detail.reason === 'SERVICE_DISABLED');
  if (disabled) {
    const service = disabled.metadata?.service ?? 'the Google API this needs';
    const project = disabled.metadata?.consumer?.replace(/^projects\//, '') ?? 'the key\'s project';
    const url = disabled.metadata?.activationUrl;
    return (
      `${base} ${service} is switched off for project ${project}. ` +
      `Enable it, wait a minute, then try again${url ? `: ${url}` : '.'}`
    );
  }

  if (reasons.has('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
    return (
      `${base} The access token did not carry the scope needed to ${operation}. ` +
      'This app asks for the Sheets scope on Sheets calls and the Drive scope on Drive calls; ' +
      'a service account restricted by a domain-wide delegation policy can still have them stripped.'
    );
  }

  if (reasons.has('storageQuotaExceeded') || reasons.has('quotaExceeded')) {
    return (
      `${base} The service account's own Drive is full - files it creates count against its ` +
      'quota, not against any person\'s. Point the key at a shared drive, or delete spreadsheets it owns.'
    );
  }

  if (status === 403) {
    // The bare "caller does not have permission", with no reason attached. Name
    // the likeliest cause for THIS operation rather than leaving it at that.
    const hint =
      operation === 'create a spreadsheet'
        ? 'Creating a spreadsheet is a Sheets API call that makes a file in Drive, so the Drive API ' +
          'must be enabled for the same Cloud project as the credential, and the Sheets API too - ' +
          'having only one of the two on is the usual cause.'
        : operation.includes('share') || operation.includes('access') || operation.includes('open')
          ? 'Sharing is a Drive operation, so the Drive API must be enabled for the key\'s project.'
          : 'The service account may not have been given access to this spreadsheet.';
    return `${base} ${hint} Run "npm run sheets:doctor" in backend/ to see which step fails.`;
  }

  return base;
}

export type GoogleSheetTab = {
  title: string;
  index: number;
  sheetId: number;
};

export type GoogleSheetRangeSelection = {
  fromRow: number;
  toRow: number;
  fromCol: number;
  toCol: number;
  a1Notation: string;
};

export type GoogleSheetColor = {
  red: number;
  green: number;
  blue: number;
  alpha: number;
};

export type GoogleSheetBorder = {
  style: string;
  color: GoogleSheetColor;
};

export type GoogleSheetTextFormat = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  fontSize: number | null;
  fontFamily: string | null;
  foregroundColor: GoogleSheetColor | null;
};

export type GoogleSheetCellFormat = {
  backgroundColor: GoogleSheetColor | null;
  textFormat: GoogleSheetTextFormat | null;
  horizontalAlignment: string | null;
  verticalAlignment: string | null;
  wrapStrategy: string | null;
  borders: {
    top: GoogleSheetBorder | null;
    right: GoogleSheetBorder | null;
    bottom: GoogleSheetBorder | null;
    left: GoogleSheetBorder | null;
  };
};

export type GoogleSheetCell = {
  value: string;
  format: GoogleSheetCellFormat | null;
};

export type GoogleSheetMergeRange = {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
};

export type GoogleSheetsRangeRequest = {
  sheetId?: unknown;
  tabName?: unknown;
  fromRow?: unknown;
  toRow?: unknown;
  fromCol?: unknown;
  toCol?: unknown;
};

export type GoogleSheetsUpdateRangeRequest = GoogleSheetsRangeRequest & {
  values?: unknown;
};

export type GoogleSheetsRangeResponse = {
  spreadsheetId: string;
  spreadsheetTitle: string;
  tabs: GoogleSheetTab[];
  selectedTab?: string;
  range?: GoogleSheetRangeSelection;
  cells?: GoogleSheetCell[][];
  rowHeights?: number[];
  columnWidths?: number[];
  merges?: GoogleSheetMergeRange[];
  values?: string[][];
  totalRows?: number;
  totalColumns?: number;
};

export type GoogleSheetsUpdateRangeResponse = {
  spreadsheetId: string;
  spreadsheetTitle: string;
  selectedTab: string;
  updatedRange: string;
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
};

export type GoogleSheetsColumnValuesUpdate = {
  col?: unknown;
  values?: unknown;
};

export type GoogleSheetsBatchColumnUpdateRequest = {
  sheetId?: unknown;
  tabName?: unknown;
  startRow?: unknown;
  updates?: unknown;
};

export type GoogleSheetsBatchColumnUpdateResponse = {
  spreadsheetId: string;
  spreadsheetTitle: string;
  selectedTab: string;
  updatedRanges: string[];
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
};

export type GoogleSheetsSingleRowCellUpdate = {
  col?: unknown;
  value?: unknown;
};

export type GoogleSheetsSingleRowUpdateRequest = {
  sheetId?: unknown;
  tabName?: unknown;
  row?: unknown;
  updates?: unknown;
};

export type GoogleSheetsSingleRowUpdateResponse = {
  spreadsheetId: string;
  spreadsheetTitle: string;
  selectedTab: string;
  row: number;
  updatedRanges: string[];
  updatedColumns: number;
  updatedCells: number;
};

export type GoogleSheetsColumnValuesRequest = {
  sheetId?: unknown;
  tabName?: unknown;
  col?: unknown;
};

export type GoogleSheetsColumnValuesResponse = {
  spreadsheetId: string;
  spreadsheetTitle: string;
  selectedTab: string;
  column: number;
  values: string[];
};

type CachedAccessToken = {
  token: string;
  expiresAt: number;
};

type GoogleSheetsUpdateValuesResponse = {
  updatedRange?: string;
  updatedRows?: number;
  updatedColumns?: number;
  updatedCells?: number;
};

type GoogleSheetsBatchUpdateValuesResponse = {
  totalUpdatedRows?: number;
  totalUpdatedColumns?: number;
  totalUpdatedCells?: number;
  responses?: Array<{
    updatedRange?: string;
    updatedRows?: number;
    updatedColumns?: number;
    updatedCells?: number;
  }>;
};

/**
 * One entry per scope. Keyed rather than single, because the Sheets token and
 * the Drive token are now different tokens and a shared slot would have each
 * call evicting the other's.
 */
const cachedAccessTokens = new Map<string, CachedAccessToken>();

let warnedAboutExtraKeys = false;
let warnedAboutMissingExplicitPath = false;

/**
 * Which credential the last load actually used, for error messages.
 *
 * Kept because a 403 says nothing about WHICH key was refused, and the single
 * most common cause of one is a key that is not the one you just installed.
 */
let credentialSummary = '';

export function describeCredentialInUse(): string {
  return credentialSummary;
}

export class GoogleSheetsRequestError extends PublicError {
  statusCode: number;

  /**
   * What to tell the OPERATOR, kept apart from what anyone may read.
   *
   * The useful thing to say about a refused credential names a command to run
   * in `backend/`, or an environment variable, or a file on the server's disk;
   * the useful thing to say about a refused call is Google's own reason, the
   * Cloud project it was refused in and the credential that asked. That is
   * exactly right in a log and exactly wrong on a page: `/api/sheet` is behind
   * `requireAccount`, not `requireAdmin`, so every account holder opening their
   * own Account page was being handed `Run "npm run sheets:login" in backend/`
   * about a server they do not administer, along with the layout of its
   * directories.
   *
   * So `message` says only what the reader can act on - which is what makes
   * this a `PublicError` - and the rest goes here. `publicFailure` gives it to
   * an administrator's response and the log, and to nobody else.
   */
  declare readonly detail?: string;

  /**
   * Google's own status, when `statusCode` had to differ from it.
   *
   * A 401 from Google means THIS SERVER's credential was refused. A 401 from
   * this API means the CALLER's session is gone, and the frontend acts on that
   * by signing them out - so passing Google's through, which the routes do,
   * signed out every account holder who opened a page while the server's Google
   * sign-in was broken, and they never saw the sentence saying so. It becomes a
   * 502, the upstream refusing us, and the original is kept here for the doctor.
   */
  upstreamStatus?: number;

  constructor(statusCode: number, message: string, detail?: string) {
    const status = statusCode === 401 ? 502 : statusCode;
    super(message, { status, ...(detail ? { detail } : {}) });
    this.name = 'GoogleSheetsRequestError';
    this.statusCode = status;
    if (statusCode !== status) this.upstreamStatus = statusCode;
  }
}

/**
 * What anybody may be told when Google refuses a Sheets or Drive call, and the
 * status this API answers with.
 *
 * Google's own text - and `describeGoogleFailure`'s remedies on top of it -
 * names the Cloud project, the API to enable, the credential that asked and a
 * command to run; it is the `detail`. What is left for the reader depends only
 * on what they could do: a sheet or tab that is not there is theirs to check, a
 * busy Google is theirs to wait out, and everything else is the
 * administrator's. Google's 403 is never passed through as ours - it is the
 * server that was refused, not the caller.
 */
function publicGoogleRefusal(status: number): { status: number; message: string } {
  if (status === 404) {
    return {
      status: 404,
      message: 'That spreadsheet or tab could not be found. Check the sheet link, or contact your administrator.',
    };
  }
  if (status === 429) {
    return { status: 429, message: 'Google Sheets is busy right now. Please try again in a few minutes.' };
  }
  if (status === 400) {
    return {
      status: 400,
      message:
        'Google Sheets could not complete that request. Check the sheet and the rows you chose, ' +
        'or contact your administrator.',
    };
  }
  if (status === 403) {
    return {
      status: 502,
      message: 'This server cannot open that spreadsheet. Check the sheet link, or contact your administrator.',
    };
  }
  return {
    status: 502,
    message: 'Google Sheets could not complete that request. Please try again, or contact your administrator.',
  };
}

/** A refused Sheets or Drive call, split into what anybody may read and the operator's half. */
function googleRefusal(status: number, operatorText: string): GoogleSheetsRequestError {
  const refusal = publicGoogleRefusal(status);
  const error = new GoogleSheetsRequestError(refusal.status, refusal.message, operatorText);
  if (refusal.status !== status) error.upstreamStatus = status;
  return error;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function normalizePrivateKey(privateKey: string): string {
  return privateKey.includes('\\n') ? privateKey.replace(/\\n/g, '\n') : privateKey;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * The credential filenames, in the order a tie is broken.
 *
 * User credentials come first deliberately. Somebody who has both files has
 * usually just added the second because the first could not create anything -
 * a service account on a consumer project owns no storage - so preferring the
 * one that works is the answer they were reaching for. `GOOGLE_CREDENTIALS_PATH`
 * overrides the lot when the guess is wrong.
 */
const CREDENTIAL_FILENAMES = ['google-oauth-credentials.json', 'service-account-key.json'];

/**
 * Which variable names the credential, if one does - the newer name winning.
 *
 * Exported so `sheets:login` names the same one when it explains why the app
 * will not read the file it just saved, rather than working it out again.
 */
export function credentialPathVariable(
  env: NodeJS.ProcessEnv = process.env
): '' | 'GOOGLE_CREDENTIALS_PATH' | 'GOOGLE_SERVICE_ACCOUNT_KEY_PATH' {
  if (env.GOOGLE_CREDENTIALS_PATH?.trim()) return 'GOOGLE_CREDENTIALS_PATH';
  if (env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH?.trim()) return 'GOOGLE_SERVICE_ACCOUNT_KEY_PATH';
  return '';
}

export async function resolveCredentialPath(): Promise<string> {
  const explicitVariable = credentialPathVariable();
  const explicitPath = explicitVariable ? process.env[explicitVariable]!.trim() : '';
  const cwd = process.cwd();
  const directories = [cwd, path.join(cwd, 'backend'), path.join(__dirname, '../..'), path.join(__dirname, '../../..')];
  const candidates = [
    explicitPath,
    ...CREDENTIAL_FILENAMES.flatMap((name) => directories.map((dir) => path.join(dir, name))),
  ].filter((value): value is string => Boolean(value));

  // Deduplicated by resolved path, and case-insensitively because Windows
  // treats paths that way. Several candidates point at the SAME file whenever
  // the process runs from backend/ - `<cwd>/service-account-key.json` and
  // `<dist>/../../service-account-key.json` are then one file by two routes,
  // and reporting it as two keys is a warning about a problem nobody has.
  const present: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    if (await fileExists(resolved)) {
      seen.add(key);
      present.push(resolved);
    }
  }

  /**
   * A path that was asked for and is not there is said out loud.
   *
   * It used to drop out of the candidate list like any other missing file, so
   * the search quietly answered with something else - the stale-variable trap
   * the warning below describes, minus the warning. A relative value resolves
   * from the directory the process started in, which is `backend/` under
   * `npm run --prefix backend` and the repository root under
   * `node backend/dist/index.js`, so the same `.env` can find the file from one
   * and not the other. Warned rather than thrown: falling back is what an
   * install that works today depends on.
   */
  if (explicitPath && !present.includes(path.resolve(explicitPath)) && !warnedAboutMissingExplicitPath) {
    warnedAboutMissingExplicitPath = true;
    console.warn(
      `[sheets] ${explicitVariable} names ${path.resolve(explicitPath)}, which does not exist` +
        `${path.isAbsolute(explicitPath) ? '' : ` (a relative path resolves from ${cwd})`}. ` +
        'Searching the default locations instead.'
    );
  }

  if (present.length > 0) {
    /**
     * More than one key on disk is a trap, and a quiet one.
     *
     * Five paths are searched and the FIRST wins. Somebody who replaces the key
     * in `backend/` while an older one sits at the repo root - or who leaves
     * GOOGLE_SERVICE_ACCOUNT_KEY_PATH pointing at the old file - gets the old
     * credential with no sign that the new one was ignored. The failure that
     * follows is a 403 about permissions, which sends them looking at the new
     * project's API settings rather than at which key is in use.
     */
    if (present.length > 1 && !warnedAboutExtraKeys) {
      warnedAboutExtraKeys = true;
      // "Set GOOGLE_CREDENTIALS_PATH" is no advice to somebody whose variable
      // is the reason this file won. And the REPOSITORY .env, specifically:
      // the loader copies every assignment in it over the real environment,
      // empty ones included, so the shipped `GOOGLE_CREDENTIALS_PATH=` line
      // silently cancels the same variable set in a shell.
      const chosenExplicitly = Boolean(explicitPath) && present[0] === path.resolve(explicitPath);
      console.warn(
        `[sheets] ${present.length} Google credential files were found and only the first is used.\n` +
          present.map((file, index) => `         ${index === 0 ? 'USING  ' : 'ignored'} ${file}`).join('\n') +
          (chosenExplicitly
            ? `\n         It is used because ${explicitVariable} names it; the others are ignored.`
            : '\n         Delete the ones you do not want, or set GOOGLE_CREDENTIALS_PATH in the repository ' +
              '.env to be explicit.')
      );
    }
    return present[0];
  }

  throw new GoogleSheetsRequestError(
    500,
    'Google Sheets is not set up on this server yet.',
    'No Google credentials were found. Run "npm run sheets:login" in backend/ to sign in with ' +
      'your own Google account, or place a service account key at ' +
      'backend/service-account-key.json. GOOGLE_CREDENTIALS_PATH overrides where to look.'
  );
}

/**
 * The credential's own identity, for the doctor to print before it tries anything.
 *
 * Read through the same loader every real call uses, so a file the app would
 * refuse fails HERE, with the loader's own message. Classifying it by the
 * presence of `refresh_token` alone let a downloaded OAuth client - only half
 * of a credential - pass this step as "service account (missing)", and the
 * real complaint then surfaced one step later under a remedy about revoked
 * keys.
 */
export async function describeServiceAccount(): Promise<{
  path: string;
  kind: LoadedCredentials['kind'];
  identity: string;
  projectId: string;
}> {
  const filePath = await resolveCredentialPath();
  const credentials = await loadGoogleCredentials();
  const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as GoogleCredentialFile;
  return {
    path: filePath,
    kind: credentials.kind,
    identity: credentials.kind === 'authorized_user' ? credentials.clientId : credentials.clientEmail,
    projectId: parsed.project_id ?? '(not in this file)',
  };
}

/** A raw Drive GET, so the doctor can ask Drive about itself. */
export async function driveAbout(): Promise<{
  user?: { emailAddress?: string };
  storageQuota?: { limit?: string; usage?: string };
}> {
  return googleDriveFetch('/about?fields=user(emailAddress),storageQuota(limit,usage)');
}

/** Removes a spreadsheet outright. Only the doctor's throwaway uses this. */
export async function deleteSpreadsheet(spreadsheetId: string): Promise<void> {
  await googleDriveFetch(`/files/${encodeURIComponent(spreadsheetId)}?supportsAllDrives=true`, {
    method: 'DELETE',
  });
}

/**
 * Whether this install has a service-account key at all.
 *
 * Its own predicate so callers can answer "not configured" as a fact rather
 * than by catching the 500 that every sheets call would otherwise throw. A
 * missing key is a deployment that has not set sheets up yet, not a failure.
 */
export async function isGoogleSheetsConfigured(): Promise<boolean> {
  try {
    await resolveCredentialPath();
    return true;
  } catch {
    return false;
  }
}

async function loadGoogleCredentials(): Promise<LoadedCredentials> {
  const filePath = await resolveCredentialPath();
  const unusable =
    "This server's Google credential file cannot be used, so Sheets and Drive are unavailable " +
    'until an administrator fixes it.';

  // Caught, because Node's own error names the path - and a file sheets:login
  // wrote owner-only is unreadable to a service running as another user.
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    throw new GoogleSheetsRequestError(
      500,
      unusable,
      `${filePath} could not be read: ${error instanceof Error ? error.message : String(error)}. ` +
        'Check it is a file, and readable by the user the backend runs as.'
    );
  }

  /*
   * Each refusal here names a file on the server's disk and a command to run
   * there, so that half is `detail` - the same split getAccessToken makes, and
   * for the same reason: these reach account holders' pages too.
   */
  let parsed: GoogleCredentialFile;
  try {
    parsed = JSON.parse(raw) as GoogleCredentialFile;
  } catch {
    throw new GoogleSheetsRequestError(500, unusable, `${filePath} is not valid JSON.`);
  }

  const tokenUri = parsed.token_uri?.trim() || DEFAULT_TOKEN_URI;
  const refreshToken = parsed.refresh_token?.trim();

  // Recognised by what it CONTAINS rather than by `type`, because a file
  // written by hand or by gcloud does not always carry the field.
  if (refreshToken) {
    const clientId = parsed.client_id?.trim();
    const clientSecret = parsed.client_secret?.trim();
    if (!clientId || !clientSecret) {
      throw new GoogleSheetsRequestError(
        500,
        unusable,
        `${filePath} has a refresh_token but no client_id and client_secret to use it with. ` +
          'Run "npm run sheets:login" in backend/ to make a complete one.'
      );
    }

    credentialSummary = `user credentials ${filePath} (OAuth client ${clientId})`;
    return { kind: 'authorized_user', clientId, clientSecret, refreshToken, tokenUri };
  }

  const clientEmail = parsed.client_email?.trim();
  const privateKey = parsed.private_key?.trim();

  if (!clientEmail || !privateKey) {
    throw new GoogleSheetsRequestError(
      500,
      unusable,
      `${filePath} is not a credential this app can use. Expected either a service account key ` +
        '(client_email and private_key) or user credentials (client_id, client_secret and ' +
        'refresh_token). If this is an OAuth client file you just downloaded, it is only half of ' +
        'the second - run "npm run sheets:login" in backend/ to finish it.'
    );
  }

  credentialSummary =
    `key ${filePath} (service account ${clientEmail}` +
    `${parsed.project_id ? `, project ${parsed.project_id}` : ''})`;

  return {
    kind: 'service_account',
    clientEmail,
    privateKey: normalizePrivateKey(privateKey),
    tokenUri,
  };
}

/**
 * Names the credential on a refusal.
 *
 * A 403 reports what Google would not do, never whose key asked. When somebody
 * has just replaced a key and the error has not changed, that is exactly the
 * missing fact: the message either names the project they just set up, or it
 * names the old one and the answer is that the new key is not the one in use.
 */
function whoAsked(status: number): string {
  if (status !== 401 && status !== 403) return '';
  return credentialSummary ? ` Asked with ${credentialSummary}.` : '';
}

function buildJwtAssertion(
  credentials: Extract<LoadedCredentials, { kind: 'service_account' }>,
  scope: string
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: credentials.clientEmail,
    scope,
    aud: credentials.tokenUri,
    iat: now,
    exp: now + 3600,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsignedToken), credentials.privateKey).toString('base64url');

  return `${unsignedToken}.${signature}`;
}

export async function getAccessToken(scope: string): Promise<string> {
  const cached = cachedAccessTokens.get(scope);
  if (cached && cached.expiresAt - ACCESS_TOKEN_REFRESH_BUFFER_MS > Date.now()) {
    return cached.token;
  }

  const credentials = await loadGoogleCredentials();

  /**
   * A service account asks for the scope it needs; a person already granted it.
   *
   * The scopes on a refresh token are fixed at consent time and cannot be
   * narrowed per call, so the per-API split that keeps a Drive problem away
   * from Sheets work only applies to the first shape. For the second, both
   * scope keys end up holding the same token, which is correct and costs one
   * extra cache entry.
   */
  const body =
    credentials.kind === 'service_account'
      ? new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: buildJwtAssertion(credentials, scope),
        })
      : new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          refresh_token: credentials.refreshToken,
        });

  const response = await fetch(credentials.tokenUri, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    let errorMessage = 'Failed to authenticate with Google Sheets.';
    // Google's machine-readable code (`invalid_grant`, `deleted_client`...),
    // classified on directly rather than searched for in the joined text.
    let googleCode = '';
    try {
      const errorBody = (await response.json()) as GoogleApiErrorResponse;
      if (typeof errorBody.error === 'string') googleCode = errorBody.error.trim().toLowerCase();
      if (typeof errorBody.error === 'string' && errorBody.error_description) {
        errorMessage = `${errorBody.error}: ${errorBody.error_description}`;
      } else if (typeof errorBody.error === 'object' && errorBody.error?.message) {
        errorMessage = errorBody.error.message;
      }
    } catch {
      // Ignore JSON parsing failures and use the fallback message.
    }
    /*
     * Split in two: what anybody may read, and what only an operator should.
     *
     * Everything below that names a command, a file on disk or an environment
     * variable goes into `detail`. `message` keeps the diagnosis, because an
     * account holder seeing "the server's Google sign-in has expired" at least
     * knows to stop retrying and tell somebody.
     */
    let operatorDetail: string | undefined;
    /*
     * Google's own words, kept for the operator.
     *
     * The rewrites below replace them in `message`, and before this nothing
     * carried them anywhere - so no log said "Token has been expired or
     * revoked", which is the exact string the README's Troubleshooting row and
     * every search engine are keyed on.
     */
    const googleSaid = ` Google said: "${errorMessage}".`;

    if (errorMessage.toLowerCase().includes('invalid_grant')) {
      errorMessage =
        credentials.kind === 'authorized_user'
          ? "This server's Google sign-in is no longer valid, so Sheets and Drive are " +
            'unavailable until an administrator renews it.'
          : "This server's Google service account key was rejected, so Sheets and Drive are " +
            'unavailable until an administrator replaces it.';
      operatorDetail =
        credentials.kind === 'authorized_user'
          ? 'The saved consent is no longer valid - it was revoked, or it expired because the ' +
            'OAuth consent screen is still in Testing mode, where refresh tokens last seven days. ' +
            'Publish the consent screen first (Cloud console -> Google Auth Platform -> Audience -> ' +
            'Publish app), because a consent given while it is in Testing keeps the seven-day ' +
            'limit; then run "npm run sheets:login" in backend/ again.'
          : 'The service account key was rejected. It may have been deleted or revoked; issue a ' +
            'new one. A clock more than a few minutes out will also do this.';
      operatorDetail += googleSaid;
    }
    /*
     * The OTHER half of a saved sign-in going bad: the token is fine but the
     * OAuth client it was issued to is not. Google has three codes for that -
     * `deleted_client` (deleted by hand, or by Google for going unused; it can
     * be restored for 30 days), `disabled_client`, and `invalid_client` (an
     * unknown client or a reset secret) - and running sheets:login again cannot
     * help on its own: it would re-use the same dead client out of the same file.
     */
    const clientRefused =
      /^(invalid|deleted|disabled)_client$/.test(googleCode) ||
      /\b(invalid|deleted|disabled)_client\b/i.test(errorMessage);
    if (credentials.kind === 'authorized_user' && clientRefused) {
      errorMessage =
        "This server's Google sign-in uses an OAuth client Google no longer accepts, so Sheets and " +
        'Drive are unavailable until an administrator replaces it.';
      const why = googleCode.startsWith('deleted')
        ? 'The OAuth client was deleted - by hand, or by Google for going unused. It can be ' +
          'restored for 30 days under Cloud console -> Google Auth Platform -> Clients; after that, '
        : googleCode.startsWith('disabled')
          ? 'The OAuth client was disabled; the Cloud console says why. Re-enable it there, or '
          : 'Google refused the OAuth client itself - it does not exist, or its secret was reset. ' +
            'To replace it, ';
      operatorDetail =
        why +
        'create a new Desktop app OAuth client, download its JSON into backend/, and run ' +
        '"npm run sheets:login -- --client <that file>" in backend/. Naming the file matters: ' +
        'without it an older client_secret*.json left in backend/ can be picked instead.' +
        googleSaid;
    }
    if (errorMessage.toLowerCase().includes('user not found')) {
      errorMessage =
        "This server's Google service account was not recognized, so Sheets and Drive are " +
        'unavailable until an administrator replaces its key.';
      operatorDetail =
        `Google did not recognize ${
          credentials.kind === 'service_account' ? credentials.clientEmail : '(user credentials)'
        }. ` +
        'This usually means the JSON key belongs to a deleted or disabled service account, or the key file does not match the live account. ' +
        'Create a new key for the current service account and replace backend/service-account-key.json.';
    }
    if (response.status === 429) {
      // The token endpoint being busy is the one refusal here that waiting
      // fixes, and the only one the reader is told to wait out.
      operatorDetail = `The token request was rate-limited.${googleSaid}`;
      errorMessage = publicGoogleRefusal(429).message;
    } else if (!operatorDetail) {
      // Nothing above recognised it, so `errorMessage` is still Google's raw
      // OAuth text. That is the operator's to read, not an account holder's.
      operatorDetail = `The token request was refused.${googleSaid}`;
      errorMessage =
        "This server's Google sign-in did not work, so Sheets and Drive are unavailable until an " +
        'administrator fixes it.';
    }
    // Any other refusal at the token endpoint is THIS SERVER's credential
    // failing, whatever status Google chose for it, so it is a 502 - never
    // Google's 400, 403 or 404 passed through as if the caller's request were
    // at fault. Google's own status is kept for the doctor.
    const status = response.status === 429 ? 429 : 502;
    const refused = new GoogleSheetsRequestError(status, errorMessage, operatorDetail);
    if (response.status !== status) refused.upstreamStatus = response.status;
    throw refused;
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token || !data.expires_in) {
    throw new GoogleSheetsRequestError(500, 'Google Sheets authentication response did not include an access token.');
  }

  const minted = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  cachedAccessTokens.set(scope, minted);

  return minted.token;
}

/**
 * How a request Google answered with 429 is tried again: exponential backoff
 * with jitter, capped, then given up on.
 *
 * Google's Sheets quota is per project AND per user, and every account of this
 * install is the same "user" - the one server credential - so a reporter run,
 * a filter and a few write-backs at once spend one shared per-minute budget.
 * Google's own advice for a 429 is to wait with an exponentially growing,
 * randomised delay, and a short wait almost always clears it. Its
 * `Retry-After`, when it sends one, is honoured up to the cap.
 *
 * Constants rather than settings: nothing about an install changes what
 * Google's quota windows are. Replaceable for the tests, which must not wait.
 */
export type SheetsRetryPolicy = {
  /** Retries after the first attempt; 0 disables retrying. */
  maxRetries: number;
  /** The first wait, doubled each retry. */
  baseDelayMs: number;
  /** No single wait is longer than this. */
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  /** 0 <= random() < 1, for the jitter. */
  random: () => number;
};

const DEFAULT_RETRY_POLICY: SheetsRetryPolicy = {
  maxRetries: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 32_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

let retryPolicy: SheetsRetryPolicy = DEFAULT_RETRY_POLICY;

/** Replaces the 429 policy; call with no argument to put the real one back. */
export function setSheetsRetryPolicyForTests(next?: Partial<SheetsRetryPolicy>): void {
  retryPolicy = next ? { ...DEFAULT_RETRY_POLICY, ...next } : DEFAULT_RETRY_POLICY;
}

/**
 * The wait before retry number `attempt` (1-based): "full jitter" over an
 * exponentially growing window, or Google's own Retry-After when it is longer,
 * never past the cap.
 */
export function sheetsRetryDelayMs(attempt: number, retryAfterHeader: string | null, policy = retryPolicy): number {
  const window = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  const jittered = Math.round(window / 2 + policy.random() * (window / 2));
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
  const asked = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0;
  return Math.min(policy.maxDelayMs, Math.max(jittered, asked));
}

/**
 * One fetch, retried on 429 per the policy. Every Sheets and Drive call goes
 * through this, so the backoff is the same wherever the quota runs out.
 */
async function fetchWithBackoff(url: string, init: RequestInit | undefined): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, init);
    if (response.status !== 429 || attempt >= retryPolicy.maxRetries) return response;
    const waitMs = sheetsRetryDelayMs(attempt + 1, response.headers.get('retry-after'));
    console.warn(
      `[sheets] Google answered 429 (quota) to ${describeOperation(
        new URL(url).pathname.replace(/^\/(v4|drive\/v3)/, ''),
        String(init?.method ?? 'GET')
      )}; ` +
        `retry ${attempt + 1} of ${retryPolicy.maxRetries} in ${waitMs}ms.`
    );
    // The body is not read; let it go before waiting.
    await response.body?.cancel().catch(() => undefined);
    await retryPolicy.sleep(waitMs);
  }
}

async function googleSheetsFetch<T>(pathname: string, init?: RequestInit, hasRetried = false): Promise<T> {
  const accessToken = await getAccessToken(SHEETS_SCOPE);
  const response = await fetchWithBackoff(`${SHEETS_API_BASE}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
  });

  if (response.status === 401 && !hasRetried) {
    cachedAccessTokens.delete(SHEETS_SCOPE);
    return googleSheetsFetch<T>(pathname, init, true);
  }

  if (!response.ok) {
    throw googleRefusal(
      response.status,
      describeGoogleFailure(
        response.status,
        await readErrorBody(response),
        describeOperation(pathname, String(init?.method ?? 'GET'))
      ) + whoAsked(response.status)
    );
  }

  return response.json() as Promise<T>;
}

/** Google's error body, or null when it sent something that is not one. */
async function readErrorBody(response: Response): Promise<GoogleApiStructuredError | null> {
  try {
    return (await response.json()) as GoogleApiStructuredError;
  } catch {
    return null;
  }
}

/**
 * The same call shape against Drive rather than Sheets.
 *
 * A separate function rather than a base-url parameter on the one above,
 * because everything else about them is the same and an accidental Sheets path
 * sent to Drive returns a 404 that reads like a missing file.
 */
async function googleDriveFetch<T>(pathname: string, init?: RequestInit, hasRetried = false): Promise<T> {
  const accessToken = await getAccessToken(DRIVE_SCOPE);
  const response = await fetchWithBackoff(`${DRIVE_API_BASE}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
  });

  if (response.status === 401 && !hasRetried) {
    cachedAccessTokens.delete(DRIVE_SCOPE);
    return googleDriveFetch<T>(pathname, init, true);
  }

  if (!response.ok) {
    throw googleRefusal(
      response.status,
      describeGoogleFailure(
        response.status,
        await readErrorBody(response),
        describeOperation(pathname, String(init?.method ?? 'GET'))
      ) + whoAsked(response.status)
    );
  }

  // A 204 has no body, which `response.json()` would throw on.
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

type GoogleSheetsValuesResponse = {
  values?: Array<Array<string | number | boolean | null>>;
};

function requireNonEmptyString(fieldName: string, value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GoogleSheetsRequestError(400, `${fieldName} is required.`);
  }
  return value.trim();
}

function toPositiveInteger(fieldName: string, value: unknown): number {
  const numeric = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof numeric !== 'number' || !Number.isInteger(numeric) || numeric <= 0) {
    throw new GoogleSheetsRequestError(400, `${fieldName} must be a positive whole number.`);
  }
  return numeric;
}

function hasRangeInput(input: GoogleSheetsRangeRequest): boolean {
  return [input.fromRow, input.toRow, input.fromCol, input.toCol].some(
    (value) => value !== undefined && value !== null && value !== ''
  );
}

/** 1 -> `A`, 27 -> `AA`. Spreadsheet column letters, for building an A1 range. */
export function toColumnLetters(columnNumber: number): string {
  let current = columnNumber;
  let letters = '';

  while (current > 0) {
    const remainder = (current - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    current = Math.floor((current - 1) / 26);
  }

  return letters;
}

function quoteSheetTitle(sheetTitle: string): string {
  return `'${sheetTitle.replace(/'/g, "''")}'`;
}

function buildA1Notation(tabName: string, fromRow: number, toRow: number, fromCol: number, toCol: number): string {
  return `${quoteSheetTitle(tabName)}!${toColumnLetters(fromCol)}${fromRow}:${toColumnLetters(toCol)}${toRow}`;
}

function normalizeTabs(metadata: SpreadsheetMetadataResponse): GoogleSheetTab[] {
  return (metadata.sheets ?? [])
    .map((sheet) => ({
      title: sheet.properties?.title ?? '',
      index: sheet.properties?.index ?? 0,
      sheetId: sheet.properties?.sheetId ?? 0,
    }))
    .filter((sheet) => Boolean(sheet.title))
    .sort((left, right) => left.index - right.index);
}

function padValues(values: string[][], rowCount: number, columnCount: number): string[][] {
  return Array.from({ length: rowCount }, (_, rowIndex) =>
    Array.from({ length: columnCount }, (_, columnIndex) => values[rowIndex]?.[columnIndex] ?? '')
  );
}

function normalizeAlpha(alpha: GoogleColorApi['alpha']): number {
  if (typeof alpha === 'number' && Number.isFinite(alpha)) return alpha;
  if (alpha && typeof alpha === 'object' && typeof alpha.value === 'number' && Number.isFinite(alpha.value)) {
    return alpha.value;
  }
  return 1;
}

function normalizeColor(color?: GoogleColorApi): GoogleSheetColor | null {
  if (!color) return null;
  return {
    red: typeof color.red === 'number' ? color.red : 0,
    green: typeof color.green === 'number' ? color.green : 0,
    blue: typeof color.blue === 'number' ? color.blue : 0,
    alpha: normalizeAlpha(color.alpha),
  };
}

function normalizeBorder(border?: GoogleBorderApi): GoogleSheetBorder | null {
  if (!border?.style || border.style === 'NONE') return null;
  return {
    style: border.style,
    color: normalizeColor(border.color) ?? { red: 0.85, green: 0.88, blue: 0.92, alpha: 1 },
  };
}

function normalizeTextFormat(textFormat?: GoogleTextFormatApi): GoogleSheetTextFormat | null {
  if (!textFormat) return null;
  return {
    bold: Boolean(textFormat.bold),
    italic: Boolean(textFormat.italic),
    underline: Boolean(textFormat.underline),
    strikethrough: Boolean(textFormat.strikethrough),
    fontSize: typeof textFormat.fontSize === 'number' ? textFormat.fontSize : null,
    fontFamily: textFormat.fontFamily ?? null,
    foregroundColor: normalizeColor(textFormat.foregroundColor),
  };
}

function normalizeCellFormat(format?: GoogleCellFormatApi): GoogleSheetCellFormat | null {
  if (!format) return null;
  return {
    backgroundColor: normalizeColor(format.backgroundColor),
    textFormat: normalizeTextFormat(format.textFormat),
    horizontalAlignment: format.horizontalAlignment ?? null,
    verticalAlignment: format.verticalAlignment ?? null,
    wrapStrategy: format.wrapStrategy ?? null,
    borders: {
      top: normalizeBorder(format.borders?.top),
      right: normalizeBorder(format.borders?.right),
      bottom: normalizeBorder(format.borders?.bottom),
      left: normalizeBorder(format.borders?.left),
    },
  };
}

function buildEmptyCells(rowCount: number, columnCount: number): GoogleSheetCell[][] {
  return Array.from({ length: rowCount }, () =>
    Array.from({ length: columnCount }, () => ({
      value: '',
      format: null,
    }))
  );
}

function clampPixelSize(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeMerges(
  merges: GoogleMergeRangeApi[] | undefined,
  fromRow: number,
  toRow: number,
  fromCol: number,
  toCol: number
): GoogleSheetMergeRange[] {
  const requestStartRow = fromRow - 1;
  const requestEndRow = toRow;
  const requestStartCol = fromCol - 1;
  const requestEndCol = toCol;

  return (merges ?? [])
    .map((merge): GoogleSheetMergeRange | null => {
      const startRow = typeof merge.startRowIndex === 'number' ? merge.startRowIndex : 0;
      const endRow = typeof merge.endRowIndex === 'number' ? merge.endRowIndex : startRow;
      const startCol = typeof merge.startColumnIndex === 'number' ? merge.startColumnIndex : 0;
      const endCol = typeof merge.endColumnIndex === 'number' ? merge.endColumnIndex : startCol;

      const clippedStartRow = Math.max(startRow, requestStartRow);
      const clippedEndRow = Math.min(endRow, requestEndRow);
      const clippedStartCol = Math.max(startCol, requestStartCol);
      const clippedEndCol = Math.min(endCol, requestEndCol);

      if (clippedStartRow >= clippedEndRow || clippedStartCol >= clippedEndCol) {
        return null;
      }

      return {
        startRow: clippedStartRow - requestStartRow,
        endRow: clippedEndRow - requestStartRow,
        startCol: clippedStartCol - requestStartCol,
        endCol: clippedEndCol - requestStartCol,
      };
    })
    .filter((merge): merge is GoogleSheetMergeRange => Boolean(merge));
}

function normalizeUpdateValues(
  values: unknown,
  rowCount: number,
  columnCount: number
): string[][] {
  if (!Array.isArray(values)) {
    throw new GoogleSheetsRequestError(400, 'values must be a two-dimensional array.');
  }

  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const sourceRow = values[rowIndex];
    const normalizedSourceRow = Array.isArray(sourceRow) ? sourceRow : [];

    return Array.from({ length: columnCount }, (_, columnIndex) => {
      const cellValue = normalizedSourceRow[columnIndex];
      if (cellValue === null || cellValue === undefined) return '';
      if (typeof cellValue === 'string') return cellValue;
      if (typeof cellValue === 'number' || typeof cellValue === 'boolean') return String(cellValue);
      throw new GoogleSheetsRequestError(400, 'values must contain only strings, numbers, booleans, or empty cells.');
    });
  });
}

function normalizeColumnUpdateValues(values: unknown): string[] {
  if (!Array.isArray(values)) {
    throw new GoogleSheetsRequestError(400, 'Column update values must be an array.');
  }

  return values.map((value) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    throw new GoogleSheetsRequestError(400, 'Column update values must contain only strings, numbers, booleans, or empty cells.');
  });
}

function normalizeSingleCellValue(fieldName: string, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new GoogleSheetsRequestError(400, `${fieldName} must be a string, number, boolean, or empty value.`);
}

async function getSpreadsheetMetadata(sheetId: string): Promise<GoogleSheetsRangeResponse> {
  const metadata = await googleSheetsFetch<SpreadsheetMetadataResponse>(
    `/spreadsheets/${encodeURIComponent(sheetId)}?fields=spreadsheetId,properties(title),sheets(properties(title,sheetId,index))`
  );

  return {
    spreadsheetId: metadata.spreadsheetId,
    spreadsheetTitle: metadata.properties?.title?.trim() || sheetId,
    tabs: normalizeTabs(metadata),
  };
}

export async function fetchGoogleSheetsRange(input: GoogleSheetsRangeRequest): Promise<GoogleSheetsRangeResponse> {
  const sheetId = requireNonEmptyString('sheetId', input.sheetId);
  const metadata = await getSpreadsheetMetadata(sheetId);

  if (!hasRangeInput(input)) {
    return metadata;
  }

  const tabName = requireNonEmptyString('tabName', input.tabName);
  const fromRow = toPositiveInteger('fromRow', input.fromRow);
  const toRow = toPositiveInteger('toRow', input.toRow);
  const fromCol = toPositiveInteger('fromCol', input.fromCol);
  const toCol = toPositiveInteger('toCol', input.toCol);

  if (fromRow > toRow) {
    throw new GoogleSheetsRequestError(400, 'fromRow must be less than or equal to toRow.');
  }

  if (fromCol > toCol) {
    throw new GoogleSheetsRequestError(400, 'fromCol must be less than or equal to toCol.');
  }

  const matchingTab = metadata.tabs.find((tab) => tab.title === tabName);
  if (!matchingTab) {
    throw new GoogleSheetsRequestError(400, `Tab "${tabName}" was not found in the spreadsheet.`);
  }

  const a1Notation = buildA1Notation(tabName, fromRow, toRow, fromCol, toCol);
  const requestedRowCount = toRow - fromRow + 1;
  const requestedColumnCount = toCol - fromCol + 1;
  const gridResponse = await googleSheetsFetch<SpreadsheetGridResponse>(
    `/spreadsheets/${encodeURIComponent(sheetId)}?includeGridData=true&ranges=${encodeURIComponent(a1Notation)}&fields=${encodeURIComponent(
      'spreadsheetId,properties(title),sheets(properties(title,sheetId,index),merges,data(startRow,startColumn,rowMetadata(pixelSize),columnMetadata(pixelSize),rowData(values(formattedValue,effectiveFormat(backgroundColor,textFormat(bold,italic,underline,strikethrough,fontSize,fontFamily,foregroundColor),horizontalAlignment,verticalAlignment,wrapStrategy,borders(top(style,color),right(style,color),bottom(style,color),left(style,color)))))))'
    )}`
  );
  const selectedSheet = gridResponse.sheets?.find((sheet) => sheet.properties?.title === matchingTab.title) ?? gridResponse.sheets?.[0];
  const gridData = selectedSheet?.data?.[0];
  const cells = buildEmptyCells(requestedRowCount, requestedColumnCount);

  for (let rowIndex = 0; rowIndex < requestedRowCount; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < requestedColumnCount; columnIndex += 1) {
      const sourceCell = gridData?.rowData?.[rowIndex]?.values?.[columnIndex];
      cells[rowIndex][columnIndex] = {
        value: sourceCell?.formattedValue ?? '',
        format: normalizeCellFormat(sourceCell?.effectiveFormat),
      };
    }
  }

  const rowHeights = Array.from({ length: requestedRowCount }, (_, rowIndex) =>
    clampPixelSize(gridData?.rowMetadata?.[rowIndex]?.pixelSize, 28, 24, 120)
  );
  const columnWidths = Array.from({ length: requestedColumnCount }, (_, columnIndex) =>
    clampPixelSize(gridData?.columnMetadata?.[columnIndex]?.pixelSize, 120, 72, 360)
  );
  const merges = normalizeMerges(selectedSheet?.merges, fromRow, toRow, fromCol, toCol);
  const values = padValues(
    cells.map((row) => row.map((cell) => cell.value)),
    requestedRowCount,
    requestedColumnCount
  );

  return {
    ...metadata,
    selectedTab: matchingTab.title,
    range: {
      fromRow,
      toRow,
      fromCol,
      toCol,
      a1Notation,
    },
    cells,
    rowHeights,
    columnWidths,
    merges,
    values,
    totalRows: requestedRowCount,
    totalColumns: requestedColumnCount,
  };
}

export async function updateGoogleSheetsRange(input: GoogleSheetsUpdateRangeRequest): Promise<GoogleSheetsUpdateRangeResponse> {
  const sheetId = requireNonEmptyString('sheetId', input.sheetId);
  const metadata = await getSpreadsheetMetadata(sheetId);
  const tabName = requireNonEmptyString('tabName', input.tabName);
  const fromRow = toPositiveInteger('fromRow', input.fromRow);
  const toRow = toPositiveInteger('toRow', input.toRow);
  const fromCol = toPositiveInteger('fromCol', input.fromCol);
  const toCol = toPositiveInteger('toCol', input.toCol);

  if (fromRow > toRow) {
    throw new GoogleSheetsRequestError(400, 'fromRow must be less than or equal to toRow.');
  }

  if (fromCol > toCol) {
    throw new GoogleSheetsRequestError(400, 'fromCol must be less than or equal to toCol.');
  }

  const matchingTab = metadata.tabs.find((tab) => tab.title === tabName);
  if (!matchingTab) {
    throw new GoogleSheetsRequestError(400, `Tab "${tabName}" was not found in the spreadsheet.`);
  }

  const requestedRowCount = toRow - fromRow + 1;
  const requestedColumnCount = toCol - fromCol + 1;
  const values = normalizeUpdateValues(input.values, requestedRowCount, requestedColumnCount);
  const a1Notation = buildA1Notation(tabName, fromRow, toRow, fromCol, toCol);
  const updateResponse = await googleSheetsFetch<GoogleSheetsUpdateValuesResponse>(
    `/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(a1Notation)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        range: a1Notation,
        majorDimension: 'ROWS',
        values,
      }),
    }
  );

  return {
    spreadsheetId: metadata.spreadsheetId,
    spreadsheetTitle: metadata.spreadsheetTitle,
    selectedTab: matchingTab.title,
    updatedRange: updateResponse.updatedRange ?? a1Notation,
    updatedRows: updateResponse.updatedRows ?? requestedRowCount,
    updatedColumns: updateResponse.updatedColumns ?? requestedColumnCount,
    updatedCells: updateResponse.updatedCells ?? requestedRowCount * requestedColumnCount,
  };
}

export async function batchUpdateGoogleSheetsColumns(
  input: GoogleSheetsBatchColumnUpdateRequest
): Promise<GoogleSheetsBatchColumnUpdateResponse> {
  const sheetId = requireNonEmptyString('sheetId', input.sheetId);
  const metadata = await getSpreadsheetMetadata(sheetId);
  const tabName = requireNonEmptyString('tabName', input.tabName);
  const startRow = toPositiveInteger('startRow', input.startRow);

  const matchingTab = metadata.tabs.find((tab) => tab.title === tabName);
  if (!matchingTab) {
    throw new GoogleSheetsRequestError(400, `Tab "${tabName}" was not found in the spreadsheet.`);
  }

  if (!Array.isArray(input.updates) || input.updates.length === 0) {
    throw new GoogleSheetsRequestError(400, 'updates must contain at least one column update.');
  }

  const normalizedUpdates = input.updates.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new GoogleSheetsRequestError(400, `updates[${index + 1}] must be an object.`);
    }

    const typedEntry = entry as GoogleSheetsColumnValuesUpdate;
    const col = toPositiveInteger(`updates[${index + 1}].col`, typedEntry.col);
    const values = normalizeColumnUpdateValues(typedEntry.values);

    return { col, values };
  });

  const rowCount = Math.max(...normalizedUpdates.map((entry) => entry.values.length), 0);
  if (rowCount === 0) {
    return {
      spreadsheetId: metadata.spreadsheetId,
      spreadsheetTitle: metadata.spreadsheetTitle,
      selectedTab: matchingTab.title,
      updatedRanges: [],
      updatedRows: 0,
      updatedColumns: normalizedUpdates.length,
      updatedCells: 0,
    };
  }

  const data = normalizedUpdates.map((entry) => {
    const toRow = startRow + rowCount - 1;
    const range = buildA1Notation(tabName, startRow, toRow, entry.col, entry.col);
    const values = Array.from({ length: rowCount }, (_, rowIndex) => [entry.values[rowIndex] ?? '']);
    return {
      range,
      majorDimension: 'ROWS',
      values,
    };
  });

  const updateResponse = await googleSheetsFetch<GoogleSheetsBatchUpdateValuesResponse>(
    `/spreadsheets/${encodeURIComponent(sheetId)}/values:batchUpdate`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        valueInputOption: 'USER_ENTERED',
        data,
      }),
    }
  );

  return {
    spreadsheetId: metadata.spreadsheetId,
    spreadsheetTitle: metadata.spreadsheetTitle,
    selectedTab: matchingTab.title,
    updatedRanges: updateResponse.responses?.map((entry) => entry.updatedRange ?? '').filter(Boolean) ?? data.map((entry) => entry.range),
    updatedRows: updateResponse.totalUpdatedRows ?? rowCount,
    updatedColumns: updateResponse.totalUpdatedColumns ?? normalizedUpdates.length,
    updatedCells: updateResponse.totalUpdatedCells ?? rowCount * normalizedUpdates.length,
  };
}

export async function fetchGoogleSheetsColumnValues(
  input: GoogleSheetsColumnValuesRequest
): Promise<GoogleSheetsColumnValuesResponse> {
  const sheetId = requireNonEmptyString('sheetId', input.sheetId);
  const metadata = await getSpreadsheetMetadata(sheetId);
  const tabName = requireNonEmptyString('tabName', input.tabName);
  const col = toPositiveInteger('col', input.col);

  const matchingTab = metadata.tabs.find((tab) => tab.title === tabName);
  if (!matchingTab) {
    throw new GoogleSheetsRequestError(400, `Tab "${tabName}" was not found in the spreadsheet.`);
  }

  const range = `${quoteSheetTitle(tabName)}!${toColumnLetters(col)}:${toColumnLetters(col)}`;
  const response = await googleSheetsFetch<GoogleSheetsValuesResponse>(
    `/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}`
  );

  return {
    spreadsheetId: metadata.spreadsheetId,
    spreadsheetTitle: metadata.spreadsheetTitle,
    selectedTab: matchingTab.title,
    column: col,
    values: (response.values ?? []).map((row) => normalizeSingleCellValue('value', row?.[0] ?? '')),
  };
}

/**
 * Writes a few cells of one row, as the values they are (RAW).
 *
 * No metadata read first, unlike the helpers above: this runs once per row of
 * a Job Filter run, and the read only asked whether the tab exists - which
 * the write itself answers, with Google's own refusal. RAW rather than
 * USER_ENTERED, so a value that happens to start with `=` is a value, never a
 * formula.
 */
export async function updateGoogleSheetsRow(
  input: GoogleSheetsSingleRowUpdateRequest
): Promise<GoogleSheetsSingleRowUpdateResponse> {
  const sheetId = requireNonEmptyString('sheetId', input.sheetId);
  const tabName = requireNonEmptyString('tabName', input.tabName);
  const row = toPositiveInteger('row', input.row);

  if (!Array.isArray(input.updates) || input.updates.length === 0) {
    throw new GoogleSheetsRequestError(400, 'updates must contain at least one cell update.');
  }

  const normalizedUpdates = input.updates.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new GoogleSheetsRequestError(400, `updates[${index + 1}] must be an object.`);
    }

    const typedEntry = entry as GoogleSheetsSingleRowCellUpdate;
    const col = toPositiveInteger(`updates[${index + 1}].col`, typedEntry.col);
    const value = normalizeSingleCellValue(`updates[${index + 1}].value`, typedEntry.value);

    return { col, value };
  });

  const data = normalizedUpdates.map((entry) => {
    const range = buildA1Notation(tabName, row, row, entry.col, entry.col);
    return {
      range,
      majorDimension: 'ROWS',
      values: [[entry.value]],
    };
  });

  const updateResponse = await googleSheetsFetch<GoogleSheetsBatchUpdateValuesResponse>(
    `/spreadsheets/${encodeURIComponent(sheetId)}/values:batchUpdate`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        valueInputOption: 'RAW',
        data,
      }),
    }
  );

  return {
    spreadsheetId: sheetId,
    spreadsheetTitle: '',
    selectedTab: tabName,
    row,
    updatedRanges: updateResponse.responses?.map((entry) => entry.updatedRange ?? '').filter(Boolean) ?? data.map((entry) => entry.range),
    updatedColumns: updateResponse.totalUpdatedColumns ?? normalizedUpdates.length,
    updatedCells: updateResponse.totalUpdatedCells ?? normalizedUpdates.length,
  };
}

/* ------------------------------------------------- creating and sharing ---- */

/**
 * The columns a new dated tab starts with, in order.
 *
 * `NO(DATE)` first because that is what the sheet this was modelled on uses:
 * the row number doubles as the day's sequence. The names are reproduced
 * exactly, lower-case `note` included - a header somebody later matches on by
 * string should match what they see.
 */
/** The analysis columns, in order, after Filter Reason. Their order is part of the sheet's contract. */
export const ANALYSIS_COLUMN_HEADERS = [
  'Job Field',
  'Salary',
  'Job Hash',
  'Analyzed At',
  'Lake Status',
  'Analysis',
] as const;

export const JOB_SHEET_HEADERS = [
  'NO(DATE)',
  'Company',
  'Job Title',
  'Job Link',
  'Job Description',
  'Rate',
  'note',
  'Job Finder',
  // The filter's own two, and the reason they exist: everything above is a
  // field somebody types into. Writing a verdict into one of them would
  // overwrite the rate or the note it had, so the filter gets columns nothing
  // else owns.
  'Filter Result',
  'Filter Reason',
  // The job analysis's six (owner decision J5), written by the program alone:
  // the protected range below covers exactly these, header included, and
  // nobody but the server's own Google identity may edit them. Job Hash and
  // Lake Status belong to the Job Data Lake and stay empty until it fills
  // them. The Analysis cell is the whole analysis as JSON, which is what a
  // later run reads back instead of asking a model again (PLAN check 1).
  ...ANALYSIS_COLUMN_HEADERS,
] as const;

function columnOf(header: (typeof JOB_SHEET_HEADERS)[number]): number {
  const index = JOB_SHEET_HEADERS.indexOf(header);
  if (index < 0) throw new Error(`"${header}" is not one of the job sheet headers.`);
  return index + 1;
}

/**
 * Where each field lives, in 1-based spreadsheet columns.
 *
 * Derived from the header list rather than written out, so reordering the
 * headers moves the columns with them. A hand-kept copy of these numbers is
 * exactly the thing that drifts: the sheet gets a new column, the constant does
 * not, and every export afterwards writes company names over job links.
 */
export const JOB_SHEET_COLUMNS = {
  no: columnOf('NO(DATE)'),
  company: columnOf('Company'),
  jobTitle: columnOf('Job Title'),
  jobLink: columnOf('Job Link'),
  jobDescription: columnOf('Job Description'),
  rate: columnOf('Rate'),
  note: columnOf('note'),
  jobFinder: columnOf('Job Finder'),
  filterResult: columnOf('Filter Result'),
  filterReason: columnOf('Filter Reason'),
  jobField: columnOf('Job Field'),
  salary: columnOf('Salary'),
  jobHash: columnOf('Job Hash'),
  analyzedAt: columnOf('Analyzed At'),
  lakeStatus: columnOf('Lake Status'),
  analysis: columnOf('Analysis'),
} as const;

/** The first and last analysis column, 1-based: the protected block. */
export const ANALYSIS_FIRST_COLUMN = JOB_SHEET_COLUMNS.jobField;
export const ANALYSIS_LAST_COLUMN = JOB_SHEET_COLUMNS.analysis;

/** Row 1 is the header, so data starts at 2. */
export const JOB_SHEET_FIRST_DATA_ROW = 2;

export type CreatedSpreadsheet = {
  spreadsheetId: string;
  spreadsheetUrl: string;
  /** The gid of the tab it was created with, ready to be formatted. */
  firstTabGid: number;
};

/**
 * Creates a spreadsheet whose FIRST tab is already the one we want.
 *
 * Naming the first sheet in the create call, rather than adding a tab
 * afterwards, is what keeps Google's default `Sheet1` out of the file. A
 * spreadsheet must always contain at least one sheet, so `Sheet1` cannot simply
 * be deleted after the fact without first adding a replacement - and the
 * in-between state is visible to anyone who opens the link.
 *
 * Worth being clear about the ownership, because it surprises people: a file
 * created this way belongs to the service account, not to any person, so it
 * appears in nobody's Drive until it is shared. `shareSpreadsheetWithEmail`
 * below is what makes it reachable, and skipping that step leaves a sheet that
 * exists and that no human can open.
 */
export async function createSpreadsheet(
  title: string,
  firstTabTitle: string,
  headerCount: number = JOB_SHEET_HEADERS.length
): Promise<CreatedSpreadsheet> {
  const created = await googleSheetsFetch<{
    spreadsheetId?: string;
    spreadsheetUrl?: string;
    sheets?: Array<{ properties?: { sheetId?: number } }>;
  }>('/spreadsheets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: { title },
      sheets: [
        {
          properties: {
            title: firstTabTitle,
            gridProperties: {
              rowCount: NEW_TAB_ROW_COUNT,
              columnCount: Math.max(headerCount, NEW_TAB_MIN_COLUMNS),
              frozenRowCount: 1,
            },
          },
        },
      ],
    }),
  });

  if (!created.spreadsheetId) {
    throw new GoogleSheetsRequestError(500, 'Google did not return an id for the new spreadsheet.');
  }

  const firstTabGid = created.sheets?.[0]?.properties?.sheetId;
  if (typeof firstTabGid !== 'number') {
    throw new GoogleSheetsRequestError(500, 'Google did not return an id for the new spreadsheet\'s first tab.');
  }

  return {
    spreadsheetId: created.spreadsheetId,
    spreadsheetUrl:
      created.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${created.spreadsheetId}/edit`,
    firstTabGid,
  };
}

export type SheetTab = { title: string; gid: number };

/** Every tab with its gid, so a caller can tell new from existing and deep-link. */
export async function listSheetTabs(spreadsheetId: string): Promise<SheetTab[]> {
  const metadata = await googleSheetsFetch<SpreadsheetMetadataResponse>(
    `/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets(properties(title,sheetId))`
  );
  return (metadata.sheets ?? [])
    .map((sheet) => ({ title: sheet.properties?.title, gid: sheet.properties?.sheetId }))
    .filter((tab): tab is SheetTab => typeof tab.title === 'string' && typeof tab.gid === 'number');
}

const HEADER_BACKGROUND = { red: 0, green: 0, blue: 0 };
const HEADER_FOREGROUND = { red: 1, green: 1, blue: 1 };
const NEW_TAB_ROW_COUNT = 1000;
const NEW_TAB_MIN_COLUMNS = 12;
/**
 * Auto-fit sizes a column to its header text, and "Job Description" holds
 * paragraphs. Left to autofit it would be the narrowest column on the sheet
 * carrying the widest content, so it is given a width outright.
 */
const JOB_DESCRIPTION_WIDTH_PIXELS = 420;
/** The Analysis cell holds a whole analysis as JSON; a width of its own keeps it from swallowing the row. */
const ANALYSIS_WIDTH_PIXELS = 240;

/**
 * The text a protected range of ours carries, so a later check can tell it
 * from one somebody else added. Never shown to anybody but whoever opens
 * Data -> Protected sheets and ranges.
 */
export const ANALYSIS_PROTECTION_DESCRIPTION = 'Tailor analysis columns - written by the program only';

/** A protected range as Google reports it, as far as this module reads it. */
export type ProtectedRangeApi = {
  protectedRangeId?: number;
  description?: string;
  warningOnly?: boolean;
  range?: {
    sheetId?: number;
    startRowIndex?: number;
    endRowIndex?: number;
    startColumnIndex?: number;
    endColumnIndex?: number;
  };
  editors?: { users?: string[]; groups?: string[]; domainUsersCanEdit?: boolean };
};

/**
 * Whose Google identity the server is: the email a protected range must name
 * as its only editor.
 *
 * A service account's is in its key file. An authorized user's (the account
 * behind `npm run sheets:login`) is not, so Drive is asked once - `about` -
 * and the answer kept for the life of the process, which is the life of the
 * credential file as far as anything here is concerned.
 */
let cachedCredentialEmail: Promise<string> | null = null;

export function getCredentialEmail(): Promise<string> {
  if (!cachedCredentialEmail) {
    cachedCredentialEmail = (async () => {
      const credentials = await loadGoogleCredentials();
      if (credentials.kind === 'service_account') return credentials.clientEmail.trim().toLowerCase();
      const about = await driveAbout();
      const email = about.user?.emailAddress?.trim().toLowerCase();
      if (!email) {
        throw new GoogleSheetsRequestError(502, "Google did not say which account this server's sign-in belongs to.");
      }
      return email;
    })();
    // A failure is not remembered: the next ask tries again.
    cachedCredentialEmail.catch(() => {
      cachedCredentialEmail = null;
    });
  }
  return cachedCredentialEmail;
}

/** Forgets the identity, for a test that swaps the credential file. */
export function resetCredentialEmailForTests(): void {
  cachedCredentialEmail = null;
}

/**
 * The protection over the analysis columns, as an add request: the six whole
 * columns, header row included (no row bounds), refusing every editor but the
 * server's own identity - not a warning, and not "anybody in the domain".
 */
export function analysisProtectionRange(gid: number, editorEmail: string): Required<Pick<ProtectedRangeApi, 'description' | 'warningOnly' | 'range' | 'editors'>> {
  return {
    description: ANALYSIS_PROTECTION_DESCRIPTION,
    warningOnly: false,
    range: { sheetId: gid, startColumnIndex: ANALYSIS_FIRST_COLUMN - 1, endColumnIndex: ANALYSIS_LAST_COLUMN },
    editors: { users: [editorEmail], domainUsersCanEdit: false },
  };
}

export type AnalysisProtectionState = 'intact' | 'missing' | 'altered';

/**
 * Whether the tab's analysis columns are protected as they must be, and the
 * requests that make them so.
 *
 * Ours is found by its description or by covering exactly the six columns.
 * It is INTACT only when it covers the six whole columns of this tab (no row
 * bounds), is a real protection rather than a warning, and lists no editor
 * but the server's identity - no other user, no group, not the domain. An
 * altered one is put back with `updateProtectedRange`, a missing one added,
 * and a duplicate of ours deleted, so exactly one remains.
 */
export function analysisProtectionRequests(
  gid: number,
  existing: ProtectedRangeApi[],
  editorEmail: string
): { state: AnalysisProtectionState; requests: Array<Record<string, unknown>> } {
  const email = editorEmail.trim().toLowerCase();
  const wanted = analysisProtectionRange(gid, email);
  const coversColumns = (range: ProtectedRangeApi['range']) =>
    Boolean(range) &&
    range!.sheetId === gid &&
    range!.startColumnIndex === wanted.range.startColumnIndex &&
    range!.endColumnIndex === wanted.range.endColumnIndex;
  const ours = existing.filter(
    (entry) =>
      (entry.range?.sheetId ?? gid) === gid &&
      (entry.description === ANALYSIS_PROTECTION_DESCRIPTION || coversColumns(entry.range))
  );

  if (ours.length === 0) {
    return { state: 'missing', requests: [{ addProtectedRange: { protectedRange: wanted } }] };
  }

  const [kept, ...extra] = ours;
  const users = (kept.editors?.users ?? []).map((user) => user.trim().toLowerCase());
  const intact =
    coversColumns(kept.range) &&
    kept.range?.startRowIndex === undefined &&
    kept.range?.endRowIndex === undefined &&
    kept.warningOnly !== true &&
    kept.editors?.domainUsersCanEdit !== true &&
    (kept.editors?.groups ?? []).length === 0 &&
    users.length > 0 &&
    users.every((user) => user === email);

  const requests: Array<Record<string, unknown>> = extra
    .filter((entry) => typeof entry.protectedRangeId === 'number')
    .map((entry) => ({ deleteProtectedRange: { protectedRangeId: entry.protectedRangeId } }));
  if (!intact) {
    requests.unshift({
      updateProtectedRange: {
        protectedRange: { protectedRangeId: kept.protectedRangeId, ...wanted },
        fields: 'range,description,warningOnly,editors',
      },
    });
  }
  return { state: intact && extra.length === 0 ? 'intact' : 'altered', requests };
}

/** The header row's own requests: the cells, the filter dropdown, the widths. */
function headerFormatRequests(gid: number, headers: readonly string[]): Array<Record<string, unknown>> {
  const descriptionIndex = headers.indexOf('Job Description');
  const analysisIndex = headers.indexOf('Analysis');
  const fixedWidth = (index: number, pixels: number) =>
    index >= 0
      ? [
          {
            updateDimensionProperties: {
              range: { sheetId: gid, dimension: 'COLUMNS', startIndex: index, endIndex: index + 1 },
              properties: { pixelSize: pixels },
              fields: 'pixelSize',
            },
          },
        ]
      : [];
  return [
    {
      updateCells: {
        rows: [
          {
            values: headers.map((header) => ({
              userEnteredValue: { stringValue: header },
              userEnteredFormat: {
                backgroundColor: HEADER_BACKGROUND,
                textFormat: { bold: true, foregroundColor: HEADER_FOREGROUND },
                verticalAlignment: 'MIDDLE',
              },
            })),
          },
        ],
        fields: 'userEnteredValue,userEnteredFormat',
        start: { sheetId: gid, rowIndex: 0, columnIndex: 0 },
      },
    },
    {
      // The dropdown on the header row. Bounded to the header's own columns
      // so a filter does not claim the empty half of the grid.
      setBasicFilter: {
        filter: {
          range: { sheetId: gid, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: headers.length },
        },
      },
    },
    {
      autoResizeDimensions: {
        dimensions: { sheetId: gid, dimension: 'COLUMNS', startIndex: 0, endIndex: headers.length },
      },
    },
    // After the autofit, so it is not undone by it.
    ...fixedWidth(descriptionIndex, JOB_DESCRIPTION_WIDTH_PIXELS),
    ...fixedWidth(analysisIndex, ANALYSIS_WIDTH_PIXELS),
  ];
}

/** Sends a spreadsheet `:batchUpdate`. Nothing is sent for no requests. */
export async function batchUpdateSpreadsheet(
  spreadsheetId: string,
  requests: Array<Record<string, unknown>>
): Promise<void> {
  if (requests.length === 0) return;
  await googleSheetsFetch(`/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
}

/**
 * Lays out the header row on a tab that already exists.
 *
 * Separate from creating the tab because the two happen in different orders in
 * the two cases that matter: a brand new spreadsheet arrives with its first tab
 * already made, while a new day adds one. Both need the identical header - and
 * both are new tabs, so this is also where their analysis columns are first
 * protected (`protect`, on by default). When the server's identity cannot be
 * found, the tab is laid out unprotected and the next verify adds it; until
 * then nothing in it is trusted (see `verifyJobSheetTab`).
 */
export async function formatJobSheetTab(
  spreadsheetId: string,
  gid: number,
  headers: readonly string[] = JOB_SHEET_HEADERS,
  options: { protect?: boolean } = {}
): Promise<void> {
  const requests = headerFormatRequests(gid, headers);
  if (options.protect !== false && headers.length >= ANALYSIS_LAST_COLUMN) {
    try {
      requests.push({ addProtectedRange: { protectedRange: analysisProtectionRange(gid, await getCredentialEmail()) } });
    } catch (error) {
      console.warn(
        `[sheets] Could not tell which Google account this server is, so the analysis columns of a new tab in ` +
          `${spreadsheetId} are not protected yet; the next check of the tab adds it.`,
        error
      );
    }
  }
  await batchUpdateSpreadsheet(spreadsheetId, requests);
}

/**
 * Whether a tab's first row is the header this build expects.
 *
 * Its own function, and exported, because it decides two different upgrades: a
 * tab created but never formatted (an allocation that died between the two
 * calls), and a tab formatted by an OLDER build with fewer columns. Both look
 * the same from here - the row does not match - and both are fixed by writing
 * the header again.
 */
export function jobSheetHeaderIsCurrent(
  firstRow: ReadonlyArray<unknown>,
  headers: readonly string[] = JOB_SHEET_HEADERS
): boolean {
  return headers.every((header, index) => String(firstRow[index] ?? '').trim() === header);
}

/**
 * The headers every job tab this app ever laid out starts with - the eight the
 * first build wrote, before the filter's two and the analysis's six were
 * added after them. A tab whose row 1 starts with these is one of ours, of
 * whichever age, and is brought up to date; a tab that does not is somebody's
 * own, and is left exactly as it is.
 */
const JOB_SHEET_HEADER_PREFIX = JOB_SHEET_HEADERS.slice(0, JOB_SHEET_COLUMNS.jobFinder);

/** The `MM/DD/YYYY` title of a day's tab, as the account sheet allocates them. */
const DATED_TAB_TITLE = /^\d{2}\/\d{2}\/\d{4}$/;

/**
 * Whether a tab is a job tab this app laid out - and so one it may widen,
 * re-header and protect. Its row 1 starts with the job sheet's first eight
 * headers (a tab of any build's), or it is a day's tab whose row 1 is still
 * empty: an allocation that died between adding the tab and laying it out.
 *
 * Anything else is a tab the person made for themselves - sheet mode reads any
 * tab, through a column mapping of its own - whose row 1 is their header and
 * whose columns K to P are theirs.
 */
export function isJobSheetTab(tab: Pick<JobSheetTabInspection, 'title' | 'headerRow'>): boolean {
  if (JOB_SHEET_HEADER_PREFIX.every((header, index) => String(tab.headerRow[index] ?? '').trim() === header)) return true;
  return DATED_TAB_TITLE.test(tab.title) && tab.headerRow.every((cell) => String(cell ?? '').trim() === '');
}

/** What one read of a tab says about it: enough to verify it without reading it again. */
export type JobSheetTabInspection = {
  gid: number;
  title: string;
  columnCount: number;
  /** The grid's rows, when Google said. */
  rowCount?: number;
  headerRow: string[];
  protectedRanges: ProtectedRangeApi[];
};

/**
 * One GET for everything a verify needs: the tab's id and grid size, its
 * protected ranges, and its first row. The row is asked for as `1:1`, which
 * never runs past the grid - `A1:P1` would, on a tab an older build made
 * twelve columns wide, and Google refuses that read outright.
 */
export async function inspectJobSheetTab(spreadsheetId: string, title: string): Promise<JobSheetTabInspection> {
  const fields =
    'sheets(properties(sheetId,title,gridProperties(columnCount,rowCount)),' +
    'protectedRanges(protectedRangeId,description,warningOnly,range,editors(users,groups,domainUsersCanEdit)),' +
    'data(rowData(values(formattedValue))))';
  const response = await googleSheetsFetch<{
    sheets?: Array<{
      properties?: { sheetId?: number; title?: string; gridProperties?: { columnCount?: number; rowCount?: number } };
      protectedRanges?: ProtectedRangeApi[];
      data?: Array<{ rowData?: Array<{ values?: Array<{ formattedValue?: string }> }> }>;
    }>;
  }>(
    `/spreadsheets/${encodeURIComponent(spreadsheetId)}?includeGridData=true&ranges=${encodeURIComponent(
      `${quoteSheetTitle(title)}!1:1`
    )}&fields=${encodeURIComponent(fields)}`
  );
  const sheet = response.sheets?.find((entry) => entry.properties?.title === title) ?? response.sheets?.[0];
  const gid = sheet?.properties?.sheetId;
  if (!sheet || typeof gid !== 'number') {
    throw new GoogleSheetsRequestError(400, `Tab "${title}" was not found in the spreadsheet.`);
  }
  return {
    gid,
    title: sheet.properties?.title ?? title,
    columnCount: sheet.properties?.gridProperties?.columnCount ?? 0,
    ...(typeof sheet.properties?.gridProperties?.rowCount === 'number'
      ? { rowCount: sheet.properties.gridProperties.rowCount }
      : {}),
    headerRow: (sheet.data?.[0]?.rowData?.[0]?.values ?? []).map((cell) => cell.formattedValue ?? ''),
    protectedRanges: sheet.protectedRanges ?? [],
  };
}

/**
 * What a verify found and did. `protection` is the state the protection was
 * FOUND in - `intact`, or `missing` / `altered` and put back in this call -
 * or `unconfirmed` when the server's identity could not be learned and
 * nothing could be checked or repaired, or the tab is not a job tab at all.
 *
 * A protection that had to be put back left a window in which anybody with
 * the link could have typed into the Analysis column, so the same call that
 * restores it CLEARS that column's data rows (`analysisClearRequest`): an
 * Analysis cell in a tab whose protection was later found intact was
 * therefore written while the protection stood - by the program. Only
 * `intact` lets the cells already in the tab be trusted in this run.
 *
 * `jobTab` is false for a tab the app never laid out (`isJobSheetTab`), which
 * a verify asked to touch only job tabs leaves exactly as it was found.
 */
export type VerifiedJobSheetTab = {
  gid: number;
  protection: AnalysisProtectionState | 'unconfirmed';
  grewColumns: boolean;
  wroteHeader: boolean;
  jobTab: boolean;
};

/**
 * Empties the Analysis column below the header - the one analysis cell a build
 * trusts. Only it: Job Field to Lake Status are never read back as an
 * analysis, and on a tab an older build made, the first two of them were spare
 * columns that may hold the person's own notes. Nothing is lost - every
 * analysis is in the database, and its row is written again on its next run.
 */
export function analysisClearRequest(gid: number): Record<string, unknown> {
  return {
    updateCells: {
      range: {
        sheetId: gid,
        startRowIndex: JOB_SHEET_FIRST_DATA_ROW - 1,
        startColumnIndex: ANALYSIS_LAST_COLUMN - 1,
        endColumnIndex: ANALYSIS_LAST_COLUMN,
      },
      fields: 'userEnteredValue',
    },
  };
}

/**
 * Makes an existing tab what this build expects, in at most two calls: one
 * read (`inspectJobSheetTab`), then one `:batchUpdate` that grows the grid to
 * hold every header (`appendDimension` - never a column count set outright,
 * which would delete columns somebody added past ours), rewrites a stale or
 * missing header, and puts the analysis protection back - clearing the
 * Analysis column in the same, atomic, call when it does. Every repair of the
 * protection is logged.
 *
 * `onlyJobTabs` is for a tab the person chose rather than one the app
 * allocated: a tab that is not a job tab is not touched at all.
 */
export async function verifyJobSheetTab(
  spreadsheetId: string,
  title: string,
  headers: readonly string[] = JOB_SHEET_HEADERS,
  known?: JobSheetTabInspection,
  options: { onlyJobTabs?: boolean } = {}
): Promise<VerifiedJobSheetTab> {
  const tab = known ?? (await inspectJobSheetTab(spreadsheetId, title));
  if (options.onlyJobTabs && !isJobSheetTab(tab)) {
    return { gid: tab.gid, protection: 'unconfirmed', grewColumns: false, wroteHeader: false, jobTab: false };
  }
  const requests: Array<Record<string, unknown>> = [];

  const grewColumns = tab.columnCount < headers.length;
  if (grewColumns) {
    requests.push({
      appendDimension: { sheetId: tab.gid, dimension: 'COLUMNS', length: headers.length - tab.columnCount },
    });
  }
  const wroteHeader = !jobSheetHeaderIsCurrent(tab.headerRow, headers);
  if (wroteHeader) requests.push(...headerFormatRequests(tab.gid, headers));

  let protection: VerifiedJobSheetTab['protection'] = 'unconfirmed';
  if (headers.length >= ANALYSIS_LAST_COLUMN) {
    try {
      const email = await getCredentialEmail();
      const check = analysisProtectionRequests(tab.gid, tab.protectedRanges, email);
      protection = check.state;
      if (check.state !== 'intact') {
        // After the grid is grown (the column may not exist before), and in
        // the same call as the protection, so no cell can be typed in between.
        if (tab.rowCount === undefined || tab.rowCount >= JOB_SHEET_FIRST_DATA_ROW) {
          requests.push(analysisClearRequest(tab.gid));
        }
        console.warn(
          `[sheets] The analysis columns of "${title}" in ${spreadsheetId} were ${
            check.state === 'missing' ? 'not protected' : 'protected wrongly (other editors, a warning only, or the wrong columns)'
          }; restoring the protection so only ${email} can edit them, and clearing the Analysis cells somebody else ` +
            'could have written meanwhile. Their rows are written again from the database on their next run.'
        );
      }
      requests.push(...check.requests);
    } catch (error) {
      console.warn(
        `[sheets] Could not check the protection of the analysis columns of "${title}" in ${spreadsheetId}; ` +
          'its analysis cells are not trusted in this run.',
        error
      );
    }
  }

  await batchUpdateSpreadsheet(spreadsheetId, requests);
  return { gid: tab.gid, protection, grewColumns, wroteHeader, jobTab: true };
}

/**
 * Whether the tab's protection could be trusted when THIS verify found it:
 * only an intact one. Exported for the readers of analysis cells.
 */
export function protectionTrusted(verified: Pick<VerifiedJobSheetTab, 'protection'>): boolean {
  return verified.protection === 'intact';
}

export type EnsuredTab = {
  gid: number;
  created: boolean;
  /** What the protection of its analysis columns was found as; see VerifiedJobSheetTab. */
  protection?: VerifiedJobSheetTab['protection'] | 'added';
};

/**
 * Adds a dated tab and lays out its header, or reports the one already there.
 *
 * `created: false` is the ordinary answer on every sign-in after the first of a
 * day, and is not a failure - it is the skip the whole feature is built around.
 */
export async function addSheetTabWithHeaders(
  spreadsheetId: string,
  title: string,
  headers: readonly string[] = JOB_SHEET_HEADERS
): Promise<EnsuredTab> {
  const existing = await listSheetTabs(spreadsheetId);
  const already = existing.find((tab) => tab.title === title);
  if (already) {
    // Existing is not the same as finished. If a previous attempt created the
    // tab and then failed before laying out the header - a 429 between the two
    // calls is enough - nothing would ever write one, because every later
    // attempt sees the tab and stops here. So the tab is verified: its header,
    // its width, and the protection of its analysis columns, which is checked
    // again on every verifying ensure and put back if anybody took it off.
    const verified = await verifyJobSheetTab(spreadsheetId, title, headers);
    return { gid: verified.gid, created: false, protection: verified.protection };
  }

  const added = await googleSheetsFetch<{
    replies?: Array<{ addSheet?: { properties?: { sheetId?: number } } }>;
  }>(`/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        {
          addSheet: {
            properties: {
              title,
              gridProperties: {
                rowCount: NEW_TAB_ROW_COUNT,
                columnCount: Math.max(headers.length, NEW_TAB_MIN_COLUMNS),
                frozenRowCount: 1,
              },
            },
          },
        },
      ],
    }),
  });

  const gid = added.replies?.[0]?.addSheet?.properties?.sheetId;
  if (typeof gid !== 'number') {
    throw new GoogleSheetsRequestError(500, `Google did not return an id for the new "${title}" tab.`);
  }

  await formatJobSheetTab(spreadsheetId, gid, headers);
  return { gid, created: true, protection: 'added' };
}

/* ------------------------------------------------------ batched values -- */

/**
 * Reads several A1 ranges in ONE call (`values:batchGetByDataFilter`, a POST,
 * so a long list of ranges never runs into a URL length limit). Answers one
 * grid per range, in the order asked, each padded with nothing: a trailing
 * empty row or cell Google leaves out reads as missing, and callers read
 * missing as ''.
 */
export async function batchGetValues(spreadsheetId: string, ranges: string[]): Promise<string[][][]> {
  if (ranges.length === 0) return [];
  const response = await googleSheetsFetch<{
    valueRanges?: Array<{ valueRange?: { values?: unknown[][] } }>;
  }>(`/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGetByDataFilter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dataFilters: ranges.map((a1Range) => ({ a1Range })),
      majorDimension: 'ROWS',
      valueRenderOption: 'FORMATTED_VALUE',
    }),
  });
  return ranges.map((_, index) =>
    (response.valueRanges?.[index]?.valueRange?.values ?? []).map((row) =>
      (row ?? []).map((cell) => (cell === null || cell === undefined ? '' : String(cell)))
    )
  );
}

/**
 * Writes several ranges in ONE call, every value RAW - stored as the text or
 * number it is, never parsed as a formula, which is what analysis data must
 * be: a company name or a posting's words starting with `=` stay words. A
 * `null` in a row leaves that cell as it was (Google skips nulls), so a write
 * can fill four cells of a six-cell block without touching the other two.
 */
export async function batchUpdateValuesRaw(
  spreadsheetId: string,
  data: Array<{ range: string; values: Array<Array<string | number | null>> }>
): Promise<void> {
  if (data.length === 0) return;
  await googleSheetsFetch(`/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      valueInputOption: 'RAW',
      data: data.map((entry) => ({ range: entry.range, majorDimension: 'ROWS', values: entry.values })),
    }),
  });
}

/** A1 notation for a block of a tab, the title quoted as Google wants it. */
export function a1Range(tabName: string, fromRow: number, toRow: number, fromCol: number, toCol: number): string {
  return buildA1Notation(tabName, fromRow, toRow, fromCol, toCol);
}

/** Whole columns of a tab in A1 notation (`'Job Lake'!A:H`): where an append looks for the table's end. */
export function a1Columns(tabName: string, fromCol: number, toCol: number): string {
  return `${quoteSheetTitle(tabName)}!${toColumnLetters(fromCol)}:${toColumnLetters(toCol)}`;
}

/**
 * Appends rows after the last row of the table in `range`, in ONE call
 * (`values:append`), every value RAW - a company called `=HYPERLINK(...)`
 * stays those characters - and as NEW rows (`INSERT_ROWS`), so a row somebody
 * typed below the table is pushed down rather than written over. Through the
 * same 429 backoff as every other call.
 */
export async function appendValuesRaw(
  spreadsheetId: string,
  range: string,
  rows: Array<Array<string | number | null>>
): Promise<void> {
  if (rows.length === 0) return;
  await googleSheetsFetch(
    `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append` +
      '?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ range, majorDimension: 'ROWS', values: rows }),
    }
  );
}

/** Light red, Google's own "light red 3": what a duplicate job's row is painted. */
export const DUPLICATE_ROW_COLOR = { red: 0.957, green: 0.8, blue: 0.8 };

/**
 * A `:batchUpdate` request painting one whole row's background (`repeatCell`,
 * no column bounds), touching nothing but the background - values, borders
 * and text format stay as they are. Batched by the caller, one call per run.
 */
export function rowBackgroundRequest(
  gid: number,
  row: number,
  color: { red: number; green: number; blue: number }
): Record<string, unknown> {
  return {
    repeatCell: {
      range: { sheetId: gid, startRowIndex: row - 1, endRowIndex: row },
      cell: { userEnteredFormat: { backgroundColor: color } },
      fields: 'userEnteredFormat.backgroundColor',
    },
  };
}

/* ------------------------------------------------------------- permissions -- */

export type SheetVisibility = 'public' | 'private';

/**
 * Gives one person write access by email.
 *
 * `sendNotificationEmail=false` on purpose: this runs during sign-in, and a
 * "someone shared a file with you" mail every time an account is created is
 * noise for something the app is about to show them a link to anyway.
 */
export async function shareSpreadsheetWithEmail(spreadsheetId: string, email: string): Promise<void> {
  await googleDriveFetch(
    `/files/${encodeURIComponent(spreadsheetId)}/permissions?sendNotificationEmail=false&supportsAllDrives=true`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: email }),
    }
  );
}

type DrivePermission = { id?: string; type?: string; role?: string; emailAddress?: string };

async function listPermissions(spreadsheetId: string): Promise<DrivePermission[]> {
  const listed = await googleDriveFetch<{ permissions?: DrivePermission[] }>(
    `/files/${encodeURIComponent(spreadsheetId)}/permissions` +
      '?fields=permissions(id,type,role,emailAddress)&supportsAllDrives=true'
  );
  return listed.permissions ?? [];
}

/**
 * Whether this person holds a grant of their own on the file.
 *
 * Asked before withdrawing link sharing. The two together are the only ways in:
 * take the link away from somebody who never got a personal grant and they are
 * locked out of their own spreadsheet, with the service account the only thing
 * left that can open it.
 */
export async function hasPersonalGrant(spreadsheetId: string, email: string): Promise<boolean> {
  const wanted = email.trim().toLowerCase();
  const permissions = await listPermissions(spreadsheetId);
  return permissions.some(
    (permission) =>
      permission.type === 'user' && (permission.emailAddress ?? '').trim().toLowerCase() === wanted
  );
}

/**
 * Whether anyone holding the link can open this spreadsheet.
 *
 * Read from Drive rather than from our own stored flag, because Drive is where
 * the truth is: somebody can change the sharing in the Google UI at any time,
 * and a toggle that reported our last write would then be confidently wrong.
 */
export async function getSpreadsheetVisibility(spreadsheetId: string): Promise<SheetVisibility> {
  const permissions = await listPermissions(spreadsheetId);
  return permissions.some((permission) => permission.type === 'anyone') ? 'public' : 'private';
}

/**
 * Sets the link-sharing state.
 *
 * `public` here means anyone with the link may EDIT, which is what was asked
 * for and is worth naming plainly: the URL is the only thing standing between a
 * stranger and rewriting somebody's job rows. `private` withdraws that, leaving
 * the per-account grant made at allocation - so the owner keeps access and
 * everyone else loses it.
 */
export async function setSpreadsheetVisibility(
  spreadsheetId: string,
  visibility: SheetVisibility
): Promise<SheetVisibility> {
  const permissions = await listPermissions(spreadsheetId);
  const anyone = permissions.filter((permission) => permission.type === 'anyone');

  if (visibility === 'public') {
    if (anyone.some((permission) => permission.role === 'writer')) return 'public';
    // A reader-for-anyone left over from an earlier policy would otherwise sit
    // alongside the writer grant and make the state ambiguous.
    for (const permission of anyone) {
      if (permission.id) await revokePermission(spreadsheetId, permission.id);
    }
    await googleDriveFetch(
      `/files/${encodeURIComponent(spreadsheetId)}/permissions?supportsAllDrives=true`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'writer', type: 'anyone' }),
      }
    );
    return 'public';
  }

  for (const permission of anyone) {
    if (permission.id) await revokePermission(spreadsheetId, permission.id);
  }
  return 'private';
}

async function revokePermission(spreadsheetId: string, permissionId: string): Promise<void> {
  await googleDriveFetch(
    `/files/${encodeURIComponent(spreadsheetId)}/permissions/${encodeURIComponent(permissionId)}?supportsAllDrives=true`,
    { method: 'DELETE' }
  );
}
