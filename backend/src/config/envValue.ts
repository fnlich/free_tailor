/**
 * Reading one setting out of the environment, the same way everywhere.
 *
 * Before this file every module rolled its own: `Number(x) || default` for
 * PORT, `parseInt` for CREDIT_SIGNUP_GRANT (junk became 0 without a word),
 * private `intFlag` copies in the two CLI providers that clamped silently, and
 * an exact `=== 'off'` here and there. Each was fine on its own and together
 * they meant the same typo did four different things depending on which
 * variable it landed in.
 *
 * The policy every primitive below follows, and why:
 *
 *   - NEVER throw, never refuse to boot. An installation has to start to show
 *     its own diagnostics (the startup banner, /api/health, the doctors), and a
 *     server that will not come up over a timeout typo hides every one of them.
 *   - Unset, empty or whitespace means the default. `config/env.ts` copies a
 *     bare `NAME=` line from `.env` as '', so "empty" is what a copied
 *     `.env.example` produces and must not mean zero, off or "omit".
 *   - Junk warns ONCE per variable name and uses the default. Once, because most
 *     of these are read per call and a warning per request would bury the log;
 *     at all, because a value that is silently ignored looks exactly like a bug
 *     somewhere else.
 *   - A number outside its bounds is clamped to the nearest bound and warns once,
 *     so a value that is merely too big still moves things in the direction the
 *     operator meant.
 *
 * Every primitive takes `(name, fallback, opts, env = process.env)`. The `env`
 * argument is the test seam: a test hands in a plain object and never has to
 * mutate - and then restore - the real process environment.
 */

import { formatMoney, parseDollars } from '../utils/money';

export type EnvSource = NodeJS.ProcessEnv | Record<string, string | undefined>;

const warnedNames = new Set<string>();

/** Logs once per variable name, under the `[env]` tag the loader already uses. */
function warnOnce(name: string, message: string): void {
  if (warnedNames.has(name)) return;
  warnedNames.add(name);
  console.warn(`[env] ${message}`);
}

/** Test seam: the warnings are once-per-process, which a test would otherwise see only once. */
export function resetEnvWarningsForTests(): void {
  warnedNames.clear();
}

/**
 * The trimmed value, or null when the variable is unset, empty or whitespace.
 *
 * Exported for the rare reader whose empty case is not simply "the default" and
 * that therefore has to look at the raw text first (APIFY_PROXY_GROUPS' `auto`).
 */
export function envRaw(name: string, env: EnvSource = process.env): string | null {
  const raw = env[name];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

/** How a value is quoted in a warning: short, and never with a line break in it. */
function quote(value: string): string {
  const single = value.replace(/[\r\n\t]+/g, ' ');
  return JSON.stringify(single.length > 80 ? `${single.slice(0, 77)}...` : single);
}

/* ------------------------------------------------------------------ strings */

export type EnvStringOptions = {
  /** Longest accepted value, in characters, after trimming. */
  maxLength?: number;
  /** A value must match this (after `upperCase`, when set). */
  pattern?: RegExp;
  /** Upper-cases the value before it is checked and returned. */
  upperCase?: boolean;
  /**
   * What the value should look like, for the warning ("an ISO country code").
   * Without it the warning only says the value was not accepted.
   */
  expected?: string;
};

/**
 * A trimmed, single-line string.
 *
 * Control characters are always refused. Every string read through here ends
 * up in a header, a URL, an API payload or a log line, and a CR/LF in one of
 * those is header injection or a forged log line rather than a value - which
 * dotenv will happily produce from a double-quoted `"...\n..."`.
 */
export function envString(
  name: string,
  fallback: string,
  opts: EnvStringOptions = {},
  env: EnvSource = process.env
): string {
  const raw = envRaw(name, env);
  if (raw === null) return fallback;

  const value = opts.upperCase ? raw.toUpperCase() : raw;
  // eslint-disable-next-line no-control-regex
  const problem = /[\u0000-\u001f\u007f]/.test(value)
    ? 'contains a line break or another control character'
    : opts.maxLength !== undefined && value.length > opts.maxLength
      ? `is longer than ${opts.maxLength} characters`
      : opts.pattern && !opts.pattern.test(value)
        ? `is not ${opts.expected ?? 'in the accepted form'}`
        : null;

  if (problem) {
    warnOnce(name, `${name}=${quote(raw)} ${problem}; using ${quote(fallback)}.`);
    return fallback;
  }
  return value;
}

/* ----------------------------------------------------------------- integers */

export type EnvIntOptions = {
  min: number;
  max: number;
  /**
   * What happens to a whole number outside [min, max].
   *
   * 'clamp' (the default) moves it to the nearest bound: a timeout that is
   * merely too long still gets as long as it is allowed to be. 'fallback' uses
   * the default instead, for the values where the nearest bound is meaningless
   * rather than close - PORT=0 clamped to port 1 would be a privileged port
   * nobody asked for, where the default is what an unusable port always meant.
   */
  outOfRange?: 'clamp' | 'fallback';
  /** The unit, for the warning text only ("ms", "MB", "day(s)"). */
  unit?: string;
};

/** A plain whole number: optional sign, digits, nothing else. No 1e3, no 30s, no 1.5. */
const INTEGER = /^[+-]?\d+$/;

/**
 * A whole number inside [min, max].
 *
 * Strict about the FORM on purpose. `parseInt('30s')` is 30 and `Number('1e3')`
 * is 1000, so the permissive readers this replaces accepted a unit typed into
 * a `_MS` variable as a value a thousand times too small, and said nothing.
 * Here that is junk, and junk is reported.
 *
 * A `null` fallback is for the variables whose default is "not set at all"
 * (SCRAPER_MAX_RESULTS: no cap), so junk there means no cap rather than some
 * number invented to stand for it.
 */
export function envInt(name: string, fallback: number, opts: EnvIntOptions, env?: EnvSource): number;
export function envInt(
  name: string,
  fallback: null,
  opts: EnvIntOptions,
  env?: EnvSource
): number | null;
export function envInt(
  name: string,
  fallback: number | null,
  opts: EnvIntOptions,
  env: EnvSource = process.env
): number | null {
  const raw = envRaw(name, env);
  if (raw === null) return fallback;

  const unit = opts.unit ? ` ${opts.unit}` : '';
  const shownFallback = fallback === null ? 'the default (unset)' : `${fallback}${unit}`;
  const parsed = INTEGER.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    warnOnce(name, `${name}=${quote(raw)} is not a whole number; using ${shownFallback}.`);
    return fallback;
  }

  if (parsed < opts.min || parsed > opts.max) {
    if (opts.outOfRange === 'fallback') {
      warnOnce(
        name,
        `${name}=${parsed} is outside ${opts.min}..${opts.max}; using ${shownFallback}.`
      );
      return fallback;
    }
    const clamped = Math.min(opts.max, Math.max(opts.min, parsed));
    warnOnce(
      name,
      `${name}=${parsed} is outside ${opts.min}..${opts.max}; using ${clamped}${unit}.`
    );
    return clamped;
  }
  return parsed;
}

/* ------------------------------------------------------------------ dollars */

export type EnvDollarsOptions = {
  /** The most it may be, in thousandths of a dollar; above clamps and warns. */
  maxMilli: number;
};

/**
 * An amount of money, written in DOLLARS ("5", "0.25", "$12.50"), read as an
 * exact count of thousandths of a dollar.
 *
 * Through utils/money's one parser, so a variable reads the way every amount
 * typed into the app does: at most three decimals ($0.001 is the smallest
 * step), never negative, no exponents. Junk - "five", "0.0005", "-1" - warns
 * once and uses the default; above the ceiling clamps and warns, like envInt.
 */
export function envDollarsMilli(
  name: string,
  fallbackMilli: number,
  opts: EnvDollarsOptions,
  env: EnvSource = process.env
): number {
  const raw = envRaw(name, env);
  if (raw === null) return fallbackMilli;

  const parsed = parseDollars(raw);
  if (!parsed.ok) {
    const why =
      parsed.problem === 'precision'
        ? 'has more than three decimal places ($0.001 is the smallest step)'
        : parsed.problem === 'negative'
          ? 'is negative'
          : 'is not an amount in dollars';
    warnOnce(name, `${name}=${quote(raw)} ${why}; using ${formatMoney(fallbackMilli)}.`);
    return fallbackMilli;
  }
  if (parsed.milli > opts.maxMilli) {
    warnOnce(name, `${name}=${raw} is above ${formatMoney(opts.maxMilli)}; using ${formatMoney(opts.maxMilli)}.`);
    return opts.maxMilli;
  }
  return parsed.milli;
}

/* ----------------------------------------------------------------- booleans */

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on']);
const FALSE_WORDS = new Set(['0', 'false', 'no', 'off']);

/** 1/true/yes/on and 0/false/no/off, any case. Anything else warns and uses the default. */
export function envBool(
  name: string,
  fallback: boolean,
  _opts: Record<string, never> = {},
  env: EnvSource = process.env
): boolean {
  const raw = envRaw(name, env);
  if (raw === null) return fallback;

  const word = raw.toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;

  warnOnce(
    name,
    `${name}=${quote(raw)} is not one of 1/true/yes/on or 0/false/no/off; using ${fallback ? 'on' : 'off'}.`
  );
  return fallback;
}

/* -------------------------------------------------------------------- enums */

export type EnvEnumOptions<T extends string> = {
  values: readonly T[];
  /** Match regardless of case, returning the spelling in `values`. */
  caseInsensitive?: boolean;
};

/** One of a fixed list. */
export function envEnum<T extends string>(
  name: string,
  fallback: T,
  opts: EnvEnumOptions<T>,
  env: EnvSource = process.env
): T {
  const raw = envRaw(name, env);
  if (raw === null) return fallback;

  const match = opts.caseInsensitive
    ? opts.values.find((value) => value.toLowerCase() === raw.toLowerCase())
    : opts.values.find((value) => value === raw);
  if (match !== undefined) return match;

  warnOnce(
    name,
    `${name}=${quote(raw)} is not one of ${opts.values.join(', ')}; using ${quote(fallback)}.`
  );
  return fallback;
}

/* -------------------------------------------------------------------- lists */

export type EnvListOptions = {
  /** Every entry must match this (after `upperCase`, when set). */
  pattern?: RegExp;
  /**
   * A further rule every entry must pass, for one a pattern cannot say - a
   * model name the CLI it is meant for would silently replace, say. Judged
   * like the pattern: one entry that fails it rejects the whole value.
   */
  accept?: (entry: string) => boolean;
  upperCase?: boolean;
  expected?: string;
};

/**
 * A comma- and/or whitespace-separated list.
 *
 * All or nothing: one bad entry rejects the whole value and the default is used.
 * Dropping only the bad entry would quietly run with a list the operator never
 * wrote - for a proxy group list, a different proxy tier on the bill.
 */
export function envList(
  name: string,
  fallback: readonly string[],
  opts: EnvListOptions = {},
  env: EnvSource = process.env
): string[] {
  const raw = envRaw(name, env);
  if (raw === null) return [...fallback];

  const entries = raw
    .split(/[\s,]+/)
    .map((entry) => (opts.upperCase ? entry.toUpperCase() : entry))
    .filter(Boolean);
  const bad = entries.find(
    (entry) =>
      (opts.pattern !== undefined && !opts.pattern.test(entry)) ||
      (opts.accept !== undefined && !opts.accept(entry))
  );
  if (entries.length === 0 || bad !== undefined) {
    const what = bad !== undefined ? `has ${quote(bad)}, which is not ${opts.expected ?? 'accepted'}` : 'is empty';
    warnOnce(name, `${name}=${quote(raw)} ${what}; using ${quote(fallback.join(','))}.`);
    return [...fallback];
  }
  return entries;
}
