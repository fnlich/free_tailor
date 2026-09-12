import { BROWSER_CHAT_SITE_IDS, type BrowserChatSiteId } from '../../config/providerCatalog';
import type { AIErrorKind } from './errors';

/**
 * Hybrid rides in the existing model picker rather than in a second select
 * beside it, because the two would contradict each other the moment they
 * disagreed - a profile set to model "ChatGPT (free)" and route "Claude only"
 * has no defensible reading. One control, and every option in it is a complete
 * answer to "what answers for this profile".
 */
export { HYBRID_MODEL_ID, HYBRID_MODEL_LABEL, HYBRID_MODEL_DESCRIPTION, isHybridModelId } from '../../config/providerCatalog';

/**
 * Which free chat account a profile's calls go to.
 *
 * The two free providers are not two models of one thing - they are two
 * ACCOUNTS, each with its own message allowance that refills on its own clock.
 * That is why this is a separate choice from the model: picking "Claude (free)"
 * says which model answers, and it also silently says "spend only the Claude
 * allowance", which is the part that runs out in the middle of a batch.
 *
 * `hybrid` is the option that could not be expressed before. One tailoring run
 * is three calls, and a batch of ten profiles is thirty; on one free account
 * that is a usage wall most of the way through, with no way to say "use the
 * other one too" short of editing every profile by hand.
 */
export const FREE_CHAT_ROUTES = ['claude-only', 'chatgpt-only', 'hybrid'] as const;
export type FreeChatRoute = (typeof FREE_CHAT_ROUTES)[number];

export function isFreeChatRoute(value: unknown): value is FreeChatRoute {
  return typeof value === 'string' && (FREE_CHAT_ROUTES as readonly string[]).includes(value);
}

const SITE_LABELS: Record<BrowserChatSiteId, string> = {
  'claude-web': 'Claude (free)',
  'chatgpt-web': 'ChatGPT (free)',
};

export function freeChatSiteLabel(site: BrowserChatSiteId): string {
  return SITE_LABELS[site];
}

/**
 * How long a site is passed over after it turns a call away.
 *
 * Long enough to be worth having - a usage wall is measured in hours, and
 * retrying it every call would spend the whole batch rediscovering the same
 * wall - and short enough that a wall which lifts, or a browser the operator
 * has just started, is picked up again without a restart.
 *
 * Not honoured when it would leave nothing to call: see `planRoute`. A cooldown
 * is a preference between two working options, never a reason to refuse work.
 */
const COOLDOWN_MS: Record<string, number> = {
  // Out of messages until the account's own clock says otherwise. The site
  // often names a time; nothing parses it, so this is a guess at the short end
  // deliberately - guessing long risks idling an account that is ready.
  rateLimited: 20 * 60_000,
  // Signed out, or the tab bounced to a login page. Fixing it means a person
  // going to that window, so re-asking every call is pure cost.
  auth: 10 * 60_000,
  // No debug browser answered. Cheap to recheck: the fix is starting a window,
  // which an operator does in seconds once they see the message.
  unavailable: 2 * 60_000,
};

/** The failures that mean "ask the other account", not "this call is bad". */
const FAILOVER_KINDS: ReadonlySet<AIErrorKind> = new Set<AIErrorKind>([
  'rateLimited',
  'auth',
  'unavailable',
  'locked',
  'disabled',
]);

export function isFailoverKind(kind: AIErrorKind): boolean {
  return FAILOVER_KINDS.has(kind);
}

type SiteState = {
  /** When this site may be preferred again. */
  cooldownUntil: number;
  /** Why it is being passed over, for the message when every site is cold. */
  cooldownReason: string;
  /** When a call last went to it, which is what spreads the load. */
  lastUsedAt: number;
};

const state = new Map<BrowserChatSiteId, SiteState>();

function stateFor(site: BrowserChatSiteId): SiteState {
  const existing = state.get(site);
  if (existing) return existing;
  const created: SiteState = { cooldownUntil: 0, cooldownReason: '', lastUsedAt: 0 };
  state.set(site, created);
  return created;
}

/** Tests share one process; a cooldown from one must not decide the next. */
export function resetFreeChatRoutingForTests(): void {
  state.clear();
}

export type RoutingClock = () => number;

const defaultClock: RoutingClock = () => Date.now();

/**
 * The sites a route may use, in the order it should try them.
 *
 * For the single-site routes this is one entry and the ordering question does
 * not arise. For hybrid it is both, least-recently-used first.
 *
 * Least-recently-used and not random, and not "whichever worked last": the
 * point of hybrid is to make two allowances last twice as long, and that only
 * happens if consecutive calls alternate. Preferring the last one that worked
 * would put every call of a batch on one account and hit the same wall as
 * before, a few calls later.
 */
export function planRoute(
  route: FreeChatRoute,
  now: RoutingClock = defaultClock
): BrowserChatSiteId[] {
  if (route === 'claude-only') return ['claude-web'];
  if (route === 'chatgpt-only') return ['chatgpt-web'];

  const at = now();
  const ranked = [...BROWSER_CHAT_SITE_IDS].sort((a, b) => {
    const left = stateFor(a);
    const right = stateFor(b);
    const leftCold = left.cooldownUntil > at;
    const rightCold = right.cooldownUntil > at;
    // A site on cooldown goes last, never away. Both being cold is the
    // ordinary state of an account that ran out an hour ago and a browser that
    // is not open yet, and refusing the call would be worse than trying the one
    // more likely to answer - the cooldowns are guesses, and the site is the
    // only thing that actually knows.
    if (leftCold !== rightCold) return leftCold ? 1 : -1;
    return left.lastUsedAt - right.lastUsedAt;
  });
  return ranked;
}

/** Records that a call is going out, so the next one prefers the other site. */
export function noteFreeChatAttempt(
  site: BrowserChatSiteId,
  now: RoutingClock = defaultClock
): void {
  stateFor(site).lastUsedAt = now();
}

/**
 * Records why a site turned a call away, so later calls pass over it.
 *
 * A kind with no cooldown listed clears nothing and sets nothing: a prompt that
 * failed to parse, or a caller that cancelled, says nothing about the account.
 */
export function noteFreeChatFailure(
  site: BrowserChatSiteId,
  kind: AIErrorKind,
  detail: string,
  now: RoutingClock = defaultClock
): void {
  const cooldown = COOLDOWN_MS[kind];
  if (!cooldown) return;
  const entry = stateFor(site);
  entry.cooldownUntil = now() + cooldown;
  entry.cooldownReason = detail;
}

/** Clears a site's cooldown, because it has just answered. */
export function noteFreeChatSuccess(site: BrowserChatSiteId): void {
  const entry = stateFor(site);
  entry.cooldownUntil = 0;
  entry.cooldownReason = '';
}

export type FreeChatSiteStatus = {
  site: BrowserChatSiteId;
  label: string;
  /** Null when it is not being passed over. */
  cooldownUntil: string | null;
  cooldownReason: string;
};

/** What the settings page shows about why calls are going where they are. */
export function describeFreeChatRouting(now: RoutingClock = defaultClock): FreeChatSiteStatus[] {
  const at = now();
  return BROWSER_CHAT_SITE_IDS.map((site) => {
    const entry = stateFor(site);
    const cold = entry.cooldownUntil > at;
    return {
      site,
      label: SITE_LABELS[site],
      cooldownUntil: cold ? new Date(entry.cooldownUntil).toISOString() : null,
      cooldownReason: cold ? entry.cooldownReason : '',
    };
  });
}
