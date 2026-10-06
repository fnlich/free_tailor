/**
 * The environment a `codex` child process gets.
 *
 * `OPENAI_API_KEY` is the whole point. The CLI resolves credentials in a fixed
 * order and an API key WINS over the ChatGPT subscription, so leaving it in
 * place produces identical answers at identical latency and bills every one of
 * them - which is precisely what a subscription-seat provider exists to avoid.
 * This is not hypothetical here: an install upgraded from one that ran the
 * metered OpenAI API still has that variable in its `.env`, though nothing in
 * the app reads it any more.
 *
 * `OPENAI_BASE_URL` goes with it. A key and a base URL are two halves of the
 * same redirection, and honouring one while dropping the other would point the
 * subscription at somebody else's endpoint.
 *
 * `CODEX_API_KEY` and `CODEX_ACCESS_TOKEN` are dropped for the same reason -
 * `codex login --with-api-key` and `--with-access-token` read exactly these, so
 * an operator who once exported one would silently override the seat.
 *
 * All four always go: there is no switch to let a key through, because the app
 * runs on subscription seats only. A key `codex login --with-api-key` stored in
 * CODEX_HOME is out of this strip's reach, so the health check reports such a
 * sign-in as not signed in to a subscription.
 *
 * `CODEX_HOME` is KEPT, deliberately and by exact analogy with
 * `CLAUDE_CONFIG_DIR` on the other provider: it is where the operator's
 * `codex login` actually lives, and dropping it signs the child out.
 *
 * Everything else is kept on purpose. `PATH`, `HOME` and the proxy variables
 * are the operator's configuration and this module has no business editing
 * them.
 */
export function buildCodexChildEnv(
  parent: NodeJS.ProcessEnv = process.env,
  options: {
    /**
     * The provider's own CODEX_HOME (config/aiProviders.ts), set AFTER the
     * strip. Null or absent keeps the inherited one - the built-in provider
     * as `.env` left it.
     */
    home?: string | null;
  } = {}
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};

  const billingOverrides = new Set([
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'CODEX_API_KEY',
    'CODEX_ACCESS_TOKEN',
  ]);

  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (billingOverrides.has(name)) continue;
    child[name] = value;
  }

  if (options.home) {
    child.CODEX_HOME = options.home;
  }

  return child;
}
