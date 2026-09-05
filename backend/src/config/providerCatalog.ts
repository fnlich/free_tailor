import type { AIProvider } from '../types/template';

/**
 * How a provider proves who it is.
 *
 * `api-key`   - a secret the admin pastes (or an environment variable).
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
  /** Key on AppSettings.providersEnabled and the legacy flat wire field. */
  legacyEnabledField: 'claudeCliEnabled' | 'claudeEnabled' | 'openaiEnabled' | 'deepseekEnabled';
  /** Environment variable holding this provider's key, or null when keyless. */
  envKeyVar: string | null;
  requiresApiKey: boolean;
  credentialKind: CredentialKind;
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
    order: 3,
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
 * Provider ids that were valid in an older release, and what they became.
 *
 * This map is PERMANENT, not a migration step. A boot migration rewrites the
 * settings row once, but stored provider strings reach typed code from places
 * a migration cannot cover: a restored backup, a hand-edited row, and
 * scripts/migrateLegacyData.ts, which writes a legacy `ai-models.json`
 * verbatim at any later time. Coercing on read means none of those can brick
 * the app; the migration is then an improvement rather than a prerequisite.
 */
export const LEGACY_PROVIDER_ALIASES: Readonly<Record<string, AIProvider>> = Object.freeze({
  openrouter: 'claude-cli',
});

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

  const alias = LEGACY_PROVIDER_ALIASES[trimmed];
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
