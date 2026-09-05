import { AI_PROVIDER_IDS } from '../../config/providerCatalog';
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_OPENAI_MODEL,
} from '../aiModelCatalog';
import type { AIProvider } from '../../types/template';
import { AIProviderError } from './errors';
import { createAnthropicHttpAdapter } from './providers/anthropicHttp';
import { createClaudeCliAdapter, type ClaudeCliAdapter } from './providers/claudeCli';
import { createOpenAICompatibleAdapter } from './providers/openaiCompatible';
import type { AIProviderAdapter, ProviderCapabilities, ProviderHealth } from './types';

/**
 * Provider lookup.
 *
 * This replaces a hand-written if-chain in which `'claude'` was never tested by
 * name - it was the fallthrough - so adding or removing a provider meant
 * editing a branch nobody could see was exhaustive. A map plus the catalog's
 * `satisfies Record<AIProvider, ...>` makes an omission a compile error.
 *
 * Adapters are built lazily on first use and cached, so importing this module
 * costs nothing and touches no configuration.
 */

type AdapterFactory = () => AIProviderAdapter;

const factories = new Map<AIProvider, AdapterFactory>();
const instances = new Map<AIProvider, AIProviderAdapter>();

export function registerAdapter(id: AIProvider, factory: AdapterFactory): void {
  factories.set(id, factory);
  instances.delete(id);
}

function registerDefaults(): void {
  if (factories.size > 0) {
    return;
  }
  registerAdapter('claude-cli', () => createClaudeCliAdapter());
  registerAdapter('claude', () => createAnthropicHttpAdapter({ defaultModel: DEFAULT_CLAUDE_MODEL }));
  registerAdapter('openai', () =>
    createOpenAICompatibleAdapter({
      id: 'openai',
      defaultModel: DEFAULT_OPENAI_MODEL,
      tokenLimitField: 'max_completion_tokens',
    })
  );
  registerAdapter('deepseek', () =>
    createOpenAICompatibleAdapter({
      id: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      defaultModel: DEFAULT_DEEPSEEK_MODEL,
      tokenLimitField: 'max_tokens',
    })
  );
}

export function getAdapter(id: AIProvider): AIProviderAdapter {
  registerDefaults();
  const cached = instances.get(id);
  if (cached) {
    return cached;
  }
  const factory = factories.get(id);
  if (!factory) {
    throw new AIProviderError({
      provider: id,
      kind: 'disabled',
      detail: `No transport is registered for provider "${id}"`,
    });
  }
  const created = factory();
  instances.set(id, created);
  return created;
}

/** The CLI adapter, typed, for the admin health endpoint's extra readings. */
export function getClaudeCliAdapter(): ClaudeCliAdapter {
  return getAdapter('claude-cli') as ClaudeCliAdapter;
}

export function listProviderCapabilities(): ProviderCapabilities[] {
  return AI_PROVIDER_IDS.map((id) => getAdapter(id).capabilities);
}

export type ProviderHealthReport = ProviderHealth & { provider: AIProvider };

export async function checkProviderHealth(id: AIProvider): Promise<ProviderHealthReport> {
  const health = await getAdapter(id).health();
  return { ...health, provider: id };
}

/**
 * Reports every provider's readiness at boot, where an operator can see it,
 * rather than letting a missing binary or a signed-out seat surface hours
 * later as a failed resume. Never throws: the server must still start so the
 * admin UI is reachable to fix whatever is wrong.
 */
export async function preflightAllProviders(): Promise<ProviderHealthReport[]> {
  registerDefaults();
  const reports = await Promise.all(
    AI_PROVIDER_IDS.map(async (id) => {
      try {
        return await checkProviderHealth(id);
      } catch (error) {
        return {
          provider: id,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
          checkedAt: new Date().toISOString(),
        } satisfies ProviderHealthReport;
      }
    })
  );

  for (const report of reports) {
    const line = `[ai] ${report.provider}: ${report.detail}`;
    if (report.warning) {
      console.warn(`${line} ${report.warning}`);
    } else if (report.ok) {
      console.log(line);
    } else {
      console.warn(line);
    }
  }

  return reports;
}

export function resetRegistryForTests(): void {
  factories.clear();
  instances.clear();
}
