import {
  resolveRequestedAIModel,
  resolveStoredAIModelPreference,
  type AIModelRecord,
  type ModelRequestOptions,
} from './aiModelConfig';
import type { AIProvider } from '../types/template';

/**
 * What a run is asked to use.
 *
 * Only the model now. Two knobs stood beside it and both are gone for the same
 * reason: `thinking` reached one provider, and `effort` reached one provider,
 * so on every other model in the menu they were select boxes that changed
 * nothing and said nothing. A stored value for either is IGNORED rather than
 * rejected - a profile that still carries one must keep working, not take its
 * owner's builder down over a dead key.
 */

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
};

/** The label shown wherever a layer inherits rather than chooses. */

/** Keeps only values this build understands; anything else inherits. */
export function normalizeAiPreferences(raw: unknown): AiPreferences {
  if (!raw || typeof raw !== 'object') return {};
  const record = raw as Record<string, unknown>;
  const preferences: AiPreferences = {};

  const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : '';
  if (modelId) preferences.modelId = modelId;

  return preferences;
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
};

/**
 * The model record one call runs on: request override, then profile, then the
 * app default.
 *
 * The two ids are resolved differently on purpose. One was chosen for this run
 * and must be honoured or refused; the other was stored on a profile some time
 * ago, and one that cannot run any more is stale rather than wrong - see
 * resolveStoredAIModelPreference. A model on a removed provider is neither:
 * whichever layer names one, it runs on the app default.
 */
async function resolveAiModel(
  overrides: AiPreferences | undefined,
  profile: { profileSettings?: { ai?: AiPreferences } } | null | undefined,
  options: ModelRequestOptions
): Promise<AIModelRecord> {
  const profilePreferences = normalizeAiPreferences(profile?.profileSettings?.ai);
  const overridePreferences = normalizeAiPreferences(overrides);
  return overridePreferences.modelId
    ? resolveRequestedAIModel(overridePreferences.modelId, options)
    : resolveStoredAIModelPreference(profilePreferences.modelId);
}

function toChoice(model: AIModelRecord): AiChoice {
  return {
    provider: model.provider,
    modelName: model.modelName,
    modelId: model.id,
    modelLabel: model.name,
  };
}

/**
 * Resolves the choice for one call: request override, then profile, then the
 * app default.
 *
 * `profile` is optional because one call in a batch is not per profile - the
 * job description is analysed once and shared - and that call has no profile
 * whose preference could apply. `options.admin` is the viewer's role, which
 * decides the forms a request override may take (see ModelRequestOptions).
 */
export async function resolveAiChoice(
  overrides: AiPreferences | undefined,
  profile?: { profileSettings?: { ai?: AiPreferences } } | null,
  options: ModelRequestOptions = {}
): Promise<AiChoice> {
  return toChoice(await resolveAiModel(overrides, profile, options));
}

/**
 * A choice, and what one resume built on it costs.
 *
 * Two fields rather than a price inside the choice. The choice is written onto
 * a queued task and can be resolved AGAIN after a restart - a task queued
 * before a provider was retired is moved onto the default model - and a price
 * carried inside it would be re-priced along with it. What a resume costs is
 * decided once, when it is asked for and charged, and stays what was charged.
 */
export type PricedAiChoice = {
  choice: AiChoice;
  /** `creditsPerResume` of the model the choice landed on, at the moment it was resolved. */
  creditCost: number;
};

/**
 * `resolveAiChoice`, plus the price of a resume on the model it resolved to.
 * Every path that charges for a resume resolves through this, so the price is
 * always that of the model the resume actually runs on.
 */
export async function resolvePricedAiChoice(
  overrides: AiPreferences | undefined,
  profile?: { profileSettings?: { ai?: AiPreferences } } | null,
  options: ModelRequestOptions = {}
): Promise<PricedAiChoice> {
  const model = await resolveAiModel(overrides, profile, options);
  return { choice: toChoice(model), creditCost: model.creditsPerResume };
}

/** One line for the generation logs, so a run says what it ran with. */
export function describeAiChoice(choice: AiChoice): string {
  return `${choice.provider}/${choice.modelName}`;
}
