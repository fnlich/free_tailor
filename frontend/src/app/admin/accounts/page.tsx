'use client';

import { useCallback, useEffect, useState } from 'react';

import { AdminOnly } from '@/components/auth/AuthGate';
import { useAuth } from '@/contexts/AuthContext';
import {
  accountsApi,
  type AccountPlan,
  type AccountPlanId,
  type ManagedAccount,
  type UserRole,
} from '@/lib/auth';

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
                  <tr key={row.id} className={row.disabled ? 'opacity-60' : undefined}>
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
                      <input
                        type="number"
                        min={0}
                        step={1}
                        defaultValue={row.credits}
                        disabled={busy}
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
