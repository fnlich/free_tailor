'use client';

import Image from 'next/image';
import Link from 'next/link';
import type { RefObject } from 'react';

import AccountMenu from '@/components/auth/AccountMenu';
import { IconCredits, IconMenu, IconMoon, IconSun, IconTemplates } from '@/components/icons';
import { useTheme } from '@/lib/useTheme';
import NotificationsMenu from './NotificationsMenu';

type Props = {
  credits: number;
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
function CreditsPill({ credits }: { credits: number }) {
  return (
    <Link href="/credits" className="tl-credits" title="Credits - press to buy more">
      <IconCredits className="h-[18px] w-[18px] text-amber-500" />
      <span>{credits}</span>
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

export default function AppTopBar({ credits, drawerOpen, onToggleDrawer, triggerRef }: Props) {
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

        <Link href="/" className="flex min-w-0 items-center gap-2" aria-label="Tailor home">
          <Image
            src="/tailor-icon.svg"
            alt=""
            width={26}
            height={26}
            className="rounded-md"
            priority
            data-darkreader-ignore
            suppressHydrationWarning
          />
          <span className="truncate">Tailor</span>
        </Link>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1 px-3 sm:gap-2 sm:px-4">
        <CreditsPill credits={credits} />

        {/*
          Templates is a destination rather than a control, but it belongs up
          here with them: it is shared by the whole installation, so it is not
          any one person's work the way the sidebar entries are. Everybody can
          look; only an administrator can change one.
        */}
        <Link href="/admin/templates" className="tl-icon-button" title="Templates">
          <IconTemplates className="h-5 w-5" />
        </Link>

        <NotificationsMenu />
        <ThemeToggleButton />
        <AccountMenu />
      </div>
    </header>
  );
}
