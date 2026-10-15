'use client';

import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AdminOnly } from '@/components/auth/AuthGate';
import { useDialogLayer } from '@/components/ui/Dialog';
import { Card, EmptyState, Notice, Pill, Section, Spinner, Status } from '@/components/ui/kit';
import SettingSource from '@/components/ui/SettingSource';
import { adminApi, type AdminAppSettings, type AdminAppSettingsUpdate } from '@/lib/api';
import { appSettingSourceLabel, canReset, resetBody } from '@/lib/settingSources';
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
import { formatDate, formatMoney, parseDollars } from '@/lib/format';
import { describeClosedRequests, openRequestCount, readRefundFilter } from '@/lib/refundDisplay';
import { adminRefundRequestsApi, type RefundRequestCounts, type RefundStateFilter } from '@/lib/refunds';
import { messageWithDetail } from '@/lib/userMessage';
import styles from './page.module.css';
import {
  allLimitsSourceLabel,
  describeLimitDefault,
  describeLimits,
  limitChanges,
  limitSourceLabel,
  replaceLimitDraft,
  targetLabel,
  toLimitDraft,
  type LimitDraft,
} from './limitDraft';
import RefundQueue from './RefundQueue';

/**
 * Every payment, for reconciliation and refunds - and, on its second tab
 * (`?tab=refunds`, where every notice about a new request links), the queue of
 * refund requests people have made.
 *
 * Under `/admin`, so the nav comes from that layout rather than from here.
 */

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
  source,
}: {
  draft: LimitDraft;
  onChange: (next: LimitDraft) => void;
  /** Absent while there is nothing to remove: a method that follows .env comes back. */
  onRemove?: () => void;
  /** Where this method's limits came from, with its own Reset to default. */
  source?: ReactNode;
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
        onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="tl-button-quiet"
            data-size="sm"
            data-tone="danger"
          >
            Remove
          </button>
        ) : undefined
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
      {source}
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
  const [settings, setSettings] = useState<AdminAppSettings | null>(null);
  const [limits, setLimits] = useState<LimitDraft[]>([]);
  const [require3ds, setRequire3ds] = useState(false);
  const [newTarget, setNewTarget] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState('');

  const adopt = (next: AdminAppSettings) => {
    setSettings(next);
    setLimits(next.paymentLimits.map(toLimitDraft));
    setRequire3ds(next.requireThreeDSecure);
  };
  // A Reset takes in only what it reset; whatever is typed elsewhere stays typed.
  const adoptLimits = (next: AdminAppSettings) => {
    setSettings(next);
    setLimits(next.paymentLimits.map(toLimitDraft));
  };
  const adoptLimit = (target: string) => (next: AdminAppSettings) => {
    setSettings(next);
    setLimits((current) => replaceLimitDraft(current, next.paymentLimits, target));
  };
  const adoptCardSecurity = (next: AdminAppSettings) => {
    setSettings(next);
    setRequire3ds(next.requireThreeDSecure);
  };

  useEffect(() => {
    void (async () => {
      try {
        adopt(await adminApi.getSettings());
      } catch {
        setProblem('Could not load the current purchase limits.');
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  /**
   * Only what changed - and of the limits, only the methods that changed.
   * Each method and the switch follow .env until an administrator sets them,
   * so a save that sent them unchanged would freeze whatever .env said that
   * day.
   */
  const changes = (): AdminAppSettingsUpdate => {
    if (!settings) return {};
    const body: AdminAppSettingsUpdate = {};
    const limitRows = limitChanges(limits, settings.paymentLimits, settings.paymentLimitSources);
    if (limitRows.length > 0) body.paymentLimits = limitRows;
    if (require3ds !== settings.requireThreeDSecure) body.requireThreeDSecure = require3ds;
    return body;
  };

  const send = async (
    body: AdminAppSettingsUpdate,
    said: string,
    take: (next: AdminAppSettings) => void = adopt
  ) => {
    setSaving(true);
    setNote('');
    setProblem('');
    try {
      take(await adminApi.updateSettings(body));
      setNote(said);
      onSaved();
    } catch (err) {
      setProblem(messageWithDetail(err, 'Could not save the purchase limits.'));
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    const body = changes();
    if (Object.keys(body).length === 0) {
      setProblem('');
      setNote('Nothing to save: the limits and card security are as they were.');
      return;
    }
    void send(body, 'Saved. It applies to new purchases only.');
  };

  if (!loaded) return null;
  const sources = settings?.settingSources;
  const defaults = settings?.settingDefaults;

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
        {sources && defaults && (
          <SettingSource
            label={appSettingSourceLabel(sources, 'requireThreeDSecure')}
            resettable={canReset(sources.requireThreeDSecure)}
            gives={defaults.requireThreeDSecure ? 'on' : 'off'}
            name="card security"
            busy={saving}
            onReset={() =>
              void send(resetBody('requireThreeDSecure'), 'Card security reset to its default.', adoptCardSecurity)
            }
          />
        )}
      </Section>

      <Section
        title="Limits per payment method"
        description={
          <>
            In dollars and whole cents: the smallest and largest single purchase, and the amounts
            offered as buttons (a button outside the bounds is not offered). Each method follows its
            default limits - {defaults ? describeLimits(defaults.paymentLimits) : 'the built-in limits'},
            from .env&apos;s PAYMENT_*_USD where it sets them - until it is changed here, on its own:
            saving one method never fixes another&apos;s. Its Reset to default switches it back; nothing
            here switches a method off.
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
          {limits.map((draft, index) => {
            const target = draft.target.trim();
            const inEffect = settings?.paymentLimits.some((row) => row.target === target) ?? false;
            const limitSources = settings?.paymentLimitSources ?? {};
            const setHere = limitSources[target]?.source === 'admin';
            return (
              <LimitFields
                key={draft.target}
                draft={draft}
                onChange={(next) =>
                  setLimits((current) =>
                    current.map((entry, position) => (position === index ? next : entry))
                  )
                }
                // A row added here, or one set here (whose Remove saves as its
                // Reset); a method that follows .env would only come back.
                onRemove={
                  !inEffect || setHere
                    ? () => setLimits((current) => current.filter((_, position) => position !== index))
                    : undefined
                }
                source={
                  inEffect && defaults ? (
                    <SettingSource
                      label={limitSourceLabel(target, limitSources)}
                      resettable={setHere}
                      gives={describeLimitDefault(target, defaults.paymentLimits)}
                      name={`the ${target} limits`}
                      busy={saving}
                      onReset={() =>
                        void send(
                          { paymentLimits: [{ target, reset: true }] },
                          `The ${target} limits are reset to their default.`,
                          adoptLimit(target)
                        )
                      }
                    />
                  ) : undefined
                }
              />
            );
          })}
          {limits.length === 0 && (
            <p className="text-sm text-muted">
              No rows. Saving with none restores the defaults rather than leaving every method
              unbounded.
            </p>
          )}
          {sources && defaults && (
            <SettingSource
              label={allLimitsSourceLabel(sources.paymentLimits, settings?.paymentLimitSources ?? {})}
              resettable={canReset(sources.paymentLimits)}
              gives={describeLimits(defaults.paymentLimits)}
              name="every method's limits"
              busy={saving}
              onReset={() =>
                void send(resetBody('paymentLimits'), 'Purchase limits reset to their defaults.', adoptLimits)
              }
            />
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
            onClick={save}
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
 * the refund itself only ever starts from the button. Escape only while this
 * is the top dialog: its error notice offers Contact admin, which opens over
 * it (`useDialogLayer`). A refusal is repeated in
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

  // On the kit's dialog stack: its error notice can open Contact admin over
  // it, and an Escape meant for that must not close this - and the note in it.
  useDialogLayer(true, onCancel);

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
            is "not by us" - and pressing it does NOTHING:
            `refundPayment` answers 409 for every crypto provider
            before touching the balance, and finding that out by
            pressing is a worse way than reading it here. A row
            from a crypto provider since removed is pointed back
            at wherever it was taken, as the server's refusal is.
          */}
          {payment.method === 'crypto' ? (
            <>
              {payment.provider === 'cryptomus'
                ? 'This cannot be sent back from here. Return it from your Cryptomus merchant dashboard.'
                : 'This cannot be sent back from here. Send the funds back from wherever this payment was taken.'}{' '}
              Then adjust the balance from the accounts page. Pressing this reverses
              nothing and will say so.
            </>
          ) : (
            <>
              The money goes back through {payment.provider}. Credit already spent
              cannot be reversed - a balance never goes below $0 - and this will say
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
      setMessage(describeRefundOutcome(payment.reference, outcome) + describeClosedRequests(outcome.closedRequests));
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
      <PricingCard onSaved={() => void load()} />

      <div className="space-y-4 pt-8">
        {total > payments.length && (
          <p className="text-sm text-muted">
            Showing the newest {payments.length} of {total} payments.
          </p>
        )}
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

type PaymentsTab = 'payments' | 'refunds';

const TABS: Array<{ id: PaymentsTab; label: string }> = [
  { id: 'payments', label: 'Payments' },
  { id: 'refunds', label: 'Refund requests' },
];

/** Anything the page does not recognise is the payments list, not an error. */
function readTab(value: string | null | undefined): PaymentsTab {
  return value === 'refunds' ? 'refunds' : 'payments';
}

/**
 * The page's title and its two tabs. The tab and the queue's filter live in
 * the URL and only there, as /credits does it, so the link in a "New refund
 * request" notice lands on the queue - also when it is followed from this
 * page.
 */
function PaymentsPage() {
  const router = useRouter();
  const search = useSearchParams();
  const tab = readTab(search?.get('tab'));
  const filter = readRefundFilter(search?.get('state'), 'open');

  /*
   * The open count for the tab's badge, read once on arrival so the Payments
   * tab says there is a queue waiting; the queue itself keeps it current while
   * it is open.
   */
  const [counts, setCounts] = useState<RefundRequestCounts | null>(null);
  useEffect(() => {
    let alive = true;
    adminRefundRequestsApi.list(0, 1, 'open').then(
      (answer) => {
        if (alive) setCounts(answer.counts);
      },
      () => undefined
    );
    return () => {
      alive = false;
    };
  }, []);

  const go = useCallback(
    (changes: { tab?: PaymentsTab; state?: RefundStateFilter }) => {
      const params = new URLSearchParams(search?.toString() ?? '');
      if (changes.tab) {
        if (changes.tab === 'payments') {
          params.delete('tab');
          params.delete('state');
        } else params.set('tab', changes.tab);
      }
      if (changes.state) {
        if (changes.state === 'open') params.delete('state');
        else params.set('state', changes.state);
      }
      const query = params.toString();
      router.replace(query ? `/admin/payments?${query}` : '/admin/payments', { scroll: false });
    },
    [router, search]
  );

  // Arrow keys move along the row, as the ARIA tabs pattern expects.
  const tabRefs = useRef(new Map<PaymentsTab, HTMLButtonElement>());
  const onTabKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    event.preventDefault();
    tabRefs.current.get(TABS[next].id)?.focus();
    go({ tab: TABS[next].id });
  };

  const waiting = openRequestCount(counts);

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
          Every purchase of credit on this installation, and the refunds people have asked for. Quote the
          reference when reconciling against your provider&apos;s dashboard.
        </p>
      </header>

      <div role="tablist" aria-label="Payments" className="tl-tabs mt-6">
        {TABS.map((entry, index) => {
          const active = entry.id === tab;
          return (
            <button
              key={entry.id}
              ref={(node) => {
                if (node) tabRefs.current.set(entry.id, node);
                else tabRefs.current.delete(entry.id);
              }}
              type="button"
              role="tab"
              id={`payments-tab-${entry.id}`}
              aria-selected={active}
              aria-controls="payments-panel"
              tabIndex={active ? 0 : -1}
              data-active={active}
              className="tl-tab"
              onClick={() => go({ tab: entry.id })}
              onKeyDown={(event) => onTabKey(event, index)}
            >
              {entry.label}
              {entry.id === 'refunds' && waiting > 0 && (
                <span className="ml-2" aria-label={`${waiting} open`}>
                  <Pill tone="amber">{waiting}</Pill>
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div id="payments-panel" role="tabpanel" aria-labelledby={`payments-tab-${tab}`} className="mt-8">
        {tab === 'refunds' ? (
          /* Keyed on the filter, so a new one starts from its first page. */
          <RefundQueue key={filter} filter={filter} onFilter={(state) => go({ state })} onCounts={setCounts} />
        ) : (
          <PaymentsBody />
        )}
      </div>
    </div>
  );
}

export default function AdminPaymentsPage() {
  return (
    <AdminOnly>
      {/* `useSearchParams` needs a Suspense boundary to prerender. */}
      <Suspense fallback={<Spinner />}>
        <PaymentsPage />
      </Suspense>
    </AdminOnly>
  );
}
