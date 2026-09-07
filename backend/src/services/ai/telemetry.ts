import type { AIProvider } from '../../types/template';
import type { CompletionResult } from './types';

/**
 * Per-call-site accounting for AI work.
 *
 * The app had none: `AnthropicMessageResponse.usage` was typed and never read,
 * and the only observability was two `[Resume timing]` log lines that hardcoded
 * the assumption of exactly two model calls per resume. Without this there is
 * no way to check any claim about what the migration cost or saved.
 */

const warned = new Set<string>();

/**
 * Logs a message once per process for a given key. Used for conditions that
 * are true on EVERY call - "this provider ignores temperature" - where logging
 * per call would bury the log and logging never would hide a real surprise.
 */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) {
    return;
  }
  warned.add(key);
  console.warn(`[ai] ${message}`);
}

export function resetWarnOnceForTests(): void {
  warned.clear();
}

export type CallSiteUsage = {
  callSite: string;
  provider: AIProvider;
  /** The model the caller asked for. */
  model: string;
  /** The models that actually answered (differs after a CLI fallback). */
  resolvedModels: Set<string>;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
};

const usage = new Map<string, CallSiteUsage>();

function bucket(callSite: string, provider: AIProvider, model: string): CallSiteUsage {
  const key = `${provider} ${model} ${callSite}`;
  const existing = usage.get(key);
  if (existing) {
    return existing;
  }
  const created: CallSiteUsage = {
    callSite,
    provider,
    model,
    resolvedModels: new Set<string>(),
    calls: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
  };
  usage.set(key, created);
  return created;
}

/**
 * Both success and failure bucket on the model that was REQUESTED.
 *
 * Bucketing successes on `resolvedModel` and failures on the requested name
 * split one call site across two rows, so the success row always reported zero
 * failures. The requested name is the one the caller can act on.
 */
export function recordCompletion(callSite: string, requestedModel: string, result: CompletionResult): void {
  const entry = bucket(callSite, result.providerId, requestedModel);
  entry.resolvedModels.add(result.resolvedModel);
  entry.calls += 1;
  entry.inputTokens += result.usage?.inputTokens ?? 0;
  entry.outputTokens += result.usage?.outputTokens ?? 0;
  entry.cacheReadTokens += result.usage?.cacheReadTokens ?? 0;
  entry.cacheWriteTokens += result.usage?.cacheWriteTokens ?? 0;
  entry.costUsd += result.costUsd ?? 0;
  entry.totalLatencyMs += result.latencyMs;
  entry.maxLatencyMs = Math.max(entry.maxLatencyMs, result.latencyMs);
}

export function recordFailure(callSite: string, provider: AIProvider, model: string): void {
  bucket(callSite, provider, model).failures += 1;
}

/** Serialisable form of a usage row, for the admin health endpoint. */
export type UsageRow = Omit<CallSiteUsage, 'resolvedModels'> & { resolvedModels: string[] };

export type UsageSnapshot = {
  entries: CallSiteUsage[];
  totals: {
    calls: number;
    failures: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
  };
};

export function getUsageSnapshot(): UsageSnapshot {
  const entries = Array.from(usage.values()).map((entry) => ({
    ...entry,
    resolvedModels: new Set(entry.resolvedModels),
  }));
  const totals = entries.reduce(
    (acc, entry) => {
      acc.calls += entry.calls;
      acc.failures += entry.failures;
      acc.inputTokens += entry.inputTokens;
      acc.outputTokens += entry.outputTokens;
      acc.cacheReadTokens += entry.cacheReadTokens;
      acc.cacheWriteTokens += entry.cacheWriteTokens;
      acc.costUsd += entry.costUsd;
      return acc;
    },
    {
      calls: 0,
      failures: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    }
  );
  entries.sort((a, b) => b.calls - a.calls);
  return { entries, totals };
}

export function resetUsageForTests(): void {
  usage.clear();
}
