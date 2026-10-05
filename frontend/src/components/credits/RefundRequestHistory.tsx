'use client';

import { useCallback } from 'react';
import TablePager from './TablePager';
import { usePagedList } from './usePagedList';
import { formatDate, formatMoney } from '@/lib/format';
import {
  describeRequestOutcome,
  REFUND_STATE_LABELS,
  REFUND_STATE_TONES,
} from '@/lib/refundDisplay';
import { refundRequestsApi, type RefundRequest } from '@/lib/refunds';

const PAGE_SIZE = 10;
const COLUMNS = ['Date', 'Request #', 'For', 'Amount', 'Status', 'Your reason'];

/**
 * This account's refund requests, a page at a time, newest first: what each
 * was for, where it stands, and - once decided - the administrator's reason
 * for a decline or what came back for a refund.
 *
 * Where every notice about a request links (`/credits?tab=refunds`), so the
 * sentence in the bell and the row here say the same thing.
 */
export default function RefundRequestHistory({ epoch }: { epoch: number }) {
  const fetchPage = useCallback(async (offset: number, limit: number) => {
    const response = await refundRequestsApi.list(offset, limit);
    return { rows: response.requests, total: response.total, offset: response.offset };
  }, []);
  const list = usePagedList<RefundRequest>(fetchPage, PAGE_SIZE, epoch);

  return (
    <section aria-labelledby="refunds-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="refunds-heading" className="text-2xl font-bold tracking-tight text-ink">
            Refund Requests
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            What you have asked to have refunded. Ask from a purchase&apos;s Action column, a charge in
            Credit History, or a resume on its order&apos;s page; an administrator decides, and you are told
            in your notifications.
          </p>
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
              {COLUMNS.map((column) => (
                <th key={column} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.loaded && list.rows.map((request) => <RequestRow key={request.id} request={request} />)}
          </tbody>
        </table>
        {/* Below the table, not in a spanning cell - see OrderHistory for why. */}
        {(!list.loaded || list.rows.length === 0) && (
          <p className="p-6 text-center text-sm text-muted">
            {!list.loaded ? (
              list.failed ? (
                <>
                  Your refund requests could not be loaded.{' '}
                  <button type="button" onClick={list.retry} className="font-semibold text-accent-ink underline">
                    Try again
                  </button>
                </>
              ) : (
                'Loading…'
              )
            ) : (
              'No refund requests yet.'
            )}
          </p>
        )}
      </div>
    </section>
  );
}

function RequestRow({ request }: { request: RefundRequest }) {
  const refunded = request.state === 'refunded';
  return (
    <tr>
      <td className="whitespace-nowrap">{formatDate(request.createdAt, { style: 'short' })}</td>
      <td className="whitespace-nowrap">
        <span className="font-mono text-ink">{request.reference}</span>
      </td>
      <td className="min-w-48 break-words">
        <span className="block text-ink">{request.label}</span>
        <span className="mt-0.5 block text-xs text-subtle">{request.kind === 'purchase' ? 'Purchase' : 'Resume'}</span>
      </td>
      {/* What came back once refunded; until then, what was asked. */}
      <td className="whitespace-nowrap tabular-nums">
        {formatMoney(refunded ? request.refundedMilli : request.amountMilli)}
      </td>
      {/* Colours on spans: `.tl-table td` is unlayered and would beat a utility on the cell. */}
      <td className="min-w-56">
        <span className="tl-pill" data-tone={REFUND_STATE_TONES[request.state] ?? 'grey'}>
          {REFUND_STATE_LABELS[request.state] ?? request.state}
        </span>
        <span className="mt-1.5 block whitespace-pre-wrap break-words text-xs text-muted">
          {describeRequestOutcome(request)}
        </span>
      </td>
      <td className="min-w-48 whitespace-pre-wrap break-words">{request.reason}</td>
    </tr>
  );
}
