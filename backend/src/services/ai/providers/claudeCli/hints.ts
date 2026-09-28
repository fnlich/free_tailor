import type { CliBinaryHints } from '../cli/resolveBinary';

/**
 * What to suggest when `claude` resolves to a shim this server will not run.
 *
 * Held here rather than in the shared resolver, which serves more than one CLI
 * now and cannot know which npm package a given binary came from.
 * `@anthropic-ai/claude-code` ships its bin as a native executable, which is
 * why the example path ends in `bin/claude.exe` rather than a `cli.js`.
 */
export const CLAUDE_CLI_BINARY_HINTS: CliBinaryHints = {
  envVar: 'AI_CLI_BIN',
  packageBinSegments: ['@anthropic-ai', 'claude-code', 'bin', 'claude.exe'],
};
