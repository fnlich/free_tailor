import type { AIErrorKind } from '../../errors';

/**
 * What a failed Gemini turn means, and how long the seat should be left alone
 * because of it.
 *
 * Exit codes first, because they are the CLI's own classification (read from
 * its FatalError classes): auth and config failures happen before any stdout -
 * the `init` event is only printed after the sign-in has been used - and write
 * nothing but a line on stderr. Once the stream exists, the result event's
 * error message is the evidence.
 */

export const GEMINI_EXIT_CODES = {
  AUTH: 41,
  INPUT: 42,
  SANDBOX: 44,
  CONFIG: 52,
  TURN_LIMIT: 53,
  TOOL: 54,
  UNTRUSTED_WORKSPACE: 55,
  CANCELLED: 130,
} as const;

/** What each fatal exit means, for the admin-facing detail. */
const EXIT_MEANING: Record<number, string> = {
  [GEMINI_EXIT_CODES.INPUT]: 'it refused its input',
  [GEMINI_EXIT_CODES.SANDBOX]: 'its sandbox failed',
  [GEMINI_EXIT_CODES.CONFIG]: 'its configuration was rejected',
  [GEMINI_EXIT_CODES.TURN_LIMIT]: 'it hit its turn limit',
  [GEMINI_EXIT_CODES.TOOL]: 'a tool failed',
  [GEMINI_EXIT_CODES.UNTRUSTED_WORKSPACE]: 'it does not trust its workspace',
  [GEMINI_EXIT_CODES.CANCELLED]: 'it was cancelled',
};

/**
 * An API error exits with its HTTP status, which POSIX truncates to a byte:
 * 429 -> 173, 404 -> 148, 401 -> 145, 403 -> 147, 500 -> 244, 503 -> 247.
 * Read from the CLI's error handler, not observed, so only a tiebreak when the
 * message itself says nothing classifiable.
 */
const STATUS_BY_EXIT_CODE: Record<number, number> = {
  173: 429,
  148: 404,
  145: 401,
  147: 403,
  244: 500,
  246: 502,
  247: 503,
  248: 504,
};

/**
 * The signed-out family, as the CLI words it on stderr (all three captured):
 * no credentials or a refresh that failed, no auth method configured at all,
 * and the workspace's enforced type refusing another one.
 */
const SIGNED_OUT = /manual authorization is required|please set an auth method|enforced authentication type|re-authenticate/i;

/**
 * The part of that family no network trouble can produce: no auth method at
 * all, or the workspace's enforced type refusing another. "Manual
 * authorization is required" is NOT here - the CLI says it whenever its token
 * check fails, a refused connection to oauth2.googleapis.com included.
 */
const AUTH_NOT_CONFIGURED = /please set an auth method|enforced authentication type|re-authenticate/i;

const QUOTA = /exhausted your (?:daily )?quota|quota|RESOURCE_EXHAUSTED|rate.?limit|capacity/i;
const MODEL_MISSING = /model not found|not.?found|NOT_FOUND/i;
const AUTH = /UNAUTHENTICATED|PERMISSION_DENIED|VALIDATION_REQUIRED|unauthori[sz]ed|forbidden/i;
const SERVER = /overloaded|UNAVAILABLE|internal error|fetch failed|ECONN|ETIMEDOUT|socket hang up|bad gateway/i;
/** MAX_TOKENS_EXCEEDED, the one truncation the CLI does report (with no text at all). */
const TRUNCATED = /truncated because it exceeded the token limit/i;

/**
 * A status code counts only next to a word that makes it one ("API Error: 429",
 * "status 503"), the rule the Claude seat learned: a bare three-digit number is
 * a stack column, a duration or a token count as often as it is a status.
 */
const STATUS_WORD = /(?:status|error|http|code)\W{0,4}(\d{3})(?![\d:.])/gi;

/**
 * The CLI's notice that a request was billed to the account's paid AI Credits.
 * The workspace settings make this impossible (`overageStrategy: never`), so
 * seeing it means something outranking them - a system settings file - turned
 * it back on. Only visible when it is the last stderr line the runner keeps.
 */
export const PAID_CREDITS = /Using AI Credits/i;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** stderr as text: the recorded signed-out line is wrapped in colour codes when NO_COLOR is unset. */
export function cleanStderr(text: string): string {
  return text.replace(ANSI, '').trim();
}

function kindForStatus(status: number): AIErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rateLimited';
  if (status === 404) return 'modelUnavailable';
  if (status >= 500) return 'unavailable';
  return 'failed';
}

function statusInText(text: string): number | null {
  STATUS_WORD.lastIndex = 0;
  const codes: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = STATUS_WORD.exec(text)) !== null) {
    codes.push(Number(match[1]));
  }
  // The most telling first: an auth or limit status outranks a generic 5xx.
  for (const wanted of [401, 403, 429, 404]) {
    if (codes.includes(wanted)) return wanted;
  }
  return codes.find((code) => code >= 500 && code < 600) ?? null;
}

/**
 * The delay a quota error asks for, in seconds: "Please retry in 34.5s" or
 * "Suggested retry after 60s", the CLI's two spellings.
 */
export function parseRetryAfterSeconds(text: string): number | null {
  const retryIn = /Please retry in ([0-9.]+)(ms|s)\b/i.exec(text);
  if (retryIn) {
    const value = Number(retryIn[1]);
    if (Number.isFinite(value)) return Math.max(1, Math.ceil(retryIn[2].toLowerCase() === 'ms' ? value / 1000 : value));
  }
  const suggested = /Suggested retry after ([0-9.]+)s\b/i.exec(text);
  if (suggested) {
    const value = Number(suggested[1]);
    if (Number.isFinite(value)) return Math.max(1, Math.ceil(value));
  }
  return null;
}

export type GeminiFailure = {
  kind: AIErrorKind;
  detail: string;
  retryAfterSeconds?: number;
  /**
   * The CLI refused its sign-in while a stored one is there: a revoked token,
   * or a token check the network never let reach Google. Not yet `auth`; the
   * adapter decides that once it repeats.
   */
  signInUnverified?: boolean;
};

export type GeminiClassifyInput = {
  exitCode: number | null;
  stderrTail: string;
  sawResult: boolean;
  status: string | null;
  /** The CLI's own words for the failure: `describeGeminiFailure(state)`. */
  message: string;
  /**
   * Whether the sign-in's home holds a Google sign-in with a refresh token
   * (`hasStoredGeminiSignIn`). Passed in so this stays a pure function.
   */
  credentialsPresent?: boolean;
};

/**
 * Classifies a turn that did NOT succeed. Never called for `status: "success"`.
 */
export function classifyGeminiFailure(input: GeminiClassifyInput): GeminiFailure {
  const stderr = cleanStderr(input.stderrTail);

  if (!input.sawResult) {
    if (input.exitCode === GEMINI_EXIT_CODES.AUTH || SIGNED_OUT.test(stderr)) {
      // On every start the CLI checks its cached token with Google, and ANY
      // failure there - a refused or reset connection, a proxy - ends in the
      // same exit 41 and "Manual authorization is required" as a real sign-out.
      // With a sign-in on disk that is far more often the network, so it is
      // not reported as one until it repeats.
      if (input.credentialsPresent && !AUTH_NOT_CONFIGURED.test(stderr)) {
        return {
          kind: 'unavailable',
          detail:
            'the Gemini CLI could not validate its Google sign-in - network or proxy trouble reaching ' +
            `oauth2.googleapis.com, or a token Google has revoked (${stderr || `exit ${input.exitCode}`})`,
          signInUnverified: true,
        };
      }
      return { kind: 'auth', detail: stderr || `the CLI exited ${input.exitCode} (authentication)` };
    }
    const exitStatus = input.exitCode !== null ? STATUS_BY_EXIT_CODE[input.exitCode] : undefined;
    if (exitStatus) {
      return {
        kind: kindForStatus(exitStatus),
        detail: stderr || `the CLI exited ${input.exitCode} (HTTP ${exitStatus}) without a result`,
      };
    }
    const meaning = input.exitCode !== null ? EXIT_MEANING[input.exitCode] : undefined;
    const why =
      input.exitCode === 0
        ? 'the CLI exited 0 without a result, so it was stopped before it finished'
        : meaning
          ? `the CLI exited ${input.exitCode}: ${meaning}`
          : `the CLI exited ${input.exitCode ?? '(no code)'} without a result`;
    return { kind: 'failed', detail: stderr ? `${why} (${stderr})` : why };
  }

  const message = input.message.trim();
  const detail = message || stderr || `the turn ended with status "${input.status ?? 'unknown'}"`;

  if (TRUNCATED.test(message)) return { kind: 'truncated', detail };
  if (QUOTA.test(message) || statusInText(message) === 429) {
    const retryAfterSeconds = parseRetryAfterSeconds(message);
    return { kind: 'rateLimited', detail, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) };
  }
  if (MODEL_MISSING.test(message) || statusInText(message) === 404) return { kind: 'modelUnavailable', detail };

  const status = statusInText(message);
  if (AUTH.test(message) || status === 401 || status === 403) return { kind: 'auth', detail };
  if (SERVER.test(message) || (status !== null && status >= 500)) return { kind: 'unavailable', detail };

  // A safety or recitation block, an empty response, a malformed stream: the
  // CLI has already retried those, so there is nothing more specific to say.
  const exitStatus = input.exitCode !== null ? STATUS_BY_EXIT_CODE[input.exitCode] : undefined;
  if (exitStatus) return { kind: kindForStatus(exitStatus), detail };
  return { kind: 'failed', detail };
}

/* ============================================================ outage table */

export type GeminiHoldKind = 'auth' | 'rateLimited' | 'modelUnavailable' | 'unavailable';

type Hold = { until: number; reason: string; kind: GeminiHoldKind; since: number };

/** Signing in is an operator's action, so a signed-out seat is left alone for a while. */
const AUTH_HOLD_MS = 30 * 60_000;
/** The longest any reported delay is taken on trust before one real request probes it. */
const MAX_LIMIT_HOLD_MS = 30 * 60_000;
/** A quota error that names no delay. */
const DEFAULT_LIMIT_HOLD_MS = 5 * 60_000;
/** The shortest hold, so a "retry in 2s" the CLI has already outwaited still spaces calls out. */
const MIN_LIMIT_HOLD_MS = 30_000;
/** A model the account cannot use stays that way until an admin changes something. */
const MODEL_HOLD_MS = 10 * 60_000;
/** A 5xx that survived the CLI's own retries. */
const UNAVAILABLE_HOLD_MS = 2 * 60_000;
/**
 * A sign-in the CLI could not validate, while one is on disk: short, because
 * it is usually the network, and seat-wide, because every model shares it.
 */
const SIGN_IN_UNVERIFIED_HOLD_MS = 2 * 60_000;
/**
 * How many of those in a row, with no success between, before it is called a
 * sign-in problem - so a token Google has revoked still ends at "sign in
 * again" after a few minutes, rather than at short holds forever.
 */
const SIGN_IN_UNVERIFIED_LIMIT = 3;

/**
 * What is known not to answer, until when, and why - so a spent quota or a
 * signed-out seat is discovered once, not by every request until it changes.
 *
 * The Claude seat's table, adapted rather than shared: a Google account's quota
 * is ACCOUNT-wide (scope '*') whatever the model, the delays come from the
 * error text rather than a rate-limit event, and each hold records its kind so
 * a turned-away call reports the right one. Recovery is passive: a hold expires
 * and the next real request is the probe - except a sign-in hold, which turns
 * away the very success that would clear it, and is lifted instead by a sign-in
 * written after it (`clearAuth`).
 */
export class GeminiOutageTable {
  private readonly holds = new Map<string, Hold>();
  private unverifiedInARow = 0;
  /** When the latest sign-in the CLI could not validate was noted. */
  private lastUnverifiedAt = 0;

  constructor(
    private readonly now: () => number = Date.now,
    /** How the log names the seat: one of several Gemini providers says which. */
    private readonly seatName: string = 'the Gemini seat'
  ) {}

  /** The hold on the whole account, while it lasts - what moves a type's work to another provider. */
  seatHold(): { until: number; reason: string; kind: GeminiHoldKind } | null {
    const hold = this.holds.get('*');
    if (!hold || hold.until <= this.now()) return null;
    return { until: hold.until, reason: hold.reason, kind: hold.kind };
  }

  /** How long `model` is known to be out, why, and as what kind. */
  check(model: string): { waitMs: number; reason: string; kind: GeminiHoldKind | null } {
    const now = this.now();
    let found: { waitMs: number; reason: string; kind: GeminiHoldKind | null } = {
      waitMs: 0,
      reason: '',
      kind: null,
    };
    for (const key of ['*', model]) {
      const hold = this.holds.get(key);
      if (!hold) continue;
      if (hold.until <= now) {
        this.holds.delete(key);
        continue;
      }
      if (hold.until - now > found.waitMs) {
        found = { waitMs: hold.until - now, reason: hold.reason, kind: hold.kind };
      }
    }
    return found;
  }

  private set(key: string, until: number, reason: string, kind: GeminiHoldKind): void {
    const existing = this.holds.get(key);
    // Logged once per hold, not once per request that runs into it.
    const isNew = !existing || existing.until <= this.now() || Math.abs(existing.until - until) > 60_000;
    // `since` is the latest time it was set: only a sign-in written after that
    // may lift it.
    this.holds.set(key, { until, reason, kind, since: this.now() });
    if (isNew) {
      const seconds = Math.max(1, Math.round((until - this.now()) / 1000));
      const span = seconds >= 120 ? `${Math.round(seconds / 60)} minute(s)` : `${seconds} second(s)`;
      const what = key === '*' ? this.seatName : `Gemini model "${key}"`;
      console.warn(`[ai] Holding off ${what} for about ${span}: ${reason}`);
    }
  }

  noteAuth(reason: string): void {
    this.set('*', this.now() + AUTH_HOLD_MS, reason || 'the Gemini CLI is not signed in', 'auth');
  }

  /** Account-wide. `retryAfterSeconds` is the delay the error asked for, when it named one. */
  noteLimit(retryAfterSeconds: number | null, reason: string): void {
    const requested = retryAfterSeconds ? retryAfterSeconds * 1000 : DEFAULT_LIMIT_HOLD_MS;
    const holdMs = Math.min(MAX_LIMIT_HOLD_MS, Math.max(MIN_LIMIT_HOLD_MS, requested));
    this.set('*', this.now() + holdMs, reason || 'the Google account quota is spent', 'rateLimited');
  }

  noteModelUnavailable(model: string, reason: string): void {
    this.set(model, this.now() + MODEL_HOLD_MS, reason || 'the account cannot use this model', 'modelUnavailable');
  }

  noteUnavailable(model: string, reason: string): void {
    this.set(model, this.now() + UNAVAILABLE_HOLD_MS, reason || 'the service did not answer', 'unavailable');
  }

  /**
   * A sign-in the CLI could not validate (see `signInUnverified`). Held
   * briefly, as `unavailable`; the third in a row with no success between
   * becomes the 30-minute sign-in hold. Returns true when it did.
   */
  noteSignInUnverified(reason: string): boolean {
    this.unverifiedInARow += 1;
    this.lastUnverifiedAt = this.now();
    if (this.unverifiedInARow >= SIGN_IN_UNVERIFIED_LIMIT) {
      this.unverifiedInARow = 0;
      this.noteAuth(`${reason}; ${SIGN_IN_UNVERIFIED_LIMIT} times in a row, so treated as signed out`);
      return true;
    }
    this.set('*', this.now() + SIGN_IN_UNVERIFIED_HOLD_MS, reason, 'unavailable');
    return false;
  }

  noteSuccess(model: string): void {
    this.holds.delete(model);
    this.holds.delete('*');
    this.unverifiedInARow = 0;
  }

  /**
   * A sign-in written at `signedInAt` (the credential file's modification
   * time) lifts a sign-in hold set BEFORE it, and forgets the unvalidated
   * sign-ins counted before it. Keyed on the file, not on a check finding it:
   * the check only reads the file, so it says "signed in" for a token Google
   * has revoked too - which is exactly the escalated hold. Only signing in
   * again writes the file. True when it lifted a hold.
   */
  clearAuth(signedInAt: number): boolean {
    if (!Number.isFinite(signedInAt)) return false;
    if (signedInAt > this.lastUnverifiedAt) this.unverifiedInARow = 0;
    const hold = this.holds.get('*');
    if (!hold || hold.kind !== 'auth' || signedInAt <= hold.since) return false;
    this.holds.delete('*');
    if (hold.until <= this.now()) return false;
    console.warn(`[ai] Lifting the hold on ${this.seatName}: it was signed in again after the hold began`);
    return true;
  }

  snapshot(): Array<{ scope: string; reason: string; expiresAt: string }> {
    const now = this.now();
    const out: Array<{ scope: string; reason: string; expiresAt: string }> = [];
    for (const [scope, hold] of this.holds) {
      if (hold.until <= now) continue;
      out.push({ scope, reason: hold.reason, expiresAt: new Date(hold.until).toISOString() });
    }
    return out;
  }
}
