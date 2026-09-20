import { getDb } from './sqlite';

/**
 * Human-readable reference numbers, one sequence per day.
 *
 * `FT-20260920-0007`, `FT-PAY-20260920-0003` - short enough to read down a
 * phone, dated so support can find it, and sequential so the tenth of the day
 * is obviously the tenth. Shared by orders and payments because both are things
 * somebody quotes back at you, and the arithmetic below has one trap in it that
 * is not worth falling into twice.
 *
 * The caller owns the UNIQUE index. This function makes a collision very
 * unlikely; the index is what makes one an error rather than two records
 * answering to one name.
 */

const ALLOWED_TABLES = new Set(['orders', 'payments']);
const ALLOWED_COLUMNS = new Set(['number', 'reference']);

/** The `YYYYMMDD` part, in the server's own zone. */
export function formatSequenceDate(at: Date): string {
  const year = at.getFullYear();
  const month = `${at.getMonth() + 1}`.padStart(2, '0');
  const day = `${at.getDate()}`.padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * The next reference for a day, taken from the highest already issued.
 *
 * MAX rather than COUNT, because COUNT reissues a number the moment ANY row
 * for that day goes: delete the third of five and the sixth record is handed
 * `0005`, which already exists. MAX narrows that to the one case nothing here
 * performs - deleting the newest of a day - and the UNIQUE index makes even
 * that a caught error. A gap costs nothing; a duplicate is the number somebody
 * quotes back at you meaning two different things.
 *
 * And the MAX is NUMERIC, which is the trap. `MAX(reference)` is a string
 * maximum over a zero-padded field, so the moment a day issues its
 * ten-thousandth record `'...-10000'` sorts BELOW `'...-9999'`: MAX keeps
 * answering 9999, every retry collides with the UNIQUE index, and the last one
 * throws - failing that record and every other record for the rest of the day.
 * Casting the suffix makes the comparison the one that was always meant, and
 * leaves the padding as presentation rather than something correctness rests on.
 */
export function nextDailyReference(
  table: 'orders' | 'payments',
  column: 'number' | 'reference',
  prefix: string,
  datePart: string
): string {
  /*
   * Checked at runtime, not only at compile time.
   *
   * `table` and `column` are interpolated into SQL, where a parameter cannot
   * stand. The union above says what is allowed and TypeScript enforces it -
   * until a plain JavaScript caller, an `as` cast, or a future call that
   * forwards something from a request erases it. The type is the documentation;
   * this is the check.
   */
  if (!ALLOWED_TABLES.has(table) || !ALLOWED_COLUMNS.has(column)) {
    throw new Error('nextDailyReference was given a table or column it does not know.');
  }

  const stem = `${prefix}${datePart}-`;
  const row = getDb()
    .prepare(
      `SELECT MAX(CAST(substr(${column}, @suffixFrom) AS INTEGER)) AS highest
       FROM ${table} WHERE ${column} LIKE @pattern`
    )
    .get({ pattern: `${stem}%`, suffixFrom: stem.length + 1 }) as
    | { highest: number | null }
    | undefined;

  const highest = typeof row?.highest === 'number' ? row.highest : 0;
  const next = highest > 0 ? highest + 1 : 1;
  return `${stem}${`${next}`.padStart(4, '0')}`;
}
