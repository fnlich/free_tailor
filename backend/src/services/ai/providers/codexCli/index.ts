import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { getProviderDescriptor } from '../../../../config/providerCatalog';
import { AIProviderError, type AIErrorKind } from '../../errors';
import { acquireSlot, getProviderSemaphore } from '../../concurrency';
import { warnOnce } from '../../telemetry';
import type {
  AIProviderAdapter,
  CompletionRequest,
  CompletionResult,
  DroppedParam,
  HealthOptions,
  ProviderCapabilities,
  ProviderHealth,
} from '../../types';
import { createSpawnRunner, ensureCliWorkdir, type CliRunner } from '../cli/runner';
import { buildCodexArgv, CODEX_CLI_BINARY_HINTS } from './argv';
import { buildCodexChildEnv } from './env';
import {
  createCodexEventReducer,
  createCodexTurnState,
  describeCodexFailure,
  readCodexTurnText,
} from './events';
import { checkCodexCliHealth, type CodexCliHealth } from './health';
import { readCodexCliConfig, resolveCodexTimeoutMs, type CodexCliConfig } from './options';

const PROVIDER_ID = 'codex-cli' as const;

export type CodexCliAdapterOptions = {
  /** Injected in tests so the suite never spawns a process. */
  runner?: CliRunner;
  config?: Partial<CodexCliConfig>;
  now?: () => number;
  /** Injected in tests so `codex login status` is never executed. */
  healthCheck?: (options: { binary: string; env: NodeJS.ProcessEnv }) => Promise<CodexCliHealth>;
  /** Injected in tests, which have no real CLI to write the answer file. */
  readAnswerFile?: (file: string) => string;
};

export type CodexCliAdapter = AIProviderAdapter;

/**
 * Runs completions through the locally installed `codex` binary, on the
 * operator's ChatGPT subscription rather than a metered API key.
 *
 * The answer comes from the file named by `--output-last-message`, not from the
 * event stream. That is deliberate and it is what makes this provider robust:
 * the JSONL envelope is a moving target on a CLI that ships often, while "write
 * the final message here" is a stable contract. Events supply metadata and, for
 * a turn that produced nothing, the reason.
 *
 * There is no equivalent of the Claude provider's outage table. Modelling quota
 * would mean inventing the shape of a refusal nobody here has seen, and a
 * confidently wrong message at the moment somebody hits a limit is worse than a
 * plain one.
 */
export function createCodexCliAdapter(options: CodexCliAdapterOptions = {}): CodexCliAdapter {
  const config: CodexCliConfig = { ...readCodexCliConfig(), ...options.config };
  const now = options.now ?? Date.now;
  const runner = options.runner ?? createSpawnRunner();
  const semaphore = getProviderSemaphore(PROVIDER_ID, config.concurrency);
  const descriptor = getProviderDescriptor(PROVIDER_ID);
  const readAnswerFile =
    options.readAnswerFile ??
    ((file: string) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        // Absent is not an error here: a turn that failed before answering
        // never writes it, and the events say why.
        return '';
      }
    });

  let workdirReady = false;
  let cachedHealth: { value: CodexCliHealth; at: number } | null = null;
  // One check at a time: when the cache lapses under load, every call waiting
  // on it shares the one `codex login status` rather than each spawning its own.
  let pendingHealth: Promise<ProviderHealth> | null = null;

  const capabilities: ProviderCapabilities = {
    id: PROVIDER_ID,
    label: descriptor.label,
    // `codex exec` exposes no sampling flags at all. Saying so is what lets the
    // facade report the loss once per call site instead of dropping it silently
    // on every call.
    temperature: false,
    maxOutputTokens: false,
    // `--output-schema` takes a FILE, unlike the Claude provider's inline
    // `--json-schema`, but the capability is the same from outside.
    nativeJsonMode: 'json-schema',
    systemBlocks: false,
    maxConcurrency: config.concurrency,
  };

  function fail(
    kind: AIErrorKind,
    detail: string,
    extra: Partial<{ retryAfterSeconds: number; adminAction: string }> = {}
  ): AIProviderError {
    return new AIProviderError({ provider: PROVIDER_ID, kind, detail, ...extra });
  }

  async function checkHealth(): Promise<ProviderHealth> {
    const check = options.healthCheck ?? checkCodexCliHealth;
    try {
      const value = await check({
        binary: config.binary,
        env: buildCodexChildEnv(process.env),
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

  function health(healthOptions: HealthOptions = {}): Promise<ProviderHealth> {
    if (!healthOptions.fresh && cachedHealth && now() - cachedHealth.at < 60_000) {
      return Promise.resolve(cachedHealth.value);
    }
    pendingHealth ??= checkHealth().finally(() => {
      pendingHealth = null;
    });
    return pendingHealth;
  }

  async function complete(request: CompletionRequest): Promise<CompletionResult> {
    const model = request.modelName?.trim() || config.model;

    const droppedParams: DroppedParam[] = [];
    if (typeof request.sampling.temperature === 'number') {
      droppedParams.push('temperature');
      warnOnce(
        `codex-drop-temperature:${request.callSite}`,
        `"${request.callSite}" asks for temperature ${request.sampling.temperature}, but the Codex ` +
          'CLI exposes no sampling flags. The request runs at the model default.'
      );
    }
    if (typeof request.sampling.maxOutputTokens === 'number') {
      droppedParams.push('maxOutputTokens');
      warnOnce(
        `codex-drop-maxtokens:${request.callSite}`,
        `"${request.callSite}" asks for a ${request.sampling.maxOutputTokens}-token cap, but the ` +
          'Codex CLI has no such control.'
      );
    }

    // A key stored in CODEX_HOME (`codex login --with-api-key`, a Bedrock key)
    // is out of the environment strip's reach, and every turn on it bills per
    // token - so asked BEFORE spawning, not discovered after. Cached for a
    // minute, and `codex login status` needs no network and reads the
    // credential wherever it is kept, a keyring included. Only a positive
    // "signed in with a key" refuses: a check that failed or said nothing
    // must not block a working seat.
    const seat = (await health()) as Partial<CodexCliHealth>;
    if (seat.apiKey === true) {
      throw fail(
        'auth',
        'the Codex CLI is signed in with an API key, so this call would be billed per token; it was refused without running',
        {
          adminAction:
            'Run `codex logout`, then `codex login --device-auth` as the user this server runs as and sign in ' +
            'with ChatGPT. Calls are refused until the seat is signed in to a subscription again.',
        }
      );
    }

    if (!workdirReady) {
      ensureCliWorkdir(config.workdir);
      workdirReady = true;
    }

    // One turn, one pair of scratch files, named so two concurrent calls cannot
    // read each other's answer.
    const turnId = crypto.randomBytes(8).toString('hex');
    const answerFile = path.join(config.workdir, `answer-${turnId}.txt`);
    const schemaFile = request.jsonSchema
      ? path.join(config.workdir, `schema-${turnId}.json`)
      : undefined;

    // The caller's deadline bounds the wait as well as the queue's own cap, so
    // a request queued behind others cannot wait invisibly past its budget.
    const release = await acquireSlot(
      semaphore,
      PROVIDER_ID,
      request.deadline,
      config.queueWaitMs,
      request.signal
    );

    try {
      if (schemaFile) fs.writeFileSync(schemaFile, JSON.stringify(request.jsonSchema), 'utf8');

      const argv = buildCodexArgv({
        model,
        lastMessageFile: answerFile,
        cwd: config.workdir,
        outputSchemaFile: schemaFile,
      });

      // `systemBlocks: false`, so the facade has already folded the
      // instructions into the head of the user body. One string on stdin.
      const stdin = request.userBody;

      const state = createCodexTurnState();
      const startedAt = now();
      const reduce = createCodexEventReducer(state);

      const outcome = await runner.run({
        binary: config.binary,
        argv,
        env: buildCodexChildEnv(process.env),
        cwd: config.workdir,
        stdin,
        deadlineMs: Math.max(
          1_000,
          Math.min(request.deadline.remainingMs(), resolveCodexTimeoutMs(config, request.callSite))
        ),
        firstEventMs: config.firstEventMs,
        maxOutputBytes: config.maxOutputBytes,
        signal: request.signal,
        onLine: (line) => reduce(line),
        binaryHints: CODEX_CLI_BINARY_HINTS,
      });

      const latencyMs = now() - startedAt;

      if (outcome.spawnError) {
        if (outcome.spawnError.code === 'ENOENT') {
          throw fail('binaryMissing', `spawn ${config.binary}: ${outcome.spawnError.message}`, {
            adminAction:
              'Install the Codex CLI (npm i -g @openai/codex) and sign in with ' +
              '`codex login --device-auth` as the user this server runs as - it prints a code you ' +
              'approve from any other browser, so the server needs no display. If it IS installed, ' +
              'this process has a different PATH than your shell: set AI_CODEX_BIN to the full path.',
          });
        }
        throw fail('failed', outcome.spawnError.message);
      }
      if (outcome.aborted) throw fail('timeout', 'the request was cancelled before the model answered');
      if (outcome.timedOut) throw fail('timeout', 'the model did not finish within the deadline');
      if (outcome.stalled) {
        throw fail(
          'stalled',
          `no output at all within ${Math.round(config.firstEventMs / 1000)}s`
        );
      }

      // The answer file first, the stream second. They agree in the normal
      // case; when they do not, the file is the CLI's own final word.
      const text = (readAnswerFile(answerFile) || readCodexTurnText(state)).trim();

      if (!text) {
        const reason = describeCodexFailure(state);
        // Signed out is worth naming as such: it is the one failure an operator
        // fixes rather than retries, and the CLI's own wording for it is not
        // obviously about authentication.
        const signedOut = /not\s+logged\s+in|unauthor|401|sign\s*in/i.test(reason);
        throw fail(signedOut ? 'auth' : 'failed', reason, {
          ...(signedOut
            ? {
                adminAction:
                  'Run `codex login --device-auth` as the user this server runs as, then check ' +
                  'Admin -> Settings.',
              }
            : {}),
        });
      }

      return {
        text,
        resolvedModel: model,
        providerId: PROVIDER_ID,
        ...(state.usage
          ? {
              usage: {
                inputTokens: state.usage.inputTokens,
                outputTokens: state.usage.outputTokens,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
            }
          : {}),
        droppedParams,
        latencyMs,
      };
    } finally {
      release();
      // Best effort, and deliberately not fatal: a scratch file left behind is
      // untidy, while throwing here would turn a delivered answer into a failed
      // generation.
      for (const file of [answerFile, schemaFile]) {
        if (!file) continue;
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // ignored on purpose
        }
      }
    }
  }

  return {
    id: PROVIDER_ID,
    capabilities,
    defaultModelName: () => config.model,
    health,
    complete,
  };
}
