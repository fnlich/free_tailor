'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import {
  formatAmount,
  isPaymentPending,
  paymentsApi,
  STATE_LABELS,
  STATE_STYLES,
  type Payment,
} from '@/lib/payments';

const CARD =
  'rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900';

/**
 * Where a provider sends the browser back to.
 *
 * It waits rather than congratulates, and that is the whole design. Arriving
 * here proves only that somebody followed a redirect - the page has no way to
 * know a payment succeeded, and it must not pretend otherwise, because the
 * thing that actually decides is a signed webhook arriving server-to-server.
 * So it polls the payment until the server says it was paid.
 *
 * Usually that is over before the redirect finishes. For crypto it can be
 * minutes, because the network has to confirm the transfer - which is why the
 * waiting copy says so rather than spinning silently.
 */
function ReturnBody() {
  const search = useSearchParams();
  const paymentId = search?.get('payment') ?? '';
  const { refresh } = useAuth();

  const [payment, setPayment] = useState<Payment | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [waitedTooLong, setWaitedTooLong] = useState(false);

  const pending = useRef(false);
  useEffect(() => {
    pending.current = payment ? isPaymentPending(payment) : true;
  }, [payment]);

  const latestRequest = useRef(0);
  const load = useCallback(async () => {
    if (!paymentId) {
      setLoading(false);
      return;
    }
    const token = ++latestRequest.current;
    try {
      const response = await paymentsApi.get(paymentId);
      if (token !== latestRequest.current) return;
      setPayment(response.payment);
      setError('');
      /*
       * Tell the rest of the app the balance moved.
       *
       * Nothing else has any reason to re-read the account: the webhook that
       * credited it is server-to-server and the browser never saw it, and
       * client-side navigation away from here does not help because the auth
       * context fetches on mount and the root layout never unmounts. Without
       * this the page says "credits added" while the top-bar pill, the balance
       * panel and the credit history all still show the pre-purchase figure
       * until a full reload.
       *
       * `isPaymentPending` goes false on this state, so the poll below stops
       * right after and this fires once.
       */
      if (response.payment.state === 'paid') void refresh();
    } catch (err) {
      if (token !== latestRequest.current) return;
      setError(err instanceof Error ? err.message : 'Could not find that payment.');
    } finally {
      if (token === latestRequest.current) setLoading(false);
    }
  }, [paymentId, refresh]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (pending.current) void load();
    }, 2000);
    return () => clearInterval(timer);
  }, [load]);

  // After two minutes, stop implying it is about to happen and say what to do.
  useEffect(() => {
    const timer = setTimeout(() => setWaitedTooLong(true), 120_000);
    return () => clearTimeout(timer);
  }, []);

  if (loading) {
    return (
      <div className={CARD}>
        <div className="mx-auto h-12 w-12 animate-spin rounded-full border-b-2 border-blue-600" />
      </div>
    );
  }

  if (!payment) {
    return (
      <div className={CARD}>
        <p className="text-lg font-semibold text-gray-900 dark:text-white">Payment not found</p>
        <p className="mt-2 text-sm text-gray-600 dark:text-slate-300">
          {error || 'It may belong to another account.'}
        </p>
        <Link
          href="/credits"
          className="mt-4 inline-block text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          Back to credits
        </Link>
      </div>
    );
  }

  const waiting = isPaymentPending(payment);

  return (
    <div className="space-y-6">
      <div className={CARD}>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-xl font-semibold text-gray-900 dark:text-white">
            {payment.reference}
          </h1>
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATE_STYLES[payment.state]}`}>
            {STATE_LABELS[payment.state]}
          </span>
        </div>

        <p className="mt-2 text-sm text-gray-600 dark:text-slate-300">
          {payment.credits} credits for {formatAmount(payment.amountCents, payment.currency)}.
        </p>

        {payment.state === 'paid' && (
          <div className="mt-4 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-100">
            <p className="font-semibold">Paid. Your credits are on your balance.</p>
            <p className="mt-1">
              <Link href="/" className="font-semibold underline">
                Start building
              </Link>{' '}
              or{' '}
              <Link href="/credits" className="font-semibold underline">
                buy more
              </Link>
              .
            </p>
          </div>
        )}

        {waiting && (
          <div className="mt-4 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:bg-blue-900/30 dark:text-blue-100">
            <p className="font-semibold">Waiting for the payment to be confirmed.</p>

            <p className="mt-1">
              {/*
                Careful not to promise. Landing here proves only that a browser
                followed a redirect - somebody who started a 3-D Secure step and
                abandoned it arrives at exactly this page, in exactly this
                state, and telling them their credits are on the way would be
                false. So the sentence is conditional, and the two-minute note
                below says what to do when it stays that way.
              */}
              {payment.method === 'crypto'
                ? 'A crypto payment has to be confirmed by the network, which usually takes a few minutes. If it went through, your credits will be added even if you close this page.'
                : 'This usually takes a second or two. If the payment went through, your credits will be added even if you close this page.'}
            </p>
            {waitedTooLong && (
              <p className="mt-2">
                Still waiting. If you did not finish paying - closing the card&apos;s
                confirmation step will do it - nothing was charged and you can{' '}
                <Link href="/credits" className="font-semibold underline">
                  start again
                </Link>
                . If you were charged and this does not clear shortly, quote{' '}
                <span className="font-mono font-semibold">{payment.reference}</span> to an
                administrator.
              </p>
            )}
          </div>
        )}

        {(payment.state === 'failed' || payment.state === 'expired') && (
          <div className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-900/30 dark:text-red-100">
            <p className="font-semibold">
              {payment.state === 'expired' ? 'That checkout expired.' : 'That payment did not go through.'}
            </p>
            <p className="mt-1">You were not charged. {payment.failure}</p>
            <Link href="/credits" className="mt-2 inline-block font-semibold underline">
              Try again
            </Link>
          </div>
        )}

        {payment.state === 'refunded' && (
          <div className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">
            This payment was refunded.
          </div>
        )}
      </div>
    </div>
  );
}

export default function PaymentReturnPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      {/* `useSearchParams` needs a Suspense boundary to prerender. */}
      <Suspense
        fallback={
          <div className={CARD}>
            <div className="mx-auto h-12 w-12 animate-spin rounded-full border-b-2 border-blue-600" />
          </div>
        }
      >
        <ReturnBody />
      </Suspense>
    </main>
  );
}
