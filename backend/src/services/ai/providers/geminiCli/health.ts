import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { resolveCliExecPlan } from '../cli/resolveBinary';
import type { ProviderHealth } from '../../types';
import { resolveGeminiHome } from './env';
import { GEMINI_CLI_BINARY_HINTS } from './hints';
import { geminiCliHealthTimeoutMs } from './options';

/**
 * Is the CLI there, and does it have a Google sign-in?
 *
 * NO PROMPT IS EVER SENT, and so the second half is a look at files rather than
 * a command. The CLI has no `auth status`: every way of exercising the sign-in
 * is a model call, and `--list-sessions` swallows auth errors and exits 0. So:
 *
 *   1. `gemini --version` - is the binary runnable (about a second, no network);
 *   2. `<home>/.gemini/oauth_creds.json` - is there a Google sign-in with a
 *      refresh token in it.
 *
 * What that cannot see is a token Google has since revoked. That surfaces on
 * the first real call, as `auth` with exit 41, and the adapter holds the seat.
 * Credentials kept in the CLI's encrypted storage cannot be inspected at all,
 * and the result says so rather than guessing.
 */

export type GeminiCliHealth = ProviderHealth & {
  binary: string | null;
  version: string | null;
  /** null when the credentials are in encrypted storage and cannot be checked. */
  loggedIn: boolean | null;
};

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
    plan = resolveCliExecPlan(binary, undefined, GEMINI_CLI_BINARY_HINTS);
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

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The CLI's settings.json allows comments. Strips `//` and `/* *\/` outside
 * strings, which is all it takes to read the one field this check reports.
 */
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      out += char;
    }
  }
  return out;
}

function readSelectedAuthType(file: string): string | null {
  try {
    const settings = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8'))) as {
      security?: { auth?: { selectedType?: unknown } };
    };
    const selected = settings?.security?.auth?.selectedType;
    return typeof selected === 'string' ? selected : null;
  } catch {
    return null;
  }
}

function nonEmptyFile(file: string): boolean {
  try {
    return fs.readFileSync(file, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

/** The sign-in, said once where every message needs it. */
export const GEMINI_SIGN_IN_ACTION =
  'Run `NO_BROWSER=true gemini` once, interactively, as the user this server runs as (with ' +
  'GEMINI_CLI_HOME set to the AI_GEMINI_HOME directory, when that is set): choose "Sign in with ' +
  'Google", open the URL it prints in any browser and paste the code back. No display is needed on ' +
  'the server.';

export const GEMINI_INSTALL_ACTION =
  'Install the Gemini CLI (npm i -g @google/gemini-cli; it needs Node 20 or later), then sign in. ' +
  GEMINI_SIGN_IN_ACTION +
  ' If it IS installed, this process has a different PATH than your shell - set AI_GEMINI_BIN to the full path.';

export async function checkGeminiCliHealth(options: {
  binary: string;
  /** The CHILD's environment, which is what the binary runs with. */
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<GeminiCliHealth> {
  const checkedAt = new Date().toISOString();
  // AI_GEMINI_HEALTH_TIMEOUT_MS, read from the SERVER's environment, not
  // `options.env`, which is the child's.
  const timeoutMs = options.timeoutMs ?? geminiCliHealthTimeoutMs();

  const version = await run(options.binary, ['--version'], options.env, timeoutMs);
  if (!version.ok) {
    const missing = version.code === 'ENOENT';
    return {
      ok: false,
      loggedIn: false,
      binary: missing ? null : options.binary,
      version: null,
      checkedAt,
      detail: missing
        ? `No "${options.binary}" on the server PATH.`
        : `Could not run "${options.binary} --version": ${version.stderr.trim() || version.code || 'unknown error'}`,
      warning: missing ? GEMINI_INSTALL_ACTION : undefined,
    };
  }
  const versionText = version.stdout.trim().split('\n')[0] || null;

  const home = resolveGeminiHome(options.env);
  const geminiDir = path.join(home, '.gemini');
  const credentialsFile = path.join(geminiDir, 'oauth_creds.json');
  const accounts = readJson(path.join(geminiDir, 'google_accounts.json'));
  const account = typeof accounts?.active === 'string' && accounts.active ? accounts.active : null;
  const selectedAuthType = readSelectedAuthType(path.join(geminiDir, 'settings.json'));
  const memoryFile = path.join(geminiDir, 'GEMINI.md');
  const meta = { home, credentialsFile, account, selectedAuthType };

  // Appended to EVERY system prompt this seat runs, whatever GEMINI_SYSTEM_MD
  // says, and nothing turns it off - so an operator's personal notes would
  // steer every resume. Said here rather than discovered in an answer.
  const memoryWarning = nonEmptyFile(memoryFile)
    ? `${memoryFile} is not empty, and the CLI appends it to every prompt this seat runs. Empty it, or set ` +
      'AI_GEMINI_HOME to a home of its own for this server and sign in there.'
    : undefined;

  const credentials = readJson(credentialsFile);
  const refreshToken = credentials?.refresh_token;
  if (typeof refreshToken === 'string' && refreshToken.trim()) {
    return {
      ok: true,
      loggedIn: true,
      binary: options.binary,
      version: versionText,
      authMethod: 'oauth-personal',
      checkedAt,
      detail: account ? `Signed in with Google as ${account}.` : 'Signed in with Google.',
      warning: memoryWarning,
      meta,
    };
  }

  if ((options.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE ?? '').trim().toLowerCase() === 'true') {
    return {
      ok: true,
      loggedIn: null,
      binary: options.binary,
      version: versionText,
      authMethod: 'oauth-personal',
      checkedAt,
      detail:
        'The sign-in is kept in the CLI\'s encrypted storage (GEMINI_FORCE_ENCRYPTED_FILE_STORAGE), which ' +
        'this check cannot read without sending a prompt. The first call will say whether it works.',
      warning: memoryWarning,
      meta,
    };
  }

  return {
    ok: false,
    loggedIn: false,
    binary: options.binary,
    version: versionText,
    authMethod: null,
    checkedAt,
    detail: credentials
      ? `The Google sign-in at ${credentialsFile} has no refresh token, so it stops working within the hour.`
      : `Not signed in: there is no Google sign-in at ${credentialsFile}.`,
    warning: GEMINI_SIGN_IN_ACTION,
    meta,
  };
}
