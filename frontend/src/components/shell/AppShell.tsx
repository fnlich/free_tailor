'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { useAuth } from '@/contexts/AuthContext';
import { sheetApi } from '@/lib/sheet';
import { useIsCompact } from '@/lib/useMediaQuery';
import { useDismissable } from '@/lib/useDismissable';
import AppSidebar from './AppSidebar';
import AppTopBar from './AppTopBar';
import SettingsSubNav from './SettingsSubNav';
import { isSettingsRoute } from './navModel';

/**
 * The chrome every signed-in page sits inside.
 *
 * Mounted once, in the root layout, inside `AuthGate` - so it is never
 * constructed without an account, and `useAuth().account` is non-null for
 * everything below it. Every page used to render the navigation itself, in its
 * own full-height wrapper, thirteen times over; this replaces all of that.
 *
 * It contributes exactly two offsets to the content and nothing else: no
 * max-width and no horizontal padding, so each page keeps deciding how wide it
 * is. Seven different widths are in use, plus two full-bleed pages, and a shell
 * that picked one would have to be told about every future page that disagreed.
 */
export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { account, isAdmin } = useAuth();
  const isCompact = useIsCompact();

  const [drawerRequested, setDrawerRequested] = useState(false);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  /*
   * Derived rather than stored.
   *
   * There is no drawer above the breakpoint, so a resize past it must not be
   * able to leave the scroll lock on and the links inert - and deriving that
   * is one expression, where an effect watching the breakpoint would be a
   * second source of truth that can disagree for a frame.
   */
  const drawerOpen = drawerRequested && isCompact;

  /*
   * Close on navigation, adjusted during render rather than in an effect.
   *
   * The sidebar rows call onNavigate, which covers a click - but not the back
   * button, and not a redirect. This is React's own pattern for reacting to a
   * changed prop: it re-renders immediately with the new state rather than
   * painting the drawer open over the page it just left.
   */
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setDrawerRequested(false);
  }

  /**
   * The account's own job sheet, for the Find Jobs entry.
   *
   * Fetched here rather than in the sidebar because the shell survives every
   * client-side navigation - one request per page load instead of one per
   * route. Skipped entirely for administrators, who do not see that entry.
   */
  const [fetchedSheetUrl, setFetchedSheetUrl] = useState('');
  useEffect(() => {
    if (isAdmin) return;

    let alive = true;
    void (async () => {
      try {
        const sheet = await sheetApi.get();
        if (!alive) return;
        setFetchedSheetUrl(
          sheet.configured ? (sheet.todayTabUrl ?? sheet.spreadsheetUrl ?? '') : ''
        );
      } catch {
        // No link is the right answer here - one that opens about:blank is
        // worse than none - and that is already the starting state.
      }
    })();
    return () => {
      alive = false;
    };
  }, [isAdmin]);

  // Derived, so an account that turns out to be an administrator never shows a
  // link fetched a moment earlier.
  const sheetUrl = isAdmin ? '' : fetchedSheetUrl;

  const closeDrawer = useCallback(() => setDrawerRequested(false), []);

  useDismissable(drawerOpen, closeDrawer, sidebarRef, triggerRef);

  /**
   * Hold the page still behind the drawer.
   *
   * The previous value is saved and restored rather than cleared: the modals in
   * this app also write to it, and clearing would release a lock somebody else
   * had taken.
   */
  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

  // Send focus back where it came from, so closing does not drop the caret at
  // the top of the document.
  const toggleDrawer = useCallback(() => {
    setDrawerRequested((open) => {
      if (open) triggerRef.current?.focus();
      return !open;
    });
  }, []);

  const showSettingsNav = isAdmin && isSettingsRoute(pathname);

  return (
    <div className="tl-shell" data-drawer={drawerOpen ? 'open' : 'closed'}>
      <AppTopBar
        credits={account?.credits ?? 0}
        drawerOpen={drawerOpen}
        onToggleDrawer={toggleDrawer}
        triggerRef={triggerRef}
      />

      <AppSidebar
        pathname={pathname}
        isAdmin={isAdmin}
        plan={account?.plan}
        sheetUrl={sheetUrl}
        isCompact={isCompact}
        drawerOpen={drawerOpen}
        onNavigate={closeDrawer}
        panelRef={sidebarRef}
      />

      {drawerOpen && <div className="tl-scrim" onClick={closeDrawer} aria-hidden />}

      <div className="tl-main">
        {showSettingsNav && <SettingsSubNav pathname={pathname} />}
        {children}
      </div>
    </div>
  );
}
