'use client';

import { usePathname } from 'next/navigation';

import { isProfilesDeskRoute } from '@/lib/profileDashboard';

/**
 * The Profiles pages - the dashboard (/admin/profiles), one profile's page
 * (/admin/profiles/<id>), the template chooser and new resume
 * (/admin/resumes/new) and the editor (/admin/resumes/<id>) - draw their own
 * full-width canvas: the warm desk their cards and pages sit on, edge to
 * edge under the top bar, the way the FlowCV pages they follow do. Those
 * routes (`isProfilesDeskRoute`) get a bare <main> and lay themselves out;
 * every other admin page keeps the centred column.
 */

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? '';
  if (isProfilesDeskRoute(pathname)) {
    return <main className="tl-fill">{children}</main>;
  }
  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {children}
    </main>
  );
}
