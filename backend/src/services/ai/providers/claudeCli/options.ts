import path from 'path';
import { isEffortLevel, type EffortLevel } from '../../types';

/**
 * Environment-driven configuration for the Claude CLI provider.
 *
 * Every variable uses the `AI_CLI_` prefix, NOT `CLAUDE_CLI_`. That is a rule,
 * not a preference: `buildChildEnv` deletes every `CLAUDE_*` variable except
 * `CLAUDE_CONFIG_DIR` before spawning the child, so naming our own settings
 * `CLAUDE_CLI_*` would make the scrub list and the config list visually
 * indistinguishable - and one plausible "why is this missing in the child?"
 * fix would re-open the metered-billing hole the scrub exists to close.
 */

export const DEFAULT_CLI_MODEL = 'sonnet';
export const DEFAULT_CLI_EFFORT: EffortLevel = 'low';

/**
 * Linux caps a SINGLE argv entry at MAX_ARG_STRLEN (128 KiB), independently of
 * the much larger ARG_MAX total. Measured here: a 150 KB `--system-prompt`
 * fails the exec outright with "Argument list too long". Anything longer than
 * this threshold is moved to the head of stdin instead, which has no such cap.
 */
export const MAX_SYSTEM_PROMPT_ARG_BYTES = 60_000;

function flag(name: string, fallback = ''): string {
  return (process.env[name] ?? '').trim() || fallback;
}

function boolFlag(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function intFlag(name: string, fallback: number, min: number, max: number): number {
  const raw = Number.parseInt((process.env[name] ?? '').trim(), 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

export type ClaudeCliConfig = {
  binary: string;
  model: string;
  effort: EffortLevel;
  fallbackModels: string[];
  concurrency: number;
  queueWaitMs: number;
  firstEventMs: number;
  defaultTimeoutMs: number;
  /** Per-call-site overrides; the tailor call is far longer than the rest. */
  timeoutMsByCallSite: Record<string, number>;
  workdir: string;
  allowApiKey: boolean;
  allowOverage: boolean;
  maxOutputBytes: number;
  maxBudgetUsd: number;
  recoverySeconds: number;
};

/**
 * Where the CLI's per-project state accrues.
 *
 * One fixed, empty directory for every call - never a temp dir per call. The
 * CLI keys per-project state on the working directory, so a fresh directory
 * each time leaves a new entry under the config dir for every completion.
 * Empty, so there is no CLAUDE.md or `.claude/` there to be read even if
 * `--safe-mode` were ever dropped.
 */
function defaultWorkdir(): string {
  const dbDir = (process.env.DB_DIR ?? '').trim();
  if (dbDir) {
    return path.join(path.resolve(dbDir), 'claude-cli-work');
  }
  return path.join(process.cwd(), '.claude-cli-work');
}

export function readClaudeCliConfig(): ClaudeCliConfig {
  const effortRaw = flag('AI_CLI_EFFORT', DEFAULT_CLI_EFFORT);
  const effort = isEffortLevel(effortRaw) ? effortRaw : DEFAULT_CLI_EFFORT;
  if (!isEffortLevel(effortRaw)) {
    console.warn(
      `[ai] AI_CLI_EFFORT="${effortRaw}" is not a valid effort level; using "${DEFAULT_CLI_EFFORT}".`
    );
  }

  const defaultTimeoutMs = intFlag('AI_CLI_TIMEOUT_MS', 180_000, 5_000, 3_600_000);

  return {
    binary: flag('AI_CLI_BIN', 'claude'),
    model: flag('AI_CLI_MODEL', DEFAULT_CLI_MODEL),
    effort,
    fallbackModels: flag('AI_CLI_FALLBACK_MODELS', 'haiku')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    concurrency: intFlag('AI_CLI_CONCURRENCY', 4, 1, 32),
    // Long by default so the CALLER'S deadline is what actually bounds the
    // wait (acquireSlot takes the smaller of the two). A short cap here made a
    // batch wider than the concurrency limit fail its queued items after 30s,
    // even though a tailor call is allowed five minutes.
    queueWaitMs: intFlag('AI_CLI_QUEUE_WAIT_MS', 600_000, 1_000, 3_600_000),
    firstEventMs: intFlag('AI_CLI_FIRST_EVENT_MS', 30_000, 1_000, 300_000),
    defaultTimeoutMs,
    timeoutMsByCallSite: {
      'tailor-resume': intFlag('AI_CLI_TIMEOUT_MS_TAILOR', 300_000, 5_000, 3_600_000),
      'filter-google-sheet-job': intFlag('AI_CLI_TIMEOUT_MS_FILTER', 60_000, 5_000, 3_600_000),
    },
    workdir: flag('AI_CLI_WORKDIR', '') || defaultWorkdir(),
    allowApiKey: boolFlag('AI_CLI_ALLOW_API_KEY', false),
    allowOverage: boolFlag('AI_CLI_ALLOW_OVERAGE', false),
    maxOutputBytes: intFlag('AI_CLI_MAX_OUTPUT_BYTES', 25_000_000, 100_000, 500_000_000),
    maxBudgetUsd: Number.parseFloat(flag('AI_CLI_MAX_BUDGET_USD', '0')) || 0,
    recoverySeconds: intFlag('AI_CLI_RECOVERY_S', 600, 30, 86_400),
  };
}

export function resolveTimeoutMs(config: ClaudeCliConfig, callSite: string): number {
  return config.timeoutMsByCallSite[callSite] ?? config.defaultTimeoutMs;
}
