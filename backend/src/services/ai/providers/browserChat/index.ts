import { getProviderDescriptor } from '../../../../config/providerCatalog';
import { AIProviderError, type AIErrorKind } from '../../errors';
import { collectUnsupportedReasoningParams } from '../../reasoningParams';
import { warnOnce } from '../../telemetry';
import type {
  AIProviderAdapter,
  CompletionRequest,
  CompletionResult,
  DroppedParam,
  ProviderCapabilities,
  ProviderHealth,
} from '../../types';
import { BrowserChatSession, BrowserSessionError, debugEndpoint } from './session';
import { readChatSite, type ChatSiteId } from './sites';
import { ChatTurnError } from './tab';

/**
 * ChatGPT and Claude, driven in a browser the operator is already signed in to.
 *
 * Same transport for both - only the selectors differ, and those live in
 * `sites.ts`. There is no API key anywhere in this path: the credential is a
 * session cookie in a Chrome this app never launched and cannot read. That is
 * the point of the provider, and also its limit - it is one conversation at a
 * time, at whatever rate the chat plan allows.
 *
 * Two consequences worth stating where they will be read:
 *
 * The answer is what the page rendered - prose, with whatever markdown the
 * site chose to put around it. There is no JSON mode and no schema to enforce,
 * so a caller that wants JSON gets it because the prompt asked, and
 * `extractJSON` downstream pulls it out of a fenced block or prose. That is
 * the same footing the metered chat providers were always on.
 *
 * And it is SLOW - the answer arrives at reading speed rather than at API
 * speed, because it is literally being typed into a page. The per-call
 * deadlines the rest of this app uses still apply and are what stops a turn
 * running forever.
 */

const DEFAULT_MODEL_LABEL = 'chat';

let sharedSession: BrowserChatSession | null = null;

function getSession(): BrowserChatSession {
  if (!sharedSession) sharedSession = new BrowserChatSession(debugEndpoint());
  return sharedSession;
}

/** For tests, and for a config change that should not need a restart. */
export function resetBrowserChatSession(): void {
  const session = sharedSession;
  sharedSession = null;
  void session?.dispose();
}

export type BrowserChatAdapterOptions = {
  session?: BrowserChatSession;
  env?: NodeJS.ProcessEnv;
};

export function createBrowserChatAdapter(
  id: ChatSiteId,
  options: BrowserChatAdapterOptions = {}
): AIProviderAdapter {
  const descriptor = getProviderDescriptor(id);
  const env = options.env ?? process.env;

  const capabilities: ProviderCapabilities = {
    id,
    label: descriptor.label,
    // A chat window has no sampling controls at all: there is nowhere to put a
    // temperature and no output cap to set. Saying so is what makes the facade
    // report the loss once per call site rather than dropping it silently.
    temperature: false,
    maxOutputTokens: false,
    effort: false,
    thinking: false,
    nativeJsonMode: 'none',
    // No system channel. The facade folds the system text into the head of the
    // user turn, which is the only place a chat UI has to put it.
    systemBlocks: false,
    requiresApiKey: false,
    credentialKind: 'browser-session',
    // ONE. A tab holds one conversation, and a second prompt typed into a
    // composer that is mid-answer does not queue - it interleaves, and both
    // answers are lost. The provider semaphore is what enforces this.
    maxConcurrency: 1,
  };

  const site = () => readChatSite(id, env);

  function fail(kind: AIErrorKind, detail: string, adminAction?: string): AIProviderError {
    return new AIProviderError({ provider: id, kind, detail, ...(adminAction ? { adminAction } : {}) });
  }

  return {
    id,
    capabilities,
    defaultModelName: () => DEFAULT_MODEL_LABEL,

    async health(): Promise<ProviderHealth> {
      const session = options.session ?? getSession();
      const probe = await session.probe(site());
      return {
        ok: probe.ok,
        detail: probe.detail,
        ...(probe.hint ? { warning: probe.hint } : {}),
        checkedAt: new Date().toISOString(),
      };
    },

    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const droppedParams: DroppedParam[] = collectUnsupportedReasoningParams(request, capabilities);
      if (typeof request.sampling.temperature === 'number') {
        droppedParams.push('temperature');
        warnOnce(
          `${id}-drop-temperature:${request.callSite}`,
          `"${request.callSite}" asks for temperature ${request.sampling.temperature}, but a chat ` +
            'window has no sampling controls. The request runs at whatever the site does.'
        );
      }
      if (typeof request.sampling.maxOutputTokens === 'number') {
        droppedParams.push('maxOutputTokens');
        warnOnce(
          `${id}-drop-maxtokens:${request.callSite}`,
          `"${request.callSite}" asks for a ${request.sampling.maxOutputTokens}-token cap, but a ` +
            'chat window has no such control.'
        );
      }

      const body = [request.volatileSystem, request.stableSystem, request.userBody]
        .map((part) => part.trim())
        .filter(Boolean)
        .join('\n\n');

      const startedAt = Date.now();
      const session = options.session ?? getSession();

      try {
        const tab = await session.tabFor(site());
        const text = await tab.ask(body, request.deadline.remainingMs());
        return {
          text,
          resolvedModel: `${id}/${DEFAULT_MODEL_LABEL}`,
          providerId: id,
          // A chat window reports no token counts. Zeroes are honest here -
          // there is nothing being metered to count.
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          droppedParams,
          latencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        if (error instanceof BrowserSessionError) {
          throw fail('unavailable', error.message, error.hint);
        }
        if (error instanceof ChatTurnError) {
          if (error.kind === 'timeout') {
            throw fail(
              'timeout',
              error.message,
              'A browser provider answers at reading speed. Raise the per-call timeout, or use the ' +
                'Claude CLI provider for long prompts.'
            );
          }
          throw fail(
            error.kind === 'echo' ? 'malformedOutput' : 'unavailable',
            error.message,
            `Check the tab in the debug browser, then the selector overrides for ${descriptor.label}.`
          );
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw fail('unavailable', `${descriptor.label} failed: ${detail}`);
      }
    },
  };
}
