/**
 * The environment a `codex` child process gets.
 *
 * `OPENAI_API_KEY` is the whole point. The CLI resolves credentials in a fixed
 * order and an API key WINS over the ChatGPT subscription, so leaving it in
 * place produces identical answers at identical latency and bills every one of
 * them - which is precisely what a subscription-seat provider exists to avoid.
 * This is not hypothetical here: `.env.example` documents that variable and the
 * separate `openai` HTTP provider reads it, so on most installs running this
 * app it is already set.
 *
 * `OPENAI_BASE_URL` goes with it. A key and a base URL are two halves of the
 * same redirection, and honouring one while dropping the other would point the
 * subscription at somebody else's endpoint.
 *
 * `CODEX_API_KEY` and `CODEX_ACCESS_TOKEN` are dropped for the same reason -
 * `codex login --with-api-key` and `--with-access-token` read exactly these, so
 * an operator who once exported one would silently override the seat.
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
  options: { allowApiKey?: boolean } = {}
): NodeJS.ProcessEnv {
  const allowApiKey = options.allowApiKey === true;
  const child: NodeJS.ProcessEnv = {};

  const billingOverrides = new Set([
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'CODEX_API_KEY',
    'CODEX_ACCESS_TOKEN',
  ]);

  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (billingOverrides.has(name) && !allowApiKey) continue;
    child[name] = value;
  }

  return child;
}
