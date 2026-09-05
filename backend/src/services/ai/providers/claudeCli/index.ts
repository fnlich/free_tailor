import { getProviderDescriptor } from '../../../../config/providerCatalog';
import { AIProviderError, asAIProviderError, type AIErrorKind } from '../../errors';
import { acquireSlot, getProviderSemaphore } from '../../concurrency';
import { warnOnce } from '../../telemetry';
import type {
  AIProviderAdapter,
  CompletionRequest,
  CompletionResult,
  DroppedParam,
  ProviderCapabilities,
  ProviderHealth,
} from '../../types';
import { buildClaudeArgv, resolveCliModel } from './argv';
import { buildChildEnv } from './env';
import { createEventReducer, createTurnState, readTurnText } from './events';
import { classifyCliFailure } from './classify';
import { checkClaudeCliHealth, type ClaudeCliHealth } from './health';
import { interpretRateLimitEvent, OutageTable } from './limits';
import { readClaudeCliConfig, resolveTimeoutMs, type ClaudeCliConfig } from './options';
import { createSpawnRunner, ensureCliWorkdir, type CliRunner } from './runner';

const PROVIDER_ID = 'claude-cli' as const;

export type ClaudeCliAdapterOptions = {
  /** Injected in tests so the suite never spawns a process. */
  runner?: CliRunner;
  config?: Partial<ClaudeCliConfig>;
  now?: () => number;
  /** Injected in tests so `claude auth status` is never executed. */
  healthCheck?: (options: { binary: string; env: NodeJS.ProcessEnv }) => Promise<ClaudeCliHealth>;
};

export type ClaudeCliAdapter = AIProviderAdapter & {
  /** Live outage entries, for the admin health card. */
  outages(): Array<{ scope: string; reason: string; expiresAt: string }>;
  /** Latest usage-window readings the CLI reported, for the admin health card. */
  seatUsage(): { utilization: number | null; resetsAt: string | null; observedAt: string | null };
};

/**
 * Runs completions through the locally installed `claude` binary, on the
 * operator's subscription seat rather than a metered API key.
 *
 * One process per call. A warm pool was measured and rejected - see the note at
 * the bottom of runner.ts - so everything that makes this reliable lives in the
 * discipline around the spawn: a bounded queue, a stall timer, an outage table,
 * and a strict rule that a partial answer is never returned as an answer.
 */
export function createClaudeCliAdapter(options: ClaudeCliAdapterOptions = {}): ClaudeCliAdapter {
  const config: ClaudeCliConfig = { ...readClaudeCliConfig(), ...options.config };
  const now = options.now ?? Date.now;
  const runner = options.runner ?? createSpawnRunner();
  const outages = new OutageTable(now, config.recoverySeconds * 1000);
  const semaphore = getProviderSemaphore(PROVIDER_ID, config.concurrency);
  const descriptor = getProviderDescriptor(PROVIDER_ID);

  let workdirReady = false;
  let cachedHealth: { value: ClaudeCliHealth; at: number } | null = null;
  let seat: { utilization: number | null; resetsAt: string | null; observedAt: string | null } = {
    utilization: null,
    resetsAt: null,
    observedAt: null,
  };

  const capabilities: ProviderCapabilities = {
    id: PROVIDER_ID,
    label: descriptor.label,
    // The CLI exposes no --temperature, --top-p or --max-tokens flag. Saying so
    // in the capabilities is what lets the facade report the loss once per
    // call site instead of silently dropping it on every call.
    temperature: false,
    maxOutputTokens: false,
    nativeJsonMode: 'json-schema',
    systemBlocks: true,
    requiresApiKey: false,
    credentialKind: 'subscription-seat',
    maxConcurrency: config.concurrency,
  };

  function fail(kind: AIErrorKind, detail: string, extra: Partial<{ retryAfterSeconds: number; adminAction: string }> = {}): AIProviderError {
    return new AIProviderError({ provider: PROVIDER_ID, kind, detail, ...extra });
  }

  async function health(): Promise<ProviderHealth> {
    if (cachedHealth && now() - cachedHealth.at < 60_000) {
      return cachedHealth.value;
    }
    const check = options.healthCheck ?? checkClaudeCliHealth;
    try {
      const value = await check({
        binary: config.binary,
        env: buildChildEnv(process.env, { allowApiKey: config.allowApiKey }),
      });
      cachedHealth = { value, at: now() };
      return value;
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      };
    }
  }

  async function complete(request: CompletionRequest): Promise<CompletionResult> {
    const model = resolveCliModel(request.modelName, config.model);

    const droppedParams: DroppedParam[] = [];
    if (typeof request.sampling.temperature === 'number') {
      droppedParams.push('temperature');
      warnOnce(
        `cli-drop-temperature:${request.callSite}`,
        `"${request.callSite}" asks for temperature ${request.sampling.temperature}, but the Claude CLI ` +
          'exposes no sampling flags. The request runs at the model default.'
      );
    }
    if (typeof request.sampling.maxOutputTokens === 'number') {
      droppedParams.push('maxOutputTokens');
      warnOnce(
        `cli-drop-maxtokens:${request.callSite}`,
        `"${request.callSite}" asks for a ${request.sampling.maxOutputTokens}-token output cap, but the ` +
          'Claude CLI exposes no such flag. A response cut off by the model limit is detected and ' +
          'reported instead of being returned half-written.'
      );
    }

    // Known to be out already: turn this call away in microseconds rather than
    // let it spend its whole budget rediscovering the same fact.
    const known = outages.check(model);
    if (known.waitMs > 0) {
      throw fail(
        known.reason.includes('signed in') ? 'auth' : 'rateLimited',
        `${known.reason}; retrying in about ${Math.ceil(known.waitMs / 60_000)} minute(s)`,
        { retryAfterSeconds: Math.ceil(known.waitMs / 1000) }
      );
    }

    // The slot is taken INSIDE the caller's deadline. Acquired outside one, a
    // request queued behind others waits with no bound and the wait is
    // invisible to every clock above.
    const release = await acquireSlot(semaphore, PROVIDER_ID, request.deadline, config.queueWaitMs, request.signal);

    try {
      // Re-checked with the slot in hand: a call that queued may have been
      // passed by another that marked this model out meanwhile.
      const stillOut = outages.check(model);
      if (stillOut.waitMs > 0) {
        throw fail('rateLimited', stillOut.reason, {
          retryAfterSeconds: Math.ceil(stillOut.waitMs / 1000),
        });
      }

      if (!workdirReady) {
        ensureCliWorkdir(config.workdir);
        workdirReady = true;
      }

      const systemPrompt = [request.volatileSystem, request.stableSystem]
        .map((part) => part.trim())
        .filter(Boolean)
        .join('\n\n');

      const invocation = buildClaudeArgv({
        model,
        effort: request.effort ?? config.effort,
        systemPrompt,
        jsonSchema: request.jsonSchema,
        fallbackModels: config.fallbackModels,
        maxBudgetUsd: config.maxBudgetUsd,
      });

      const stdin = invocation.systemPromptOverflow
        ? `${invocation.systemPromptOverflow}\n\n${request.userBody}`
        : request.userBody;

      const state = createTurnState();
      const startedAt = now();
      const reduce = createEventReducer(state);

      const outcome = await runner.run({
        binary: config.binary,
        argv: invocation.argv,
        env: buildChildEnv(process.env, { allowApiKey: config.allowApiKey }),
        cwd: config.workdir,
        stdin,
        deadlineMs: Math.max(1_000, Math.min(request.deadline.remainingMs(), resolveTimeoutMs(config, request.callSite))),
        firstEventMs: config.firstEventMs,
        maxOutputBytes: config.maxOutputBytes,
        signal: request.signal,
        onLine: (line) => reduce(line, now() - startedAt),
      });

      const latencyMs = now() - startedAt;

      if (outcome.spawnError) {
        if (outcome.spawnError.code === 'ENOENT') {
          throw fail('binaryMissing', `spawn ${config.binary}: ${outcome.spawnError.message}`, {
            adminAction:
              'Install Claude Code (npm i -g @anthropic-ai/claude-code), run `claude auth login` as the user this server runs as, or point AI_CLI_BIN at the binary.',
          });
        }
        throw fail('failed', outcome.spawnError.message);
      }

      if (outcome.aborted) {
        throw fail('timeout', 'the request was cancelled before the model answered');
      }

      if (outcome.stalled) {
        // At the seat's usage limit the CLI blocks rather than failing, so a
        // turn that produced no event at all is far more likely to be a spent
        // window than a slow model. Holding the seat briefly turns the next
        // hundred requests into instant, explicable failures.
        outages.noteLimit('*', null, 'the CLI produced no output at all, which is what a spent usage window looks like');
        throw fail(
          'stalled',
          `no output at all within ${Math.round(config.firstEventMs / 1000)}s`
        );
      }

      const rate = interpretRateLimitEvent(state.rateLimit, { allowOverage: config.allowOverage });
      if (rate.utilization !== null) {
        seat = {
          utilization: rate.utilization,
          resetsAt: rate.resetsAt ? new Date(rate.resetsAt * 1000).toISOString() : null,
          observedAt: new Date(now()).toISOString(),
        };
      }

      const text = readTurnText(state).trim();

      // A limit is always recorded, so the next call is turned away instantly
      // rather than spending its whole budget rediscovering it.
      if (rate.limited) {
        outages.noteLimit(rate.scope, rate.resetsAt, rate.reason);
      }
      // But it only FAILS this turn when there is no answer, or when the answer
      // was billed as paid overage - which is the case this provider exists to
      // prevent, and which silently keeping the answer would hide.
      if (rate.limited && (!text || rate.refuseEvenWithText)) {
        const retryAfterSeconds = rate.resetsAt
          ? Math.max(1, Math.ceil(rate.resetsAt - now() / 1000))
          : undefined;
        throw fail('rateLimited', rate.reason, { retryAfterSeconds });
      }

      // A key reaching the child means this call is billed per token, which is
      // the exact failure this provider exists to prevent - and it is
      // otherwise completely invisible. Free to assert, so assert it.
      if (state.apiKeySource && state.apiKeySource !== 'none' && !config.allowApiKey) {
        // Held as an outage too. Failing only this call leaves the operator
        // free to retry straight into another billed request; every call until
        // the environment is fixed would be metered.
        outages.noteAuth(`the CLI is authenticating with ${state.apiKeySource}, not the subscription`);
        throw fail(
          'auth',
          `the CLI reported apiKeySource="${state.apiKeySource}", so this call was billed per token rather than run on the subscription`,
          {
            adminAction:
              'An ANTHROPIC_API_KEY reached the claude subprocess. Remove it from the server environment, or set AI_CLI_ALLOW_API_KEY=1 to accept metered billing deliberately.',
          }
        );
      }

      // Only consulted when something actually says the turn failed. Run on
      // every turn it would read stderr from a SUCCESSFUL call - where a
      // benign warning containing "timed out" or a bare "ETIMEDOUT" would be
      // classified as a service failure and throw away a good answer.
      const looksFailed = state.isError || (outcome.exitCode !== null && outcome.exitCode !== 0) || !text;
      const kind = looksFailed
        ? classifyCliFailure({
            apiErrorStatus: state.apiErrorStatus,
            isError: state.isError,
            exitCode: outcome.exitCode,
            stderrTail: outcome.stderrTail,
            resultText: state.resultText ?? '',
            errors: state.errors,
          })
        : null;

      // A classified failure fails the turn whether or not text arrived. Text
      // that arrived and was then cut off by an error is a fragment of a reply,
      // not a reply, and returning it would surface the failure later as a
      // parse error pointing at the prompt.
      if (kind) {
        const detail =
          (state.isError ? state.resultText : '') || outcome.stderrTail || `exit ${outcome.exitCode ?? 'unknown'}`;
        if (kind === 'auth') {
          outages.noteAuth(detail);
        } else if (kind === 'rateLimited') {
          outages.noteLimit('*', rate.resetsAt, detail);
        } else if (kind === 'unavailable' || kind === 'modelUnavailable') {
          outages.noteUnavailable(model, detail);
        }
        throw fail(kind, detail);
      }

      if (outcome.timedOut) {
        // Deliberately no partial body. Every JSON caller runs the answer
        // through extractJSON, which will happily find a balanced sub-object
        // inside a truncated document - so a fragment does not fail here, it
        // fails later, in a parser, looking like a prompt bug.
        throw fail(
          'timeout',
          text
            ? `cut off after ${Math.round(latencyMs / 1000)}s with ${text.length} character(s) written`
            : `cut off after ${Math.round(latencyMs / 1000)}s before any text arrived`
        );
      }

      if (state.stopReason === 'max_tokens') {
        throw fail('truncated', 'the model reached its output limit before finishing');
      }

      if (!text) {
        throw fail(
          'malformedOutput',
          state.sawResult
            ? 'the model returned an empty response'
            : `the CLI exited (${outcome.exitCode ?? 'no code'}) without producing a result: ${outcome.stderrTail || 'no diagnostic'}`
        );
      }

      if (state.stopReason === null && !state.sawResult) {
        warnOnce(
          'no-stop-reason',
          'The Claude CLI did not report a stop reason for a completed turn, so a response cut off by ' +
            'the model output limit cannot be detected. Downstream JSON parsing is the remaining guard.'
        );
      }

      // Not on a turn that reported a limit. noteSuccess clears both the model
      // entry and the seat-wide one, so calling it here would delete the hold
      // this same call just recorded and let every following request
      // rediscover the limit the hard way.
      if (!rate.limited) {
        outages.noteSuccess(model);
      }

      return {
        text,
        resolvedModel: state.model ?? model,
        providerId: PROVIDER_ID,
        usage: state.usage,
        costUsd: state.costUsd,
        droppedParams,
        latencyMs,
      };
    } finally {
      release();
    }
  }

  return {
    id: PROVIDER_ID,
    capabilities,
    defaultModelName: () => config.model,
    health,
    complete: (request) =>
      complete(request).catch((error) => {
        throw asAIProviderError(error, PROVIDER_ID);
      }),
    outages: () => outages.snapshot(),
    seatUsage: () => ({ ...seat }),
  };
}
