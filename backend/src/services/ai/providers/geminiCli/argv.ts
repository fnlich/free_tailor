import { warnOnce } from '../../telemetry';
import { isGeminiModelName } from './options';

/**
 * Command-line construction for one headless `gemini` turn, kept pure so the
 * flag set - and the flags that must never appear - can be asserted without
 * spawning anything.
 */

/**
 * Flags this provider must never pass, with their short aliases.
 *
 * Each one either hands the model the machine or changes what a turn is:
 *   --yolo / --approval-mode would approve tool calls (and `plan` mode makes
 *     the CLI's model fallbacks silent);
 *   --sandbox runs the turn in a container this server did not ask for;
 *   --prompt / --prompt-interactive put the prompt in argv, where a shell or
 *     Windows re-quotes it - it goes on stdin;
 *   --raw-output / --accept-raw-output-risk stop the CLI stripping escape
 *     sequences from model output;
 *   --resume / --session-file continue a stored conversation, which would leak
 *     one turn's content into another;
 *   --acp / --experimental-acp switch to an agent protocol on stdio;
 *   --debug opens a debug console;
 *   --worktree, --include-directories and --allowed-tools widen what the turn
 *     can reach;
 *   the hidden --fake-responses / --record-responses are test hooks.
 *
 * `--extensions` and `--allowed-mcp-server-names` are not here: every turn
 * passes them, pinned to values that NARROW (see buildGeminiArgv).
 */
export const FORBIDDEN_FLAGS = [
  '--yolo',
  '-y',
  '--approval-mode',
  '--sandbox',
  '-s',
  '--prompt',
  '-p',
  '--prompt-interactive',
  '-i',
  '--raw-output',
  '--accept-raw-output-risk',
  '--resume',
  '-r',
  '--session-file',
  '--acp',
  '--experimental-acp',
  '--debug',
  '-d',
  '--worktree',
  '-w',
  '--include-directories',
  '--allowed-tools',
  '--fake-responses',
  '--fake-responses-non-strict',
  '--record-responses',
] as const;

/**
 * What the model is told it is doing when the prompt brings no instructions.
 *
 * GEMINI_SYSTEM_MD replaces the CLI's built-in system prompt entirely, which is
 * a coding agent's - tools, files, shell, workflow - and none of it applies to
 * "answer this in the reply". The stored prompts carry the real contract.
 */
export const GEMINI_BASE_SYSTEM_PROMPT =
  'You answer exactly what the message asks for and nothing else: no preamble, ' +
  'no explanation, and no commentary afterwards. You have no tools and no ' +
  'filesystem; write your answer directly into the reply.';

/**
 * The most the CLI reads from stdin. Beyond it the CLI truncates the prompt
 * with nothing but a debug-log line, and the model answers half a question - so
 * a longer prompt is refused before anything is spawned.
 */
export const MAX_GEMINI_STDIN_BYTES = 8 * 1024 * 1024;

/**
 * Narrows a stored model name to one the CLI will serve.
 *
 * The CLI forwards any `--model` string to the backend, which answers a name it
 * does not know with a 404 on every call. A record or prompt override carrying
 * a name from another provider degrades to the configured default with one
 * warning instead, as the Claude seat's `resolveCliModel` does.
 */
export function resolveGeminiModel(requested: string | undefined, fallback: string): string {
  const name = (requested ?? '').trim();
  if (!name) return fallback;
  if (isGeminiModelName(name)) return name;
  warnOnce(
    `gemini-model:${name}`,
    `Model "${name}" is not a Gemini CLI model name; using "${fallback}" instead. ` +
      'Change it under Admin -> Models, or clear the per-prompt model override.'
  );
  return fallback;
}

export type GeminiArgvOptions = {
  model: string;
  /** The directory holding the deny-all policy file. */
  policyDir: string;
  /** A fresh UUID per turn, so the turn's transcript can be found and deleted. */
  sessionId: string;
};

/** The `--session-id` alphabet the CLI enforces; anything else is a usage error. */
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

/**
 * The command line for one turn. Every flag was read off the 0.62.0 bundle's
 * option table rather than recalled.
 *
 * No `-p` and no positional query: the prompt goes on STDIN, which is both the
 * repository's standing rule (argv is re-parsed by shells and re-quoted by
 * Windows, and the prompt holds admin-editable and user-supplied text) and what
 * makes the run headless - stdin is not a TTY.
 */
export function buildGeminiArgv(options: GeminiArgvOptions): string[] {
  if (!SESSION_ID.test(options.sessionId)) {
    throw new Error(`invalid Gemini session id "${options.sessionId}"`);
  }
  return [
    // JSONL, one event per line, as the turn happens. The `json` format writes
    // nothing until the end, which would leave the stall timer blind.
    '--output-format',
    'stream-json',
    // Always explicit, so neither GEMINI_MODEL nor the operator's own
    // settings.model.name decides which model a record runs on.
    '--model',
    options.model,
    // `[[rule]] toolName = "*" decision = "deny"`. Given a directory, --policy
    // also REPLACES the operator's own ~/.gemini/policies rather than adding
    // to them, so nothing the operator allowed for themselves reaches a turn.
    '--policy',
    options.policyDir,
    // The workspace is ours; an untrusted one makes a headless run exit 55.
    '--skip-trust',
    '--session-id',
    options.sessionId,
    // MCP servers and extensions OFF, by flag because no settings file can do
    // it: 0.62.0 builds `admin.*` from remote admin controls only, ignoring it
    // in every settings file, and an empty `mcp.allowed` means "no limit". So
    // the operator's own ~/.gemini mcpServers would start (and a hung one
    // stall every turn) and an installed extension's context would join every
    // prompt. A non-empty allowlist naming no real server blocks every server,
    // extensions' included; `none` is the CLI's own value for "load none".
    '--allowed-mcp-server-names',
    GEMINI_NO_MCP_SERVER,
    '--extensions',
    'none',
  ];
}

/** An MCP allowlist entry no real server is called, so the allowlist admits none. */
export const GEMINI_NO_MCP_SERVER = '__tailor_none__';

/**
 * The CLI's own `@path` token, copied from its parser (atCommandProcessor in
 * 0.62.0): an `@` not preceded by a backslash, then a quoted string or a run of
 * characters up to whitespace or punctuation, with backslash escapes.
 */
const AT_REFERENCE = /(?<!\\)@(?:(?:"[^"]*")|(?:\\.|[^ \t\n\r,;!?()[\]{}.]|\.(?!$|[ \t\n\r])))+/g;

/**
 * Escapes every `@` reference the CLI would read, with the CLI's own `\@`,
 * which it leaves as text.
 *
 * The CLI treats `@name` in the prompt as "attach this file", reads it before
 * the model is called, and resolves it against every workspace directory - the
 * empty one this seat runs in, but ALSO each `context.includeDirectories` in the
 * operator's ~/.gemini or system settings, a list the workspace settings cannot
 * clear (its merge strategy is concat). A path can also reach the CLI's
 * per-project temp dir under ~/.gemini/tmp, where every concurrent turn's
 * transcript sits. A job description is user-supplied text, so `@config.json`
 * or `@../../home/app/.gemini/tmp/...` in one would attach the operator's
 * files, or other users' prompts, to this turn. So no token is judged safe by
 * its spelling: emails and handles are escaped too, and the backslash that
 * puts in front of them is taken back out of the answer (restoreEscapedAt).
 *
 * Repeated until nothing changes, because escaping the first `@` of a token
 * like `@a@/etc` exposes the second as a token of its own.
 */
export function escapeAtReferences(text: string): string {
  let current = text;
  for (;;) {
    const next = current.replace(AT_REFERENCE, (match) => `\\${match}`);
    if (next === current) return current;
    current = next;
  }
}

/**
 * Undoes the escape above in a model's answer.
 *
 * A model shown `jane\@example.com` can copy it as written, and a `\@` inside
 * a JSON string is not a valid escape, so the whole answer would fail to parse.
 * Only a `\@` whose backslash is not itself escaped is changed - the CLI's own
 * unescapeLiteralAt rule - so a JSON `\\@` (a real backslash) survives.
 */
export function restoreEscapedAt(text: string): string {
  return text.replace(/\\@/g, (match, offset: number, full: string) => {
    let backslashes = 0;
    for (let i = offset - 1; i >= 0 && full[i] === '\\'; i -= 1) backslashes += 1;
    return backslashes % 2 === 0 ? '@' : match;
  });
}

/**
 * The prompt as it goes on stdin.
 *
 * Two guards, both against the CLI treating user text as a command: the `@`
 * escape above, and a leading newline when the text starts with `/`, which the
 * CLI would otherwise run as a slash command instead of sending it.
 */
export function guardGeminiPrompt(userBody: string): string {
  const escaped = escapeAtReferences(userBody);
  return escaped.startsWith('/') ? `\n${escaped}` : escaped;
}
