'use client';

import { Suspense, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { ApiResponseError } from '@/lib/api';
import { formatDate } from '@/lib/format';
import {
  formatAmount,
  isPaymentSettled,
  paymentsApi,
  type Payment,
  type PaymentState,
} from '@/lib/payments';
import styles from './invoice.module.css';

const STATUS_WORDS: Record<PaymentState, string> = {
  paid: 'Paid',
  pending: 'Pending',
  failed: 'Failed',
  expired: 'Expired',
  refunding: 'Refund in progress',
  refunded: 'Refunded',
};

/** What a load came back with, tagged with the id it was for. */
type Loaded = { id: string; payment: Payment } | { id: string; error: string };

/**
 * One payment as an invoice, for printing or saving as a PDF.
 *
 * Opened in a tab of its own from the order table on /credits. The shell draws
 * no rail or top bar on this route (`isBareRoute`), but it is still behind the
 * sign-in gate - and the API answers 404 for anybody else's payment, so this
 * page can only ever show the signed-in account its own.
 */
function InvoiceBody() {
  const search = useSearchParams();
  const paymentId = search?.get('payment') ?? '';
  const { account } = useAuth();

  /*
   * Keyed by the id it was loaded for, so a change of ?payment= reads as
   * loading again without an effect having to reset state first.
   */
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!paymentId) return;
    let live = true;
    paymentsApi.get(paymentId).then(
      ({ payment }) => {
        if (live) setLoaded({ id: paymentId, payment });
      },
      (error: unknown) => {
        if (!live) return;
        const message =
          error instanceof ApiResponseError && error.status === 404
            ? 'That invoice was not found.'
            : error instanceof Error
              ? error.message
              : 'The invoice could not be loaded.';
        setLoaded({ id: paymentId, error: message });
      }
    );
    return () => {
      live = false;
    };
  }, [paymentId]);

  const current = loaded && loaded.id === paymentId ? loaded : null;
  const payment = current && 'payment' in current ? current.payment : null;

  // The browser offers the title as the file name when saving to PDF.
  useEffect(() => {
    if (payment) document.title = `Invoice ${payment.reference}`;
  }, [payment]);

  if (!paymentId) {
    return <Message title="No invoice named">Open an invoice from the order list on the Credits page.</Message>;
  }
  if (!current) {
    return (
      <Message title="Loading invoice" back={false}>
        <span className="inline-block h-8 w-8 animate-spin rounded-full border-b-2 border-accent" aria-hidden />
      </Message>
    );
  }
  if (!payment) {
    return <Message title="Invoice unavailable">{'error' in current ? current.error : ''}</Message>;
  }

  const settled = isPaymentSettled(payment);
  const net = payment.creditsGranted || payment.credits;

  return (
    <article className={styles.card}>
      <p className="text-2xl font-extrabold tracking-tight text-accent-ink">TAILOR</p>

      <div className="mt-10 grid gap-8 sm:grid-cols-3">
        <div>
          <Term>Billed To</Term>
          {account?.name && <p className="mt-2 text-sm text-ink">{account.name}</p>}
          <p className={`${account?.name ? '' : 'mt-2 '}text-sm text-muted break-all`}>{account?.email}</p>
        </div>
        <div>
          <Term>Invoice Number</Term>
          <p className="mt-2 text-sm text-ink">{payment.reference}</p>
          <Term className="mt-6">Date of Issue</Term>
          <p className="mt-2 text-sm text-ink">
            {formatDate(payment.creditedAt || payment.createdAt, { style: 'date' })}
          </p>
        </div>
        <div>
          <Term>Invoice Status</Term>
          <p className="mt-2 text-sm text-ink">{STATUS_WORDS[payment.state] ?? payment.state}</p>
          <Term className="mt-6">Payment Method</Term>
          <p className="mt-2 text-sm text-ink">
            {payment.method === 'crypto' ? 'Crypto' : 'Credit/Debit Card'}
          </p>
        </div>
      </div>

      <table className={`${styles.lines} mt-12`}>
        <thead>
          <tr>
            <th scope="col">Description</th>
            <th scope="col" className={styles.amount}>
              Amount Due
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{payment.credits} Credit Balance</td>
            <td className={styles.amount}>
              {formatAmount(payment.amountCents - payment.feeCents, payment.currency)}
            </td>
          </tr>
        </tbody>
      </table>

      <dl className={`${styles.totals} mt-6`}>
        <div>
          <dt className="text-muted">Transaction Fees</dt>
          <dd className="text-ink">{formatAmount(payment.feeCents, payment.currency)}</dd>
        </div>
        <div className={styles.strong}>
          <dt className="text-ink">Total</dt>
          <dd className="text-ink">{formatAmount(payment.amountCents, payment.currency)}</dd>
        </div>
        <div>
          <dt className="text-muted">Amount Paid</dt>
          {/* Nothing was paid on an order that never settled, whatever it was for. */}
          <dd className="text-ink">{formatAmount(settled ? payment.amountCents : 0, payment.currency)}</dd>
        </div>
        <div className={styles.strong}>
          <dt className="text-ink">Net Credits</dt>
          <dd className="text-ink">{net}</dd>
        </div>
      </dl>

      {payment.state === 'refunded' && (
        <p className="mt-8 text-sm text-ink">
          Refunded: {payment.refundedCredits} credits
          {payment.refundedAt ? ` on ${formatDate(payment.refundedAt, { style: 'date' })}` : ''}
        </p>
      )}
    </article>
  );
}

function Term({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <h2 className={`text-sm font-semibold text-ink ${className}`}>{children}</h2>;
}

function Message({ title, back = true, children }: { title: string; back?: boolean; children: ReactNode }) {
  return (
    <div className={`${styles.card} text-center`}>
      <h1 className="text-xl font-semibold text-ink">{title}</h1>
      <div className="mt-3 text-sm text-muted">{children}</div>
      {back && (
        <Link href="/credits" className="mt-6 inline-block text-sm font-semibold text-accent-ink underline">
          Back to Credits
        </Link>
      )}
    </div>
  );
}

function PrintIcon() {
  // Drawn to the icon set's grid - 24x24, 1.75 stroke, round joins - which has
  // no printer of its own.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className="h-5 w-5"
    >
      <path d="M7 9V4h10v5" />
      <rect x="3.5" y="9" width="17" height="8" rx="2" />
      <path d="M7 14h10v6H7z" />
      <path d="M17 12h.01" />
    </svg>
  );
}

export default function InvoicePage() {
  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <button type="button" className={styles.print} onClick={() => window.print()} aria-label="Print invoice">
          <PrintIcon />
        </button>
      </div>
      <main className={styles.frame}>
        {/* `useSearchParams` needs a Suspense boundary to prerender. */}
        <Suspense fallback={<div className={styles.card} />}>
          <InvoiceBody />
        </Suspense>
      </main>
    </div>
  );
}
