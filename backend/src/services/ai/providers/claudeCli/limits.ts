import type { CliRateLimitInfo } from './events';

/**
 * Rate-limit interpretation and the outage table.
 *
 * The point of both is that a limit or an outage should be discovered ONCE.
 * Without them, every request until the window resets spends its whole budget
 * rediscovering the same fact - and at the usage limit the CLI blocks silently
 * rather than failing, so each of those is a full stall timeout.
 */

/** The statuses under which a turn may proceed, per the CLI's own schema. */
const ALLOWED_STATUSES = new Set(['allowed', 'allowed_warning']);

/**
 * Windows scoped to ONE model rather than the whole seat. A weekly Opus cap is
 * not a weekly Sonnet cap, and a limit on one leaves the other answering.
 */
const MODEL_SCOPED_WINDOWS: Record<string, string> = {
  seven_day_opus: 'opus',
  seven_day_sonnet: 'sonnet',
};

export type RateLimitVerdict = {
  limited: boolean;
  /** Model alias the limit applies to, or '*' for the whole seat. */
  scope: string;
  reason: string;
  /** Epoch seconds when the window resets, when the CLI names one. */
  resetsAt: number | null;
  /** Highest window utilisation seen, for the admin health card. */
  utilization: number | null;
  /**
   * Fail the turn even if it produced an answer.
   *
   * True only for paid overage. An ordinary window filling on the last
   * successful call is a warning about the NEXT call, so that answer is kept;
   * an answer that was billed as extra usage is the thing this provider exists
   * to prevent, and silently keeping it means nobody ever finds out.
   */
  refuseEvenWithText: boolean;
};

export function interpretRateLimitEvent(
  info: CliRateLimitInfo | null,
  options: { allowOverage: boolean }
): RateLimitVerdict {
  const none: RateLimitVerdict = {
    limited: false,
    scope: '*',
    reason: '',
    resetsAt: null,
    utilization: null,
    refuseEvenWithText: false,
  };
  if (!info) {
    return none;
  }

  const scope = MODEL_SCOPED_WINDOWS[String(info.rateLimitType ?? '')] ?? '*';
  const resetsAt = typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) ? info.resetsAt : null;

  let utilization: number | null = null;
  let spentWindow: string | null = null;
  for (const [name, window] of Object.entries(info.unifiedWindows ?? {})) {
    const value = typeof window?.utilization === 'number' ? window.utilization : null;
    if (value === null) continue;
    if (utilization === null || value > utilization) {
      utilization = value;
    }
    // An overage window filling is not the subscription window filling.
    if (!name.toLowerCase().includes('overage') && value >= 1) {
      spentWindow = name;
    }
  }

  // Checked FIRST, before the status branch. The CLI reports isUsingOverage
  // alongside a non-allowed status, so testing status first returned early and
  // left this branch unreachable - accepting the one kind of turn this
  // provider exists to refuse.
  if (info.isUsingOverage === true && !options.allowOverage) {
    return {
      limited: true,
      scope: '*',
      reason: 'the subscription window is spent and the plan is billing extra usage',
      resetsAt,
      utilization,
      refuseEvenWithText: true,
    };
  }

  const status = String(info.status ?? '');
  if (status && !ALLOWED_STATUSES.has(status)) {
    return {
      limited: true,
      scope,
      reason: `rate limit status "${status}"`,
      resetsAt,
      utilization,
      refuseEvenWithText: false,
    };
  }

  // A window at 100% blocks the next turn without necessarily emitting another
  // event, so treat it as limited even while `status` still says allowed.
  if (spentWindow) {
    return {
      limited: true,
      // Scoped by the window that is ACTUALLY spent, not by rateLimitType.
      // The two are independent: `rateLimitType` names the window currently
      // doing the limiting, while this one was found by scanning. Every window
      // the CLI can put in `unifiedWindows` is seat-wide, so in practice this
      // resolves to '*' - which is the right answer, and is what the previous
      // code got wrong when rateLimitType happened to name a per-model window.
      scope: MODEL_SCOPED_WINDOWS[spentWindow] ?? '*',
      reason: `the ${spentWindow} usage window is fully used`,
      resetsAt,
      utilization,
      refuseEvenWithText: false,
    };
  }

  return { ...none, scope, resetsAt, utilization };
}

type Outage = { until: number; reason: string };

/** How long a signed-out seat is left alone: signing in is an operator action. */
const AUTH_HOLD_MS = 30 * 60_000;
/** The longest a reported reset time is taken on trust before one probe. */
const MAX_LIMIT_HOLD_MS = 30 * 60_000;
/** The shortest, so a limit reported with no reset time still holds briefly. */
const MIN_LIMIT_HOLD_MS = 5 * 60_000;

/**
 * What is known not to answer, until when, and why.
 *
 * Recovery is passive: a hold expires and the next real request is the probe.
 * Nothing polls. The 30-minute clamp on a limit means a lifted limit, a wrong
 * clock or an upgraded plan costs at most one stalled request to rediscover.
 */
export class OutageTable {
  private readonly entries = new Map<string, Outage>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly recoveryMs: number = 10 * 60_000
  ) {}

  /** Milliseconds this model is known to be out, and why. 0 when it is not. */
  check(model: string): { waitMs: number; reason: string } {
    const now = this.now();
    let waitMs = 0;
    let reason = '';
    for (const key of ['*', model]) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      if (entry.until <= now) {
        this.entries.delete(key);
        continue;
      }
      const remaining = entry.until - now;
      if (remaining > waitMs) {
        waitMs = remaining;
        reason = entry.reason;
      }
    }
    return { waitMs, reason };
  }

  private set(key: string, until: number, reason: string): void {
    const existing = this.entries.get(key);
    // Log an outage once, not once per request that discovers it.
    const isNew = !existing || existing.until <= this.now() || Math.abs(existing.until - until) > 60_000;
    this.entries.set(key, { until, reason });
    if (isNew) {
      const minutes = Math.max(1, Math.round((until - this.now()) / 60_000));
      const what = key === '*' ? 'the Claude subscription' : `model "${key}"`;
      console.warn(`[ai] Holding off ${what} for about ${minutes} minute(s): ${reason}`);
    }
  }

  noteAuth(reason: string): void {
    this.set('*', this.now() + AUTH_HOLD_MS, reason || 'the CLI reported it is not signed in');
  }

  noteLimit(scope: string, resetsAtSeconds: number | null, reason: string): void {
    const now = this.now();
    const requested = resetsAtSeconds ? resetsAtSeconds * 1000 : now + MIN_LIMIT_HOLD_MS;
    const until = Math.min(Math.max(requested, now + MIN_LIMIT_HOLD_MS), now + MAX_LIMIT_HOLD_MS);
    this.set(scope || '*', until, reason || 'the usage limit was reached');
  }

  noteUnavailable(model: string, reason: string): void {
    this.set(model, this.now() + this.recoveryMs, reason || 'the service refused this model');
  }

  noteSuccess(model: string): void {
    this.entries.delete(model);
    this.entries.delete('*');
  }

  snapshot(): Array<{ scope: string; reason: string; expiresAt: string }> {
    const now = this.now();
    const out: Array<{ scope: string; reason: string; expiresAt: string }> = [];
    for (const [scope, entry] of this.entries) {
      if (entry.until <= now) continue;
      out.push({ scope, reason: entry.reason, expiresAt: new Date(entry.until).toISOString() });
    }
    return out;
  }

  clear(): void {
    this.entries.clear();
  }
}
