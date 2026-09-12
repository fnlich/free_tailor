'use client';

import { useEffect, useState } from 'react';

import AppTopNav from '@/components/AppTopNav';
import { useAuth } from '@/contexts/AuthContext';
import { authApi, describeProfileUsage, type AccountPlan } from '@/lib/auth';

/**
 * The signed-in account's own page: who they are, what plan they are on, and
 * what that plan allows.
 *
 * Read-mostly on purpose. The only thing a user may change about themselves is
 * their display name - plan, credits and role are an administrator's to set,
 * and a form that let somebody pick their own plan would be a form that lies.
 */

const CARD =
  'rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900';
const LABEL = 'text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400';
const VALUE = 'mt-1 text-sm text-gray-900 dark:text-white';

function formatDate(value?: string): string {
  if (!value) return 'Never';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

export default function AccountPage() {
  const { account, refresh, adopt } = useAuth();

  const [plans, setPlans] = useState<AccountPlan[]>([]);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    authApi.plans().then(({ plans: list }) => setPlans(list)).catch(() => setPlans([]));
  }, []);

  useEffect(() => {
    if (account) setName(account.name);
  }, [account]);

  // The profile count is stale the moment somebody adds one on another page,
  // and this is where it is read most carefully.
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!account) return null;

  const saveName = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      adopt((await authApi.updateName(name)).account);
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save that name.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950">
      <AppTopNav />

      <main className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Your account</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
            Your profiles belong to this account and are not visible to anybody else on this
            installation.
          </p>
        </div>

        <section className={CARD}>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Account info</h2>

          <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <dt className={LABEL}>Email</dt>
              {/* Not editable. It is the identity both sign-in paths prove, so
                  changing it here would mean changing which account you are. */}
              <dd className={VALUE}>{account.email}</dd>
            </div>
            <div>
              <dt className={LABEL}>Role</dt>
              <dd className={VALUE}>{account.role === 'admin' ? 'Administrator' : 'User'}</dd>
            </div>
            <div>
              <dt className={LABEL}>Member since</dt>
              <dd className={VALUE}>{formatDate(account.createdAt)}</dd>
            </div>
            <div>
              <dt className={LABEL}>Last signed in</dt>
              <dd className={VALUE}>{formatDate(account.lastLoginAt)}</dd>
            </div>
          </dl>

          <form onSubmit={saveName} className="mt-6 max-w-sm">
            <label className={LABEL} htmlFor="account-name">
              Display name
            </label>
            <div className="mt-1 flex gap-2">
              <input
                id="account-name"
                value={name}
                maxLength={120}
                disabled={saving}
                onChange={(event) => {
                  setName(event.target.value);
                  setSaved(false);
                }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
              />
              <button
                type="submit"
                disabled={saving || !name.trim() || name === account.name}
                className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-400"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
            {saved && <p className="mt-2 text-sm text-green-700 dark:text-green-300">Saved.</p>}
            {error && <p className="mt-2 text-sm text-red-700 dark:text-red-300">{error}</p>}
          </form>
        </section>

        <section className={CARD}>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Credits</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
            {/* Said plainly rather than dressed up. A balance of zero next to
                no explanation reads as "you cannot use this yet", which is not
                true in this release. */}
            Nothing spends credits yet. The balance is here so an administrator can grant it and so
            it is already correct when something does.
          </p>
          <p className="mt-4 text-3xl font-semibold text-gray-900 dark:text-white">
            {account.credits}
          </p>
        </section>

        <section id="subscription" className={CARD}>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Subscription</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
            You are on <strong>{account.planLabel}</strong>. {account.planSummary}
          </p>

          <p className="mt-4 text-sm text-gray-700 dark:text-slate-200">
            Profiles used: <strong>{describeProfileUsage(account)}</strong>
          </p>

          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {plans.map((plan) => {
              const current = plan.id === account.plan;
              return (
                <div
                  key={plan.id}
                  className={`rounded-lg border p-4 ${
                    current
                      ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-500/10'
                      : 'border-gray-200 dark:border-slate-800'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-gray-900 dark:text-white">{plan.label}</p>
                    {current && (
                      <span className="rounded-full bg-blue-600 px-2 py-0.5 text-xs font-medium text-white">
                        Current
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
                    {plan.profileLimit === null ? 'Unlimited profiles' : `${plan.profileLimit} profile${plan.profileLimit === 1 ? '' : 's'}`}
                  </p>
                </div>
              );
            })}
          </div>

          <p className="mt-6 text-sm text-gray-500 dark:text-slate-400">
            {/* There is no checkout, and pretending otherwise with a disabled
                "Upgrade" button would just raise the question this sentence
                answers. */}
            Plans are set by an administrator of this installation. Ask them to move your account if
            you need more profiles.
          </p>
        </section>
      </main>
    </div>
  );
}
