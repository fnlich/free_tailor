
/**
 * The environment a `claude` child process gets.
 *
 * Three removals, each closing a failure that is silent rather than loud.
 *
 * `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` - the CLI resolves credentials
 * in a fixed order and an API key WINS over the subscription. Left in place it
 * produces identical answers at identical latency and bills every one of them,
 * which is exactly what this provider exists to avoid. This app reads no key
 * of its own any more, but an install upgraded from one that ran the metered
 * Anthropic API still has `ANTHROPIC_API_KEY` in its `.env`. Always stripped:
 * there is no switch to let one through, because the app runs on subscription
 * seats only.
 *
 * `CLAUDECODE` and `CLAUDE_*` - set when the server is itself launched from
 * inside a Claude Code session, which is the normal development loop. Left in
 * place the child rejoins the PARENT session: it reports the parent's session
 * id, and answers arrive contaminated by unrelated context rather than failing
 * in a way anyone would notice. `CLAUDE_CONFIG_DIR` is the one exception and is
 * kept deliberately - it is where the operator's sign-in lives, and dropping it
 * signs the child out.
 *
 * `MAX_THINKING_TOKENS` - the CLI's thinking budget. Dropped so that thinking
 * behaviour is the same on every machine that runs this app: the models think
 * adaptively, deciding per turn, and an operator who happens to have exported
 * this cannot quietly make one server answer differently from another.
 *
 * It used to be SET from the request, when thinking was a per-profile choice.
 * That choice is gone - it was a single-provider on/off that every other
 * provider ignored - so nothing sets it now and the strip is all that remains.
 *
 * Everything else is kept on purpose. `PATH`, `HOME`, `ANTHROPIC_BASE_URL` and
 * proxy variables are the operator's configuration and this module has no
 * business editing them.
 */
export function buildChildEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
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
    if (name === 'ANTHROPIC_API_KEY' || name === 'ANTHROPIC_AUTH_TOKEN') {
      continue;
    }
    if (name === 'MAX_THINKING_TOKENS') {
      continue;
    }
    child[name] = value;
  }

  return child;
}
