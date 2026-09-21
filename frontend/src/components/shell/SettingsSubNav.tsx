'use client';

import Link from 'next/link';

import { activeHref, SETTINGS_ITEMS } from './navModel';

/**
 * The second row, for the eight pages behind the single Settings entry.
 *
 * Its container mirrors the admin layout's `max-w-7xl px-4 sm:px-6 lg:px-8` so
 * the pills line up with the page heading underneath them rather than sitting
 * at a different left edge.
 *
 * Sticky under the bar, at the page-toolbar layer - below every piece of app
 * chrome, above page content, which is exactly what that tier was defined for
 * and never used by anything until now.
 */
export default function SettingsSubNav({ pathname }: { pathname: string }) {
  const active = activeHref(pathname, SETTINGS_ITEMS);

  return (
    <div className="tl-subnav sticky top-[var(--tl-topbar-h)] z-[var(--layer-page-toolbar)]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <nav className="tl-subnav-row" aria-label="Settings">
          {SETTINGS_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              data-active={active === item.href}
              aria-current={active === item.href ? 'page' : undefined}
              className="tl-subnav-item"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
