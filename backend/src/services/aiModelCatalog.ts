import type { AIProvider } from '../types/template';
import {
  AI_PROVIDER_IDS,
  coerceProviderId,
  getProviderLabel,
  RETIRED_FAMILY_DESCRIPTION,
  RETIRED_FAMILY_MIGRATION,
  retiredModelFamily,
  retiredProviderFamily,
} from '../config/providerCatalog';
import { describeProviderModelOptions, findProviderModelOption } from '../config/providerModels';

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
  // per-record catch, so one stored override pinned to a retired provider would
  // take down Admin -> Prompts, and on a shipped prompt every generation that
  // uses it. Migrations 006 and 007 clear these; this keeps a row neither has
  // reached yet (or one a restored backup brought back) harmless. See
  // RETIRED_PROVIDER_IDS.
  const family = retiredProviderFamily(normalizedProvider) ?? retiredModelFamily(normalizedModelName);
  if (family) {
    const key = `${normalizedProvider}/${normalizedModelName}`;
    if (!warnedRetiredOverrides.has(key)) {
      warnedRetiredOverrides.add(key);
      console.warn(
        `[prompts] A prompt's model override names "${key}", on the ${RETIRED_FAMILY_DESCRIPTION[family]}, ` +
          'which were removed; it is ignored and those prompts run on the model chosen for the run. Saving ' +
          `the prompt under Admin -> Prompts clears it, as migration ${RETIRED_FAMILY_MIGRATION[family]} does.`
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
