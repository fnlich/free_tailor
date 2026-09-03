import type { AIProvider } from '../types/template';

export const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.1';
export const DEFAULT_OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-5.4-nano';
export const DEFAULT_CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
export const DEFAULT_DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

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

  if (
    normalizedProvider !== 'openai' &&
    normalizedProvider !== 'claude' &&
    normalizedProvider !== 'openrouter' &&
    normalizedProvider !== 'deepseek'
  ) {
    throw new Error('Prompt model provider must be one of: openai, claude, openrouter, deepseek.');
  }

  if (!normalizedModelName) {
    throw new Error('Prompt model name is required when a prompt-level model override is set.');
  }

  return {
    provider: normalizedProvider,
    modelName: normalizedModelName,
  };
}
