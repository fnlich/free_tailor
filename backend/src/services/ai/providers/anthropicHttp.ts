import { getProviderApiKey } from '../../../config/aiModelConfig';
import { getProviderDescriptor } from '../../../config/providerCatalog';
import { AIProviderError, asAIProviderError, type AIErrorKind } from '../errors';
import type {
  AIProviderAdapter,
  CompletionRequest,
  CompletionResult,
  ProviderCapabilities,
  ProviderHealth,
} from '../types';

/**
 * The metered Anthropic Messages API, driven with `fetch` (the app has never
 * depended on the Anthropic SDK and does not start here).
 *
 * Kept alongside the CLI provider on purpose. It is the only remaining provider
 * that can honour `temperature`, which makes it the escape hatch for the cover
 * letter prompt if its prose becomes too uniform on the CLI - a change of one
 * field on that prompt record, with no deploy.
 */

const PROVIDER_ID = 'claude' as const;
const MAX_RETRIES = 4;
const BASE_RETRY_DELAY_MS = 600;
const MAX_RETRY_DELAY_MS = 15_000;

type AnthropicTextBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

type AnthropicResponse = {
  model?: string;
  stop_reason?: string | null;
  content?: Array<{ type: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

function retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(Math.round(retryAfterSeconds * 1000), MAX_RETRY_DELAY_MS);
  }
  const exponential = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
  return Math.min(exponential + Math.round(Math.random() * 300), MAX_RETRY_DELAY_MS);
}

function classifyStatus(status: number): AIErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rateLimited';
  if (status === 404) return 'modelUnavailable';
  if (status >= 500) return 'unavailable';
  return 'failed';
}

const isRetriableStatus = (status: number): boolean =>
  status === 429 || status === 529 || (status >= 500 && status < 600);

export function createAnthropicHttpAdapter(options: { defaultModel: string }): AIProviderAdapter {
  const descriptor = getProviderDescriptor(PROVIDER_ID);

  const capabilities: ProviderCapabilities = {
    id: PROVIDER_ID,
    label: descriptor.label,
    temperature: true,
    maxOutputTokens: true,
    nativeJsonMode: 'none',
    systemBlocks: true,
    requiresApiKey: true,
    credentialKind: 'api-key',
    maxConcurrency: Number.POSITIVE_INFINITY,
  };

  return {
    id: PROVIDER_ID,
    capabilities,
    defaultModelName: () => options.defaultModel,

    async health(): Promise<ProviderHealth> {
      const checkedAt = new Date().toISOString();
      const apiKey = await getProviderApiKey(PROVIDER_ID);
      return apiKey
        ? { ok: true, detail: 'An API key is configured.', checkedAt }
        : {
            ok: false,
            detail: 'No API key is configured.',
            checkedAt,
            warning: 'Add one under Admin -> Settings, or set ANTHROPIC_API_KEY.',
          };
    },

    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const startedAt = Date.now();
      const apiKey = await getProviderApiKey(PROVIDER_ID);
      if (!apiKey) {
        throw new AIProviderError({
          provider: PROVIDER_ID,
          kind: 'auth',
          detail: 'Anthropic API key is not set',
          adminAction: 'Add an Anthropic key under Admin -> Settings, or set ANTHROPIC_API_KEY.',
        });
      }

      const system: AnthropicTextBlock[] = [];
      if (request.volatileSystem.trim()) {
        system.push({ type: 'text', text: request.volatileSystem });
      }
      if (request.stableSystem.trim()) {
        // The stable preamble is byte-identical across every call of a prompt,
        // which is exactly what an ephemeral cache breakpoint is for. The
        // system/user split existed here already and had never been wired to
        // caching; this is the one line that made it pay.
        system.push({ type: 'text', text: request.stableSystem, cache_control: { type: 'ephemeral' } });
      }

      const body = {
        model: request.modelName || options.defaultModel,
        max_tokens: request.sampling.maxOutputTokens ?? 4000,
        temperature: request.sampling.temperature ?? 0,
        ...(system.length ? { system } : {}),
        messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: request.userBody || ' ' }] }],
      };

      let lastError: unknown = null;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
        if (request.deadline.expired()) {
          throw new AIProviderError({
            provider: PROVIDER_ID,
            kind: 'timeout',
            detail: 'the request budget was exhausted before Anthropic answered',
          });
        }

        try {
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              'anthropic-beta': 'prompt-caching-2024-07-31',
            },
            body: JSON.stringify(body),
            signal: request.signal,
          });

          if (!response.ok) {
            const errorText = await response.text();
            const kind = classifyStatus(response.status);
            if (!isRetriableStatus(response.status) || attempt === MAX_RETRIES) {
              throw new AIProviderError({
                provider: PROVIDER_ID,
                kind,
                detail: `Anthropic API error (${response.status}): ${errorText}`,
              });
            }
            const delay = retryDelayMs(attempt, response.headers.get('retry-after'));
            console.warn(
              `[ai] Anthropic returned ${response.status} (attempt ${attempt}/${MAX_RETRIES}); retrying in ${delay}ms.`
            );
            await sleep(delay);
            continue;
          }

          const data = (await response.json()) as AnthropicResponse;
          const text = (data.content ?? [])
            .filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text ?? '')
            .join('')
            .trim();

          if (data.stop_reason === 'max_tokens') {
            throw new AIProviderError({
              provider: PROVIDER_ID,
              kind: 'truncated',
              detail: `the response hit the ${body.max_tokens}-token output cap`,
            });
          }
          if (!text) {
            throw new AIProviderError({
              provider: PROVIDER_ID,
              kind: 'malformedOutput',
              detail: 'Anthropic returned no text content',
            });
          }

          return {
            text,
            resolvedModel: data.model || body.model,
            providerId: PROVIDER_ID,
            usage: {
              inputTokens: data.usage?.input_tokens ?? 0,
              outputTokens: data.usage?.output_tokens ?? 0,
              cacheReadTokens: data.usage?.cache_read_input_tokens ?? 0,
              cacheWriteTokens: data.usage?.cache_creation_input_tokens ?? 0,
            },
            droppedParams: [],
            latencyMs: Date.now() - startedAt,
          };
        } catch (error) {
          if (error instanceof AIProviderError) {
            throw error;
          }
          lastError = error;
          const message = error instanceof Error ? error.message.toLowerCase() : String(error);
          const isNetworkFailure =
            (error instanceof Error && error.name === 'TypeError') || message.includes('fetch failed');
          if (!isNetworkFailure || attempt === MAX_RETRIES) {
            throw asAIProviderError(error, PROVIDER_ID, isNetworkFailure ? 'unavailable' : 'failed');
          }
          const delay = retryDelayMs(attempt, null);
          console.warn(
            `[ai] Anthropic request failed on a network error (attempt ${attempt}/${MAX_RETRIES}); retrying in ${delay}ms.`
          );
          await sleep(delay);
        }
      }

      throw asAIProviderError(lastError ?? new Error('Anthropic request failed'), PROVIDER_ID, 'unavailable');
    },
  };
}
