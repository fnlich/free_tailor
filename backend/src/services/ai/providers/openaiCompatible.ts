import OpenAI from 'openai';
import { getProviderApiKey } from '../../../config/aiModelConfig';
import type { EnvUrl } from '../../../config/envValue';
import { deepseekBaseUrl, openaiBaseUrl } from '../../../config/operational';
import {
  getProviderDescriptor,
} from '../../../config/providerCatalog';
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

type OpenAICompatibleId = Extract<AIProvider, 'openai' | 'deepseek'>;

type OpenAICompatibleOptions = {
  id: OpenAICompatibleId;
  defaultModel: string;
  /** OpenAI renamed this field; DeepSeek did not. */
  tokenLimitField: 'max_completion_tokens' | 'max_tokens';
};

/**
 * Where each provider's API lives: OPENAI_BASE_URL and DEEPSEEK_BASE_URL, each
 * defaulting to the vendor endpoint when unset and validated by envUrl, since
 * the API key is sent to whatever they name. An absolute http(s) URL is used as
 * set - plain http to another host warns but is used. A value envUrl REFUSES
 * (no scheme, `user:password@`, a query or fragment) makes the provider
 * unavailable: `getClient` throws before a client exists and `health` reports
 * it, so nothing is sent - least of all to the vendor the setting was there to
 * route around.
 *
 * Keyed on the id, so a third OpenAI-compatible provider cannot be added
 * without deciding its endpoint. OPENAI_BASE_URL is passed EXPLICITLY even
 * though the SDK would read it by itself: that way it is validated, shown on
 * the startup line beside the other two, and - the point for DeepSeek - an
 * explicit `baseURL` is what keeps the SDK's own read of that variable from
 * ever applying to the wrong vendor. For the same reason a refusal is never
 * "pass no baseURL": the SDK would read OPENAI_BASE_URL again, unchecked.
 */
const BASE_URL: Record<OpenAICompatibleId, () => EnvUrl> = {
  openai: openaiBaseUrl,
  deepseek: deepseekBaseUrl,
};

/**
 * What the SDK would otherwise read from OPENAI_* for a client that is not
 * talking to OpenAI.
 *
 * `new OpenAI()` fills `organization` and `project` from OPENAI_ORG_ID and
 * OPENAI_PROJECT_ID when they are left undefined, and sends them as the
 * OpenAI-Organization and OpenAI-Project headers on every request. That is
 * right for OpenAI and a leak for DeepSeek, which would receive the operator's
 * OpenAI org and project ids on every call. `null` (not undefined) is what the
 * SDK takes as "none" - its defaults are destructuring defaults.
 */
const VENDOR_SCOPE: Record<OpenAICompatibleId, { organization?: null; project?: null }> = {
  openai: {},
  deepseek: { organization: null, project: null },
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

  /** The error for an endpoint envUrl refused: raised before any client or request exists. */
  function refusedEndpoint(endpoint: Extract<EnvUrl, { ok: false }>): AIProviderError {
    return new AIProviderError({
      provider: options.id,
      kind: 'misconfigured',
      detail: endpoint.problem,
      adminAction: endpoint.remedy,
    });
  }

  async function getClient(): Promise<OpenAI> {
    // Read per call so a test can change it; the client is rebuilt only when
    // the key or the endpoint actually changed, which in a running server is
    // never - `.env` is loaded once at boot. Checked FIRST: a refused endpoint
    // means nothing is sent, whatever else is or is not configured.
    const endpoint = BASE_URL[options.id]();
    if (!endpoint.ok) {
      throw refusedEndpoint(endpoint);
    }
    const apiKey = await getProviderApiKey(options.id);
    if (!apiKey) {
      throw new AIProviderError({
        provider: options.id,
        kind: 'auth',
        detail: `${descriptor.label} API key is not set`,
        adminAction:
          `Set ${descriptor.envKeyVar} in the root .env and restart the backend - keys are read from the ` +
          'environment only.',
      });
    }
    const baseURL = endpoint.url;
    const key = `${baseURL}\n${apiKey}`;
    if (!client || clientKey !== key) {
      // No per-request `timeout`, so the SDK's own (10 minutes per attempt,
      // two retries) applies and AI_REQUEST_TIMEOUT_MS does not cut an
      // in-flight request short. Only the caller's cancel signal does.
      client = new OpenAI({ apiKey, baseURL, ...VENDOR_SCOPE[options.id] });
      clientKey = key;
    }
    return client;
  }

  return {
    id: options.id,
    capabilities,
    defaultModelName: () => options.defaultModel,

    async health(): Promise<ProviderHealth> {
      const checkedAt = new Date().toISOString();
      const endpoint = BASE_URL[options.id]();
      if (!endpoint.ok) {
        return { ok: false, detail: `${endpoint.problem}, so nothing is sent.`, checkedAt, warning: endpoint.remedy };
      }
      try {
        const apiKey = await getProviderApiKey(options.id);
        return apiKey
          ? { ok: true, detail: 'An API key is configured.', checkedAt }
          : {
              ok: false,
              detail: 'No API key is configured.',
              checkedAt,
              warning: `Set ${descriptor.envKeyVar} in .env - keys are read from the environment only.`,
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
