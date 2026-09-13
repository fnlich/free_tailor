'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { useAuth } from '@/contexts/AuthContext';
import SignInPanel from './SignInPanel';

/**
 * Shows the app to whoever is signed in, and the sign-in form to everybody else.
 *
 * A wrapper rather than a redirect. There is no separate /login route to be
 * bounced to and back from, so a deep link survives signing in: the URL never
 * changes, and the page behind it renders as soon as the account arrives.
 */

/** Pages that render for a signed-out visitor. */
const PUBLIC_PATHS = new Set<string>([]);

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-gray-900">
      {children}
    </div>
  );
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const { loading, signedIn, error } = useAuth();
  const pathname = usePathname();

  if (PUBLIC_PATHS.has(pathname)) return <>{children}</>;

  // Distinct from signed out, and rendering the login form here would flash it
  // at somebody who is already signed in on every single page load.
  if (loading) {
    return (
      <Centered>
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading...</p>
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
        <div className="w-full max-w-md rounded-xl border border-red-200 bg-white p-6 text-sm shadow-sm dark:border-red-800 dark:bg-gray-800">
          <p className="font-semibold text-red-700 dark:text-red-300">Cannot reach the server</p>
          <p className="mt-2 text-gray-700 dark:text-gray-200">{error}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            Try again
          </button>
        </div>
      </Centered>
    );
  }

  if (!signedIn) return <SignInPanel />;

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

  if (loading) return <p className="text-sm text-gray-500">Loading...</p>;

  if (!isAdmin) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-100">
        <p className="font-semibold">Administrators only</p>
        <p className="mt-1">
          This page manages settings shared by everybody on this installation, so it is limited to
          administrator accounts. Ask an administrator here if you need something changed.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
