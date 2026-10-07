import { execFile } from 'child_process';
import { aiCliHealthTimeoutMs } from '../../../../config/operational';
import { resolveCliExecPlan } from '../cli/resolveBinary';
import { CLAUDE_CLI_BINARY_HINTS } from './hints';
import type { ProviderHealth } from '../../types';

/**
 * Is the CLI there, and is it signed in with a subscription?
 *
 * Checked at boot and from the admin health endpoint rather than left to
 * surface as a failed resume generation later. `claude auth status` prints
 * JSON - {"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty",
 * ...} - whose `authMethod` is the CLI's own word for where its credential
 * came from. Read out of the published builds, from 2.1.40 (the first with
 * `auth status`) to 2.1.292:
 *
 *   claude.ai       the sign-in `claude auth login` saves - the subscription
 *   oauth_token     a token the CLI was handed rather than one it saved: a
 *                   token file a host provides (a hosted Claude Code machine
 *                   prints this), or CLAUDE_CODE_OAUTH_TOKEN, which the child
 *                   never sees here (env.ts strips every CLAUDE_* but the
 *                   config dir). 2.1.292 prints it for an `ant` API profile
 *                   too, which nothing in this JSON tells apart; that one is
 *                   left to the call-time check, as it always was
 *   api_key         ANTHROPIC_API_KEY, and from 2.1.286 a Console login
 *   api_key_helper  an apiKeyHelper in the CLI's settings
 *   third_party     Bedrock, Vertex or another provider's API
 *
 * This check once took `oauth_token` alone for the subscription - what a
 * hosted machine prints - so a server signed in the ordinary way, which
 * prints `claude.ai`, was warned about at every start, and the admin seat
 * check never lifted its sign-in hold.
 *
 * From 2.1.40 to 2.1.285 a Console login - an API key the CLI made for itself
 * at `/login`, billed per token - ALSO read `claude.ai`, told apart only by
 * the `apiKeySource: "/login managed key"` printed beside it (2.1.286 calls it
 * `api_key`). So a key source beside a subscription method means it is not
 * one; the JSON leaves the field out when there is none.
 */

/** The `authMethod`s that are the subscription, when no API key is named beside them. */
export const SUBSCRIPTION_AUTH_METHODS: readonly string[] = Object.freeze(['claude.ai', 'oauth_token']);

export type ClaudeCliHealth = ProviderHealth & {
  binary: string | null;
  version: string | null;
  loggedIn: boolean;
  /** `claude auth status`'s `apiKeySource`: absent or null when it names no key. */
  apiKeySource?: string | null;
};

/**
 * The ONE answer to "is this sign-in the subscription?" - the startup line and
 * the admin card's warning ask it, and so does the adapter before a fresh
 * check may lift a sign-in hold (index.ts). Signed in, on a method in
 * SUBSCRIPTION_AUTH_METHODS, with no API key named beside it.
 */
export function isSubscriptionSignIn(
  status: Pick<ClaudeCliHealth, 'loggedIn' | 'authMethod' | 'apiKeySource'>
): boolean {
  if (status.loggedIn !== true) return false;
  if (typeof status.authMethod !== 'string' || !SUBSCRIPTION_AUTH_METHODS.includes(status.authMethod)) {
    return false;
  }
  const key = status.apiKeySource;
  return key === undefined || key === null || key === '' || key === 'none';
}

/** What each subscription method is called in the detail line. */
const SUBSCRIPTION_DETAILS: Readonly<Record<string, string>> = Object.freeze({
  'claude.ai': 'claude.ai sign-in',
  oauth_token: 'OAuth token',
});

function run(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<{ ok: boolean; stdout: string; stderr: string; code: string | null }> {
  // Resolved the same way the runner does, so the health card reports what a
  // real request would actually find - a `.cmd` shim on Windows included.
  let plan;
  try {
    plan = resolveCliExecPlan(binary, undefined, CLAUDE_CLI_BINARY_HINTS);
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

export async function checkClaudeCliHealth(options: {
  binary: string;
  /** The CHILD's environment, which is what the binary runs with. */
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /**
   * The sign-in command this provider's advice names. An added provider's
   * carries its own CLAUDE_CONFIG_DIR: the bare `claude auth login` signs in
   * the server's default folder, which is another provider's.
   */
  signInCommand?: string;
}): Promise<ClaudeCliHealth> {
  const checkedAt = new Date().toISOString();
  const signIn = options.signInCommand ?? 'claude auth login';
  // AI_CLI_HEALTH_TIMEOUT_MS, applied to each of the two commands, so the
  // whole check can take up to twice it. Configurable because spawn time is
  // the machine's, not the code's: a Windows `.cmd` shim, an antivirus scan of
  // a fresh binary or a cold global install can outlast 20s, and a probe that
  // times out reports a working seat as broken. Read from the SERVER's
  // environment, not `options.env`, which is the child's.
  const timeoutMs = options.timeoutMs ?? aiCliHealthTimeoutMs();

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
        ? `Install Claude Code (npm i -g @anthropic-ai/claude-code) and run \`${signIn}\` as the user this server runs as, or set AI_CLI_BIN to its path.`
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
  const apiKeySource = typeof parsed.apiKeySource === 'string' ? parsed.apiKeySource : null;
  const versionText = version.stdout.trim().split('\n')[0] || null;

  if (!loggedIn) {
    return {
      ok: false,
      loggedIn: false,
      binary: options.binary,
      version: versionText,
      authMethod,
      apiKeySource,
      checkedAt,
      detail: 'The Claude CLI is installed but not signed in.',
      warning: `Run \`${signIn}\` as the user this server runs as.`,
      meta: parsed,
    };
  }

  // Said out loud because the failure is otherwise invisible until a call is
  // made: an API key answers every request just as well as the subscription
  // and bills for every one of them, so the adapter stops any turn whose first
  // event says it runs on a key, and holds the seat. Left ok, because an auth
  // method this check has never seen may still be the subscription, and the
  // call-time check is the one that knows.
  const onSubscription = isSubscriptionSignIn({ loggedIn, authMethod, apiKeySource });
  return {
    ok: true,
    loggedIn: true,
    binary: options.binary,
    version: versionText,
    authMethod,
    apiKeySource,
    checkedAt,
    detail: onSubscription
      ? `Signed in on a Claude subscription (${SUBSCRIPTION_DETAILS[authMethod ?? ''] ?? authMethod}).`
      : `Signed in with authMethod="${authMethod ?? 'unknown'}"` +
        (apiKeySource && apiKeySource !== 'none' ? ` and apiKeySource="${apiKeySource}".` : '.'),
    warning: onSubscription
      ? undefined
      : 'This may not be a subscription sign-in. A call the CLI starts on an API key is stopped at its first ' +
        `event, before the model answers, and the seat is held for every call after it; run \`${signIn}\` ` +
        'as the user this server runs as to use the subscription.',
    meta: parsed,
  };
}
