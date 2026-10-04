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
 *   - The one exception is a URL (`envUrl`): its default is a vendor's endpoint,
 *     so "use the default" for a value set to somewhere else would send the
 *     traffic where the operator chose it not to go. A bad one is refused and
 *     the caller is told, rather than handed the default.
 *
 * Every primitive takes `(name, fallback, opts, env = process.env)`. The `env`
 * argument is the test seam: a test hands in a plain object and never has to
 * mutate - and then restore - the real process environment.
 */

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
  const bad = opts.pattern ? entries.find((entry) => !opts.pattern!.test(entry)) : undefined;
  if (entries.length === 0 || bad !== undefined) {
    const what = bad !== undefined ? `has ${quote(bad)}, which is not ${opts.expected ?? 'accepted'}` : 'is empty';
    warnOnce(name, `${name}=${quote(raw)} ${what}; using ${quote(fallback.join(','))}.`);
    return [...fallback];
  }
  return entries;
}

/* --------------------------------------------------------------------- URLs */

/**
 * Hosts that never leave the machine, where plain http costs nothing.
 *
 * WHATWG URL keeps the brackets on an IPv6 literal, so `[::1]` is what
 * `hostname` returns for http://[::1]:4000.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '[::1]' || host === '::1') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * What a URL setting resolved to.
 *
 * A refusal is its own outcome, never the fallback in disguise: see `envUrl`.
 * `problem` names the variable and says what is wrong without repeating the
 * value; `remedy` is the sentence to give an administrator.
 */
export type EnvUrl = { ok: true; url: string } | { ok: false; problem: string; remedy: string };

/**
 * An absolute http(s) base URL, with the trailing slash stripped.
 *
 * Unset or empty is the fallback - the vendor's endpoint. A value that is SET
 * is the operator's statement of where the traffic goes, and both ways of
 * second-guessing it would send it somewhere they did not name:
 *
 *   - Plain http is HONOURED, whatever the host, with one warning when the host
 *     is not this machine. An API key goes with every request, so http on a
 *     real network hands it to anybody on the path - but an operator who
 *     pointed OPENAI_BASE_URL at an Ollama or LM Studio box on the LAN, which
 *     the openai SDK always honoured, means that box.
 *   - A value that cannot be used is REFUSED, and the refusal is returned to
 *     the caller rather than replaced by the fallback. Every caller is an AI
 *     provider, and its fallback is the vendor: `localhost:11434/v1` (no
 *     scheme) or a gateway written with `user:password@` would otherwise send
 *     the prompt, the resume and the key to the very vendor the setting exists
 *     to route around - where before the openai SDK either failed the request
 *     or sent it to the operator's own host. So the provider that reads it
 *     sends nothing at all until the value is fixed or removed, and its health
 *     check says so. Nothing refuses to boot.
 *
 * Refused: anything that is not an absolute http(s) URL, an `@` anywhere (it
 * reads as `user:password@`, which Node's fetch refuses outright - and a
 * password with a `/` in it does not even parse as one), a query string and a
 * fragment (callers APPEND a path, `${base}/v1/messages`, which either breaks).
 *
 * The warning never repeats a refused value: it may hold a password or a key,
 * and the log is not where those belong. When the value parsed as http(s) and
 * has no `@`, its scheme, host and path are shown - what a valid value would
 * show on the startup line anyway.
 *
 * The slash is stripped so `https://gw.example/` and `https://gw.example` join
 * the same way.
 */
export function envUrl(
  name: string,
  fallback: string,
  _opts: Record<string, never> = {},
  env: EnvSource = process.env
): EnvUrl {
  const raw = envRaw(name, env);
  if (raw === null) return { ok: true, url: fallback };

  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  const isHttp = url !== null && (url.protocol === 'http:' || url.protocol === 'https:');

  const problem = raw.includes('@')
    ? `${name} has an "@" in it, which reads as user:password@ credentials`
    : !url || !isHttp
      ? `${name} is not an absolute http(s) URL - it has to start with http:// or https://`
      : url.search || url.hash
        ? `${name}=${quote(`${url.protocol}//${url.host}${url.pathname}`)} has a query string or fragment`
        : null;

  if (problem || !url) {
    const refusal = {
      ok: false as const,
      problem: problem ?? `${name} is not an absolute http(s) URL`,
      remedy: `Fix ${name} in the root .env, or remove it to use ${fallback}, and restart the backend.`,
    };
    // Only the query-string case shows anything of the value, and never that part.
    const withheld = problem?.includes('query string') ? 'neither is shown here' : 'the value is not repeated here';
    warnOnce(
      name,
      `${refusal.problem} (${withheld}). It is refused, and NOT replaced by ${fallback}: whatever it ` +
        'configures sends nothing until it is fixed or removed.'
    );
    return refusal;
  }

  const value = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    warnOnce(
      name,
      `${name}=${quote(value)} uses plain http to a host that is not this machine, so the API key ` +
        'sent with every request travels unencrypted. Using it as set; put it behind https or a ' +
        'localhost tunnel if that network is not one you trust.'
    );
  }
  return { ok: true, url: value };
}
