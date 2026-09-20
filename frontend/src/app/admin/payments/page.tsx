'use client';

import { useCallback, useEffect, useState } from 'react';
import { AdminOnly } from '@/components/auth/AuthGate';
import { adminApi } from '@/lib/api';
import {
  adminPaymentsApi,
  formatAmount,
  STATE_LABELS,
  STATE_STYLES,
  type AdminPayment,
} from '@/lib/payments';

/**
 * Every payment, for reconciliation and refunds.
 *
 * Under `/admin`, so the nav comes from that layout rather than from here.
 */

function formatDate(value: string): string {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toLocaleString();
}

/**
 * The price, set where the payments it governs are read.
 *
 * Not on the general settings page, and that is a judgement rather than
 * laziness: an operator who has come to reconcile payments is the operator who
 * wants to change the price, and a number that decides what customers are
 * charged is worth having beside the record of what they were charged.
 *
 * It saves through the ordinary settings endpoint, so the server's own
 * validation - whole numbers, in range, minimum not above maximum - is the
 * same validation any other settings change gets.
 */
function PricingCard({ onSaved }: { onSaved: () => void }) {
  const [price, setPrice] = useState('');
  const [minCredits, setMinCredits] = useState('');
  const [maxCredits, setMaxCredits] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const settings = await adminApi.getSettings();
        setPrice(String(settings.creditPriceCents));
        setMinCredits(String(settings.creditMinCredits));
        setMaxCredits(String(settings.creditMaxCredits));
      } catch {
        setProblem('Could not load the current pricing.');
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    setNote('');
    setProblem('');
    try {
      await adminApi.updateSettings({
        creditPriceCents: Number.parseInt(price, 10),
        creditMinCredits: Number.parseInt(minCredits, 10),
        creditMaxCredits: Number.parseInt(maxCredits, 10),
      });
      setNote('Pricing saved. It applies to new purchases only.');
      onSaved();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Could not save the pricing.');
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return null;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <h2 className="text-base font-semibold text-gray-900">Pricing</h2>
      <p className="mt-1 text-sm text-gray-600">
        Each payment records the price at the time it was made, so changing this never rewrites what
        somebody has already paid.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Price per credit (cents)</span>
          <input
            type="number"
            min={1}
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Smallest purchase</span>
          <input
            type="number"
            min={1}
            value={minCredits}
            onChange={(event) => setMinCredits(event.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Largest purchase</span>
          <input
            type="number"
            min={1}
            value={maxCredits}
            onChange={(event) => setMaxCredits(event.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
          />
        </label>
      </div>

      {problem && <p className="mt-3 text-sm text-red-700">{problem}</p>}
      {note && <p className="mt-3 text-sm text-green-700">{note}</p>}

      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-400"
      >
        {saving ? 'Saving…' : 'Save pricing'}
      </button>
    </div>
  );
}

function PaymentsBody() {
  const [payments, setPayments] = useState<AdminPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [refunding, setRefunding] = useState('');
  const [confirming, setConfirming] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await adminPaymentsApi.list();
      setPayments(response.payments);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load payments.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refund = async (payment: AdminPayment) => {
    setRefunding(payment.id);
    setError('');
    setMessage('');
    try {
      const outcome = await adminPaymentsApi.refund(payment.id, note.trim());
      /*
       * All three numbers, always.
       *
       * A balance may not go negative, so refunding somebody who has already
       * spent what they bought returns their money and reverses only what is
       * left. Reporting a bare "refunded" would leave whoever pressed this
       * button to find out from the customer.
       */
      setMessage(
        outcome.shortfall > 0
          ? `${payment.reference} refunded in full. Only ${outcome.creditsReversed} of ` +
              `${outcome.creditsSold} credits could be reversed - the other ${outcome.shortfall} ` +
              'had already been spent.'
          : `${payment.reference} refunded, and all ${outcome.creditsReversed} credits reversed.`
      );
      setConfirming('');
      setNote('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not refund that payment.');
    } finally {
      setRefunding('');
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Payments</h1>
        <p className="mt-1 text-sm text-gray-600">
          Every credit purchase on this installation. Quote the reference when reconciling against
          your provider&apos;s dashboard.
        </p>
      </div>

      <PricingCard onSaved={() => void load()} />

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-700">{error}</div>
      )}
      {message && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-green-800">
          {message}
        </div>
      )}

      {payments.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <p className="text-lg font-semibold text-gray-900">No payments yet</p>
          <p className="mt-2 text-sm text-gray-600">
            Purchases appear here as soon as somebody buys credits.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <ul className="divide-y divide-gray-200">
            {payments.map((payment) => (
              <li key={payment.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-gray-900">
                        {payment.reference}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATE_STYLES[payment.state]}`}
                      >
                        {STATE_LABELS[payment.state]}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-gray-700">
                      {payment.userEmail || payment.userId} &middot; {payment.credits} credits &middot;{' '}
                      {formatAmount(payment.amountCents, payment.currency)} &middot; {payment.method}
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {formatDate(payment.createdAt)}
                      {payment.providerRef && (
                        <>
                          {' '}
                          &middot; <span className="font-mono">{payment.providerRef}</span>
                        </>
                      )}
                    </p>
                    {payment.state === 'refunded' && (
                      <p className="mt-1 text-xs text-amber-700">
                        {payment.refundedCredits} of {payment.credits} credits reversed
                        {payment.refundedCredits < payment.credits &&
                          ` - the other ${payment.credits - payment.refundedCredits} had been spent`}
                        .
                      </p>
                    )}
                    {payment.failure && (
                      <p className="mt-1 text-xs text-red-700">{payment.failure}</p>
                    )}
                  </div>

                  {payment.state === 'paid' && (
                    <button
                      type="button"
                      onClick={() => {
                        setConfirming(confirming === payment.id ? '' : payment.id);
                        setNote('');
                      }}
                      className="rounded-md border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
                    >
                      Refund
                    </button>
                  )}
                </div>

                {confirming === payment.id && (
                  <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-4">
                    <p className="text-sm font-semibold text-red-900">
                      Refund {formatAmount(payment.amountCents, payment.currency)} to{' '}
                      {payment.userEmail || 'this account'}?
                    </p>
                    <p className="mt-1 text-sm text-red-800">
                      The money goes back through {payment.provider}. Credits already spent cannot be
                      reversed - a balance never goes below zero - and this will say how many were.
                    </p>
                    <input
                      type="text"
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder="Why this is being refunded"
                      className="mt-3 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                    />
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void refund(payment)}
                        disabled={refunding === payment.id}
                        className="rounded-md bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:bg-gray-400"
                      >
                        {refunding === payment.id ? 'Refunding…' : 'Refund it'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirming('')}
                        className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function AdminPaymentsPage() {
  return (
    <AdminOnly>
      <PaymentsBody />
    </AdminOnly>
  );
}
