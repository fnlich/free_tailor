import { listResolvedProviders } from '../../config/aiModelConfig';
import {
  currentProviders,
  isBuiltInProviderId,
  providerTypeOf,
  type ResolvedAIProvider,
} from '../../config/aiProviders';
import { AI_PROVIDER_IDS, getProviderLabel, getProviderLockReason } from '../../config/providerCatalog';
import { getDatabasePath } from '../../database/sqlite';
import type { AIProvider } from '../../types/template';
import { getProviderSemaphore } from './concurrency';
import { AIProviderError } from './errors';
import { createClaudeCliAdapter, type ClaudeCliAdapter } from './providers/claudeCli';
import { createCodexCliAdapter } from './providers/codexCli';
import { createGeminiCliAdapter, type GeminiCliAdapter } from './providers/geminiCli';
import type {
  AIProviderAdapter,
  HealthOptions,
  ProviderCapabilities,
  ProviderHealth,
  ProviderInstanceSpec,
  ProviderReadiness,
} from './types';

/**
 * Provider lookup: one adapter per PROVIDER, not per type.
 *
 * A provider is one place a type runs (config/aiProviders.ts): two Claude
 * providers are two adapters, each with its own sign-in folder, binary,
 * semaphore, holds and health cache - so one signed out says nothing about
 * the other, and each is limited by its own `concurrency_max_requests`. The
 * built-in provider of each type has the type's id, which is why every caller
 * that still names a type gets exactly the adapter it always did.
 *
 * Adapters are built lazily on first use and cached by id. A provider whose
 * folder or binary an administrator changed is a different seat, so its
 * adapter is rebuilt (its holds and health go with the old one); a changed
 * limit only resizes the semaphore it already holds, so calls in flight are
 * still counted.
 *
 * `registerAdapter` is the tests' seam. A stub registered under a TYPE id
 * stands in for every provider of that type that has none of its own - a
 * suite that stubs the three seats must never reach a real CLI through a
 * provider it did not know about.
 */

type AdapterFactory = () => AIProviderAdapter;

const factories = new Map<string, AdapterFactory>();
const instances = new Map<string, { adapter: AIProviderAdapter; signature: string; concurrency: number }>();

export function registerAdapter(id: string, factory: AdapterFactory): void {
  factories.set(id, factory);
  for (const key of [...instances.keys()]) {
    if (key === id || providerTypeOf(key) === id) instances.delete(key);
  }
}

/** The providers in effect for this database, from the last settings read. */
export function providersNow(): ResolvedAIProvider[] {
  return currentProviders(getDatabasePath());
}

export function toInstanceSpec(provider: ResolvedAIProvider): ProviderInstanceSpec {
  return {
    id: provider.id,
    label: provider.label,
    builtIn: provider.builtIn,
    homeDir: provider.homeDir,
    binaryPath: provider.binaryPath,
    concurrency: provider.concurrency_max_requests,
  };
}

function createDefault(type: AIProvider, instance: ProviderInstanceSpec): AIProviderAdapter {
  if (type === 'codex-cli') return createCodexCliAdapter({ instance });
  if (type === 'gemini-cli') return createGeminiCliAdapter({ instance });
  return createClaudeCliAdapter({ instance });
}

/**
 * The adapter for a provider id - a type id is its built-in provider.
 *
 * A removed provider's adapter stays cached while anything still holds it (a
 * call in flight), and is refused to anything new.
 */
export function getAdapter(id: string): AIProviderAdapter {
  const provider = providersNow().find((entry) => entry.id === id) ?? null;
  const type = provider?.type ?? providerTypeOf(id);
  const explicit = factories.get(id) ?? (type && id !== type ? factories.get(type) : undefined);
  const signature = explicit
    ? 'registered'
    : provider
      ? `${provider.type}\u0000${provider.homeDir ?? ''}\u0000${provider.binaryPath}`
      : '';

  const cached = instances.get(id);
  if (cached && (cached.signature === signature || !provider)) {
    if (provider && !explicit && cached.concurrency !== provider.concurrency_max_requests) {
      // In place: the semaphore keeps counting what is already running.
      getProviderSemaphore(id, provider.concurrency_max_requests);
      cached.concurrency = provider.concurrency_max_requests;
    }
    return cached.adapter;
  }

  if (!type || (!provider && !explicit)) {
    throw new AIProviderError({
      provider: type ?? 'claude-cli',
      kind: 'disabled',
      detail: `No transport is registered for provider "${id}"`,
    });
  }

  const adapter = explicit ? explicit() : createDefault(type, toInstanceSpec(provider!));
  instances.set(id, {
    adapter,
    signature,
    concurrency: provider?.concurrency_max_requests ?? adapter.capabilities.maxConcurrency,
  });
  return adapter;
}

/**
 * What the adapter knows about taking a call now - on `modelName`, when one is
 * given, so a hold on that model alone counts (see ProviderReadiness.held). A
 * stub with no `readiness` is always ready; so is a provider nothing has built
 * an adapter for yet, which says nothing against it.
 */
export function providerReadiness(id: string, modelName?: string): ProviderReadiness {
  try {
    return getAdapter(id).readiness?.(modelName) ?? { ready: null, held: null };
  } catch {
    return { ready: false, held: null };
  }
}

/** The built-in Claude provider's adapter, typed, for the readings only it keeps. */
export function getClaudeCliAdapter(id = 'claude-cli'): ClaudeCliAdapter {
  return getAdapter(id) as ClaudeCliAdapter;
}

/**
 * A Gemini provider's adapter, typed, for its outage holds.
 *
 * Null when something other than the real adapter holds the id - a test's
 * stub has no `outages()` to read, and the card must not throw over it.
 */
export function getGeminiCliAdapter(id = 'gemini-cli'): GeminiCliAdapter | null {
  const adapter = getAdapter(id) as Partial<GeminiCliAdapter>;
  return typeof adapter.outages === 'function' ? (adapter as GeminiCliAdapter) : null;
}

/** Each TYPE's capabilities, read off its built-in provider. */
export function listProviderCapabilities(): ProviderCapabilities[] {
  return AI_PROVIDER_IDS.map((id) => getAdapter(id).capabilities);
}

export type ProviderHealthReport = ProviderHealth & {
  /** The provider's TYPE. */
  provider: AIProvider;
  /** Which provider of it: the type id for the built-in one. */
  providerId: string;
  label: string;
};

/** One provider's health; `id` is a provider id, a type id meaning its built-in one. */
export async function checkProviderHealth(id: string, options: HealthOptions = {}): Promise<ProviderHealthReport> {
  const type = providerTypeOf(id) ?? 'claude-cli';
  const label = providersNow().find((entry) => entry.id === id)?.label ?? getProviderLabel(type);
  // Answered without touching the adapter. Probing a locked provider costs
  // something real - the CLI check spawns a binary and waits on it - to learn
  // a fact that could not change the answer, and it would report "not signed
  // in" where the truth is "not offered here".
  const lockReason = getProviderLockReason(type);
  if (lockReason) {
    return {
      provider: type,
      providerId: id,
      label,
      ok: false,
      detail: `Locked in this installation. ${lockReason}`,
      checkedAt: new Date().toISOString(),
      meta: { locked: true },
    };
  }

  const health = await getAdapter(id).health(options);
  return { ...health, provider: type, providerId: id, label };
}

/**
 * Reports every enabled provider's readiness at boot, where an operator can
 * see it, rather than letting a missing binary or a signed-out seat surface
 * hours later as a failed resume. Never throws: the server must still start so
 * the admin UI is reachable to fix whatever is wrong.
 */
export async function preflightAllProviders(): Promise<ProviderHealthReport[]> {
  // The settings first, so a provider an administrator added is checked too.
  const providers = await listResolvedProviders().catch(() => providersNow());
  const reports = await Promise.all(
    providers
      .filter((entry) => entry.enabled)
      .map(async (entry) => {
        try {
          return await checkProviderHealth(entry.id);
        } catch (error) {
          return {
            provider: entry.type,
            providerId: entry.id,
            label: entry.label,
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
            checkedAt: new Date().toISOString(),
          } satisfies ProviderHealthReport;
        }
      })
  );

  for (const report of reports) {
    const name = isBuiltInProviderId(report.providerId)
      ? report.provider
      : `${report.providerId} ("${report.label}", ${report.provider})`;
    const line = `[ai] ${name}: ${report.detail}`;
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
