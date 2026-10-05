'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import ThemeToggle from '@/components/ThemeToggle';
import { ContactAdminLink } from '@/components/contact/ContactAdminDialog';
import { Notice, Spinner } from '@/components/ui/kit';
import { useAuth } from '@/contexts/AuthContext';
import { canOpenReportJobs, redirectFor } from '@/lib/roles';
import { hasSubscription, type AccountSubscriptionId } from '@/lib/subscriptions';
import SignInPanel from './SignInPanel';

/**
 * Shows the app to whoever is signed in, and the sign-in form to everybody else.
 *
 * A wrapper rather than a redirect. There is no separate /login route to be
 * bounced to and back from, so a deep link survives signing in: the URL never
 * changes, and the page behind it renders as soon as the account arrives.
 *
 * It is also where a REPORTER is kept to their own pages (owner decision A3):
 * on any path outside lib/roles.ts's allowlist - Report Jobs, Credits,
 * Settings -> Profile and Job Sheet - they are sent to Report Jobs, and the
 * page they asked for is never mounted. Here rather than in each page because
 * every builder page fires requests the moment it mounts, and every one of
 * them answers a reporter 403 `role-not-allowed`: a reporter who followed an
 * old link would get a wall of refusals instead of their own page. An
 * allowlist rather than a list of what to keep them out of, because /admin/*
 * holds everybody's pages too (/admin/profiles), and a page added later stays
 * closed to reporters until somebody opens it.
 */

/** Pages that render for a signed-out visitor. */
const PUBLIC_PATHS = new Set<string>([]);

/**
 * The three signed-out screens carry their own theme control.
 *
 * The toggle lives in the top bar now, and the top bar is part of the
 * signed-in shell - so without this, the one screen somebody sees before they
 * have an account would be the only screen with no way to change the theme.
 */
function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      {children}
      <ThemeToggle />
    </div>
  );
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const { loading, signedIn, error, role } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  // Only once the account has arrived: the decision is its role, and until
  // then there is none to read - nobody is sent anywhere on a guess.
  const sendTo = !loading && signedIn ? redirectFor(role, pathname) : null;
  useEffect(() => {
    // `replace`, so Back does not land on the page that bounced and bounce again.
    if (sendTo) router.replace(sendTo);
  }, [router, sendTo]);

  if (PUBLIC_PATHS.has(pathname)) return <>{children}</>;

  // Distinct from signed out, and rendering the login form here would flash it
  // at somebody who is already signed in on every single page load.
  if (loading) {
    return (
      <Centered>
        <Spinner />
      </Centered>
    );
  }

  /**
   * The backend is unreachable, which is not the same as being signed out.
   *
   * Showing the sign-in form here would send somebody to type an address into
   * a form whose submit cannot possibly work, and they would conclude their
   * password was wrong rather than that the server is down.
   */
  if (error && !signedIn) {
    return (
      <Centered>
        <div className="tl-card w-full max-w-md p-6 sm:p-8">
          {/* The sentence under it says why, in words written for whoever is
              looking - the addresses tried and the port in the build go to the
              browser console (lib/userMessage.ts), not onto this card. */}
          <p className="text-xl font-semibold text-ink">Tailor is not available right now</p>
          <Notice tone="error" className="mt-4 break-words">
            {error}
          </Notice>
          <button type="button" onClick={() => window.location.reload()} className="tl-button mt-6">
            Try again
          </button>
        </div>
      </Centered>
    );
  }

  if (!signedIn)
    return (
      <>
        <SignInPanel />
        <ThemeToggle />
      </>
    );

  // On its way to Report Jobs: the page asked for is not mounted at all, so
  // none of its requests is made and refused.
  if (sendTo) {
    return (
      <Centered>
        <Spinner />
      </Centered>
    );
  }

  return <>{children}</>;
}

/**
 * The same idea for an admin-only page: shown to admins, explained to everybody
 * else.
 *
 * Explained rather than hidden. A user who followed a link to an admin page and
 * got a blank screen would reasonably think the page was broken.
 */
export function AdminOnly({ children }: { children: ReactNode }) {
  const { isAdmin, loading } = useAuth();

  if (loading) return <p className="text-sm text-subtle">Loading...</p>;

  if (!isAdmin) {
    return (
      <div className="tl-notice m-4 p-6 sm:m-8" data-tone="warn">
        <p className="font-semibold">Administrators only</p>
        <p className="mt-1">
          This page manages settings shared by everybody on this installation, so it is limited to
          administrator accounts. Ask an administrator here if you need something changed.{' '}
          <ContactAdminLink />
        </p>
      </div>
    );
  }

  return <>{children}</>;
}

/**
 * The same idea again, for a section an account's SUBSCRIPTION does not include.
 *
 * Separate from `AdminOnly` because the remedy is different and the sentence has
 * to say so: "ask an administrator" is right for a settings page and useless for
 * a subscription limit, where what is needed is a different subscription on
 * your own account.
 *
 * It lets administrators through, as the backend's `requireSubscription` does
 * (owner decision B1: an administrator is exempt from the tiers, as from
 * credits and the profile cap). A gate that disagreed with the backend either
 * shows somebody a page whose every request then fails, or hides one that
 * would have worked - `hasSubscription` is the shared rule.
 */
export function RequiresSubscription({
  minimum,
  label,
  children,
}: {
  minimum: AccountSubscriptionId;
  /** How the subscription reads to a person, e.g. "Premium". */
  label: string;
  children: ReactNode;
}) {
  const { account, loading } = useAuth();

  if (loading) return <p className="text-sm text-subtle">Loading...</p>;

  if (!hasSubscription(account, minimum)) {
    return (
      <div className="tl-notice m-4 p-6 sm:m-8" data-tone="warn">
        <p className="font-semibold">Needs a {label} subscription</p>
        <p className="mt-1">
          This part of the app is included from {label} upwards, and your account&apos;s
          subscription is <strong>{account?.subscriptionLabel ?? 'one that does not include it'}</strong>.
          Subscriptions are set by an administrator of this installation, so ask them to move your
          account. <ContactAdminLink />
        </p>
      </div>
    );
  }

  return <>{children}</>;
}

/**
 * The same idea for Report Jobs: a reporter's page, which an administrator may
 * open too. An ordinary user who types the address is told what it is for
 * rather than shown a page whose requests their account is refused.
 */
export function ReporterOnly({ children }: { children: ReactNode }) {
  const { role, loading } = useAuth();

  if (loading) return <p className="text-sm text-subtle">Loading...</p>;

  if (!canOpenReportJobs(role)) {
    return (
      <div className="tl-notice m-4 p-6 sm:m-8" data-tone="warn">
        <p className="font-semibold">Reporters only</p>
        <p className="mt-1">
          Report Jobs is where reporter accounts add job postings to the installation&apos;s job lake.
          Your account builds resumes instead. Ask an administrator here if you should have a
          reporter account. <ContactAdminLink />
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
