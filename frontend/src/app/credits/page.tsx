'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import AppTopNav from '@/components/AppTopNav';
import CreditLedger from '@/components/CreditLedger';
import PayForm from '@/components/credits/PayForm';
import { resolvePreferredTheme } from '@/lib/theme';
import { creditsApi, type CreditStatus, type LedgerEntry } from '@/lib/credits';
import {
  formatAmount,
  paymentsApi,
  STATE_LABELS,
  STATE_STYLES,
  type MethodAvailability,
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

export default function BuyCreditsPage() {
  const search = useSearchParams();
  const cancelled = search?.get('cancelled');

  const [options, setOptions] = useState<PaymentOptions | null>(null);
  const [status, setStatus] = useState<CreditStatus | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState<MethodAvailability['method'] | null>(null);
  const [error, setError] = useState('');
  /*
   * The open payment form, once one has been started.
   *
   * Held here rather than on a separate route because the amount is chosen on
   * this page and paying should not lose it: the form replaces the amount field
   * in place, and cancelling puts it back. The pending payment it leaves behind
   * is harmless - it is never credited, and it expires at the provider.
   */
  const [form, setForm] = useState<{
    clientSecret: string;
    credits: number;
    amountCents: number;
    currency: string;
  } | null>(null);

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
        setAmount((current) => current || String(optionsResult.value.minCredits));
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

  const credits = Number.parseInt(amount, 10);
  const valid =
    options !== null &&
    Number.isInteger(credits) &&
    credits >= options.minCredits &&
    credits <= options.maxCredits;

  // Shown, not calculated: the same unit price the server will charge with,
  // multiplied by the same count being sent. The page never invents a price.
  const total = options && valid ? credits * options.unitPriceCents : 0;

  const buy = async (method: MethodAvailability['method']) => {
    if (!valid) return;
    setSending(method);
    setError('');
    try {
      const started = await paymentsApi.checkout(method, credits);

      // The form is ours: mount it here and the customer never leaves.
      if (started.clientSecret) {
        setForm({
          clientSecret: started.clientSecret,
          credits: started.credits,
          amountCents: started.amountCents,
          currency: started.currency,
        });
        setSending(null);
        return;
      }

      // A provider that hosts its own page. A full navigation, not a router
      // push: the destination is somebody else's domain. `assign` rather than
      // setting `href`, which the lint rule reads as mutating a value from
      // outside the component.
      if (started.redirectUrl) {
        window.location.assign(started.redirectUrl);
        return;
      }

      setError('That payment could not be started. Nothing was charged.');
      setSending(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start that payment.');
      setSending(null);
    }
  };

  const anyMethod = options?.methods.some((entry) => entry.available) ?? false;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950">
      <AppTopNav />
      <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Buy credits</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
            One credit builds one resume. Previews are always free.
          </p>
        </div>

        {cancelled && (
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">
            That payment was cancelled. Nothing was charged.
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-900/30 dark:text-red-100">
            {error}
          </div>
        )}

        {loading ? (
          <div className={CARD}>
            <div className="mx-auto h-12 w-12 animate-spin rounded-full border-b-2 border-blue-600" />
          </div>
        ) : (
          <>
            <div className={CARD}>
              <div className={LABEL}>Your balance</div>
              <div className="mt-1 text-3xl font-semibold text-gray-900 dark:text-white">
                {status?.balance ?? 0}
              </div>
              {status && status.held > 0 && (
                <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
                  {status.held} held by a run in progress.
                </p>
              )}
              {status?.exempt && (
                <p className="mt-2 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:bg-blue-900/30 dark:text-blue-100">
                  Administrators do not spend credits, so you do not need to buy any.
                </p>
              )}
            </div>

            {!anyMethod ? (
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
            ) : form ? (
              <div className={CARD}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-base font-semibold text-gray-900 dark:text-white">
                    {form.credits} credits
                  </h2>
                  <span className="text-lg font-semibold text-gray-900 dark:text-white">
                    {formatAmount(form.amountCents, form.currency)}
                  </span>
                </div>
                <div className="mt-4">
                  <PayForm
                    publishableKey={options?.publishableKey ?? ''}
                    clientSecret={form.clientSecret}
                    credits={form.credits}
                    amountCents={form.amountCents}
                    currency={form.currency}
                    dark={resolvePreferredTheme() === 'dark'}
                    onCancel={() => setForm(null)}
                  />
                </div>
              </div>
            ) : (
              <div className={CARD}>
                <label htmlFor="credits" className={LABEL}>
                  How many credits
                </label>
                <div className="mt-2 flex flex-wrap items-end gap-4">
                  <input
                    id="credits"
                    type="number"
                    inputMode="numeric"
                    min={options?.minCredits}
                    max={options?.maxCredits}
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    className="w-40 rounded-lg border border-gray-300 px-4 py-2 text-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                  />
                  <div>
                    <div className={LABEL}>Total</div>
                    <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white">
                      {options && valid ? formatAmount(total, options.currency) : '—'}
                    </div>
                  </div>
                </div>

                <p className="mt-2 text-sm text-gray-500 dark:text-slate-400">
                  {options &&
                    `${formatAmount(options.unitPriceCents, options.currency)} per credit. Between ${
                      options.minCredits
                    } and ${options.maxCredits} at a time.`}
                </p>

                <div className="mt-5 flex flex-wrap gap-3">
                  {options?.methods
                    .filter((entry) => entry.available)
                    .map((entry) => (
                      <button
                        key={entry.method}
                        type="button"
                        onClick={() => void buy(entry.method)}
                        disabled={!valid || sending !== null}
                        className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-400"
                      >
                        {sending === entry.method ? 'Preparing…' : `Pay by ${entry.label.toLowerCase()}`}
                      </button>
                    ))}
                </div>

                <p className="mt-3 text-xs text-gray-500 dark:text-slate-400">
                  Card details are entered in a form served by Stripe, so this server never sees
                  them. Your credits arrive once the payment is confirmed.
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
                          {payment.credits} credits &middot;{' '}
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
          </>
        )}
      </main>
    </div>
  );
}
