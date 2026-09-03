'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

type Props = {
  onLogout?: () => void;
};

const NAV_ITEMS = [
  { href: '/', label: 'Builder' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/jobs', label: 'LinkedIn Jobs' },
  { href: '/jobs/filter', label: 'Job Filter' },
  { href: '/bid-assistant', label: 'Bid Assistant' },
  { href: '/test', label: 'Test' },
  { href: '/admin/profiles', label: 'Profiles' },
  { href: '/admin/templates', label: 'Templates' },
  { href: '/admin/groups', label: 'Groups' },
];

const SETTINGS_ITEMS = [
  { href: '/admin/settings', label: 'General' },
  { href: '/admin/google-sheets', label: 'Google Sheets' },
  { href: '/admin/prompts', label: 'Prompts' },
  { href: '/admin/models', label: 'Models' },
  { href: '/admin/skills', label: 'Skill Library' },
];

function isActivePath(pathname: string, href: string): boolean {
  if (href === '/') {
    return pathname === '/';
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function AppTopNav({ onLogout }: Props) {
  const pathname = usePathname();
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

  const isSettingsActive = SETTINGS_ITEMS.some((item) => isActivePath(pathname, item.href));
  const mobileMenuPanel =
    isMobileMenuOpen && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={mobileMenuPanelRef}
            className="fixed left-4 right-4 top-[4.5rem] max-h-[calc(100vh-5.5rem)] overflow-y-auto rounded-xl border border-gray-200 bg-white py-2 shadow-xl dark:border-slate-800 dark:bg-slate-950"
            style={{ zIndex: 2147483000 }}
          >
            {NAV_ITEMS.map((item) => {
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
              {SETTINGS_ITEMS.map((item) => {
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
            {NAV_ITEMS.map((item) => {
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
                  {SETTINGS_ITEMS.map((item) => {
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

          {onLogout ? (
            <button
              type="button"
              onClick={onLogout}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
            >
              Logout
            </button>
          ) : (
            <Link
              href="/admin"
              className="rounded-md px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
            >
              Admin
            </Link>
          )}
          </div>
        </div>
      </header>
      {mobileMenuPanel}
    </>
  );
}
