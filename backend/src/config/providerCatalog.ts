import type { AIProvider } from '../types/template';

/**
 * How a provider proves who it is.
 *
 * `api-key`   - a secret read from the environment.
 * `subscription-seat` - a sign-in the operator performed on the server; there
 *               is no secret for this app to store, hold, or leak.
 * `browser-session` - a chat site the operator is signed in to in a Chrome
 *               they started themselves. This app stores no credential and
 *               never asks for one: it attaches to that browser over the
 *               DevTools protocol and drives the page, so the session cookie
 *               is never copied anywhere. Worth being exact about what that
 *               does and does not mean - a DevTools attachment CAN read the
 *               cookies of the browser it is attached to. Nothing here does,
 *               and the code that drives the page is right there to check, but
 *               the guarantee is "this app does not", not "this app could
 *               not". Which is why it attaches to a browser the operator
 *               started, on loopback, with a profile of its own.
 */
export type CredentialKind = 'api-key' | 'subscription-seat' | 'browser-session';

export type ProviderDescriptor = {
  id: AIProvider;
  /** Shown in every UI that names a provider. Never render a raw id. */
  label: string;
  /** Short line under the label in the admin provider list. */
  summary: string;
  /**
   * The flat wire field an already-loaded browser tab reads for this provider.
   *
   * Null for a provider added after those flags stopped being written: nothing
   * older than it can be asking about it, so inventing a flag would only be a
   * field with no reader.
   */
  legacyEnabledField:
    | 'claudeCliEnabled'
    | 'claudeEnabled'
    | 'openaiEnabled'
    | 'deepseekEnabled'
    | null;
  /**
   * Whether the effort and thinking knobs reach the model at all.
   *
   * Here, with the provider's other facts, rather than only on the adapter,
   * because the UI needs it and the adapter is not reachable from the settings
   * layer. Each adapter reads its own capabilities from this, so the answer a
   * picker greys a select with is the same one the transport acts on.
   *
   * The chat providers are the reason this exists. A chat window has no effort
   * flag and no thinking budget: there is nowhere to put either. Offering the
   * two selects anyway meant a profile could be saved asking for `effort=max`
   * on ChatGPT, where it changed nothing and said nothing.
   */
  supportsEffort: boolean;
  supportsThinking: boolean;
  /** Environment variable holding this provider's key, or null when keyless. */
  envKeyVar: string | null;
  requiresApiKey: boolean;
  credentialKind: CredentialKind;
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
 * returned the DeepSeek answer - so a provider added without touching all four
 * silently reported as DeepSeek, was gated by `deepseekEnabled`, and was handed
 * `DEEPSEEK_API_KEY`. `satisfies Record<AIProvider, ...>` turns that class of
 * bug into a compile error.
 */
export const PROVIDER_CATALOG = {
  'claude-cli': {
    id: 'claude-cli',
    label: 'Claude (subscription)',
    summary: 'Runs the local `claude` CLI on the signed-in subscription seat. No API key, no metered tokens.',
    supportsEffort: true,
    supportsThinking: true,
    legacyEnabledField: 'claudeCliEnabled',
    envKeyVar: null,
    requiresApiKey: false,
    credentialKind: 'subscription-seat',
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
  claude: {
    id: 'claude',
    label: 'Anthropic API',
    summary: 'Anthropic Messages API with an API key. Billed per token.',
    supportsEffort: false,
    supportsThinking: false,
    legacyEnabledField: 'claudeEnabled',
    envKeyVar: 'ANTHROPIC_API_KEY',
    requiresApiKey: true,
    credentialKind: 'api-key',
    locked: false,
    lockReason: '',
    order: 1,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    summary: 'OpenAI chat completions with an API key. Billed per token.',
    supportsEffort: false,
    supportsThinking: false,
    legacyEnabledField: 'openaiEnabled',
    envKeyVar: 'OPENAI_API_KEY',
    requiresApiKey: true,
    credentialKind: 'api-key',
    locked: false,
    lockReason: '',
    order: 2,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    summary: 'DeepSeek chat completions with an API key. Billed per token.',
    supportsEffort: false,
    supportsThinking: false,
    legacyEnabledField: 'deepseekEnabled',
    envKeyVar: 'DEEPSEEK_API_KEY',
    requiresApiKey: true,
    credentialKind: 'api-key',
    locked: false,
    lockReason: '',
    order: 3,
  },
  'claude-web': {
    id: 'claude-web',
    label: 'Claude (free)',
    summary:
      'Drives claude.ai in a Chrome you started and signed in to. Free: no API key, nothing metered, and the chat plan you already have is the quota. Add a browser per parallel request under Settings.',
    supportsEffort: false,
    supportsThinking: false,
    legacyEnabledField: null,
    envKeyVar: null,
    requiresApiKey: false,
    credentialKind: 'browser-session',
    locked: false,
    lockReason: '',
    order: 4,
  },
  'chatgpt-web': {
    id: 'chatgpt-web',
    label: 'ChatGPT (free)',
    summary:
      'Drives chatgpt.com in a Chrome you started and signed in to. Free: no API key, nothing metered, and the chat plan you already have is the quota. Add a browser per parallel request under Settings.',
    supportsEffort: false,
    supportsThinking: false,
    legacyEnabledField: null,
    envKeyVar: null,
    requiresApiKey: false,
    credentialKind: 'browser-session',
    locked: false,
    lockReason: '',
    order: 5,
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
  return PROVIDER_CATALOG[id]?.label ?? id;
}

export function providerRequiresApiKey(id: AIProvider): boolean {
  return PROVIDER_CATALOG[id]?.requiresApiKey ?? true;
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
 * Provider ids that were valid in an older release, and what they became.
 *
 * This map is PERMANENT, not a migration step. A boot migration rewrites the
 * settings row once, but stored provider strings reach typed code from places
 * a migration cannot cover: a restored backup, a hand-edited row, and
 * scripts/migrateLegacyData.ts, which writes a legacy `ai-models.json`
 * verbatim at any later time. Coercing on read means none of those can brick
 * the app; the migration is then an improvement rather than a prerequisite.
 */
export const LEGACY_PROVIDER_ALIASES: Readonly<Record<string, AIProvider>> = Object.freeze(
  // Null prototype: a plain object would resolve "constructor", "toString" and
  // every other inherited name to an Object.prototype member, and a stored
  // provider string of that shape would then be handed back as a provider id.
  Object.assign(Object.create(null) as Record<string, AIProvider>, {
    openrouter: 'claude-cli' as AIProvider,
  })
);

const warnedAliases = new Set<string>();

/**
 * Narrows an untrusted string to a provider id, following legacy aliases.
 * Returns null for anything unrecognised so callers can decide between
 * "fall back to the default" and "reject the request".
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

  const alias = Object.prototype.hasOwnProperty.call(LEGACY_PROVIDER_ALIASES, trimmed)
    ? LEGACY_PROVIDER_ALIASES[trimmed]
    : undefined;
  if (alias) {
    if (!warnedAliases.has(trimmed)) {
      warnedAliases.add(trimmed);
      console.warn(
        `[ai] Provider "${trimmed}" no longer exists; reading it as "${alias}". ` +
          'Stored records are rewritten by the provider migration on next boot.'
      );
    }
    return alias;
  }

  return null;
}

/** Test seam: lets a test assert the alias warning fires exactly once. */
export function resetProviderAliasWarningsForTests(): void {
  warnedAliases.clear();
}

/**
 * The two chat sites this app drives in a browser.
 *
 * Here rather than with the app settings that store them, because the routing
 * layer needs the list and the settings layer needs the routing - and with the
 * list in the settings module those two imported each other.
 */
export type BrowserChatSiteId = Extract<AIProvider, 'claude-web' | 'chatgpt-web'>;

export const BROWSER_CHAT_SITE_IDS: readonly BrowserChatSiteId[] = ['claude-web', 'chatgpt-web'];

export function isBrowserChatSiteId(value: unknown): value is BrowserChatSiteId {
  return value === 'claude-web' || value === 'chatgpt-web';
}

/**
 * The reserved model id that means BROWSER MODE: any free chat browser.
 *
 * The one entry the picker offers for browser work, replacing the three it used
 * to - "Claude (free)", "ChatGPT (free)" and "Hybrid (free)". Those three were a
 * choice nobody had a reason to make: the queue hands a task to whichever
 * browser comes free, so pinning one to a platform only meant waiting longer for
 * the same answer. One option that means "use the browsers" says what the app
 * actually does.
 *
 * The id still reads `free-hybrid`, and that is deliberate: profiles already
 * store it. Renaming would silently repoint every one of them at the app
 * default.
 *
 * It lives here, with the provider catalog, rather than with the routing logic
 * that acts on it, because the two things that need it sit on opposite sides of
 * that logic: the model list has to OFFER it, and the choice resolver has to
 * RECOGNISE it. Putting it in the routing module made those two import each
 * other through it.
 *
 * It is deliberately not a row in `aiModels`. There is no provider to call and
 * no model name to send, and an admin editing or deleting such a row would
 * leave every profile that picked it pointing at nothing.
 */
export const HYBRID_MODEL_ID = 'free-hybrid';

export const HYBRID_MODEL_LABEL = 'Default (browser)';

export const HYBRID_MODEL_DESCRIPTION =
  'Runs on whichever free chat browser is available - Claude or ChatGPT - and ' +
  'moves to another when one is out of messages, signed out, or not running.';

export function isHybridModelId(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === HYBRID_MODEL_ID;
}

/** Does this provider honour the effort knob? Used by pickers and adapters alike. */
export function providerSupportsEffort(id: AIProvider): boolean {
  return getProviderDescriptor(id).supportsEffort;
}

/** Does this provider honour the thinking knob? */
export function providerSupportsThinking(id: AIProvider): boolean {
  return getProviderDescriptor(id).supportsThinking;
}
