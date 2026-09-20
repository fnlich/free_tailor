import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

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

type GoogleServiceAccountCredentials = {
  client_email?: string;
  private_key?: string;
  token_uri?: string;
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
        ? 'Creating a spreadsheet makes a file in Drive, so the Drive API must be enabled for the ' +
          'same Cloud project as the key - having only the Sheets API on is the usual cause.'
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

export class GoogleSheetsRequestError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
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

export async function resolveServiceAccountPath(): Promise<string> {
  const explicitPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH?.trim();
  const cwd = process.cwd();
  const candidates = [
    explicitPath,
    path.join(cwd, 'service-account-key.json'),
    path.join(cwd, 'backend/service-account-key.json'),
    path.join(__dirname, '../../service-account-key.json'),
    path.join(__dirname, '../../../service-account-key.json'),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  throw new GoogleSheetsRequestError(
    500,
    'Google Service Account key file was not found. Set GOOGLE_SERVICE_ACCOUNT_KEY_PATH or place service-account-key.json in the project or backend directory.'
  );
}

/**
 * Whether this install has a service-account key at all.
 *
 * Its own predicate so callers can answer "not configured" as a fact rather
 * than by catching the 500 that every sheets call would otherwise throw. A
 * missing key is a deployment that has not set sheets up yet, not a failure.
 */
/** The key's own identity, for the doctor to print before it tries anything. */
export async function describeServiceAccount(): Promise<{
  path: string;
  clientEmail: string;
  projectId: string;
}> {
  const path = await resolveServiceAccountPath();
  const parsed = JSON.parse(await fs.readFile(path, 'utf8')) as {
    client_email?: string;
    project_id?: string;
  };
  return {
    path,
    clientEmail: parsed.client_email ?? '(missing)',
    projectId: parsed.project_id ?? '(missing)',
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

export async function isGoogleSheetsConfigured(): Promise<boolean> {
  try {
    await resolveServiceAccountPath();
    return true;
  } catch {
    return false;
  }
}

async function loadServiceAccountCredentials(): Promise<Required<GoogleServiceAccountCredentials>> {
  const filePath = await resolveServiceAccountPath();
  const raw = await fs.readFile(filePath, 'utf8');

  let parsed: GoogleServiceAccountCredentials;
  try {
    parsed = JSON.parse(raw) as GoogleServiceAccountCredentials;
  } catch {
    throw new GoogleSheetsRequestError(500, 'Google Service Account key file is not valid JSON.');
  }

  const clientEmail = parsed.client_email?.trim();
  const privateKey = parsed.private_key?.trim();
  const tokenUri = parsed.token_uri?.trim() || DEFAULT_TOKEN_URI;

  if (!clientEmail || !privateKey) {
    throw new GoogleSheetsRequestError(
      500,
      'Google Service Account credentials are incomplete. Expected client_email and private_key.'
    );
  }

  return {
    client_email: clientEmail,
    private_key: normalizePrivateKey(privateKey),
    token_uri: tokenUri,
  };
}

function buildJwtAssertion(
  credentials: Required<GoogleServiceAccountCredentials>,
  scope: string
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: credentials.client_email,
    scope,
    aud: credentials.token_uri,
    iat: now,
    exp: now + 3600,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsignedToken), credentials.private_key).toString('base64url');

  return `${unsignedToken}.${signature}`;
}

export async function getAccessToken(scope: string): Promise<string> {
  const cached = cachedAccessTokens.get(scope);
  if (cached && cached.expiresAt - ACCESS_TOKEN_REFRESH_BUFFER_MS > Date.now()) {
    return cached.token;
  }

  const credentials = await loadServiceAccountCredentials();
  const assertion = buildJwtAssertion(credentials, scope);
  const response = await fetch(credentials.token_uri, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });

  if (!response.ok) {
    let errorMessage = 'Failed to authenticate with Google Sheets.';
    try {
      const errorBody = (await response.json()) as GoogleApiErrorResponse;
      if (typeof errorBody.error === 'string' && errorBody.error_description) {
        errorMessage = `${errorBody.error}: ${errorBody.error_description}`;
      } else if (typeof errorBody.error === 'object' && errorBody.error?.message) {
        errorMessage = errorBody.error.message;
      }
    } catch {
      // Ignore JSON parsing failures and use the fallback message.
    }
    if (errorMessage.toLowerCase().includes('user not found')) {
      errorMessage =
        `Google service account was not recognized: ${credentials.client_email}. ` +
        'This usually means the JSON key belongs to a deleted or disabled service account, or the key file does not match the live account. ' +
        'Create a new key for the current service account and replace backend/service-account-key.json.';
    }
    throw new GoogleSheetsRequestError(response.status, errorMessage);
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

async function googleSheetsFetch<T>(pathname: string, init?: RequestInit, hasRetried = false): Promise<T> {
  const accessToken = await getAccessToken(SHEETS_SCOPE);
  const response = await fetch(`${SHEETS_API_BASE}${pathname}`, {
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
    throw new GoogleSheetsRequestError(
      response.status,
      describeGoogleFailure(
        response.status,
        await readErrorBody(response),
        describeOperation(pathname, String(init?.method ?? 'GET'))
      )
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
  const response = await fetch(`${DRIVE_API_BASE}${pathname}`, {
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
    throw new GoogleSheetsRequestError(
      response.status,
      describeGoogleFailure(
        response.status,
        await readErrorBody(response),
        describeOperation(pathname, String(init?.method ?? 'GET'))
      )
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

function toColumnLetters(columnNumber: number): string {
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

export async function updateGoogleSheetsRow(
  input: GoogleSheetsSingleRowUpdateRequest
): Promise<GoogleSheetsSingleRowUpdateResponse> {
  const sheetId = requireNonEmptyString('sheetId', input.sheetId);
  const metadata = await getSpreadsheetMetadata(sheetId);
  const tabName = requireNonEmptyString('tabName', input.tabName);
  const row = toPositiveInteger('row', input.row);

  const matchingTab = metadata.tabs.find((tab) => tab.title === tabName);
  if (!matchingTab) {
    throw new GoogleSheetsRequestError(400, `Tab "${tabName}" was not found in the spreadsheet.`);
  }

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
        valueInputOption: 'USER_ENTERED',
        data,
      }),
    }
  );

  return {
    spreadsheetId: metadata.spreadsheetId,
    spreadsheetTitle: metadata.spreadsheetTitle,
    selectedTab: matchingTab.title,
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
} as const;

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

/**
 * Lays out the header row on a tab that already exists.
 *
 * Separate from creating the tab because the two happen in different orders in
 * the two cases that matter: a brand new spreadsheet arrives with its first tab
 * already made, while a new day adds one. Both need the identical header.
 */
export async function formatJobSheetTab(
  spreadsheetId: string,
  gid: number,
  headers: readonly string[] = JOB_SHEET_HEADERS
): Promise<void> {
  const descriptionIndex = headers.indexOf('Job Description');

  await googleSheetsFetch(`/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
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
        ...(descriptionIndex >= 0
          ? [
              {
                updateDimensionProperties: {
                  range: {
                    sheetId: gid,
                    dimension: 'COLUMNS',
                    startIndex: descriptionIndex,
                    endIndex: descriptionIndex + 1,
                  },
                  properties: { pixelSize: JOB_DESCRIPTION_WIDTH_PIXELS },
                  fields: 'pixelSize',
                },
              },
            ]
          : []),
      ],
    }),
  });
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
 * Writes the header only when the first row is not already it.
 *
 * Deliberately a read before a write: re-formatting on every sign-in would undo
 * a column somebody widened, and would spend a write call a day per account for
 * nothing.
 */
async function formatJobSheetTabIfBlank(
  spreadsheetId: string,
  gid: number,
  title: string,
  headers: readonly string[]
): Promise<void> {
  const range = `${quoteSheetTitle(title)}!A1:${toColumnLetters(headers.length)}1`;
  const current = await googleSheetsFetch<GoogleSheetsValuesResponse>(
    `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`
  );

  if (jobSheetHeaderIsCurrent(current.values?.[0] ?? [], headers)) return;

  await formatJobSheetTab(spreadsheetId, gid, headers);
}

export type EnsuredTab = { gid: number; created: boolean };

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
    // attempt sees the tab and stops here. So the header is checked, and
    // written when it is missing.
    await formatJobSheetTabIfBlank(spreadsheetId, already.gid, title, headers);
    return { gid: already.gid, created: false };
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
  return { gid, created: true };
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
