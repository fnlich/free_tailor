'use client';

/**
 * First / previous / next / last over a server-paged table, and the sentence
 * that says where in it you are.
 *
 * Driven by `offset` and `count` as they describe the rows ON SCREEN, never by
 * what was last asked for - see `usePagedList` for why the two differ. The
 * buttons are `.tl-button-quiet`, which carries no utility the dark-mode shim
 * names, so there is no `dark:` anywhere here.
 */
export default function TablePager({
  total,
  offset,
  count,
  pageSize,
  onChange,
}: {
  /** Rows altogether, as the server counted them. */
  total: number;
  /** Where the rows on screen start. */
  offset: number;
  /** How many rows are on screen. */
  count: number;
  pageSize: number;
  onChange: (offset: number) => void;
}) {
  const atStart = offset <= 0;
  const atEnd = offset + pageSize >= total;
  const lastOffset = total > 0 ? Math.floor((total - 1) / pageSize) * pageSize : 0;

  let summary = '';
  if (count > 0) summary = `Showing ${offset + 1}–${offset + count} of ${total}`;
  else if (total > 0) summary = `${total} in all`;

  return (
    <div className="flex flex-col items-start gap-1.5 sm:items-end">
      <div className="flex items-center gap-2" role="group" aria-label="Pages">
        <button type="button" className="tl-button-quiet" disabled={atStart} onClick={() => onChange(0)}>
          First
        </button>
        <button
          type="button"
          className="tl-button-quiet"
          aria-label="Previous page"
          disabled={atStart}
          onClick={() => onChange(Math.max(0, offset - pageSize))}
        >
          <span aria-hidden className="text-lg leading-none">&lsaquo;</span>
        </button>
        <button
          type="button"
          className="tl-button-quiet"
          aria-label="Next page"
          disabled={atEnd}
          onClick={() => onChange(offset + pageSize)}
        >
          <span aria-hidden className="text-lg leading-none">&rsaquo;</span>
        </button>
        <button
          type="button"
          className="tl-button-quiet"
          disabled={atEnd}
          onClick={() => onChange(lastOffset)}
        >
          Last
        </button>
      </div>
      {/*
        Announced, because a press changes a table somebody may not be looking
        at directly, and this line is the only thing that says it did anything
        when the rows look alike.
      */}
      <p className="min-h-4 text-xs text-subtle tabular-nums" aria-live="polite">
        {summary}
      </p>
    </div>
  );
}
