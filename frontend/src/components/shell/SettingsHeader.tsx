'use client';

import Link from 'next/link';

import { activeHref, SETTINGS_ACCOUNT_TABS, SETTINGS_ADMIN_TABS, SETTINGS_ITEMS } from './navModel';

type Props = {
  pathname: string;
  isAdmin: boolean;
  /**
   * On the installation's own pages, which are laid out at `max-w-7xl` - so the
   * title and tabs line up with the page underneath rather than sitting at a
   * different left edge from it. An account's own tabs are narrower.
   */
  wide: boolean;
};

/**
 * "Settings", and the row of tabs under it, above every settings page.
 *
 * Rendered by the shell rather than by each page so it is one component on
 * thirteen routes, and because the administrator's tabs are not all under one
 * directory a layout could own - `/test` is one of them.
 *
 * The account's tabs come first and are everybody's. An administrator gets the
 * installation's after them, behind a divider with its own heading, so the
 * row never mixes "my account" and "this server" without saying which is which.
 */
export default function SettingsHeader({ pathname, isAdmin, wide }: Props) {
  // Longest match across every tab, so /settings/plan lights Plan and not
  // Profile, whose /settings is a prefix of it.
  const active = activeHref(pathname, SETTINGS_ITEMS);

  const tab = (item: { href: string; label: string }) => (
    <Link
      key={item.href}
      href={item.href}
      data-active={active === item.href}
      aria-current={active === item.href ? 'page' : undefined}
      className="tl-tab"
    >
      {item.label}
    </Link>
  );

  return (
    <div className={`mx-auto px-4 pt-8 sm:px-6 lg:px-8 ${wide ? 'max-w-7xl' : 'max-w-5xl'}`}>
      <h1 className="text-3xl font-bold tracking-tight text-ink">Settings</h1>
      <nav className="tl-tabs mt-6" aria-label="Settings">
        {SETTINGS_ACCOUNT_TABS.map(tab)}
        {isAdmin && (
          <>
            <span className="tl-tabs-group" aria-hidden>
              Administration
            </span>
            {SETTINGS_ADMIN_TABS.map(tab)}
          </>
        )}
      </nav>
    </div>
  );
}
