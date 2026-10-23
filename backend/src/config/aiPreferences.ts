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
 * rejected - a resume that still carries one must keep working, not take its
 * owner's builder down over a dead key.
 */

/**
 * What a resume, or one generate request, asks for.
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
 * The model record one call runs on: request override, then resume, then the
 * app default.
 *
 * The two ids are resolved differently on purpose. One was chosen for this run
 * and must be honoured or refused; the other was stored on a resume some time
 * ago, and one that cannot run any more is stale rather than wrong - see
 * resolveStoredAIModelPreference. A model on a removed provider is neither:
 * whichever layer names one, it runs on the app default.
 */
async function resolveAiModel(
  overrides: AiPreferences | undefined,
  resume: { resumeSettings?: { ai?: AiPreferences } } | null | undefined,
  options: ModelRequestOptions
): Promise<AIModelRecord> {
  const resumePreferences = normalizeAiPreferences(resume?.resumeSettings?.ai);
  const overridePreferences = normalizeAiPreferences(overrides);
  return overridePreferences.modelId
    ? resolveRequestedAIModel(overridePreferences.modelId, options)
    : resolveStoredAIModelPreference(resumePreferences.modelId);
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
 * Resolves the choice for one call: request override, then resume, then the
 * app default.
 *
 * `resume` is optional because one call in a batch is not per resume - the
 * job description is analysed once and shared - and that call has no resume
 * whose preference could apply. `options.admin` is the viewer's role, which
 * decides the forms a request override may take (see ModelRequestOptions).
 */
export async function resolveAiChoice(
  overrides: AiPreferences | undefined,
  resume?: { resumeSettings?: { ai?: AiPreferences } } | null,
  options: ModelRequestOptions = {}
): Promise<AiChoice> {
  return toChoice(await resolveAiModel(overrides, resume, options));
}

/*
 * No price lives here any more. What a resume costs is the price of the build
 * mode it is built in (config/buildModes.ts, `getBuildModePrices`), worked out
 * by services/resumeChoice.ts `priceRun`; the model a resume runs on never
 * changes it, so a choice is only ever a model.
 */

/** One line for the generation logs, so a run says what it ran with. */
export function describeAiChoice(choice: AiChoice): string {
  return `${choice.provider}/${choice.modelName}`;
}
