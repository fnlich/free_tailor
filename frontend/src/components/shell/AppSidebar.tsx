'use client';

import Link from 'next/link';
import { useEffect, useRef, type RefObject } from 'react';

import { ICONS, IconLock } from '@/components/icons';
import { lockLabel, useLockedFeature } from '@/components/subscription/LockedFeature';
import { describeLock, type LockSpec } from '@/lib/subscriptions';
import {
  activeHref,
  canSee,
  isNavLocked,
  isSettingsRoute,
  SIDEBAR_ASSISTANT,
  SIDEBAR_BOTTOM,
  SIDEBAR_MAIN,
  type NavItem,
} from './navModel';

type Props = {
  pathname: string;
  /** The account's role: a reporter's rail is Report Jobs, Credits and Settings. */
  role: unknown;
  /** The account's subscription, for the entries it draws locked (navModel's `isNavLocked`). */
  subscription: unknown;
  /** Below the md breakpoint, where the rail is an off-canvas drawer. */
  isCompact: boolean;
  drawerOpen: boolean;
  onNavigate: () => void;
  /**
   * For a row that opens a dialog over the page instead of navigating (a
   * locked entry): closes the drawer with focus on its button first. The
   * dialog gives focus back to whatever held it when it opened, and the row
   * pressed sits in a drawer that is inert by the time it closes - focus fell
   * to <body>, and a keyboard started again from the top of the page.
   */
  onOpenDialog: () => void;
  panelRef: RefObject<HTMLElement | null>;
};

function Row({
  item,
  active,
  onNavigate,
  onOpenDialog,
  lock,
  onLocked,
  autoFocus,
}: {
  item: NavItem;
  active: boolean;
  onNavigate: () => void;
  onOpenDialog: () => void;
  /** Set while the account's subscription does not include the entry. */
  lock: LockSpec | null;
  onLocked: (lock: LockSpec) => void;
  autoFocus?: boolean;
}) {
  const Icon = ICONS[item.icon];
  const content = (
    <>
      <Icon />
      <span className="truncate">{item.label}</span>
    </>
  );

  /**
   * Drawn, never hidden, below the tier it needs: a button that says what it
   * needs and leads to the Subscription page. The drawer closes first, so the
   * dialog is not opened behind it, and hands focus to its own button, which
   * the dialog gives it back to.
   */
  if (lock) {
    const label = lockLabel(lock);
    return (
      <button
        type="button"
        onClick={() => {
          onOpenDialog();
          onLocked(lock);
        }}
        data-active={active}
        data-locked-feature={lock.feature}
        aria-haspopup="dialog"
        aria-label={`${item.label}. ${label}`}
        title={label}
        className="tl-nav-item"
      >
        {content}
        <IconLock className="tl-nav-lock" />
      </button>
    );
  }

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      data-active={active}
      aria-current={active ? 'page' : undefined}
      autoFocus={autoFocus}
      className="tl-nav-item"
    >
      {content}
    </Link>
  );
}

export default function AppSidebar({
  pathname,
  role,
  subscription,
  isCompact,
  drawerOpen,
  onNavigate,
  onOpenDialog,
  panelRef,
}: Props) {
  // The role decides what is offered; the subscription only locks an entry (`isNavLocked`).
  const offered = (item: NavItem) => canSee(item, role);
  const main = SIDEBAR_MAIN.filter(offered);
  const assistant = SIDEBAR_ASSISTANT.filter(offered);
  const bottom = SIDEBAR_BOTTOM.filter(offered);
  const locked = useLockedFeature();
  const lockOf = (item: NavItem): LockSpec | null =>
    isNavLocked(item, role, subscription) ? describeLock(item.feature ?? 'many-profiles', { subscription }) : null;

  // Resolved across every entry at once, by longest match, so a route under
  // another entry's path lights only the row that is really its own.
  const active = activeHref(pathname, [...main, ...assistant, ...bottom]);
  const settingsActive = isSettingsRoute(pathname);

  const firstLink = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isCompact || !drawerOpen) return;
    firstLink.current?.querySelector<HTMLElement>('a')?.focus();
  }, [isCompact, drawerOpen]);

  // Settings stays lit on every one of its tabs, including the
  // administrator's, which live under /admin/ rather than under /settings.
  const isActive = (item: NavItem) =>
    item.href === '/settings' ? settingsActive : !settingsActive && active === item.href;

  return (
    <aside
      id="app-sidebar"
      ref={panelRef}
      aria-label="Main"
      /*
       * Off-screen links stay out of the tab order. `inert` is a real React 19
       * prop, so this needs no visibility juggling - the drawer can keep its
       * transform and still not be reachable by keyboard while closed.
       */
      inert={isCompact && !drawerOpen}
      className="tl-sidebar"
    >
      <div ref={firstLink} className="flex flex-col">
        {main.map((item) => (
          <Row
            key={item.href}
            item={item}
            active={isActive(item)}
            onNavigate={onNavigate}
            onOpenDialog={onOpenDialog}
            lock={lockOf(item)}
            onLocked={locked.open}
          />
        ))}
      </div>

      {assistant.length > 0 && (
        <>
          <div className="tl-sidebar-divider" />
          <div className="tl-sidebar-label" id="nav-assistant">
            Assistant
          </div>
          <div className="flex flex-col" role="group" aria-labelledby="nav-assistant">
            {assistant.map((item) => (
              <Row
                key={item.href}
                item={item}
                active={isActive(item)}
                onNavigate={onNavigate}
                onOpenDialog={onOpenDialog}
                lock={lockOf(item)}
                onLocked={locked.open}
              />
            ))}
          </div>
        </>
      )}

      {bottom.length > 0 && (
        <div className="tl-sidebar-bottom flex flex-col">
          {bottom.map((item) => (
            <Row
              key={item.href}
              item={item}
              active={isActive(item)}
              onNavigate={onNavigate}
              onOpenDialog={onOpenDialog}
              lock={lockOf(item)}
              onLocked={locked.open}
            />
          ))}
        </div>
      )}
      {locked.dialog}
    </aside>
  );
}
