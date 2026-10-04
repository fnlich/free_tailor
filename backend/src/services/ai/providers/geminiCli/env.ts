import os from 'os';

/**
 * The environment a `gemini` child process gets.
 *
 * Unlike the other two seats, deleting the billing variables is not enough
 * here, and the reason is the CLI's own `.env` loader: it walks up from the
 * working directory (and falls back to `~/.gemini/.env` and `~/.env`) and
 * copies into its environment every variable that is not already SET. Verified
 * against 0.62.0: a GEMINI_API_KEY in `$HOME/.env` was loaded silently and the
 * turn ran - and billed - on the key. A variable that is present but empty is
 * left alone by that loader and reads as unset to the auth code, so the key,
 * Vertex and gateway switches are PINNED to "" rather than removed. The empty
 * `.gemini/.env` the workspace carries (workspace.ts) stops the walk as a
 * second, independent guard, and the workspace settings refuse any auth type
 * but the Google sign-in as a third.
 */

/** Removed outright: debugging, IDE and sandbox plumbing that could only steer a turn. */
const DROPPED = new Set([
  'GEMINI_CLI_ACTIVITY_LOG_TARGET',
  'GEMINI_DEBUG_LOG_FILE',
  'GEMINI_CLI_INTEGRATION_TEST',
  'SANDBOX',
  'SEATBELT_PROFILE',
  'DEBUG',
  'DEBUG_MODE',
  // NO_COLOR is set below, but chalk lets FORCE_COLOR win over it, and the
  // stderr tail is read as text.
  'FORCE_COLOR',
]);

const DROPPED_PREFIXES = [
  // Six variables an IDE companion sets; one of them carries an auth token.
  'GEMINI_CLI_IDE_',
  'SANDBOX_',
  'GEMINI_SANDBOX_',
  // Switches for sections of the CLI's built-in system prompt. That prompt is
  // replaced wholesale by GEMINI_SYSTEM_MD, and the operator's shell has no
  // business toggling parts of it anyway.
  'GEMINI_PROMPT_',
];

/**
 * Pinned to "" - present, so the `.env` loader cannot fill them in, and empty,
 * so the CLI reads them as unset. Each one is a way for a turn to stop running
 * on the Google sign-in: an API key, Vertex AI, a gateway or base URL that
 * would receive the prompt, a service-account JSON (GOOGLE_APPLICATION_
 * CREDENTIALS authenticates instead of the seat), a raw access token, compute
 * or Cloud Shell credentials, extra headers, an env-chosen model.
 */
export const GEMINI_PINNED_EMPTY = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_USE_GCA',
  'GOOGLE_GEMINI_BASE_URL',
  'GOOGLE_VERTEX_BASE_URL',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_ACCESS_TOKEN',
  'GEMINI_CLI_USE_COMPUTE_ADC',
  'CLOUD_SHELL',
  'GEMINI_CLI_CUSTOM_HEADERS',
  'GEMINI_API_KEY_AUTH_MECHANISM',
  'GEMINI_MODEL',
  'GEMINI_WRITE_SYSTEM_MD',
  'CODE_ASSIST_API_VERSION',
] as const;

/**
 * The Code Assist endpoint the Google sign-in talks to.
 *
 * Pinned to its real value rather than to "": the CLI reads it with `??`, so an
 * empty string would be used AS the endpoint and break every call. And it is
 * pinned at all because the request carries the account's OAuth bearer token -
 * a redirected endpoint would receive it.
 */
export const GEMINI_CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';

export type GeminiChildEnvOptions = {
  /** This turn's system prompt file, which fully replaces the CLI's own. */
  systemPromptFile?: string;
  /**
   * This turn's temp directory. The CLI writes a dump of the FULL conversation
   * to the temp dir on every API error, so it goes somewhere the adapter
   * deletes when the turn ends.
   */
  tmpDir?: string;
  /** AI_GEMINI_HOME, resolved: where a dedicated sign-in lives. */
  home?: string | null;
};

/**
 * Builds the child's environment from the parent's.
 *
 * KEPT on purpose, by analogy with CLAUDE_CONFIG_DIR and CODEX_HOME: the
 * variables that say where the sign-in lives (GEMINI_CLI_HOME, and
 * GEMINI_FORCE_ENCRYPTED_FILE_STORAGE - dropping it signs the child out),
 * GOOGLE_CLOUD_PROJECT / _PROJECT_ID / _LOCATION (a Workspace account needs a
 * project, and without the Vertex switch they cannot move the call to Vertex),
 * the operator's system-settings and trusted-folders paths, and PATH, HOME and
 * the proxy variables, which are the machine's configuration.
 */
export function buildGeminiChildEnv(
  parent: NodeJS.ProcessEnv = process.env,
  options: GeminiChildEnvOptions = {}
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (DROPPED.has(name)) continue;
    if (DROPPED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    child[name] = value;
  }

  for (const name of GEMINI_PINNED_EMPTY) {
    child[name] = '';
  }
  child.CODE_ASSIST_ENDPOINT = GEMINI_CODE_ASSIST_ENDPOINT;

  // Without it, a headless run on Windows, macOS or a Linux desktop asks
  // "Do you want to continue? [Y/n]" ON STDOUT, reads stdin and opens a
  // browser for up to five minutes. With it, a signed-out seat fails with
  // exit 41 at once.
  child.NO_BROWSER = 'true';
  child.NO_COLOR = '1';
  // Without it the CLI relaunches itself as a child node process and the outer
  // one IGNORES SIGTERM - measured: the inner process survived even SIGKILL of
  // the wrapper and finished the turn. The runner's deadline kill has to reach
  // the process that is actually working.
  child.GEMINI_CLI_NO_RELAUNCH = 'true';
  // The workspace is ours and empty; the folder-trust prompt would only refuse
  // to run in it (exit 55). `--skip-trust` says the same on the command line.
  child.GEMINI_CLI_TRUST_WORKSPACE = 'true';
  child.GEMINI_SANDBOX = 'false';

  if (options.home) {
    child.GEMINI_CLI_HOME = options.home;
  }
  if (options.systemPromptFile) {
    child.GEMINI_SYSTEM_MD = options.systemPromptFile;
  }
  if (options.tmpDir) {
    // TMPDIR for POSIX, TEMP and TMP for Windows, where os.tmpdir() reads
    // those two and ignores TMPDIR.
    child.TMPDIR = options.tmpDir;
    child.TEMP = options.tmpDir;
    child.TMP = options.tmpDir;
  }

  return child;
}

/**
 * The directory the child keeps its `.gemini` in: GEMINI_CLI_HOME when set,
 * else the user's home as the child would compute it - from ITS environment,
 * which is what `os.homedir()` reads first.
 */
export function resolveGeminiHome(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  fallbackHome: () => string = os.homedir
): string {
  const configured = (env.GEMINI_CLI_HOME ?? '').trim();
  if (configured) return configured;
  const home = (platform === 'win32' ? env.USERPROFILE : env.HOME) ?? '';
  return home.trim() || fallbackHome();
}
