import { describeDollarProblem, MILLI_PER_DOLLAR, parseDollars } from '../utils/money';

/**
 * The three ways a run builds its resumes, and what each costs per resume.
 *
 * - `suitable` (Choose Suitable Resume): the resume the matcher picks for each
 *   job, built as written; the only model call is the cover letter.
 * - `partial` (Partial Tailor): the matcher's pick, tailored to the posting.
 * - `full` (Fully Tailor): the profile's effective default resume, written
 *   for the posting from its roles' titles, companies and dates alone.
 *
 * The mode belongs to the RUN (`POST /api/generation/batches`' `buildMode`),
 * not to a resume or a model. Each mode has ONE price per resume, an
 * administrator's setting with a `.env` default: `suitablePriceMilli`,
 * `partialPriceMilli` and `fullPriceMilli`, in thousandths of a dollar, so a
 * resume built Partial at $0.023 takes $0.023 off a balance and seven of them
 * $0.161, exactly. A model no longer carries a price: which model runs a
 * resume never changes what it costs.
 *
 * A leaf on purpose. The settings read it to normalize the prices and the run
 * pipeline to name the modes, and neither may import the other.
 */

export const BUILD_MODES = ['suitable', 'partial', 'full'] as const;
export type BuildMode = (typeof BUILD_MODES)[number];

/** What a mode is called to a person: the builder's cards, an order's label, a charge's ledger line. */
export const BUILD_MODE_LABELS: Readonly<Record<BuildMode, string>> = {
  suitable: 'Choose Suitable Resume',
  partial: 'Partial Tailor',
  full: 'Fully Tailor',
};

/** Zero makes a mode free. A free run takes no reservation and writes no ledger row. */
const MIN_BUILD_MODE_PRICE_MILLI = 0;

/**
 * $1000.000. A ceiling, because the value arrives from a form and a field with
 * no ceiling is a field somebody will type 1000000 into - after which every
 * resume built in that mode is refused for want of a balance nobody could hold.
 */
export const MAX_BUILD_MODE_PRICE_MILLI = 1_000_000;

/**
 * The names a mode's price goes by: the setting it is STORED and served under
 * (thousandths), the request field an administrator SENDS it in (dollars) and
 * the `.env` variable that gives it a default. The settings tables are held to
 * this one (config/settingDefaults.ts `APP_SETTING_ENV_VARIABLES`).
 */
export const BUILD_MODE_PRICE_FIELDS: Readonly<
  Record<
    BuildMode,
    {
      setting: 'suitablePriceMilli' | 'partialPriceMilli' | 'fullPriceMilli';
      request: 'suitablePriceUsd' | 'partialPriceUsd' | 'fullPriceUsd';
      env: 'RESUME_SUITABLE_PRICE_USD' | 'RESUME_PARTIAL_PRICE_USD' | 'RESUME_FULL_PRICE_USD';
    }
  >
> = {
  suitable: { setting: 'suitablePriceMilli', request: 'suitablePriceUsd', env: 'RESUME_SUITABLE_PRICE_USD' },
  partial: { setting: 'partialPriceMilli', request: 'partialPriceUsd', env: 'RESUME_PARTIAL_PRICE_USD' },
  full: { setting: 'fullPriceMilli', request: 'fullPriceUsd', env: 'RESUME_FULL_PRICE_USD' },
};

type BuildModePriceSetting =(typeof BUILD_MODE_PRICE_FIELDS)[BuildMode]['setting'];

export function isBuildMode(value: unknown): value is BuildMode {
  return typeof value === 'string' && (BUILD_MODES as readonly string[]).includes(value);
}

/**
 * A price refused, naming the box it came from (`field`, the `...Usd` name it
 * was sent under): PUT /api/admin/settings passes `field` and `code` on, so
 * the page puts the sentence under that price.
 */
export class BuildModePriceError extends Error {
  readonly code: 'bad-price' | 'bad-price-field';
  readonly status = 400 as const;

  constructor(message: string, readonly field: string, code: 'bad-price' | 'bad-price-field' = 'bad-price') {
    super(message);
    this.name = 'BuildModePriceError';
    this.code = code;
  }
}

/** The words every refusal of an administrator's price ends with. */
const PRICE_RULE =
  `from $${MIN_BUILD_MODE_PRICE_MILLI} to $${MAX_BUILD_MODE_PRICE_MILLI / MILLI_PER_DOLLAR} in steps of ` +
  '$0.001, like 0.023; 0 makes it free';

/**
 * An administrator's price for a mode, in DOLLARS (`partialPriceUsd`:
 * "0.023" or the JSON number 0.023), as an exact count of thousandths.
 *
 * A price is required: '' and a missing value are refused (Reset to default is
 * the button that returns to `.env`'s), and so is anything finer than a
 * thousandth, negative or above the ceiling - refused rather than rounded or
 * clamped, because a figure the administrator did not type is a figure every
 * user is then charged.
 */
export function parseBuildModePriceInput(mode: BuildMode, value: unknown): number {
  const { request } = BUILD_MODE_PRICE_FIELDS[mode];
  const label = `The ${BUILD_MODE_LABELS[mode]} price`;
  const parsed = parseDollars(value);
  if (!parsed.ok) {
    throw new BuildModePriceError(`${describeDollarProblem(parsed.problem, label)} It is ${PRICE_RULE}.`, request);
  }
  if (parsed.milli < MIN_BUILD_MODE_PRICE_MILLI || parsed.milli > MAX_BUILD_MODE_PRICE_MILLI) {
    throw new BuildModePriceError(`${label} must be ${PRICE_RULE}.`, request);
  }
  return parsed.milli;
}

/**
 * The refusal of a price sent in thousandths. Every amount a request carries is
 * dollars, in a field ending `Usd`, and a `...Milli` field read as dollars would
 * price a mode a thousand times what was meant.
 */
export function buildModePriceFieldError(mode: BuildMode): BuildModePriceError {
  const { request } = BUILD_MODE_PRICE_FIELDS[mode];
  return new BuildModePriceError(
    `Send the ${BUILD_MODE_LABELS[mode]} price in dollars, as ${request}.`,
    request,
    'bad-price-field'
  );
}

/**
 * A stored price as this app writes one: a whole number of thousandths from 0
 * to the ceiling. Anything else was hand-edited into the row.
 */
export function isStoredBuildModePriceMilli(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_BUILD_MODE_PRICE_MILLI &&
    value <= MAX_BUILD_MODE_PRICE_MILLI
  );
}
