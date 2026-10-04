/**
 * Reading a configuration value on the frontend.
 *
 * Not a copy of the backend's `config/envValue.ts`, and it cannot be one. Those
 * helpers take a variable's NAME and look it up in `process.env`; Next inlines
 * a `NEXT_PUBLIC_` value into the browser bundle only where the literal
 * expression `process.env.NEXT_PUBLIC_X` appears in the source, so a lookup by
 * name (`process.env[name]`) compiles to `undefined` in the browser and the
 * setting silently does nothing. Every helper here therefore takes the VALUE -
 * the call site writes the literal expression - and the name only to say which
 * setting was ignored.
 *
 * Server-only values (read inside a route handler at request time) go through
 * the same helpers, with the value read from `process.env` by the caller, so
 * both kinds of setting obey one set of rules.
 *
 * The rules are the backend's, because one .env feeds both sides and an
 * operator should not have to learn two dialects:
 *
 * - empty or whitespace means the default. The root .env is copied key by key,
 *   so a bare `NAME=` left over from .env.example arrives as '' rather than as
 *   unset, and it must not read as a value;
 * - junk is the default, with one warning per setting;
 * - a number out of range is clamped to the nearest bound, with one warning;
 * - nothing here throws. A typo in .env has to cost a log line, not a page.
 */

const warned = new Set<string>();

/**
 * Logs once per setting, under the same `[env]` tag and in the same words as
 * the backend's warnings, so one grep of the logs finds both sides. Once,
 * because the server-side settings are read per request.
 */
function warnOnce(name: string, message: string): void {
  if (warned.has(name)) return;
  warned.add(name);
  console.warn(`[env] ${message}`);
}

/** How a value is quoted in a warning: short, and never with a line break in it. */
function quote(value: string): string {
  const single = value.replace(/[\r\n\t]+/g, ' ');
  return JSON.stringify(single.length > 80 ? `${single.slice(0, 77)}...` : single);
}

/** A trimmed string, or `fallback` when it is unset, empty or whitespace. */
export function envString(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

/**
 * A whole number within `min..max`.
 *
 * Whole numbers only, written as digits: `12000` is read, and `12e3`, `12s`
 * and `12,000` are junk. `parseInt('12s')` is 12, so a unit typed into a `_MS`
 * setting would otherwise become a timeout a thousand times too short without
 * a word - and a value silently different from the one written is worse than
 * the default, which at least is documented.
 */
export function envInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name = 'A setting'
): number {
  const raw = value?.trim();
  if (!raw) return fallback;

  const parsed = /^[+-]?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    warnOnce(name, `${name}=${quote(raw)} is not a whole number; using ${fallback}.`);
    return fallback;
  }
  if (parsed < min || parsed > max) {
    // Clamped rather than defaulted: a timeout that is merely too long still
    // gets as long as it is allowed to be, which is what the operator meant.
    const clamped = Math.min(max, Math.max(min, parsed));
    warnOnce(name, `${name}=${parsed} is outside ${min}..${max}; using ${clamped}.`);
    return clamped;
  }
  return parsed;
}

/**
 * An IANA time zone name, such as `America/Los_Angeles`, or `fallback`.
 *
 * The test is whether `Intl.DateTimeFormat` accepts it, which is the same
 * engine that will later format times in it - a zone it rejects would throw a
 * RangeError the first time the page used it, so it is refused here instead.
 * Offset forms (`+05:00`), which newer engines also accept, are refused too:
 * they are not zone names, and the calendar API is sent the name.
 *
 * The value is returned as written rather than as `resolvedOptions()` reports
 * it, on purpose. Engines disagree about which spelling of a renamed zone is
 * canonical (`Asia/Kolkata` comes back as `Asia/Calcutta` in V8), and this runs
 * both while the server renders the page and again in the browser: two
 * different answers would be a hydration mismatch and a request whose zone
 * depended on which browser sent it.
 */
export function envTimeZone(
  value: string | undefined,
  fallback: string,
  name = 'A time zone setting'
): string {
  const raw = value?.trim();
  if (!raw) return fallback;
  if (isTimeZoneName(raw)) return raw;

  warnOnce(name, `${name}=${quote(raw)} is not a time zone this runtime knows; using ${quote(fallback)}.`);
  return fallback;
}

/** Whether `value` is a time zone name the runtime's Intl accepts. */
export function isTimeZoneName(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
