import {
  getAIModelSettings,
  getDefaultEnabledProvider,
  isBrowserChatSiteId,
  isProviderEnabled,
  type BrowserChatSiteId,
} from '../../config/aiModelConfig';
import {
  coerceProviderId,
  getProviderLabel,
  getProviderLockReason,
  isProviderLocked,
} from '../../config/providerCatalog';
import type { AIProvider } from '../../types/template';
import { AIProviderError, isAIProviderError } from './errors';
import {
  isFailoverKind,
  noteFreeChatAttempt,
  noteFreeChatFailure,
  noteFreeChatSuccess,
  planRoute,
  freeChatSiteLabel,
  type FreeChatRoute,
} from './freeChatRouting';
import { resolvePromptByExactId, resolvePromptByRuntimeId } from '../promptService';
import { assemblePrompt, assembleRawPrompt, JSON_ONLY_SYSTEM_PROMPT,
  JSON_SENTINEL_SYSTEM_PROMPT, type AssembledPrompt, type PromptRef } from './promptAssembly';
import { getAdapter } from './registry';
import { recordCompletion, recordFailure, warnOnce } from './telemetry';
import {
  createDeadline,
  isEffortLevel,
  isThinkingMode,
  type CompletionRequest,
  type CompletionResponseFormat,
  type CompletionResult,
  type EffortLevel,
  type ThinkingMode,
} from './types';

/**
 * The one entry point every AI call in this app goes through.
 *
 * `claude-cli` is the default because the app's premise is a subscription seat
 * rather than metered tokens. This constant matters more than it looks: two
 * callers (profile extraction and template extraction) pass no provider at all,
 * so a default left pointing at a metered provider would keep billing for them
 * with nothing in the UI to say so.
 */
export const DEFAULT_PROVIDER: AIProvider = 'claude-cli';

/** Fallback wall-clock budget when a caller names none. */
const DEFAULT_TIMEOUT_MS = 300_000;

export type PromptExecutionConfig = {
  provider: AIProvider;
  modelName?: string;
  /**
   * True when a prompt record or a caller named this provider on purpose.
   * False when it is only the default, in which case an admin disabling it
   * should reroute rather than fail - there is no UI for the bid assistant to
   * pick a provider, so a hard failure would leave it unusable with no way
   * back.
   */
  explicit?: boolean;
  /**
   * True when `provider` is only the caller's fallback and may therefore be
   * swapped for the other free chat account under a hybrid route.
   *
   * False when a PROMPT RECORD named the provider. That is a choice somebody
   * made about this prompt specifically, and a route is a default about the
   * profile - the narrower statement wins, or an admin who pinned one prompt to
   * one account would find it silently running somewhere else.
   */
  routable?: boolean;
};

/**
 * Which provider and model a prompt runs on: the prompt record's own override
 * when it has one, otherwise what the caller asked for.
 */
export async function resolvePromptExecutionConfig(
  promptId: string,
  fallbackProvider: AIProvider,
  fallbackModelName?: string,
  useExactPromptId = false
): Promise<PromptExecutionConfig> {
  const prompt = useExactPromptId
    ? await resolvePromptByExactId(promptId)
    : await resolvePromptByRuntimeId(promptId);

  return configFromRecord(prompt, fallbackProvider, fallbackModelName);
}

function configFromRecord(
  record: { modelProvider?: AIProvider; modelName?: string } | null,
  fallbackProvider: AIProvider,
  fallbackModelName?: string,
  explicitFallback = true
): PromptExecutionConfig {
  const provider = coerceProviderId(record?.modelProvider);
  if (!provider || !record?.modelName) {
    return {
      provider: fallbackProvider,
      modelName: fallbackModelName,
      explicit: explicitFallback,
      routable: true,
    };
  }

  // An override naming a provider this installation cannot run is read as no
  // override at all. It is a value STORED on the prompt record, possibly years
  // ago and possibly by the provider migration itself, which repointed every
  // custom prompt at the subscription seat - so honouring it here would mean a
  // build that locks that seat cannot run any of those prompts, and the person
  // hitting it has no way to see why from the prompt they are using.
  if (isProviderLocked(provider)) {
    warnOnce(
      `lockedPromptOverride:${provider}`,
      `A prompt record names the locked provider "${getProviderLabel(provider)}"; that override is ` +
        'being ignored and those prompts run on the model chosen in the UI instead. Clear it under ' +
        'Admin -> Prompts to silence this.'
    );
    return {
      provider: fallbackProvider,
      modelName: fallbackModelName,
      explicit: explicitFallback,
      routable: true,
    };
  }

  return { provider, modelName: record.modelName, explicit: true, routable: false };
}

export type CreatePromptCompletionInput = {
  promptId: string;
  /**
   * Stable id of the calling FEATURE, for timeouts and usage buckets.
   *
   * Distinct from `promptId`, which is a prompt-record id and can be a custom
   * per-profile record. Keying the tailor-resume timeout on the record id
   * meant a profile with a custom prompt silently got the default budget.
   */
  callSite?: string;
  /**
   * Values for the prompt's `[[variables]]`. The prompt is rendered here, once,
   * from these - callers no longer render it themselves and pass the text.
   */
  promptValues: Record<string, string>;
  fallbackProvider?: AIProvider;
  fallbackModelName?: string;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: CompletionResponseFormat;
  useExactPromptId?: boolean;
  /**
   * Extra instruction appended to the assembled prompt's user turn. For text
   * that must reach the model but does not belong in the stored record.
   */
  appendToUserBody?: string;
  /**
   * A JSON Schema the provider may enforce natively.
   *
   * Only pass this when the schema is GENERATED BY CODE and the prompt is not
   * one of the admin-editable prompt features. Binding a schema to a prompt an
   * admin can edit converts a recoverable "unparseable text" - which
   * `extractJSON` handles - into a hard transport failure that points at the
   * wrong layer the moment the two drift apart.
   */
  jsonSchema?: Readonly<Record<string, unknown>>;
  effort?: EffortLevel;
  thinking?: ThinkingMode;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** The profile's free-chat route, so a hybrid call can use both accounts. */
  route?: FreeChatRoute;
};

async function runAssembled(
  assembled: AssembledPrompt,
  config: PromptExecutionConfig,
  input: {
    callSite: string;
    responseFormat: CompletionResponseFormat;
    maxTokens?: number;
    temperature?: number;
    jsonSchema?: Readonly<Record<string, unknown>>;
    effort?: EffortLevel;
    thinking?: ThinkingMode;
    timeoutMs?: number;
    signal?: AbortSignal;
    appendToUserBody?: string;
    route?: FreeChatRoute;
  }
): Promise<CompletionResult> {
  const settings = await getAIModelSettings();
  let provider = config.provider;

  if (!isProviderEnabled(provider, settings)) {
    const lockReason = getProviderLockReason(provider);
    if (lockReason && config.explicit !== false) {
      // Reported as its own kind so the message names the real obstacle. A
      // locked provider is not something an administrator can switch back on.
      throw new AIProviderError({
        provider,
        kind: 'locked',
        detail: `Provider "${getProviderLabel(provider)}" is locked in this installation`,
        adminAction: lockReason,
      });
    }
    if (config.explicit !== false) {
      throw new AIProviderError({
        provider,
        kind: 'disabled',
        detail: `Provider "${getProviderLabel(provider)}" is disabled by an administrator`,
      });
    }
    // Nobody chose this provider - it was only the default. Reroute rather
    // than fail, so a caller with no provider setting of its own does not
    // become unusable the moment an admin unticks a box.
    const alternative = getDefaultEnabledProvider(settings);
    if (!isProviderEnabled(alternative, settings)) {
      throw new AIProviderError({
        provider,
        kind: 'disabled',
        detail: 'No AI provider is enabled',
      });
    }
    warnOnce(
      `reroute:${provider}->${alternative}`,
      `The default provider "${getProviderLabel(provider)}" is disabled; calls that name no provider ` +
        `are running on "${getProviderLabel(alternative)}" instead.`
    );
    provider = alternative;
  }

  const userBody = input.appendToUserBody
    ? `${assembled.userBody}\n\n${input.appendToUserBody}`
    : assembled.userBody;

  // ONE deadline for the whole call, shared by every attempt.
  //
  // Not one per attempt, which is the obvious reading of "try the other
  // account" and is wrong: two attempts at a five-minute budget is a ten-minute
  // call, and the caller that set the budget - and the operator watching a page
  // that has not come back - has no idea it could take twice as long. Failing
  // over buys a second chance with the time that is left, not more time.
  const deadline = createDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const buildRequest = (attemptProvider: AIProvider): { request: CompletionRequest; modelName: string } => {
    const adapter = getAdapter(attemptProvider);
    // The model name comes from THIS provider, never carried over. A failover
    // is to a different account with a different adapter, and the name the
    // first one wanted means nothing to the second.
    const modelName =
      config.explicit && config.modelName && attemptProvider === config.provider
        ? config.modelName
        : adapter.defaultModelName();

    // A provider with no system channel gets everything in one turn, so no
    // instruction is silently dropped for it. The previous flat Anthropic path
    // dropped the JSON-only instruction entirely, which is why the one caller
    // that used it had no JSON enforcement at all.
    const foldSystem = !adapter.capabilities.systemBlocks;
    // Which JSON instruction, decided by what the TRANSPORT can enforce.
    //
    // A provider with a native JSON mode is already constrained and needs only
    // to be told not to narrate; asking it for sentinels would put them inside
    // the JSON it is obliged to emit and break the one output that was
    // guaranteed to parse. A chat window enforces nothing, so it gets the long
    // instruction and the sentinels the extractor keys on.
    const volatileSystem =
      input.responseFormat === 'json'
        ? adapter.capabilities.nativeJsonMode === 'none'
          ? JSON_SENTINEL_SYSTEM_PROMPT
          : JSON_ONLY_SYSTEM_PROMPT
        : '';

    return {
      modelName,
      request: {
        modelName,
        stableSystem: foldSystem ? '' : assembled.stableSystem,
        volatileSystem: foldSystem ? '' : volatileSystem,
        userBody: foldSystem
          ? [volatileSystem, assembled.stableSystem, userBody].filter(Boolean).join('\n\n')
          : userBody,
        responseFormat: input.responseFormat,
        // A schema only reaches a provider that can enforce one natively.
        jsonSchema:
          adapter.capabilities.nativeJsonMode === 'json-schema' ? input.jsonSchema : undefined,
        // Sampling hints are passed through UNFILTERED and on purpose. The
        // adapter owns the decision, because only it can report what it had to
        // drop; stripping them here would make the loss invisible again.
        sampling: {
          maxOutputTokens: input.maxTokens,
          temperature: input.temperature,
        },
        effort: isEffortLevel(input.effort) ? input.effort : undefined,
        thinking: isThinkingMode(input.thinking) ? input.thinking : undefined,
        deadline,
        signal: input.signal,
        callSite: input.callSite,
      },
    };
  };

  const attempts = planAttempts(provider, config, input.route);

  let lastError: unknown;
  for (let index = 0; index < attempts.length; index += 1) {
    const attemptProvider = attempts[index];
    const { request, modelName } = buildRequest(attemptProvider);
    if (isBrowserChatSiteId(attemptProvider)) noteFreeChatAttempt(attemptProvider);

    try {
      const result = await getAdapter(attemptProvider).complete(request);
      recordCompletion(input.callSite, modelName, result);
      if (isBrowserChatSiteId(attemptProvider)) noteFreeChatSuccess(attemptProvider);
      return result;
    } catch (error) {
      recordFailure(input.callSite, attemptProvider, modelName);
      lastError = error;

      const providerError = isAIProviderError(error) ? error : null;
      const kind = providerError?.kind ?? null;
      if (isBrowserChatSiteId(attemptProvider) && providerError && kind) {
        noteFreeChatFailure(attemptProvider, kind, providerError.detail || providerError.message);
      }

      const next = attempts[index + 1];
      if (!next) break;
      // Only a failure OF THE ACCOUNT moves to the other one. A prompt that
      // came back unparseable, a caller that cancelled, or a budget that ran
      // out would fail the same way twice - and the second attempt would have
      // spent whatever time the first one left.
      if (!kind || !isFailoverKind(kind)) break;
      if (deadline.remainingMs() <= 0) break;

      warnOnce(
        `freeChatFailover:${attemptProvider}->${next}:${kind}`,
        `${freeChatSiteLabel(attemptProvider as BrowserChatSiteId)} could not take this call ` +
          `(${kind}); the hybrid route is sending it to ${freeChatSiteLabel(next as BrowserChatSiteId)} ` +
          'instead. Both accounts are used in turn, so this is not an error on its own.'
      );
    }
  }

  throw lastError;
}

/**
 * Which accounts this call may try, in order.
 *
 * One, except for a hybrid route on a call whose provider was not pinned by a
 * prompt record - and even then only the free chat accounts are candidates:
 * failing a metered API call over to a chat window, or the reverse, would
 * change what the caller is paying and what it is talking to.
 *
 * The order is asked for HERE, at send time, and not taken from the provider
 * the choice resolved to. The two are usually the same and the difference is
 * the point: one `AiChoice` is resolved per generation and then used for three
 * calls, so leading with its provider would send all three to the same account
 * - and, worse, keep sending them there after the first one came back walled.
 * Measured against the cooldown that call recorded: two calls, two failures,
 * one for each time the executor re-asked an account that had already said no.
 *
 * The resolved provider is kept in the list rather than replaced, because on an
 * install where the OTHER site has no model configured it is the only account
 * that can answer at all.
 */
function planAttempts(
  provider: AIProvider,
  config: PromptExecutionConfig,
  route?: FreeChatRoute
): AIProvider[] {
  if (route !== 'hybrid') return [provider];
  if (config.routable === false) return [provider];
  if (!isBrowserChatSiteId(provider)) return [provider];

  const planned = planRoute('hybrid');
  return [...planned, ...(planned.includes(provider) ? [] : [provider])];
}

/**
 * Renders a stored prompt and runs it on the resolved provider.
 */
export async function createPromptCompletion(input: CreatePromptCompletionInput): Promise<string> {
  const ref: PromptRef = {
    id: input.promptId,
    mode: input.useExactPromptId ? 'exact' : 'runtime',
  };

  const assembled = await assemblePrompt(ref, input.promptValues);
  const config = configFromRecord(
    assembled.record,
    input.fallbackProvider || DEFAULT_PROVIDER,
    input.fallbackModelName,
    // A caller that named a provider chose it; one that fell through to the
    // default did not, and should be rerouted rather than failed if an admin
    // has disabled that default.
    Boolean(input.fallbackProvider)
  );

  const result = await runAssembled(assembled, config, {
    callSite: input.callSite || input.promptId,
    responseFormat: input.responseFormat ?? 'json',
    maxTokens: input.maxTokens,
    temperature: input.temperature,
    jsonSchema: input.jsonSchema,
    effort: input.effort,
    thinking: input.thinking,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    appendToUserBody: input.appendToUserBody,
    route: input.route,
  });

  return result.text;
}

export type CreateRawCompletionInput = {
  callSite: string;
  system: string;
  user: string;
  provider?: AIProvider;
  modelName?: string;
  responseFormat?: CompletionResponseFormat;
  maxTokens?: number;
  temperature?: number;
  jsonSchema?: Readonly<Record<string, unknown>>;
  effort?: EffortLevel;
  thinking?: ThinkingMode;
  timeoutMs?: number;
  signal?: AbortSignal;
  route?: FreeChatRoute;
};

/**
 * Runs a prompt the caller composed itself, for the bid assistant - the one
 * subsystem whose prompt template lives outside the prompt store.
 */
export async function createRawCompletion(input: CreateRawCompletionInput): Promise<string> {
  const assembled = assembleRawPrompt({ system: input.system, user: input.user });
  const result = await runAssembled(
    assembled,
    {
      provider: input.provider || DEFAULT_PROVIDER,
      modelName: input.modelName,
      // The bid assistant has no provider setting of its own, so an unnamed
      // provider here is the default rather than a choice.
      explicit: Boolean(input.provider),
      routable: true,
    },
    {
      callSite: input.callSite,
      responseFormat: input.responseFormat ?? 'json',
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      jsonSchema: input.jsonSchema,
      effort: input.effort,
      thinking: input.thinking,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      route: input.route,
    }
  );
  return result.text;
}
