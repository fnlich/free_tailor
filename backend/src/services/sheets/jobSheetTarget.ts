import { getAppSettings } from '../../config/aiModelConfig';
import { JOB_SHEET_FIRST_DATA_ROW } from '../../integrations/googleSheets';
import type { UserAccount } from '../../types/account';
import {
  ensureAccountSheet,
  resolveAddressableSheet,
  resolveAddressableTab,
  SheetAccessError,
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
  // Verifying: a job route is about to write into the tab this resolves, and
  // the stored date alone cannot tell us the tab is still there.
  const state = await ensureAccountSheet(account, { verifyTab: true });
  const spreadsheetId = await resolveAddressableSheet(
    account,
    body?.sheetId,
    await adminAllowedSheetIds(account),
    state
  );
  const tabName = await resolveAddressableTab(account, spreadsheetId, body?.tabName, state);
  return { spreadsheetId, tabName };
}

/**
 * A column the caller named, or the one the job sheet layout puts it in.
 *
 * Absent means "use the layout". Present but not a positive column number is an
 * ERROR, not a reason to fall back: silently substituting a default would take
 * a request that used to be refused with a 400 and turn it into a write to a
 * column the caller never asked for.
 */
export function resolveColumn(field: string, value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;

  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new SheetAccessError(`${field} must be a whole number greater than or equal to 1.`, 400);
  }
  return parsed;
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
  if (value !== undefined && value !== null && value !== '') {
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new SheetAccessError('startRow must be a whole number greater than or equal to 1.', 400);
    }
    return parsed;
  }

  const used = Math.max(0, ...existingColumns.map((column) => column.values.length));
  return Math.max(JOB_SHEET_FIRST_DATA_ROW, used + 1);
}
