'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import TablePager from './TablePager';
import { usePagedList } from './usePagedList';
import { formatDate } from '@/lib/format';
import {
  formatAmount,
  isPaymentSettled,
  type Payment,
  type PaymentMethod,
  paymentsApi,
  type PaymentState,
  STATE_TONES,
} from '@/lib/payments';

const PAGE_SIZE = 10;

/**
 * The word each state gets in this table; its colour is STATE_TONES, shared
 * with the return page and the administrator's list.
 *
 * Its own map rather than `STATE_LABELS`, which the order page and the admin
 * list share and which says "Waiting for payment" where a column of pills
 * wants one word. Keyed by the union, so a state added to the API without an
 * entry here is a compile error rather than a blank pill.
 */
const STATUS: Record<PaymentState, string> = {
  paid: 'Completed',
  pending: 'Pending',
  failed: 'Failed',
  expired: 'Expired',
  refunding: 'Refunding',
  refunded: 'Refunded',
};

const COPY: Record<PaymentMethod, { heading: string; blurb: string; empty: string; label: string }> = {
  card: {
    heading: 'Card Orders History',
    blurb: 'A list of all your card purchase transactions.',
    empty: 'No card purchases yet.',
    label: 'Card',
  },
  crypto: {
    heading: 'Crypto Orders History',
    blurb: 'A list of all your crypto purchase transactions.',
    empty: 'No crypto purchases yet.',
    label: 'Crypto',
  },
};

const COLUMNS = ['Date', 'Order #', 'Method', 'Amount', 'Paid', 'Credits Received', 'Status', 'Action(s)'];

/**
 * One method's orders, a page at a time.
 *
 * The credits page mounts this keyed on the method, so switching between Card
 * and Crypto starts the other list fresh on its first page rather than at the
 * offset the first one had reached.
 */
export default function OrderHistory({ method, epoch }: { method: PaymentMethod; epoch: number }) {
  const fetchPage = useCallback(
    async (offset: number, limit: number) => {
      const response = await paymentsApi.list(offset, limit, method);
      return { rows: response.payments, total: response.total, offset: response.offset };
    },
    [method]
  );
  const list = usePagedList<Payment>(fetchPage, PAGE_SIZE, epoch);
  const copy = COPY[method];

  return (
    <section aria-labelledby="orders-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="orders-heading" className="text-2xl font-bold tracking-tight text-ink">
            {copy.heading}
          </h2>
          <p className="mt-1 text-sm text-muted">{copy.blurb}</p>
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
            {list.loaded && list.rows.map((payment) => <OrderRow key={payment.id} payment={payment} />)}
          </tbody>
        </table>
        {/*
          Below the table rather than in a full-width cell. On a phone the table
          is wider than the screen and scrolls inside this box, so a message in
          a spanning cell was centred on the SCROLLED width - "No card purch"
          and a Try again button off the edge. A block child of the scroll box
          is as wide as what is visible.
        */}
        {(!list.loaded || list.rows.length === 0) && (
          <p className="p-6 text-center text-sm text-muted">
            {!list.loaded ? (
              list.failed ? (
                <>
                  Your orders could not be loaded.{' '}
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

function OrderRow({ payment }: { payment: Payment }) {
  const label = STATUS[payment.state] ?? payment.state;
  const tone = STATE_TONES[payment.state] ?? 'grey';
  const settled = isPaymentSettled(payment);
  const id = encodeURIComponent(payment.id);

  return (
    <tr>
      <td className="whitespace-nowrap">{formatDate(payment.createdAt, { style: 'short' })}</td>
      <td className="whitespace-nowrap">
        <Link
          href={`/credits/return?payment=${id}`}
          className="font-medium text-accent-ink underline underline-offset-2"
        >
          {payment.reference}
        </Link>
      </td>
      <td>{payment.method === 'crypto' ? 'Crypto' : 'Card'}</td>
      {/* On a span: `.tl-table td` is unlayered and would beat a utility on the cell. */}
      <td className="whitespace-nowrap">
        <span className="text-ink">{payment.credits} Credits</span>
      </td>
      {/*
        Under "Paid", only what was paid. A pending, failed or expired order
        took no money, and its price here read as a charge - the cell beside it
        and the invoice's Amount Paid already say nothing for the same reason.
      */}
      <td className="whitespace-nowrap tabular-nums">
        {settled ? formatAmount(payment.amountCents, payment.currency) : '—'}
      </td>
      <td className="tabular-nums">
        {/*
          What was GRANTED, falling back to what was quoted for every row
          written before a fee could reduce it. Nothing until the payment
          settles: a pending order has received nothing yet, and a number here
          would say it had.
        */}
        {settled ? payment.creditsGranted || payment.credits : '—'}
      </td>
      <td>
        <span className="tl-pill" data-tone={tone}>
          {label}
        </span>
      </td>
      <td>
        <div className="flex flex-col gap-2">
          {settled ? (
            <Link
              href={`/credits/invoice?payment=${id}`}
              target="_blank"
              rel="noreferrer"
              className="tl-button-quiet"
            >
              Invoice
            </Link>
          ) : (
            /*
              The title sits on a wrapper because a disabled button receives no
              pointer events, and in some browsers shows no tooltip of its own.
            */
            <span title="An invoice is issued once the payment completes" className="flex">
              <button type="button" disabled className="tl-button-quiet pointer-events-none flex-1">
                Invoice
              </button>
            </span>
          )}
          <Link href={`/credits/return?payment=${id}`} className="tl-button-quiet">
            Help
          </Link>
        </div>
      </td>
    </tr>
  );
}
