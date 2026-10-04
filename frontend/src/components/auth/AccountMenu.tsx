'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { IconUser } from '@/components/icons';
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
        /*
         * Its own name, because otherwise it often has none.
         *
         * The name beside the avatar is `hidden sm:inline` and an avatar image
         * is `alt=""`, so below 640px this button announces nothing at all to
         * a screen reader - it is the only control in the bar without a name.
         * The label is also what makes it visible to the shell walkthrough's
         * order check, which reads controls by title or aria-label; without
         * one, the account was simply missing from the row it checks.
         */
        aria-label={`Account: ${account.name || account.email}`}
        title={`Account: ${account.name || account.email}`}
        className="tl-icon-button"
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
            className="h-9 w-9 rounded-full"
            referrerPolicy="no-referrer"
          />
        ) : (
          /*
           * An outlined figure rather than initials on a coloured disc - the
           * reference's account button, which keeps the bar's right end a row
           * of same-weight line icons. The name is one press away, at the top
           * of the menu, and in this button's accessible name and tooltip.
           */
          <span className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-current">
            <IconUser className="h-5 w-5" />
          </span>
        )}
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

            {/*
              A div rather than a dl, because these rows are links now and an
              anchor is not a valid child of a dl. The number is worth a
              destination: it dips while a run is in flight, and somebody
              noticing that needs somewhere to find out why.
            */}
            <div className="mt-3 space-y-1 text-xs text-gray-600 dark:text-slate-300">
              <Link
                href="/credits"
                onClick={() => setOpen(false)}
                className="-mx-1 flex justify-between rounded px-1 py-0.5 hover:bg-gray-50 dark:hover:bg-slate-900"
              >
                <span>Credits</span>
                <span className="font-medium text-gray-900 dark:text-white">{account.credits}</span>
              </Link>
              <Link
                href="/settings/plan"
                onClick={() => setOpen(false)}
                className="-mx-1 flex justify-between rounded px-1 py-0.5 hover:bg-gray-50 dark:hover:bg-slate-900"
              >
                <span>Profiles</span>
                <span className="font-medium text-gray-900 dark:text-white">
                  {describeProfileUsage(account)}
                </span>
              </Link>
            </div>
          </div>

          <Link href="/settings" onClick={() => setOpen(false)} className={ITEM}>
            Settings
          </Link>
          <Link href="/settings/plan" onClick={() => setOpen(false)} className={ITEM}>
            Plan
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
