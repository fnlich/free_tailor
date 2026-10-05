'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { useAuth } from '@/contexts/AuthContext';
import { REPORTER_HOME } from '@/lib/roles';

/**
 * /admin is a landing path, not a page.
 *
 * It used to send everybody to /admin/settings. That was right when the admin
 * pages were open to anybody; since v2 those pages are administrator-only, so an
 * ordinary user following an old link, a bookmark, or the address bar landed on
 * the "administrators only" notice - technically correct and useless.
 *
 * Now it sends each role somewhere they can actually do something. Waiting for
 * `loading` matters: redirecting before the account has arrived would send every
 * admin to the profiles page, because `isAdmin` is false while it is unknown.
 * A reporter never gets this far - /admin is not on their allowlist, so
 * AuthGate sends them to Report Jobs first - but if they did, that is where
 * they would go: the profiles are a builder's.
 */
export default function AdminPage() {
  const router = useRouter();
  const { isAdmin, isReporter, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    router.replace(isAdmin ? '/admin/settings' : isReporter ? REPORTER_HOME : '/admin/profiles');
  }, [router, isAdmin, isReporter, loading]);

  return (
    <div className="tl-fill flex items-center justify-center">
      <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-blue-600"></div>
    </div>
  );
}
