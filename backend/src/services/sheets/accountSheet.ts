import {
  addSheetTabWithHeaders,
  createSpreadsheet,
  formatJobSheetTab,
  getSpreadsheetVisibility,
  hasPersonalGrant,
  isGoogleSheetsConfigured,
  setSpreadsheetVisibility,
  shareSpreadsheetWithEmail,
  type CreatedSpreadsheet,
  type EnsuredTab,
  type SheetVisibility,
} from '../../integrations/googleSheets';
import {
  getUserById,
  getUserBySheetId,
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
  /**
   * A link that opens today's tab rather than whichever one Google shows first.
   * Absent when the gid is not known - an upgraded row from before it was
   * stored, or a day whose tab this call did not touch.
   */
  todayTabUrl?: string;
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
  createSpreadsheet(title: string, firstTabTitle: string): Promise<CreatedSpreadsheet>;
  formatJobSheetTab(spreadsheetId: string, gid: number): Promise<void>;
  addSheetTabWithHeaders(spreadsheetId: string, title: string): Promise<EnsuredTab>;
  shareSpreadsheetWithEmail(spreadsheetId: string, email: string): Promise<void>;
  hasPersonalGrant(spreadsheetId: string, email: string): Promise<boolean>;
  getSpreadsheetVisibility(spreadsheetId: string): Promise<SheetVisibility>;
  setSpreadsheetVisibility(spreadsheetId: string, visibility: SheetVisibility): Promise<SheetVisibility>;
};

const realClient: SheetsClient = {
  isConfigured: isGoogleSheetsConfigured,
  createSpreadsheet: (title, firstTabTitle) => createSpreadsheet(title, firstTabTitle),
  formatJobSheetTab: (spreadsheetId, gid) => formatJobSheetTab(spreadsheetId, gid),
  addSheetTabWithHeaders: (spreadsheetId, title) => addSheetTabWithHeaders(spreadsheetId, title),
  shareSpreadsheetWithEmail,
  hasPersonalGrant,
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
 * Drops the in-flight join, so a test can force the race it normally prevents.
 *
 * The join is the first line of defence and the conditional write is the second
 * - and the second is only reachable once the first is out of the way, which no
 * amount of ordinary concurrency can arrange.
 */
export function resetInFlightForTests(): void {
  inFlight.clear();
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

export type EnsureOptions = {
  /**
   * Ask Google whether today's tab is really there, instead of trusting the
   * stored date.
   *
   * Off by default, and deliberately off for sign-in: the stored date is what
   * keeps a repeat sign-in free of network calls. But the sheet is one anybody
   * with the link may edit, so the tab can be renamed or deleted under us, and
   * a job route that then writes to a tab name Google does not have fails the
   * whole run. The job routes are already several calls deep, so one listing is
   * proportionate there and wasteful on the hot path.
   */
  verifyTab?: boolean;
};

export function ensureAccountSheet(
  account: UserAccount,
  options: EnsureOptions = {}
): Promise<AccountSheetState> {
  // A verifying call must not be satisfied by a trusting one already in flight.
  const key = options.verifyTab ? `${account.id}:verify` : account.id;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const run = ensure(account, options).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, run);
  return run;
}

async function ensure(account: UserAccount, options: EnsureOptions = {}): Promise<AccountSheetState> {
  const todayTab = todaySheetTitle();

  if (!(await client.isConfigured())) {
    return { configured: false, todayTab };
  }

  // Re-read rather than trusting the argument: the caller may be holding an
  // account object from before this same function allocated a sheet for it.
  const current = getUserById(account.id) ?? account;
  let spreadsheetId = current.sheetId ?? '';
  let spreadsheetUrl = current.sheetUrl ?? '';
  let todayGid: number | undefined;

  if (!spreadsheetId) {
    // The spreadsheet arrives with today's tab already on it, so there is never
    // a stray `Sheet1` and never a moment where the file has the wrong tab.
    const created = await client.createSpreadsheet(spreadsheetTitleFor(current), todayTab);

    if (recordAccountSheet(current.id, created.spreadsheetId, created.spreadsheetUrl)) {
      spreadsheetId = created.spreadsheetId;
      spreadsheetUrl = created.spreadsheetUrl;
      todayGid = created.firstTabGid;

      await client.formatJobSheetTab(spreadsheetId, created.firstTabGid);
      recordSheetTabDate(current.id, todayTab, created.firstTabGid);

      // Public ONLY here, on the sheet's first day. Re-asserting it on every
      // ensure would quietly undo the private toggle on the next sign-in,
      // which is the opposite of what pressing it meant.
      try {
        await client.setSpreadsheetVisibility(spreadsheetId, 'public');
      } catch (error) {
        console.warn(
          `[sheets] Created ${spreadsheetId} for ${current.email} but could not make it link-shared.`,
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

  // Sharing is repaired here, not only at creation. The first run of a new
  // install is exactly when it fails - the Drive API is usually not enabled yet
  // - and a grant that was attempted once and lost is a person who cannot open
  // their own spreadsheet, with nothing in the product that would ever retry.
  await ensureOwnerAccess(spreadsheetId, current.email);

  const stored = getUserById(current.id);
  if (stored?.sheetTabDate !== todayTab || options.verifyTab) {
    // `created: false` means the tab was already in the spreadsheet while our
    // row had not caught up - the ordinary answer, not a failure.
    const tab = await client.addSheetTabWithHeaders(spreadsheetId, todayTab);
    todayGid = tab.gid;
    recordSheetTabDate(current.id, todayTab, tab.gid);
  } else if (todayGid === undefined && stored?.sheetTabGid) {
    todayGid = Number(stored.sheetTabGid);
  }

  return {
    configured: true,
    spreadsheetId,
    spreadsheetUrl,
    todayTab,
    ...(Number.isFinite(todayGid)
      ? { todayTabUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${todayGid}` }
      : {}),
  };
}

/**
 * Makes sure the owner holds a grant of their own, repairing it if not.
 *
 * Never fatal. A failure here leaves the sheet exactly as it was, and the
 * private toggle refuses to take the link away until this has succeeded - so
 * the worst case is a sheet that stays public, not one nobody can open.
 */
async function ensureOwnerAccess(spreadsheetId: string, email: string): Promise<boolean> {
  try {
    if (await client.hasPersonalGrant(spreadsheetId, email)) return true;
    await client.shareSpreadsheetWithEmail(spreadsheetId, email);
    return true;
  } catch (error) {
    console.warn(
      `[sheets] Could not give ${email} their own access to ${spreadsheetId}. ` +
        'Sharing a file needs the Drive API enabled for the service account\'s project.',
      error
    );
    return false;
  }
}

/** Allocation plus the current sharing state, which is what the UI needs. */
export async function describeAccountSheet(
  account: UserAccount
): Promise<AccountSheetState & { visibility?: SheetVisibility }> {
  const state = await ensureAccountSheet(account);
  if (!state.spreadsheetId) return state;
  return { ...state, visibility: await client.getSpreadsheetVisibility(state.spreadsheetId) };
}

export class SheetAccessError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = 'SheetAccessError';
    this.status = status;
  }
}

/** Flips link sharing, and reports what Drive says afterwards rather than what was asked for. */
export async function setAccountSheetVisibility(
  account: UserAccount,
  visibility: SheetVisibility
): Promise<SheetVisibility> {
  const state = await ensureAccountSheet(account);
  if (!state.spreadsheetId) {
    throw new SheetAccessError('This account has no spreadsheet yet. Try again in a moment.', 503);
  }

  // Refused rather than attempted. Going private withdraws the link, so if the
  // personal grant is missing this is the request that locks somebody out of
  // their own spreadsheet - and the UI has no way back from that.
  if (visibility === 'private' && !(await ensureOwnerAccess(state.spreadsheetId, account.email))) {
    throw new SheetAccessError(
      'This sheet cannot be made private yet: your account does not have its own access to it, ' +
        'so withdrawing the link would lock you out. This usually means the Drive API is not ' +
        "enabled for the server's Google project."
    );
  }

  return client.setSpreadsheetVisibility(state.spreadsheetId, visibility);
}

/**
 * Which spreadsheet this person is allowed to point a job route at.
 *
 * The guard exists because the service account now OWNS every account's
 * spreadsheet. Before that it could only reach sheets an administrator had
 * deliberately shared with it, so a route taking an id on trust was harmless;
 * now the same route would read - and write - anybody's sheet for anybody who
 * knows the id. Sheets are public by default, so the id travels in a URL people
 * pass around, and the private toggle does not help: these routes reach Google
 * as the service account rather than as the person.
 *
 * A non-admin may address exactly one spreadsheet: their own. An admin may also
 * address the shared sources they configured. Anything else is NOT FOUND rather
 * than forbidden, because the difference between those two answers confirms
 * that a given spreadsheet exists.
 */
export async function resolveAddressableSheet(
  account: UserAccount,
  requested: unknown,
  allowedForAdmins: readonly string[] = [],
  known?: AccountSheetState
): Promise<string> {
  const state = known ?? (await ensureAccountSheet(account));
  const own = state.spreadsheetId ?? '';
  const asked = typeof requested === 'string' ? requested.trim() : '';

  // The common case, and the one the UI now takes: say nothing, get your own.
  if (!asked) {
    if (!own) {
      throw new SheetAccessError(
        'Your job sheet is not ready yet. Open the account page to finish setting it up.',
        503
      );
    }
    return own;
  }

  if (asked === own) return own;
  if (account.role === 'admin' && allowedForAdmins.some((id) => id.trim() === asked)) return asked;

  throw new SheetAccessError('That spreadsheet was not found.', 404);
}

/**
 * Refuses a spreadsheet that is some other account's personal sheet.
 *
 * A narrower guard than `resolveAddressableSheet`, for surfaces that legitimately
 * address spreadsheets this installation does not manage - the bid assistant's
 * saved sources, for one. Those may point anywhere the service account can
 * reach, and before per-account sheets existed that meant only spreadsheets
 * somebody had deliberately shared with it. Now it also means every user's own
 * sheet, so the one thing such a surface must not accept is another account's.
 *
 * Synchronous and cheap: one indexed lookup, no Google call.
 */
export function assertSheetNotOwnedByAnotherAccount(account: UserAccount, sheetId: unknown): void {
  const asked = typeof sheetId === 'string' ? sheetId.trim() : '';
  if (!asked) return;

  const owner = getUserBySheetId(asked);
  if (!owner || owner.id === account.id) return;

  // 404, like the other guard, so the status does not confirm that a
  // spreadsheet with this id exists.
  throw new SheetAccessError('That spreadsheet was not found.', 404);
}

/** The tab a job route writes to when the caller names none: today's. */
export async function resolveAddressableTab(
  account: UserAccount,
  spreadsheetId: string,
  requested: unknown,
  known?: AccountSheetState
): Promise<string> {
  const asked = typeof requested === 'string' ? requested.trim() : '';
  if (asked) return asked;

  const state = known ?? (await ensureAccountSheet(account));
  // Only meaningful for the account's own sheet; an admin naming a shared
  // source has to name its tab too, since we do not manage its layout.
  if (spreadsheetId !== state.spreadsheetId) {
    throw new SheetAccessError('A tab name is required for this spreadsheet.', 400);
  }
  return state.todayTab;
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
