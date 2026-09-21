'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import AccountMenu from '@/components/auth/AccountMenu';
import { useAuth } from '@/contexts/AuthContext';
import { planAtLeast, type AccountPlanId } from '@/lib/plans';
import { sheetApi } from '@/lib/sheet';

type Props = {
  onLogout?: () => void;
};

type NavItem = {
  href: string;
  label: string;
  /** Who may see it. Absent means everybody who is signed in. */
  needs?: 'admin' | AccountPlanId;
};

/**
 * The whole navigation, with what each entry requires.
 *
 * Declared together rather than assembled in the markup so there is ONE list to
 * read when asking "who can see what" - and because the bar and the mobile menu
 * both render it, so a rule applied in one place would otherwise have to be
 * remembered in the other.
 *
 * Hiding is not the protection. Every one of these pages carries its own gate
 * and every route behind them carries a middleware; this only stops the app
 * offering somebody a door that will not open.
 */
const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Builder' },
  // Beside the builder because it is the other half of it: a sheet import
  // returns an order number rather than files, and this is where the files are.
  { href: '/orders', label: 'Orders' },
  { href: '/calendar', label: 'Calendar' },
  // Was "LinkedIn Jobs" while LinkedIn was one of its scrapers. It is not any
  // more, and a label naming a source the page cannot run would be a lie.
  { href: '/jobs', label: 'Jobs' },
  { href: '/jobs/filter', label: 'Job Filter' },
  { href: '/bid-assistant', label: 'Bid Assistant' },
  { href: '/test', label: 'Test', needs: 'admin' },
  { href: '/admin/profiles', label: 'Profiles' },
  // Templates are shared by the whole installation, so only an administrator
  // may manage them. Everybody still picks one when building.
  { href: '/admin/templates', label: 'Templates', needs: 'admin' },
  { href: '/admin/groups', label: 'Groups', needs: 'premium' },
];

/** Every settings page is administrator-only, so the whole control is. */
const SETTINGS_ITEMS = [
  { href: '/admin/settings', label: 'General' },
  { href: '/admin/google-sheets', label: 'Google Sheets' },
  { href: '/admin/prompts', label: 'Prompts' },
  { href: '/admin/models', label: 'Models' },
  { href: '/admin/skills', label: 'Skill Library' },
  { href: '/admin/accounts', label: 'Accounts' },
  { href: '/admin/payments', label: 'Payments' },
];

function canSee(item: NavItem, isAdmin: boolean, plan: unknown): boolean {
  if (!item.needs) return true;
  if (item.needs === 'admin') return isAdmin;
  return planAtLeast(plan, item.needs);
}

function isActivePath(pathname: string, href: string): boolean {
  if (href === '/') {
    return pathname === '/';
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function AppTopNav({ onLogout }: Props) {
  const pathname = usePathname();
  const { isAdmin, account } = useAuth();
  const navItems = NAV_ITEMS.filter((item) => canSee(item, isAdmin, account?.plan));
  // The whole control, not just the Accounts entry inside it: every page behind
  // it is administrator-only, so offering the menu to anybody else is offering
  // five doors that all say "administrators only".
  const settingsItems = isAdmin ? SETTINGS_ITEMS : [];

  /**
   * The account's own job sheet, for the "Find the job" link.
   *
   * Fetched once here because the link lives in the bar on every page. It is
   * left out entirely until there is a URL to open - while it loads, when the
   * server has no Google key, and when allocation has not finished - since a
   * link that opens about:blank is worse than no link at all.
   */
  const [sheetUrl, setSheetUrl] = useState('');
  useEffect(() => {
    void (async () => {
      try {
        const sheet = await sheetApi.get();
        setSheetUrl(sheet.configured ? (sheet.todayTabUrl ?? sheet.spreadsheetUrl ?? '') : '');
      } catch {
        setSheetUrl('');
      }
    })();
  }, []);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const mobileMenuRef = useRef<HTMLDivElement | null>(null);
  const mobileMenuPanelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!settingsRef.current?.contains(event.target as Node)) {
        setIsSettingsOpen(false);
      }
      if (!mobileMenuRef.current?.contains(target) && !mobileMenuPanelRef.current?.contains(target)) {
        setIsMobileMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  /**
   * Not a `Link`: it leaves the app entirely, for Google's own page.
   *
   * `target="_blank"` on purpose - somebody looking up a job is in the middle
   * of building a resume, and taking the tab away from them would lose it.
   */
  const findTheJob = (onNavigate?: () => void, className?: string) =>
    sheetUrl ? (
      <a
        href={sheetUrl}
        target="_blank"
        rel="noreferrer"
        onClick={onNavigate}
        className={className}
        title="Opens today's tab of your job sheet in a new tab"
      >
        Find the job
      </a>
    ) : null;

  const isSettingsActive = settingsItems.some((item) => isActivePath(pathname, item.href));
  const mobileMenuPanel =
    isMobileMenuOpen && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={mobileMenuPanelRef}
            className="fixed left-4 right-4 top-[4.5rem] max-h-[calc(100vh-5.5rem)] overflow-y-auto rounded-xl border border-gray-200 bg-white py-2 shadow-xl dark:border-slate-800 dark:bg-slate-950"
            style={{ zIndex: 2147483000 }}
          >
            {findTheJob(
              () => setIsMobileMenuOpen(false),
              'block px-4 py-3 text-sm font-semibold text-emerald-700 hover:bg-gray-50 dark:text-emerald-300 dark:hover:bg-slate-900'
            )}
            {navItems.map((item) => {
              const isActive = isActivePath(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setIsMobileMenuOpen(false)}
                  className={`block px-4 py-3 text-sm transition ${
                    isActive
                      ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200'
                      : 'text-gray-700 hover:bg-gray-50 dark:text-slate-200 dark:hover:bg-slate-900'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}

            <div className="mt-2 border-t border-gray-200 pt-2 dark:border-slate-800">
              {settingsItems.map((item) => {
                const isActive = isActivePath(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setIsMobileMenuOpen(false)}
                    className={`block px-4 py-3 text-sm transition ${
                      isActive
                        ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200'
                        : 'text-gray-700 hover:bg-gray-50 dark:text-slate-200 dark:hover:bg-slate-900'
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <header className="app-top-nav sticky top-0 z-[var(--layer-app-nav)] border-b border-gray-200 bg-white/95 shadow-sm backdrop-blur dark:border-slate-800 dark:bg-slate-950/85">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-6">
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2 py-4 text-sm font-bold text-gray-900 dark:text-white"
            aria-label="FreeBuilder home"
          >
            <Image
              src="/freebuilder-icon.svg"
              alt=""
              width={32}
              height={32}
              className="rounded-lg shadow-sm"
              priority
              data-darkreader-ignore
              suppressHydrationWarning
            />
            <span className="hidden sm:inline">FreeBuilder</span>
          </Link>
          <nav className="hidden flex-wrap items-center gap-2 md:flex">
            {findTheJob(
              undefined,
              'rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700'
            )}
            {navItems.map((item) => {
              const isActive = isActivePath(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-md px-3 py-2 text-sm font-medium transition ${
                    isActive
                      ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200'
                      : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}

            {settingsItems.length > 0 && (
            <div className="relative" ref={settingsRef}>
              <button
                type="button"
                onClick={() => setIsSettingsOpen((current) => !current)}
                className={`rounded-md px-3 py-2 text-sm font-medium transition ${
                  isSettingsActive || isSettingsOpen
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white'
                }`}
              >
                Settings
              </button>

              {isSettingsOpen && (
                <div className="app-top-nav-menu absolute left-0 top-full z-[var(--layer-app-nav-menu)] mt-2 w-56 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-950">
                  {settingsItems.map((item) => {
                    const isActive = isActivePath(pathname, item.href);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => setIsSettingsOpen(false)}
                        className={`block px-4 py-3 text-sm transition ${
                          isActive
                            ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200'
                            : 'text-gray-700 hover:bg-gray-50 dark:text-slate-200 dark:hover:bg-slate-900'
                        }`}
                      >
                        {item.label}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
            )}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <div className="relative md:hidden" ref={mobileMenuRef}>
            <button
              type="button"
              onClick={() => setIsMobileMenuOpen((current) => !current)}
              className={`rounded-md px-3 py-2 text-sm font-medium transition ${
                isMobileMenuOpen
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white'
              }`}
              aria-expanded={isMobileMenuOpen}
              aria-haspopup="menu"
            >
              Menu
            </button>

          </div>

          {/*
            The account menu replaces the old Admin link. That link went to a
            page anybody could open, which is no longer true - and "Admin" as a
            destination made less sense than the account it belongs to, which
            is also where logging out lives.
          */}
          {onLogout && (
            <button
              type="button"
              onClick={onLogout}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
            >
              Logout
            </button>
          )}
          <AccountMenu />
          </div>
        </div>
      </header>
      {mobileMenuPanel}
    </>
  );
}
