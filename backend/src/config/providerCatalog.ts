import type { AIProvider } from '../types/template';

/**
 * How a provider proves who it is.
 *
 * `api-key`   - a secret read from the environment.
 * `subscription-seat` - a sign-in the operator performed on the server; there
 *               is no secret for this app to store, hold, or leak.
 */
export type CredentialKind = 'api-key' | 'subscription-seat';

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
    label: 'Codex (subscription)',
    summary:
      'Runs the local `codex` CLI on the signed-in ChatGPT subscription. No API key, no metered tokens.',
    // Nothing older than this provider can be asking about it, so a flat wire
    // flag would be a field with no reader.
    legacyEnabledField: null,
    // Null on purpose, and the opposite of what it looks like. `OPENAI_API_KEY`
    // exists and this provider must NOT be given it: an API key outranks the
    // subscription in the CLI's own resolution order, so honouring one here
    // would move every call onto metered billing while looking identical. The
    // child environment strips it; see providers/codexCli/env.ts.
    envKeyVar: null,
    requiresApiKey: false,
    credentialKind: 'subscription-seat',
    locked: false,
    lockReason:
      'Needs the `codex` CLI installed and a ChatGPT subscription signed in on this machine. ' +
      'Run `codex login --device-auth` there, then remove it from AI_LOCKED_PROVIDERS.',
    order: 1,
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
    order: 2,
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
    order: 3,
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
    order: 4,
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

/**
 * Provider ids an older release offered, retired with nothing to replace them.
 *
 * `claude-web` and `chatgpt-web` drove claude.ai and chatgpt.com in a debug
 * Chrome the operator started and signed in to. They are deliberately NOT in
 * `LEGACY_PROVIDER_ALIASES`: their records carry `modelName: 'chat'`, and
 * aliasing one onto a CLI seat would run `claude --model chat` or
 * `codex -m chat` - a model neither has - turning a value that could be read
 * harmlessly into a failure at generate time. So `coerceProviderId` returns
 * null for them like any unknown id, and every read path that would otherwise
 * THROW on that null asks this list first and treats the value as absent: a
 * model record is skipped, an enable flag is ignored, a prompt override is no
 * override, and a stored preference falls back to the app default.
 *
 * PERMANENT, for the reason the alias map above is. Migration 006 removes them
 * from the database once, but a restored backup, a hand-edited row or a page
 * left open from before the upgrade can put them back at any time - and 006
 * itself sits behind 003 in the migration chain, which waits for the first
 * administrator. Tolerating them on read is what keeps any of those from taking
 * every settings read down with "invalid provider".
 */
export const RETIRED_PROVIDER_IDS: readonly string[] = Object.freeze(['claude-web', 'chatgpt-web']);

export function isRetiredProviderId(value: unknown): boolean {
  return typeof value === 'string' && RETIRED_PROVIDER_IDS.includes(value.trim());
}

/**
 * Model ids that only ever meant one of the retired providers.
 *
 * `free-hybrid` was the synthesized "any free chat browser" entry in the model
 * picker - never a stored row - and `claude-web-chat` / `chatgpt-web-chat` the
 * seeded records for the two sites. A profile, the stored default, or a request
 * from a page loaded before the upgrade can still name any of them. They read as
 * "the app default" rather than as an unknown model: the browser entry was
 * labelled as the default and meant it, and refusing would break every stale
 * tab and every profile that picked it, on a change their owners did not make.
 *
 * Only these three can be listed. A browser model an administrator created has
 * a random id; `normalizeAIModelRecords` in aiModelConfig remembers those as it
 * drops their records, which covers the same ground for the life of the process.
 */
export const RETIRED_MODEL_IDS: readonly string[] = Object.freeze([
  'free-hybrid',
  'claude-web-chat',
  'chatgpt-web-chat',
]);

export function isRetiredModelId(value: unknown): boolean {
  return typeof value === 'string' && RETIRED_MODEL_IDS.includes(value.trim());
}

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
