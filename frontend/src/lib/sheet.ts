import { apiFetch } from './api';

/**
 * The account's own Google spreadsheet.
 *
 * One spreadsheet per account, one tab per day, named `MM/DD/YYYY`. The backend
 * allocates it in the background at sign-in and again on this read, so the
 * first call after a new account is created can take a few seconds and every
 * one after it is quick.
 */

export type SheetVisibility = 'public' | 'private';

export type AccountSheet = {
  /** False when the server has no Google service account key. Not an error. */
  configured: boolean;
  /** Present only when configured is false: what an operator needs to set. */
  message?: string;
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  visibility?: SheetVisibility;
  /** Today's tab, whether or not this call is what created it. */
  todayTab: string;
  /** A link that opens today's tab rather than whichever Google opens first. */
  todayTabUrl?: string;
};

export const sheetApi = {
  get: () => apiFetch<AccountSheet>('/sheet'),
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
