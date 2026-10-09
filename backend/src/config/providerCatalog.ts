import type { AIProvider } from '../types/template';

export type ProviderDescriptor = {
  id: AIProvider;
  /** Shown in every UI that names a provider. Never render a raw id. */
  label: string;
  /** Short line under the label in the admin provider list. */
  summary: string;
  /**
   * True when this build does not offer the provider to run on.
   *
   * A LOCK IS NOT THE ADMIN'S DISABLE SWITCH. `providersEnabled` records what
   * the operator chose and is theirs to change from the Settings page; a lock
   * is a property of the deployment - the thing the provider needs is not
   * present here - and no amount of ticking a box makes it runnable. Which is
   * why the UI keeps a locked provider's models on screen with a padlock
   * rather than hiding them: "you cannot pick this, and here is why" is
   * information, and a model that silently vanishes is a bug report.
   *
   * Escapable at the deployment level, never from the UI: see
   * `AI_UNLOCKED_PROVIDERS` below.
   */
  locked: boolean;
  /**
   * Why it is locked, and what would unlock it. Shown verbatim next to the
   * padlock, so it is written for the person reading the screen.
   */
  lockReason: string;
  /** Sort order in menus; also the order getDefaultEnabledProvider walks. */
  order: number;
};

/**
 * The single source of truth for "which AI providers exist".
 *
 * Before this table the same four-way branch was hand-written in eleven places
 * across aiModelConfig.ts, and four of those ended in an unguarded `else` that
 * returned the last provider's answer - so a provider added without touching
 * all four silently reported as another one, gated by its flag and handed its
 * key. `satisfies Record<AIProvider, ...>` turns that class of bug into a
 * compile error.
 *
 * Only subscription seats: CLIs the operator signed in on this machine, with
 * no API key for this app to hold and nothing billed per token.
 */
export const PROVIDER_CATALOG = {
  'claude-cli': {
    id: 'claude-cli',
    label: 'Claude (Subscription)',
    summary: 'Runs the local `claude` CLI on the signed-in subscription seat. No API key, no metered tokens.',
    // Offered. It was locked while this installation had no seat signed in, and
    // that is not a build-time fact - whether the `claude` binary is on PATH and
    // signed in is something only the machine can answer, and the health check
    // asks it. A lock would say "this deployment cannot run it", which is now
    // simply untrue and left the one keyless, unmetered provider unpickable.
    //
    // The reason survives the unlock: an operator on a box with no seat can put
    // this provider back behind a padlock with AI_LOCKED_PROVIDERS, and the
    // sentence they want shown then is this one, not a generic "turned off".
    locked: false,
    lockReason:
      'Needs the `claude` CLI installed and a subscription seat signed in on this machine. ' +
      'Run `claude login` there, then remove it from AI_LOCKED_PROVIDERS.',
    order: 0,
  },
  'codex-cli': {
    id: 'codex-cli',
    label: 'Codex (Subscription)',
    summary:
      'Runs the local `codex` CLI on the signed-in ChatGPT subscription. No API key, no metered tokens.',
    locked: false,
    lockReason:
      'Needs the `codex` CLI installed and a ChatGPT subscription signed in on this machine. ' +
      'Run `codex login --device-auth` there, then remove it from AI_LOCKED_PROVIDERS.',
    order: 1,
  },
  'gemini-cli': {
    id: 'gemini-cli',
    label: 'Gemini (Subscription)',
    summary:
      'Runs the local `gemini` CLI on the signed-in Google account. No API key, no metered tokens.',
    // Offered, like the other two: whether `gemini` is installed and signed in
    // is the health check's question, not the build's.
    locked: false,
    lockReason:
      'Needs the `gemini` CLI installed (`npm i -g @google/gemini-cli`) and a Google account signed in on ' +
      'this machine. Run `NO_BROWSER=true gemini` there once as the user this server runs as, then remove ' +
      'it from AI_LOCKED_PROVIDERS.',
    order: 2,
  },
} as const satisfies Record<AIProvider, ProviderDescriptor>;

/** Every provider id, in menu order. */
export const AI_PROVIDER_IDS: readonly AIProvider[] = (
  Object.values(PROVIDER_CATALOG) as ProviderDescriptor[]
)
  .slice()
  .sort((a, b) => a.order - b.order)
  .map((descriptor) => descriptor.id);

export function getProviderDescriptor(id: AIProvider): ProviderDescriptor {
  return PROVIDER_CATALOG[id];
}

export function getProviderLabel(id: AIProvider): string {
  return (PROVIDER_CATALOG[id] as ProviderDescriptor | undefined)?.label ?? id;
}

/**
 * The env var that lifts a lock, as a comma or space separated list of
 * provider ids: `AI_UNLOCKED_PROVIDERS=claude-cli`.
 *
 * A deployment-level escape hatch on purpose. The lock says "the thing this
 * provider needs is not here", and the only person who can know that has
 * changed is whoever installed the CLI or signed the seat in - not a user
 * clicking around the admin pages, which is why there is no button for it.
 * Read on every call rather than captured at import, so a test can set it and
 * so a restart is the only thing needed to apply it.
 */
export const UNLOCKED_PROVIDERS_ENV_VAR = 'AI_UNLOCKED_PROVIDERS';

/**
 * The env var that ADDS a lock: `AI_LOCKED_PROVIDERS=claude-cli`.
 *
 * The mirror of the one above, and it earns its place for the same reason that
 * one does. No provider is locked in the shipped catalog any more, but whether a
 * provider can run here is still a fact only the machine knows - a box with no
 * `claude` binary, or a shared install whose operator does not want the
 * subscription seat spent, wants the seat gone from the picker with a padlock
 * and a reason rather than present and failing at generate time.
 *
 * Unlock wins over lock when a provider is named in both, so the escape hatch
 * stays an escape hatch.
 */
export const LOCKED_PROVIDERS_ENV_VAR = 'AI_LOCKED_PROVIDERS';

function envProviderList(name: string): Set<string> {
  const raw = process.env[name];
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

/**
 * True when this deployment cannot run the provider.
 *
 * Deliberately NOT a function of the settings row: a lock and the admin's
 * enable flag answer different questions, and merging them would make
 * "unticked because I do not want it" indistinguishable from "cannot run
 * here". `isProviderEnabled` in aiModelConfig is where the two meet.
 */
export function isProviderLocked(id: AIProvider): boolean {
  if (envProviderList(UNLOCKED_PROVIDERS_ENV_VAR).has(id)) {
    return false;
  }
  if (envProviderList(LOCKED_PROVIDERS_ENV_VAR).has(id)) {
    return true;
  }
  return (PROVIDER_CATALOG[id] as ProviderDescriptor | undefined)?.locked ?? false;
}

/** Why `id` is locked, or '' when it is not locked right now. */
export function getProviderLockReason(id: AIProvider): string {
  if (!isProviderLocked(id)) {
    return '';
  }
  const descriptor = PROVIDER_CATALOG[id] as ProviderDescriptor | undefined;
  // A catalog reason when the catalog is what locked it; otherwise the operator
  // did, and saying so points at the fix rather than at a condition the
  // deployment does not actually have.
  return (
    descriptor?.lockReason ||
    `Turned off for this installation (${LOCKED_PROVIDERS_ENV_VAR}). ` +
      'Remove it from that list to offer it again.'
  );
}

/** Every provider locked right now, in menu order. */
export function listLockedProviderIds(): AIProvider[] {
  return AI_PROVIDER_IDS.filter((id) => isProviderLocked(id));
}

/**
 * Narrows an untrusted string to a provider id. Returns null for anything
 * unrecognised so callers can decide between "fall back to the default" and
 * "reject the request".
 */
export function coerceProviderId(value: unknown): AIProvider | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(PROVIDER_CATALOG, trimmed)) {
    return trimmed as AIProvider;
  }

  return null;
}
