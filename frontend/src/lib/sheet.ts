import { apiFetch } from './api';

/**
 * The account's own Google spreadsheet.
 *
 * One spreadsheet per account, with two tabs of the app's: All, first, which
 * every job page reads and writes unless another is picked, and Temp For AI.
 * The backend allocates it in the background at sign-in and again on this
 * read, so the first call after a new account is created can take a few
 * seconds and every one after it is quick.
 */

export type SheetVisibility = 'public' | 'private';

/**
 * A tab name the sheet already used for a tab of the person's own (not laid
 * out as a job tab), which the app therefore left alone instead of making its
 * All or Temp For AI there - with the sentence the page says it in.
 */
export type SheetTabConflict = {
  tabs: string[];
  message: string;
};

export type AccountSheet = {
  /** False when the server has no Google service account key. Not an error. */
  configured: boolean;
  /** Present only when configured is false: what an operator needs to set. */
  message?: string;
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  visibility?: SheetVisibility;
  /** `All`: the tab a job page uses unless another is picked. */
  defaultTab: string;
  /** A link that opens All rather than whichever tab Google opens first. Absent while All is not the app's. */
  defaultTabUrl?: string;
  /** `Temp For AI`. */
  tempTab: string;
  tempTabUrl?: string;
  /** Present when All or Temp For AI is a tab of the person's own, left alone. */
  conflict?: SheetTabConflict;
};

export const sheetApi = {
  /**
   * `recheck` asks the server to look at a tab name clash again, so a tab the
   * person renamed is replaced by the job tab now. Only the Job Sheet page
   * asks - the shell reads this on every page load, and a look costs Google
   * reads for as long as the clash stays.
   */
  get: (options: { recheck?: boolean } = {}) => apiFetch<AccountSheet>(options.recheck ? '/sheet?recheck=1' : '/sheet'),
  setVisibility: (visibility: SheetVisibility) =>
    apiFetch<{ visibility: SheetVisibility }>('/sheet/visibility', {
      method: 'POST',
      body: JSON.stringify({ visibility }),
    }),
};

/**
 * Reading the range fields a person types: `A`, `AA`, `12`.
 *
 * Here because three pages and two modals ask for the same four fields - a
 * from-column, a to-column, a start row and an end row - and each had written
 * its own copy of these, byte for byte. They throw rather than returning a
 * sentinel because every caller is inside a submit handler that already catches
 * and shows the message, and `label` is the field's own name so the message
 * names the field the person got wrong.
 */

/** `A` -> 1, `Z` -> 26, `AA` -> 27. Throws if it is not spreadsheet letters. */
export function parseSpreadsheetColumnInput(label: string, value: string): number {
  const normalized = value.trim().toUpperCase();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  if (!/^[A-Z]+$/.test(normalized)) {
    throw new Error(`${label} must use spreadsheet letters like A, B, or AA.`);
  }

  let columnNumber = 0;
  for (const character of normalized) {
    columnNumber = (columnNumber * 26) + (character.charCodeAt(0) - 64);
  }

  return columnNumber;
}

/** The inverse: 1 -> `A`, 27 -> `AA`. Zero and below give an empty string. */
export function toSpreadsheetColumnLabel(columnNumber: number): string {
  let current = columnNumber;
  let label = '';

  while (current > 0) {
    const remainder = (current - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    current = Math.floor((current - 1) / 26);
  }

  return label;
}

/** A row number as typed. Throws on anything that is not 1 or more. */
export function parsePositiveWholeNumber(label: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive whole number.`);
  }
  return parsed;
}
