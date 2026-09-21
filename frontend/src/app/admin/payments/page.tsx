'use client';

import { useCallback, useEffect, useState } from 'react';
import { AdminOnly } from '@/components/auth/AuthGate';
import { adminApi, type PaymentTargetLimits } from '@/lib/api';
import {
  adminPaymentsApi,
  formatAmount,
  STATE_LABELS,
  STATE_STYLES,
  type AdminPayment,
  type HeldTransfer,
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
 * One target's limits, while they are being edited.
 *
 * Strings, not numbers, and that is the point: an operator clearing a box to
 * retype it produces "" for a moment, and a number-typed state turns that into
 * NaN or - worse - silently into 0, which is a live setting that offers a
 * purchase of nothing. Parsing happens once, on save, where a bad value can be
 * reported instead of applied.
 */
type LimitDraft = {
  target: string;
  minCents: string;
  maxCents: string;
  feeBps: string;
  feeFixedCents: string;
  presetsCents: string;
};

function toDraft(row: PaymentTargetLimits): LimitDraft {
  return {
    target: row.target,
    minCents: String(row.minCents),
    maxCents: String(row.maxCents),
    feeBps: String(row.feeBps),
    feeFixedCents: String(row.feeFixedCents),
    presetsCents: row.presetsCents.join(', '),
  };
}

/** Whole numbers only, and a blank or a word becomes 0 for the server to refuse. */
function wholeNumber(value: string): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) ? parsed : 0;
}

function toRow(draft: LimitDraft): PaymentTargetLimits {
  return {
    target: draft.target.trim(),
    minCents: wholeNumber(draft.minCents),
    maxCents: wholeNumber(draft.maxCents),
    feeBps: wholeNumber(draft.feeBps),
    feeFixedCents: wholeNumber(draft.feeFixedCents),
    /*
     * Commas, spaces or both - an operator pasting a list should not have to
     * guess the separator. Anything that is not a whole number is dropped
     * here rather than sent as a zero, because a $0.00 button is a button
     * that sells nothing and the server would only refuse the whole save.
     */
    presetsCents: draft.presetsCents
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((part) => Number.parseInt(part, 10))
      .filter((cents) => Number.isInteger(cents)),
  };
}

function targetLabel(target: string): string {
  if (target === 'card') return 'Card';
  if (target === 'crypto') return 'Crypto — every coin';
  return target;
}

/** Cents as dollars, for the hint under a pair of bounds. */
function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const LIMIT_FIELD = 'mt-1 w-full rounded-md border border-gray-300 px-3 py-2';

function LimitFields({
  draft,
  onChange,
  onRemove,
}: {
  draft: LimitDraft;
  onChange: (next: LimitDraft) => void;
  onRemove: () => void;
}) {
  const min = wholeNumber(draft.minCents);
  const max = wholeNumber(draft.maxCents);
  const feeBps = wholeNumber(draft.feeBps);

  return (
    <div className="rounded-lg border border-gray-200 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-900">{targetLabel(draft.target)}</h3>
        <button
          type="button"
          onClick={onRemove}
          className="text-xs font-medium text-red-700 hover:underline"
        >
          Remove
        </button>
      </div>
      <p className="mt-0.5 text-xs text-gray-500">
        <span className="font-mono">{draft.target}</span> &middot; {dollars(min)} to{' '}
        {dollars(max)}
        {feeBps > 0 && ` · fee ${(feeBps / 100).toFixed(2)}%`}
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Smallest (cents)</span>
          <input
            type="number"
            min={1}
            value={draft.minCents}
            onChange={(event) => onChange({ ...draft, minCents: event.target.value })}
            className={LIMIT_FIELD}
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Largest (cents)</span>
          <input
            type="number"
            min={1}
            value={draft.maxCents}
            onChange={(event) => onChange({ ...draft, maxCents: event.target.value })}
            className={LIMIT_FIELD}
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Fee (basis points)</span>
          <input
            type="number"
            min={0}
            value={draft.feeBps}
            onChange={(event) => onChange({ ...draft, feeBps: event.target.value })}
            className={LIMIT_FIELD}
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Fee (fixed cents)</span>
          <input
            type="number"
            min={0}
            value={draft.feeFixedCents}
            onChange={(event) => onChange({ ...draft, feeFixedCents: event.target.value })}
            className={LIMIT_FIELD}
          />
        </label>
      </div>

      <label className="mt-3 block text-sm">
        <span className="font-medium text-gray-700">Preset buttons (cents)</span>
        <input
          type="text"
          inputMode="numeric"
          value={draft.presetsCents}
          onChange={(event) => onChange({ ...draft, presetsCents: event.target.value })}
          className={LIMIT_FIELD}
          placeholder="500, 1000, 2500"
        />
      </label>
    </div>
  );
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
  const [limits, setLimits] = useState<LimitDraft[]>([]);
  const [newTarget, setNewTarget] = useState('');
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
        setLimits(settings.paymentLimits.map(toDraft));
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
        paymentLimits: limits.map(toRow),
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

      <div className="mt-6 border-t border-gray-200 pt-5">
        <h3 className="text-sm font-semibold text-gray-900">Limits per payment method</h3>
        <p className="mt-1 text-sm text-gray-600">
          In cents, and the tighter of the two wins: a row here can narrow a method but never
          take it past the credit bounds above. A method with no row falls back to those bounds
          with no fee and no preset buttons, so removing a row is a way of switching its limits
          off rather than a way of switching the method off.
        </p>
        <p className="mt-1 text-sm text-gray-600">
          A fee is taken <span className="font-medium">out of</span> the amount charged, not added
          to it - the buyer pays what they chose and receives the credits the remainder buys. A
          row naming a coin, such as <span className="font-mono">ethereum:USDT</span>, overrides
          the <span className="font-mono">crypto</span> row for that coin alone.
        </p>

        <div className="mt-4 space-y-4">
          {limits.map((draft, index) => (
            <LimitFields
              key={draft.target}
              draft={draft}
              onChange={(next) =>
                setLimits((current) =>
                  current.map((entry, position) => (position === index ? next : entry))
                )
              }
              onRemove={() =>
                setLimits((current) => current.filter((_, position) => position !== index))
              }
            />
          ))}
          {limits.length === 0 && (
            <p className="text-sm text-gray-600">
              No rows. Saving with none restores the built-in defaults rather than leaving every
              method unbounded.
            </p>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="block text-sm">
            <span className="font-medium text-gray-700">Add a target</span>
            <input
              type="text"
              value={newTarget}
              onChange={(event) => setNewTarget(event.target.value)}
              placeholder="card, crypto, or ethereum:USDT"
              className="mt-1 w-64 rounded-md border border-gray-300 px-3 py-2"
            />
          </label>
          <button
            type="button"
            disabled={
              newTarget.trim() === '' ||
              limits.some((entry) => entry.target === newTarget.trim())
            }
            onClick={() => {
              setLimits((current) => [
                ...current,
                {
                  target: newTarget.trim(),
                  // The credit bounds above, in cents, so a new row starts
                  // where the method already was rather than at zero.
                  minCents: String(
                    (Number.parseInt(minCredits, 10) || 0) * (Number.parseInt(price, 10) || 0)
                  ),
                  maxCents: String(
                    (Number.parseInt(maxCredits, 10) || 0) * (Number.parseInt(price, 10) || 0)
                  ),
                  feeBps: '0',
                  feeFixedCents: '0',
                  presetsCents: '',
                },
              ]);
              setNewTarget('');
            }}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>

      {problem && <p className="mt-3 text-sm text-red-700">{problem}</p>}
      {note && <p className="mt-3 text-sm text-green-700">{note}</p>}

      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-400"
      >
        {saving ? 'Saving…' : 'Save pricing and limits'}
      </button>
    </div>
  );
}

function PaymentsBody() {
  const [payments, setPayments] = useState<AdminPayment[]>([]);
  const [held, setHeld] = useState<HeldTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [refunding, setRefunding] = useState('');
  const [confirming, setConfirming] = useState('');
  const [note, setNote] = useState('');
  const [resolving, setResolving] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await adminPaymentsApi.list();
      setPayments(response.payments);
      /*
       * Settled separately: a held transfer is the more urgent of the two and
       * must not be hidden because the payment list failed to load, nor take
       * the payment list down when it fails itself.
       */
      try {
        setHeld((await adminPaymentsApi.held()).held);
      } catch {
        // An older backend has no such route. Nothing to show is correct.
      }
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

  /**
   * Marks an unattributable transfer as dealt with.
   *
   * Deliberately NOT a credit and NOT a refund: this server cannot know which
   * of those the administrator did, only that they have finished. What it
   * changes is the queue, so that a list of things needing a person stays a
   * list of things needing a person.
   */
  const dismiss = async (entry: HeldTransfer) => {
    setResolving(entry.id);
    try {
      await adminPaymentsApi.resolveHeld(entry.id);
      setHeld((current) => current.filter((item) => item.id !== entry.id));
      setMessage('Marked as dealt with.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not clear that item.');
    } finally {
      setResolving('');
    }
  };

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

      {/*
        Above everything, because it is the only thing on this page that is
        somebody's money sitting unclaimed.

        A transfer lands here when it could not be attributed to exactly ONE
        open order - the amount was off and either nothing or two things were
        close enough. Nothing was credited and nothing was written off, which
        is the only honest outcome when guessing would give one buyer's coin
        to another buyer's order.
      */}
      {held.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <h2 className="text-base font-semibold text-red-700">
            {held.length} payment{held.length === 1 ? ' needs' : 's need'} attention
          </h2>
          <p className="mt-1 text-sm text-red-700">
            Coin arrived that could not be matched to one order automatically. Nothing has been
            credited and nothing has been lost. Check the transaction against the order, then
            adjust the balance from the accounts page.
          </p>
          <ul className="mt-3 space-y-2">
            {held.map((entry) => (
              <li key={entry.id} className="rounded-md border border-red-200 bg-white p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium text-gray-900">{entry.asset}</span>
                  <span className="text-xs text-gray-500">{formatDate(entry.at)}</span>
                </div>
                <p className="mt-1 text-gray-700">{entry.note}</p>
                <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-gray-600 sm:grid-cols-2">
                  {/*
                    Shown only when there is one. An unattributable transfer
                    has no single order behind it, so an "Expected: —" row
                    reads as a figure that went missing rather than as a
                    question this entry does not have an answer to.
                  */}
                  {entry.expected && (
                    <div>
                      <dt className="inline font-medium">Expected: </dt>
                      <dd className="inline font-mono">{entry.expected}</dd>
                    </div>
                  )}
                  <div>
                    <dt className="inline font-medium">Received: </dt>
                    <dd className="inline font-mono">{entry.received || '—'}</dd>
                  </div>
                  {entry.txid && (
                    <div className="sm:col-span-2">
                      <dt className="inline font-medium">Transaction: </dt>
                      <dd className="inline break-all font-mono">{entry.txid}</dd>
                    </div>
                  )}
                </dl>
                {/*
                  Only an unattributable transfer offers this. A held invoice
                  belongs to a payment and keeps its place in that payment's
                  history, so there is nothing here to dismiss.
                */}
                {entry.resolvable && (
                  <button
                    type="button"
                    onClick={() => void dismiss(entry)}
                    disabled={resolving === entry.id}
                    className="mt-3 rounded-md border-2 border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
                  >
                    {resolving === entry.id ? 'Clearing…' : 'Mark as dealt with'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

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
