import { getBrowserChatEndpoints } from '../../../../config/aiModelConfig';
import {
  getProviderDescriptor,
  providerSupportsEffort,
  providerSupportsThinking,
} from '../../../../config/providerCatalog';
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
 * How long a browser that REFUSED is set aside.
 *
 * Much longer than an unreachable one, because the reasons are different in
 * kind. A browser that did not answer the debug port is probably being started
 * right now. A browser whose account is out of messages will still be out of
 * messages in thirty seconds, and asking it again every call spends a tab
 * lease and a page load to rediscover what the last call already found out.
 *
 * Not longer still, because the two things that end a wall - the account's own
 * clock, and an operator signing back in - both happen without telling this
 * app, and a browser held down for an hour after it recovered is capacity the
 * operator paid for and is not getting.
 */
const REFUSED_FOR_MS = 10 * 60_000;

/**
 * How long a browser that could not take the prompt is set aside.
 *
 * The middle case: a wedged tab, a composer that would not hold the text, a
 * previous turn that never let go. Usually transient and usually fixed by the
 * next turn's fresh conversation, so this only has to stop a batch from
 * queueing every one of its calls onto the same bad browser in turn.
 */
const UNUSABLE_FOR_MS = 2 * 60_000;

/**
 * Why a browser was passed over, and for how long - or null when the failure
 * was the REQUEST'S and no other browser would do better.
 *
 * This is the whole judgement, in one place. The rule is not about the kind of
 * failure but about whether the prompt was asked: a turn that never got the
 * question in front of the site has cost that account nothing, so asking a
 * different browser is free. A turn that did ask cannot be repeated elsewhere
 * without putting the same question into two accounts - except when the site
 * answered by refusing, where no answer is coming and a duplicate entry in one
 * chat history is a far smaller price than failing the whole generation.
 *
 * `timeout` and `cancelled` are never another browser's problem. The first
 * means the budget is gone, so a second attempt has nothing to spend; the
 * second means the caller left, and the whole point of noticing was to stop.
 */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
}

/**
 * The same failure, with the browsers that were tried named in its detail.
 *
 * `detail` and not `userMessage`: the list is for whoever reads the log, and
 * the sentence shown in the app is already the right one for the kind. A new
 * error rather than a mutation, because `AIProviderError` is built once and
 * read in several places.
 */
function withTriedBrowsers(error: AIProviderError, tried: string): AIProviderError {
  return new AIProviderError({
    provider: error.provider,
    kind: error.kind,
    detail: `${error.detail} ${tried}`,
    ...(error.adminAction ? { adminAction: error.adminAction } : {}),
    ...(error.userMessage ? { userMessage: error.userMessage } : {}),
    ...(typeof error.retryAfterSeconds === 'number'
      ? { retryAfterSeconds: error.retryAfterSeconds }
      : {}),
  });
}

function describeBrowserFault(
  error: unknown
): { reason: string; coolForMs: number } | null {
  if (error instanceof BrowserSessionError) {
    return { reason: error.message, coolForMs: UNREACHABLE_FOR_MS };
  }
  if (!(error instanceof ChatTurnError)) return null;
  if (error.kind === 'timeout' || error.kind === 'cancelled') return null;

  if (error.kind === 'refused') {
    // Both before and after sending. The site has said it will not answer, so
    // waiting on this browser cannot help and another one might.
    return { reason: error.message, coolForMs: REFUSED_FOR_MS };
  }

  // Everything else only when the prompt never landed.
  //
  // The residual risk is named rather than hidden: a send that DID reach the
  // site but could not be confirmed within the confirm window reads as unsent,
  // and this will ask a second browser. That is a duplicate question in one
  // account, against a status quo where the caller got nothing at all - and it
  // takes both the click confirmation and the Enter fallback failing to get
  // there.
  return error.sent ? null : { reason: error.message, coolForMs: UNUSABLE_FOR_MS };
}

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
  /** One session for every browser. Kept for callers that need no per-browser behaviour. */
  session?: BrowserChatSession;
  /**
   * A session PER BROWSER, when the two have to differ.
   *
   * The skip-and-move-on behaviour is entirely about browsers behaving
   * differently from one another - this one is out of messages, that one is
   * fine - and a seam that hands the same session to every endpoint cannot
   * express the situation it is meant to exercise, let alone check it.
   */
  sessionFor?: (endpoint: string) => BrowserChatSession;
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
    effort: providerSupportsEffort(id),
    thinking: providerSupportsThinking(id),
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
          const session = options.sessionFor?.(endpoint) ?? options.session ?? sessionFor(endpoint);
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

      // Tried on ANOTHER browser when this one cannot do the job.
      //
      // A configured browser is not necessarily a usable one. It may not be
      // running - the defaults name ports nobody has opened - or it may be
      // running and signed out, or wedged, or its account out of messages for
      // the next three hours. Those are all facts about that browser and none
      // of them is a fact about the request, which is why having a second
      // browser should mean the request still succeeds.
      //
      // It is the reason to run more than one in the first place: a site's
      // browsers are separate windows with separate sessions, so an operator
      // can sign a different account into each. A wall on one is then not a
      // wall on the site, and failing the call on the strength of it wastes
      // capacity that is sitting right there.
      //
      // Each browser is tried at most once - the lease is released and the
      // endpoint marked down before moving on, so `acquire` cannot hand back
      // the same one - and the last failure of each is kept, because when they
      // all refuse, "which browsers, and why each" is the only thing an
      // operator can act on.
      const skipped: Array<{ endpoint: string; reason: string }> = [];
      // The raw error of the last browser to refuse, kept so the failure that
      // comes back is still that browser's own. See the throw below.
      let lastFault: unknown;
      const attempts = Math.max(1, pool.size);

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const lease = await acquireTab(pool, request, id, descriptor.label);
        try {
          const session = options.sessionFor?.(lease.endpoint) ?? options.session ?? sessionFor(lease.endpoint);
          const tab = await session.tabFor(site());
          const text = await tab.ask(body, request.deadline.remainingMs(), request.signal);
          pool.markReachable(lease.endpoint);
          return finish(text);
        } catch (error) {
          const fault = describeBrowserFault(error);
          // Out of time is out of time, whoever's fault it was. Another browser
          // needs a whole turn and there is nothing left to give it.
          if (!fault || request.deadline.remainingMs() <= 0) {
            throw translate(error);
          }
          pool.markUnreachable(lease.endpoint, fault.coolForMs);
          skipped.push({ endpoint: lease.endpoint, reason: fault.reason });
          lastFault = error;
          warnOnce(
            `${id}-skip:${lease.endpoint}:${fault.reason.slice(0, 60)}`,
            `${descriptor.label}: the browser on ${lease.endpoint} could not take this prompt ` +
              `(${fault.reason}). Trying another one, and leaving that browser out for ` +
              `${Math.round(fault.coolForMs / 60_000)} minute(s).`
          );
          continue;
        } finally {
          lease.release();
        }
      }

      // Every browser this site has was tried and none could take it.
      //
      // Reported as the LAST browser's own failure, not as a generic
      // "unavailable". The kind carries real meaning downstream - a usage wall
      // is a 429 that is worth retrying later, a signed-out tab is a 503 that
      // needs a person, and the hybrid router reads the kind to decide whether
      // the other account is worth asking - and flattening every one of them
      // into one kind threw all of that away along with the sentence written
      // for this provider's voice.
      //
      // What IS added is which browsers were tried, because after this change
      // that is the new question: "out of messages" reads as a fact about the
      // site until you know that three separate windows each said it.
      if (skipped.length > 0) {
        const tried =
          skipped.length === 1
            ? `The one ${descriptor.label} browser (${skipped[0].endpoint}) could not take it.`
            : `All ${skipped.length} ${descriptor.label} browsers were tried: ` +
              // Each reason clipped: a turn error is a paragraph of advice, and
              // four run together is a wall nobody reads.
              skipped.map((entry) => `${entry.endpoint} (${clip(entry.reason, 120)})`).join('; ');
        throw withTriedBrowsers(translate(lastFault), tried);
      }

      throw fail('unavailable', `No ${descriptor.label} browser could be reached.`);

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
