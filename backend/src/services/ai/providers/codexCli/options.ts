import path from 'path';
import { cliTimeoutMs } from '../../../../config/operational';

/**
 * Environment-driven configuration for the Codex CLI provider.
 *
 * Every variable uses the `AI_CODEX_` prefix, mirroring `AI_CLI_` on the Claude
 * side, and for the same reason: `buildCodexChildEnv` scrubs the child's
 * environment, so settings of our own must not be confusable with the variables
 * being scrubbed.
 */

/**
 * The model name that means "whatever the CLI is configured to use".
 *
 * Codex resolves its model catalog from the signed-in account at runtime, so
 * there is no static list this app could seed and no id it could hard-code that
 * is true for every account. The seeded record uses this sentinel and the argv
 * builder simply omits `-m`, which works on any account; a specific model is a
 * record an administrator adds under Admin -> Models.
 */
export const CODEX_DEFAULT_MODEL = 'default';

export type CodexCliConfig = {
  binary: string;
  model: string;
  concurrency: number;
  queueWaitMs: number;
  firstEventMs: number;
  defaultTimeoutMs: number;
  timeoutMsByCallSite: Record<string, number>;
  workdir: string;
  maxOutputBytes: number;
};

function flag(name: string, fallback = ''): string {
  return (process.env[name] ?? '').trim() || fallback;
}

function intFlag(name: string, fallback: number, min: number, max: number): number {
  const raw = Number.parseInt((process.env[name] ?? '').trim(), 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

/**
 * A fixed, empty working directory, like the Claude provider's.
 *
 * Codex reads project files and per-project state from wherever it is run, and
 * `--cd` is how it is told. An empty directory of our own means a turn cannot
 * pick up a stray AGENTS.md, a git repo, or anything else that would silently
 * steer an answer that is supposed to depend only on the prompt.
 */
function defaultWorkdir(): string {
  const dbDir = (process.env.DB_DIR ?? '').trim();
  if (dbDir) return path.join(path.resolve(dbDir), 'codex-cli-work');
  return path.join(process.cwd(), '.codex-cli-work');
}

export function readCodexCliConfig(): CodexCliConfig {
  // Read by operational.ts's reader, like the Claude seat's: the startup
  // warning about a budget the request deadline caps has to read it this way.
  const defaultTimeoutMs = cliTimeoutMs('AI_CODEX_TIMEOUT_MS');

  return {
    binary: flag('AI_CODEX_BIN', 'codex'),
    model: flag('AI_CODEX_MODEL', CODEX_DEFAULT_MODEL),
    concurrency: intFlag('AI_CODEX_CONCURRENCY', 4, 1, 32),
    queueWaitMs: intFlag('AI_CODEX_QUEUE_WAIT_MS', 600_000, 1_000, 3_600_000),
    /*
     * Longer than the Claude side's 30s, and measured rather than guessed.
     *
     * A real run of `codex exec --json` emits `thread.started` immediately and
     * then, on a flaky network, reconnects up to five times before falling back
     * from WebSockets to HTTPS. Those reconnects arrive as events, so the stall
     * timer is reset by them - but the first event can still be slow to appear
     * on a cold start, and cutting a turn off there would report a stall where
     * the truth is a slow connect.
     */
    firstEventMs: intFlag('AI_CODEX_FIRST_EVENT_MS', 60_000, 1_000, 300_000),
    defaultTimeoutMs,
    timeoutMsByCallSite: {
      'tailor-resume': cliTimeoutMs('AI_CODEX_TIMEOUT_MS_TAILOR'),
      'filter-google-sheet-job': cliTimeoutMs('AI_CODEX_TIMEOUT_MS_FILTER'),
    },
    workdir: flag('AI_CODEX_WORKDIR') || defaultWorkdir(),
    maxOutputBytes: intFlag('AI_CODEX_MAX_OUTPUT_BYTES', 8_000_000, 100_000, 64_000_000),
  };
}

export function resolveCodexTimeoutMs(config: CodexCliConfig, callSite: string): number {
  return config.timeoutMsByCallSite[callSite] ?? config.defaultTimeoutMs;
}
