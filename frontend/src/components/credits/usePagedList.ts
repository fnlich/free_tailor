'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** One page as a list endpoint answers it, whatever it calls its rows. */
export type PageAnswer<Row> = { rows: Row[]; total: number; offset: number };

/**
 * One server-paged table: what was asked for, what is on screen, and the race
 * between them.
 *
 * Both histories on /credits page the same way, so the rules live here once:
 *
 *  - **One guard token per list.** Pressing Next twice quickly leaves two
 *    requests in flight and the slower one must not win. Each table calls this
 *    hook for itself, so a ledger request can never cancel a payments one.
 *  - **`shown` is not what was asked for.** A page request that fails leaves
 *    the rows alone on purpose - a failed page is not an empty history - but
 *    the request has already moved. Driving the pager from the request would
 *    put rows 1-10 on screen under "11-20 of 23". `shown` comes from the
 *    server's own `offset`, so the pager always describes the rows below it.
 *  - **`epoch` sends it back to the first page** without unmounting it. The
 *    credits page bumps it after a purchase, because the row a buyer wants to
 *    see is the one they just made, and it is at the top. The rows already on
 *    screen stay until the new ones arrive, so nothing flashes empty.
 */
export function usePagedList<Row>(
  fetchPage: (offset: number, limit: number) => Promise<PageAnswer<Row>>,
  pageSize: number,
  epoch = 0
) {
  /*
   * A fresh object on every request, including a repeat of the same offset:
   * that is what makes "Try again" and a second press after a failure run the
   * effect again rather than being swallowed as no change.
   */
  const [asked, setAsked] = useState({ offset: 0, epoch });
  const offset = asked.epoch === epoch ? asked.offset : 0;

  const [rows, setRows] = useState<Row[]>([]);
  const [shown, setShown] = useState(0);
  const [total, setTotal] = useState(0);
  /** Whether any page has arrived yet - "loading" and "empty" look alike otherwise. */
  const [loaded, setLoaded] = useState(false);
  /** Whether the LATEST request failed. Rows from an earlier one may still be up. */
  const [failed, setFailed] = useState(false);

  const latest = useRef(0);

  useEffect(() => {
    const token = ++latest.current;
    fetchPage(offset, pageSize).then(
      (answer) => {
        if (token !== latest.current) return;
        setRows(answer.rows);
        setShown(answer.offset);
        setTotal(answer.total);
        setLoaded(true);
        setFailed(false);
      },
      () => {
        if (token === latest.current) setFailed(true);
      }
    );
    // `asked` and `epoch` rather than `offset` alone: asking for the same page
    // twice still asks twice, and a new epoch reloads even a list that was
    // already on its first page - which is the case that matters after a
    // purchase.
  }, [fetchPage, pageSize, offset, asked, epoch]);

  const goTo = useCallback((next: number) => setAsked({ offset: next, epoch }), [epoch]);
  const retry = useCallback(() => setAsked((current) => ({ ...current })), []);

  return { rows, shown, total, loaded, failed, goTo, retry };
}
