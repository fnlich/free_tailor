import type { CliBinaryHints } from '../cli/resolveBinary';

/**
 * What to suggest when `gemini` resolves to a shim this server will not run.
 *
 * `@google/gemini-cli` ships its bin as a JavaScript file (`bundle/gemini.js`,
 * an ES module that needs Node 20 or later), so npm writes the usual
 * `.cmd`/`.ps1` wrappers on Windows and the resolver normally unwraps them to
 * that script under this server's own Node. This is only the fallback text for
 * a shim it cannot read.
 */
export const GEMINI_CLI_BINARY_HINTS: CliBinaryHints = {
  envVar: 'AI_GEMINI_BIN',
  packageBinSegments: ['@google', 'gemini-cli', 'bundle', 'gemini.js'],
};
