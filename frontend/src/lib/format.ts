/**
 * Rendering a server timestamp for a reader.
 *
 * Seven pages had written their own `formatDate`, and they disagreed in three
 * ways that all turned out to be deliberate: what an absent value shows, what
 * an unreadable one shows, and how much of the date to print. Those are the two
 * options below, so one function covers all seven rather than seven functions
 * covering one each.
 *
 * Every timestamp reaching this comes from the API as an ISO string, and the
 * output is the VIEWER's locale - deliberately, because these are read by the
 * person the row belongs to. The server formats in `en-US` where it has to name
 * an amount in a log; that is the other direction and stays separate.
 */

export type DateStyle =
  /** Date and time, the default: `27/09/2026, 14:03:12`. */
  | 'full'
  /** Date only, for a column where the time is noise: `27/09/2026`. */
  | 'date'
  /** Compact date and time for a dense list: `27 Sep, 14:03`. */
  | 'short';

export function formatDate(
  value?: string,
  options: { empty?: string; style?: DateStyle } = {}
): string {
  /*
   * Nothing to format. `empty` is what to say instead - "Never" for a
   * last-seen column, "-" for a table cell - and where a caller names none the
   * value is handed back untouched, which is what the callers taking a
   * non-optional string always did.
   */
  if (!value) return options.empty ?? '';

  /*
   * An unreadable timestamp shows the raw string, NOT "Invalid Date".
   *
   * Six of the seven copies guarded this; `admin/prompts` did not, and rendered
   * the literal words `Invalid Date` to an administrator - which says nothing
   * about which row is wrong. The raw value at least identifies it.
   */
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;

  if (options.style === 'date') return at.toLocaleDateString();
  if (options.style === 'short') {
    return at.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return at.toLocaleString();
}
