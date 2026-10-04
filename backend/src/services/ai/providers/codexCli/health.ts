import { execFile } from 'child_process';
import { aiCodexHealthTimeoutMs } from '../../../../config/operational';
import { resolveCliExecPlan } from '../cli/resolveBinary';
import { CODEX_CLI_BINARY_HINTS } from './argv';
import type { ProviderHealth } from '../../types';

/**
 * Is the CLI there, and is it signed in?
 *
 * `codex login status` prints PLAIN TEXT and - measured on the real binary -
 * EXITS 0 EITHER WAY. So the exit code carries no signal at all and the text is
 * the entire check, which is the opposite of the Claude side where
 * `claude auth status` prints JSON.
 *
 * The signed-out wording was captured ("Not logged in"). The signed-IN wording
 * was not, because this machine has no ChatGPT credential. So the rule is
 * written the only way that cannot be wrong about a string it has never seen:
 * match the known negative, and treat anything else as signed in while
 * reporting the line verbatim. A new phrasing of "not logged in" would be the
 * one way this misreads, which is why the raw line is always shown.
 */

export type CodexCliHealth = ProviderHealth & {
  binary: string | null;
  loggedIn: boolean;
};

const SIGNED_OUT = /not\s+logged\s+in|no\s+credentials|please\s+run\s+`?codex\s+login/i;

function run(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<{ ok: boolean; stdout: string; stderr: string; code: string | null }> {
  let plan;
  try {
    // Resolved the way the runner resolves it, so the health card reports what
    // a real request would find - a Windows `.cmd` shim included.
    plan = resolveCliExecPlan(binary, undefined, CODEX_CLI_BINARY_HINTS);
  } catch (error) {
    return Promise.resolve({
      ok: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      code: 'ENOENT',
    });
  }

  return new Promise((resolve) => {
    execFile(
      plan.command,
      [...plan.prefixArgs, ...args],
      { env, timeout: timeoutMs, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL', windowsHide: true },
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

export async function checkCodexCliHealth(options: {
  binary: string;
  /** The CHILD's environment, which is what the binary runs with. */
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<CodexCliHealth> {
  const checkedAt = new Date().toISOString();
  // AI_CODEX_HEALTH_TIMEOUT_MS, the mirror of the Claude side's
  // AI_CLI_HEALTH_TIMEOUT_MS and configurable for the same reason: how long a
  // spawn takes is the machine's business (a Windows `.cmd` shim, antivirus, a
  // cold global install), and a probe that times out reports a working seat as
  // missing. Read from the SERVER's environment, not `options.env`.
  const timeoutMs = options.timeoutMs ?? aiCodexHealthTimeoutMs();
  const status = await run(options.binary, ['login', 'status'], options.env, timeoutMs);

  if (status.code === 'ENOENT') {
    return {
      ok: false,
      loggedIn: false,
      binary: null,
      detail:
        `The \`${options.binary}\` CLI was not found. Install it with ` +
        '`npm i -g @openai/codex`, then sign in with `codex login --device-auth` as the user this ' +
        'server runs as. If it IS installed, this process has a different PATH than your shell - ' +
        'set AI_CODEX_BIN to the full path.',
      checkedAt,
    };
  }

  // Both streams, because a CLI is free to put its status on either and the
  // exit code has already been established as meaningless here.
  const said = `${status.stdout}\n${status.stderr}`.trim();
  const firstLine = said.split('\n').map((line) => line.trim()).filter(Boolean)[0] ?? '';

  if (!said) {
    return {
      ok: false,
      loggedIn: false,
      binary: options.binary,
      detail: '`codex login status` said nothing at all, so its sign-in state is unknown.',
      checkedAt,
    };
  }

  if (SIGNED_OUT.test(said)) {
    return {
      ok: false,
      loggedIn: false,
      binary: options.binary,
      detail:
        `Not signed in (\`codex login status\` said: ${firstLine}). Run ` +
        '`codex login --device-auth` as the user this server runs as - it prints a code you ' +
        'approve from any other browser, so no display is needed on the server.',
      checkedAt,
    };
  }

  return {
    ok: true,
    loggedIn: true,
    binary: options.binary,
    detail: firstLine,
    checkedAt,
  };
}
