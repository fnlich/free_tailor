'use client';

import Link from 'next/link';
import { useEffect, useRef, type RefObject } from 'react';

import { ICONS, IconExternal } from '@/components/icons';
import {
  activeHref,
  canSee,
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
  /** The account's subscription, for entries a tier includes. */
  subscription: unknown;
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
        <IconExternal className="tl-nav-out" />
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
  role,
  subscription,
  sheetUrl,
  isCompact,
  drawerOpen,
  onNavigate,
  panelRef,
}: Props) {
  // A link that would open about:blank is worse than no link at all, so the
  // sheet entry stays out until there is a URL for it.
  const offered = (item: NavItem) => canSee(item, role, subscription) && (!item.external || Boolean(sheetUrl));
  const main = SIDEBAR_MAIN.filter(offered);
  const assistant = SIDEBAR_ASSISTANT.filter(offered);
  const bottom = SIDEBAR_BOTTOM.filter(offered);

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
            key={item.href || item.label}
            item={item}
            active={isActive(item)}
            sheetUrl={sheetUrl}
            onNavigate={onNavigate}
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
                sheetUrl={sheetUrl}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </>
      )}

      {bottom.length > 0 && (
        <div className="tl-sidebar-bottom flex flex-col">
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
