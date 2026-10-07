import { sheetBackfillPauseMs } from '../../config/operational';
import {
  a1Rows,
  addSheetTabWithHeaders,
  batchGetValues,
  createSpreadsheet,
  describeCredentialInUse,
  getAccessToken,
  SHEETS_SCOPE,
  formatJobSheetTab,
  getSpreadsheetVisibility,
  hasPersonalGrant,
  isGoogleSheetsConfigured,
  jobTabLayoutOf,
  listSheetTabs,
  setSpreadsheetVisibility,
  shareSpreadsheetWithEmail,
  type AddTabOptions,
  type CreatedSpreadsheet,
  type EnsuredTab,
  type JobTabLayout,
  type SheetTab,
  type SheetVisibility,
} from '../../integrations/googleSheets';
import {
  getUserById,
  getUserBySheetId,
  listAccountsNeedingSheetLayout,
  listAccountsWithoutSheet,
  recordOwnerGrant,
  recordAccountSheet,
  recordSheetLayout,
} from '../../database/userRepository';
import type { UserAccount } from '../../types/account';
import { PublicError } from '../../middleware/publicError';

/**
 * One spreadsheet per account, with two tabs of its own: All and Temp For AI
 * (owner decision S2).
 *
 * Every step is skip-if-exists, and that is the whole contract: an account
 * that has a spreadsheet keeps it, and a sheet that has its two tabs does not
 * get a second of either. Everything else here exists to make that true when
 * two callers arrive at once, when Google is down, or when the install has no
 * key at all.
 *
 * A sheet an older build made - one tab per day, in its sixteen columns - is
 * given the two tabs, All first and Temp For AI second, and its daily tabs are
 * left exactly as they are: this build neither reads nor writes them (they are
 * not job tabs, `isJobSheetTab`). A tab already called All or Temp For AI that
 * is not a job tab is left alone too, and reported (`conflict`).
 *
 * Nothing in this module may throw at a caller who is signing somebody in. A
 * spreadsheet is a convenience; being able to log in is not.
 */

/** The tab a job route reads and writes when the caller names none. */
export const DEFAULT_TAB = 'All';
/** The second tab: the one an administrator's Push to Google Sheet replaces (Phase 4). */
export const TEMP_TAB = 'Temp For AI';
/** The layout this build lays an account's sheet out to: both tabs there (users.sheet_layout). */
export const SHEET_LAYOUT_VERSION = 2;

/** Tabs whose name was taken by a tab that is not a job tab, so this build left them alone. */
export type SheetTabConflict = {
  tabs: string[];
  /** For the account holder, in words they can act on. */
  message: string;
};

export type AccountSheetState = {
  /** False when this install has no service-account key. Not an error. */
  configured: boolean;
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  /** `All`: the tab a job route uses when the caller names none. */
  defaultTab: string;
  /** A link that opens the All tab. Absent while its gid is not known, or the name clashes. */
  defaultTabUrl?: string;
  /** `Temp For AI`. */
  tempTab: string;
  tempTabUrl?: string;
  /** Present when All or Temp For AI is a tab of the person's that is not a job tab. */
  conflict?: SheetTabConflict;
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
  /**
   * Adds a job tab (at `options.index`), or verifies the one of that title
   * already there - which answers `jobTab: false`, untouched, when it is not
   * a job tab.
   */
  addSheetTabWithHeaders(spreadsheetId: string, title: string, options?: AddTabOptions): Promise<EnsuredTab>;
  shareSpreadsheetWithEmail(spreadsheetId: string, email: string): Promise<void>;
  hasPersonalGrant(spreadsheetId: string, email: string): Promise<boolean>;
  getSpreadsheetVisibility(spreadsheetId: string): Promise<SheetVisibility>;
  setSpreadsheetVisibility(spreadsheetId: string, visibility: SheetVisibility): Promise<SheetVisibility>;
  /** Every tab of a spreadsheet, in Google's order, with its gid. */
  listSheetTabs(spreadsheetId: string): Promise<SheetTab[]>;
  /** Several ranges in ONE call (`batchGetValues`): every tab's row 1, for a tab listing. */
  readRanges(spreadsheetId: string, ranges: string[]): Promise<string[][][]>;
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
  addSheetTabWithHeaders: (spreadsheetId, title, options) => addSheetTabWithHeaders(spreadsheetId, title, options),
  shareSpreadsheetWithEmail,
  hasPersonalGrant,
  getSpreadsheetVisibility,
  setSpreadsheetVisibility,
  listSheetTabs,
  readRanges: (spreadsheetId, ranges) => batchGetValues(spreadsheetId, ranges),
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
 * A day as the job sheet writes it, `MM/DD/YYYY` - today unless told
 * otherwise: an export's Date column and its NO(DATE) numbering.
 *
 * `SHEET_TIMEZONE` matters more than it looks. A server running in UTC rolls
 * the day over at midnight UTC, which for a user in New York is seven in the
 * evening - so an evening's rows would be dated, and numbered, as tomorrow's.
 * Naming the zone the users actually live in is what keeps a day's rows
 * together.
 */
export function sheetDateText(at: Date = new Date()): string {
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

/** Days from Google's epoch (12/30/1899) to the Unix one. */
const SHEETS_EPOCH_OFFSET_DAYS = 25569;
const DAY_MS = 86_400_000;

/**
 * A `MM/DD/YYYY` day as the serial number a spreadsheet stores a date as -
 * what a RAW write sends so the Date column holds a real, sortable date
 * (the tab's number format shows it as `MM/DD/YYYY`). Null for anything else.
 */
export function sheetDateSerial(text: string): number | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  if (!match) return null;
  const [month, day, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(year, month - 1, day);
  const back = new Date(time);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null;
  return time / DAY_MS + SHEETS_EPOCH_OFFSET_DAYS;
}

/**
 * The day a Date cell holds, as `MM/DD/YYYY`, however it reads back: the
 * date format this app gives the column, a date somebody typed (`M/D/YYYY`,
 * `YYYY-MM-DD`), or a bare serial number whose format was lost. Null for a
 * cell that is no date.
 */
export function sheetDateOfCell(cell: unknown): string | null {
  const text = String(cell ?? '').trim();
  if (!text) return null;
  const pad = (value: number) => String(value).padStart(2, '0');
  const asText = (year: number, month: number, day: number) => {
    const formatted = `${pad(month)}/${pad(day)}/${year}`;
    return sheetDateSerial(formatted) === null ? null : formatted;
  };
  let match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (match) return asText(Number(match[3]), Number(match[1]), Number(match[2]));
  match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) return asText(Number(match[1]), Number(match[2]), Number(match[3]));
  // A serial with its format gone: five digits, 1970 onwards, whole days only.
  if (/^\d{5}$/.test(text)) {
    const serial = Number(text);
    if (serial < SHEETS_EPOCH_OFFSET_DAYS) return null;
    const at = new Date((serial - SHEETS_EPOCH_OFFSET_DAYS) * DAY_MS);
    return asText(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
  }
  return null;
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
   * Ask Google whether the All and Temp For AI tabs are really there, instead
   * of trusting the stored layout - and put back whichever is gone.
   *
   * Off by default, and deliberately off for sign-in: with the grant already
   * confirmed, the stored layout is the last thing between a repeat sign-in
   * and zero network calls. But the sheet is one anybody with the link may
   * edit, so a tab can be renamed or deleted under us, and a job route that
   * then writes to a tab name Google does not have fails the whole run. The
   * job routes are already several calls deep, so one listing is
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

/** The state a stored row describes, with no Google call. */
function stateOf(row: UserAccount | null, spreadsheetId: string, spreadsheetUrl: string): AccountSheetState {
  const link = (gid: string | undefined) =>
    gid && /^\d+$/.test(gid) ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${gid}` : undefined;
  const allUrl = link(row?.sheetAllGid);
  const tempUrl = link(row?.sheetTempGid);
  const laidOut = (row?.sheetLayout ?? 0) >= SHEET_LAYOUT_VERSION;
  const clashing = laidOut ? [...(allUrl ? [] : [DEFAULT_TAB]), ...(tempUrl ? [] : [TEMP_TAB])] : [];
  return {
    configured: true,
    spreadsheetId,
    spreadsheetUrl,
    defaultTab: DEFAULT_TAB,
    ...(allUrl ? { defaultTabUrl: allUrl } : {}),
    tempTab: TEMP_TAB,
    ...(tempUrl ? { tempTabUrl: tempUrl } : {}),
    ...(clashing.length > 0 ? { conflict: describeConflict(clashing) } : {}),
  };
}

/**
 * What the Job Sheet page says about a name clash - and, with `retry` ("push
 * again"), what an action refused over one says: the same sentence, ending in
 * what the reader does next there.
 */
export function describeConflict(tabs: string[], retry?: string): SheetTabConflict {
  const named = tabs.map((tab) => `"${tab}"`).join(' and ');
  const plural = tabs.length > 1;
  const then = retry ?? `reload this page to get ${plural ? 'the job tabs' : 'the job tab'} added`;
  return {
    tabs,
    message:
      `Your job sheet already has ${plural ? 'tabs' : 'a tab'} named ${named} that ${plural ? 'are' : 'is'} not laid ` +
      `out as a job tab, so ${plural ? 'they were' : 'it was'} left exactly as ${plural ? 'they are' : 'it is'}. ` +
      `Rename or delete ${plural ? 'them' : 'it'} in Google Sheets, then ${then}.`,
  };
}

async function ensure(account: UserAccount, options: EnsureOptions = {}): Promise<AccountSheetState> {
  if (!(await client.isConfigured())) {
    return { configured: false, defaultTab: DEFAULT_TAB, tempTab: TEMP_TAB };
  }

  // Re-read rather than trusting the argument: the caller may be holding an
  // account object from before this same function allocated a sheet for it.
  const current = getUserById(account.id) ?? account;
  let spreadsheetId = current.sheetId ?? '';
  let spreadsheetUrl = current.sheetUrl ?? '';

  if (!spreadsheetId) {
    // The spreadsheet arrives with All already on it, so there is never a
    // stray `Sheet1` and never a moment where the file has the wrong tab.
    const created = await client.createSpreadsheet(spreadsheetTitleFor(current), DEFAULT_TAB);

    if (recordAccountSheet(current.id, created.spreadsheetId, created.spreadsheetUrl)) {
      spreadsheetId = created.spreadsheetId;
      spreadsheetUrl = created.spreadsheetUrl;

      await client.formatJobSheetTab(spreadsheetId, created.firstTabGid);
      // Temp For AI second. Told the one tab there is, so it is not listed.
      const temp = await client.addSheetTabWithHeaders(spreadsheetId, TEMP_TAB, {
        index: 1,
        existing: [{ title: DEFAULT_TAB, gid: created.firstTabGid }],
      });
      recordSheetLayout(current.id, SHEET_LAYOUT_VERSION, created.firstTabGid, temp.jobTab === false ? null : temp.gid);

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
    return { configured: true, defaultTab: DEFAULT_TAB, tempTab: TEMP_TAB };
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
  // An older build's sheet (or one whose two tabs never landed) is laid out
  // now; a verifying call checks the two are still there. Anything else - a
  // sign-in once layout 2 is recorded - asks Google nothing.
  if ((stored?.sheetLayout ?? 0) < SHEET_LAYOUT_VERSION || options.verifyTab) {
    await layOutTabs(current.id, spreadsheetId, stored);
  }

  return stateOf(getUserById(current.id), spreadsheetId, spreadsheetUrl);
}

/**
 * Makes sure the sheet has its All (first) and Temp For AI (second) tabs:
 * ONE listing, then, for each, nothing when it is there under the gid already
 * recorded, else `addSheetTabWithHeaders` - which adds it at its place, or
 * verifies the tab of that name already there (an empty one becomes a job
 * tab) and reports one that is not a job tab, untouched. The result is
 * recorded as layout 2: a gid for each job tab, NULL for a name clash.
 *
 * Nothing else in the spreadsheet is looked at: an older build's daily tabs
 * stay as they are.
 */
async function layOutTabs(accountId: string, spreadsheetId: string, stored: UserAccount | null): Promise<void> {
  const tabs = await client.listSheetTabs(spreadsheetId);
  const laidOut = (stored?.sheetLayout ?? 0) >= SHEET_LAYOUT_VERSION;
  const place = async (title: string, index: number, recordedGid: string | undefined): Promise<number | null> => {
    const found = tabs.find((tab) => tab.title === title);
    // Already laid out, and still the very tab that was: nothing to ask.
    if (found && laidOut && recordedGid === String(found.gid)) return found.gid;
    const ensured = await client.addSheetTabWithHeaders(spreadsheetId, title, { index, existing: tabs });
    if (ensured.created) tabs.splice(Math.min(index, tabs.length), 0, { title, gid: ensured.gid });
    if (ensured.jobTab === false) {
      // Said once, when the clash is found - not again at every look the
      // Job Sheet page asks for while it stays (a recorded layout with no gid
      // for this tab IS the recorded clash).
      if (!(laidOut && recordedGid === undefined)) {
        console.warn(
          `[sheets] ${spreadsheetId} already has a tab named "${title}" that is not a job tab; it is left as it is, ` +
            'and the account is told to rename it.'
        );
      }
      return null;
    }
    return ensured.gid;
  };
  const allGid = await place(DEFAULT_TAB, 0, stored?.sheetAllGid);
  /*
   * Temp For AI goes first when All could not be placed (a name clash), so
   * that the All added at index 0 once the name is free lands it second -
   * the order owner decision S2 asks for. At index 1 it would sit behind
   * whatever tab was first (an older build's daily tab), and stay there:
   * once laid out it is never moved.
   */
  const tempGid = await place(TEMP_TAB, allGid === null ? 0 : 1, stored?.sheetTempGid);
  recordSheetLayout(accountId, SHEET_LAYOUT_VERSION, allGid, tempGid);
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

export type DescribeOptions = {
  /**
   * Look at the sheet's two tabs again (GET /api/sheet?recheck=1): a
   * verifying ensure, so the job tab is added the moment a clashing name is
   * free, and an All or Temp For AI deleted or renamed in Google Sheets is
   * put back, with the links answered for the new tab rather than the gone
   * one. Only the Job Sheet page asks: it is where the clash is reported,
   * where somebody who renamed their tab reloads, and the one page that
   * shows the sheet that every account opens - a reporter included, who has
   * no export to put a deleted All back. Every other reader - the shell on
   * every page load, Build Resumes, the job pages - is answered from the
   * stored row, because a look is a listing (plus, while a name clashes, a
   * read of the clashing tab - all of it, when its row 1 is blank) on the
   * read quota every account shares.
   */
  recheck?: boolean;
};

/** Allocation plus the current sharing state, which is what the UI needs. */
export async function describeAccountSheet(
  account: UserAccount,
  options: DescribeOptions = {}
): Promise<AccountSheetState & { visibility?: SheetVisibility }> {
  let state = await ensureAccountSheet(account);
  // Not only on a recorded clash: a tab deleted under a recorded layout
  // leaves nothing in the row to say so, and only a listing finds it.
  if (options.recheck && state.spreadsheetId) {
    try {
      state = await ensureAccountSheet(account, { verifyTab: true });
    } catch (error) {
      // The look is a courtesy: Google refusing it must not take away the
      // page that reports the clash, or the sheet's link. The stored row
      // still says what is true as far as anybody here knows.
      console.warn(`[sheets] Could not look at ${account.email}'s job sheet tabs again; answering from what is recorded.`, error);
    }
  }
  if (!state.spreadsheetId) return state;
  return { ...state, visibility: await client.getSpreadsheetVisibility(state.spreadsheetId) };
}

/**
 * A refusal about the caller's own spreadsheet, so it is public. One that only
 * an administrator can fix says so generically, and carries the reason as
 * `detail`.
 */
export class SheetAccessError extends PublicError {
  constructor(message: string, status = 409, detail?: string) {
    super(message, { status, ...(detail ? { detail } : {}) });
    this.name = 'SheetAccessError';
  }
}

/**
 * Job sheets need Google Sheets set up on the server, which nobody but an
 * administrator can do - so the reader is pointed there, not at a settings
 * page that would only tell them the same, and the ref's log line and an
 * administrator's response carry the cause.
 */
function sheetsNotConfigured(): SheetAccessError {
  return new SheetAccessError(
    "Job sheets aren't available right now. Please contact your administrator.",
    503,
    'Google Sheets is not configured on this server (no Google credential file). GET /api/sheet as an ' +
      'administrator, or "npm run sheets:doctor" in backend/, shows what is missing.'
  );
}

/**
 * Why a job route will not use a tab: it is not a job tab - an older build's
 * daily tab, a tab of the person's own, a tab with data under a blank row 1 -
 * and the app neither reads its columns as a job sheet's nor writes into it.
 * `cannot` completes "so it cannot be ..." (`reported from`, `exported into`,
 * `filtered`). A 409, code `not-job-tab`.
 */
export function notJobTabSentence(tabName: string, cannot: string): string {
  return (
    `"${tabName}" is not laid out as a job sheet tab, so it cannot be ${cannot}. Choose ${DEFAULT_TAB} or ` +
    `${TEMP_TAB}, or an empty tab, which is laid out as one the first time it is used.`
  );
}

export function notJobTabError(tabName: string, cannot: string): PublicError {
  return new PublicError(notJobTabSentence(tabName, cannot), { status: 409, code: 'not-job-tab' });
}

/** Flips link sharing, and reports what Drive says afterwards rather than what was asked for. */
export async function setAccountSheetVisibility(
  account: UserAccount,
  visibility: SheetVisibility
): Promise<SheetVisibility> {
  const state = await ensureAccountSheet(account);
  if (!state.configured) throw sheetsNotConfigured();
  if (!state.spreadsheetId) {
    throw new SheetAccessError('This account has no spreadsheet yet. Try again in a moment.', 503);
  }

  // Refused rather than attempted. Going private withdraws the link, so if the
  // personal grant is missing this is the request that locks somebody out of
  // their own spreadsheet - and the UI has no way back from that.
  if (visibility === 'private' && !(await ensureOwnerAccess(state.spreadsheetId, account.email))) {
    // The owner is told what is at stake and who can fix it; the likely cause
    // is about the server's Google project, which is the administrator's.
    throw new SheetAccessError(
      'This sheet cannot be made private yet: your account does not have its own access to it, ' +
        'so withdrawing the link would lock you out. Please contact your administrator.',
      409,
      `${account.email} has no grant of its own on spreadsheet ${state.spreadsheetId}, so it was ` +
        "not made private. This usually means the Drive API is not enabled for the server's " +
        'Google project; run "npm run sheets:doctor" in backend/ to see which step fails.'
    );
  }

  return client.setSpreadsheetVisibility(state.spreadsheetId, visibility);
}

/**
 * Which spreadsheet this person is allowed to point a job route at: their
 * own, and nothing else (owner decision S1).
 *
 * The guard exists because the service account OWNS every account's
 * spreadsheet, so a route taking an id on trust would read - and write -
 * anybody's sheet for anybody who knows the id. Sheets can be link-shared, so
 * the id travels in a URL people pass around, and the private toggle does not
 * help: these routes reach Google as the service account rather than as the
 * person. An administrator is no exception: the saved "shared sources" an
 * administrator could once name here are gone, and any id but their own
 * sheet's is refused like anybody's.
 *
 * Anything else is NOT FOUND rather than forbidden, because the difference
 * between those two answers confirms that a given spreadsheet exists.
 */
export async function resolveAddressableSheet(
  account: UserAccount,
  requested: unknown,
  known?: AccountSheetState
): Promise<string> {
  const state = known ?? (await ensureAccountSheet(account));
  const own = state.spreadsheetId ?? '';
  const asked = typeof requested === 'string' ? requested.trim() : '';

  // The common case, and the one the UI takes: say nothing, get your own.
  if (!asked) {
    if (!state.configured) throw sheetsNotConfigured();
    if (!own) {
      throw new SheetAccessError(
        'Your job sheet is not ready yet. Open Settings > Job Sheet to finish setting it up.',
        503
      );
    }
    return own;
  }

  if (own && asked === own) return own;
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

/** A tab as a listing reports it: its title, gid, and what its row 1 says it is (`jobTabLayoutOf`). */
export type ListedSheetTab = SheetTab & { layout: JobTabLayout };

export type AddressableSheetTabs = {
  spreadsheetId: string;
  /** Every tab, in the spreadsheet's own order, each with its layout. */
  tabs: ListedSheetTab[];
  /**
   * The tab a picker should start on: All when it is a job tab (or still
   * blank), else the first job tab, else the first blank one - never a tab
   * that is not a job tab. Null when there is none.
   */
  defaultTab: string | null;
};

/**
 * The tabs of the caller's own spreadsheet (`resolveAddressableSheet`, so any
 * other id is 404), each with its layout from ONE batched read of every tab's
 * row 1 - which a picker uses to offer only the job tabs, and to say why an
 * older build's daily tab is not offered.
 *
 * What the builder's sheet panel lists in its Tab select, and the reporter's.
 */
export async function listAddressableSheetTabs(account: UserAccount, requested: unknown): Promise<AddressableSheetTabs> {
  const state = await ensureAccountSheet(account);
  const spreadsheetId = await resolveAddressableSheet(account, requested, state);
  const tabs = await client.listSheetTabs(spreadsheetId);
  const firstRows = tabs.length > 0 ? await client.readRanges(spreadsheetId, tabs.map((tab) => a1Rows(tab.title, 1, 1))) : [];
  const listed: ListedSheetTab[] = tabs.map((tab, index) => ({
    title: tab.title,
    gid: tab.gid,
    layout: jobTabLayoutOf(firstRows[index]?.[0] ?? []),
  }));
  const usable = (layout: JobTabLayout) => listed.find((tab) => tab.layout === layout)?.title;
  const all = listed.find((tab) => tab.title === DEFAULT_TAB && tab.layout !== 'other');
  const defaultTab = all?.title ?? usable('job') ?? usable('blank') ?? null;
  return { spreadsheetId, tabs: listed, defaultTab };
}

/** The tab a job route reads and writes when the caller names none: All. */
export function resolveAddressableTab(requested: unknown): string {
  const asked = typeof requested === 'string' ? requested.trim() : '';
  return asked || DEFAULT_TAB;
}

/**
 * Gives a spreadsheet to accounts that predate this feature, and the All and
 * Temp For AI tabs to sheets an older build laid out one tab per day.
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

  // Accounts with no sheet yet, then sheets an older build laid out (daily
  // tabs), which are given All and Temp For AI the same way a sign-in would.
  const pending = [...listAccountsWithoutSheet(), ...listAccountsNeedingSheetLayout(SHEET_LAYOUT_VERSION)];

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

  console.log(
    `[sheets] Preparing the job sheets of ${pending.length} account(s) from before this build (a spreadsheet, ` +
      'or its All and Temp For AI tabs).'
  );
  let done = 0;
  let failed = 0;

  for (const account of pending) {
    try {
      await ensureAccountSheet(account);
      done += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[sheets] Could not prepare the job sheet of ${account.email}.`, error);
    }
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }

  console.log(`[sheets] Backfill finished: ${done} prepared, ${failed} left for next time.`);
  return { done, failed };
}
