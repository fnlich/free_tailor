import crypto from 'crypto';
import fs from 'fs';

import { getProviderLabel } from '../../../../config/providerCatalog';
import type { AIProvider } from '../../../../types/template';
import { AIProviderError, asAIProviderError, type AIErrorKind } from '../../errors';
import { acquireSlot, getProviderSemaphore } from '../../concurrency';
import { JSON_BEGIN_SENTINEL, JSON_END_SENTINEL } from '../../jsonSentinels';
import { warnOnce } from '../../telemetry';
import type {
  AIProviderAdapter,
  CompletionRequest,
  CompletionResult,
  DroppedParam,
  HealthOptions,
  ProviderCapabilities,
  ProviderHealth,
  ProviderInstanceSpec,
  ProviderReadiness,
} from '../../types';
import { createSpawnRunner, type CliRunner } from '../cli/runner';
import { describeInstance, instanceWorkdir } from '../cli/instance';
import {
  buildGeminiArgv,
  escapeAtReferences,
  GEMINI_BASE_SYSTEM_PROMPT,
  guardGeminiPrompt,
  MAX_GEMINI_STDIN_BYTES,
  resolveGeminiModel,
  restoreEscapedAt,
} from './argv';
import { classifyGeminiFailure, cleanStderr, GeminiOutageTable, PAID_CREDITS } from './classify';
import { buildGeminiChildEnv, resolveGeminiHome } from './env';
import {
  createGeminiEventReducer,
  createGeminiTurnState,
  describeGeminiFailure,
  readGeminiTurnText,
} from './events';
import {
  checkGeminiCliHealth,
  GEMINI_INSTALL_ACTION,
  GEMINI_SIGN_IN_ACTION,
  hasStoredGeminiSignIn,
  type GeminiCliHealth,
} from './health';
import { GEMINI_CLI_BINARY_HINTS } from './hints';
import { readGeminiCliConfig, resolveGeminiTimeoutMs, type GeminiCliConfig } from './options';
import {
  closeGeminiTurn,
  GeminiWorkspaceError,
  openGeminiTurn,
  prepareGeminiWorkspace,
  removeGeminiSessionTranscript,
  type GeminiWorkspace,
} from './workspace';

const PROVIDER_ID = 'gemini-cli' satisfies AIProvider;

/**
 * Whether the LAST begin sentinel has no end sentinel after it - the same
 * "last begin, first end after it" reading the extractor takes, so a model
 * that quotes the instruction before obeying it is judged by its real answer.
 */
function openedSentinelNeverClosed(text: string): boolean {
  const begin = text.lastIndexOf(JSON_BEGIN_SENTINEL);
  if (begin === -1) return false;
  return !text.includes(JSON_END_SENTINEL, begin + JSON_BEGIN_SENTINEL.length);
}

export type GeminiCliAdapterOptions = {
  /** Injected in tests so the suite never spawns a process. */
  runner?: CliRunner;
  config?: Partial<GeminiCliConfig>;
  now?: () => number;
  /** Injected in tests so `gemini --version` is never executed. */
  healthCheck?: (options: { binary: string; env: NodeJS.ProcessEnv }) => Promise<GeminiCliHealth>;
  /**
   * Which Gemini PROVIDER this adapter is (config/aiProviders.ts): its
   * GEMINI_CLI_HOME, binary and limit, and - for one an administrator added -
   * a workspace and state directory of its own. Absent, it is the built-in
   * one as `.env` configures it. `config` still wins over it, for the tests.
   */
  instance?: ProviderInstanceSpec;
};

export type GeminiCliAdapter = AIProviderAdapter & {
  /** Live holds on the seat or a model, for the admin health card. */
  outages(): Array<{ scope: string; reason: string; expiresAt: string }>;
};

/**
 * Runs completions through the locally installed `gemini` binary, on the
 * operator's Google sign-in rather than an API key.
 *
 * One process per call, like the other two seats, with the same discipline
 * around the spawn - a bounded queue, a stall timer, an outage table, and no
 * partial answer ever returned as an answer. What is particular to this CLI:
 *
 *   - It is locked down by FILES as much as by flags: a workspace settings file
 *     that allows only the Google sign-in and registers no tools, a deny-all
 *     policy, an empty `.env` (workspace.ts), and an environment in which every
 *     key, Vertex and gateway variable is pinned empty (env.ts).
 *   - The system prompt goes through a per-turn file (GEMINI_SYSTEM_MD), the
 *     prompt on stdin, and nothing but flags in argv - so there is no command
 *     line budget to manage, on Windows or anywhere else.
 *   - Exit code 0 is not success; only a result with `status: "success"` is.
 *   - Each turn leaves a transcript of the conversation in the sign-in's home
 *     directory, which is deleted when the turn ends.
 */
export function createGeminiCliAdapter(options: GeminiCliAdapterOptions = {}): GeminiCliAdapter {
  const instance = options.instance;
  const base = readGeminiCliConfig();
  const config: GeminiCliConfig = {
    ...base,
    ...(instance
      ? {
          binary: instance.binaryPath,
          concurrency: instance.concurrency,
          // The provider's own sign-in home - or, for the built-in left unset,
          // AI_GEMINI_HOME as this seat always read it (null inherits).
          home: instance.homeDir ?? base.home,
          // One workspace and one state directory per provider: the CLI
          // registers its workspace in the HOME's projects.json and keeps the
          // turn's transcript there, so two homes never share one.
          workdir: instanceWorkdir(base.workdir, instance),
          stateDir: instanceWorkdir(base.stateDir, instance),
        }
      : {}),
    ...options.config,
  };
  const providerId = instance?.id ?? PROVIDER_ID;
  const now = options.now ?? Date.now;
  const runner = options.runner ?? createSpawnRunner();
  const seatName = instance && !instance.builtIn ? `the Gemini provider "${instance.label}"` : 'the Gemini seat';
  const outages = new GeminiOutageTable(now, seatName);
  // Keyed by PROVIDER: two Gemini providers are two limits (owner decision P2).
  const semaphore = getProviderSemaphore(providerId, config.concurrency);
  const signInAction = instance && !instance.builtIn && config.home
    ? `Run \`GEMINI_CLI_HOME=${config.home} NO_BROWSER=true gemini\` once, interactively, as the user this ` +
      'server runs as: choose "Sign in with Google", open the URL it prints in any browser and paste the code back.'
    : GEMINI_SIGN_IN_ACTION;

  let workspace: GeminiWorkspace | null = null;
  let cachedHealth: { value: GeminiCliHealth; at: number } | null = null;

  const capabilities: ProviderCapabilities = {
    id: PROVIDER_ID,
    label: getProviderLabel(PROVIDER_ID),
    // No sampling flag of any kind: sampling comes from the CLI's own model
    // configs. Saying so lets the facade report the loss once per call site.
    temperature: false,
    maxOutputTokens: false,
    // And no JSON mode or schema flag, so the facade asks for JSON in words and
    // the extractor finds it by its sentinels.
    nativeJsonMode: 'none',
    // GEMINI_SYSTEM_MD replaces the system prompt outright, so instructions get
    // a channel of their own instead of being folded into the user turn.
    systemBlocks: true,
    maxConcurrency: config.concurrency,
  };

  function fail(
    kind: AIErrorKind,
    detail: string,
    extra: Partial<{ retryAfterSeconds: number; adminAction: string }> = {}
  ): AIProviderError {
    return new AIProviderError({ provider: PROVIDER_ID, kind, detail: describeInstance(instance, detail), ...extra });
  }

  /** The child's environment, minus what only a turn has. */
  function baseEnv(): NodeJS.ProcessEnv {
    return buildGeminiChildEnv(process.env, { home: config.home });
  }

  async function health(healthOptions: HealthOptions = {}): Promise<ProviderHealth> {
    if (!healthOptions.fresh && cachedHealth && now() - cachedHealth.at < 60_000) return cachedHealth.value;
    const check = options.healthCheck ?? checkGeminiCliHealth;
    try {
      const value = await check({ binary: config.binary, env: baseEnv() });
      cachedHealth = { value, at: now() };
      // A sign-in hold turns away the success that would clear it, so a sign-in
      // written after the hold lifts it instead. By the file's time, not by
      // this check saying "signed in": the check only reads the file, and says
      // that for a revoked token too.
      if (value.loggedIn === true) {
        const signedInAt = credentialsWrittenAt(value.meta?.credentialsFile);
        if (signedInAt !== null) outages.clearAuth(signedInAt);
      }
      return value;
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      };
    }
  }

  /** When the sign-in file the check read was last written, or null. */
  function credentialsWrittenAt(file: unknown): number | null {
    if (typeof file !== 'string' || !file) return null;
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
  }

  function ensureWorkspace(): GeminiWorkspace {
    if (workspace) return workspace;
    try {
      workspace = prepareGeminiWorkspace({
        workdir: config.workdir,
        stateDir: config.stateDir,
        maxAttempts: config.maxAttempts,
        now,
      });
      return workspace;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw fail('misconfigured', detail, {
        adminAction:
          error instanceof GeminiWorkspaceError
            ? detail
            : 'The Gemini CLI workspace could not be prepared. Check that AI_GEMINI_WORKDIR and ' +
              'AI_GEMINI_STATE_DIR (by default inside DB_DIR) are writable by the user this server runs as.',
      });
    }
  }

  /** Fails fast while the seat, or this model, is known to be out. */
  function throwIfHeld(model: string): void {
    const held = outages.check(model);
    if (held.waitMs <= 0) return;
    const seconds = Math.ceil(held.waitMs / 1000);
    throw fail(held.kind ?? 'rateLimited', `${held.reason}; holding off for about ${seconds}s`, {
      retryAfterSeconds: seconds,
      ...(held.kind === 'auth' ? { adminAction: signInAction } : {}),
    });
  }

  async function complete(request: CompletionRequest): Promise<CompletionResult> {
    const model = resolveGeminiModel(request.modelName, config.model);

    const droppedParams: DroppedParam[] = [];
    if (typeof request.sampling.temperature === 'number') {
      droppedParams.push('temperature');
      warnOnce(
        `gemini-drop-temperature:${request.callSite}`,
        `"${request.callSite}" asks for temperature ${request.sampling.temperature}, but the Gemini CLI ` +
          'exposes no sampling flags. The request runs at the model default.'
      );
    }
    if (typeof request.sampling.maxOutputTokens === 'number') {
      droppedParams.push('maxOutputTokens');
      warnOnce(
        `gemini-drop-maxtokens:${request.callSite}`,
        `"${request.callSite}" asks for a ${request.sampling.maxOutputTokens}-token cap, but the Gemini ` +
          'CLI has no such control.'
      );
    }

    // Known to be out already: turned away in microseconds rather than left to
    // spend its whole budget rediscovering it.
    throwIfHeld(model);

    // Refused before it costs a slot: past this size the CLI cuts the prompt
    // off without a word and the model answers what is left.
    const stdin = guardGeminiPrompt(request.userBody);
    // When that escaped an `@`, the model saw `\@` where the user wrote `@`,
    // and may copy it into its answer; it is taken back out there.
    const escapedAt = escapeAtReferences(request.userBody) !== request.userBody;
    if (Buffer.byteLength(stdin, 'utf8') > MAX_GEMINI_STDIN_BYTES) {
      throw fail(
        'failed',
        `the prompt is ${Buffer.byteLength(stdin, 'utf8')} bytes, over the ${MAX_GEMINI_STDIN_BYTES} the Gemini CLI reads from stdin`
      );
    }

    // The slot is taken INSIDE the caller's deadline, so a request queued behind
    // others cannot wait past its budget invisibly.
    const release = await acquireSlot(semaphore, PROVIDER_ID, request.deadline, config.queueWaitMs, request.signal);

    let turnDir: string | null = null;
    const sessionId = crypto.randomUUID();
    const turnEnv = baseEnv();

    try {
      // Re-checked with the slot in hand: a call that queued may have been
      // passed by one that found the seat out meanwhile.
      throwIfHeld(model);

      const prepared = ensureWorkspace();
      const systemPrompt =
        [request.volatileSystem, request.stableSystem]
          .map((part) => part.trim())
          .filter(Boolean)
          .join('\n\n') || GEMINI_BASE_SYSTEM_PROMPT;
      const turn = openGeminiTurn(prepared, crypto.randomBytes(8).toString('hex'), systemPrompt);
      turnDir = turn.dir;

      const state = createGeminiTurnState();
      const reduce = createGeminiEventReducer(state);
      const startedAt = now();

      const outcome = await runner.run({
        binary: config.binary,
        argv: buildGeminiArgv({ model, policyDir: prepared.policyDir, sessionId }),
        env: buildGeminiChildEnv(process.env, {
          home: config.home,
          systemPromptFile: turn.systemPromptFile,
          tmpDir: turn.tmpDir,
        }),
        cwd: prepared.workdir,
        stdin,
        deadlineMs: Math.max(
          1_000,
          Math.min(request.deadline.remainingMs(), resolveGeminiTimeoutMs(config, request.callSite))
        ),
        firstEventMs: config.firstEventMs,
        maxOutputBytes: config.maxOutputBytes,
        signal: request.signal,
        onLine: (line) => reduce(line),
        binaryHints: GEMINI_CLI_BINARY_HINTS,
      });

      const latencyMs = now() - startedAt;

      if (outcome.spawnError) {
        if (outcome.spawnError.code === 'ENOENT') {
          throw fail('binaryMissing', `spawn ${config.binary}: ${outcome.spawnError.message}`, {
            adminAction: GEMINI_INSTALL_ACTION,
          });
        }
        // The shared runner's overflow message names the Claude CLI; the
        // setting that moves the cap is this provider's own.
        const overflow = /more than (\d+) bytes of output/.exec(outcome.spawnError.message);
        throw fail(
          'failed',
          overflow
            ? `the Gemini CLI wrote more than ${overflow[1]} bytes to stdout (AI_GEMINI_MAX_OUTPUT_BYTES); ` +
                'its stdout repeats the whole prompt before the answer'
            : outcome.spawnError.message
        );
      }
      if (outcome.aborted) throw fail('timeout', 'the request was cancelled before the model answered');
      if (outcome.timedOut) {
        // No partial body, ever: a fragment would fail later, in a JSON parser,
        // looking like a prompt bug.
        throw fail('timeout', `cut off after ${Math.round(latencyMs / 1000)}s`);
      }
      if (outcome.stalled) {
        // The CLI prints its first event only after the OAuth refresh and the
        // Code Assist setup, so silence here is the sign-in or the network
        // hanging - not the model, which has not been asked yet.
        throw fail(
          'stalled',
          `no output at all within ${Math.round(config.firstEventMs / 1000)}s - the sign-in or the network setup hung`
        );
      }

      const stderr = cleanStderr(outcome.stderrTail);

      // Billed to paid AI Credits: refused even when it answered, because that
      // is the one thing this seat exists not to do, and keeping the answer
      // would hide it. Held, so the next calls are not billed the same way.
      if (PAID_CREDITS.test(stderr)) {
        const reason = 'the Gemini CLI billed this call to the account\'s paid AI Credits';
        outages.noteLimit(null, reason);
        throw fail('rateLimited', reason, {
          adminAction:
            'The workspace settings say billing.overageStrategy "never", so something that outranks them - a ' +
            'system settings file (GEMINI_CLI_SYSTEM_SETTINGS_PATH, /etc/gemini-cli) - turned paid credits on. ' +
            'Remove that, or wait for the free quota to reset.',
        });
      }

      // The workspace registers no tools and the policy denies them all, so a
      // tool call means that lockdown did not hold. Nothing the turn produced
      // is trusted.
      if (state.toolUses > 0) {
        throw fail('failed', `the model called ${state.toolUses} tool(s), which this seat's lockdown should make impossible`, {
          adminAction:
            'Check for a system settings file (GEMINI_CLI_SYSTEM_SETTINGS_PATH, /etc/gemini-cli) that re-enables ' +
            'tools, extensions or MCP servers for every workspace.',
        });
      }

      const answered = readGeminiTurnText(state).trim();
      const text = escapedAt ? restoreEscapedAt(answered) : answered;

      if (!state.sawResult || state.status !== 'success') {
        const failure = classifyGeminiFailure({
          exitCode: outcome.exitCode,
          stderrTail: stderr,
          sawResult: state.sawResult,
          status: state.status,
          message: describeGeminiFailure(state),
          // Only a turn with no result can be the sign-in refusing, and only
          // then is the file worth reading.
          credentialsPresent: !state.sawResult && hasStoredGeminiSignIn(turnEnv),
        });
        if (failure.signInUnverified) {
          const signedOut = outages.noteSignInUnverified(failure.detail);
          throw fail(signedOut ? 'auth' : 'unavailable', failure.detail, {
            adminAction: signedOut
              ? signInAction
              : 'Check that this server can reach oauth2.googleapis.com (a proxy, a firewall, DNS). If it keeps ' +
                'happening, the token may have been revoked - then sign in again: ' +
                signInAction,
          });
        }
        if (failure.kind === 'auth') {
          outages.noteAuth(failure.detail);
          throw fail('auth', failure.detail, { adminAction: signInAction });
        }
        if (failure.kind === 'rateLimited') {
          outages.noteLimit(failure.retryAfterSeconds ?? null, failure.detail);
          throw fail('rateLimited', failure.detail, {
            ...(failure.retryAfterSeconds ? { retryAfterSeconds: failure.retryAfterSeconds } : {}),
          });
        }
        if (failure.kind === 'modelUnavailable') {
          outages.noteModelUnavailable(model, failure.detail);
          throw fail('modelUnavailable', failure.detail, {
            adminAction: `The signed-in Google account cannot use model "${model}". Pick another model for this record under Admin -> Models.`,
          });
        }
        if (failure.kind === 'unavailable') {
          outages.noteUnavailable(model, failure.detail);
        }
        throw fail(failure.kind, failure.detail);
      }

      if (!text) {
        throw fail('malformedOutput', 'the model returned an empty response');
      }

      // The envelope reports a response cut off by the output limit as an
      // ordinary success (verified), and names no finish reason once any text
      // arrived. A JSON answer still gives it away: this seat has no JSON mode,
      // so it is always asked to wrap the document in sentinels, and one that
      // opened them and never closed them stopped mid-document. Refused here,
      // as Claude's truncation is, because downstream it does NOT fail: the
      // extractor's balanced scan finds the first complete inner object and
      // returns that fragment as the answer.
      if (request.responseFormat === 'json' && openedSentinelNeverClosed(text)) {
        throw fail(
          'truncated',
          `the answer opened ${JSON_BEGIN_SENTINEL} and never closed it, so it was cut off at the output limit`
        );
      }

      // Said once: a PROSE answer cut short has no such marker, so nothing here
      // can catch one.
      warnOnce(
        'gemini-no-truncation-signal',
        'The Gemini CLI reports a response cut off by the model output limit as a success. A JSON answer ' +
          'that never closes its sentinels is refused as truncated; a text answer cut short cannot be detected.'
      );

      outages.noteSuccess(model);

      return {
        text,
        resolvedModel: state.resolvedModel ?? model,
        providerId: PROVIDER_ID,
        providerInstanceId: providerId,
        ...(state.usage
          ? {
              usage: {
                inputTokens: state.usage.inputTokens,
                outputTokens: state.usage.outputTokens,
                cacheReadTokens: state.usage.cacheReadTokens,
                cacheWriteTokens: 0,
              },
            }
          : {}),
        droppedParams,
        latencyMs,
      };
    } finally {
      release();
      // Best effort, and never fatal: a leftover file is untidy, while throwing
      // here would turn a delivered answer into a failed generation.
      if (turnDir) {
        closeGeminiTurn(turnDir);
        removeGeminiSessionTranscript({
          home: resolveGeminiHome(turnEnv),
          workdir: config.workdir,
          sessionId,
        });
      }
    }
  }

  function readiness(): ProviderReadiness {
    const held = outages.seatHold();
    return {
      // A sign-in kept in encrypted storage reads as ok with loggedIn null:
      // the check cannot see it, and "cannot tell" must not bench a provider.
      ready: cachedHealth ? cachedHealth.value.ok : null,
      held: held ? { kind: held.kind, reason: held.reason, until: new Date(held.until).toISOString() } : null,
    };
  }

  return {
    id: PROVIDER_ID,
    instanceId: providerId,
    capabilities,
    defaultModelName: () => config.model,
    health,
    complete: (request) =>
      complete(request).catch((error) => {
        throw asAIProviderError(error, PROVIDER_ID);
      }),
    readiness,
    outages: () => outages.snapshot(),
  };
}
