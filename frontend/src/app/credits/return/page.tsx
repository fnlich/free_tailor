'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import AppTopNav from '@/components/AppTopNav';
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
 * minutes, because a chain payment has to confirm - which is why the waiting
 * copy says so rather than spinning silently.
 */
function ReturnBody() {
  const search = useSearchParams();
  const paymentId = search?.get('payment') ?? '';

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
    } catch (err) {
      if (token !== latestRequest.current) return;
      setError(err instanceof Error ? err.message : 'Could not find that payment.');
    } finally {
      if (token === latestRequest.current) setLoading(false);
    }
  }, [paymentId]);

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
              {payment.method === 'crypto'
                ? 'A crypto payment has to be confirmed on the chain, which usually takes a few minutes. You can close this page - your credits will be added either way.'
                : 'This usually takes a second or two. You can close this page - your credits will be added either way.'}
            </p>
            {waitedTooLong && (
              <p className="mt-2">
                Still waiting. If you were charged and this does not clear shortly, quote{' '}
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
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950">
      <AppTopNav />
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
    </div>
  );
}
