import type { AdminAppSettings, AIModelRecord, AIProvider, ProviderModelNameOption } from '@/lib/api';

/**
 * The Admin -> Models form's choices, kept apart from the page so they can be
 * tested without React (see backend/test/frontendHelpers.test.js). Imports
 * nothing at runtime.
 */

type DraftSettings = Pick<AdminAppSettings, 'aiModels' | 'providerModelOptions'>;

/** The model names a seat offers, from the server's list for it. */
export function optionsFor(settings: DraftSettings, provider: AIProvider): ProviderModelNameOption[] {
  return settings.providerModelOptions.find((entry) => entry.provider === provider)?.models ?? [];
}

/**
 * Whether another record already uses this provider and model name.
 *
 * The server refuses a second record for the same pair - it is how a request
 * naming `provider:modelName` resolves to exactly one model - so the form marks
 * those options rather than letting a save fail over them.
 */
export function isTaken(
  settings: DraftSettings,
  provider: AIProvider,
  modelName: string,
  exceptId: string | null
): boolean {
  const wanted = modelName.toLowerCase();
  return settings.aiModels.some(
    (model) => model.id !== exceptId && model.provider === provider && model.modelName.toLowerCase() === wanted
  );
}

/**
 * The model name a provider switch lands on: the seat's first option no other
 * record uses. Empty when every one is taken - the select then shows "Choose a
 * model" rather than preselecting an option it has disabled, which could only
 * be saved into the duplicate refusal - and for a seat the server listed no
 * names for.
 */
export function firstModelName(settings: DraftSettings, provider: AIProvider, exceptId: string | null): string {
  return optionsFor(settings, provider).find((option) => !isTaken(settings, provider, option.value, exceptId))?.value ?? '';
}

/**
 * Where a blank form starts: the first seat, in catalog order, with a model
 * name no record uses yet, on that name. Every name on every seat taken: the
 * first seat, with no name chosen.
 */
export function blankDraftChoice(settings: DraftSettings | null): { provider: AIProvider; modelName: string } {
  const seats = settings?.providerModelOptions ?? [];
  for (const entry of seats) {
    const modelName = firstModelName(settings!, entry.provider, null);
    if (modelName) return { provider: entry.provider, modelName };
  }
  return { provider: seats[0]?.provider ?? 'claude-cli', modelName: '' };
}

/**
 * Another record that already goes by this display name, compared the way
 * people read it - trimmed, any case. Users see display names and nothing
 * else, so two records sharing one are two identical choices at different
 * prices; the server refuses it, and the form says so first.
 */
export function displayNameOwner(
  settings: Pick<AdminAppSettings, 'aiModels'>,
  name: string,
  exceptId: string | null
): AIModelRecord | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  return settings.aiModels.find((model) => model.id !== exceptId && model.name.trim().toLowerCase() === wanted) ?? null;
}
