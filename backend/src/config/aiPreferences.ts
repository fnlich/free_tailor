import { EFFORT_LEVELS, isEffortLevel, type EffortLevel } from '../services/ai/types';
import { DEFAULT_CLI_EFFORT } from '../services/ai/providers/claudeCli/options';
import { resolveRequestedAIModel, resolveStoredAIModelPreference } from './aiModelConfig';
import type { AIProvider } from '../types/template';

/**
 * How hard the model is asked to work, and whether it may think first.
 *
 * Two knobs, because the CLI really has two and they are not the same thing.
 *
 * `--effort` is a documented flag (low, medium, high, xhigh, max) and is the
 * depth control: how much reasoning the model spends before answering.
 *
 * Thinking is separate, adaptive, and already ON - the models decide per turn
 * whether to think, and measurably do: the same prompt run repeatedly produced
 * a thinking block about two thirds of the time with nothing configured.
 * `MAX_THINKING_TOKENS=0` suppressed it on every run. So the honest control is
 * "let the model decide" versus "don't", which is what these two values are.
 * There is deliberately no third "more thinking" option: raising the budget
 * could not be shown to change anything, and a setting that does nothing is
 * worse than no setting.
 */
export const THINKING_MODES = ['default', 'off'] as const;
export type ThinkingMode = (typeof THINKING_MODES)[number];

export function isThinkingMode(value: unknown): value is ThinkingMode {
  return typeof value === 'string' && (THINKING_MODES as readonly string[]).includes(value);
}

/**
 * What a profile, or one generate request, asks for.
 *
 * Every field is optional and an absent field means INHERIT, never "off" -
 * that is what lets the same type describe every layer without a separate
 * "unset" sentinel per field.
 */
export type AiPreferences = {
  /** An `AIModelRecord` id, as configured under Admin -> Models. */
  modelId?: string;
  effort?: EffortLevel;
  thinking?: ThinkingMode;
};

/** The label shown wherever a layer inherits rather than chooses. */
export const INHERIT_VALUE = '';

/** Keeps only values this build understands; anything else inherits. */
export function normalizeAiPreferences(raw: unknown): AiPreferences {
  if (!raw || typeof raw !== 'object') return {};
  const record = raw as Record<string, unknown>;
  const preferences: AiPreferences = {};

  const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : '';
  if (modelId) preferences.modelId = modelId;
  if (isEffortLevel(record.effort)) preferences.effort = record.effort;
  if (isThinkingMode(record.thinking)) preferences.thinking = record.thinking;

  return preferences;
}

/**
 * Later layers win, field by field.
 *
 * Field by field and not object by object: a request that overrides only the
 * effort must keep the profile's model, which a whole-object precedence would
 * throw away.
 */
export function mergeAiPreferences(...layers: Array<AiPreferences | undefined>): AiPreferences {
  const merged: AiPreferences = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.modelId) merged.modelId = layer.modelId;
    if (layer.effort) merged.effort = layer.effort;
    if (layer.thinking) merged.thinking = layer.thinking;
  }
  return merged;
}

/**
 * The effort used when neither the request nor the profile names one.
 *
 * Read from the same `AI_CLI_EFFORT` the provider itself reads, so the value
 * offered as "the app default" in the UI is the value that will actually be
 * used rather than a second opinion about it.
 */
export function appDefaultEffort(env: NodeJS.ProcessEnv = process.env): EffortLevel {
  const configured = (env.AI_CLI_EFFORT ?? '').trim();
  return isEffortLevel(configured) ? configured : DEFAULT_CLI_EFFORT;
}

/** Thinking when nothing names it: whatever the model does on its own. */
export const APP_DEFAULT_THINKING: ThinkingMode = 'default';

export type AiPreferenceDefaults = {
  effort: EffortLevel;
  thinking: ThinkingMode;
  effortLevels: readonly EffortLevel[];
  thinkingModes: readonly ThinkingMode[];
};

/** What the UI needs to label the inherit option and populate the selects. */
export function describeAiPreferenceDefaults(
  env: NodeJS.ProcessEnv = process.env
): AiPreferenceDefaults {
  return {
    effort: appDefaultEffort(env),
    thinking: APP_DEFAULT_THINKING,
    effortLevels: EFFORT_LEVELS,
    thinkingModes: THINKING_MODES,
  };
}

/**
 * A resolved choice: what the model layer is actually asked for.
 *
 * Bundled rather than passed as four positional arguments, because it travels
 * through every generation path and the two new fields would otherwise have to
 * be threaded onto fourteen call sites that already carry `(provider,
 * modelName)` and would silently drop them wherever one was missed.
 */
export type AiChoice = {
  provider: AIProvider;
  /** The model name the provider understands, e.g. `sonnet`. */
  modelName: string;
  /** The `AIModelRecord` id it came from, for logs and for the UI. */
  modelId: string;
  modelLabel: string;
  effort?: EffortLevel;
  thinking?: ThinkingMode;
};

/**
 * Resolves the choice for one call: request override, then profile, then the
 * app default.
 *
 * `profile` is optional because one call in a batch is not per profile - the
 * job description is analysed once and shared - and that call has no profile
 * whose preference could apply.
 */
export async function resolveAiChoice(
  overrides: AiPreferences | undefined,
  profile?: { profileSettings?: { ai?: AiPreferences } } | null
): Promise<AiChoice> {
  const profilePreferences = normalizeAiPreferences(profile?.profileSettings?.ai);
  const overridePreferences = normalizeAiPreferences(overrides);
  const preferences = mergeAiPreferences(profilePreferences, overridePreferences);

  // The two ids are resolved differently on purpose. One was chosen for this
  // run and must be honoured or refused; the other was stored on a profile
  // some time ago, and a provider locked since then makes it stale rather than
  // wrong - see resolveStoredAIModelPreference.
  const model = overridePreferences.modelId
    ? await resolveRequestedAIModel(overridePreferences.modelId)
    : await resolveStoredAIModelPreference(profilePreferences.modelId);
  return {
    provider: model.provider,
    modelName: model.modelName,
    modelId: model.id,
    modelLabel: model.name,
    effort: preferences.effort,
    thinking: preferences.thinking,
  };
}

/** One line for the generation logs, so a run says what it ran with. */
export function describeAiChoice(choice: AiChoice): string {
  const parts = [`${choice.provider}/${choice.modelName}`];
  if (choice.effort) parts.push(`effort=${choice.effort}`);
  if (choice.thinking) parts.push(`thinking=${choice.thinking}`);
  return parts.join(' ');
}
