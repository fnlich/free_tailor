import { execFile } from 'child_process';
import type { ProviderHealth } from '../../types';

/**
 * Is the CLI there, and is it signed in with a subscription?
 *
 * Checked at boot and from the admin health endpoint rather than left to
 * surface as a failed resume generation later. `claude auth status` prints
 * JSON: {"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}
 */

export type ClaudeCliHealth = ProviderHealth & {
  binary: string | null;
  version: string | null;
  loggedIn: boolean;
};

function run(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<{ ok: boolean; stdout: string; stderr: string; code: string | null }> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { env, timeout: timeoutMs, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code ?? null;
        resolve({
          ok: !error,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: typeof code === 'string' ? code : code === null ? null : String(code),
        });
      }
    );
  });
}

export async function checkClaudeCliHealth(options: {
  binary: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<ClaudeCliHealth> {
  const checkedAt = new Date().toISOString();
  const timeoutMs = options.timeoutMs ?? 20_000;

  const version = await run(options.binary, ['--version'], options.env, timeoutMs);
  if (!version.ok) {
    const missing = version.code === 'ENOENT';
    return {
      ok: false,
      loggedIn: false,
      binary: null,
      version: null,
      checkedAt,
      detail: missing
        ? `No "${options.binary}" on the server PATH.`
        : `Could not run "${options.binary}": ${version.stderr.trim() || version.code || 'unknown error'}`,
      warning: missing
        ? 'Install Claude Code (npm i -g @anthropic-ai/claude-code) and run `claude auth login` as the user this server runs as, or set AI_CLI_BIN to its path.'
        : undefined,
    };
  }

  const status = await run(options.binary, ['auth', 'status'], options.env, timeoutMs);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(status.stdout) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  const loggedIn = parsed.loggedIn === true;
  const authMethod = typeof parsed.authMethod === 'string' ? parsed.authMethod : null;
  const versionText = version.stdout.trim().split('\n')[0] || null;

  if (!loggedIn) {
    return {
      ok: false,
      loggedIn: false,
      binary: options.binary,
      version: versionText,
      authMethod,
      checkedAt,
      detail: 'The Claude CLI is installed but not signed in.',
      warning: 'Run `claude auth login` as the user this server runs as.',
      meta: parsed,
    };
  }

  // Said out loud because the failure is otherwise invisible: an API key
  // answers every request just as well as the subscription and bills for
  // every one of them.
  const onSubscription = authMethod === 'oauth_token';
  return {
    ok: true,
    loggedIn: true,
    binary: options.binary,
    version: versionText,
    authMethod,
    checkedAt,
    detail: onSubscription
      ? 'Signed in on a Claude subscription (OAuth).'
      : `Signed in with authMethod="${authMethod ?? 'unknown'}".`,
    warning: onSubscription
      ? undefined
      : 'This is not a subscription sign-in, so every request is billed per token.',
    meta: parsed,
  };
}
