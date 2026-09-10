import { getProviderDescriptor } from '../../../../config/providerCatalog';
import { AIProviderError, type AIErrorKind } from '../../errors';
import { acquireSlot, getProviderSemaphore } from '../../concurrency';
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

/**
 * Longest a queued call waits for the one tab.
 *
 * Long, because the alternative is worse: a chat window answers at reading
 * speed, so a second request arriving during a normal turn is ordinary rather
 * than exceptional, and failing it immediately would make a two-profile batch
 * unusable. The caller's own deadline still bounds the wait - `acquireSlot`
 * takes whichever is shorter.
 */
const QUEUE_WAIT_MS = 10 * 60_000;

let sharedSession: BrowserChatSession | null = null;

function getSession(): BrowserChatSession {
  if (!sharedSession) sharedSession = new BrowserChatSession(debugEndpoint());
  return sharedSession;
}

/** For tests, and for a config change that should not need a restart. */
export function resetBrowserChatSession(): void {
  const session = sharedSession;
  sharedSession = null;
  // Not awaited - the caller wants the handle dropped, not a round trip to a
  // browser that may already be gone - but the rejection IS caught. An
  // unhandled one from `disconnect()` on a dead socket takes the process down
  // under Node's default policy, and this runs from config-change handlers and
  // from test teardown, where an exit is a mystifying failure somewhere else.
  void session?.dispose().catch(() => undefined);
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

  // Keyed on the BROWSER, not on the provider.
  //
  // Both browser providers attach to the same Chrome, and a turn's first act is
  // to bring its tab to the front - because a backgrounded tab is frozen and
  // never answers a DOM read at all. Two providers holding separate slots would
  // therefore run at once and take the foreground from each other, and the one
  // that loses it stops being able to read its own page. A single slot per
  // endpoint is what `maxConcurrency: 1` has to mean here.
  const semaphore = getProviderSemaphore(
    `browser-chat:${debugEndpoint(env)}`,
    capabilities.maxConcurrency
  );

  function fail(
    kind: AIErrorKind,
    detail: string,
    adminAction?: string,
    userMessage?: string
  ): AIProviderError {
    return new AIProviderError({
      provider: id,
      kind,
      detail,
      ...(adminAction ? { adminAction } : {}),
      ...(userMessage ? { userMessage } : {}),
    });
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

      // ONE AT A TIME, enforced rather than declared. `maxConcurrency: 1` above
      // is only a number the facade reports; the semaphore is the adapter's to
      // take, exactly as the CLI provider takes its own. Without this two
      // generate requests type into the SAME composer at once: the second
      // clears the first mid-answer, and both callers get somebody else's reply
      // or none. A batch of profiles does this by default.
      const release = await acquireSlot(
        semaphore,
        id,
        request.deadline,
        QUEUE_WAIT_MS,
        request.signal
      );

      try {
        const tab = await session.tabFor(site());
        const text = await tab.ask(body, request.deadline.remainingMs(), request.signal);
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
          if (error.kind === 'cancelled') {
            throw fail('failed', error.message);
          }
          if (error.kind === 'timeout') {
            throw fail(
              'timeout',
              error.message,
              'A browser provider answers at reading speed. Raise the per-call timeout, or use the ' +
                'Claude CLI provider for long prompts.'
            );
          }
          // The site declining is not this app malfunctioning, and the two get
          // told apart here so the operator is sent to the right place. A usage
          // wall is `rateLimited`, which the facade already treats as worth
          // retrying; a signed-out tab is `auth`, which it does not.
          if (error.kind === 'refused') {
            // The kind is reused for its status code and retry semantics, but
            // NOT for its sentence. `auth` and `rateLimited` are worded for the
            // Claude CLI - "an administrator needs to run `claude auth login`",
            // "the Claude subscription usage limit" - and a user whose
            // chatgpt.com tab has signed itself out would be sent to fix a
            // subscription that has nothing to do with it.
            throw fail(
              error.retryable ? 'rateLimited' : 'auth',
              error.message,
              error.retryable
                ? `${descriptor.label} shares the quota of the chat plan it is signed in to. ` +
                    'Nothing here can raise it.'
                : `Open the ${descriptor.label} tab in the debug browser and sign in again.`,
              error.retryable
                ? `${descriptor.label} has reached the usage limit of the chat account it is ` +
                    'signed in to. It resumes when that limit resets, or pick another model.'
                : `${descriptor.label} is signed out in the debug browser. Someone needs to sign ` +
                    'in to that tab, or pick another model.'
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
      } finally {
        release();
      }
    },
  };
}
