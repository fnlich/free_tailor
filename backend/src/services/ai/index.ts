/**
 * The AI transport layer.
 *
 * Everything outside `services/ai` imports from here and nowhere deeper. That
 * boundary is what makes a new provider a new file rather than an edit to every
 * call site, and it is what lets the provider suite run with no network, no
 * database and no `claude` binary.
 */

export { AIProviderError, isAIProviderError, HTTP_STATUS_BY_KIND, USER_MESSAGE_BY_KIND } from './errors';
export type { AIErrorKind } from './errors';

export {
  createPromptCompletion,
  createRawCompletion,
  resolvePromptExecutionConfig,
  DEFAULT_PROVIDER,
} from './promptExecution';
export type { CreatePromptCompletionInput, CreateRawCompletionInput } from './promptExecution';

export { JSON_ONLY_SYSTEM_PROMPT } from './promptAssembly';

export {
  checkProviderHealth,
  getClaudeCliAdapter,
  listProviderCapabilities,
  preflightAllProviders,
  registerAdapter,
  resetRegistryForTests,
} from './registry';
export type { ProviderHealthReport } from './registry';

export {
  AsyncSemaphore,
  getProviderSemaphore,
  getSemaphoreStats,
  mapWithConcurrency,
} from './concurrency';
export type { ConcurrentMapResult } from './concurrency';

export { getUsageSnapshot, warnOnce } from './telemetry';
export type { UsageSnapshot } from './telemetry';

export { EFFORT_LEVELS, isEffortLevel } from './types';
export type {
  CompletionResponseFormat,
  CompletionResult,
  EffortLevel,
  ProviderCapabilities,
  ProviderHealth,
} from './types';
