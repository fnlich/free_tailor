/**
 * What one resume costs, in credits, on a given model.
 *
 * Each model record carries its own `creditsPerResume`, set by an administrator
 * under Admin -> Models. Not called a price anywhere in code: `creditPriceCents`
 * already means what a CREDIT costs in money, and two "prices" a line apart is
 * how one gets multiplied by the other.
 *
 * A leaf on purpose. The model settings read it to normalize a record, and the
 * credit service reads it to know what a resume costs when nothing says, and
 * neither may import the other.
 */

/**
 * What a resume costs when no model says otherwise: a record saved before the
 * field existed, a task queued before it existed, and every seed.
 *
 * One, because one credit per resume is what every install charged before the
 * price became a per-model setting, and an upgrade must not change a bill
 * nobody touched.
 */
export const DEFAULT_CREDITS_PER_RESUME = 1;

/** Zero makes a model free. A free run takes no reservation and writes no ledger row. */
export const MIN_CREDITS_PER_RESUME = 0;

/**
 * A ceiling, because the value arrives from a number input and a field with no
 * ceiling is a field somebody will type 1000000 into - after which every resume
 * on that model is refused for want of credits nobody could hold.
 */
export const MAX_CREDITS_PER_RESUME = 1000;

const warnedStoredValues = new Set<string>();

/**
 * A stored record's price, as the settings READ takes it: absent is the
 * default, out of range clamps, junk is the default. Never throws.
 *
 * Forgiving where an admin's save is strict, for the reason the rest of the
 * stored row is: one hand-edited record refusing to parse would fail every
 * settings read - the model list, every generation, and the very page an
 * administrator would fix it from. Said once in the log rather than silently,
 * so the fix can be found. Nothing is written back; the next save from Admin ->
 * Models writes the value that is in force.
 */
export function readCreditsPerResume(value: unknown, recordId = ''): number {
  if (value === undefined || value === null) return DEFAULT_CREDITS_PER_RESUME;

  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)
        ? Number(value)
        : Number.NaN;
  const read = Number.isFinite(parsed)
    ? Math.min(MAX_CREDITS_PER_RESUME, Math.max(MIN_CREDITS_PER_RESUME, Math.round(parsed)))
    : DEFAULT_CREDITS_PER_RESUME;

  if (read !== value) {
    const key = `${recordId}:${String(value)}`;
    if (!warnedStoredValues.has(key)) {
      warnedStoredValues.add(key);
      console.warn(
        `[models] Stored model "${recordId || '(no id)'}" has creditsPerResume ${JSON.stringify(value)}, ` +
          `which is not a whole number from ${MIN_CREDITS_PER_RESUME} to ${MAX_CREDITS_PER_RESUME}; ` +
          `it is read as ${read}. Saving the model under Admin -> Models stores that.`
      );
    }
  }
  return read;
}

/**
 * An administrator's price for a model they are creating or editing: the
 * fallback when the input leaves the field out - so the enable switch, which
 * sends only `{ enabled }`, keeps the price - and otherwise a whole number in
 * range, or an error naming the field. A number input sends a number, but a
 * digits-only string is taken too; `1.5`, `-1`, `''` and `'two'` are refused
 * rather than rounded into something the administrator did not type.
 */
export function parseCreditsPerResume(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\s*\d+\s*$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < MIN_CREDITS_PER_RESUME || parsed > MAX_CREDITS_PER_RESUME) {
    throw new Error(
      `Price per resume (creditsPerResume) must be a whole number of credits from ${MIN_CREDITS_PER_RESUME} ` +
        `to ${MAX_CREDITS_PER_RESUME}; 0 makes the model free.`
    );
  }
  return parsed;
}
