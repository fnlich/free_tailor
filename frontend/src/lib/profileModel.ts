/**
 * The model choice a profile save sends, kept apart from the form so it can be
 * tested without React (see backend/test/frontendHelpers.test.js). Imports
 * nothing at runtime.
 */

type ModelChoice = { modelId?: string };

/**
 * A choice that is no longer on offer is sent back UNCHANGED when it is the one
 * already stored: the server accepts an unchanged choice, and runs the profile
 * on the app default until the model is offered again - a model unticked for
 * an afternoon, a seat switched off or locked. Clearing it here made every
 * profile edited meanwhile lose its model for good, with nothing said.
 *
 * Only a choice that is unavailable AND differs from what is stored - an
 * imported or duplicated profile, a new one - is saved as "inherit", because
 * the server refuses to save a new choice this account cannot pick. The picker
 * offers a stale id only as its disabled "Unavailable model" entry, so the
 * person can still change it, never newly pick it.
 */
export function savableModelChoice<T extends ModelChoice>(
  choice: T,
  context: { modelsLoaded: boolean; offeredIds: readonly string[]; storedModelId?: string }
): T | Record<string, never> {
  if (!context.modelsLoaded || !choice.modelId) return choice;
  if (context.offeredIds.includes(choice.modelId)) return choice;
  if (choice.modelId === context.storedModelId) return choice;
  return {};
}
