import type { AIProvider } from '../types/template';
import { AI_PROVIDER_IDS, coerceProviderId } from '../config/providerCatalog';

export const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.1';
export const DEFAULT_CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
export const DEFAULT_DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
/**
 * The `--model` value the CLI provider uses when nothing else names one.
 * An alias rather than a dated model name, so it follows the current release.
 */
export const DEFAULT_CLAUDE_CLI_MODEL = process.env.AI_CLI_MODEL || 'sonnet';

export type AIModelOption = {
  id: string;
  label: string;
  provider: AIProvider;
  modelName: string;
  description: string;
};

export function normalizePromptModelSelection(
  provider: unknown,
  modelName: unknown
): { provider: AIProvider; modelName: string } | null {
  const normalizedProvider = typeof provider === 'string' ? provider.trim() : '';
  const normalizedModelName = typeof modelName === 'string' ? modelName.trim() : '';

  if (!normalizedProvider && !normalizedModelName) {
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
