'use client';

import Link from 'next/link';
import { useEffect, useRef, type RefObject } from 'react';

import { ICONS } from '@/components/icons';
import {
  activeHref,
  canSee,
  isSettingsRoute,
  SIDEBAR_BOTTOM,
  SIDEBAR_MAIN,
  SIDEBAR_TOOLS,
  type NavItem,
} from './navModel';

type Props = {
  pathname: string;
  isAdmin: boolean;
  plan: unknown;
  /** The account's own job sheet. Empty until it loads, or when there is none. */
  sheetUrl: string;
  /** Below the md breakpoint, where the rail is an off-canvas drawer. */
  isCompact: boolean;
  drawerOpen: boolean;
  onNavigate: () => void;
  panelRef: RefObject<HTMLElement | null>;
};

function Row({
  item,
  active,
  sheetUrl,
  onNavigate,
  autoFocus,
}: {
  item: NavItem;
  active: boolean;
  sheetUrl: string;
  onNavigate: () => void;
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
   * Not a `Link`: it leaves the app entirely, for Google's own page.
   * `target="_blank"` on purpose - somebody looking up a job is in the middle
   * of building a resume, and taking the tab away from them would lose it.
   */
  if (item.external) {
    return (
      <a
        href={sheetUrl}
        target="_blank"
        rel="noreferrer"
        onClick={onNavigate}
        title={item.title}
        className="tl-nav-item"
      >
        {content}
      </a>
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
  isAdmin,
  plan,
  sheetUrl,
  isCompact,
  drawerOpen,
  onNavigate,
  panelRef,
}: Props) {
  const main = SIDEBAR_MAIN.filter((item) => canSee(item, isAdmin, plan));
  const tools = SIDEBAR_TOOLS.filter((item) => canSee(item, isAdmin, plan));
  const bottom = SIDEBAR_BOTTOM.filter(
    // A link that would open about:blank is worse than no link at all, so the
    // sheet entry stays out until there is a URL for it.
    (item) => canSee(item, isAdmin, plan) && (!item.external || sheetUrl)
  );

  // Resolved across every entry at once, so /jobs/filter lights "Job Filter"
  // alone rather than lighting "Job Search" as well.
  const active = activeHref(pathname, [...main, ...tools, ...bottom]);
  const settingsActive = isSettingsRoute(pathname);

  const firstLink = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isCompact || !drawerOpen) return;
    firstLink.current?.querySelector<HTMLElement>('a')?.focus();
  }, [isCompact, drawerOpen]);

  const isActive = (item: NavItem) =>
    item.href === '/admin/settings' ? settingsActive : active === item.href;

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
      <div ref={firstLink} className="flex flex-col gap-0.5">
        {main.map((item) => (
          <Row
            key={item.href}
            item={item}
            active={isActive(item)}
            sheetUrl={sheetUrl}
            onNavigate={onNavigate}
          />
        ))}
      </div>

      {tools.length > 0 && <div className="tl-sidebar-divider" />}

      <div className="flex flex-col gap-0.5">
        {tools.map((item) => (
          <Row
            key={item.href}
            item={item}
            active={isActive(item)}
            sheetUrl={sheetUrl}
            onNavigate={onNavigate}
          />
        ))}
      </div>

      {bottom.length > 0 && (
        <div className="tl-sidebar-bottom flex flex-col gap-0.5">
          {bottom.map((item) => (
            <Row
              key={item.href || item.label}
              item={item}
              active={isActive(item)}
              sheetUrl={sheetUrl}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </aside>
  );
}
