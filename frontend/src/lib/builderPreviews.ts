/**
 * Small decisions the builder makes about its multi-profile previews, kept
 * apart from the page so they can be tested without React (see
 * backend/test/frontendHelpers.test.js). Imports nothing at runtime.
 */

type PreviewLike = { profileId: string; tailoredContent?: unknown };

/**
 * The profiles whose previews are ready to finalise, as one string.
 *
 * A string so it can be a hook dependency that only changes when the SET does:
 * the previews array gets a new identity on every keystroke in the JSON editor
 * and every time the form resets, and the cost line used to re-ask the server
 * for a price on each one.
 */
export function readyPreviewKey(previews: readonly PreviewLike[]): string {
  return previews
    .filter((preview) => preview.tailoredContent)
    .map((preview) => preview.profileId)
    .join(',');
}

/**
 * What is left to finalise after a run: the previews that did not become a
 * resume. The ones that did are gone, so finalising again cannot build - and
 * charge for - them a second time.
 */
export function keepUnbuiltPreviews<T extends PreviewLike>(
  previews: readonly T[],
  failedProfileIds: readonly string[]
): T[] {
  const failed = new Set(failedProfileIds);
  return previews.filter((preview) => failed.has(preview.profileId));
}
