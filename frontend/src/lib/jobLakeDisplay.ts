import { describeDollarProblem, formatMoney, parseDollars, toDollarInput } from './format';
import { parseReportRate } from './reporterPay';
import type {
  AdminLakeSheet,
  AdminLakeSyncStatus,
  DuplicateWindow,
  LakeEntry,
  LakeReward,
  LakeSettings,
  LakeSettingsUpdate,
  MergeReport,
  MergeStatus,
  ReportOverview,
  ReportPreviewRow,
  ReportRowOutcome,
  ReportRowStatus,
  ReportRun,
  ReportRunSummary,
  RevokeOutcome,
  SyncReport,
} from './jobLake';

/**
 * What the Job Data Lake's two pages decide, with no React in it: Report Jobs
 * (/report) - the range a run is asked for, which previewed rows it will
 * skip, how a row's outcome reads and which are red, and the owner's summary
 * line - and Admin -> Job Lake (/admin/job-lake) - the query a filter form
 * sends, how a reward, a revoke, the duplicate window, the sync and a merge
 * read, and which settings a save sends.
 *
 * Imports only frontend leaves (lib/format.ts, lib/reporterPay.ts) at runtime
 * - the API shapes come in as types - so backend/test/frontendJobLake.test.js
 * loads it and runs the copies of the server's rules here against the server's
 * own: the range a run takes (`readRunRange`), the settings it stores
 * (`updateLakeSettings`), the filters the lake route accepts.
 */

const plural = (count: number, noun: string, many = `${noun}s`): string => `${count} ${count === 1 ? noun : many}`;

/* ================================================================ Report Jobs */

/** Row 1 is the header of every job sheet tab. */
export const REPORT_FIRST_ROW = 2;

/** The server's MAX_REPORT_RUN_ROWS, for before GET /api/report has answered. */
export const DEFAULT_MAX_RUN_ROWS = 500;

export type ReportRange = { tabName: string; fromRow: number; toRow: number };

/** A row number as the server reads one: a whole number, typed or sent, nothing else. */
function wholeRow(value: unknown): number {
  if (typeof value === 'number') return value;
  return typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
}

/**
 * The tab and rows a run is asked for, as typed - or the server's own refusal,
 * word for word (services/jobLake/reportRun.ts `readRunRange`), so the line
 * under the boxes and the refusal a request would bring are one sentence.
 */
export function readReportRange(
  input: { tabName: unknown; fromRow: unknown; toRow: unknown },
  maxRows: number = DEFAULT_MAX_RUN_ROWS
): { ok: true; range: ReportRange } | { ok: false; error: string } {
  const tabName = typeof input.tabName === 'string' ? input.tabName.trim() : '';
  if (!tabName || tabName.length > 100) return { ok: false, error: 'Choose the tab of your sheet to report from.' };
  const fromRow = wholeRow(input.fromRow);
  const toRow = wholeRow(input.toRow);
  if (!Number.isSafeInteger(fromRow) || !Number.isSafeInteger(toRow) || fromRow < REPORT_FIRST_ROW || toRow < fromRow) {
    return {
      ok: false,
      error: 'Give the rows to report as From and To row numbers, from row 2 (row 1 is the header).',
    };
  }
  if (toRow - fromRow + 1 > maxRows) return { ok: false, error: `Report at most ${maxRows} rows at a time.` };
  return { ok: true, range: { tabName, fromRow, toRow } };
}

/** Whether two ranges are the same rows of the same tab. */
export function sameRange(a: ReportRange | null | undefined, b: ReportRange | null | undefined): boolean {
  return Boolean(a && b && a.tabName === b.tabName && a.fromRow === b.fromRow && a.toRow === b.toRow);
}

export type ReportPreviewCount = { jobs: number; toReport: number; reported: number };

/** The previewed rows a run would take to the lake, and those it skips as reported before. */
export function countReportPreview(rows: readonly Pick<ReportPreviewRow, 'reported'>[]): ReportPreviewCount {
  const reported = rows.filter((row) => row.reported).length;
  return { jobs: rows.length, toReport: rows.length - reported, reported };
}

/** The line over the preview: how many rows hold a job, and how many of them a run would skip. */
export function describeReportPreview(rows: readonly Pick<ReportPreviewRow, 'reported'>[]): string {
  const { jobs, toReport, reported } = countReportPreview(rows);
  if (jobs === 0) return 'No row in that range holds a job.';
  const holding = `${plural(jobs, 'row')} ${jobs === 1 ? 'holds' : 'hold'} a job`;
  if (reported === 0) return `${holding}, and ${jobs === 1 ? 'it' : `all ${jobs}`} will be taken to the job lake.`;
  if (toReport === 0) {
    return `${holding}, and ${jobs === 1 ? 'it was' : `all ${jobs} were`} reported before, so a run would skip ${jobs === 1 ? 'it' : 'every one'}.`;
  }
  return (
    `${holding}: ${toReport} will be taken to the job lake, and ${reported} ` +
    `${reported === 1 ? 'was' : 'were'} reported before and will be skipped.`
  );
}

export type NoteTone = 'grey' | 'amber' | 'sky' | 'green' | 'red';

/**
 * What the preview says about one row before a run: skipped as reported
 * before (and what its Lake Status says), tried again after a Skipped, or the
 * gap a run will trip on - no company, no description. Only `reported` is a
 * promise; the gaps are what to fix in the sheet first.
 */
export function describePreviewRow(
  row: Pick<ReportPreviewRow, 'reported' | 'lakeStatus' | 'company' | 'descriptionLength'>
): { label: string; tone: NoteTone; skipped: boolean } {
  if (row.reported) return { label: `Reported before (${row.lakeStatus}) - skipped`, tone: 'grey', skipped: true };
  // The run still reads these two (a link analysed before needs no
  // description), so they are not promised as skipped - only flagged as the
  // gap that will most likely leave them Skipped, to fill in first.
  if (!row.company.trim()) return { label: 'No company - it will be Skipped', tone: 'amber', skipped: false };
  if (row.descriptionLength === 0) {
    return { label: 'No job description - Skipped unless its link was analysed before', tone: 'amber', skipped: false };
  }
  if ((row.lakeStatus ?? '').trim().toLowerCase() === 'skipped') {
    return { label: 'Skipped last time - tried again', tone: 'sky', skipped: false };
  }
  return { label: 'To add', tone: 'sky', skipped: false };
}

/**
 * The server's refusal of a tab that is not one of the job sheet's own (a
 * tab the reporter keeps notes on): the run's words
 * (services/jobLake/reportRun.ts), said by the preview before a run is
 * started, so the two never disagree about the same tab.
 */
export function notJobTabMessage(tabName: string): string {
  return `"${tabName}" is not laid out as a job sheet tab, so it cannot be reported from. Choose one of the dated tabs of your job sheet.`;
}

/**
 * Why "Add to job lake" cannot be pressed yet, or '' when it can. A run is
 * started only over rows the page has PREVIEWED - the same tab and the same
 * rows - so what the reporter saw (which rows will be skipped as reported
 * before) is what the run is asked to do; and never while a run is going,
 * which the server would refuse anyway (409 `run-in-progress`).
 */
export function startBlocker(input: {
  sheetReady: boolean;
  run: Pick<ReportRun, 'state'> | null;
  range: ReturnType<typeof readReportRange>;
  preview: (ReportRange & { jobTab: boolean; rows: readonly Pick<ReportPreviewRow, 'reported'>[] }) | null;
}): string {
  if (!input.sheetReady) return 'Your job sheet is not available, so there is nothing to report from yet.';
  if (isRunLive(input.run)) return 'A run is going. Wait for it to finish first.';
  if (!input.range.ok) return input.range.error;
  if (!input.preview || !sameRange(input.preview, input.range.range)) {
    return 'Preview these rows first, to see what will be added.';
  }
  if (!input.preview.jobTab) return notJobTabMessage(input.preview.tabName);
  const { jobs, toReport } = countReportPreview(input.preview.rows);
  if (jobs === 0) return 'No row in that range holds a job.';
  if (toReport === 0) return 'Every row in that range was reported before: there is nothing new to add.';
  return '';
}

/** How often a page asks how a run is getting on while it goes. */
export const REPORT_POLL_MS = 1500;

/** How a row's outcome reads. */
export const REPORT_STATUS_LABELS: Readonly<Record<ReportRowStatus, string>> = {
  pending: 'Waiting',
  added: 'Added',
  replaced: 'Replaced',
  duplicate: 'Duplicate',
  unclassified: 'Unclassified',
  skipped: 'Skipped',
  failed: 'Failed',
  'already-reported': 'Reported before',
};

/**
 * Its pill's colour. Red is kept for duplicates, as the sheet paints them, so
 * a red pill on this page and a red row in the sheet mean the same thing; a
 * failure (a seat down) is amber - it is tried again next time.
 */
export const REPORT_STATUS_TONES: Readonly<Record<ReportRowStatus, NoteTone>> = {
  pending: 'sky',
  added: 'green',
  replaced: 'green',
  duplicate: 'red',
  unclassified: 'amber',
  skipped: 'grey',
  failed: 'amber',
  'already-reported': 'grey',
};

export function reportStatusLabel(status: string): string {
  return REPORT_STATUS_LABELS[status as ReportRowStatus] ?? status;
}

export function reportStatusTone(status: string): NoteTone {
  return REPORT_STATUS_TONES[status as ReportRowStatus] ?? 'grey';
}

/** The rows painted red: a duplicate, here as in the sheet. */
export function isRedOutcome(row: Pick<ReportRowOutcome, 'status'>): boolean {
  return row.status === 'duplicate';
}

/**
 * The owner's line, in the owner's words: `N out of M was added, your current
 * credit is $X` - added counting replacements (a job that replaced an older
 * version of itself is added), M the rows the run took to the lake, and the
 * balance after the run, always to the thousandth.
 */
export function describeRunSummary(summary: Pick<ReportRunSummary, 'added' | 'total' | 'balanceMilli'>): string {
  return `${summary.added} out of ${summary.total} was added, your current credit is ${formatMoney(summary.balanceMilli)}`;
}

/** The line under it: what the run earned, and what became of the rows that were not added. */
export function describeRunBreakdown(summary: ReportRunSummary, paid: boolean): string {
  const parts: string[] = [];
  if (summary.replaced > 0) {
    parts.push(`${summary.replaced} of the added replaced an older version of the same job`);
  }
  if (summary.duplicates > 0) parts.push(`${plural(summary.duplicates, 'duplicate')} (red)`);
  if (summary.unclassified > 0) parts.push(`${summary.unclassified} unclassified`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);
  if (summary.failed > 0) parts.push(`${summary.failed} failed and will be tried again next time`);
  if (summary.alreadyReported > 0) parts.push(`${summary.alreadyReported} reported before`);
  const earned = paid
    ? `This run earned ${formatMoney(summary.earnedMilli)}.`
    : 'Administrators are not paid for the jobs they report.';
  return parts.length > 0 ? `${earned} ${capitalise(parts.join(', '))}.` : earned;
}

function capitalise(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** Whether the page should keep asking how a run is getting on. */
export function isRunLive(run: Pick<ReportRun, 'state'> | null | undefined): boolean {
  return run?.state === 'running';
}

/** Where a run is, as a sentence beside its bar. */
export function describeRunProgress(run: Pick<ReportRun, 'state' | 'progress'>): string {
  const { done, total } = run.progress;
  if (run.state === 'running') {
    if (total === 0) return 'Reading your sheet...';
    return `Analysing and adding: ${done} of ${plural(total, 'row')}`;
  }
  if (run.state === 'failed') return 'The run stopped.';
  return `Done: ${plural(total, 'row')} taken to the job lake.`;
}

/**
 * A row's outcome as the line under the table counts it: what it paid, or
 * nothing. A reporter who is not paid (an administrator) sees "-" rather than
 * a column of $0 that reads like a rate of nothing.
 */
export function describeRowReward(row: Pick<ReportRowOutcome, 'rewardMilli'>, paid: boolean): string {
  if (!paid || row.rewardMilli <= 0) return '-';
  return formatMoney(row.rewardMilli);
}

/** The bar's fill, 0 to 1. A run still reading its sheet has nothing to show yet. */
export function runFraction(run: Pick<ReportRun, 'progress'>): number {
  const { done, total } = run.progress;
  if (!(total > 0)) return 0;
  return Math.min(1, Math.max(0, done / total));
}

/**
 * The line under the rate at the top of the page, which shows the figure
 * itself: whose rate it is - this account's own, or the global one every
 * reporter without one is paid - or that an administrator is never paid.
 */
export function describeReporterRate(overview: Pick<ReportOverview, 'paid' | 'rate'>): string {
  if (!overview.paid) return 'Administrators may report jobs, and are never paid for them.';
  return overview.rate.source === 'own'
    ? 'Your own rate, set by an administrator.'
    : 'The global rate, paid to every reporter without a rate of their own.';
}

/** Today's earnings, against the daily cap when there is one. */
export function describeEarnedToday(overview: Pick<ReportOverview, 'earnedTodayMilli' | 'dailyCapMilli'>): string {
  const earned = formatMoney(overview.earnedTodayMilli);
  if (overview.dailyCapMilli === null) return earned;
  return `${earned} of ${formatMoney(overview.dailyCapMilli)}`;
}

/* ================================================================ the admin lake */

/** The Lake tab's filter form, as typed. Every field a string; '' means "any". */
export type LakeFilters = {
  q: string;
  company: string;
  field: string;
  salaryMin: string;
  salaryMax: string;
  requestedBy: string;
  updatedFrom: string;
  updatedTo: string;
};

export const EMPTY_LAKE_FILTERS: LakeFilters = {
  q: '',
  company: '',
  field: '',
  salaryMin: '',
  salaryMax: '',
  requestedBy: '',
  updatedFrom: '',
  updatedTo: '',
};

const FILTER_ORDER: ReadonlyArray<keyof LakeFilters> = [
  'q',
  'company',
  'field',
  'salaryMin',
  'salaryMax',
  'requestedBy',
  'updatedFrom',
  'updatedTo',
];

/** The route's number rule (routes/jobLake.ts `readNumber`): digits, an optional fraction. */
const SALARY = /^\d+(\.\d+)?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** The route's date rule (`readTime`), for a date box: a bare date reads as that UTC day. */
function readableDate(text: string, end: boolean): boolean {
  const dateOnly = DATE_ONLY.test(text);
  return Number.isFinite(Date.parse(dateOnly ? `${text}T${end ? '23:59:59.999' : '00:00:00.000'}Z` : text));
}

/**
 * Why the lake route would answer these filters 400, in its words - or ''
 * when it would not. Checked before asking, so the form says which box is
 * wrong rather than emptying the table.
 */
export function lakeFilterProblem(filters: LakeFilters): string {
  const salaryMin = filters.salaryMin.trim();
  const salaryMax = filters.salaryMax.trim();
  if (salaryMin && !SALARY.test(salaryMin)) return 'The lowest salary must be a number.';
  if (salaryMax && !SALARY.test(salaryMax)) return 'The highest salary must be a number.';
  const from = filters.updatedFrom.trim();
  const to = filters.updatedTo.trim();
  if (from && !readableDate(from, false)) return 'Updated from must be a date, like 2026-10-05.';
  if (to && !readableDate(to, true)) return 'Updated to must be a date, like 2026-10-05.';
  return '';
}

/** The query string GET /api/admin/job-lake is asked with: what was typed, trimmed, then the page. */
export function lakeQueryString(filters: LakeFilters, offset = 0, limit?: number): string {
  const params = new URLSearchParams();
  for (const key of FILTER_ORDER) {
    const value = filters[key].trim();
    if (value) params.set(key, value);
  }
  if (typeof limit === 'number') params.set('limit', String(limit));
  if (offset > 0) params.set('offset', String(offset));
  return params.toString();
}

/** Whether any filter is set - "No jobs match" and "The lake is empty" are different sentences. */
export function hasLakeFilters(filters: LakeFilters): boolean {
  return FILTER_ORDER.some((key) => filters[key].trim() !== '');
}

/** A reward as one cell: what was paid and at what rate, what was taken back, or nothing paid. */
export function describeReward(reward: LakeReward): string {
  if (reward.milli <= 0) return 'Not paid';
  const paid = `${formatMoney(reward.milli)}${reward.rateMilli !== null ? ` at ${formatMoney(reward.rateMilli)} per job` : ''}`;
  if (reward.revokedAt) return `${paid} - ${formatMoney(reward.revokedMilli)} taken back`;
  return paid;
}

/** Whether "Revoke reward" (and "also revoke the reward" on delete) has anything to take back. */
export function canRevoke(entry: Pick<LakeEntry, 'reward' | 'requestedBy'>): boolean {
  return entry.reward.milli > 0 && !entry.reward.revokedAt && Boolean(entry.requestedBy);
}

/** What a revoke did, said to the administrator who pressed it. */
export function describeRevoke(outcome: RevokeOutcome | null, who: string): string {
  if (!outcome || !outcome.revoked) {
    return 'There was no reward to take back: none was paid for this job, or it was taken back already.';
  }
  const balance = formatMoney(outcome.balanceMilli ?? 0);
  if (outcome.takenMilli < outcome.rewardMilli) {
    return (
      `Took back ${formatMoney(outcome.takenMilli)} of the ${formatMoney(outcome.rewardMilli)} reward - all ` +
      `${who} had left (earnings already paid out are not a debt). Their balance is now ${balance}.`
    );
  }
  return `Took back the ${formatMoney(outcome.rewardMilli)} reward from ${who}. Their balance is now ${balance}.`;
}

const WINDOW_VARIABLE = 'JOB_LAKE_DUPLICATE_WINDOW_DAYS';

/**
 * The duplicate window in effect and where it came from - the value set
 * here, .env, or the built-in default - and what applies if the value set
 * here is cleared. An .env value that is not a whole number is said out loud:
 * it is ignored, which is not what whoever wrote it meant.
 */
export function describeDuplicateWindow(window: DuplicateWindow): string {
  const days = plural(window.days, 'day');
  const envLine = window.envInvalid
    ? `${WINDOW_VARIABLE} in .env is not a whole number, so it is ignored and the default of ${plural(window.envDays, 'day')} applies`
    : window.envSet
      ? `${WINDOW_VARIABLE} in .env says ${plural(window.envDays, 'day')}`
      : `${WINDOW_VARIABLE} is not set in .env, so the default is ${plural(window.envDays, 'day')}`;
  if (window.source === 'admin') return `In effect: ${days}, set here. Without it: ${envLine}.`;
  if (window.source === 'env') return `In effect: ${days}, from ${WINDOW_VARIABLE} in .env. A value set here wins over it.`;
  return `In effect: ${days}, the built-in default - ${envLine}. A value set here wins.`;
}

/**
 * The window box's placeholder, for when no value is set here: what applies
 * instead and where it comes from - .env when it names a usable value, else
 * the built-in default.
 */
export function windowPlaceholder(window: DuplicateWindow): string {
  return `${window.envDays} (${window.envSet && !window.envInvalid ? 'from .env' : 'the default'})`;
}

/** The settings form, as typed. */
export type LakeSettingsDraft = { rate: string; window: string; cap: string };

/** The form as the stored settings fill it: empty for what is not set. */
export function lakeSettingsDraft(settings: LakeSettings): LakeSettingsDraft {
  return {
    rate: settings.reportRateSet ? toDollarInput(settings.reportRateMilli) : '',
    window: settings.duplicateWindow.adminDays === null ? '' : String(settings.duplicateWindow.adminDays),
    cap: settings.dailyCapMilli === null ? '' : toDollarInput(settings.dailyCapMilli),
  };
}

/** The server's window bounds (OPERATIONAL_INT_BOUNDS.JOB_LAKE_DUPLICATE_WINDOW_DAYS). */
export const DUPLICATE_WINDOW_MIN_DAYS = 1;
export const DUPLICATE_WINDOW_MAX_DAYS = 3650;
/** The server's MAX_DAILY_CAP_MILLI: $1,000,000. */
export const MAX_DAILY_CAP_MILLI = 1_000_000_000;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseWindow(text: string): Parsed<number | null> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: null };
  const days = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(days) || days < DUPLICATE_WINDOW_MIN_DAYS || days > DUPLICATE_WINDOW_MAX_DAYS) {
    return {
      ok: false,
      error: `The duplicate window is a whole number of days from ${DUPLICATE_WINDOW_MIN_DAYS} to ${DUPLICATE_WINDOW_MAX_DAYS}.`,
    };
  }
  return { ok: true, value: days };
}

function parseCap(text: string): Parsed<number | null> {
  if (!text.trim()) return { ok: true, value: null };
  const parsed = parseDollars(text);
  if (!parsed.ok) return { ok: false, error: describeDollarProblem(parsed.problem, 'The daily cap') };
  if (parsed.milli > MAX_DAILY_CAP_MILLI) {
    return { ok: false, error: `The daily cap can be at most ${formatMoney(MAX_DAILY_CAP_MILLI)}.` };
  }
  return { ok: true, value: parsed.milli };
}

function parseRate(text: string): Parsed<number | null> {
  // The same rule as a reporter's own rate (config/reportRate.ts): dollars to
  // $0.001, $0-$1,000, empty for none.
  const parsed = parseReportRate(text);
  return parsed.ok ? { ok: true, value: parsed.milli } : { ok: false, error: parsed.error };
}

export type LakeSettingsProblems = Partial<Record<keyof LakeSettingsDraft, string>>;

/** Each box's problem, in the server's words (services/jobLake/settings.ts `updateLakeSettings`). */
export function lakeSettingsProblems(draft: LakeSettingsDraft): LakeSettingsProblems {
  const problems: LakeSettingsProblems = {};
  const rate = parseRate(draft.rate);
  const window = parseWindow(draft.window);
  const cap = parseCap(draft.cap);
  if (!rate.ok) problems.rate = rate.error;
  if (!window.ok) problems.window = window.error;
  if (!cap.ok) problems.cap = cap.error;
  return problems;
}

/** The box a refusal's `code` is about, so it is shown under that box. */
export function settingsFieldForCode(code: string | undefined): keyof LakeSettingsDraft | null {
  if (code === 'bad-rate') return 'rate';
  if (code === 'bad-window') return 'window';
  if (code === 'bad-cap') return 'cap';
  return null;
}

/**
 * The PUT body: only what changed from what is stored, each as TYPED (an
 * amount is sent as dollars text, never a number this page parsed), '' to
 * clear. Empty when nothing changed - "0.07" for a stored $0.070 is no change.
 * Null while a box holds something the server would refuse.
 */
export function lakeSettingsChanges(draft: LakeSettingsDraft, settings: LakeSettings): LakeSettingsUpdate | null {
  const rate = parseRate(draft.rate);
  const window = parseWindow(draft.window);
  const cap = parseCap(draft.cap);
  if (!rate.ok || !window.ok || !cap.ok) return null;
  const body: LakeSettingsUpdate = {};
  const storedRate = settings.reportRateSet ? settings.reportRateMilli : null;
  if (rate.value !== storedRate) body.reportRateUsd = draft.rate.trim();
  if (window.value !== settings.duplicateWindow.adminDays) body.duplicateWindowDays = draft.window.trim();
  if (cap.value !== settings.dailyCapMilli) body.dailyCapUsd = draft.cap.trim();
  return body;
}

/** The global rate's line under its box. */
export function describeGlobalRate(settings: Pick<LakeSettings, 'reportRateMilli' | 'reportRateSet'>): string {
  if (!settings.reportRateSet) {
    return 'Not set: every job is accepted and nobody is paid until you set one. A reporter with a rate of their own (Accounts) is paid that.';
  }
  return `${formatMoney(settings.reportRateMilli)} per job the lake accepts, for every reporter without a rate of their own (Accounts).`;
}

/** The daily cap's line under its box. */
export function describeDailyCap(dailyCapMilli: number | null): string {
  if (dailyCapMilli === null) return 'No cap: a reporter is paid for every job the lake accepts.';
  return `A reporter earns at most ${formatMoney(dailyCapMilli)} a day (UTC). A job past it is still added, and paid what is left of the day.`;
}

/**
 * The admin sheet's state in one line, with the tone of its notice: sending
 * now, jobs waiting (and whether the last attempt failed), nothing yet, or
 * everything sent.
 */
export function describeSyncState(
  sheet: AdminLakeSheet | null,
  sync: AdminLakeSyncStatus
): { tone: 'info' | 'success' | 'warn'; text: string } {
  if (sync.running) return { tone: 'info', text: 'Sending jobs to the admin sheet now...' };
  if (sync.unsynced > 0) {
    const waiting = `${plural(sync.unsynced, 'job')} ${sync.unsynced === 1 ? 'is' : 'are'} waiting to be added to the admin sheet.`;
    return sync.lastError
      ? { tone: 'warn', text: `${waiting} The last attempt failed; Retry now sends them again.` }
      : { tone: 'info', text: `${waiting} They are sent after each report run and merge, and at every start.` };
  }
  if (!sheet) {
    return { tone: 'info', text: 'No admin sheet yet: the server creates it the first time the lake has a job to send.' };
  }
  return { tone: 'success', text: 'Every job in the lake is on the admin sheet.' };
}

/** What "Retry now" did. */
export function describeSyncReport(report: SyncReport): { tone: 'success' | 'warn'; text: string } {
  if (report.skipped === 'nothing-to-sync') {
    return { tone: 'success', text: 'Nothing was waiting: every job in the lake is on the admin sheet.' };
  }
  if (report.skipped === 'not-configured') {
    return { tone: 'warn', text: 'Google Sheets is not set up on this server, so there is no admin sheet to send jobs to.' };
  }
  if (report.failed) {
    return { tone: 'warn', text: 'The admin sheet could not be updated. The jobs stay waiting and nothing is lost; the cause is below.' };
  }
  return { tone: 'success', text: `Added ${plural(report.appended, 'job')} to the admin sheet.` };
}

/** How a merge result reads in the duplicate report. */
export const MERGE_STATUS_LABELS: Readonly<Record<MergeStatus, string>> = {
  added: 'Added',
  replaced: 'Replaced an older version',
  duplicate: 'Duplicate',
  already: 'Duplicate',
  unclassified: 'Unclassified - not merged',
  'no-company': 'No company - not merged',
  'not-found': 'Not found',
  'merged-before': 'Merged before',
  'not-offered': 'Not offered (no company on record)',
};

/** The one line a merge ends with. */
export function describeMergeReport(report: MergeReport): string {
  if (report.results.length === 0) return 'There was nothing to merge.';
  const parts = [`${report.added} added`];
  if (report.replaced > 0) parts[0] += ` (${report.replaced} replacing an older version)`;
  parts.push(plural(report.duplicates, 'duplicate'));
  if (report.skipped > 0) parts.push(`${report.skipped} skipped`);
  const still = report.remaining > 0 ? ` ${report.remaining} still to merge.` : ' Nothing is left to merge.';
  return `Merged ${report.merged}: ${parts.join(', ')}.${still} Nobody is paid for a merge.`;
}

const isDuplicateResult = (status: MergeStatus): boolean => status === 'duplicate' || status === 'already';

/** The results the duplicate report lists: a job the lake already had within the window. */
export function mergeDuplicates(report: MergeReport): MergeReport['results'] {
  return report.results.filter((result) => isDuplicateResult(result.status));
}

/**
 * Every result the lake did not add, for the table under a merge's line:
 * the duplicates first (the report the owner asked for), then whatever was
 * skipped and why, each group in the order merged.
 */
export function mergeResultsNotAdded(report: MergeReport): MergeReport['results'] {
  const notAdded = report.results.filter((result) => result.status !== 'added' && result.status !== 'replaced');
  return [
    ...notAdded.filter((result) => isDuplicateResult(result.status)),
    ...notAdded.filter((result) => !isDuplicateResult(result.status)),
  ];
}

/**
 * A web address from a sheet or the lake as an href - `http(s)` with a host
 * and no credentials - or null, and the page shows the text instead. A job
 * link is whatever somebody typed into a cell, so `javascript:` and `data:`
 * never reach an anchor.
 */
export function safeWebLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const href = value.trim();
  if (!href || /[\s\u0000-\u001f\u007f]/.test(href)) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname || url.username || url.password) return null;
  return url.href;
}

/** What a link cell shows: the host, without a leading `www.`. */
export function linkHost(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return href;
  }
}

/** How a lake row came in. */
export function describeSource(source: 'report' | 'merge'): string {
  return source === 'merge' ? 'Merged from a build' : 'Reported';
}

/** The seen count as a cell: a job reported once reads plainly, a duplicate says how often. */
export function describeSeen(entry: Pick<LakeEntry, 'seenCount'>): string {
  if (entry.seenCount <= 1) return 'Once';
  return `${entry.seenCount} times`;
}

/** The line over the lake table: how many jobs, and whether a filter narrowed them. */
export function describeLakeTotal(total: number, filtered: boolean): string {
  if (filtered) return total === 0 ? 'No job in the lake matches these filters.' : `${plural(total, 'job')} match.`;
  return total === 0 ? 'The lake is empty.' : `${plural(total, 'job')} in the lake.`;
}

/**
 * What Delete asks before it acts: the job goes, can be reported again as a
 * new one, and - only when asked - its reward is taken back.
 */
export function describeDeleteConfirm(
  entry: Pick<LakeEntry, 'company' | 'jobFieldLabel' | 'reward' | 'requestedBy'>,
  revokeReward: boolean
): string {
  const job = `${entry.company} - ${entry.jobFieldLabel}`;
  const base = `Delete ${job} from the lake? It can then be reported again, as a new job.`;
  if (!canRevoke(entry)) return base;
  return revokeReward
    ? `${base} Its ${formatMoney(entry.reward.milli)} reward is taken back from the reporter's balance, never below $0.`
    : `${base} The reporter keeps its ${formatMoney(entry.reward.milli)} reward.`;
}

/** Who reported a lake row, as a cell: their email, or why there is none. */
export function describeRequester(entry: Pick<LakeEntry, 'requester' | 'requestedBy'>): string {
  if (entry.requester) return entry.requester.email || entry.requester.name;
  return entry.requestedBy ? 'Deleted account' : 'Nobody on record';
}
