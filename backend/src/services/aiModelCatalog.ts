import type { AIProvider } from '../types/template';
import { AI_PROVIDER_IDS, coerceProviderId, getProviderLabel } from '../config/providerCatalog';
import { describeProviderModelOptions, findProviderModelOption } from '../config/providerModels';

/**
 * The `--model` value the CLI provider uses when nothing else names one.
 * An alias rather than a dated model name, so it follows the current release.
 */
export const DEFAULT_CLAUDE_CLI_MODEL = process.env.AI_CLI_MODEL || 'sonnet';

export function normalizePromptModelSelection(
  provider: unknown,
  modelName: unknown
): { provider: AIProvider; modelName: string } | null {
  const normalizedProvider = typeof provider === 'string' ? provider.trim() : '';
  const normalizedModelName = typeof modelName === 'string' ? modelName.trim() : '';

  if (!normalizedProvider && !normalizedModelName) {
    return null;
  }

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

const warnedUnreadableOverrides = new Set<string>();

/**
 * A prompt's model override as a STORED record holds it - the read path.
 *
 * Never a throw: listing prompts has no per-record catch, so one stored
 * override this build cannot read - a provider that no longer exists, written
 * by hand or by a build long gone - would take down Admin -> Prompts, and on a
 * shipped prompt every run that uses it. Such an override is NO override: the
 * prompt runs on the model the caller resolved, which is what clearing it
 * would do, and the log says so once. Saving the prompt clears it.
 */
export function readStoredPromptModelSelection(
  provider: unknown,
  modelName: unknown,
  promptId: string
): { provider: AIProvider; modelName: string } | null {
  try {
    return normalizePromptModelSelection(provider, modelName);
  } catch (error) {
    const key = `${promptId}:${String(provider)}/${String(modelName)}`;
    if (!warnedUnreadableOverrides.has(key)) {
      warnedUnreadableOverrides.add(key);
      console.warn(
        `[prompts] The prompt "${promptId}" has a model override this build cannot use ` +
          `(${String(provider)}/${String(modelName)}: ${error instanceof Error ? error.message : String(error)}); ` +
          'it runs on the model chosen for the run instead. Saving the prompt under Admin -> Prompts clears it.'
      );
    }
    return null;
  }
}

/**
 * A prompt's model override as an administrator SAVES it: the read-path
 * normalizer above, plus the model name checked against the seat's options
 * (config/providerModels) and stored in the option's spelling - the same rule
 * Admin -> Models applies to a record.
 *
 * `current` is what the prompt holds now. An override saved unchanged is not
 * asked about the list, for the reason a model record is not: one saved before
 * the lists existed, or that a narrowed `.env` list no longer names, must not
 * stop the prompt's text being edited. Kept off the read path entirely, which
 * stays list-agnostic so a `.env` change can never take Admin -> Prompts down.
 */
export function normalizePromptModelOverride(
  provider: unknown,
  modelName: unknown,
  current?: { provider?: unknown; modelName?: unknown } | null
): { provider: AIProvider; modelName: string } | null {
  const selection = normalizePromptModelSelection(provider, modelName);
  if (!selection) {
    return null;
  }

  const currentProvider = typeof current?.provider === 'string' ? coerceProviderId(current.provider) : null;
  const currentModelName = typeof current?.modelName === 'string' ? current.modelName.trim() : '';
  if (
    currentProvider === selection.provider &&
    currentModelName &&
    currentModelName.toLowerCase() === selection.modelName.toLowerCase()
  ) {
    return { provider: selection.provider, modelName: currentModelName };
  }

  const option = findProviderModelOption(selection.provider, selection.modelName);
  if (!option) {
    throw new Error(
      `"${selection.modelName}" is not one of the ${getProviderLabel(selection.provider)} models: ` +
        `${describeProviderModelOptions(selection.provider)}.`
    );
  }
  return { provider: selection.provider, modelName: option.value };
}
