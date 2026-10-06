import { jobFieldLabel } from '../../config/jobFields';
import {
  a1Columns,
  a1Range,
  appendValuesRaw,
  batchUpdateValuesRaw,
  createSpreadsheet,
  isGoogleSheetsConfigured,
  shareSpreadsheetWithEmail,
  type CreatedSpreadsheet,
  type SheetCellValue,
} from '../../integrations/googleSheets';
import {
  countUnsyncedLakeEntries,
  listUnsyncedLakeEntries,
  markLakeEntriesSynced,
  reopenLakeOutbox,
  type LakeEntry,
} from '../../database/jobLakeRepository';
import { getSetting, setSetting } from '../../database/settingsRepository';
import { getUserById, listUsers } from '../../database/userRepository';
import { formatSalary } from '../jobAnalysis/facts';
import { isPublicError, PublicError } from '../../middleware/publicError';

/**
 * The administrators' copy of the Job Data Lake: one spreadsheet the server
 * creates on first use (owner decision J9), and an append-only log in it of
 * every job the lake ADDED - new, or replacing an older duplicate (J10).
 *
 * THE DATABASE IS THE RECORD; the sheet follows it through an outbox. A row
 * is committed first, with `sheet_synced_at` NULL; this sync appends every
 * such row in batches (one `values:append`, RAW, per batch, through the
 * Sheets 429 backoff) and only then marks them - by id AND version, so a row
 * replaced while it was being appended keeps its new version unsynced and
 * gets its own line. A failed append never undoes or blocks anything: the
 * rows stay unsynced, the failure is kept for the admin page, and the next
 * sync - after the next report run or merge, at boot, or "Retry now" - sends
 * them. A duplicate touches neither the database's outbox nor the sheet.
 *
 * At least once, not exactly once, across a crash: a process that dies
 * between Google taking a batch and the mark landing appends that batch again
 * at its next sync. Within a process the syncs are serialised, so two never
 * send the same rows - and a sync marks a batch only while the sheet it
 * appended to is still the stored one: "Create a new admin sheet" pressed
 * mid-sync reopens the outbox for the new sheet, and the sync goes round
 * again on that rather than marking the reopened rows as sent to the old.
 *
 * The spreadsheet is shared, as a writer, with every enabled administrator's
 * email - each sync, with nothing to append or not, shares it with any
 * administrator it was not shared with yet (asking Google nothing when nobody
 * is missing). Taking an administrator off the sheet is done in Google, by
 * hand.
 */

export const ADMIN_LAKE_SHEET_KEY = 'job-lake.admin-sheet';
export const ADMIN_LAKE_SHEET_TITLE = 'Tailor - Job Data Lake';
export const ADMIN_LAKE_TAB = 'Job Lake';
export const ADMIN_LAKE_HEADERS = [
  'Company',
  'Job Field',
  'Title',
  'Salary',
  'Link',
  'Requested By',
  'Updated At',
  'Job Hash',
  // v6, columns I-K: appended, so every line an earlier sync wrote keeps its
  // columns; those lines leave the three blank ("Create a new admin sheet"
  // writes the whole lake again, with them).
  'Job Type',
  'Clearance',
  'Industry',
] as const;

/**
 * Which `ADMIN_LAKE_HEADERS` a sheet's header row holds: 1 the first eight,
 * 2 with Job Type, Clearance and Industry. A sheet stored below this has its
 * header rewritten once, before its next append.
 */
export const ADMIN_LAKE_HEADER_VERSION = 2;

/** Rows per append: well inside Google's request size, few calls for a big merge. */
const SYNC_BATCH = 200;
/** Batches per sync; a lake with more waiting is finished by the next sync. */
const SYNC_MAX_BATCHES = 50;

/** The Google calls this module makes, as a seam the tests drive with a fake. */
export type AdminLakeSheetClient = {
  isConfigured(): Promise<boolean>;
  createSpreadsheet(title: string, firstTab: string): Promise<CreatedSpreadsheet>;
  writeRaw(spreadsheetId: string, data: Array<{ range: string; values: Array<Array<SheetCellValue>> }>): Promise<void>;
  appendRows(spreadsheetId: string, range: string, rows: Array<Array<SheetCellValue>>): Promise<void>;
  shareWithEmail(spreadsheetId: string, email: string): Promise<void>;
};

const realClient: AdminLakeSheetClient = {
  isConfigured: () => isGoogleSheetsConfigured(),
  createSpreadsheet: (title, firstTab) => createSpreadsheet(title, firstTab, ADMIN_LAKE_HEADERS.length),
  writeRaw: (spreadsheetId, data) => batchUpdateValuesRaw(spreadsheetId, data),
  appendRows: (spreadsheetId, range, rows) => appendValuesRaw(spreadsheetId, range, rows),
  shareWithEmail: (spreadsheetId, email) => shareSpreadsheetWithEmail(spreadsheetId, email),
};

let client: AdminLakeSheetClient = realClient;

/** Swaps the Google calls for a fake; call with no argument to put the real ones back. */
export function setAdminLakeSheetClientForTests(next?: AdminLakeSheetClient): void {
  client = next ?? realClient;
}

/* --------------------------------------------------------- the sheet -- */

export type AdminLakeSheet = {
  spreadsheetId: string;
  spreadsheetUrl: string;
  tabName: string;
  createdAt: string;
  /** The administrator emails it has been shared with, lower case. */
  sharedWith: string[];
  /**
   * False from the moment the spreadsheet exists until its header row lands.
   * It is stored at once, so a header write that fails leaves THIS sheet for
   * the next attempt to finish - never a second spreadsheet nobody can find.
   * Absent (a sheet stored before the flag) reads as true.
   */
  headerWritten: boolean;
  /**
   * The `ADMIN_LAKE_HEADER_VERSION` its header row was written at. Absent (a
   * sheet stored before v6) reads as 1: its header is rewritten, whole, the
   * next time a row is appended.
   */
  headerVersion: number;
};

function readSheet(): AdminLakeSheet | null {
  try {
    const stored = getSetting<Partial<AdminLakeSheet>>(ADMIN_LAKE_SHEET_KEY);
    if (!stored || typeof stored.spreadsheetId !== 'string' || !stored.spreadsheetId) return null;
    return {
      spreadsheetId: stored.spreadsheetId,
      spreadsheetUrl:
        typeof stored.spreadsheetUrl === 'string' && stored.spreadsheetUrl
          ? stored.spreadsheetUrl
          : `https://docs.google.com/spreadsheets/d/${stored.spreadsheetId}/edit`,
      tabName: typeof stored.tabName === 'string' && stored.tabName ? stored.tabName : ADMIN_LAKE_TAB,
      createdAt: typeof stored.createdAt === 'string' ? stored.createdAt : '',
      sharedWith: Array.isArray(stored.sharedWith) ? stored.sharedWith.filter((email): email is string => typeof email === 'string') : [],
      headerWritten: stored.headerWritten !== false,
      headerVersion:
        typeof stored.headerVersion === 'number' && Number.isSafeInteger(stored.headerVersion) ? stored.headerVersion : 1,
    };
  } catch (error) {
    console.warn(`[lake] app_settings["${ADMIN_LAKE_SHEET_KEY}"] is not readable; a new admin sheet will be created.`, error);
    return null;
  }
}

/** The admin sheet as stored, or null before it is first created. */
export function describeAdminLakeSheet(): AdminLakeSheet | null {
  return readSheet();
}

/** Every enabled administrator's email, lower case: who the sheet is shared with. */
function administratorEmails(): string[] {
  return listUsers()
    .filter((account) => account.role === 'admin' && !account.disabled && account.email)
    .map((account) => account.email.trim().toLowerCase());
}

/** Who the stored sheet has not been shared with yet. */
function missingAdministrators(sheet: AdminLakeSheet): string[] {
  return administratorEmails().filter((email) => !sheet.sharedWith.includes(email));
}

/**
 * Stores a change to a sheet only while it is still THE sheet: a recreate
 * may have stored another while Google answered, and that one must not be
 * written over with the sheet it replaced.
 */
function storeIfCurrent(sheet: AdminLakeSheet): void {
  if (readSheet()?.spreadsheetId === sheet.spreadsheetId) setSetting(ADMIN_LAKE_SHEET_KEY, sheet);
}

type Creation = { promise: Promise<AdminLakeSheet>; recreate: boolean };
let creating: Creation | null = null;

/**
 * The admin sheet, created on first use - a spreadsheet of the server's own,
 * one tab with the header written RAW, its id stored in app settings - and
 * shared with any administrator it has not been shared with yet. Two callers
 * at once share one creation. `recreate` makes a NEW spreadsheet (the old one
 * was deleted, or should be left behind) and opens the outbox again for every
 * row, so the new sheet gets the whole lake.
 *
 * One creation at a time: a plain call takes whatever is being made, while a
 * recreate joins only another recreate - joining a plain call would answer
 * with the very sheet it was asked to replace - and otherwise waits for it,
 * then makes its own.
 */
export async function getOrCreateAdminLakeSheet(options: { recreate?: boolean } = {}): Promise<AdminLakeSheet> {
  const recreate = options.recreate === true;
  while (creating) {
    const current = creating;
    if (!recreate || current.recreate) return current.promise;
    await current.promise.catch(() => undefined);
  }
  const promise: Promise<AdminLakeSheet> = makeOrShare(recreate).finally(() => {
    if (creating?.promise === promise) creating = null;
  });
  creating = { promise, recreate };
  return promise;
}

async function makeOrShare(recreate: boolean): Promise<AdminLakeSheet> {
  let sheet = recreate ? null : readSheet();
  if (!sheet) {
    if (!(await client.isConfigured())) {
      throw new PublicError(
        'Google Sheets is not configured on this server, so the admin sheet cannot be created. The jobs are in the ' +
          'database; set Google up (see The job sheet in the README) and try again.',
        { status: 503, code: 'sheets-not-configured' }
      );
    }
    const created = await client.createSpreadsheet(ADMIN_LAKE_SHEET_TITLE, ADMIN_LAKE_TAB);
    sheet = {
      spreadsheetId: created.spreadsheetId,
      spreadsheetUrl: created.spreadsheetUrl,
      tabName: ADMIN_LAKE_TAB,
      createdAt: new Date().toISOString(),
      sharedWith: [],
      headerWritten: false,
      headerVersion: ADMIN_LAKE_HEADER_VERSION,
    };
    // Stored the moment it exists - before its header is written and before
    // it is shared: either can fail, and the next attempt must finish THIS
    // sheet rather than create a second one nobody can find.
    setSetting(ADMIN_LAKE_SHEET_KEY, sheet);
    // A new sheet holds the whole lake: every row back into the outbox - in
    // the same tick as the new id is stored, so a sync appending to the old
    // sheet sees the change before it marks anything (`syncOnce`).
    if (recreate) reopenLakeOutbox();
    console.log(`[lake] Created the admin sheet ${sheet.spreadsheetId}.`);
  }
  // Before any row is appended - and before the sheet is handed to anybody.
  // A sheet whose header is an older build's gets this one's, once, so the
  // columns appended since (I-K) are named before a line fills them.
  if (!sheet.headerWritten || sheet.headerVersion < ADMIN_LAKE_HEADER_VERSION) sheet = await writeHeader(sheet);
  return shareWithAdministrators(sheet);
}

async function writeHeader(sheet: AdminLakeSheet): Promise<AdminLakeSheet> {
  await client.writeRaw(sheet.spreadsheetId, [
    { range: a1Range(sheet.tabName, 1, 1, 1, ADMIN_LAKE_HEADERS.length), values: [[...ADMIN_LAKE_HEADERS]] },
  ]);
  if (sheet.headerWritten) {
    console.log(`[lake] Rewrote the admin sheet's header for its new columns (${sheet.spreadsheetId}).`);
  }
  const next = { ...sheet, headerWritten: true, headerVersion: ADMIN_LAKE_HEADER_VERSION };
  storeIfCurrent(next);
  return next;
}

async function shareWithAdministrators(sheet: AdminLakeSheet): Promise<AdminLakeSheet> {
  const missing = missingAdministrators(sheet);
  if (missing.length === 0) return sheet;
  const shared = [...sheet.sharedWith];
  for (const email of missing) {
    try {
      await client.shareWithEmail(sheet.spreadsheetId, email);
      shared.push(email);
    } catch (error) {
      // The next sync tries again; one administrator's grant never stops the log.
      console.warn(`[lake] Could not share the admin sheet with ${email}; the next sync tries again.`, error);
    }
  }
  const next = { ...sheet, sharedWith: shared };
  storeIfCurrent(next);
  return next;
}

/* -------------------------------------------------------------- the sync -- */

export type AdminLakeSyncStatus = {
  /** Rows whose current version is not in the sheet yet. */
  unsynced: number;
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  /** Rows the last sync appended. */
  lastAppended: number;
  /** Why the last sync failed, for an administrator; null when it did not. */
  lastError: string | null;
};

const status = {
  lastAttemptAt: null as string | null,
  lastSuccessAt: null as string | null,
  lastAppended: 0,
  lastError: null as string | null,
};

let running: Promise<SyncReport> | null = null;
let again = false;

export type SyncReport = { appended: number; failed: boolean; skipped?: 'nothing-to-sync' | 'not-configured' };

export function adminLakeSyncStatus(): AdminLakeSyncStatus {
  return { unsynced: countUnsyncedLakeEntries(), running: running !== null, ...status };
}

/**
 * A lake row as one line of the admin sheet, in `ADMIN_LAKE_HEADERS` order.
 * Clearance is a real TRUE/FALSE, blank only for a row whose facts are not
 * filled in yet; a job type or industry the posting does not state is blank.
 */
export function adminSheetRow(entry: LakeEntry, requesterEmail: string): SheetCellValue[] {
  return [
    entry.company,
    jobFieldLabel(entry.jobFieldId),
    entry.title,
    formatSalary(entry.salary),
    entry.url,
    requesterEmail,
    entry.updatedAt,
    entry.jobHash,
    entry.jobTypeLabel,
    entry.clearance === null ? '' : entry.clearance,
    entry.industryLabel,
  ];
}

/**
 * Why a sync failed, for the administrators' page: the sentence, then the
 * operator's half of a Google refusal (`detail` - Google's status and its own
 * words) when there is one. Only administrators read this status, and the
 * sentence alone - "check the sheet link, or contact your administrator" -
 * tells the one reader who could act on it nothing.
 */
function describeSyncFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const detail = isPublicError(error) ? error.detail : undefined;
  return detail && detail !== message ? `${message}\n${detail}` : message;
}

/**
 * With nothing to append, an administrator appointed since the sheet was last
 * shared is still given it - "Retry now", the boot sync and every report run
 * or merge come here. Google is asked nothing when nobody is missing, and no
 * sheet is created before the lake holds a job.
 */
async function shareWhileIdle(): Promise<void> {
  const sheet = readSheet();
  if (!sheet || missingAdministrators(sheet).length === 0) return;
  try {
    if (!(await client.isConfigured())) return;
    await getOrCreateAdminLakeSheet();
  } catch (error) {
    console.warn('[lake] Could not share the admin sheet with a new administrator; the next sync tries again.', error);
  }
}

/** Whether the sheet a sync is appending to is still the stored one. */
function stillTheSheet(sheet: AdminLakeSheet): boolean {
  return readSheet()?.spreadsheetId === sheet.spreadsheetId;
}

async function syncOnce(): Promise<SyncReport> {
  // The database first: with nothing to append, no spreadsheet is created
  // before the lake holds a job, and Google is asked nothing unless an
  // administrator is still to be given the sheet.
  if (countUnsyncedLakeEntries() === 0) {
    await shareWhileIdle();
    return { appended: 0, failed: false, skipped: 'nothing-to-sync' };
  }
  status.lastAttemptAt = new Date().toISOString();
  if (!(await client.isConfigured())) {
    status.lastError = 'Google Sheets is not configured on this server, so the admin sheet cannot be written. The jobs are in the database.';
    return { appended: 0, failed: true, skipped: 'not-configured' };
  }
  let appended = 0;
  try {
    const sheet = await getOrCreateAdminLakeSheet();
    const emails = new Map<string, string>();
    const emailOf = (id: string | null) => {
      if (!id) return '';
      if (!emails.has(id)) emails.set(id, getUserById(id)?.email ?? '');
      return emails.get(id)!;
    };
    for (let batch = 0; batch < SYNC_MAX_BATCHES; batch += 1) {
      // "Create a new admin sheet" since this sync began: the outbox is the
      // new sheet's now. Round again, on that.
      if (!stillTheSheet(sheet)) {
        again = true;
        break;
      }
      const rows = listUnsyncedLakeEntries(SYNC_BATCH);
      if (rows.length === 0) break;
      await client.appendRows(
        sheet.spreadsheetId,
        a1Columns(sheet.tabName, 1, ADMIN_LAKE_HEADERS.length),
        rows.map((entry) => adminSheetRow(entry, emailOf(entry.requestedBy)))
      );
      // Checked again in the same tick as the mark: a sheet recreated while
      // Google took this batch reopened the outbox for the new one, and these
      // rows went to the old - marked, the new sheet would never get them.
      if (!stillTheSheet(sheet)) {
        again = true;
        break;
      }
      markLakeEntriesSynced(rows, new Date().toISOString());
      appended += rows.length;
    }
    status.lastSuccessAt = new Date().toISOString();
    status.lastAppended = appended;
    status.lastError = null;
    if (appended > 0) console.log(`[lake] Appended ${appended} job(s) to the admin sheet.`);
    return { appended, failed: false };
  } catch (error) {
    status.lastAppended = appended;
    status.lastError = describeSyncFailure(error);
    console.warn(
      `[lake] Could not append to the admin sheet (${appended} appended before it failed); the rest stay in the ` +
        'database and are sent by the next sync, or by "Retry now" on Admin -> Job Lake.',
      error
    );
    return { appended, failed: true };
  }
}

/**
 * Runs the sync now, or - when one is running - once more after it, and
 * answers when that is done. Never rejects.
 */
export function syncAdminLakeSheet(): Promise<SyncReport> {
  if (running) {
    // The running sync goes round once more before it answers.
    again = true;
    return running;
  }
  running = (async () => {
    let report = await syncOnce();
    while (again) {
      again = false;
      const next = await syncOnce();
      report = { appended: report.appended + next.appended, failed: next.failed, ...(next.skipped ? { skipped: next.skipped } : {}) };
    }
    return report;
  })()
    .catch((error) => {
      console.warn('[lake] The admin sheet sync stopped unexpectedly.', error);
      return { appended: 0, failed: true };
    })
    .finally(() => {
      running = null;
      // Asked for between the last pass and here: one more, so nothing waits for the next trigger.
      if (again) {
        again = false;
        void syncAdminLakeSheet();
      }
    });
  return running;
}

/** Starts a sync in the background: after a report run or a merge, and at boot. */
export function requestAdminLakeSync(reason: string): void {
  void syncAdminLakeSheet().then((report) => {
    if (report.failed && report.skipped !== 'not-configured') {
      console.warn(`[lake] The admin sheet sync after ${reason} did not finish; Admin -> Job Lake shows why.`);
    }
  });
}

/** Tests share one process: the state, the seam and any sync in flight are forgotten. */
export function resetAdminLakeSheetForTests(): void {
  status.lastAttemptAt = null;
  status.lastSuccessAt = null;
  status.lastAppended = 0;
  status.lastError = null;
  running = null;
  again = false;
  creating = null;
  client = realClient;
}
