/**
 * The AI transport layer.
 *
 * Everything outside `services/ai` imports from here and nowhere deeper. That
 * boundary is what makes a new provider a new file rather than an edit to every
 * call site, and it is what lets the provider suite run with no network, no
 * database and no `claude` binary.
 */

export {
  AIProviderError,
  isAIProviderError,
  ADMIN_MESSAGE_BY_KIND,
  HTTP_STATUS_BY_KIND,
  PUBLIC_AI_MESSAGE,
} from './errors';
export type { AIErrorKind, PublicAiFailure } from './errors';

export {
  createPromptCompletion,
  createPromptCompletionResult,
  createRawCompletion,
  resolvePromptExecutionConfig,
  DEFAULT_PROVIDER,
} from './promptExecution';
export type { CreatePromptCompletionInput, CreateRawCompletionInput } from './promptExecution';

export { JSON_ONLY_SYSTEM_PROMPT } from './promptAssembly';

export {
  checkProviderHealth,
  getAdapter,
  getClaudeCliAdapter,
  getGeminiCliAdapter,
  listProviderCapabilities,
  preflightAllProviders,
  providerReadiness,
  providersNow,
  registerAdapter,
  resetRegistryForTests,
} from './registry';
export type { ProviderHealthReport } from './registry';

export {
  isProviderReady,
  pickProvider,
  pinnedProviderId,
  providerLoad,
  runPinnedToProvider,
} from './providerPool';

export { resolveBatchCapacity, cliConcurrency } from './batchCapacity';
export type { BatchCapacity } from './batchCapacity';

export {
  AsyncSemaphore,
  getProviderSemaphore,
  getSemaphoreStats,
  mapWithConcurrency,
} from './concurrency';
export type { ConcurrentMapResult } from './concurrency';

export { getUsageSnapshot, warnOnce } from './telemetry';
export type { UsageSnapshot } from './telemetry';

export type {
  CompletionResponseFormat,
  CompletionResult,
  ProviderCapabilities,
  ProviderHealth,
  ProviderInstanceSpec,
  ProviderReadiness,
} from './types';
