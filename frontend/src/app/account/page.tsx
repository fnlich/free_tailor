'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

import AppTopNav from '@/components/AppTopNav';
import CreditLedger from '@/components/CreditLedger';
import { useAuth } from '@/contexts/AuthContext';
import { authApi, describeProfileUsage, type AccountPlan } from '@/lib/auth';
import { creditsApi, type CreditStatus, type LedgerEntry } from '@/lib/credits';
import { sheetApi, type AccountSheet, type SheetVisibility } from '@/lib/sheet';

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
  const [credits, setCredits] = useState<CreditStatus | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<AccountSheet | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    authApi.plans().then(({ plans: list }) => setPlans(list)).catch(() => setPlans([]));
  }, []);

  /**
   * Settled, not all: the balance and the history are independent, and one
   * failing should not blank the other. A user whose history loaded fine has no
   * reason to be shown an error instead of it.
   */
  useEffect(() => {
    void (async () => {
      const [status, entries] = await Promise.allSettled([
        creditsApi.status(),
        creditsApi.ledger(50),
      ]);
      if (status.status === 'fulfilled') setCredits(status.value);
      if (entries.status === 'fulfilled') setLedger(entries.value.entries);
    })();
  }, []);

  /**
   * The sheet loads on its own, and slowly the first time.
   *
   * On a brand new account this call is what creates the spreadsheet, which is
   * several round trips to Google - so it is deliberately not bundled with the
   * credits fetch above. A page that waited for it would be blank for seconds
   * on the one visit where everything else is already known.
   */
  useEffect(() => {
    void (async () => {
      try {
        setSheet(await sheetApi.get());
      } catch (caught) {
        setSheetError(caught instanceof Error ? caught.message : 'Could not load your sheet.');
      }
    })();
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

  const changeVisibility = async (visibility: SheetVisibility) => {
    setSharing(true);
    setSheetError(null);
    try {
      const result = await sheetApi.setVisibility(visibility);
      // Stored from the response rather than from the button that was pressed:
      // the server reads the answer back from Drive, and that is the state that
      // is actually true.
      setSheet((current) => (current ? { ...current, visibility: result.visibility } : current));
    } catch (caught) {
      setSheetError(caught instanceof Error ? caught.message : 'Could not change the sharing.');
    } finally {
      setSharing(false);
    }
  };

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

        <section id="sheet" className={CARD}>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Your job sheet</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
            One Google spreadsheet belongs to this account, with a tab for each day you sign in,
            named like <code className="rounded bg-gray-100 px-1 dark:bg-slate-800">09/17/2026</code>.
            Each tab starts with the job columns - company, job title, link, description, rate and
            your notes.
          </p>

          {sheetError && (
            <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-900/30 dark:text-red-100">
              {sheetError}
            </p>
          )}

          {!sheet && !sheetError && (
            <p className="mt-4 text-sm text-gray-600 dark:text-slate-300">
              {/* The honest wording. On a new account this call is creating the
                  spreadsheet, and "loading" would undersell how long that takes. */}
              Preparing your sheet...
            </p>
          )}

          {sheet && !sheet.configured && (
            <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">
              {sheet.message ?? 'Google Sheets is not set up on this server.'}
            </p>
          )}

          {sheet?.configured && sheet.spreadsheetUrl && (
            <>
              <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <dt className={LABEL}>Spreadsheet</dt>
                  <dd className="mt-1 text-sm">
                    <a
                      // Today's tab when we know its id, so the link opens the
                      // day being worked on rather than whichever tab Google
                      // decides to show first - which, once there are thirty
                      // of them, is not the one anybody wants.
                      href={sheet.todayTabUrl ?? sheet.spreadsheetUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                    >
                      Open in Google Sheets
                    </a>
                  </dd>
                </div>
                <div>
                  <dt className={LABEL}>Today&apos;s tab</dt>
                  <dd className={VALUE}>{sheet.todayTab}</dd>
                </div>
              </dl>

              <div className="mt-6 border-t border-gray-200 pt-4 dark:border-slate-800">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Who can open it</h3>

                <div className="mt-3 flex flex-wrap gap-2">
                  {(['public', 'private'] as const).map((option) => {
                    const current = sheet.visibility === option;
                    return (
                      <button
                        key={option}
                        type="button"
                        disabled={sharing || current}
                        onClick={() => void changeVisibility(option)}
                        className={`rounded-lg border px-4 py-2 text-sm font-medium transition ${
                          current
                            ? 'border-blue-500 bg-blue-600 text-white'
                            : 'border-gray-300 text-gray-700 hover:border-gray-400 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:text-slate-200'
                        }`}
                      >
                        {option === 'public' ? 'Anyone with the link' : 'Only me'}
                      </button>
                    );
                  })}
                </div>

                {/* Named plainly, because the link is the only thing between a
                    stranger and rewriting these rows. */}
                <p className="mt-3 text-sm text-gray-600 dark:text-slate-300">
                  {sheet.visibility === 'public'
                    ? 'Anyone who has the link can open this sheet and edit it. Share the link carefully.'
                    : 'Only you can open this sheet. Your account keeps edit access through the address you sign in with.'}
                </p>
                <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
                  Either way this server keeps its own access, so job links, company names and
                  descriptions still load when you generate resumes.
                </p>
              </div>
            </>
          )}
        </section>

        <section id="credits" className={CARD}>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Credits</h2>

          {/*
            Stated unconditionally, not only once the fetch lands. If /credits
            fails, a balance with no explanation beside it is exactly the
            information vacuum this section exists to fill.
          */}
          <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
            One credit builds one resume, however many files it produces - a PDF, a DOCX and a cover
            letter together still cost one. Previews are free and keep working at zero.
          </p>

          <p className="mt-4 text-3xl font-semibold text-gray-900 dark:text-white">
            {credits?.balance ?? account.credits}
          </p>

          {credits && credits.held > 0 && (
            <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
              {/* The dip is real, so it is named. Otherwise the number appears to
                  drop and then come back from nowhere. */}
              A run in progress is holding <strong>{credits.held}</strong>. Any resume that does not
              build gives its credit back.
            </p>
          )}

          {credits?.exempt ? (
            <p className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:bg-blue-900/30 dark:text-blue-100">
              You are an administrator, so your runs spend nothing. This balance stays where it is.
            </p>
          ) : (
            (credits?.balance ?? account.credits) === 0 && (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">
                You have no credits, so generating a resume will be refused. Previews still work.{' '}
                {/* The buy page decides what to offer - it is the only thing
                    that knows whether a payment method is configured, and
                    saying "buy some" here when none is would be worse than the
                    "ask an administrator" copy this replaced. */}
                <Link href="/credits" className="font-semibold underline">
                  Buy credits
                </Link>
                .
              </p>
            )
          )}

          {(credits?.balance ?? account.credits) > 0 && !credits?.exempt && (
            <Link
              href="/credits"
              className="mt-4 inline-block rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              Buy credits
            </Link>
          )}

          <div className="mt-6 border-t border-gray-200 pt-4 dark:border-slate-800">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">History</h3>
            <div className="mt-2">
              <CreditLedger entries={ledger} />
            </div>
          </div>
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
