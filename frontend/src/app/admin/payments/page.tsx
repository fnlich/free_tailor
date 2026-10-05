'use client';

import { useCallback, useEffect, useState } from 'react';
import { AdminOnly } from '@/components/auth/AuthGate';
import { Card, EmptyState, Notice, Pill, Section, Spinner, Status } from '@/components/ui/kit';
import { adminApi, type PaymentTargetLimits, type PaymentTargetLimitsInput } from '@/lib/api';
import {
  type AdminPayment,
  adminPaymentsApi,
  STATE_LABELS,
  STATE_TONES,
} from '@/lib/payments';
import {
  describePurchaseCredit,
  describeRefundedNote,
  describeRefundOutcome,
  isLegacyPurchase,
} from '@/lib/paymentDisplay';
import { formatDate, formatMoney, parseDollars, toDollarInput } from '@/lib/format';
import { messageWithDetail } from '@/lib/userMessage';
import styles from './page.module.css';

/**
 * Every payment, for reconciliation and refunds.
 *
 * Under `/admin`, so the nav comes from that layout rather than from here.
 */

/**
 * One method's limits, while they are being edited.
 *
 * Strings, not numbers, and that is the point: an operator clearing a box to
 * retype it produces "" for a moment, and a number-typed state turns that into
 * NaN or - worse - silently into 0, which is a live setting that offers a
 * purchase of nothing. They are DOLLARS as typed ("2.50"), sent to the server
 * as typed, and the server parses them exactly and refuses anything that is
 * not a whole number of cents by name - so a bad value is reported on save
 * instead of applied.
 */
type LimitDraft = {
  target: string;
  min: string;
  max: string;
  presets: string;
};

function toDraft(row: PaymentTargetLimits): LimitDraft {
  return {
    target: row.target,
    min: toDollarInput(row.minMilli),
    max: toDollarInput(row.maxMilli),
    presets: row.presetsMilli.map(toDollarInput).join(', '),
  };
}

function toRow(draft: LimitDraft): PaymentTargetLimitsInput {
  return {
    target: draft.target.trim(),
    minUsd: draft.min.trim(),
    maxUsd: draft.max.trim(),
    /*
     * Commas, spaces or both - an operator pasting a list should not have to
     * guess the separator. Each is sent as typed: one that is not an amount is
     * refused by the server naming the preset, rather than dropped here where
     * nobody would notice it went.
     */
    presetsUsd: draft.presets
      .split(/[\s,]+/)
      .map((part) => part.replace(/^\$/, ''))
      .filter(Boolean),
  };
}

function targetLabel(target: string): string {
  if (target === 'card') return 'Card';
  if (target === 'crypto') return 'Crypto — every coin';
  return target;
}

/** A typed bound as money for the card's description, or a dash while it is not one yet. */
function typedMoney(value: string): string {
  const parsed = parseDollars(value);
  return parsed.ok ? formatMoney(parsed.milli) : '—';
}

const LIMIT_FIELD = 'tl-input mt-2';

function LimitFields({
  draft,
  onChange,
  onRemove,
}: {
  draft: LimitDraft;
  onChange: (next: LimitDraft) => void;
  onRemove: () => void;
}) {
  return (
    <Card
      title={targetLabel(draft.target)}
      description={
        <>
          <span className="font-mono">{draft.target}</span> &middot; {typedMoney(draft.min)} to{' '}
          {typedMoney(draft.max)}
        </>
      }
      actions={
        <button
          type="button"
          onClick={onRemove}
          className="tl-button-quiet"
          data-size="sm"
          data-tone="danger"
        >
          Remove
        </button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="tl-label">Smallest purchase ($)</span>
          <input
            type="text"
            inputMode="decimal"
            value={draft.min}
            onChange={(event) => onChange({ ...draft, min: event.target.value })}
            className={LIMIT_FIELD}
            placeholder="2.50"
          />
        </label>
        <label className="block">
          <span className="tl-label">Largest purchase ($)</span>
          <input
            type="text"
            inputMode="decimal"
            value={draft.max}
            onChange={(event) => onChange({ ...draft, max: event.target.value })}
            className={LIMIT_FIELD}
            placeholder="100.00"
          />
        </label>
      </div>

      <label className="mt-4 block">
        <span className="tl-label">Preset buttons ($)</span>
        <input
          type="text"
          inputMode="decimal"
          value={draft.presets}
          onChange={(event) => onChange({ ...draft, presets: event.target.value })}
          className={LIMIT_FIELD}
          placeholder="5, 10, 25"
        />
      </label>
    </Card>
  );
}

/**
 * What may be bought, set where the payments it governs are read.
 *
 * Not on the general settings page, and that is a judgement rather than
 * laziness: an operator who has come to reconcile payments is the operator who
 * wants to change what can be bought, and a bound that decides what customers
 * may be charged is worth having beside the record of what they were charged.
 *
 * There is no price to set. A credit is a dollar and a purchase credits
 * exactly what it charges, so the only settings are each method's bounds and
 * buttons, in dollars. It saves through the ordinary settings endpoint, so the
 * server's own validation - whole cents, in range, minimum not above maximum -
 * is the same validation any other settings change gets.
 */
function PricingCard({ onSaved }: { onSaved: () => void }) {
  const [limits, setLimits] = useState<LimitDraft[]>([]);
  const [require3ds, setRequire3ds] = useState(false);
  const [newTarget, setNewTarget] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const settings = await adminApi.getSettings();
        setLimits(settings.paymentLimits.map(toDraft));
        setRequire3ds(settings.requireThreeDSecure);
      } catch {
        setProblem('Could not load the current purchase limits.');
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
        paymentLimits: limits.map(toRow),
        requireThreeDSecure: require3ds,
      });
      setNote('Saved. It applies to new purchases only.');
      onSaved();
    } catch (err) {
      setProblem(messageWithDetail(err, 'Could not save the purchase limits.'));
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return null;

  return (
    <>
      <Section
        title="Credit"
        description="A credit is a dollar: a purchase credits exactly what it charges, by card or by crypto, with nothing taken out. Each payment records what it charged, so changing a limit below never rewrites what somebody has already paid. Payments from before credits were dollars keep the credits and the price they were bought at."
      />

      <Section title="Card security">
        <label className="tl-choice" data-on={require3ds}>
          <input
            type="checkbox"
            checked={require3ds}
            onChange={(event) => setRequire3ds(event.target.checked)}
          />
          <span className="min-w-0 text-sm">
            <span className="block font-medium text-ink">
              Always ask the cardholder&apos;s bank to authenticate
            </span>
            <span className="mt-1 block text-muted">
              Off, your payment provider decides when to challenge somebody, using its own risk
              rules. On, every card payment asks the bank &ndash; which is what moves
              responsibility for a disputed payment from you to the bank that issued the card.
            </span>
            <span className="mt-1 block text-muted">
              It is not free: a challenge is a step a buyer can fail or give up on, and a card
              somebody has kept stops charging in one tap, because they have to confirm each
              time. That trade is yours to make, which is why this is a switch.
            </span>
          </span>
        </label>
      </Section>

      <Section
        title="Limits per payment method"
        description={
          <>
            In dollars and whole cents: the smallest and largest single purchase, and the amounts
            offered as buttons (a button outside the bounds is not offered). A method with no row
            falls back to its built-in limits - card $2.50 to $100, crypto $50 to $2,000 - so
            removing a row is a way of switching its limits back, not a way of switching the method
            off.
            {/* A block span rather than a second <p>: the kit puts the
                description inside one paragraph already. */}
            <span className="mt-2 block">
              There are two methods to name here, <span className="font-mono">card</span> and{' '}
              <span className="font-mono">crypto</span>; a row naming a coin is left over from when
              this app chose the coin itself and no longer applies to anything.
            </span>
          </>
        }
      >
        <div className="space-y-4">
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
            <p className="text-sm text-muted">
              No rows. Saving with none restores the built-in defaults rather than leaving every
              method unbounded.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          {/*
            `card or crypto`, and not the coin id this suggested for three
            commits after the coins were deleted. Two paragraphs above, this page
            already tells the operator that a row naming a coin applies to
            nothing - and then invited them to type one, and saved it without a
            word.
          */}
          <label className="block w-64 max-w-full">
            <span className="tl-label">Add a target</span>
            <input
              type="text"
              value={newTarget}
              onChange={(event) => setNewTarget(event.target.value)}
              placeholder="card or crypto"
              className="tl-input mt-2"
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
                  // Empty, for the operator to fill: there is no sensible
                  // default to guess, and a save with the boxes left empty is
                  // refused by name rather than stored as $0.
                  min: '',
                  max: '',
                  presets: '',
                },
              ]);
              setNewTarget('');
            }}
            className="tl-button-quiet"
            // Level with the 2.5rem field beside it; inline, because
            // .tl-button-quiet is unlayered and outranks a min-h utility.
            style={{ minHeight: '2.5rem' }}
          >
            Add
          </button>
        </div>

        <div>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="tl-button"
          >
            {saving ? 'Saving…' : 'Save limits'}
          </button>
          {problem && <Status tone="error">{problem}</Status>}
          {note && <Status tone="ok">{note}</Status>}
        </div>
      </Section>
    </>
  );
}

/**
 * Confirming a refund, as a dialog over the list.
 *
 * Escape and a click on the backdrop do what Cancel does, and nothing else -
 * the refund itself only ever starts from the button. A refusal is repeated in
 * here because the page's own notice is behind the backdrop while this is up -
 * but only one from a press in THIS dialog, so a stale error left on the page
 * by an earlier attempt does not greet the next payment opened.
 */
function RefundDialog({
  payment,
  note,
  onNote,
  refunding,
  error,
  onRefund,
  onCancel,
}: {
  payment: AdminPayment;
  note: string;
  onNote: (value: string) => void;
  refunding: boolean;
  error: string;
  onRefund: () => void;
  onCancel: () => void;
}) {
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="tl-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="refund-dialog-title"
        className="tl-dialog max-w-lg p-6"
      >
        <h2 id="refund-dialog-title" className="text-lg font-semibold text-ink">
          Refund {formatMoney(payment.amountMilli)} to{' '}
          {payment.userEmail || 'this account'}?
        </h2>
        <p className="mt-2 text-sm text-muted">
          {/*
            Said BEFORE the button, because for crypto the answer
            is "not by us" - and pressing it does NOTHING.
            `refundPayment` answers 409 for every crypto provider
            before touching the balance, so the old chain line
            ("pressing this will reverse the credits only") was a
            promise the server refuses. The old copy before that
            said "the money goes back through chain" and let the
            administrator discover the refusal by pressing, which
            is a worse way to find out than reading it here.
          */}
          {payment.method === 'crypto' ? (
            <>
              {payment.provider === 'chain'
                ? 'This cannot be sent back from here - nobody is holding the coin. Return it from the wallet you configured.'
                : payment.provider === 'coinbase'
                  ? 'This cannot be sent back from here. Return it from your Coinbase Commerce account.'
                  : 'This cannot be sent back from here. Return it from your Cryptomus merchant dashboard.'}{' '}
              Then adjust the balance from the accounts page. Pressing this reverses
              nothing and will say so.
            </>
          ) : (
            <>
              The money goes back through {payment.provider}. Credit already spent
              cannot be reversed - a balance never goes below $0.000 - and this will say
              how much was.
              {isLegacyPurchase(payment) && (
                <>
                  {' '}
                  This payment was made before credits became dollars, and its credits were
                  reset then, so refunding it reverses nothing on the balance.
                </>
              )}
            </>
          )}
        </p>
        {attempted && error && (
          <Notice tone="error" role="alert" className="mt-4">
            {error}
          </Notice>
        )}
        <input
          type="text"
          value={note}
          onChange={(event) => onNote(event.target.value)}
          placeholder="Why this is being refunded"
          aria-label="Why this is being refunded"
          autoFocus
          className="tl-input mt-4"
        />
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button type="button" onClick={onCancel} className="tl-button-quiet">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              setAttempted(true);
              onRefund();
            }}
            disabled={refunding}
            className="tl-button"
            data-tone="danger"
          >
            {refunding ? 'Refunding…' : 'Refund it'}
          </button>
        </div>
      </div>
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
  /** How many exist, against how many are on screen. */
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await adminPaymentsApi.list();
      setPayments(response.payments);
      setTotal(response.total ?? response.payments.length);
      setError('');
    } catch (err) {
      setError(messageWithDetail(err, 'Could not load payments.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The next page, appended rather than swapped in.
   *
   * Refunds are driven from a row here, so a payment this page cannot show is
   * a payment nobody can refund - and it used to stop at the newest 200 with
   * no control, no count and no hint that anything was missing. On an install
   * with 377 payments that hid 66 refundable ones.
   */
  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const response = await adminPaymentsApi.list(payments.length);
      setPayments((current) => [...current, ...response.payments]);
      if (typeof response.total === 'number') setTotal(response.total);
      setError('');
    } catch (err) {
      setError(messageWithDetail(err, 'Could not load older payments.'));
    } finally {
      setLoadingMore(false);
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
      setMessage(describeRefundOutcome(payment.reference, outcome));
      setConfirming('');
      setNote('');
      await load();
    } catch (err) {
      setError(messageWithDetail(err, 'Could not refund that payment.'));
    } finally {
      setRefunding('');
    }
  };

  if (loading) {
    return <Spinner />;
  }

  const confirmingPayment = payments.find((payment) => payment.id === confirming);

  return (
    <div>
      <header>
        {/*
          An h1 at the size of the other Administration pages' h2, and on
          purpose: backend/test/e2e/browser.js waits for `h1:has-text("Payments")`
          before it reads this page.
        */}
        <h1 className="text-2xl font-bold tracking-tight text-ink">Payments</h1>
        <p className="mt-1 text-sm text-muted">
          Every purchase of credit on this installation. Quote the reference when reconciling against
          your provider&apos;s dashboard.
          {total > payments.length && (
            <> Showing the newest {payments.length} of {total}.</>
          )}
        </p>
      </header>

      <PricingCard onSaved={() => void load()} />

      <div className="space-y-4 pt-8">
        {error && (
          <Notice tone="error" role="alert">
            {error}
          </Notice>
        )}
        {message && (
          <Notice tone="success" role="status">
            {message}
          </Notice>
        )}

        {payments.length === 0 ? (
          <EmptyState title="No payments yet">
            Purchases appear here as soon as somebody buys credit.
          </EmptyState>
        ) : (
          <>
            {/* `relative` so the sr-only Actions heading - absolutely positioned -
                is held by this scroll box; otherwise it escapes the sideways
                scroll and widens the whole page on a phone. */}
            <div className="tl-table-box relative">
              <table className="tl-table">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Reference</th>
                    <th scope="col">Account</th>
                    <th scope="col">Credit</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Method</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((payment) => (
                    <tr key={payment.id}>
                      <td className="whitespace-nowrap">{formatDate(payment.createdAt)}</td>
                      <td>
                        {/* Colours on inner elements: `.tl-table td` is
                            unlayered and would beat a utility on the cell. */}
                        <span className="whitespace-nowrap font-mono font-semibold text-ink">
                          {payment.reference}
                        </span>
                        {payment.providerRef && (
                          /*
                            `break-all`: an opaque provider identifier with no
                            break opportunity - a Stripe session id runs to 66
                            characters - and without it the cell would stretch
                            the table to fit it.
                          */
                          <span className="mt-1 block break-all font-mono text-xs text-subtle">
                            {payment.providerRef}
                          </span>
                        )}
                      </td>
                      <td className="break-words">{payment.userEmail || payment.userId}</td>
                      {/* What it was for - a count of credits on a payment from before dollars. */}
                      <td className="whitespace-nowrap tabular-nums">{describePurchaseCredit(payment)}</td>
                      <td className="whitespace-nowrap tabular-nums">{formatMoney(payment.amountMilli)}</td>
                      <td>
                        <span className="capitalize">{payment.method}</span>
                      </td>
                      <td className="min-w-[10rem]">
                        <Pill tone={STATE_TONES[payment.state] ?? 'grey'}>{STATE_LABELS[payment.state]}</Pill>
                        {payment.state === 'refunded' && (
                          <p className={styles.note} data-tone="warn">
                            {describeRefundedNote(payment)}
                          </p>
                        )}
                        {payment.failure && (
                          <p className={styles.note} data-tone="error">
                            {payment.failure}
                          </p>
                        )}
                      </td>
                      <td className="text-right">
                        {payment.state === 'paid' && (
                          <button
                            type="button"
                            onClick={() => {
                              setConfirming(confirming === payment.id ? '' : payment.id);
                              setNote('');
                            }}
                            className="tl-button-quiet"
                            data-size="sm"
                            data-tone="danger"
                          >
                            Refund
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/*
              The way past the first page. Shown only while there is more, so a
              small installation never sees a button that would do nothing.
            */}
            {payments.length < total && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="tl-button-quiet"
                >
                  {loadingMore ? 'Loading…' : `Show older payments (${total - payments.length} more)`}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {confirmingPayment && (
        <RefundDialog
          payment={confirmingPayment}
          note={note}
          onNote={setNote}
          refunding={refunding === confirmingPayment.id}
          error={error}
          onRefund={() => void refund(confirmingPayment)}
          onCancel={() => setConfirming('')}
        />
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
