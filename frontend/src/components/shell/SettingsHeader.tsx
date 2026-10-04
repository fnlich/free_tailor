'use client';

import Link from 'next/link';

import {
  activeHref,
  isAdminSettingsRoute,
  SETTINGS_ACCOUNT_TABS,
  SETTINGS_ADMIN_TABS,
  type SettingsTab,
} from './navModel';

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

/** Where the Administration tab goes: the first of the installation's pages. */
const ADMINISTRATION_HREF = SETTINGS_ADMIN_TABS[0].href;

/**
 * "Settings", and the tabs under it, above every settings page.
 *
 * Rendered by the shell rather than by each page so it is one component on
 * thirteen routes, and because the administrator's pages are not all under one
 * directory a layout could own - `/test` is one of them.
 *
 * Two levels, not one long row. The account's four tabs are everybody's; an
 * administrator gets a fifth, Administration, and only on its pages a second,
 * smaller row of the installation's nine. One row of thirteen ran off the end
 * of a 1440px window with nothing to say there was more - four of the nine
 * were simply not there to be seen.
 */
export default function SettingsHeader({ pathname, isAdmin, wide }: Props) {
  const onAdmin = isAdmin && isAdminSettingsRoute(pathname);

  // Longest match, so /settings/plan lights Plan and not Profile, whose
  // /settings is a prefix of it.
  const accountActive = onAdmin ? null : activeHref(pathname, SETTINGS_ACCOUNT_TABS);
  const adminActive = onAdmin ? activeHref(pathname, SETTINGS_ADMIN_TABS) : null;

  const tab = (item: SettingsTab, active: boolean, className = 'tl-tab') => (
    <Link
      key={item.href}
      href={item.href}
      data-active={active}
      aria-current={active ? 'page' : undefined}
      className={className}
    >
      {item.label}
    </Link>
  );

  return (
    <div className={`mx-auto px-4 pt-8 sm:px-6 lg:px-8 ${wide ? 'max-w-7xl' : 'max-w-5xl'}`}>
      <h1 className="text-3xl font-bold tracking-tight text-ink">Settings</h1>
      <nav className="tl-tabs mt-6" aria-label="Settings">
        {SETTINGS_ACCOUNT_TABS.map((item) => tab(item, accountActive === item.href))}
        {isAdmin && tab({ href: ADMINISTRATION_HREF, label: 'Administration' }, onAdmin)}
      </nav>
      {onAdmin && (
        <nav className="tl-subtabs" aria-label="Administration">
          {SETTINGS_ADMIN_TABS.map((item) => tab(item, adminActive === item.href, 'tl-subtab'))}
        </nav>
      )}
    </div>
  );
}
