import { sheetBackfillPauseMs } from '../../config/operational';
import {
  addSheetTabWithHeaders,
  createSpreadsheet,
  describeCredentialInUse,
  getAccessToken,
  SHEETS_SCOPE,
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
  recordOwnerGrant,
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
  /**
   * Proves the credential is accepted, before anything is attempted with it.
   *
   * On the seam rather than imported directly, which the other eight already
   * were, because the backfill now STOPS when this throws - and a check that
   * reached past the seam would fail every test that drives the allocation
   * against a fake, while the fake's own calls carried on working. Configured
   * and accepted are different questions: `isConfigured` asks whether a
   * credential exists, this asks whether Google will take it.
   */
  checkCredential(): Promise<void>;
  createSpreadsheet(title: string, firstTabTitle: string): Promise<CreatedSpreadsheet>;
  formatJobSheetTab(spreadsheetId: string, gid: number): Promise<void>;
  addSheetTabWithHeaders(spreadsheetId: string, title: string): Promise<EnsuredTab>;
  shareSpreadsheetWithEmail(spreadsheetId: string, email: string): Promise<void>;
  hasPersonalGrant(spreadsheetId: string, email: string): Promise<boolean>;
  getSpreadsheetVisibility(spreadsheetId: string): Promise<SheetVisibility>;
  setSpreadsheetVisibility(spreadsheetId: string, visibility: SheetVisibility): Promise<SheetVisibility>;
};

const warnedVisibility = new Set<string>();

/**
 * Whether a newly allocated spreadsheet is link-shared.
 *
 * `public` on this app's Drive means **anyone with the link may EDIT** - see
 * `setSpreadsheetVisibility` - and the sheet holds one person's job search:
 * companies, roles, dates. On an installation anybody can sign up to, the URL
 * would be the only thing between a stranger and that, so the default is
 * `private` and the account holder reaches theirs through the per-account writer
 * grant instead.
 *
 * The validation is DELIBERATELY ASYMMETRIC: only the exact string `public`
 * opens a sheet up, and everything else - a typo, a casing slip, `yes`, `1`,
 * empty - resolves to `private` with a warning. A misread value must fail towards
 * the safe answer, because the unsafe one cannot be taken back once a link is
 * out.
 *
 * Per-account sharing is unaffected: `POST /sheet/visibility` still flips either
 * way whenever somebody wants their own sheet shared.
 */
export function defaultSheetVisibility(env: NodeJS.ProcessEnv = process.env): SheetVisibility {
  const raw = (env.SHEET_DEFAULT_VISIBILITY ?? '').trim();
  if (!raw || raw === 'private') return 'private';
  if (raw === 'public') return 'public';

  // Once per distinct value, not once per allocation: this is read every time an
  // account gets a sheet, and a misconfigured install would otherwise warn on
  // every new sign-up. Not `services/ai/telemetry`'s warnOnce, which prefixes
  // `[ai]` - a sheets problem filed under the AI layer sends the next reader to
  // the wrong place.
  if (!warnedVisibility.has(raw)) {
    warnedVisibility.add(raw);
    console.warn(
      `[sheets] SHEET_DEFAULT_VISIBILITY="${raw}" is not "private" or "public". Treating it as ` +
        '"private", because a value nobody meant must not link-share everybody\'s job rows.'
    );
  }
  return 'private';
}

const realClient: SheetsClient = {
  isConfigured: isGoogleSheetsConfigured,
  checkCredential: async () => {
    await getAccessToken(SHEETS_SCOPE);
  },
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
  // Still the old name, deliberately. This is a STORED title on every
  // spreadsheet ever allocated, and Drive sorts by it: renaming it here
  // would not touch the existing files, so new accounts' sheets would
  // simply file themselves somewhere else in the operator's Drive. Change
  // it only alongside a pass that renames what is already out there.
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
   * Off by default, and deliberately off for sign-in: with the grant already
   * confirmed, the stored date is the last thing between a repeat sign-in and
   * zero network calls. But the sheet is one anybody
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

      /*
       * Link sharing, ONLY here and only if asked for.
       *
       * Set on the sheet's first day and never re-asserted: doing it on every
       * ensure would quietly undo the private toggle on the next sign-in, which
       * is the opposite of what pressing it meant.
       *
       * `private` makes NO Drive call at all rather than asking for 'private'.
       * A brand-new file has no `anyone` grant to revoke, so the call could only
       * waste a round trip or fail; the account holder's own access comes from
       * the writer grant above, not from this.
       */
      if (defaultSheetVisibility() === 'public') {
        try {
          await client.setSpreadsheetVisibility(spreadsheetId, 'public');
        } catch (error) {
          console.warn(
            `[sheets] Created ${spreadsheetId} for ${current.email} but could not make it link-shared.`,
            error
          );
        }
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

  const stored = getUserById(current.id);

  // Repaired until it works, then never asked about again.
  //
  // Sharing is retried here rather than only at creation because the first run
  // of a new install is exactly when it fails - the Drive API is usually not
  // switched on yet - and a grant attempted once and lost is a person who
  // cannot open their own spreadsheet, with nothing that would ever retry.
  //
  // But confirming it costs a Drive `permissions.list`, and doing that on every
  // sign-in spends a per-minute quota asking a question whose answer has not
  // changed since the account was made. So the answer is remembered. An install
  // whose Drive API was off still repairs itself the moment it is switched on;
  // it just stops paying for the guarantee afterwards.
  //
  // The cost of remembering: a grant revoked in Google's own UI later will not
  // be noticed here. `setAccountSheetVisibility` still checks live before going
  // private, which is the one request where a stale belief locks somebody out.
  if (!stored?.sheetSharedAt) {
    if (await ensureOwnerAccess(spreadsheetId, current.email)) {
      recordOwnerGrant(current.id, new Date().toISOString());
    }
  }
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
 * Never fatal, and retried on EVERY ensure - so a transient failure heals itself
 * on the account's next sign-in rather than needing anybody to intervene.
 *
 * What the worst case is depends on the default, and it changed when that did.
 * While new sheets were link-shared, a failure here left a sheet that stayed
 * public: reachable, if too reachable. Now that they are private, a failure
 * leaves a sheet its own account holder cannot open - the file exists, the row
 * points at it, and only this app's Drive identity has access. That is a worse
 * experience and a better accident: the alternative was publishing somebody's
 * job search to anyone with the URL because a Drive call failed. It is also
 * almost always one cause - the Drive API not enabled for the server's project -
 * which `npm run sheets:doctor` names outright.
 *
 * The private TOGGLE still refuses while this has not succeeded (below), because
 * there the sheet IS public and withdrawing the link would take away the only
 * access that works.
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
        'Your job sheet is not ready yet. Open Settings > Job Sheet to finish setting it up.',
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
 *
 * The pause is SHEET_BACKFILL_PAUSE_MS, 250ms by default. The quota it paces
 * against belongs to the operator's own Cloud project and depends on that
 * project's plan, so it is theirs to tune; 0 means no pause.
 */
export async function backfillAccountSheets(
  pauseMs: number = sheetBackfillPauseMs()
): Promise<{ done: number; failed: number }> {
  if (process.env.SHEET_BACKFILL === 'off') return { done: 0, failed: 0 };
  if (!(await client.isConfigured())) return { done: 0, failed: 0 };

  const pending = listAccountsWithoutSheet();

  /*
   * The credential is checked FIRST, and a refusal ends the backfill.
   *
   * Said before anything else because the commonest cause of a failure here is a
   * key that is not the one somebody just installed, and that is indistinguishable
   * from a misconfigured project once the per-account errors start arriving.
   *
   * It RETURNS rather than falling through, which it used not to. Every account
   * below needs this same token, so a credential Google refused - an expired
   * consent, a deleted service account - fails all of them for one reason, and
   * the loop would report it once per account with the default 250ms pause
   * between. Two hundred sheet-less accounts meant fifty seconds of startup
   * spent failing and two hundred and one warnings for a single dead token. One
   * line an operator can act on is worth more than all of them.
   */
  try {
    await client.checkCredential();
    const using = describeCredentialInUse();
    if (using) console.log(`[sheets] Using ${using}.`);
  } catch (error) {
    console.warn(
      '[sheets] Could not load the Google credentials, so no spreadsheet can be allocated ' +
        `(${pending.length} account(s) waiting). Run "npm run sheets:doctor" in backend/ to see ` +
        'which step is broken.',
      error
    );
    return { done: 0, failed: pending.length };
  }

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
