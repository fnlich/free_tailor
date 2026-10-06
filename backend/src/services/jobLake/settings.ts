import { envRaw, type EnvSource } from '../../config/envValue';
import { jobLakeDuplicateWindowDays, OPERATIONAL_INT_BOUNDS } from '../../config/operational';
import { MAX_REPORT_RATE_MILLI, parseReportRateUsd } from '../../config/reportRate';
import { getSetting, setSetting } from '../../database/settingsRepository';
import { describeDollarProblem, formatMoney, parseDollars } from '../../utils/money';

/**
 * The Job Data Lake's three settings, set by an administrator on
 * /admin/job-lake and kept in `app_settings['job-lake']`:
 *
 *  - `reportRateMilli`, the GLOBAL rate a reporter is paid per job the lake
 *    accepts (owner decision J7), in thousandths of a dollar. A reporter with
 *    a rate of their own (`users.report_rate_milli`, Admin -> Accounts) is
 *    paid that instead. Unset reads as $0.000: nobody is paid until an
 *    administrator decides what a job is worth, as no model is priced until
 *    one is (M5).
 *  - `duplicateWindowDays`, the duplicate window (J2b). Unset falls back to
 *    `JOB_LAKE_DUPLICATE_WINDOW_DAYS` in .env, then to 60 - the value set
 *    here WINS over .env, and `resolveDuplicateWindow` says which is in
 *    effect and where it came from, which the page shows.
 *  - `dailyCapMilli`, the most one reporter earns from the lake in one UTC
 *    day. Unset is no cap. A job past it is still added - the lake wants the
 *    job - and paid only what the cap leaves.
 *
 * Every amount a request sends is dollars, as text, in a field ending `Usd`
 * (`reportRateUsd`, `dailyCapUsd`); every amount served is an integer in a
 * field ending `Milli`. Refused by name rather than rounded or clamped: a
 * rate silently changed from what was typed pays every job after it wrongly.
 */

export const JOB_LAKE_SETTINGS_KEY = 'job-lake';

/** The daily cap's ceiling: $1,000,000, so an absurd figure is a typo refused rather than a cap. */
export const MAX_DAILY_CAP_MILLI = 1_000_000_000;

const WINDOW_BOUNDS = OPERATIONAL_INT_BOUNDS.JOB_LAKE_DUPLICATE_WINDOW_DAYS;

type StoredLakeSettings = {
  reportRateMilli?: unknown;
  duplicateWindowDays?: unknown;
  dailyCapMilli?: unknown;
  updatedAt?: unknown;
  updatedBy?: unknown;
};

export type DuplicateWindowSource = 'admin' | 'env' | 'default';

export type DuplicateWindow = {
  /** The window in effect, in days. */
  days: number;
  /** Where it came from: the administrator's value, .env, or the built-in 60. */
  source: DuplicateWindowSource;
  /** The administrator's value, or null when none is set. */
  adminDays: number | null;
  /** What .env alone gives - its value (clamped), or the default when unset or junk. */
  envDays: number;
  /** Whether .env names the variable at all. */
  envSet: boolean;
  /** Whether what it names is not a whole number, and was ignored (it warned once). */
  envInvalid: boolean;
};

export type LakeSettings = {
  reportRateMilli: number;
  /** False until an administrator saves a global rate: the page says nobody is paid yet. */
  reportRateSet: boolean;
  duplicateWindow: DuplicateWindow;
  dailyCapMilli: number | null;
  updatedAt: string | null;
};

const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[lake] ${message}`);
}

function readStored(): StoredLakeSettings {
  try {
    const stored = getSetting<StoredLakeSettings>(JOB_LAKE_SETTINGS_KEY);
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  } catch (error) {
    // A hand-edited row that is not JSON: every setting reads as unset, said once.
    warnOnce('unreadable', `app_settings["${JOB_LAKE_SETTINGS_KEY}"] is not readable; using the defaults.`);
    void error;
    return {};
  }
}

function wholeIn(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

/** A stored value that is present but not usable reads as unset, with one warning naming it. */
function storedInt(stored: StoredLakeSettings, key: keyof StoredLakeSettings, min: number, max: number): number | null {
  const value = stored[key];
  if (value === undefined || value === null) return null;
  const usable = wholeIn(value, min, max);
  if (usable === null) {
    warnOnce(`junk:${key}`, `app_settings["${JOB_LAKE_SETTINGS_KEY}"].${key} is ${JSON.stringify(value)}, which is not usable; ignoring it.`);
  }
  return usable;
}

/** The duplicate window in effect - the administrator's, else .env's, else 60 - and where it came from. */
export function resolveDuplicateWindow(env: EnvSource = process.env, stored: StoredLakeSettings = readStored()): DuplicateWindow {
  const adminDays = storedInt(stored, 'duplicateWindowDays', WINDOW_BOUNDS.min, WINDOW_BOUNDS.max);
  const raw = envRaw('JOB_LAKE_DUPLICATE_WINDOW_DAYS', env);
  const envSet = raw !== null;
  const envInvalid = envSet && !/^[+-]?\d+$/.test(raw);
  const envDays = jobLakeDuplicateWindowDays(env);
  if (adminDays !== null) return { days: adminDays, source: 'admin', adminDays, envDays, envSet, envInvalid };
  return { days: envDays, source: envSet && !envInvalid ? 'env' : 'default', adminDays: null, envDays, envSet, envInvalid };
}

export function readLakeSettings(env: EnvSource = process.env): LakeSettings {
  const stored = readStored();
  const rate = storedInt(stored, 'reportRateMilli', 0, MAX_REPORT_RATE_MILLI);
  return {
    reportRateMilli: rate ?? 0,
    reportRateSet: rate !== null,
    duplicateWindow: resolveDuplicateWindow(env, stored),
    dailyCapMilli: storedInt(stored, 'dailyCapMilli', 0, MAX_DAILY_CAP_MILLI),
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
  };
}

/** The global rate per accepted job, in thousandths: what a reporter without a rate of their own is paid. */
export function globalReportRateMilli(): number {
  return readLakeSettings().reportRateMilli;
}

export type LakeSettingsUpdate =
  | { ok: true; settings: LakeSettings }
  | { ok: false; status: number; code: string; error: string };

function refuse(code: string, error: string, status = 400): LakeSettingsUpdate {
  return { ok: false, status, code, error };
}

/**
 * An administrator's change, `{ reportRateUsd?, duplicateWindowDays?,
 * dailyCapUsd? }` - each optional, so a page may save one at a time.
 *
 *  - `reportRateUsd`: dollars to $0.001, $0.000-$1000.000; null or '' sets
 *    it back to unset ($0.000).
 *  - `duplicateWindowDays`: a whole number 1-3650; null or '' removes the
 *    administrator's value, so .env (or 60) is in effect again.
 *  - `dailyCapUsd`: dollars to $0.001; null or '' removes the cap.
 *
 * An amount in thousandths (`reportRateMilli`, `dailyCapMilli`) is refused:
 * requests carry dollars, responses thousandths, everywhere in this app.
 */
export function updateLakeSettings(body: unknown, actorId: string): LakeSettingsUpdate {
  const input = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  for (const field of ['reportRateMilli', 'dailyCapMilli']) {
    if (field in input) {
      return refuse('amount-in-dollars', `Send ${field.replace('Milli', 'Usd')} in dollars, not ${field}.`);
    }
  }
  const stored = readStored();
  const next: StoredLakeSettings = { ...stored };

  if ('reportRateUsd' in input) {
    const parsed = parseReportRateUsd(input.reportRateUsd);
    if (!parsed.ok) return refuse('bad-rate', parsed.error);
    if (parsed.milli === null) delete next.reportRateMilli;
    else next.reportRateMilli = parsed.milli;
  }

  if ('duplicateWindowDays' in input) {
    const value = input.duplicateWindowDays;
    if (value === null || (typeof value === 'string' && value.trim() === '')) {
      delete next.duplicateWindowDays;
    } else {
      const days = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
      if (wholeIn(days, WINDOW_BOUNDS.min, WINDOW_BOUNDS.max) === null) {
        return refuse(
          'bad-window',
          `The duplicate window is a whole number of days from ${WINDOW_BOUNDS.min} to ${WINDOW_BOUNDS.max}.`
        );
      }
      next.duplicateWindowDays = days;
    }
  }

  if ('dailyCapUsd' in input) {
    const value = input.dailyCapUsd;
    if (value === null || (typeof value === 'string' && value.trim() === '')) {
      delete next.dailyCapMilli;
    } else {
      const parsed = parseDollars(value);
      if (!parsed.ok) return refuse('bad-cap', describeDollarProblem(parsed.problem, 'The daily cap'));
      if (parsed.milli > MAX_DAILY_CAP_MILLI) {
        return refuse('bad-cap', `The daily cap can be at most ${formatMoney(MAX_DAILY_CAP_MILLI)}.`);
      }
      next.dailyCapMilli = parsed.milli;
    }
  }

  next.updatedAt = new Date().toISOString();
  next.updatedBy = actorId;
  setSetting(JOB_LAKE_SETTINGS_KEY, next);
  return { ok: true, settings: readLakeSettings() };
}

/** Tests share one process: the once-only warnings are forgotten. */
export function resetLakeSettingsWarningsForTests(): void {
  warned.clear();
}
