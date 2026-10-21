'use client';

import { usePathname } from 'next/navigation';

/**
 * The Profiles pages - the list (/admin/profiles), the template chooser and
 * new profile (/admin/profiles/new) and the editor (/admin/profiles/<id>) -
 * draw their own full-width canvas: the warm desk their cards and pages sit
 * on, edge to edge under the top bar, the way the FlowCV pages they follow
 * do. Those routes get a bare <main> and lay themselves out; every other
 * admin page keeps the centred column.
 */
const FULL_WIDTH = /^\/admin\/profiles(\/[^/]+)?\/?$/;

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? '';
  if (FULL_WIDTH.test(pathname)) {
    return <main className="tl-fill">{children}</main>;
  }
  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {children}
    </main>
  );
}
