import path from 'path';
import { envInt, envString, type EnvIntOptions, type EnvSource } from '../../../../config/envValue';
// Type-only, so nothing is loaded at runtime: config/operational.ts may import
// GEMINI_CLI_SETTINGS from here without the two modules requiring each other.
import type { OperationalVariable } from '../../../../config/operational';

/**
 * Environment-driven configuration for the Gemini CLI provider.
 *
 * Every variable uses the `AI_GEMINI_` prefix, mirroring `AI_CLI_` and
 * `AI_CODEX_`, and for the same reason: `buildGeminiChildEnv` pins or drops a
 * long list of `GEMINI_*` and `GOOGLE_*` variables before spawning the child,
 * so a setting of our own spelled like one of those would be indistinguishable
 * from the scrub list.
 *
 * Unlike the two older seats, every value is read through `config/envValue.ts`:
 * junk warns once and uses the default, out of range clamps and warns, and
 * nothing here can stop the server from starting. There is deliberately NO
 * switch that lets an API key reach the child - this provider exists to run on
 * a Google sign-in, and `env.ts` makes key billing impossible rather than
 * optional.
 *
 * This file is a leaf on purpose (envValue.ts and a type, nothing else), so the
 * operational table, the queue and the batch sizing can import its getters
 * without a cycle back through the adapter.
 */

/**
 * The model every call uses unless the record names another.
 *
 * `auto` is the CLI's own default alias: it resolves per account (preview
 * access, plan) and lets the CLI fall back from Pro to Flash on a transient
 * error. It costs one extra classifier request per turn, which an explicit
 * model skips. Always passed as `--model`, so neither the operator's
 * `settings.model.name` nor a stray `GEMINI_MODEL` decides it.
 */
export const GEMINI_DEFAULT_MODEL = 'auto';

/**
 * The model names this provider will pass to the CLI.
 *
 * The CLI itself forwards ANY `--model` string to the backend, which answers a
 * name it does not serve with a 404 per call. So the shape is checked here,
 * once, and a stale name - an OpenRouter id from an old prompt override, a
 * Claude alias on the wrong provider - degrades to the default with a warning
 * instead (`resolveGeminiModel` in argv.ts). The aliases are the CLI's own
 * (`auto`, `pro`, `flash`, `flash-lite`); concrete ids are `gemini-<version>...`
 * and the experimental `gemma-...` family. Its internal `auto-gemini-*` aliases
 * are left out: they are implementation detail of `auto`.
 */
export const GEMINI_MODEL_NAME = /^(?:auto|pro|flash|flash-lite|gemini-\d[\w.-]*|gemma-[\w.-]+)$/;

export function isGeminiModelName(name: string): boolean {
  return GEMINI_MODEL_NAME.test(name);
}

/** `pro`, `flash` or `flash-lite` for an alias or a concrete id; null for `auto`, gemma and the unknown. */
export function geminiModelFamily(name: string | null | undefined): 'pro' | 'flash' | 'flash-lite' | null {
  const lower = (name ?? '').trim().toLowerCase();
  if (!lower || lower === 'auto' || lower.startsWith('gemma-')) return null;
  if (/(?:^|-)flash-lite(?:-|$)/.test(lower)) return 'flash-lite';
  if (/(?:^|-)flash(?:-|$)/.test(lower)) return 'flash';
  if (/(?:^|-)pro(?:-|$)/.test(lower)) return 'pro';
  return null;
}

/**
 * True when the CLI answered a turn with another family than the one asked
 * for - Pro switched to Flash. Compared by family: a concrete id and its alias
 * are the same model. `auto` asks the CLI to choose, so whatever answered is
 * what was asked for; an unknown name on either side is not a fallback.
 */
export function geminiAnsweredByFallback(requested: string, answered: string | null | undefined): boolean {
  const asked = geminiModelFamily(requested);
  const got = geminiModelFamily(answered);
  return Boolean(asked && got && asked !== got);
}

/**
 * Every whole-number setting's default and bounds, in the shape of
 * `OPERATIONAL_INT_BOUNDS`, so the operational table can take these as they are.
 */
export const GEMINI_CLI_INT_SETTINGS = {
  /*
   * Lower than the other seats' 4. A Google-account seat has per-minute limits
   * on top of its daily quota, and `auto` spends an extra classifier request on
   * every turn, so four at once reaches the per-minute ceiling sooner than it
   * buys throughput. Sizes the adapter's semaphore AND the `gemini` queue lane.
   */
  AI_GEMINI_CONCURRENCY: { fallback: 2, min: 1, max: 32, unit: 'process(es)' },
  AI_GEMINI_QUEUE_WAIT_MS: { fallback: 600_000, min: 1_000, max: 3_600_000, unit: 'ms' },
  /*
   * The stall timer. The CLI prints its first event only after the OAuth token
   * refresh and the Code Assist setup have both been over the network, so this
   * is set like the Codex seat's rather than the Claude seat's 30s.
   */
  AI_GEMINI_FIRST_EVENT_MS: { fallback: 60_000, min: 1_000, max: 300_000, unit: 'ms' },
  // Per-call budgets, capped by AI_REQUEST_TIMEOUT_MS like the other seats'.
  AI_GEMINI_TIMEOUT_MS: { fallback: 180_000, min: 5_000, max: 3_600_000, unit: 'ms' },
  AI_GEMINI_TIMEOUT_MS_TAILOR: { fallback: 300_000, min: 5_000, max: 3_600_000, unit: 'ms' },
  AI_GEMINI_HEALTH_TIMEOUT_MS: { fallback: 15_000, min: 1_000, max: 120_000, unit: 'ms' },
  /*
   * Written into the workspace settings as `general.maxAttempts`, which bounds
   * the CLI's own silent retry loop on 429 and 5xx. Its default is 10 attempts
   * at a 5-30s backoff - minutes of nothing on stdout while a request burns its
   * budget - and the CLI caps the setting at 10.
   */
  AI_GEMINI_MAX_ATTEMPTS: { fallback: 3, min: 1, max: 10, unit: 'attempt(s)' },
  /*
   * Larger than the Codex seat's, because stdout ECHOES the whole prompt once
   * (as the `role: "user"` message) before the answer starts. The floor keeps
   * an ordinary tens-of-kilobytes prompt plus its answer inside the cap.
   */
  AI_GEMINI_MAX_OUTPUT_BYTES: { fallback: 25_000_000, min: 1_000_000, max: 500_000_000, unit: 'bytes' },
} as const satisfies Record<string, EnvIntOptions & { fallback: number }>;

export type GeminiCliIntSetting = keyof typeof GEMINI_CLI_INT_SETTINGS;

function readInt(name: GeminiCliIntSetting, env: EnvSource): number {
  const spec = GEMINI_CLI_INT_SETTINGS[name];
  return envInt(name, spec.fallback, spec, env);
}

/** The binary, `gemini` on PATH by default. */
export function geminiCliBinary(env: EnvSource = process.env): string {
  return envString('AI_GEMINI_BIN', 'gemini', { maxLength: 4_096, expected: 'a path to the gemini binary' }, env);
}

/** The default model, as the record-less calls and `defaultModelName()` see it. */
export function geminiCliModel(env: EnvSource = process.env): string {
  return envString(
    'AI_GEMINI_MODEL',
    GEMINI_DEFAULT_MODEL,
    {
      pattern: GEMINI_MODEL_NAME,
      expected: 'a Gemini CLI model name (auto, pro, flash, flash-lite, gemini-..., gemma-...)',
    },
    env
  );
}

/**
 * Simultaneous `gemini` processes. Exported for the queue lane and the batch
 * fan-out, which must agree with the adapter's own semaphore to the slot.
 */
export function geminiCliConcurrency(env: EnvSource = process.env): number {
  return readInt('AI_GEMINI_CONCURRENCY', env);
}

/** The per-call budgets, keyed by the variable that sets each. */
export const GEMINI_CLI_TIMEOUT_VARIABLES = [
  'AI_GEMINI_TIMEOUT_MS',
  'AI_GEMINI_TIMEOUT_MS_TAILOR',
] as const;

export type GeminiCliTimeoutVariable = (typeof GEMINI_CLI_TIMEOUT_VARIABLES)[number];

/**
 * One per-call budget, in ms. The ONE reader of these two, so a warning about
 * a budget the request deadline caps can read them exactly as the adapter does.
 */
export function geminiCliTimeoutMs(name: GeminiCliTimeoutVariable, env: EnvSource = process.env): number {
  return readInt(name, env);
}

/** Timeout of `gemini --version` in the health check, in ms. */
export function geminiCliHealthTimeoutMs(env: EnvSource = process.env): number {
  return readInt('AI_GEMINI_HEALTH_TIMEOUT_MS', env);
}

/** A directory setting: '' when unset, which means "the default", else absolute. */
function dirSetting(name: string, env: EnvSource): string {
  const value = envString(name, '', { maxLength: 4_096, expected: 'a directory path' }, env);
  return value ? path.resolve(value) : '';
}

/** Where a default directory goes: inside DB_DIR when it is set, else beside the process. */
function besideDatabase(env: EnvSource, inDbDir: string, inCwd: string): string {
  const dbDir = (env.DB_DIR ?? '').trim();
  return dbDir ? path.join(path.resolve(dbDir), inDbDir) : path.join(process.cwd(), inCwd);
}

/**
 * The fixed working directory every turn runs in, and the CLI's "workspace".
 *
 * It must stay EMPTY apart from the `.gemini/` this provider writes into it:
 * the CLI reads any `@path` a prompt names that resolves inside it, and loads a
 * `GEMINI.md` there into the system prompt. Fixed rather than per-turn, because
 * the CLI registers every directory it runs in (projects.json, a history and a
 * tmp folder each), and a fresh one per call would grow that without bound.
 */
export function geminiCliWorkdir(env: EnvSource = process.env): string {
  return dirSetting('AI_GEMINI_WORKDIR', env) || besideDatabase(env, 'gemini-cli-work', '.gemini-cli-work');
}

/**
 * Where the deny-all policy and each turn's system prompt and temp files live.
 *
 * OUTSIDE the workspace, deliberately: the CLI will read a path inside the
 * workspace when a prompt names it with `@`, and the per-turn system prompt and
 * the CLI's error dumps (which hold the full conversation) do not belong where
 * that can reach them.
 */
export function geminiCliStateDir(env: EnvSource = process.env): string {
  return dirSetting('AI_GEMINI_STATE_DIR', env) || besideDatabase(env, 'gemini-cli-state', '.gemini-cli-state');
}

/**
 * A dedicated sign-in home, passed to the child as GEMINI_CLI_HOME (the parent
 * of `.gemini`, not `.gemini` itself). Null inherits GEMINI_CLI_HOME or the
 * user's home.
 *
 * The one way to keep an operator's personal `~/.gemini/GEMINI.md` out of every
 * prompt: the CLI appends that global memory file to the system prompt whatever
 * GEMINI_SYSTEM_MD says, and no setting or flag turns it off.
 */
export function geminiCliHome(env: EnvSource = process.env): string | null {
  return dirSetting('AI_GEMINI_HOME', env) || null;
}

export type GeminiCliConfig = {
  binary: string;
  model: string;
  concurrency: number;
  queueWaitMs: number;
  firstEventMs: number;
  defaultTimeoutMs: number;
  /** Per-call-site overrides; the tailor call is far longer than the rest. */
  timeoutMsByCallSite: Record<string, number>;
  maxAttempts: number;
  maxOutputBytes: number;
  workdir: string;
  stateDir: string;
  /** AI_GEMINI_HOME, resolved; null to inherit GEMINI_CLI_HOME or the user's home. */
  home: string | null;
};

/** Read once, when the adapter is built - the same as the other two seats. */
export function readGeminiCliConfig(env: EnvSource = process.env): GeminiCliConfig {
  return {
    binary: geminiCliBinary(env),
    model: geminiCliModel(env),
    concurrency: geminiCliConcurrency(env),
    queueWaitMs: readInt('AI_GEMINI_QUEUE_WAIT_MS', env),
    firstEventMs: readInt('AI_GEMINI_FIRST_EVENT_MS', env),
    defaultTimeoutMs: geminiCliTimeoutMs('AI_GEMINI_TIMEOUT_MS', env),
    timeoutMsByCallSite: {
      'tailor-resume': geminiCliTimeoutMs('AI_GEMINI_TIMEOUT_MS_TAILOR', env),
    },
    maxAttempts: readInt('AI_GEMINI_MAX_ATTEMPTS', env),
    maxOutputBytes: readInt('AI_GEMINI_MAX_OUTPUT_BYTES', env),
    workdir: geminiCliWorkdir(env),
    stateDir: geminiCliStateDir(env),
    home: geminiCliHome(env),
  };
}

export function resolveGeminiTimeoutMs(config: GeminiCliConfig, callSite: string): number {
  return config.timeoutMsByCallSite[callSite] ?? config.defaultTimeoutMs;
}

/* ================================================================== table */

const READ_IN = 'services/ai/providers/geminiCli/options.ts';

function intSetting(
  name: GeminiCliIntSetting,
  readAt: OperationalVariable['readAt'],
  readIn: string
): OperationalVariable {
  const spec = GEMINI_CLI_INT_SETTINGS[name];
  return {
    name,
    defaultValue: String(spec.fallback),
    bounds: { min: spec.min, max: spec.max },
    side: 'backend',
    readAt,
    readIn,
    current: (env) => String(readInt(name, env)),
  };
}

/**
 * Every AI_GEMINI_* setting as an operational-table entry: name, the default
 * `.env.example` shows, bounds, when it is read and where, and the getter the
 * startup line uses.
 *
 * Read once when the adapter is built - the first health check or call, which
 * is boot for an unlocked seat - except the health timeout, which each check
 * reads. The three directories default to '' ("unset"), because their real
 * default depends on DB_DIR.
 */
export const GEMINI_CLI_SETTINGS: readonly OperationalVariable[] = [
  {
    name: 'AI_GEMINI_BIN',
    defaultValue: 'gemini',
    side: 'backend',
    readAt: 'startup',
    readIn: READ_IN,
    current: geminiCliBinary,
  },
  {
    name: 'AI_GEMINI_MODEL',
    defaultValue: GEMINI_DEFAULT_MODEL,
    side: 'backend',
    readAt: 'startup',
    readIn: READ_IN,
    current: geminiCliModel,
  },
  intSetting(
    'AI_GEMINI_CONCURRENCY',
    'startup',
    `${READ_IN} (the adapter's semaphore and the gemini queue lane)`
  ),
  intSetting('AI_GEMINI_QUEUE_WAIT_MS', 'startup', READ_IN),
  intSetting('AI_GEMINI_FIRST_EVENT_MS', 'startup', READ_IN),
  intSetting('AI_GEMINI_TIMEOUT_MS', 'startup', READ_IN),
  intSetting('AI_GEMINI_TIMEOUT_MS_TAILOR', 'startup', READ_IN),
  intSetting('AI_GEMINI_HEALTH_TIMEOUT_MS', 'per-call', 'services/ai/providers/geminiCli/health.ts'),
  intSetting(
    'AI_GEMINI_MAX_ATTEMPTS',
    'startup',
    'services/ai/providers/geminiCli/workspace.ts (the workspace settings.json)'
  ),
  intSetting('AI_GEMINI_MAX_OUTPUT_BYTES', 'startup', READ_IN),
  {
    name: 'AI_GEMINI_WORKDIR',
    defaultValue: '',
    side: 'backend',
    readAt: 'startup',
    readIn: READ_IN,
    current: (env) => dirSetting('AI_GEMINI_WORKDIR', env),
  },
  {
    name: 'AI_GEMINI_STATE_DIR',
    defaultValue: '',
    side: 'backend',
    readAt: 'startup',
    readIn: READ_IN,
    current: (env) => dirSetting('AI_GEMINI_STATE_DIR', env),
  },
  {
    name: 'AI_GEMINI_HOME',
    defaultValue: '',
    side: 'backend',
    readAt: 'startup',
    readIn: `${READ_IN} -> env.ts (GEMINI_CLI_HOME)`,
    current: (env) => geminiCliHome(env) ?? '',
  },
];
