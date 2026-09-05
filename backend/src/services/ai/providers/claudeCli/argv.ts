import { warnOnce } from '../../telemetry';
import type { EffortLevel } from '../../types';
import { MAX_SYSTEM_PROMPT_ARG_BYTES } from './options';

/**
 * Command-line construction for one `claude -p` turn.
 *
 * Kept as a pure function so the flag set can be asserted in a test without
 * spawning anything - including the negative assertion that matters most,
 * that `--bare` never appears.
 */

/**
 * Flags this provider must never pass.
 *
 * `--bare` is the dangerous one. Its own help says Anthropic auth becomes
 * "strictly ANTHROPIC_API_KEY or apiKeyHelper (OAuth and keychain are never
 * read)" - precisely backwards for a provider whose entire premise is a
 * subscription seat. `--safe-mode` is the flag that turns off the operator's
 * CLAUDE.md, skills, plugins, hooks and MCP servers while leaving auth alone.
 */
export const FORBIDDEN_FLAGS = ['--bare'] as const;

/**
 * What the CLI is told it is doing.
 *
 * Claude Code's default system prompt is a coding AGENT's - tools, files, git,
 * workflow - and none of it applies to "answer this prompt in the reply".
 * Replacing it removes thousands of tokens of irrelevant instruction from every
 * call and stops the model reaching for behaviour the app's prompts would then
 * have to argue it out of. Deliberately short: the stored prompts carry the
 * real contract, and anything said twice is a chance for the two to disagree.
 */
export const CLI_BASE_SYSTEM_PROMPT =
  'You answer exactly what the message asks for and nothing else: no preamble, ' +
  'no explanation, and no commentary afterwards. You have no tools and no ' +
  'filesystem; write your answer directly into the reply.';

/** Model aliases the CLI resolves to the current model in that family. */
export const CLI_MODEL_ALIASES: ReadonlySet<string> = new Set([
  'default',
  'opus',
  'sonnet',
  'haiku',
  'fable',
  'sonnet[1m]',
]);

/** Full model names the CLI accepts, e.g. `claude-sonnet-5`, `claude-opus-4-1`. */
const CANONICAL_MODEL = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/i;

/**
 * Narrows a stored model name to something the CLI will actually serve.
 *
 * This is the single load-bearing safety net for a database written before the
 * migration. Every model name such an install carries - `openai/gpt-5.4-nano`
 * on both shipped prompts, the six persisted OpenRouter rows - makes the CLI
 * exit with "There's an issue with the selected model (...). It may not exist
 * or you may not have access to it" (verified: HTTP 404). Degrading to the
 * configured default with one warning is the difference between a migration
 * that is optional and one that is mandatory before the next request.
 */
export function resolveCliModel(requested: string | undefined, fallback: string): string {
  const name = (requested ?? '').trim();
  if (!name) {
    return fallback;
  }
  if (CLI_MODEL_ALIASES.has(name) || CANONICAL_MODEL.test(name)) {
    return name;
  }
  warnOnce(
    `cli-model:${name}`,
    `Model "${name}" is not a Claude CLI model name; using "${fallback}" instead. ` +
      'Change it under Admin -> Models, or clear the per-prompt model override.'
  );
  return fallback;
}

export type ClaudeArgvOptions = {
  model: string;
  effort: EffortLevel;
  /** Instructions for the model. Moved to stdin when it exceeds the arg cap. */
  systemPrompt: string;
  jsonSchema?: Readonly<Record<string, unknown>>;
  fallbackModels?: readonly string[];
  maxBudgetUsd?: number;
};

export type ClaudeInvocation = {
  argv: string[];
  /**
   * System text that did not fit in argv and must be prepended to stdin.
   * Empty in the normal case.
   */
  systemPromptOverflow: string;
};

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function buildClaudeArgv(options: ClaudeArgvOptions): ClaudeInvocation {
  const systemPrompt = options.systemPrompt.trim() || CLI_BASE_SYSTEM_PROMPT;
  const fitsInArgv = byteLength(systemPrompt) <= MAX_SYSTEM_PROMPT_ARG_BYTES;
  const systemArg = fitsInArgv ? systemPrompt : CLI_BASE_SYSTEM_PROMPT;

  if (!fitsInArgv) {
    warnOnce(
      'cli-system-prompt-overflow',
      `A prompt's instruction block is larger than ${MAX_SYSTEM_PROMPT_ARG_BYTES} bytes, which ` +
        'exceeds the per-argument limit the operating system enforces on exec. It is being sent ' +
        'at the head of the message instead of as --system-prompt. Behaviour is equivalent.'
    );
  }

  const argv = [
    '-p',
    // stream-json rather than json so a turn that is cut off still yields the
    // events that arrived, and so rate-limit and retry events are visible
    // while the turn is in flight rather than only after it ends.
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose', // required by stream-json
    '--model',
    options.model,
    '--effort',
    options.effort,
    // No tools at all. The answer is text; a tool call is a way for the turn
    // to end without one.
    '--tools',
    '',
    // The operator's CLAUDE.md, skills, plugins, hooks, MCP servers and custom
    // settings are not part of this task and could only steer it. Auth,
    // model selection and permissions still work normally.
    '--safe-mode',
    '--strict-mcp-config',
    '--disable-slash-commands',
    // Nothing may block waiting for a human who is not there.
    '--permission-prompts',
    'none',
    // Every call is one stateless completion. Without this the CLI writes a
    // transcript per call into the config directory and never removes it.
    '--no-session-persistence',
    '--system-prompt',
    systemArg,
  ];

  if (options.jsonSchema) {
    argv.push('--json-schema', JSON.stringify(options.jsonSchema));
  }
  if (options.fallbackModels?.length) {
    // Handles an overloaded or unavailable model inside the CLI, which is one
    // round trip cheaper than discovering it here and spawning again.
    argv.push('--fallback-model', options.fallbackModels.join(','));
  }
  if (options.maxBudgetUsd && options.maxBudgetUsd > 0) {
    argv.push('--max-budget-usd', String(options.maxBudgetUsd));
  }

  return {
    argv,
    systemPromptOverflow: fitsInArgv ? '' : systemPrompt,
  };
}
