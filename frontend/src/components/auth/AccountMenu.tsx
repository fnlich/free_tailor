'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { IconUser } from '@/components/icons';
import { useAuth } from '@/contexts/AuthContext';
import { describeProfileUsage } from '@/lib/auth';
import { formatMoney } from '@/lib/format';
import { Pill } from '@/components/ui/kit';
import styles from './AccountMenu.module.css';

/**
 * The account button in the top bar, and what drops out of it.
 *
 * Everything here is read from the account the provider already holds, so
 * opening the menu costs no request - which matters because it is opened far
 * more often than anything in it is used.
 */

/** A row of the menu: full width, lit by the theme's muted surface on hover. */
const ITEM = 'block w-full px-4 py-2.5 text-left text-sm font-medium text-ink hover:bg-surface-muted';

/** A hairline between the menu's groups - not the bare `border-*` the dark-mode shim recolours. */
const RULE = 'border-[color:var(--line-subtle)]';

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
        <div className="tl-panel app-top-nav-menu absolute right-0 top-full mt-2 w-72 overflow-hidden">
          <div className={`border-b-[1px] ${RULE} px-4 py-4`}>
            <p className="truncate text-sm font-semibold text-ink">
              {account.name || account.email}
            </p>
            <p className="truncate text-xs text-subtle">{account.email}</p>

            <div className="mt-3 flex items-center justify-between">
              {/* "Default" alone reads as a setting left untouched; it is a tier. */}
              <Pill tone="sky">{account.subscriptionLabel} subscription</Pill>
              {isAdmin && <Pill tone="violet">Admin</Pill>}
            </div>

            {/*
              A div rather than a dl, because these rows are links now and an
              anchor is not a valid child of a dl. The number is worth a
              destination: it dips while a run is in flight, and somebody
              noticing that needs somewhere to find out why.
            */}
            <div className="mt-3 space-y-1 text-xs text-muted">
              <Link
                href="/credits"
                onClick={() => setOpen(false)}
                className="-mx-1.5 flex justify-between rounded px-1.5 py-1 hover:bg-surface-muted"
              >
                <span>Credit</span>
                <span className="font-semibold tabular-nums text-ink">{formatMoney(account.balanceMilli)}</span>
              </Link>
              <Link
                href="/settings/subscription"
                onClick={() => setOpen(false)}
                className="-mx-1.5 flex justify-between rounded px-1.5 py-1 hover:bg-surface-muted"
              >
                <span>Profiles</span>
                <span className="font-semibold text-ink">{describeProfileUsage(account)}</span>
              </Link>
            </div>
          </div>

          <div className="py-1">
            <Link href="/settings" onClick={() => setOpen(false)} className={ITEM}>
              Settings
            </Link>
            <Link href="/settings/subscription" onClick={() => setOpen(false)} className={ITEM}>
              Subscription
            </Link>
            {isAdmin && (
              <Link href="/admin/accounts" onClick={() => setOpen(false)} className={ITEM}>
                Manage accounts
              </Link>
            )}
          </div>

          <div className={`border-t-[1px] ${RULE} py-1`}>
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
              className={`${ITEM} ${styles.signOut}`}
            >
              {signingOut ? 'Signing out...' : 'Log out'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
