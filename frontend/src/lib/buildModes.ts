/**
 * The three ways a run builds its resumes. A copy of the server's
 * config/buildModes.ts (modes, labels, the setting each price is served
 * under), held to it by a drift test. It imports nothing, so a test can load
 * it alone.
 *
 * The mode belongs to the RUN, not to a resume or a model, and each mode has
 * one price per resume (an administrator's setting).
 */

export const BUILD_MODES = ['suitable', 'partial', 'full'] as const;
export type BuildMode = (typeof BUILD_MODES)[number];

export function isBuildMode(value: unknown): value is BuildMode {
  return typeof value === 'string' && (BUILD_MODES as readonly string[]).includes(value);
}

/** What a mode is called to a person. */
export const BUILD_MODE_LABELS: Readonly<Record<BuildMode, string>> = {
  suitable: 'Choose Suitable Resume',
  partial: 'Partial Tailor',
  full: 'Fully Tailor',
};

/** The setting each mode's price is served under (thousandths of a dollar). */
export const BUILD_MODE_PRICE_SETTINGS: Readonly<
  Record<BuildMode, 'suitablePriceMilli' | 'partialPriceMilli' | 'fullPriceMilli'>
> = {
  suitable: 'suitablePriceMilli',
  partial: 'partialPriceMilli',
  full: 'fullPriceMilli',
};

/** The cards the builder and Find Jobs' order dialog draw, in the server's mode order. */
export const BUILD_MODE_CHOICES: ReadonlyArray<{ value: BuildMode; label: string; description: string }> = [
  {
    value: 'suitable',
    label: BUILD_MODE_LABELS.suitable,
    description:
      'For each job, the resume whose keywords match the posting best, built as written. Only its cover letter is written by AI.',
  },
  {
    value: 'partial',
    label: BUILD_MODE_LABELS.partial,
    description:
      "The best-matching resume, with job-friendly changes for the posting's keywords. Your own summary and each role's description and achievements are rewritten; a role you left empty is written from the posting.",
  },
  {
    value: 'full',
    label: BUILD_MODE_LABELS.full,
    description:
      "The profile's default resume, with the summary, experience and skills written for the posting from each role's company, title and dates, with plausible figures. Read it before you send it.",
  },
];
