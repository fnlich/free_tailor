import type { UserAccount } from '../../types/account';
import { ensureAccountSheet, resolveAddressableSheet, resolveAddressableTab } from './accountSheet';

/**
 * Where a job route reads and writes, when the caller does not say.
 *
 * Every job route used to make the browser supply a spreadsheet id, a tab name
 * and four column numbers. Now that each account owns a spreadsheet with a
 * known layout, all of it is answerable from the account itself: the
 * spreadsheet is the account's own (any other id is 404, an administrator's
 * included - the saved shared sheets are gone, owner decision S1), the tab is
 * the one named or All, and the columns are the job sheet's own.
 */

export type JobSheetTarget = {
  spreadsheetId: string;
  tabName: string;
};

export async function resolveJobSheetTarget(
  account: UserAccount,
  body: Record<string, unknown> | undefined,
  options: { verifyTab?: boolean } = {}
): Promise<JobSheetTarget> {
  // Verifying for a route about to write: the stored layout alone cannot tell
  // us All is still there, and a write to a tab Google does not have fails
  // the whole run. A reading route trusts it, and is told by Google if not.
  const state = await ensureAccountSheet(account, { verifyTab: options.verifyTab === true });
  const spreadsheetId = await resolveAddressableSheet(account, body?.sheetId, state);
  return { spreadsheetId, tabName: resolveAddressableTab(body?.tabName) };
}
