'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { useAuth } from '@/contexts/AuthContext';
import { describeProfileUsage } from '@/lib/auth';

/**
 * The account button in the top bar, and what drops out of it.
 *
 * Everything here is read from the account the provider already holds, so
 * opening the menu costs no request - which matters because it is opened far
 * more often than anything in it is used.
 */

const ITEM =
  'block w-full px-4 py-3 text-left text-sm text-gray-700 transition hover:bg-gray-50 ' +
  'dark:text-slate-200 dark:hover:bg-slate-900';

function initials(name: string, email: string): string {
  const source = name.trim() || email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const letters = parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[1][0];
  return letters.toUpperCase();
}

export default function AccountMenu() {
  const { account, isAdmin, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  // Escape closes it, which is the one keyboard behaviour a dropdown must have
  // for somebody who opened it by accident and is not using a mouse.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!account) return null;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-full py-1 pl-1 pr-3 text-sm font-medium text-gray-700 transition hover:bg-gray-100 dark:text-slate-200 dark:hover:bg-slate-800"
      >
        {account.picture ? (
          // A plain <img>, not next/image: the src is a Google avatar URL on a
          // host the Next image loader is not configured for, and an
          // unconfigured host is a hard render error rather than a broken
          // picture.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={account.picture}
            alt=""
            width={32}
            height={32}
            className="h-8 w-8 rounded-full"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">
            {initials(account.name, account.email)}
          </span>
        )}
        <span className="hidden max-w-[10rem] truncate sm:inline">{account.name || account.email}</span>
      </button>

      {open && (
        <div className="app-top-nav-menu absolute right-0 top-full z-[var(--layer-app-nav-menu)] mt-2 w-72 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-950">
          <div className="border-b border-gray-200 px-4 py-3 dark:border-slate-800">
            <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">
              {account.name || account.email}
            </p>
            <p className="truncate text-xs text-gray-500 dark:text-slate-400">{account.email}</p>

            <div className="mt-3 flex items-center justify-between text-xs">
              <span className="rounded-full bg-blue-50 px-2 py-1 font-medium text-blue-700 dark:bg-blue-500/15 dark:text-blue-200">
                {account.planLabel}
              </span>
              {isAdmin && (
                <span className="rounded-full bg-purple-50 px-2 py-1 font-medium text-purple-700 dark:bg-purple-500/15 dark:text-purple-200">
                  Admin
                </span>
              )}
            </div>

            <dl className="mt-3 space-y-1 text-xs text-gray-600 dark:text-slate-300">
              <div className="flex justify-between">
                <dt>Credits</dt>
                <dd className="font-medium text-gray-900 dark:text-white">{account.credits}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Profiles</dt>
                <dd className="font-medium text-gray-900 dark:text-white">
                  {describeProfileUsage(account)}
                </dd>
              </div>
            </dl>
          </div>

          <Link href="/account" onClick={() => setOpen(false)} className={ITEM}>
            Account info
          </Link>
          <Link href="/account#subscription" onClick={() => setOpen(false)} className={ITEM}>
            Subscription
          </Link>
          {isAdmin && (
            <Link href="/admin/accounts" onClick={() => setOpen(false)} className={ITEM}>
              Manage accounts
            </Link>
          )}

          <div className="border-t border-gray-200 dark:border-slate-800">
            <button
              type="button"
              disabled={signingOut}
              onClick={async () => {
                setSigningOut(true);
                try {
                  await signOut();
                } finally {
                  // The menu is unmounted by the sign-out anyway; resetting
                  // matters only when the request failed and it is still here.
                  setSigningOut(false);
                  setOpen(false);
                }
              }}
              className={`${ITEM} text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-900/30`}
            >
              {signingOut ? 'Signing out...' : 'Log out'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
