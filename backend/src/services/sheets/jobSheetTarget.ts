import { getAppSettings } from '../../config/aiModelConfig';
import { JOB_SHEET_FIRST_DATA_ROW } from '../../integrations/googleSheets';
import type { UserAccount } from '../../types/account';
import {
  ensureAccountSheet,
  resolveAddressableSheet,
  resolveAddressableTab,
} from './accountSheet';

/**
 * Where a job route should read and write, when the caller does not say.
 *
 * Every job route used to make the browser supply a spreadsheet id, a tab name
 * and four column numbers. Now that each account owns a spreadsheet with a
 * known layout, all six are answerable from the account itself - and a caller
 * who does supply an id has it checked rather than trusted.
 */

export type JobSheetTarget = {
  spreadsheetId: string;
  tabName: string;
};

/**
 * The shared sources an admin configured, which only an admin may address.
 *
 * Read through `getAppSettings` rather than kept anywhere here, so an id
 * removed from the admin page stops being addressable on the next request
 * rather than at the next restart.
 */
export async function adminAllowedSheetIds(account: UserAccount): Promise<string[]> {
  if (account.role !== 'admin') return [];
  try {
    const settings = await getAppSettings();
    return settings.googleSheetsSources.map((source) => source.sheetId).filter(Boolean);
  } catch (error) {
    // A settings read that fails must narrow what is allowed, never widen it.
    console.warn('[sheets] Could not read the configured sheet sources; allowing none.', error);
    return [];
  }
}

export async function resolveJobSheetTarget(
  account: UserAccount,
  body: Record<string, unknown> | undefined
): Promise<JobSheetTarget> {
  // Resolved once and handed to both, rather than each fetching it: two calls
  // would be two independent answers to "what is today's tab", and on the
  // stroke of midnight they would not have to agree.
  const state = await ensureAccountSheet(account);
  const spreadsheetId = await resolveAddressableSheet(
    account,
    body?.sheetId,
    await adminAllowedSheetIds(account),
    state
  );
  const tabName = await resolveAddressableTab(account, spreadsheetId, body?.tabName, state);
  return { spreadsheetId, tabName };
}

/** A column the caller named, or the one the job sheet layout puts it in. */
export function resolveColumn(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The first row to write, when the caller does not choose one.
 *
 * Appends rather than starting at the top. Defaulting to row 2 would be correct
 * exactly once per tab and would overwrite the morning's rows every run after
 * that - the existing columns are already fetched for de-duplication, so their
 * length is the honest answer and costs nothing extra.
 */
export function resolveAppendRow(value: unknown, existingColumns: Array<{ values: unknown[] }>): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;

  const used = Math.max(0, ...existingColumns.map((column) => column.values.length));
  return Math.max(JOB_SHEET_FIRST_DATA_ROW, used + 1);
}
