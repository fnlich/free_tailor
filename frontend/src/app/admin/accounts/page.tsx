'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';

import { AdminOnly } from '@/components/auth/AuthGate';
import { useAuth } from '@/contexts/AuthContext';
import {
  accountsApi,
  type AccountPlan,
  type AccountPlanId,
  type ManagedAccount,
  type UserRole,
} from '@/lib/auth';
import { describeLedgerReason, formatDelta, type LedgerEntry } from '@/lib/credits';

/**
 * Managing everybody's accounts.
 *
 * Each control writes on change rather than collecting a form and saving it.
 * The alternative - a Save button per row - hides which of eight rows have
 * unsaved edits, and the server refuses the changes that matter (the last
 * admin, an unknown plan) rather than the page, so a refusal has to be shown
 * per control anyway.
 */

const CARD =
  'rounded-xl border border-gray-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900';
const SELECT =
  'rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 ' +
  'focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-white';

function formatDate(value?: string): string {
  if (!value) return 'Never';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleDateString() : value;
}

function AccountsTable() {
  const { account: me, refresh: refreshMe } = useAuth();

  const [accounts, setAccounts] = useState<ManagedAccount[]>([]);
  const [plans, setPlans] = useState<AccountPlan[]>([]);
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

  const [inviteEmail, setInviteEmail] = useState('');
  const [invitePlan, setInvitePlan] = useState<AccountPlanId>('default');
  const [inviting, setInviting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await accountsApi.list();
      setAccounts(data.accounts);
      setPlans(data.plans);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load accounts.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = async (id: string, action: () => Promise<ManagedAccount | null>) => {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      const updated = await action();
      if (updated) {
        setAccounts((current) => current.map((row) => (row.id === updated.id ? updated : row)));
        // The signed-in admin may have just changed their OWN plan or role, and
        // the top bar reads that from the provider rather than from this page.
        if (updated.id === me?.id) void refreshMe();
      } else {
        await load();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That change was refused.');
      // Reloaded so the control snaps back to what the server actually holds,
      // rather than showing a value the refusal means was never stored.
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const openHistory = async (id: string) => {
    if (historyFor === id) {
      setHistoryFor(null);
      return;
    }
    const token = (ledgerRequest.current += 1);
    setHistoryFor(id);
    setHistory([]);
    setHistoryLoading(true);
    try {
      const result = await accountsApi.ledger(id);
      // Only if this is still the newest request. Two quick clicks would
      // otherwise let the slower response paint under the wrong account.
      if (ledgerRequest.current === token) setHistory(result.entries);
    } catch (caught) {
      if (ledgerRequest.current === token) {
        setError(caught instanceof Error ? caught.message : 'Could not load that history.');
      }
    } finally {
      if (ledgerRequest.current === token) setHistoryLoading(false);
    }
  };

  const grant = async (row: ManagedAccount) => {
    const amount = Number(grantAmount);
    if (!Number.isFinite(amount) || Math.floor(amount) === 0) return;

    await apply(row.id, async () => {
      const result = await accountsApi.grantCredits(row.id, Math.floor(amount), grantNote.trim());
      return result.account;
    });
    setGrantFor(null);
    setGrantAmount('');
    setGrantNote('');
    if (historyFor === row.id) await openHistory(row.id);
  };

  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    setInviting(true);
    setError(null);
    setNotice(null);
    try {
      await accountsApi.create({ email: inviteEmail, plan: invitePlan });
      setInviteEmail('');
      setNotice(
        `Account created for ${inviteEmail}. They still have to sign in with Google or an emailed ` +
          'code - this only sets the plan in advance.'
      );
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create that account.');
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
      setError(caught instanceof Error ? caught.message : 'Could not delete that account.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Accounts</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
          Everybody who can sign in to this installation, and what their plan allows them.
        </p>
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-200">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:bg-blue-900/30 dark:text-blue-100">
          {notice}
        </p>
      )}

      <section className={`${CARD} p-6`}>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Add an account</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
          Sets somebody&apos;s plan before they arrive. It is not a way in: they still prove the
          address through Google or an emailed code.
        </p>
        <form onSubmit={invite} className="mt-4 flex flex-wrap items-end gap-3">
          <div className="min-w-[16rem] flex-1">
            <label className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400" htmlFor="invite-email">
              Email address
            </label>
            <input
              id="invite-email"
              type="email"
              required
              value={inviteEmail}
              disabled={inviting}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder="them@example.com"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-white"
            />
          </div>
          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400" htmlFor="invite-plan">
              Plan
            </label>
            <select
              id="invite-plan"
              value={invitePlan}
              disabled={inviting}
              onChange={(event) => setInvitePlan(event.target.value as AccountPlanId)}
              className={`${SELECT} mt-1 block py-2`}
            >
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={inviting || !inviteEmail}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-400"
          >
            {inviting ? 'Adding...' : 'Add account'}
          </button>
        </form>
      </section>

      <section className={`${CARD} overflow-x-auto`}>
        {loading ? (
          <p className="p-6 text-sm text-gray-500 dark:text-slate-400">Loading accounts...</p>
        ) : (
          <table className="min-w-full divide-y divide-gray-200 dark:divide-slate-800">
            <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:bg-slate-950 dark:text-slate-400">
              <tr>
                <th className="px-4 py-3">Account</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">Profiles</th>
                <th className="px-4 py-3">Credits</th>
                <th className="px-4 py-3">Last seen</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 text-sm dark:divide-slate-800">
              {accounts.map((row) => {
                const busy = busyId === row.id;
                const isMe = row.id === me?.id;
                return (
                  <Fragment key={row.id}>
                  <tr className={row.disabled ? 'opacity-60' : undefined}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900 dark:text-white">
                        {row.name || row.email}
                        {isMe && <span className="ml-2 text-xs text-gray-500">(you)</span>}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-slate-400">{row.email}</p>
                      {row.disabled && (
                        <p className="mt-1 text-xs font-medium text-red-600 dark:text-red-300">Disabled</p>
                      )}
                    </td>

                    <td className="px-4 py-3">
                      <select
                        value={row.role}
                        disabled={busy}
                        onChange={(event) =>
                          apply(row.id, async () =>
                            (await accountsApi.update(row.id, { role: event.target.value as UserRole }))
                              .account
                          )
                        }
                        className={SELECT}
                      >
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                      </select>
                    </td>

                    <td className="px-4 py-3">
                      <select
                        value={row.plan}
                        disabled={busy}
                        onChange={(event) =>
                          apply(row.id, async () =>
                            (await accountsApi.update(row.id, { plan: event.target.value as AccountPlanId }))
                              .account
                          )
                        }
                        className={SELECT}
                      >
                        {plans.map((plan) => (
                          <option key={plan.id} value={plan.id}>
                            {plan.label}
                          </option>
                        ))}
                      </select>
                    </td>

                    <td className="px-4 py-3 text-gray-700 dark:text-slate-200">
                      {row.profilesUsed} / {row.profileLimit === null ? '∞' : row.profileLimit}
                      {row.profileLimit !== null && row.profilesUsed > row.profileLimit && (
                        // Possible and legitimate: moving an account down a
                        // plan never deletes what it already has.
                        <span className="ml-1 text-xs text-amber-600 dark:text-amber-300" title="Over the plan's limit; they keep these but cannot add more.">
                          over
                        </span>
                      )}
                    </td>

                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <input
                          // Remounted when the balance moves from elsewhere. The
                          // input is uncontrolled, so after a delta grant it
                          // would otherwise still show the pre-grant number and
                          // the next blur would write that stale absolute value
                          // back over the grant.
                          key={`${row.id}:${row.credits}`}
                          type="number"
                          min={0}
                          step={1}
                          defaultValue={row.credits}
                          disabled={busy}
                          title="Set the balance to this number"
                          // On blur, not on every keystroke: a write per digit
                          // would store 4 on the way to typing 40.
                          onBlur={(event) => {
                            const credits = Number(event.target.value);
                            if (!Number.isFinite(credits) || credits === row.credits) return;
                            void apply(
                              row.id,
                              async () => (await accountsApi.update(row.id, { credits })).account
                            );
                          }}
                          className={`${SELECT} w-20`}
                        />
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setGrantFor(grantFor === row.id ? null : row.id);
                            setGrantAmount('');
                            setGrantNote('');
                          }}
                          title="Add or take away credits, rather than setting a total"
                          className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                          +/-
                        </button>
                      </div>
                      {row.role === 'admin' && (
                        // The number is real and grantable, but it is not a
                        // budget: administrators spend nothing.
                        <p
                          className="mt-1 text-xs text-gray-400 dark:text-slate-500"
                          title="Administrators are exempt from credits and spend nothing."
                        >
                          exempt
                        </p>
                      )}
                    </td>

                    <td className="px-4 py-3 text-xs text-gray-500 dark:text-slate-400">
                      {formatDate(row.lastLoginAt)}
                    </td>

                    <td className="px-4 py-3">
                      <div className="flex flex-wrap justify-end gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            apply(row.id, async () =>
                              (await accountsApi.update(row.id, { disabled: !row.disabled })).account
                            )
                          }
                          className="rounded-lg border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
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
                          className="rounded-lg border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                          Sign out
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void openHistory(row.id)}
                          title="Show where this balance came from"
                          className="rounded-lg border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                          {historyFor === row.id ? 'Hide' : 'History'}
                        </button>
                        <button
                          type="button"
                          disabled={busy || isMe}
                          onClick={() => void remove(row)}
                          title={isMe ? 'You cannot delete the account you are signed in with.' : undefined}
                          className="rounded-lg border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-40 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/30"
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
                  {(grantFor === row.id || historyFor === row.id) && (
                    <tr className="bg-gray-50 dark:bg-slate-950">
                      <td colSpan={7} className="px-4 py-4">
                        {grantFor === row.id && (
                          <form
                            onSubmit={(event) => {
                              event.preventDefault();
                              void grant(row);
                            }}
                            className="mb-4 flex flex-wrap items-end gap-3"
                          >
                            <div>
                              <label
                                className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400"
                                htmlFor={`grant-${row.id}`}
                              >
                                Add credits
                              </label>
                              <input
                                id={`grant-${row.id}`}
                                type="number"
                                step={1}
                                autoFocus
                                value={grantAmount}
                                onChange={(event) => setGrantAmount(event.target.value)}
                                placeholder="10"
                                className={`${SELECT} mt-1 block w-28 py-2`}
                              />
                            </div>
                            <div className="min-w-[14rem] flex-1">
                              <label
                                className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400"
                                htmlFor={`grant-note-${row.id}`}
                              >
                                Note (optional)
                              </label>
                              <input
                                id={`grant-note-${row.id}`}
                                value={grantNote}
                                onChange={(event) => setGrantNote(event.target.value)}
                                placeholder="Why these credits were added"
                                className={`${SELECT} mt-1 block w-full py-2`}
                              />
                            </div>
                            <button
                              type="submit"
                              // Disabled rather than silently rejecting: a
                              // button that does nothing is indistinguishable
                              // from a broken one.
                              disabled={!Number.isFinite(Number(grantAmount)) || Math.floor(Number(grantAmount)) === 0}
                              title={
                                Math.floor(Number(grantAmount)) === 0
                                  ? 'Enter a number of credits to add, or a negative one to take away.'
                                  : undefined
                              }
                              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-400"
                            >
                              Apply
                            </button>
                            <p className="w-full text-xs text-gray-500 dark:text-slate-400">
                              A positive number adds, a negative one takes away. The field in the
                              table above sets a total instead.
                            </p>
                          </form>
                        )}

                        {historyFor === row.id && (
                          <div>
                            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                              Credit history for {row.email}
                            </h3>
                            {historyLoading ? (
                              <p className="mt-2 text-sm text-gray-500 dark:text-slate-400">
                                Loading...
                              </p>
                            ) : history.length === 0 ? (
                              <p className="mt-2 text-sm text-gray-600 dark:text-slate-300">
                                Nothing has moved on this account yet.
                              </p>
                            ) : (
                              <ul className="mt-2 divide-y divide-gray-200 dark:divide-slate-800">
                                {[...history]
                                  .sort((left, right) => right.seq - left.seq)
                                  .map((entry) => (
                                    <li
                                      key={entry.id}
                                      className="flex items-start justify-between gap-4 py-2 text-sm"
                                    >
                                      <div className="min-w-0">
                                        <p className="text-gray-900 dark:text-white">
                                          {describeLedgerReason(entry)}
                                        </p>
                                        {entry.note && (
                                          <p className="truncate text-xs text-gray-500 dark:text-slate-400">
                                            {entry.note}
                                          </p>
                                        )}
                                        <p className="text-xs text-gray-400 dark:text-slate-500">
                                          {formatDate(entry.createdAt)}
                                        </p>
                                      </div>
                                      <div className="shrink-0 text-right">
                                        <p
                                          className={`font-semibold ${
                                            entry.delta > 0
                                              ? 'text-green-700 dark:text-green-300'
                                              : 'text-red-700 dark:text-red-300'
                                          }`}
                                        >
                                          {formatDelta(entry.delta)}
                                        </p>
                                        <p className="text-xs text-gray-500 dark:text-slate-400">
                                          {entry.balanceAfter} after
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
        )}
      </section>
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
