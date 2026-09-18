import {
  addSheetTabWithHeaders,
  createSpreadsheet,
  getSpreadsheetVisibility,
  isGoogleSheetsConfigured,
  setSpreadsheetVisibility,
  shareSpreadsheetWithEmail,
  type CreatedSpreadsheet,
  type SheetVisibility,
} from '../../integrations/googleSheets';
import {
  getUserById,
  listAccountsWithoutSheet,
  recordAccountSheet,
  recordSheetTabDate,
} from '../../database/userRepository';
import type { UserAccount } from '../../types/account';

/**
 * One spreadsheet per account, one tab per day.
 *
 * Both halves are skip-if-exists, and that is the whole contract: an account
 * that has a spreadsheet keeps it, and a day that has a tab does not get a
 * second one. Everything else here exists to make that true when two callers
 * arrive at once, when Google is down, or when the install has no key at all.
 *
 * Nothing in this module may throw at a caller who is signing somebody in. A
 * spreadsheet is a convenience; being able to log in is not.
 */

export type AccountSheetState = {
  /** False when this install has no service-account key. Not an error. */
  configured: boolean;
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  /** The `MM/DD/YYYY` tab for today, whether or not it was just created. */
  todayTab: string;
};

/**
 * The Google calls this service makes, as an interface.
 *
 * Injected rather than imported directly so the tests can drive the whole
 * allocation - the races, the retries, the skip paths - without a network. The
 * default is the real integration, so production wires itself.
 */
export type SheetsClient = {
  isConfigured(): Promise<boolean>;
  createSpreadsheet(title: string): Promise<CreatedSpreadsheet>;
  addSheetTabWithHeaders(spreadsheetId: string, title: string): Promise<number | null>;
  shareSpreadsheetWithEmail(spreadsheetId: string, email: string): Promise<void>;
  getSpreadsheetVisibility(spreadsheetId: string): Promise<SheetVisibility>;
  setSpreadsheetVisibility(spreadsheetId: string, visibility: SheetVisibility): Promise<SheetVisibility>;
};

const realClient: SheetsClient = {
  isConfigured: isGoogleSheetsConfigured,
  createSpreadsheet,
  addSheetTabWithHeaders: (spreadsheetId, title) => addSheetTabWithHeaders(spreadsheetId, title),
  shareSpreadsheetWithEmail,
  getSpreadsheetVisibility,
  setSpreadsheetVisibility,
};

let client: SheetsClient = realClient;

export function setSheetsClientForTests(next: SheetsClient): void {
  client = next;
}

export function resetSheetsClientForTests(): void {
  client = realClient;
}

/**
 * Today, as the tab is named.
 *
 * `SHEET_TIMEZONE` matters more than it looks. A server running in UTC rolls
 * the day over at midnight UTC, which for a user in New York is seven in the
 * evening - so an evening's work would land on tomorrow's tab. Naming the zone
 * the users actually live in is what keeps a day's rows together.
 */
export function todaySheetTitle(at: Date = new Date()): string {
  const timeZone = process.env.SHEET_TIMEZONE?.trim();
  const options: Intl.DateTimeFormatOptions = {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  };
  try {
    return new Intl.DateTimeFormat('en-US', options).format(at);
  } catch {
    // An unknown zone name throws rather than falling back, and a bad env var
    // must not be able to stop a sign-in.
    console.warn(`[sheets] SHEET_TIMEZONE="${timeZone}" is not a zone this runtime knows; using the server's.`);
    return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(at);
  }
}

function spreadsheetTitleFor(account: UserAccount): string {
  return `Free Tailor - ${account.email}`;
}

/**
 * In-flight allocations, keyed by account.
 *
 * A sign-in and the Account page loading beside it both call this, and without
 * the join the two would each create a spreadsheet before either had written
 * one. The conditional write in `recordAccountSheet` is the second line of
 * defence; this is the one that usually does the work.
 */
const inFlight = new Map<string, Promise<AccountSheetState>>();

export function ensureAccountSheet(account: UserAccount): Promise<AccountSheetState> {
  const existing = inFlight.get(account.id);
  if (existing) return existing;

  const run = ensure(account).finally(() => {
    inFlight.delete(account.id);
  });
  inFlight.set(account.id, run);
  return run;
}

async function ensure(account: UserAccount): Promise<AccountSheetState> {
  const todayTab = todaySheetTitle();

  if (!(await client.isConfigured())) {
    return { configured: false, todayTab };
  }

  // Re-read rather than trusting the argument: the caller may be holding an
  // account object from before this same function allocated a sheet for it.
  const current = getUserById(account.id) ?? account;
  let spreadsheetId = current.sheetId ?? '';
  let spreadsheetUrl = current.sheetUrl ?? '';

  if (!spreadsheetId) {
    const created = await client.createSpreadsheet(spreadsheetTitleFor(current));

    if (recordAccountSheet(current.id, created.spreadsheetId, created.spreadsheetUrl)) {
      spreadsheetId = created.spreadsheetId;
      spreadsheetUrl = created.spreadsheetUrl;

      // After the claim, never before it: if sharing fails we still want the
      // spreadsheet on the row, because the alternative is creating a fresh one
      // on every attempt and leaving a trail of unreachable files in Drive.
      try {
        await client.shareSpreadsheetWithEmail(spreadsheetId, current.email);
        await client.setSpreadsheetVisibility(spreadsheetId, 'public');
      } catch (error) {
        console.warn(
          `[sheets] Created ${spreadsheetId} for ${current.email} but could not finish sharing it. ` +
            'The owner can fix the sharing from the account page.',
          error
        );
      }
    } else {
      // Somebody else claimed the slot while this call was talking to Google.
      const winner = getUserById(current.id);
      spreadsheetId = winner?.sheetId ?? '';
      spreadsheetUrl = winner?.sheetUrl ?? '';
      console.warn(
        `[sheets] Two allocations raced for ${current.email}; keeping ${spreadsheetId}. ` +
          `Spreadsheet ${created.spreadsheetId} is unreferenced and can be deleted.`
      );
    }
  }

  if (!spreadsheetId) {
    // Only reachable if the winning write vanished between the two statements.
    return { configured: true, todayTab };
  }

  const known = getUserById(current.id)?.sheetTabDate;
  if (known !== todayTab) {
    // Returns null when the tab is already there, which is not a failure - it is
    // the ordinary answer for an account whose row simply had not caught up.
    await client.addSheetTabWithHeaders(spreadsheetId, todayTab);
    recordSheetTabDate(current.id, todayTab);
  }

  return { configured: true, spreadsheetId, spreadsheetUrl, todayTab };
}

/** Allocation plus the current sharing state, which is what the UI needs. */
export async function describeAccountSheet(
  account: UserAccount
): Promise<AccountSheetState & { visibility?: SheetVisibility }> {
  const state = await ensureAccountSheet(account);
  if (!state.spreadsheetId) return state;
  return { ...state, visibility: await client.getSpreadsheetVisibility(state.spreadsheetId) };
}

/** Flips link sharing, and reports what Drive says afterwards rather than what was asked for. */
export async function setAccountSheetVisibility(
  account: UserAccount,
  visibility: SheetVisibility
): Promise<SheetVisibility> {
  const state = await ensureAccountSheet(account);
  if (!state.spreadsheetId) {
    throw new Error('This account has no spreadsheet yet. Try again in a moment.');
  }
  return client.setSpreadsheetVisibility(state.spreadsheetId, visibility);
}

/**
 * Gives a spreadsheet to accounts that predate this feature.
 *
 * Serial, with a pause, because an install with two hundred accounts would
 * otherwise open two hundred conversations with Drive the moment it booted and
 * be rate-limited for its trouble. Best-effort throughout: anyone this misses is
 * picked up by their next sign-in, which runs the same function.
 */
export async function backfillAccountSheets(pauseMs = 250): Promise<{ done: number; failed: number }> {
  if (process.env.SHEET_BACKFILL === 'off') return { done: 0, failed: 0 };
  if (!(await client.isConfigured())) return { done: 0, failed: 0 };

  const pending = listAccountsWithoutSheet();
  if (pending.length === 0) return { done: 0, failed: 0 };

  console.log(`[sheets] Allocating spreadsheets for ${pending.length} account(s) from before this build.`);
  let done = 0;
  let failed = 0;

  for (const account of pending) {
    try {
      await ensureAccountSheet(account);
      done += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[sheets] Could not allocate a spreadsheet for ${account.email}.`, error);
    }
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }

  console.log(`[sheets] Backfill finished: ${done} allocated, ${failed} left for next time.`);
  return { done, failed };
}
