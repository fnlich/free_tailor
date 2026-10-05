import type { AdminAppSettings, AIModelRecord } from '@/lib/api';
import { describeDollarProblem, formatMoney, parseDollars } from '@/lib/format';

/**
 * A model's price on the Admin -> Models form: what the box may hold, and
 * which models are free. Kept apart from the page so it can be tested without
 * React (backend/test/frontendMoney.test.js); its one runtime import is
 * lib/format.ts.
 *
 * A price is dollars per resume to the thousandth - "0.023" is 23 thousandths
 * - from $0.000 to $1,000.000, and 0 makes the model free. There is NO default:
 * the server refuses a new model without a price, and the box starts empty so
 * nobody saves a figure they did not choose.
 */

/** The most a resume may cost: $1,000.000. The backend's MAX_PRICE_PER_RESUME_MILLI. */
const MAX_PRICE_MILLI = 1_000_000;

/** The words every refusal of a price ends with - the server's own (config/pricePerResume.ts). */
const PRICE_RULE =
  `from ${formatMoney(0)} to ${formatMoney(MAX_PRICE_MILLI)} in steps of $0.001, like 0.023; ` +
  '0 makes the model free';

export type PriceDraft = { ok: true; milli: number } | { ok: false; message: string };

/**
 * The typed price as the server will read it, or the sentence it would refuse
 * it with - word for word, an empty box included (the page sends '' rather
 * than leaving the field out, so an edit cannot clear a price by accident). Refused rather than rounded - "0.0235", "-1", "1001", "two" - for
 * the server's reason: a price is money, and a figure the administrator did not
 * type is a figure every user is then charged. The page sends what was TYPED,
 * and the server parses it again.
 */
export function readPriceDraft(text: string): PriceDraft {
  const parsed = parseDollars(text);
  if (!parsed.ok) {
    return { ok: false, message: `${describeDollarProblem(parsed.problem, 'Price per resume')} It is ${PRICE_RULE}.` };
  }
  if (parsed.milli > MAX_PRICE_MILLI) {
    return { ok: false, message: `Price per resume must be ${PRICE_RULE}.` };
  }
  return { ok: true, milli: parsed.milli };
}

/**
 * The models anybody can pick that cost nothing, in the library's order - the
 * red notice's list.
 *
 * The server's `freeEnabledModelIds` decides, so the page lists exactly what
 * the server would charge nothing for; a record is looked up for its name.
 */
export function freeEnabledModels(
  settings: Pick<AdminAppSettings, 'aiModels' | 'freeEnabledModelIds'>
): AIModelRecord[] {
  const free = new Set(settings.freeEnabledModelIds);
  return settings.aiModels.filter((model) => free.has(model.id));
}
