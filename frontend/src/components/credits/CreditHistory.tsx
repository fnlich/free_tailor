'use client';

import { useCallback, useState } from 'react';
import RefundRequestDialog from './RefundRequestDialog';
import TablePager from './TablePager';
import { usePagedList } from './usePagedList';
import styles from './history.module.css';
import { creditsApi, describeLedgerReason, type LedgerEntry } from '@/lib/credits';
import { formatDate } from '@/lib/format';
import { describeLedgerBalance, describeLedgerChange, ledgerDirection } from '@/lib/ledger';
import { refundChargeIdFor } from '@/lib/refundDisplay';

const PAGE_SIZE = 10;
const COLUMNS = ['Date', 'Change', 'Reason', 'Balance After', 'Note', 'Action'];

/**
 * How the list reads. `earnings` is a reporter's (owner decisions A3, A4): the
 * same ledger, titled for what moves on it - job rewards in, payouts recorded
 * by an administrator out - and with no Action column, because a reporter
 * asks for no refunds (the server refuses them one, 403 `role-not-allowed`).
 */
export type CreditHistoryVariant = 'credits' | 'earnings';

const COPY: Record<CreditHistoryVariant, { title: string; lead: string; empty: string; failed: string }> = {
  credits: {
    title: 'Credit History',
    lead: 'Every amount of credit added, spent or given back.',
    empty: 'Nothing has moved yet. Every amount of credit added, spent or given back will be listed here.',
    failed: 'Your credit history could not be loaded.',
  },
  earnings: {
    title: 'Earnings and Payouts',
    lead: 'Every amount you have earned, and every payout an administrator recorded against it.',
    empty: 'Nothing has moved yet. What you earn, and every payout recorded to you, will be listed here.',
    failed: 'Your earnings and payouts could not be loaded.',
  },
};

/**
 * Every movement on the balance, a page at a time, newest first.
 *
 * In dollars to the thousandth - except rows from before credits became
 * dollars, which say what they moved then, in credits (lib/ledger.ts).
 *
 * A charge for resumes offers "Ask for refund" (`refundChargeIdFor`). One
 * charge can pay for a whole run, so the dialog asks which resume - the
 * server lists the run's resumes from the charge's own id. Not in the
 * `earnings` variant, a reporter's, which asks for nothing.
 */
export default function CreditHistory({
  epoch,
  variant = 'credits',
}: {
  epoch: number;
  variant?: CreditHistoryVariant;
}) {
  const copy = COPY[variant];
  const asks = variant === 'credits';
  const columns = asks ? COLUMNS : COLUMNS.filter((column) => column !== 'Action');
  const fetchPage = useCallback(async (offset: number, limit: number) => {
    const response = await creditsApi.ledger(offset, limit);
    return { rows: response.entries, total: response.total, offset: response.offset };
  }, []);
  const list = usePagedList<LedgerEntry>(fetchPage, PAGE_SIZE, epoch);
  /** The charge whose "Ask for refund" was pressed. */
  const [asking, setAsking] = useState<string | null>(null);

  // Sorted on `seq`, not the timestamp: two movements written in the same
  // millisecond tie on `createdAt`. A copy, so the hook's array is untouched.
  const ordered = [...list.rows].sort((left, right) => right.seq - left.seq);

  return (
    <section aria-labelledby="ledger-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="ledger-heading" className="text-2xl font-bold tracking-tight text-ink">
            {copy.title}
          </h2>
          <p className="mt-1 text-sm text-muted">{copy.lead}</p>
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
        <p className="tl-notice mt-4" data-tone="warn" role="status">
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
              {columns.map((column) => (
                <th key={column} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.loaded &&
              ordered.map((entry) => {
                const chargeId = asks ? refundChargeIdFor(entry) : null;
                return (
                  <tr key={entry.id}>
                    <td className="whitespace-nowrap">{formatDate(entry.createdAt, { style: 'short' })}</td>
                    {/* Colours on spans: `.tl-table td` is unlayered and would beat a utility on the cell. */}
                    <td className="whitespace-nowrap tabular-nums">
                      <span
                        className={
                          ledgerDirection(entry) > 0 ? styles.gain : ledgerDirection(entry) < 0 ? styles.loss : undefined
                        }
                      >
                        {describeLedgerChange(entry)}
                      </span>
                    </td>
                    <td>
                      <span className="text-ink">{describeLedgerReason(entry)}</span>
                    </td>
                    <td className="whitespace-nowrap tabular-nums">{describeLedgerBalance(entry)}</td>
                    <td className="break-words">{entry.note || '—'}</td>
                    {asks && (
                      <td>
                        {chargeId ? (
                          <button
                            type="button"
                            onClick={() => setAsking(chargeId)}
                            className="tl-button-quiet whitespace-nowrap"
                            data-size="sm"
                          >
                            Ask for refund
                          </button>
                        ) : null}
                      </td>
                    )}
                  </tr>
                );
              })}
          </tbody>
        </table>
        {/* Below the table, not in a spanning cell - see OrderHistory for why. */}
        {(!list.loaded || ordered.length === 0) && (
          <p className="p-6 text-center text-sm text-muted">
            {!list.loaded ? (
              list.failed ? (
                <>
                  {copy.failed}{' '}
                  <button type="button" onClick={list.retry} className="font-semibold text-accent-ink underline">
                    Try again
                  </button>
                </>
              ) : (
                'Loading…'
              )
            ) : (
              copy.empty
            )}
          </p>
        )}
      </div>

      {asking && <RefundRequestDialog source={{ chargeId: asking }} onClose={() => setAsking(null)} />}
    </section>
  );
}
