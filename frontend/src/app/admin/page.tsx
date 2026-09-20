'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { useAuth } from '@/contexts/AuthContext';

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
 */
export default function AdminPage() {
  const router = useRouter();
  const { isAdmin, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    router.replace(isAdmin ? '/admin/settings' : '/admin/profiles');
  }, [router, isAdmin, loading]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-slate-950">
      <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-blue-600"></div>
    </div>
  );
}
