import type { CliBinaryHints } from '../cli/resolveBinary';
import { CODEX_DEFAULT_MODEL } from './options';

/**
 * What to suggest when `codex` resolves to a shim this server will not run.
 *
 * npm installs a CLI on Windows as a `.cmd` shim that `spawn` cannot execute,
 * and this app refuses to go through a shell to fix that - an admin-editable
 * system prompt would land on a command line `cmd` re-parses.
 */
export const CODEX_CLI_BINARY_HINTS: CliBinaryHints = {
  envVar: 'AI_CODEX_BIN',
  packageBinSegments: ['@openai', 'codex', 'bin', 'codex.js'],
};

export type CodexArgvOptions = {
  /** `default` means "let the CLI choose", and omits the flag entirely. */
  model: string;
  /** Where the final answer is written, read back by the adapter. */
  lastMessageFile: string;
  /** The fixed, empty directory the turn runs in. */
  cwd: string;
  /** A JSON Schema file, when the caller asked for structured output. */
  outputSchemaFile?: string;
};

/**
 * The command line for one `codex exec` turn.
 *
 * Every flag here was read off `codex exec --help` from the installed binary
 * rather than recalled, because this CLI moves fast and a flag that does not
 * exist is a spawn that fails with a usage message.
 *
 * The prompt is NOT here. It goes on stdin - `-` as the argument - which is
 * both what the CLI documents and this repository's standing rule: argv gets
 * re-parsed by shells and re-quoted by Windows, and the prompt contains
 * admin-editable text.
 */
export function buildCodexArgv(options: CodexArgvOptions): string[] {
  const argv = [
    'exec',
    '--json',
    // The answer, written to a file. This is what makes the provider robust to
    // the event schema changing: the events are progress and metadata, and the
    // text a caller actually receives comes from here.
    '--output-last-message',
    options.lastMessageFile,
    // Read-only. The agent is being asked for prose, and a sandbox that could
    // write is a way for a turn to change this machine instead of answering.
    '--sandbox',
    'read-only',
    // The workdir is a fixed empty directory, which is not a git repo - without
    // this the CLI refuses to start there.
    '--skip-git-repo-check',
    // No session files. One-shot completions have nothing to resume, and each
    // would otherwise leave state behind per call.
    '--ephemeral',
    // The operator's own config is not part of this task and could only steer
    // it. Auth is unaffected: the CLI documents that it still reads CODEX_HOME.
    '--ignore-user-config',
    // stdout is parsed, so ANSI escapes in it would be noise in the NDJSON.
    '--color',
    'never',
    '--cd',
    options.cwd,
  ];

  // Omitted for the sentinel, which is the seeded default: Codex resolves its
  // catalog from the signed-in account, so "whatever this account has" is the
  // only model name that is true everywhere.
  if (options.model && options.model !== CODEX_DEFAULT_MODEL) {
    argv.push('--model', options.model);
  }

  // A PATH, unlike the Claude provider's inline `--json-schema`. The adapter
  // writes the schema out and cleans it up.
  if (options.outputSchemaFile) {
    argv.push('--output-schema', options.outputSchemaFile);
  }

  // Last, and the reason the prompt never appears above it.
  argv.push('-');
  return argv;
}
