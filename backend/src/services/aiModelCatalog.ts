import type { AIProvider } from '../types/template';
import {
  AI_PROVIDER_IDS,
  coerceProviderId,
  isRetiredModelId,
  isRetiredProviderId,
} from '../config/providerCatalog';

export const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.1';
export const DEFAULT_CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
export const DEFAULT_DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
/**
 * The `--model` value the CLI provider uses when nothing else names one.
 * An alias rather than a dated model name, so it follows the current release.
 */
export const DEFAULT_CLAUDE_CLI_MODEL = process.env.AI_CLI_MODEL || 'sonnet';

const warnedRetiredOverrides = new Set<string>();

export function normalizePromptModelSelection(
  provider: unknown,
  modelName: unknown
): { provider: AIProvider; modelName: string } | null {
  const normalizedProvider = typeof provider === 'string' ? provider.trim() : '';
  const normalizedModelName = typeof modelName === 'string' ? modelName.trim() : '';

  if (!normalizedProvider && !normalizedModelName) {
    return null;
  }

  // An override naming a removed provider is NO override: the prompt runs on
  // whatever model the caller resolved, which is what clearing it would do.
  // Never a throw, because this is also the READ path - listing prompts has no
  // per-record catch, so one stored override pinned to a browser chat site would
  // take down Admin -> Prompts, and on a shipped prompt every generation that
  // uses it. Migration 006 clears these; this keeps a row it has not reached yet
  // (or one a restored backup brought back) harmless. See RETIRED_PROVIDER_IDS.
  if (isRetiredProviderId(normalizedProvider) || isRetiredModelId(normalizedModelName)) {
    const key = `${normalizedProvider}/${normalizedModelName}`;
    if (!warnedRetiredOverrides.has(key)) {
      warnedRetiredOverrides.add(key);
      console.warn(
        `[prompts] A prompt's model override names "${key}", on the browser chat providers, which were ` +
          'removed; it is ignored and those prompts run on the model chosen for the run. Saving the prompt ' +
          'under Admin -> Prompts clears it.'
      );
    }
    return null;
  }

  // Coerced rather than compared, because this runs on the prompt READ path:
  // a stored record naming a provider that no longer exists must resolve, not
  // make listing prompts throw.
  const resolvedProvider = coerceProviderId(normalizedProvider);
  if (!resolvedProvider) {
    throw new Error(`Prompt model provider must be one of: ${AI_PROVIDER_IDS.join(', ')}.`);
  }

  if (!normalizedModelName) {
    throw new Error('Prompt model name is required when a prompt-level model override is set.');
  }

  return {
    provider: resolvedProvider,
    modelName: normalizedModelName,
  };
}
