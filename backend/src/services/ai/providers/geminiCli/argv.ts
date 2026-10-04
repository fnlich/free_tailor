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
 *   --worktree, --include-directories, --extensions, --allowed-tools and
 *     --allowed-mcp-server-names widen what the turn can reach;
 *   the hidden --fake-responses / --record-responses are test hooks.
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
  '--extensions',
  '-e',
  '--allowed-tools',
  '--allowed-mcp-server-names',
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
  ];
}

/**
 * The CLI's own `@path` token, copied from its parser (atCommandProcessor in
 * 0.62.0): an `@` not preceded by a backslash, then a quoted string or a run of
 * characters up to whitespace or punctuation, with backslash escapes.
 */
const AT_REFERENCE = /(?<!\\)@(?:(?:"[^"]*")|(?:\\.|[^ \t\n\r,;!?()[\]{}.]|\.(?!$|[ \t\n\r])))+/g;

/** A token that could name a file outside the empty workspace. */
const PATH_LIKE = /[\\/~:"]/;

/**
 * Escapes every `@` the CLI would read as a reference to a file OUTSIDE the
 * workspace.
 *
 * The CLI treats `@path` in the prompt as "attach this file", reads it before
 * the model is called, and allows any path inside the workspace OR inside its
 * own per-project temp directory under `~/.gemini/tmp/` - which is where every
 * concurrent turn's transcript sits while it runs. A job description is
 * user-supplied text, so `@../../home/app/.gemini/tmp/gemini-cli-work/chats`
 * in one would attach other users' prompts to this turn. A token with a path
 * separator, a drive colon, a `~` or a quote is escaped with the CLI's own
 * `\@`, which it leaves as text. Emails and handles (`@example.com`, `@jane`)
 * cannot leave the empty workspace and are left exactly as written; a URL with
 * an `@` in its path gains one backslash, which is the cost of the guard.
 *
 * Repeated until nothing changes, because escaping the first `@` of a token
 * like `@a@/etc` exposes the second as a token of its own.
 */
export function escapeOutsidePathReferences(text: string): string {
  let current = text;
  for (;;) {
    const next = current.replace(AT_REFERENCE, (match) =>
      PATH_LIKE.test(match.slice(1)) ? `\\${match}` : match
    );
    if (next === current) return current;
    current = next;
  }
}

/**
 * The prompt as it goes on stdin.
 *
 * Two guards, both against the CLI treating user text as a command: the `@`
 * escape above, and a leading newline when the text starts with `/`, which the
 * CLI would otherwise run as a slash command instead of sending it.
 */
export function guardGeminiPrompt(userBody: string): string {
  const escaped = escapeOutsidePathReferences(userBody);
  return escaped.startsWith('/') ? `\n${escaped}` : escaped;
}
