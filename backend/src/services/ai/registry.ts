import { AI_PROVIDER_IDS, getProviderLockReason } from '../../config/providerCatalog';
import type { AIProvider } from '../../types/template';
import { AIProviderError } from './errors';
import { createClaudeCliAdapter, type ClaudeCliAdapter } from './providers/claudeCli';
import { createCodexCliAdapter } from './providers/codexCli';
import { createGeminiCliAdapter, type GeminiCliAdapter } from './providers/geminiCli';
import type { AIProviderAdapter, HealthOptions, ProviderCapabilities, ProviderHealth } from './types';

/**
 * Provider lookup.
 *
 * This replaces a hand-written if-chain in which the last provider was never
 * tested by name - it was the fallthrough - so adding or removing a provider
 * meant editing a branch nobody could see was exhaustive. A map plus the
 * catalog's `satisfies Record<AIProvider, ...>` makes an omission a compile
 * error.
 *
 * Adapters are built lazily on first use and cached, so importing this module
 * costs nothing and touches no configuration.
 */

type AdapterFactory = () => AIProviderAdapter;

const factories = new Map<AIProvider, AdapterFactory>();
const instances = new Map<AIProvider, AIProviderAdapter>();
let defaultsRegistered = false;

export function registerAdapter(id: AIProvider, factory: AdapterFactory): void {
  factories.set(id, factory);
  instances.delete(id);
}

/** Registers a built-in only where nothing has claimed that id already. */
function registerDefault(id: AIProvider, factory: AdapterFactory): void {
  if (!factories.has(id)) {
    factories.set(id, factory);
  }
}

function registerDefaults(): void {
  // Guarded on its own flag, not on `factories.size`. Sharing the map with
  // registerAdapter meant a single explicitly registered provider would count
  // as "the defaults are present" and leave every other provider missing.
  // And each default is registered only where nothing already holds that id,
  // so an explicit registerAdapter always wins over the built-in.
  if (defaultsRegistered) {
    return;
  }
  defaultsRegistered = true;
  registerDefault('claude-cli', () => createClaudeCliAdapter());
  registerDefault('codex-cli', () => createCodexCliAdapter());
  registerDefault('gemini-cli', () => createGeminiCliAdapter());
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

/**
 * The Gemini seat's adapter, typed, for its outage holds on the same card.
 *
 * Null when something other than the built-in holds the id - a test's stub has
 * no `outages()` to read, and the card must not throw over it.
 */
export function getGeminiCliAdapter(): GeminiCliAdapter | null {
  const adapter = getAdapter('gemini-cli') as Partial<GeminiCliAdapter>;
  return typeof adapter.outages === 'function' ? (adapter as GeminiCliAdapter) : null;
}

export function listProviderCapabilities(): ProviderCapabilities[] {
  return AI_PROVIDER_IDS.map((id) => getAdapter(id).capabilities);
}

export type ProviderHealthReport = ProviderHealth & { provider: AIProvider };

export async function checkProviderHealth(id: AIProvider, options: HealthOptions = {}): Promise<ProviderHealthReport> {
  // Answered without touching the adapter. Probing a locked provider costs
  // something real - the CLI check spawns a binary and waits on it - to learn
  // a fact that could not change the answer, and it would report "not signed
  // in" where the truth is "not offered here".
  const lockReason = getProviderLockReason(id);
  if (lockReason) {
    return {
      provider: id,
      ok: false,
      detail: `Locked in this installation. ${lockReason}`,
      checkedAt: new Date().toISOString(),
      meta: { locked: true },
    };
  }

  const health = await getAdapter(id).health(options);
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
  defaultsRegistered = false;
}
