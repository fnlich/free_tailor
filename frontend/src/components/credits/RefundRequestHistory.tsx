'use client';

import { useCallback } from 'react';
import TablePager from './TablePager';
import { usePagedList } from './usePagedList';
import { ContactAdminLink } from '@/components/contact/ContactAdminDialog';
import { formatDate, formatMoney } from '@/lib/format';
import { describeRequestOutcome, refundKindLabel, refundStateLabel, REFUND_STATE_TONES } from '@/lib/refundDisplay';
import { refundRequestsApi, type RefundRequest } from '@/lib/refunds';

const PAGE_SIZE = 10;

/**
 * Which list this is. `requests` is a user's (or an administrator's): the
 * refund requests they made before asking for refunds was removed (owner
 * decision R1), read-only. `payouts` is a reporter's: the payout requests
 * they made with Ask for Refund, listed under it on their Credits page.
 */
export type RefundHistoryVariant = 'requests' | 'payouts';

const COPY: Record<RefundHistoryVariant, { title: string; empty: string; failed: string; reasonColumn: string }> = {
  requests: {
    title: 'Refund Requests',
    empty: 'No refund requests.',
    failed: 'Your refund requests could not be loaded.',
    reasonColumn: 'Your reason',
  },
  payouts: {
    title: 'Payout requests',
    empty: 'No payout requests yet. Ask for Refund, above, asks an administrator to pay out your balance.',
    failed: 'Your payout requests could not be loaded.',
    reasonColumn: 'Your note',
  },
};

/**
 * This account's refund or payout requests, a page at a time, newest first:
 * what each was for, where it stands, and - once decided - the
 * administrator's reason for a decline, or what came back (or was paid out).
 *
 * Where every notice about a request links - `/credits?tab=refunds` for a
 * user's, `/credits` for a reporter's - so the sentence in the bell and the row
 * here say the same thing.
 */
export default function RefundRequestHistory({
  epoch,
  variant = 'requests',
}: {
  epoch: number;
  variant?: RefundHistoryVariant;
}) {
  const copy = COPY[variant];
  const payouts = variant === 'payouts';
  const fetchPage = useCallback(
    async (offset: number, limit: number) => {
      // A reporter's own list is their payouts; a user's is everything they asked.
      const response = await refundRequestsApi.list(offset, limit, undefined, payouts ? 'payout' : undefined);
      return { rows: response.requests, total: response.total, offset: response.offset };
    },
    [payouts]
  );
  const list = usePagedList<RefundRequest>(fetchPage, PAGE_SIZE, epoch);
  const columns = payouts
    ? ['Date', 'Request #', 'Amount', 'Status', copy.reasonColumn]
    : ['Date', 'Request #', 'For', 'Amount', 'Status', copy.reasonColumn];

  return (
    <section aria-labelledby="refunds-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="refunds-heading" className="text-2xl font-bold tracking-tight text-ink">
            {copy.title}
          </h2>
          {payouts ? (
            <p className="mt-1 max-w-2xl text-sm text-muted">
              What you have asked to be paid out. An administrator records each payout with what they actually
              sent, and you are told in your notifications.
            </p>
          ) : (
            <p className="mt-1 max-w-2xl text-sm text-muted">
              What you asked to have refunded before refunds stopped being asked for in the app. If you think a
              purchase or a resume should be refunded, contact your administrator. <ContactAdminLink />
            </p>
          )}
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
              list.rows.map((request) => <RequestRow key={request.id} request={request} showItem={!payouts} />)}
          </tbody>
        </table>
        {/* Below the table, not in a spanning cell - see OrderHistory for why. */}
        {(!list.loaded || list.rows.length === 0) && (
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
    </section>
  );
}

function RequestRow({ request, showItem }: { request: RefundRequest; showItem: boolean }) {
  const refunded = request.state === 'refunded';
  return (
    <tr>
      <td className="whitespace-nowrap">{formatDate(request.createdAt, { style: 'short' })}</td>
      <td className="whitespace-nowrap">
        <span className="font-mono text-ink">{request.reference}</span>
      </td>
      {showItem && (
        <td className="min-w-48 break-words">
          <span className="block text-ink">{request.label}</span>
          <span className="mt-0.5 block text-xs text-subtle">{refundKindLabel(request.kind)}</span>
        </td>
      )}
      {/*
        What came back once refunded - for a payout, what was recorded as paid,
        which may be more than was asked; until then, what was asked.
      */}
      <td className="whitespace-nowrap tabular-nums">
        {formatMoney(refunded ? request.refundedMilli : request.amountMilli)}
      </td>
      {/* Colours on spans: `.tl-table td` is unlayered and would beat a utility on the cell. */}
      <td className="min-w-56">
        <span className="tl-pill" data-tone={REFUND_STATE_TONES[request.state] ?? 'grey'}>
          {refundStateLabel(request)}
        </span>
        <span className="mt-1.5 block whitespace-pre-wrap break-words text-xs text-muted">
          {describeRequestOutcome(request)}
        </span>
      </td>
      <td className="min-w-48 whitespace-pre-wrap break-words">
        {request.reason || <span className="text-subtle">&mdash;</span>}
      </td>
    </tr>
  );
}
