import OpenAI from 'openai';
import { getProviderApiKey } from '../../../config/aiModelConfig';
import { getProviderDescriptor } from '../../../config/providerCatalog';
import type { AIProvider } from '../../../types/template';
import { AIProviderError, asAIProviderError, type AIErrorKind } from '../errors';
import type {
  AIProviderAdapter,
  CompletionRequest,
  CompletionResult,
  ProviderCapabilities,
  ProviderHealth,
} from '../types';

/**
 * OpenAI and DeepSeek share a wire format, so they share an adapter. The only
 * differences are the base URL, the default model, and the token-cap field
 * name - OpenAI moved to `max_completion_tokens` while DeepSeek still takes
 * `max_tokens`.
 */

type OpenAICompatibleOptions = {
  id: Extract<AIProvider, 'openai' | 'deepseek'>;
  baseURL?: string;
  defaultModel: string;
  /** OpenAI renamed this field; DeepSeek did not. */
  tokenLimitField: 'max_completion_tokens' | 'max_tokens';
};

function classifyHttpStatus(status: number | undefined): AIErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rateLimited';
  if (status === 404) return 'modelUnavailable';
  if (status && status >= 500) return 'unavailable';
  return 'failed';
}

export function createOpenAICompatibleAdapter(options: OpenAICompatibleOptions): AIProviderAdapter {
  const descriptor = getProviderDescriptor(options.id);
  let client: OpenAI | null = null;
  let clientKey = '';

  const capabilities: ProviderCapabilities = {
    id: options.id,
    label: descriptor.label,
    temperature: true,
    maxOutputTokens: true,
    nativeJsonMode: 'response_format',
    systemBlocks: false,
    requiresApiKey: true,
    credentialKind: 'api-key',
    maxConcurrency: Number.POSITIVE_INFINITY,
  };

  async function getClient(): Promise<OpenAI> {
    const apiKey = await getProviderApiKey(options.id);
    if (!apiKey) {
      throw new AIProviderError({
        provider: options.id,
        kind: 'auth',
        detail: `${descriptor.label} API key is not set`,
        adminAction: `Add a ${descriptor.label} key under Admin -> Settings, or set ${descriptor.envKeyVar}.`,
      });
    }
    if (!client || clientKey !== apiKey) {
      client = new OpenAI({ apiKey, ...(options.baseURL ? { baseURL: options.baseURL } : {}) });
      clientKey = apiKey;
    }
    return client;
  }

  return {
    id: options.id,
    capabilities,
    defaultModelName: () => options.defaultModel,

    async health(): Promise<ProviderHealth> {
      const checkedAt = new Date().toISOString();
      try {
        const apiKey = await getProviderApiKey(options.id);
        return apiKey
          ? { ok: true, detail: 'An API key is configured.', checkedAt }
          : {
              ok: false,
              detail: 'No API key is configured.',
              checkedAt,
              warning: `Add one under Admin -> Settings, or set ${descriptor.envKeyVar}.`,
            };
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
          checkedAt,
        };
      }
    },

    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const startedAt = Date.now();
      const model = request.modelName || options.defaultModel;
      const system = [request.volatileSystem, request.stableSystem]
        .map((part) => part.trim())
        .filter(Boolean)
        .join('\n\n');

      const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
      if (system) {
        messages.push({ role: 'system', content: system });
      }
      messages.push({ role: 'user', content: request.userBody });

      try {
        const response = await (await getClient()).chat.completions.create(
          {
            model,
            [options.tokenLimitField]: request.sampling.maxOutputTokens ?? 4000,
            temperature: request.sampling.temperature ?? 0,
            top_p: 1,
            ...(request.responseFormat === 'json'
              ? { response_format: { type: 'json_object' as const } }
              : {}),
            messages,
          } as Parameters<OpenAI['chat']['completions']['create']>[0],
          { signal: request.signal }
        );

        const completion = response as OpenAI.Chat.Completions.ChatCompletion;
        const choice = completion.choices?.[0];
        const text = choice?.message?.content?.trim() ?? '';

        if (choice?.finish_reason === 'length') {
          throw new AIProviderError({
            provider: options.id,
            kind: 'truncated',
            detail: `the response hit the ${request.sampling.maxOutputTokens ?? 4000}-token output cap`,
          });
        }
        if (!text) {
          throw new AIProviderError({
            provider: options.id,
            kind: 'malformedOutput',
            detail: `${descriptor.label} returned an empty response`,
          });
        }

        return {
          text,
          resolvedModel: completion.model || model,
          providerId: options.id,
          usage: {
            inputTokens: completion.usage?.prompt_tokens ?? 0,
            outputTokens: completion.usage?.completion_tokens ?? 0,
            cacheReadTokens: completion.usage?.prompt_tokens_details?.cached_tokens ?? 0,
            cacheWriteTokens: 0,
          },
          droppedParams: [],
          latencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        if (error instanceof AIProviderError) {
          throw error;
        }
        const status = (error as { status?: number }).status;
        throw asAIProviderError(error, options.id, classifyHttpStatus(status));
      }
    },
  };
}
