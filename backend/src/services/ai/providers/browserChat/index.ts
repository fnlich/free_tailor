import { getBrowserChatEndpoints } from '../../../../config/aiModelConfig';
import { getProviderDescriptor } from '../../../../config/providerCatalog';
import { AIProviderError, type AIErrorKind } from '../../errors';
import {
  getTabPool,
  isEndpointLeased,
  NoTabsConfiguredError,
  TabWaitAbortedError,
  TabWaitTimeoutError,
  type TabLease,
  type TabPool,
} from './pool';
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

/**
 * How long a browser that could not be reached is set aside.
 *
 * Short, because the likeliest reason to be here is that the operator is
 * starting that browser right now - the defaults name ports nobody has opened
 * yet. Long enough that a batch does not retry a dead one on every single call.
 */
const UNREACHABLE_FOR_MS = 30_000;

/**
 * One connection per browser, held open between calls.
 *
 * Keyed on the endpoint because there is now more than one browser: a site's
 * concurrency IS how many it has. Reconnecting per call would cost a round trip
 * and, worse, lose the tab - every call would land on whatever tab happened to
 * be frontmost in that window.
 */
const sessions = new Map<string, BrowserChatSession>();

function sessionFor(endpoint: string): BrowserChatSession {
  const held = sessions.get(endpoint);
  if (held) return held;
  const created = new BrowserChatSession(endpoint);
  sessions.set(endpoint, created);
  return created;
}

/**
 * Lets go of browsers that are no longer configured, without closing them.
 *
 * A browser being USED right now is left alone even when it has just been
 * removed from the list. This runs at the start of every call, so an operator
 * who removes a row while a request is running would otherwise have that
 * request's connection torn out from under it mid-answer - and the pool is
 * already careful about exactly this, keeping a removed-but-busy tab busy until
 * its call lets go. The session has to be as careful as the pool. It is dropped
 * on the next call after the lease ends.
 */
function forgetUnconfigured(live: Set<string> | null): void {
  if (!live) return;
  for (const [endpoint, session] of [...sessions]) {
    if (live.has(endpoint) || isEndpointLeased(endpoint)) continue;
    sessions.delete(endpoint);
    // `dispose`, never `close`: it is the operator's window, and they are
    // probably still signed in to it.
    void session.dispose().catch(() => undefined);
  }
}

function endpointUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** "port 9222", for a message that has to name which browser went wrong. */
function portOf(endpoint: string): string {
  try {
    const port = new URL(endpoint).port;
    return port ? `port ${port}` : endpoint;
  } catch {
    return endpoint;
  }
}

/**
 * The tabs this site may use, refreshed from settings on every call.
 *
 * `AI_WEB_CDP_URL` still wins outright when set: it is the escape hatch for a
 * browser that is not on this machine, and a port list cannot express one. It
 * gives that site exactly one tab, which is what a single URL can describe.
 */
async function endpointsFor(
  id: ChatSiteId,
  env: NodeJS.ProcessEnv
): Promise<{ mine: string[]; all: Set<string> | null }> {
  const explicit = (env.AI_WEB_CDP_URL ?? '').trim();
  if (explicit) return { mine: [explicit], all: new Set([explicit]) };
  try {
    const configured = await getBrowserChatEndpoints();
    const all = new Set(configured.map((entry) => endpointUrl(entry.port)));
    const mine = configured
      .filter((entry) => entry.siteId === id)
      .map((entry) => endpointUrl(entry.port));
    return { mine, all };
  } catch {
    // A settings read that fails must not take the provider down with it - so
    // this call falls back to the environment's single browser. `all` is NULL
    // rather than that one endpoint, and the difference matters: `all` is what
    // decides which connections to let go of, and a momentary settings failure
    // saying "one browser is configured" would drop every other browser's
    // connection in the process. Not knowing is not the same as knowing there
    // is nothing, and only the second is grounds for forgetting anything.
    return { mine: [debugEndpoint(env)], all: null };
  }
}

/**
 * This site's pool, pointed at the browsers currently configured for it.
 *
 * Each site has its own pool and therefore its own line: Claude free and
 * ChatGPT free do not wait for one another, and neither waits for the Claude
 * CLI, which has a semaphore of its own. Three providers, three queues.
 */
async function poolFor(id: ChatSiteId, env: NodeJS.ProcessEnv): Promise<TabPool> {
  const { mine, all } = await endpointsFor(id, env);
  const pool = getTabPool(id, getProviderDescriptor(id).label);
  pool.setEndpoints(mine);
  // Against the WHOLE configured set, not just this site's: a browser removed
  // from the other site is no less gone, and a held connection to it is a
  // socket kept open to a window nobody is going to use again.
  forgetUnconfigured(all);
  return pool;
}

/** For tests, and for a config change that should not need a restart. */
export function resetBrowserChatSession(): void {
  const held = [...sessions.values()];
  sessions.clear();
  for (const session of held) {
    // Not awaited - the caller wants the handles dropped, not a round trip to a
    // browser that may already be gone - but the rejection IS caught. An
    // unhandled one from `disconnect()` on a dead socket takes the process down
    // under Node's default policy, and this runs from config-change handlers
    // and from test teardown, where an exit is a mystifying failure elsewhere.
    void session.dispose().catch(() => undefined);
  }
}


/**
 * A tab, or a failure worded for the thing that actually went wrong.
 *
 * Three of them, and they want three different things done. No browser
 * configured is a setup step nobody has taken. A wait that ran out is a queue
 * that is genuinely long - the caller's own deadline decided that, not a cap.
 * A cancelled call is nobody's fault at all.
 */
async function acquireTab(
  pool: TabPool,
  request: CompletionRequest,
  id: ChatSiteId,
  label: string
): Promise<TabLease> {
  try {
    return await pool.acquire({
      // The caller's own deadline, and nothing else. There is no queue bound
      // here on purpose: a call is never refused for being late in the line,
      // only for running out of its own time.
      timeoutMs: Math.min(request.deadline.remainingMs(), QUEUE_WAIT_MS),
      signal: request.signal,
    });
  } catch (error) {
    if (error instanceof NoTabsConfiguredError) {
      throw new AIProviderError({
        provider: id,
        kind: 'disabled',
        detail: error.message,
        userMessage: `${label} has no browser set up yet.`,
        adminAction:
          `Add a browser for ${label} under Admin -> Settings -> Browser Chat, start it, and ` +
          'sign in to the tab it opens.',
      });
    }
    if (error instanceof TabWaitTimeoutError) {
      throw new AIProviderError({
        provider: id,
        kind: 'timeout',
        detail: error.message,
        userMessage:
          `${label} is busy and this request waited its whole time budget for a free tab.`,
        adminAction:
          `Add another browser for ${label} under Admin -> Settings -> Browser Chat: each one ` +
          'runs one more request at a time.',
      });
    }
    if (error instanceof TabWaitAbortedError) {
      throw new AIProviderError({ provider: id, kind: 'failed', detail: error.message });
    }
    throw error;
  }
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
    // One call PER TAB. A tab holds one conversation, and a second prompt
    // typed into a composer that is mid-answer does not queue - it interleaves,
    // and both answers are lost. How many run at once is therefore how many
    // browsers this site has, which the operator decides on the Settings page;
    // the pool is what enforces one call per tab. Reported as 1 because that is
    // what a single tab allows, and it is the number the facade uses to warn a
    // caller about a provider that cannot be parallelised on its own.
    maxConcurrency: 1,
  };

  const site = () => readChatSite(id, env);

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

    /**
     * Every browser this site has, not just one.
     *
     * A site with three browsers and one signed-out tab is two-thirds working,
     * and reporting only the first would either hide that or condemn the whole
     * provider for it. `ok` means at least one tab can be driven, because one
     * is all a call needs; the detail says how many of them can.
     */
    async health(): Promise<ProviderHealth> {
      const { mine } = await endpointsFor(id, env);
      if (mine.length === 0) {
        return {
          ok: false,
          detail: 'No browser is set up for this provider yet.',
          warning:
            'Register a debug port under Admin -> Settings -> Browser Chat, start it with ' +
            `\`npm run browser:debug\`, and sign in to the ${descriptor.label} tab it opens.`,
          checkedAt: new Date().toISOString(),
        };
      }

      // A browser a call is USING is reported, not probed.
      //
      // A probe drives the same tab a turn is driving: it reads the DOM, and
      // `pageFor` will navigate or open a tab if it does not find one. Doing
      // that to a tab mid-answer can disturb a live request - and the Settings
      // page asks for health on every load, so this is not a rare collision but
      // one an operator triggers by watching. A browser that is in use is, by
      // the only definition that matters here, working.
      const probes = await Promise.all(
        mine.map(async (endpoint) => {
          if (isEndpointLeased(endpoint)) {
            return { endpoint, ok: true, detail: 'Busy with a request.', hint: undefined };
          }
          const session = options.session ?? sessionFor(endpoint);
          return { endpoint, ...(await session.probe(site())) };
        })
      );

      const ready = probes.filter((probe) => probe.ok);
      const broken = probes.filter((probe) => !probe.ok);
      const plural = probes.length === 1 ? 'tab' : 'tabs';

      return {
        ok: ready.length > 0,
        detail:
          ready.length === probes.length
            ? `${ready.length} ${plural} ready.`
            : `${ready.length} of ${probes.length} ${plural} ready.`,
        ...(broken.length
          ? {
              warning: broken
                .map((probe) => `${portOf(probe.endpoint)}: ${probe.detail}${probe.hint ? ` ${probe.hint}` : ''}`)
                .join(' | '),
            }
          : {}),
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

      // A TAB, not merely permission to proceed.
      //
      // The line for this site is unbounded and first-come-first-served: the
      // moment any of its browsers frees up, the call at the head takes that
      // browser. Which one it gets matters and is why this hands back an
      // endpoint rather than a slot - a caller cannot drive a browser without
      // knowing which browser it has been given.
      //
      // Without it, two generate requests type into the SAME composer at once:
      // the second clears the first mid-answer, and both callers get somebody
      // else's reply or none. A batch of profiles does this by default.
      const pool = await poolFor(id, env);

      // Tried on another browser when THIS one cannot be reached at all.
      //
      // A configured browser is not necessarily a running one - the defaults
      // name ports nobody has started yet, and an operator can close a window
      // mid-run. Without this, a site with two browsers and one of them dead
      // fails every second call for a reason that has nothing to do with the
      // request. Only a connection failure is retried: a page that misbehaved
      // says nothing about whether the browser is there, and repeating a prompt
      // that was already typed would ask the same question twice.
      let lastUnreachable: BrowserSessionError | null = null;
      const attempts = Math.max(1, pool.size);

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const lease = await acquireTab(pool, request, id, descriptor.label);
        try {
          const session = options.session ?? sessionFor(lease.endpoint);
          const tab = await session.tabFor(site());
          const text = await tab.ask(body, request.deadline.remainingMs(), request.signal);
          pool.markReachable(lease.endpoint);
          return finish(text);
        } catch (error) {
          if (error instanceof BrowserSessionError && request.deadline.remainingMs() > 0) {
            pool.markUnreachable(lease.endpoint, UNREACHABLE_FOR_MS);
            lastUnreachable = error;
            continue;
          }
          throw translate(error);
        } finally {
          lease.release();
        }
      }

      throw fail(
        'unavailable',
        lastUnreachable?.message ?? `No ${descriptor.label} browser could be reached.`,
        lastUnreachable?.hint
      );

      function finish(text: string): CompletionResult {
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
      }

      function translate(error: unknown): AIProviderError {
        if (error instanceof BrowserSessionError) {
          return fail('unavailable', error.message, error.hint);
        }
        if (error instanceof ChatTurnError) {
          if (error.kind === 'cancelled') {
            return fail('failed', error.message);
          }
          if (error.kind === 'timeout') {
            return fail(
              'timeout',
              error.message,
              'A free browser provider answers at reading speed. Raise the per-call timeout, add ' +
                'another browser for it under Settings, or use the Claude CLI provider.',
              // The DRIVER's sentence, not the generic one for this kind.
              //
              // `detail` never reaches a browser - the middleware withholds it
              // on purpose - so without this every browser-chat failure arrived
              // as "The request took too long. Try a shorter job description",
              // whatever had actually gone wrong. The driver knows which step
              // failed and says so; that is the sentence worth showing.
              `${descriptor.label}: ${error.message}`
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
            return fail(
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
          return fail(
            error.kind === 'echo' ? 'malformedOutput' : 'unavailable',
            error.message,
            `Run \`npm run browser:doctor -- --send\` against the ${descriptor.label} tab: it ` +
              'reports which selector role matched what, and names the override that fixes it.',
            // Same reasoning as the timeout branch: the driver names the step
            // that failed, and a generic "the provider is unavailable" sends
            // the operator nowhere.
            `${descriptor.label}: ${error.message}`
          );
        }
        const detail = error instanceof Error ? error.message : String(error);
        return fail('unavailable', `${descriptor.label} failed: ${detail}`);
      }
    },
  };
}
