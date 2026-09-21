'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import CreditLedger from '@/components/CreditLedger';
import BuyCreditsDialog from '@/components/credits/BuyCreditsDialog';
import { PRIMARY } from '@/components/credits/chrome';
import { creditsApi, type CreditStatus, type LedgerEntry } from '@/lib/credits';
import {
  formatAmount,
  paymentsApi,
  STATE_LABELS,
  STATE_STYLES,
  type Payment,
  type PaymentOptions,
} from '@/lib/payments';

const CARD =
  'rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900';
const LABEL = 'text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400';

function formatDate(value: string): string {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toLocaleString();
}

/**
 * The balance, what has been bought, and a button that opens the purchase.
 *
 * The amount used to be typed here, with one Pay button per method beside it -
 * so the method was chosen last, and the limits that apply to it could only be
 * discovered by being refused. Buying now happens in a dialog that asks for
 * the method first, and this page is what it always should have been: the
 * account's own record.
 */
export default function BuyCreditsPage() {
  const search = useSearchParams();
  const cancelled = search?.get('cancelled');

  const [options, setOptions] = useState<PaymentOptions | null>(null);
  const [status, setStatus] = useState<CreditStatus | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [buying, setBuying] = useState(false);

  const latestRequest = useRef(0);
  const load = useCallback(async () => {
    const token = ++latestRequest.current;
    try {
      // Settled rather than all: a payment provider being unreachable must not
      // blank out the balance, which is the thing somebody came here to see.
      const [optionsResult, statusResult, ledgerResult, paymentsResult] = await Promise.allSettled([
        paymentsApi.options(),
        creditsApi.status(),
        creditsApi.ledger(20),
        paymentsApi.list(),
      ]);
      if (token !== latestRequest.current) return;

      if (optionsResult.status === 'fulfilled') {
        setOptions(optionsResult.value);
      } else {
        setError('Could not load the payment options.');
      }
      if (statusResult.status === 'fulfilled') setStatus(statusResult.value);
      if (ledgerResult.status === 'fulfilled') setLedger(ledgerResult.value.entries);
      if (paymentsResult.status === 'fulfilled') setPayments(paymentsResult.value.payments);
    } finally {
      if (token === latestRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const anyMethod = options?.targets.some((target) => target.available) ?? false;

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Buy credits</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
          One credit builds one resume. Previews are always free.
        </p>
      </div>

      {cancelled && (
        <div className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">
          That payment was cancelled. Nothing was charged.
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className={CARD}>
          <div className="mx-auto h-12 w-12 animate-spin rounded-full border-b-2 border-blue-600" />
        </div>
      ) : (
        <>
          <div className={CARD}>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className={LABEL}>Your balance</div>
                <div className="mt-1 text-3xl font-semibold text-gray-900 dark:text-white">
                  {status?.balance ?? 0}
                </div>
                {status && status.held > 0 && (
                  <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
                    {status.held} held by a run in progress.
                  </p>
                )}
              </div>
              {anyMethod && options && (
                <button type="button" onClick={() => setBuying(true)} className={PRIMARY}>
                  Buy credits
                </button>
              )}
            </div>
            {status?.exempt && (
              <p className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">
                Administrators do not spend credits, so you do not need to buy any.
              </p>
            )}
          </div>

          {!anyMethod && (
            <div className={CARD}>
              <p className="text-lg font-semibold text-gray-900 dark:text-white">
                No payment method is set up
              </p>
              <p className="mt-2 text-sm text-gray-600 dark:text-slate-300">
                This installation cannot take payments yet. An administrator can turn one on:
              </p>
              <ul className="mt-3 space-y-1 text-sm text-gray-600 dark:text-slate-300">
                {options?.methods.map((entry) => (
                  <li key={entry.method}>
                    <span className="font-medium">{entry.label}</span> &mdash; {entry.reason}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm text-gray-600 dark:text-slate-300">
                Until then, an administrator can add credits to your account directly.
              </p>
            </div>
          )}

          {payments.length > 0 && (
            <div className={CARD}>
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">Your payments</h2>
              <ul className="mt-3 divide-y divide-gray-200 dark:divide-slate-800">
                {payments.map((payment) => (
                  <li key={payment.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div>
                      <Link
                        href={`/credits/return?payment=${payment.id}`}
                        className="font-mono text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {payment.reference}
                      </Link>
                      <p className="text-xs text-gray-500 dark:text-slate-400">
                        {/*
                          What was GRANTED, falling back to what was quoted for
                          every row written before a fee could reduce it. The
                          two differ only when a fee was taken, and showing the
                          quote there would credit the account, on screen, with
                          credits it never received.
                        */}
                        {payment.creditsGranted || payment.credits} credits &middot;{' '}
                        {formatAmount(payment.amountCents, payment.currency)} &middot;{' '}
                        {formatDate(payment.createdAt)}
                      </p>
                    </div>
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${STATE_STYLES[payment.state]}`}
                    >
                      {STATE_LABELS[payment.state]}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className={CARD}>
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">Credit history</h2>
            <div className="mt-3">
              <CreditLedger entries={ledger} />
            </div>
          </div>

          {/*
            Mounted only while it is open, so the wizard's state - which step,
            which method, how many credits, which order is open at the provider
            - resets by unmounting rather than by a reset action somebody has to
            remember to dispatch on the second purchase.
          */}
          {buying && options && (
            <BuyCreditsDialog options={options} onClose={() => setBuying(false)} />
          )}
        </>
      )}
    </main>
  );
}
