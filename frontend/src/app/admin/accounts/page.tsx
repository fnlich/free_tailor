'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';

import { AdminOnly } from '@/components/auth/AuthGate';
import { useAuth } from '@/contexts/AuthContext';
import {
  accountsApi,
  type AccountChange,
  type AccountSubscription,
  type AccountSubscriptionId,
  type ManagedAccount,
  type RoleOption,
  type UserRole,
} from '@/lib/auth';
import { describeLedgerReason, type LedgerEntry } from '@/lib/credits';
import { describeDollarProblem, formatDate, formatMoney, parseDollars, toDollarInput } from '@/lib/format';
import { describeLedgerBalance, describeLedgerChange, ledgerDirection } from '@/lib/ledger';
import {
  describePayoutAmount,
  describeReportRate,
  globalRatePlaceholder,
  MAX_PAYOUT_NOTE,
  mintPayoutRequestId,
  parseReportRate,
  payoutProblem,
} from '@/lib/reporterPay';
import { ACCOUNT_ROLES, ROLE_LABELS, configuredAdminNotes } from '@/lib/roles';
import { Field, Notice, Pill, Section, Spinner } from '@/components/ui/kit';
import { messageWithDetail } from '@/lib/userMessage';
import styles from './page.module.css';

/**
 * Managing everybody's accounts.
 *
 * Each control writes on change rather than collecting a form and saving it.
 * The alternative - a Save button per row - hides which of eight rows have
 * unsaved edits, and the server refuses the changes that matter (the last
 * admin, an unknown subscription) rather than the page, so a refusal has to be shown
 * per control anyway.
 *
 * The signed-in administrator's OWN row cannot be demoted, disabled or
 * deleted from here, and says so: the server refuses all three for the
 * caller's own account (another administrator may still do them), so the
 * controls are locked rather than offered and refused.
 *
 * A reporter's row (owner decisions A3, A4, J7) carries two more things: their
 * own rate per job, in dollars - empty means the installation's global rate -
 * and Record payout, for money already paid to them outside the app, which
 * takes it off their balance with a note saying how it was paid.
 */

/**
 * Why a typed grant cannot be applied, or '' when it can: an amount in
 * dollars to the thousandth, positive to add and negative to take away, and
 * not zero - a grant of nothing is a row in somebody's history that says
 * nothing happened. The server's own parser and words (lib/format.ts), so the
 * button says what the server would.
 */
function grantProblem(text: string): string {
  const parsed = parseDollars(text, { allowNegative: true });
  if (!parsed.ok) return describeDollarProblem(parsed.problem, 'The amount');
  if (parsed.milli === 0) return 'Enter an amount to add, like 5 or 0.25, or a negative one to take away.';
  return '';
}

/** Why a typed rate per job cannot be stored, or '' when it can - empty included, which is the global rate. */
function rateProblem(text: string): string {
  const parsed = parseReportRate(text);
  return parsed.ok ? '' : parsed.error;
}

/**
 * Record payout, under a reporter's row: the amount already paid, how it was
 * paid, and - as the amount is typed - the balance it will leave.
 *
 * The amount is checked as it is typed, in the server's words, and so is the
 * note, which the button's title names; nothing is clamped, because the record
 * is of money that has already left and must say what was paid.
 */
function PayoutForm({
  row,
  busy,
  amount,
  note,
  onAmount,
  onNote,
  onSubmit,
}: {
  row: ManagedAccount;
  busy: boolean;
  amount: string;
  note: string;
  onAmount: (value: string) => void;
  onNote: (value: string) => void;
  onSubmit: () => void;
}) {
  const problem = payoutProblem(amount, note, row.balanceMilli);
  const line = describePayoutAmount(amount, row.balanceMilli);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="mb-4 space-y-3"
      aria-labelledby={`payout-heading-${row.id}`}
    >
      <div>
        <h3 id={`payout-heading-${row.id}`} className="text-sm font-semibold text-ink">
          Record a payout to {row.email}
        </h3>
        <p className="mt-1 text-xs text-subtle">
          For money already paid outside the app - by bank transfer, or however you pay reporters.
          It is taken off their balance and shown in their history, and their bell, with your note.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-36">
          <label className="tl-label" htmlFor={`payout-${row.id}`}>
            Amount paid ($)
          </label>
          <input
            id={`payout-${row.id}`}
            type="text"
            inputMode="decimal"
            autoFocus
            value={amount}
            disabled={busy}
            onChange={(event) => onAmount(event.target.value)}
            placeholder="25.00"
            aria-describedby={`payout-line-${row.id}`}
            className="tl-input mt-2 tabular-nums"
          />
        </div>
        <div className="min-w-[14rem] flex-1">
          <label className="tl-label" htmlFor={`payout-note-${row.id}`}>
            How it was paid
          </label>
          <input
            id={`payout-note-${row.id}`}
            value={note}
            disabled={busy}
            maxLength={MAX_PAYOUT_NOTE}
            onChange={(event) => onNote(event.target.value)}
            placeholder="Bank transfer, 2026-10-01, ref 4471"
            className="tl-input mt-2"
          />
        </div>
        <button
          type="submit"
          // Disabled with the reason, rather than pressed and refused.
          disabled={busy || Boolean(problem)}
          title={problem || undefined}
          className="tl-button"
        >
          {busy ? 'Recording...' : 'Record payout'}
        </button>
      </div>
      <p
        id={`payout-line-${row.id}`}
        className="tl-status text-subtle tabular-nums"
        data-tone={line.tone === 'error' ? 'error' : undefined}
        aria-live="polite"
      >
        {line.text}
      </p>
    </form>
  );
}

/** The server's role catalog, for a backend that predates sending one. */
const FALLBACK_ROLES: RoleOption[] = ACCOUNT_ROLES.map((id) => ({ id, label: ROLE_LABELS[id] }));

/** Said on your own row, beside the controls it locks. */
const OWN_ROW_NOTE =
  'Your own account: you cannot change its role, disable it or delete it. Another administrator can.';

function AccountsTable() {
  const { account: me, refresh: refreshMe } = useAuth();

  const [accounts, setAccounts] = useState<ManagedAccount[]>([]);
  const [subscriptions, setSubscriptions] = useState<AccountSubscription[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>(FALLBACK_ROLES);
  /**
   * The rate a reporter with no rate of their own is paid, set on Admin -> Job
   * Lake: what an empty rate box means, named by its figure. Null until the
   * list arrives (or from a backend from before the job lake).
   */
  const [globalRateMilli, setGlobalRateMilli] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Which row is mid-write, so its controls can be disabled individually. */
  const [busyId, setBusyId] = useState<string | null>(null);

  /**
   * Which account's history is open, and what it holds.
   *
   * A request token rather than comparing against the state: reading `detail`
   * inside an async callback captures the value from the render that started
   * it, which is the PREVIOUS one - so a guard written that way would reject
   * the right response and admit a stale one, painting another account's
   * ledger under this row.
   */
  const ledgerRequest = useRef(0);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<LedgerEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [grantFor, setGrantFor] = useState<string | null>(null);
  const [grantAmount, setGrantAmount] = useState('');
  const [grantNote, setGrantNote] = useState('');

  /**
   * The reporter whose Record payout form is open, and its id - minted when
   * the form opens and kept across retries, so a press whose answer was lost
   * and is pressed again records the payout once (the server answers the
   * repeat `recorded: false`, with the first row).
   */
  const [payoutFor, setPayoutFor] = useState<string | null>(null);
  const [payoutAmount, setPayoutAmount] = useState('');
  const [payoutNote, setPayoutNote] = useState('');
  const [payoutRequestId, setPayoutRequestId] = useState('');

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<UserRole>('user');
  const [inviteSubscription, setInviteSubscription] = useState<AccountSubscriptionId>('default');
  const [inviteRate, setInviteRate] = useState('');
  const [inviting, setInviting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await accountsApi.list();
      setAccounts(data.accounts);
      setSubscriptions(data.subscriptions);
      if (Array.isArray(data.roles) && data.roles.length > 0) setRoles(data.roles);
      setGlobalRateMilli(typeof data.globalReportRateMilli === 'number' ? data.globalReportRateMilli : null);
      setError(null);
    } catch (caught) {
      setError(messageWithDetail(caught, 'Could not load accounts.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = async (id: string, action: () => Promise<AccountChange | null>) => {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      const change = await action();
      if (change) {
        const updated = change.account;
        setAccounts((current) => current.map((row) => (row.id === updated.id ? updated : row)));
        // The change was stored but will not last - an ADMIN_EMAILS (or
        // SMTP_USER) address made something other than an administrator - and
        // the server says so.
        if (change.note) setNotice(change.note);
        // The signed-in admin may have just changed their OWN subscription or role, and
        // the top bar reads that from the provider rather than from this page.
        if (updated.id === me?.id) void refreshMe();
      } else {
        await load();
      }
    } catch (caught) {
      setError(messageWithDetail(caught, 'That change was refused.'));
      // Reloaded so the control snaps back to what the server actually holds,
      // rather than showing a value the refusal means was never stored.
      await load();
    } finally {
      setBusyId(null);
    }
  };

  /** Fetches one account's ledger into the panel. Does not open or close it. */
  const reloadHistory = async (id: string) => {
    const token = (ledgerRequest.current += 1);
    setHistory([]);
    setHistoryLoading(true);
    try {
      const result = await accountsApi.ledger(id);
      // Only if this is still the newest request. Two quick clicks would
      // otherwise let the slower response paint under the wrong account.
      if (ledgerRequest.current === token) setHistory(result.entries);
    } catch (caught) {
      if (ledgerRequest.current === token) {
        setError(messageWithDetail(caught, 'Could not load that history.'));
      }
    } finally {
      if (ledgerRequest.current === token) setHistoryLoading(false);
    }
  };

  const openHistory = async (id: string) => {
    if (historyFor === id) {
      setHistoryFor(null);
      return;
    }
    setHistoryFor(id);
    await reloadHistory(id);
  };

  const grant = async (row: ManagedAccount) => {
    // Sent as TYPED, never as a number this page worked out: the server parses
    // dollars exactly, and "0.1" read as a float and sent back is not 0.1.
    if (grantProblem(grantAmount)) return;

    await apply(row.id, async () => {
      const result = await accountsApi.grantCredits(row.id, grantAmount.trim(), grantNote.trim());
      return { account: result.account };
    });
    setGrantFor(null);
    setGrantAmount('');
    setGrantNote('');
    // Reloaded, not re-opened: openHistory TOGGLES, so calling it on the row
    // whose history is already open would close the panel the grant was
    // supposed to appear in.
    if (historyFor === row.id) await reloadHistory(row.id);
  };

  /** Opens one of a row's two forms, closing the other: one panel under a row at a time. */
  const openGrant = (id: string) => {
    setPayoutFor(null);
    setGrantFor(grantFor === id ? null : id);
    setGrantAmount('');
    setGrantNote('');
  };

  const openPayout = (id: string) => {
    setGrantFor(null);
    setPayoutFor(payoutFor === id ? null : id);
    setPayoutAmount('');
    setPayoutNote('');
    setPayoutRequestId(mintPayoutRequestId());
  };

  /**
   * Records a payout already made. Not through `apply`: the answer is a row
   * AND a sentence about the money, and a refusal - above the balance, most
   * likely, if it moved since the page loaded - keeps the form open with what
   * was typed, and its id, for the retry.
   */
  const recordPayout = async (row: ManagedAccount) => {
    if (payoutProblem(payoutAmount, payoutNote, row.balanceMilli)) return;
    setBusyId(row.id);
    setError(null);
    setNotice(null);
    try {
      const result = await accountsApi.recordPayout(row.id, {
        // As typed: the server parses dollars exactly, as it does a grant.
        amountUsd: payoutAmount.trim(),
        note: payoutNote.trim(),
        requestId: payoutRequestId,
      });
      setAccounts((current) => current.map((entry) => (entry.id === result.account.id ? result.account : entry)));
      const paid = formatMoney(-result.entry.deltaMilli);
      setNotice(
        result.recorded
          ? `Recorded a payout of ${paid} to ${row.email}. Their balance is now ${formatMoney(result.balanceMilli)}.`
          : `That payout of ${paid} to ${row.email} was already recorded, so nothing more was taken. ` +
              `Their balance is ${formatMoney(result.balanceMilli)}.`
      );
      setPayoutFor(null);
      setPayoutAmount('');
      setPayoutNote('');
      if (historyFor === row.id) await reloadHistory(row.id);
    } catch (caught) {
      setError(messageWithDetail(caught, 'Could not record that payout.'));
      // The balance it was measured against may have moved; show the real one.
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const inviteRateProblem = inviteRole === 'reporter' ? rateProblem(inviteRate) : '';

  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inviteRateProblem) return;
    setInviting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await accountsApi.create({
        email: inviteEmail,
        role: inviteRole,
        subscription: inviteSubscription,
        // Only a reporter is paid per job; empty is the global rate, so nothing is sent.
        ...(inviteRole === 'reporter' && inviteRate.trim() ? { reportRateUsd: inviteRate.trim() } : {}),
      });
      setInviteEmail('');
      setInviteRate('');
      const as = roles.find((role) => role.id === inviteRole)?.label ?? ROLE_LABELS[inviteRole];
      setNotice(
        [
          `Account created for ${inviteEmail}, as ${/^[aeiou]/i.test(as) ? 'an' : 'a'} ${as}. They still have to ` +
            'sign in with Google or an emailed code - this only sets the account up in advance.',
          result.note,
        ]
          .filter(Boolean)
          .join(' ')
      );
      await load();
    } catch (caught) {
      setError(messageWithDetail(caught, 'Could not create that account.'));
    } finally {
      setInviting(false);
    }
  };

  const remove = async (row: ManagedAccount) => {
    if (
      !window.confirm(
        `Delete the account for ${row.email}?\n\n` +
          'Their profiles are NOT deleted - they stay in the database, visible to administrators, ' +
          'until you reassign or delete them.'
      )
    ) {
      return;
    }
    setBusyId(row.id);
    setError(null);
    try {
      const result = await accountsApi.remove(row.id);
      setNotice(result.note ?? `Deleted the account for ${row.email}.`);
      await load();
    } catch (caught) {
      setError(messageWithDetail(caught, 'Could not delete that account.'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <header>
        <h2 className="text-2xl font-bold tracking-tight text-ink">Accounts</h2>
        <p className="mt-1 text-sm text-muted">
          Everybody who can sign in to this installation, and what their subscription allows them.
        </p>
      </header>

      {(error || notice) && (
        <div className="mt-6 space-y-3">
          {error && (
            <Notice tone="error" role="alert">
              {error}
            </Notice>
          )}
          {notice && (
            <Notice tone="info" role="status">
              {notice}
            </Notice>
          )}
        </div>
      )}

      <Section
        title="Add an account"
        description={
          <>
            Sets somebody&apos;s role and subscription before they arrive - a reporter&apos;s rate per job
            too. It is not a way in: they still prove the address through Google or an emailed code.
          </>
        }
      >
        <form onSubmit={invite} className="space-y-6">
          <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_12rem_12rem]">
            <Field label="Email address" htmlFor="invite-email">
              <input
                id="invite-email"
                type="email"
                required
                value={inviteEmail}
                disabled={inviting}
                onChange={(event) => setInviteEmail(event.target.value)}
                placeholder="them@example.com"
                className="tl-input"
              />
            </Field>
            <Field label="Role" htmlFor="invite-role">
              <select
                id="invite-role"
                value={inviteRole}
                disabled={inviting}
                onChange={(event) => setInviteRole(event.target.value as UserRole)}
                className="tl-input"
              >
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.label}
                  </option>
                ))}
              </select>
            </Field>
            {/*
              A reporter builds no resumes, so a subscription is nothing to
              them; what they are set up with is what they are paid per job.
            */}
            {inviteRole === 'reporter' ? (
              <Field label="Rate per job ($)" htmlFor="invite-rate">
                <input
                  id="invite-rate"
                  type="text"
                  inputMode="decimal"
                  value={inviteRate}
                  disabled={inviting}
                  onChange={(event) => setInviteRate(event.target.value)}
                  placeholder={globalRatePlaceholder(globalRateMilli)}
                  aria-describedby="invite-rate-hint"
                  className="tl-input tabular-nums"
                />
              </Field>
            ) : (
              <Field label="Subscription" htmlFor="invite-subscription">
                <select
                  id="invite-subscription"
                  value={inviteSubscription}
                  disabled={inviting}
                  onChange={(event) => setInviteSubscription(event.target.value as AccountSubscriptionId)}
                  className="tl-input"
                >
                  {subscriptions.map((subscription) => (
                    <option key={subscription.id} value={subscription.id}>
                      {subscription.label}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          {inviteRole === 'reporter' && (
            <p
              id="invite-rate-hint"
              className="tl-status text-subtle"
              data-tone={inviteRateProblem ? 'error' : undefined}
              aria-live="polite"
            >
              {inviteRateProblem ||
                `Dollars per job the job lake accepts, to $0.001. Leave it empty to pay the global rate${
                  globalRateMilli === null ? '' : `, ${formatMoney(globalRateMilli)} now`
                } (Settings > Job Lake).`}
            </p>
          )}
          <button
            type="submit"
            disabled={inviting || !inviteEmail || Boolean(inviteRateProblem)}
            title={inviteRateProblem || undefined}
            className="tl-button"
          >
            {inviting ? 'Adding...' : 'Add account'}
          </button>
        </form>
      </Section>

      <div className="pt-8">
        {loading ? (
          <Spinner label="Loading accounts..." />
        ) : (
          <div className="tl-table-box relative">
            {/* `relative` so the sr-only Actions heading - absolutely positioned -
                is held by this scroll box; otherwise it escapes the sideways
                scroll and widens the whole page on a phone. */}
            <table className="tl-table">
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Role</th>
                  <th scope="col">Subscription</th>
                  <th scope="col">Profiles</th>
                  <th scope="col">Balance</th>
                  <th scope="col">Last seen</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((row) => {
                  const busy = busyId === row.id;
                  const isMe = row.id === me?.id;
                  // Said beside an address the server makes an administrator
                  // again at every sign-in, naming the setting that does it.
                  const configured = row.configuredAdmin ? configuredAdminNotes(row.configuredAdminSource) : null;
                  return (
                    <Fragment key={row.id}>
                    <tr className={row.disabled ? 'opacity-60' : undefined}>
                      <td>
                        {/* Colours on inner elements: `.tl-table td` is
                            unlayered and would beat a utility on the cell. */}
                        <p className="font-medium text-ink">
                          {row.name || row.email}
                          {isMe && <span className="ml-2 text-xs font-normal text-subtle">(you)</span>}
                        </p>
                        <p className="break-words text-xs text-subtle">{row.email}</p>
                        {isMe && <p className="mt-1 max-w-[16rem] text-xs text-muted">{OWN_ROW_NOTE}</p>}
                        {(row.role !== 'user' || row.disabled) && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {row.role === 'admin' && <Pill tone="violet">Admin</Pill>}
                            {row.role === 'reporter' && <Pill tone="amber">Reporter</Pill>}
                            {row.disabled && <Pill tone="red">Disabled</Pill>}
                          </div>
                        )}
                      </td>

                      <td>
                        <div className="w-36">
                          <select
                            value={row.role}
                            // Your own role is locked: demoting yourself is
                            // refused, and the select would only offer it.
                            disabled={busy || isMe}
                            title={isMe ? OWN_ROW_NOTE : configured?.title}
                            aria-label={`Role for ${row.email}`}
                            onChange={(event) =>
                              apply(row.id, () => accountsApi.update(row.id, { role: event.target.value as UserRole }))
                            }
                            className={`tl-input ${styles.compact}`}
                          >
                            {roles.map((role) => (
                              <option key={role.id} value={role.id}>
                                {role.label}
                              </option>
                            ))}
                          </select>
                          {configured && (
                            // Beside the select it outranks: a role set here
                            // lasts only until the next sign-in.
                            <p className="mt-1 text-xs text-subtle" title={configured.title}>
                              {configured.line}
                            </p>
                          )}
                          {row.role === 'reporter' && (
                            <div className="mt-3">
                              <label className="block text-xs text-subtle" htmlFor={`rate-${row.id}`}>
                                Rate per job
                              </label>
                              <div className="mt-1 flex items-center gap-1">
                                <span aria-hidden className="text-xs font-semibold text-muted">
                                  $
                                </span>
                                <div className="min-w-0 flex-1">
                                  <input
                                    id={`rate-${row.id}`}
                                    // Remounted when the stored rate moves, like the
                                    // balance box: an uncontrolled input would otherwise
                                    // keep showing what it held before.
                                    key={`${row.id}:${row.reportRateMilli ?? 'global'}`}
                                    type="text"
                                    inputMode="decimal"
                                    defaultValue={row.reportRateMilli === null ? '' : toDollarInput(row.reportRateMilli)}
                                    placeholder={globalRatePlaceholder(globalRateMilli, true)}
                                    disabled={busy}
                                    title={`${describeReportRate(row.reportRateMilli, globalRateMilli)}. Type dollars to $0.001, or empty it for the global rate.`}
                                    // On blur, like the balance: a write per keystroke
                                    // would store $0.07 on the way to $0.075.
                                    onBlur={(event) => {
                                      const typed = event.target.value;
                                      const parsed = parseReportRate(typed);
                                      if (!parsed.ok) {
                                        setError(parsed.error);
                                        event.target.value =
                                          row.reportRateMilli === null ? '' : toDollarInput(row.reportRateMilli);
                                        return;
                                      }
                                      // Unchanged - "0.07" for $0.070, or still empty - writes nothing.
                                      if (parsed.milli === row.reportRateMilli) return;
                                      void apply(row.id, () =>
                                        accountsApi.update(row.id, { reportRateUsd: typed.trim() })
                                      );
                                    }}
                                    className={`tl-input ${styles.compact} tabular-nums`}
                                  />
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      </td>

                      <td>
                        <div className="w-32">
                          <select
                            value={row.subscription}
                            disabled={busy}
                            aria-label={`Subscription for ${row.email}`}
                            onChange={(event) =>
                              apply(row.id, () =>
                                accountsApi.update(row.id, {
                                  subscription: event.target.value as AccountSubscriptionId,
                                })
                              )
                            }
                            className={`tl-input ${styles.compact}`}
                          >
                            {subscriptions.map((subscription) => (
                              <option key={subscription.id} value={subscription.id}>
                                {subscription.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </td>

                      <td className="whitespace-nowrap">
                        <span className="tabular-nums">
                          {row.profilesUsed} / {row.profileLimit === null ? '∞' : row.profileLimit}
                        </span>
                        {row.profileLimit !== null && row.profilesUsed > row.profileLimit && (
                          // Possible and legitimate: moving an account down a
                          // subscription never deletes what it already has.
                          <span
                            className="ml-2"
                            title="Over the subscription's limit; they keep these but cannot add more."
                          >
                            <Pill tone="amber">over</Pill>
                          </span>
                        )}
                      </td>

                      <td>
                        <div className="flex items-center gap-2">
                          {/* A `$` before the box, and boxes around it: `.tl-input` is always
                              full width, and would not shrink in a flex row on its own. */}
                          <div className="flex w-28 items-center gap-1">
                            <span aria-hidden className="text-xs font-semibold text-muted">
                              $
                            </span>
                            <div className="min-w-0 flex-1">
                              <input
                                // Remounted when the balance moves from elsewhere. The
                                // input is uncontrolled, so after a delta grant it
                                // would otherwise still show the pre-grant amount and
                                // the next blur would write that stale absolute value
                                // back over the grant.
                                key={`${row.id}:${row.balanceMilli}`}
                                type="text"
                                inputMode="decimal"
                                defaultValue={toDollarInput(row.balanceMilli)}
                                disabled={busy}
                                title={`${formatMoney(row.balanceMilli)}. Type an amount in dollars to set the balance to it.`}
                                aria-label={`Balance in dollars for ${row.email}`}
                                // On blur, not on every keystroke: a write per digit
                                // would store $4 on the way to typing $40.
                                onBlur={(event) => {
                                  const typed = event.target.value;
                                  const parsed = parseDollars(typed);
                                  // Unchanged - including "3.5" for $3.500 - writes nothing.
                                  if (parsed.ok && parsed.milli === row.balanceMilli) return;
                                  if (!parsed.ok) {
                                    // Refused here in the server's words, and put back,
                                    // rather than sent to be refused there.
                                    setError(describeDollarProblem(parsed.problem, 'The balance'));
                                    event.target.value = toDollarInput(row.balanceMilli);
                                    return;
                                  }
                                  void apply(row.id, () => accountsApi.update(row.id, { balanceUsd: typed.trim() }));
                                }}
                                className={`tl-input ${styles.compact} tabular-nums`}
                              />
                            </div>
                          </div>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => openGrant(row.id)}
                            title="Add or take away credit, rather than setting a total"
                            className="tl-button-quiet"
                            data-size="sm"
                          >
                            +/-
                          </button>
                        </div>
                        {row.role === 'admin' && (
                          // The number is real and grantable, but it is not a
                          // budget: administrators spend nothing.
                          <p
                            className="mt-1 text-xs text-subtle"
                            title="Administrators are not charged for resumes and spend nothing."
                          >
                            exempt
                          </p>
                        )}
                        {row.role === 'reporter' && (
                          // Not credit to spend: what they have earned and are
                          // still owed, which Record payout takes down.
                          <p
                            className="mt-1 text-xs text-subtle"
                            title="A reporter's balance is what they have earned and not yet been paid."
                          >
                            unpaid earnings
                          </p>
                        )}
                      </td>

                      <td className="whitespace-nowrap text-xs">
                        {formatDate(row.lastLoginAt, { empty: 'Never', style: 'date' })}
                      </td>

                      <td>
                        {/* Two by two, so four actions fit beside six columns
                            without the table outgrowing its box at 1440. */}
                        <div className="ml-auto grid w-max grid-cols-2 gap-2">
                          {row.role === 'reporter' && (
                            // Only here: the server refuses a payout to any
                            // other account (409 `not-a-reporter`).
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => openPayout(row.id)}
                              title="Record money already paid to this reporter outside the app"
                              className="tl-button-quiet col-span-2"
                              data-size="sm"
                            >
                              {payoutFor === row.id ? 'Close payout' : 'Record payout'}
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy || isMe}
                            onClick={() => apply(row.id, () => accountsApi.update(row.id, { disabled: !row.disabled }))}
                            title={isMe ? OWN_ROW_NOTE : undefined}
                            className="tl-button-quiet"
                            data-size="sm"
                          >
                            {row.disabled ? 'Enable' : 'Disable'}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              apply(row.id, async () => {
                                await accountsApi.signOutEverywhere(row.id);
                                return null;
                              })
                            }
                            title="Ends every session for this account. They can sign in again; whoever holds an old cookie cannot."
                            className="tl-button-quiet"
                            data-size="sm"
                          >
                            Sign out
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void openHistory(row.id)}
                            title="Show where this balance came from"
                            className="tl-button-quiet"
                            data-size="sm"
                          >
                            {historyFor === row.id ? 'Hide' : 'History'}
                          </button>
                          <button
                            type="button"
                            disabled={busy || isMe}
                            onClick={() => void remove(row)}
                            title={isMe ? OWN_ROW_NOTE : undefined}
                            className="tl-button-quiet"
                            data-size="sm"
                            data-tone="danger"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>

                    {/*
                      A full-width row beneath the account it belongs to, rather
                      than more columns. The table is already wide, and a history
                      has no business being squeezed into a cell.
                    */}
                    {(grantFor === row.id || payoutFor === row.id || historyFor === row.id) && (
                      <tr>
                        <td colSpan={7} className="bg-surface-muted">
                          {payoutFor === row.id && (
                            <PayoutForm
                              row={row}
                              busy={busy}
                              amount={payoutAmount}
                              note={payoutNote}
                              onAmount={setPayoutAmount}
                              onNote={setPayoutNote}
                              onSubmit={() => void recordPayout(row)}
                            />
                          )}

                          {grantFor === row.id && (
                            <form
                              onSubmit={(event) => {
                                event.preventDefault();
                                void grant(row);
                              }}
                              className="mb-4 flex flex-wrap items-end gap-3"
                            >
                              <div className="w-32">
                                <label className="tl-label" htmlFor={`grant-${row.id}`}>
                                  Add credit ($)
                                </label>
                                <input
                                  id={`grant-${row.id}`}
                                  type="text"
                                  inputMode="decimal"
                                  autoFocus
                                  value={grantAmount}
                                  onChange={(event) => setGrantAmount(event.target.value)}
                                  placeholder="5.00"
                                  className="tl-input mt-2 tabular-nums"
                                />
                              </div>
                              <div className="min-w-[14rem] flex-1">
                                <label className="tl-label" htmlFor={`grant-note-${row.id}`}>
                                  Note (optional)
                                </label>
                                <input
                                  id={`grant-note-${row.id}`}
                                  value={grantNote}
                                  onChange={(event) => setGrantNote(event.target.value)}
                                  placeholder="Why this credit was added"
                                  className="tl-input mt-2"
                                />
                              </div>
                              <button
                                type="submit"
                                // Disabled rather than silently rejecting: a
                                // button that does nothing is indistinguishable
                                // from a broken one.
                                disabled={Boolean(grantProblem(grantAmount))}
                                title={grantProblem(grantAmount) || undefined}
                                className="tl-button"
                              >
                                Apply
                              </button>
                              <p className="w-full text-xs text-subtle">
                                Dollars, to $0.001: a positive amount adds, a negative one takes away
                                and stops at $0.000. The field in the table above sets a total instead.
                              </p>
                            </form>
                          )}

                          {historyFor === row.id && (
                            <div>
                              <h3 className="text-sm font-semibold text-ink">
                                Credit history for {row.email}
                              </h3>
                              {historyLoading ? (
                                <p className="mt-2 text-sm text-subtle">
                                  Loading...
                                </p>
                              ) : history.length === 0 ? (
                                <p className="mt-2 text-sm text-muted">
                                  Nothing has moved on this account yet.
                                </p>
                              ) : (
                                <ul className="tl-rows mt-3">
                                  {[...history]
                                    .sort((left, right) => right.seq - left.seq)
                                    .map((entry) => (
                                      <li
                                        key={entry.id}
                                        className="flex items-start justify-between gap-4 text-sm"
                                      >
                                        <div className="min-w-0">
                                          <p className="text-ink">
                                            {describeLedgerReason(entry)}
                                          </p>
                                          {entry.note && (
                                            <p className="truncate text-xs text-muted">
                                              {entry.note}
                                            </p>
                                          )}
                                          <p className="text-xs text-subtle">
                                            {formatDate(entry.createdAt, { empty: 'Never', style: 'date' })}
                                          </p>
                                        </div>
                                        <div className="shrink-0 text-right">
                                          <p
                                            className={`tabular-nums ${
                                              ledgerDirection(entry) > 0 ? styles.gain : styles.loss
                                            }`}
                                          >
                                            {describeLedgerChange(entry)}
                                          </p>
                                          <p className="text-xs tabular-nums text-subtle">
                                            {describeLedgerBalance(entry)} after
                                          </p>
                                        </div>
                                      </li>
                                    ))}
                                </ul>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AdminAccountsPage() {
  return (
    <AdminOnly>
      <AccountsTable />
    </AdminOnly>
  );
}
