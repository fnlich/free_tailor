'use client';

import Image from 'next/image';
import Link from 'next/link';
import type { RefObject } from 'react';

import AccountMenu from '@/components/auth/AccountMenu';
import { IconCredits, IconMenu, IconMoon, IconSun } from '@/components/icons';
import { formatMoney } from '@/lib/format';
import { homeFor } from '@/lib/roles';
import { useTheme } from '@/lib/useTheme';
import NotificationsMenu from './NotificationsMenu';

type Props = {
  /** The balance, in thousandths of a dollar. */
  balanceMilli: number;
  /** The account's role: a reporter's logo leads to Report Jobs, and their balance is earnings. */
  role: unknown;
  /** The account's own job sheet, as the shell read it - a reporter's menu links it. */
  sheetUrl: string;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
};

/**
 * The credit balance, where it can be seen.
 *
 * It used to live two clicks deep inside the account menu, which is the wrong
 * place for the one number that decides whether the next thing you press will
 * work. It reads from the auth context rather than fetching, so the refresh
 * that Resume Profiles already triggers after a create keeps this current too.
 */
function CreditsPill({ balanceMilli, reporter }: { balanceMilli: number; reporter: boolean }) {
  const balance = formatMoney(balanceMilli);
  return (
    <Link
      href="/credits"
      className="tl-credits"
      // A reporter cannot buy credit: their balance is what they have earned
      // and not yet been paid, and the page it opens says so.
      title={reporter ? 'Credits - what you have earned and not yet been paid' : 'Credits - press to buy more'}
    >
      <span className="tl-coin" aria-hidden>
        <IconCredits className="h-5 w-5" />
      </span>
      {/* Three decimals, like every amount: a $0.023 charge moves the last digit. */}
      <span>{balance}</span>
    </Link>
  );
}

function ThemeToggleButton() {
  const { theme, mounted, toggle } = useTheme();
  const dark = mounted && theme === 'dark';

  return (
    <button
      type="button"
      onClick={toggle}
      className="tl-icon-button"
      // Until hydration settles, the server's guess could be either, so the
      // control describes itself neutrally rather than claiming a state.
      aria-label={mounted ? (dark ? 'Switch to light mode' : 'Switch to dark mode') : 'Switch theme'}
      aria-pressed={dark}
      title={mounted ? (dark ? 'Light mode' : 'Dark mode') : 'Switch theme'}
    >
      {dark ? <IconSun className="h-5 w-5" /> : <IconMoon className="h-5 w-5" />}
    </button>
  );
}

export default function AppTopBar({ balanceMilli, role, sheetUrl, drawerOpen, onToggleDrawer, triggerRef }: Props) {
  return (
    <header className="tl-topbar">
      <div className="tl-brand">
        <button
          type="button"
          ref={triggerRef}
          onClick={onToggleDrawer}
          aria-expanded={drawerOpen}
          aria-controls="app-sidebar"
          aria-label={drawerOpen ? 'Close navigation' : 'Open navigation'}
          className="tl-icon-button tl-drawer-trigger -ml-1.5"
        >
          <IconMenu className="h-5 w-5" />
        </button>

        {/* A reporter's home is Report Jobs: `/` is the builder, which is not theirs. */}
        <Link href={homeFor(role)} className="flex min-w-0 items-center gap-2.5" aria-label="Tailor home">
          <Image
            src="/tailor-icon.svg"
            alt=""
            width={34}
            height={34}
            className="rounded-lg"
            priority
            data-darkreader-ignore
            suppressHydrationWarning
          />
          <span className="tl-wordmark truncate">Tailor</span>
        </Link>
      </div>

      {/*
        Controls only - what you have, what is new, how it looks, who you are.
        Templates, which used to end this row, is a destination, and now sits
        at the foot of the rail beside Settings.
      */}
      <div className="ml-auto flex shrink-0 items-center gap-1 px-3 sm:gap-3 sm:px-5">
        <CreditsPill balanceMilli={balanceMilli} reporter={role === 'reporter'} />
        <NotificationsMenu />
        <ThemeToggleButton />
        <AccountMenu sheetUrl={sheetUrl} />
      </div>
    </header>
  );
}
