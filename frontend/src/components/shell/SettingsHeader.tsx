'use client';

import Link from 'next/link';

import {
  activeHref,
  isAdminSettingsRoute,
  SETTINGS_ACCOUNT_TABS,
  SETTINGS_ADMIN_TABS,
  type SettingsTab,
} from './navModel';
import { useTabRow } from './useTabRow';

type Props = {
  pathname: string;
  isAdmin: boolean;
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
export default function SettingsHeader({ pathname, isAdmin }: Props) {
  const onAdmin = isAdmin && isAdminSettingsRoute(pathname);
  const accountRow = useTabRow<HTMLElement>(pathname);
  const adminRow = useTabRow<HTMLElement>(`${pathname}:${onAdmin}`);

  // Longest match, so /settings/subscription lights Subscription and not
  // Profile, whose /settings is a prefix of it.
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

  /*
   * One width on every settings route. It used to be narrower over an account
   * tab than over an administration one, and because both are centred the
   * title and the whole row jumped sideways on a wide window at the moment
   * Administration was pressed. The account pages narrow inside this box
   * instead (SettingsPage), from the right, so their left edge stays put.
   */
  return (
    <div className="mx-auto max-w-7xl px-4 pt-8 sm:px-6 lg:px-8">
      <h1 className="text-3xl font-bold tracking-tight text-ink">Settings</h1>
      <nav ref={accountRow} className="tl-tabs mt-6" aria-label="Settings">
        {SETTINGS_ACCOUNT_TABS.map((item) => tab(item, accountActive === item.href))}
        {isAdmin && tab({ href: ADMINISTRATION_HREF, label: 'Administration' }, onAdmin)}
      </nav>
      {onAdmin && (
        <nav ref={adminRow} className="tl-subtabs" aria-label="Administration">
          {SETTINGS_ADMIN_TABS.map((item) => tab(item, adminActive === item.href, 'tl-subtab'))}
        </nav>
      )}
    </div>
  );
}
