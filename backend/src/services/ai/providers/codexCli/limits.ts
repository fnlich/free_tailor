/**
 * A Codex seat's usage limit, read from the turn's own words, and how long it
 * holds the provider.
 *
 * Codex once kept no holds at all, on the reasoning that modelling a refusal
 * nobody here had seen would produce a confidently wrong message. That was
 * affordable with one Codex seat. With several providers of a type (owner
 * decision P4) it is not: a provider at its limit fails each turn in a moment,
 * which makes it the least loaded lane, so placement, an idle slot's steal and
 * every retry kept handing it the work a healthy Codex provider could build -
 * and a resume failed on its last attempt there. So a usage limit now HOLDS the
 * provider, like the Claude and Gemini seats, and its waiting work moves.
 *
 * The match is deliberately on the limit's plain words rather than on one
 * captured envelope (this machine has no ChatGPT credential): the CLI's own
 * "You've hit your usage limit. ... try again in 4 days 2 hours" and the
 * HTTP-ish "429 Too Many Requests" / "rate limit" a backend error carries. A
 * phrasing it misses fails the turn as before - retried, never held - which
 * is the old behaviour, not a new failure.
 */

/** What a Codex hold is for. One kind: a signed-out seat is its health reading, not a hold. */
export type CodexHoldKind = 'rateLimited';

const USAGE_LIMIT = /\busage\s+limit\b|\brate[\s_-]*limit|\btoo\s+many\s+requests\b|\b429\b/i;

/** True when a failed turn's words say the seat is out of its usage window. */
export function isCodexUsageLimit(text: string): boolean {
  return USAGE_LIMIT.test(text);
}

const UNIT_SECONDS: ReadonlyArray<[RegExp, number]> = [
  [/^d(?:ays?)?$/i, 86_400],
  [/^h(?:ours?|rs?)?$/i, 3_600],
  [/^m(?:in(?:ute)?s?)?$/i, 60],
  [/^s(?:ec(?:ond)?s?)?$/i, 1],
];

/**
 * The wait the CLI names - "try again in 4 days 2 hours 3 minutes", "in 45
 * seconds" - in seconds, or null when it names none it can be read from (a
 * clock time, "later"). A clock time is not guessed at: its time zone is the
 * CLI's, not necessarily this server's.
 */
export function codexRetryAfterSeconds(text: string): number | null {
  const tail = /try\s+again\s+in\s+([^.;\n]+)/i.exec(text);
  if (!tail) return null;
  let total = 0;
  let found = false;
  for (const part of tail[1].matchAll(/(\d+)\s*([a-z]+)/gi)) {
    const unit = UNIT_SECONDS.find(([pattern]) => pattern.test(part[2]));
    if (!unit) continue;
    total += Number(part[1]) * unit[1];
    found = true;
  }
  return found && total > 0 ? total : null;
}

/** Never shorter than this, so a limit reported with a tiny wait still holds briefly. */
export const MIN_CODEX_LIMIT_HOLD_MS = 5 * 60_000;
/**
 * Never longer: a weekly limit is taken on trust for half an hour at a time,
 * so a lifted limit, a wrong reading or an upgraded plan costs one failed turn
 * to rediscover - the Claude seat's rule.
 */
export const MAX_CODEX_LIMIT_HOLD_MS = 30 * 60_000;
/** When the CLI names no wait at all. */
export const DEFAULT_CODEX_LIMIT_HOLD_MS = 15 * 60_000;

/** How long a usage limit holds the provider, from the wait the CLI named. */
export function codexLimitHoldMs(retryAfterSeconds: number | null): number {
  const requested = retryAfterSeconds ? retryAfterSeconds * 1000 : DEFAULT_CODEX_LIMIT_HOLD_MS;
  return Math.min(MAX_CODEX_LIMIT_HOLD_MS, Math.max(MIN_CODEX_LIMIT_HOLD_MS, requested));
}
