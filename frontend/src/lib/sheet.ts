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
};

export const sheetApi = {
  get: () => apiFetch<AccountSheet>('/sheet'),
  setVisibility: (visibility: SheetVisibility) =>
    apiFetch<{ visibility: SheetVisibility }>('/sheet/visibility', {
      method: 'POST',
      body: JSON.stringify({ visibility }),
    }),
};
