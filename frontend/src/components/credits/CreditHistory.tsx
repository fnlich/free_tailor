'use client';

import { useCallback } from 'react';
import TablePager from './TablePager';
import { usePagedList } from './usePagedList';
import styles from './history.module.css';
import { creditsApi, describeLedgerReason, formatDelta, type LedgerEntry } from '@/lib/credits';
import { formatDate } from '@/lib/format';

const PAGE_SIZE = 10;
const COLUMNS = ['Date', 'Change', 'Reason', 'Balance After', 'Note'];

/** Every movement on the balance, a page at a time, newest first. */
export default function CreditHistory({ epoch }: { epoch: number }) {
  const fetchPage = useCallback(async (offset: number, limit: number) => {
    const response = await creditsApi.ledger(offset, limit);
    return { rows: response.entries, total: response.total, offset: response.offset };
  }, []);
  const list = usePagedList<LedgerEntry>(fetchPage, PAGE_SIZE, epoch);

  // Sorted on `seq`, not the timestamp: two movements written in the same
  // millisecond tie on `createdAt`. A copy, so the hook's array is untouched.
  const ordered = [...list.rows].sort((left, right) => right.seq - left.seq);

  return (
    <section aria-labelledby="ledger-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="ledger-heading" className="text-2xl font-bold tracking-tight text-ink">
            Credit History
          </h2>
          <p className="mt-1 text-sm text-muted">Every credit added, spent or given back.</p>
        </div>
        <TablePager
          total={list.total}
          offset={list.shown}
          count={list.rows.length}
          pageSize={PAGE_SIZE}
          onChange={list.goTo}
        />
      </div>

      {list.failed && list.loaded && (
        <p className={`${styles.notice} mt-4`} data-tone="warn" role="status">
          That page could not be loaded, so these are the rows from before.{' '}
          <button type="button" onClick={list.retry} className="font-semibold underline">
            Try again
          </button>
        </p>
      )}

      <div className="tl-table-box mt-6">
        <table className="tl-table">
          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <th key={column} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!list.loaded ? (
              <tr>
                <td colSpan={COLUMNS.length} className="text-center">
                  {list.failed ? (
                    <>
                      Your credit history could not be loaded.{' '}
                      <button type="button" onClick={list.retry} className="font-semibold text-accent-ink underline">
                        Try again
                      </button>
                    </>
                  ) : (
                    'Loading…'
                  )}
                </td>
              </tr>
            ) : ordered.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} className="text-center">
                  Nothing has moved yet. Every credit added, spent or given back will be listed here.
                </td>
              </tr>
            ) : (
              ordered.map((entry) => (
                <tr key={entry.id}>
                  <td className="whitespace-nowrap">{formatDate(entry.createdAt, { style: 'short' })}</td>
                  {/* Colours on spans: `.tl-table td` is unlayered and would beat a utility on the cell. */}
                  <td>
                    <span className={entry.delta > 0 ? styles.gain : entry.delta < 0 ? styles.loss : undefined}>
                      {formatDelta(entry.delta)}
                    </span>
                  </td>
                  <td>
                    <span className="text-ink">{describeLedgerReason(entry)}</span>
                  </td>
                  <td className="tabular-nums">{entry.balanceAfter}</td>
                  <td className="break-words">{entry.note || '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
