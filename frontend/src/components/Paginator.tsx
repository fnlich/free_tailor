'use client';

import { useId } from 'react';

/**
 * How many rows, which page, and how many there are altogether.
 *
 * One component for both lists on the credits page, because two copies of
 * "which page am I on" drift - and because the sentence in the middle is the
 * whole point of the exercise. A list that shows the newest N and says nothing
 * about the rest is not a history; it is a window that looks like one. This is
 * what makes the difference visible.
 *
 * **One callback, not two.** The page size and the offset cannot be changed
 * independently: growing the page while staying at offset 40 can land past the
 * end, and the list comes back empty with no way back except Previous. Emitting
 * both together makes that state unreachable rather than something every caller
 * has to remember to avoid.
 *
 * Offset paging over a newest-first list can repeat a row when new rows arrive
 * while somebody is on page two. That is inherent to counting from the end that
 * moves, it is what the admin list already does, and the alternative - a cursor
 * on `(created_at, rowid)` - buys nothing here: these lists are read once and
 * the cost of the repeat is seeing a payment twice, not miscounting money.
 *
 * Nothing here carries a `dark:` variant, for the reason `credits/chrome.ts`
 * sets out at length: the `html.dark` shim in `globals.css` is unlayered and
 * beats every `dark:` utility outright. The tokens (`text-muted`, `text-ink`,
 * `border-line`) re-resolve on their own. The `<select>` is the exception worth
 * knowing about - the shim restyles bare `select` elements in dark mode, so the
 * classes below are what it looks like in LIGHT mode and the shim handles the
 * other one. That is the same bargain `chrome.ts`'s `FIELD` makes.
 */

export const PAGE_SIZES = [5, 10, 20, 100] as const;

export type PageState = { offset: number; pageSize: number };

export default function Paginator({
  total,
  offset,
  pageSize,
  noun,
  onChange,
}: {
  total: number;
  offset: number;
  pageSize: number;
  /** Plural, lowercase: "payments", "movements". Used in the count sentence. */
  noun: string;
  onChange: (next: PageState) => void;
}) {
  const selectId = useId();

  /*
   * Nothing to say when everything fits in the smallest page anybody could
   * choose. A size selector and two dead buttons under a three-row list is
   * furniture, and this page already has plenty.
   */
  if (total <= PAGE_SIZES[0]) return null;

  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + pageSize, total);
  const atStart = offset <= 0;
  const atEnd = offset + pageSize >= total;

  const button =
    'rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-muted ' +
    'transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-45 ' +
    'disabled:hover:bg-transparent';

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
      <div className="flex items-center gap-2">
        <label htmlFor={selectId} className="text-xs text-subtle">
          Rows
        </label>
        <select
          id={selectId}
          value={pageSize}
          // Back to the first page, always. Keeping the offset while the page
          // grows is how you land past the end and get an empty list.
          onChange={(event) => onChange({ offset: 0, pageSize: Number(event.target.value) })}
          className="rounded-lg border border-gray-300 px-2 py-1 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </div>

      {/*
        Announced, because pressing Next changes a list somebody may not be
        looking at directly - and this sentence is the only thing that says the
        press did anything at all when the rows below look alike.
      */}
      <p className="text-xs text-subtle" aria-live="polite">
        {first}&ndash;{last} of {total} {noun}
      </p>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onChange({ offset: Math.max(0, offset - pageSize), pageSize })}
          disabled={atStart}
          className={button}
        >
          Newer
        </button>
        <button
          type="button"
          onClick={() => onChange({ offset: offset + pageSize, pageSize })}
          disabled={atEnd}
          className={button}
        >
          Older
        </button>
      </div>
    </div>
  );
}
