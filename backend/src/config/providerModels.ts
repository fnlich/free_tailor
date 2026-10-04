import type { AIProvider } from '../types/template';
import { isClaudeCliModelName } from '../services/ai/providers/claudeCli/modelNames';
import { isGeminiModelName } from '../services/ai/providers/geminiCli/options';
import { envList, type EnvSource } from './envValue';
// Type-only, so nothing is loaded at runtime: config/operational.ts imports
// PROVIDER_MODEL_OPTION_SETTINGS from here without the two requiring each other.
import type { OperationalVariable } from './operational';

/**
 * The model names an administrator may pick for each seat.
 *
 * Admin -> Models used to take the model name as free text, which made every
 * typo a record that failed at generate time - and for the Claude seat not
 * even then: `resolveCliModel` swaps a name the CLI would not serve for the
 * default with one log line, so the record ran on a model nobody chose. A
 * select over a list closes that, and the server checks the same list, so a
 * page that sends something else is refused rather than trusted.
 *
 * The lists are the CLIs' own names, read out of the releases this was built
 * against (Claude Code 2.1.289, Codex 0.160.0's bundled catalog, Gemini CLI
 * 0.62.0). Which of them a given account may use is decided by its plan,
 * server-side - nothing here can know it - so an operator can replace any list
 * with `AI_CLI_MODEL_OPTIONS`, `AI_CODEX_MODEL_OPTIONS` or
 * `AI_GEMINI_MODEL_OPTIONS`.
 *
 * Only ever checked when an administrator CHOOSES a model name: creating a
 * record, changing one's provider or model, saving a prompt override. A stored
 * record is never checked against a list, because the list comes from `.env`
 * and can change under it; a narrowed list must not take every settings read
 * down with it. Such a record keeps running, and the admin page flags it.
 */

export type ProviderModelOption = {
  /** What is stored on the record and passed to the CLI. */
  value: string;
  /** What the admin form shows. */
  label: string;
};

/** One seat's list, as the admin settings payload carries it. */
export type ProviderModelOptions = {
  provider: AIProvider;
  label: string;
  models: ProviderModelOption[];
};

/**
 * Each seat's default list, in the order the form offers it - the first is what
 * a provider switch resets to.
 *
 * `default` on the Codex seat is required, not a choice like the others: it is
 * the sentinel the argv builder turns into "no `-m`" (the account's own model),
 * and the seed record `codex-cli-default` names it. The user-facing names
 * "chatgpt-astro" and "chatgpt-luna" do not exist in Codex 0.160.0; `gpt-6-astra`
 * and `gpt-6-luna` are the real ones.
 */
const DEFAULT_OPTIONS: Readonly<Record<AIProvider, readonly ProviderModelOption[]>> = {
  'claude-cli': [
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'opus', label: 'Opus' },
    { value: 'haiku', label: 'Haiku' },
    { value: 'fable', label: 'Fable' },
  ],
  'codex-cli': [
    { value: 'default', label: 'Account default' },
    { value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
    { value: 'gpt-6-astra', label: 'GPT-6-Astra' },
    { value: 'gpt-6-sol', label: 'GPT-6-Sol' },
    { value: 'gpt-6-luna', label: 'GPT-6-Luna' },
    { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
    { value: 'gpt-5.5', label: 'GPT-5.5' },
  ],
  'gemini-cli': [
    { value: 'auto', label: 'Auto' },
    { value: 'pro', label: 'Pro' },
    { value: 'flash', label: 'Flash' },
    { value: 'flash-lite', label: 'Flash-Lite' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
    { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' },
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)' },
  ],
};

/**
 * Labels for names an operator is likely to list that the defaults leave out.
 * Anything in neither table is shown as written.
 */
const EXTRA_LABELS: Readonly<Record<AIProvider, Readonly<Record<string, string>>>> = {
  'claude-cli': { default: 'Account default', 'sonnet[1m]': 'Sonnet (1M context)' },
  'codex-cli': {},
  'gemini-cli': { 'gemini-2.5-flash': 'Gemini 2.5 Flash' },
};

/** The variable that replaces each seat's list. */
export const PROVIDER_MODEL_OPTION_VARIABLES: Readonly<Record<AIProvider, string>> = Object.freeze({
  'claude-cli': 'AI_CLI_MODEL_OPTIONS',
  'codex-cli': 'AI_CODEX_MODEL_OPTIONS',
  'gemini-cli': 'AI_GEMINI_MODEL_OPTIONS',
});

/** One entry's shape: a CLI model name, `[1m]`-style suffixes included. */
const MODEL_OPTION_ENTRY = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,63}$/;

/**
 * Names a seat's CLI would not run as written, refused in an override for the
 * reason the list exists at all. The Claude seat swaps any other name for its
 * default (`resolveCliModel`) and the Gemini seat does the same
 * (`resolveGeminiModel`), each with only a log line - so a listed name either
 * would have run a different model than the one picked. Codex is handed any
 * name as it is, and refuses what the account cannot use when it runs.
 */
const SEAT_RULE: Readonly<Record<AIProvider, { accept?: (entry: string) => boolean; expected: string }>> = {
  'claude-cli': {
    accept: isClaudeCliModelName,
    expected: 'a Claude CLI model name (an alias such as sonnet, or a full claude-... id)',
  },
  'codex-cli': { expected: 'a Codex model name' },
  'gemini-cli': {
    accept: isGeminiModelName,
    expected: 'a Gemini CLI model name (auto, pro, flash, flash-lite, gemini-..., gemma-...)',
  },
};

function isSeat(provider: unknown): provider is AIProvider {
  return typeof provider === 'string' && Object.prototype.hasOwnProperty.call(DEFAULT_OPTIONS, provider);
}

function labelFor(provider: AIProvider, value: string): string {
  const lower = value.toLowerCase();
  const known = DEFAULT_OPTIONS[provider].find((option) => option.value.toLowerCase() === lower);
  if (known) return known.label;
  const extra = Object.entries(EXTRA_LABELS[provider]).find(([name]) => name.toLowerCase() === lower);
  return extra ? extra[1] : value;
}

/**
 * The model names offered for `provider`, in order: its override when that is
 * set and every entry in it is acceptable, otherwise the default list. Read on
 * each call, so a test can hand in its own environment. Duplicates - including
 * two spellings of one name, which the case-insensitive match could not tell
 * apart - keep the first. An unknown provider has none.
 */
export function listProviderModelOptions(
  provider: AIProvider,
  env: EnvSource = process.env
): ProviderModelOption[] {
  if (!isSeat(provider)) return [];
  const defaults = DEFAULT_OPTIONS[provider];
  const rule = SEAT_RULE[provider];
  const values = envList(
    PROVIDER_MODEL_OPTION_VARIABLES[provider],
    defaults.map((option) => option.value),
    { pattern: MODEL_OPTION_ENTRY, accept: rule.accept, expected: rule.expected },
    env
  );

  const seen = new Set<string>();
  const options: ProviderModelOption[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ value, label: labelFor(provider, value) });
  }
  return options;
}

/**
 * The option `modelName` names on `provider`, matched case-insensitively, or
 * null. The match is what gets stored, so `Sonnet` typed in a request is saved
 * as the CLI's `sonnet`.
 */
export function findProviderModelOption(
  provider: AIProvider,
  modelName: string,
  env: EnvSource = process.env
): ProviderModelOption | null {
  const wanted = modelName.trim().toLowerCase();
  if (!wanted) return null;
  return listProviderModelOptions(provider, env).find((option) => option.value.toLowerCase() === wanted) ?? null;
}

/** "sonnet, opus, haiku, fable" - the values, for a message naming what is allowed. */
export function describeProviderModelOptions(provider: AIProvider, env: EnvSource = process.env): string {
  return listProviderModelOptions(provider, env)
    .map((option) => option.value)
    .join(', ');
}

/**
 * The three overrides as operational-table entries. Read per call: Admin ->
 * Models reads the list each time it loads, so a restart is all a change needs.
 */
export const PROVIDER_MODEL_OPTION_SETTINGS: readonly OperationalVariable[] = (
  Object.keys(PROVIDER_MODEL_OPTION_VARIABLES) as AIProvider[]
).map((provider) => ({
  name: PROVIDER_MODEL_OPTION_VARIABLES[provider],
  defaultValue: DEFAULT_OPTIONS[provider].map((option) => option.value).join(','),
  side: 'backend' as const,
  readAt: 'per-call' as const,
  readIn: 'config/providerModels.ts (served on GET /api/admin/settings; checked by Admin -> Models and Prompts)',
  current: (env: EnvSource) =>
    listProviderModelOptions(provider, env)
      .map((option) => option.value)
      .join(','),
}));
