/**
 * The environment a `claude` child process gets.
 *
 * Three removals, each closing a failure that is silent rather than loud.
 *
 * `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` - the CLI resolves credentials
 * in a fixed order and an API key WINS over the subscription. Left in place it
 * produces identical answers at identical latency and bills every one of them,
 * which is exactly what this provider exists to avoid. This app documents
 * `ANTHROPIC_API_KEY` in `.env.example` and reads it for the separate `claude`
 * HTTP provider, so it is very likely to be present.
 *
 * `CLAUDECODE` and `CLAUDE_*` - set when the server is itself launched from
 * inside a Claude Code session, which is the normal development loop. Left in
 * place the child rejoins the PARENT session: it reports the parent's session
 * id, and answers arrive contaminated by unrelated context rather than failing
 * in a way anyone would notice. `CLAUDE_CONFIG_DIR` is the one exception and is
 * kept deliberately - it is where the operator's sign-in lives, and dropping it
 * signs the child out.
 *
 * Everything else is kept on purpose. `PATH`, `HOME`, `ANTHROPIC_BASE_URL` and
 * proxy variables are the operator's configuration and this module has no
 * business editing them.
 */
export function buildChildEnv(
  parent: NodeJS.ProcessEnv = process.env,
  options: { allowApiKey?: boolean } = {}
): NodeJS.ProcessEnv {
  const allowApiKey = options.allowApiKey === true;
  const child: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) {
      continue;
    }
    if (name === 'CLAUDECODE') {
      continue;
    }
    if (name.startsWith('CLAUDE_') && name !== 'CLAUDE_CONFIG_DIR') {
      continue;
    }
    if ((name === 'ANTHROPIC_API_KEY' || name === 'ANTHROPIC_AUTH_TOKEN') && !allowApiKey) {
      continue;
    }
    child[name] = value;
  }

  return child;
}
