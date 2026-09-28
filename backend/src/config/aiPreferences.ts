import {
  isHybridSelection,
  resolveRequestedAIModel,
  resolveStoredAIModelPreference,
} from './aiModelConfig';
import type { FreeChatRoute } from '../services/ai/freeChatRouting';
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
 * Later layers win, field by field.
 *
 * Field by field rather than object by object. It reads as overkill with one
 * field, and it is the shape that stays correct when a second one is added -
 * a whole-object precedence silently throws away everything the later layer
 * did not mention.
 */
export function mergeAiPreferences(...layers: Array<AiPreferences | undefined>): AiPreferences {
  const merged: AiPreferences = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.modelId) merged.modelId = layer.modelId;
  }
  return merged;
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
  /**
   * Set only when the choice was Hybrid.
   *
   * `provider` above already names the account this call is going to, chosen by
   * the router. This says the choice was "either account", which is what lets
   * the executor move to the other one when this one is out of messages - a
   * single-account choice must fail instead, because somebody picked it.
   */
  route?: FreeChatRoute;
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

  // Read from what was ASKED FOR, not from the record that came back. Hybrid
  // resolves to one of the two free accounts, so by the time the record exists
  // it is indistinguishable from having picked that account outright - and that
  // difference is the whole of what hybrid means.
  //
  // Asked of the layer below rather than of `preferences.modelId` alone,
  // because an absent model means INHERIT: a profile that has never chosen runs
  // on the app default, and an install whose default is Hybrid has every such
  // profile on Hybrid.
  const hybrid = await isHybridSelection(preferences.modelId);

  return {
    provider: model.provider,
    modelName: model.modelName,
    modelId: model.id,
    modelLabel: hybrid ? `${model.name} (hybrid)` : model.name,
    ...(hybrid ? { route: 'hybrid' as const } : {}),
  };
}

/** One line for the generation logs, so a run says what it ran with. */
export function describeAiChoice(choice: AiChoice): string {
  const parts = [`${choice.provider}/${choice.modelName}`];
  if (choice.route) parts.push(`route=${choice.route}`);
  return parts.join(' ');
}
