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
    legacyEnabledField: 'claudeCliEnabled',
    envKeyVar: null,
    requiresApiKey: false,
    credentialKind: 'subscription-seat',
    locked: true,
    lockReason:
      'Needs a Claude subscription seat signed in to the `claude` CLI on the machine running this ' +
      'server. Use Claude (free) or ChatGPT (free) instead, or unlock this once the seat is signed ' +
      'in by adding claude-cli to AI_UNLOCKED_PROVIDERS in .env.',
    order: 0,
  },
  claude: {
    id: 'claude',
    label: 'Anthropic API',
    summary: 'Anthropic Messages API with an API key. Billed per token.',
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

function envUnlockedProviders(): Set<string> {
  const raw = process.env[UNLOCKED_PROVIDERS_ENV_VAR];
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
  const descriptor = PROVIDER_CATALOG[id] as ProviderDescriptor | undefined;
  if (!descriptor?.locked) {
    return false;
  }
  return !envUnlockedProviders().has(id);
}

/** Why `id` is locked, or '' when it is not locked right now. */
export function getProviderLockReason(id: AIProvider): string {
  return isProviderLocked(id) ? PROVIDER_CATALOG[id]?.lockReason ?? '' : '';
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
