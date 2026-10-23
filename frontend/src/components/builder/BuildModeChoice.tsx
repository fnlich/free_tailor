'use client';

import { ChoiceCard } from '@/components/subscription/LockedFeature';
import { BUILD_MODE_CHOICES, type BuildMode } from '@/lib/buildModes';
import { formatMoney } from '@/lib/format';

/**
 * How a run builds its resumes: Choose Suitable Resume, Partial Tailor or
 * Fully Tailor, as three `.tl-choice` cards (owner decisions D19-D21). The
 * mode is the RUN's - not a resume's or a model's - and every account may use
 * every mode, so no card is ever locked.
 *
 * Each card says what the mode does and what it costs per resume, from the
 * prices the settings serve (`prices`, thousandths of a dollar; null while
 * they are not known, then the price is left out and the cost line beside the
 * button still quotes the run). A mode priced $0 says "Free.": a free mode
 * takes no credit.
 *
 * A money module: amounts are shown with `formatMoney` and never parsed or
 * rounded here (test/frontendMoney.test.js reads this file).
 */
export default function BuildModeChoice({
  name,
  value,
  onChange,
  prices,
  disabled = false,
}: {
  /** The radios' name, which the end-to-end scripts find them by. */
  name: 'manualBuildMode' | 'sheetsBuildMode' | 'orderBuildMode';
  value: BuildMode;
  onChange: (mode: BuildMode) => void;
  /** The three prices per resume in thousandths of a dollar, or null while unknown. */
  prices: Record<BuildMode, number> | null;
  disabled?: boolean;
}) {
  return (
    // A container query, not a viewport breakpoint: the cards sit in the manual page's 22rem sidebar as
    // well as in wide places (the sheet panel, Find Jobs' dialog), and three across in 312px left each
    // card about 37px of text. They are one per row until their own box is 42rem wide.
    <div className="@container">
      <p className="tl-label">Build mode</p>
      <div className="mt-2 grid gap-2 @2xl:grid-cols-3" role="radiogroup" aria-label="Build mode">
        {BUILD_MODE_CHOICES.map((choice) => (
          <ChoiceCard
            key={choice.value}
            name={name}
            value={choice.value}
            checked={value === choice.value}
            onSelect={() => onChange(choice.value)}
            disabled={disabled}
            hint={priceHint(choice.description, prices ? prices[choice.value] : null)}
          >
            {choice.label}
          </ChoiceCard>
        ))}
      </div>
    </div>
  );
}

/** The card's muted line: what the mode does, then what a resume costs in it. */
function priceHint(description: string, priceMilli: number | null): string {
  if (priceMilli === null || priceMilli === undefined) return description;
  return `${description} ${priceMilli === 0 ? 'Free.' : `${formatMoney(priceMilli)} a resume.`}`;
}
