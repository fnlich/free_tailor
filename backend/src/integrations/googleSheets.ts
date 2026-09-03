import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
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

type GoogleApiStructuredError = {
  error?: {
    message?: string;
    status?: string;
  };
};

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

let cachedAccessToken: CachedAccessToken | null = null;

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

async function resolveServiceAccountPath(): Promise<string> {
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

function buildJwtAssertion(credentials: Required<GoogleServiceAccountCredentials>): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: credentials.client_email,
    scope: SHEETS_SCOPE,
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

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt - ACCESS_TOKEN_REFRESH_BUFFER_MS > Date.now()) {
    return cachedAccessToken.token;
  }

  const credentials = await loadServiceAccountCredentials();
  const assertion = buildJwtAssertion(credentials);
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

  cachedAccessToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return cachedAccessToken.token;
}

async function googleSheetsFetch<T>(pathname: string, init?: RequestInit, hasRetried = false): Promise<T> {
  const accessToken = await getAccessToken();
  const response = await fetch(`${SHEETS_API_BASE}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
  });

  if (response.status === 401 && !hasRetried) {
    cachedAccessToken = null;
    return googleSheetsFetch<T>(pathname, init, true);
  }

  if (!response.ok) {
    let errorMessage = 'Google Sheets request failed.';
    try {
      const errorBody = (await response.json()) as GoogleApiStructuredError;
      if (errorBody.error?.message) {
        errorMessage = errorBody.error.message;
      }
    } catch {
      // Ignore JSON parsing failures and use the fallback message.
    }
    throw new GoogleSheetsRequestError(response.status, errorMessage);
  }

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
