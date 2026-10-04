import type { IconName } from '@/components/icons';
import { planAtLeast, type AccountPlanId } from '@/lib/plans';

/**
 * The whole navigation, and what each entry requires.
 *
 * Declared here rather than assembled in markup so there is ONE list to read
 * when asking "who can see what" - and because the rail and the mobile drawer
 * render the same arrays, so a rule applied in one would otherwise have to be
 * remembered in the other.
 *
 * Hiding is not the protection. Every page carries its own gate and every route
 * behind it carries middleware; this only stops the app offering somebody a
 * door that will not open.
 */

export type NavNeeds = 'admin' | 'non-admin' | AccountPlanId;

export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  /** Who may see it. Absent means everybody who is signed in. */
  needs?: NavNeeds;
  /** Leaves the app; rendered as an anchor with target=_blank. */
  external?: boolean;
  title?: string;
};

/**
 * The primary destinations, in the order the rail shows them.
 *
 * "Find Jobs" has no href of its own - it opens the account's own job sheet,
 * whose URL is fetched once by the shell, in a new tab. It sits second because
 * it is the second thing in the day's loop: profiles first, then the jobs
 * those profiles are for, then the resumes built for them.
 */
export const SIDEBAR_MAIN: NavItem[] = [
  // "Profiles" here is the resume profiles - the career data a resume is built
  // from. The account you are signed in as lives under Settings instead.
  { href: '/admin/profiles', label: 'Profiles', icon: 'profile' },
  {
    href: '',
    label: 'Find Jobs',
    icon: 'search',
    external: true,
    title: "Opens today's tab of your job sheet in a new tab",
  },
  { href: '/', label: 'Build Resumes', icon: 'build' },
  { href: '/orders', label: 'Orders', icon: 'orders' },
  { href: '/credits', label: 'Credits', icon: 'credits' },
];

/** Below the divider, under the "Assistant" heading: the tools that help work a job. */
export const SIDEBAR_ASSISTANT: NavItem[] = [
  { href: '/jobs/filter', label: 'Job Filter', icon: 'filter' },
  { href: '/bid-assistant', label: 'Bid Assistant', icon: 'bid' },
  { href: '/calendar', label: 'Calendar', icon: 'calendar' },
];

/**
 * Pinned to the bottom of the rail.
 *
 * Templates is shared by the whole installation - everybody can look, only an
 * administrator can change one - and Settings is everybody's: an account's own
 * tabs for everyone, the installation's on top of them for an administrator.
 */
export const SIDEBAR_BOTTOM: NavItem[] = [
  { href: '/admin/templates', label: 'Templates', icon: 'templates' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
];

export type SettingsTab = { href: string; label: string };

/** Settings for the account you are signed in as. Everybody gets these. */
export const SETTINGS_ACCOUNT_TABS: SettingsTab[] = [
  { href: '/settings', label: 'Profile' },
  { href: '/settings/job-sheet', label: 'Job Sheet' },
  { href: '/settings/payment-methods', label: 'Payment Methods' },
  { href: '/settings/plan', label: 'Plan' },
];

/**
 * The installation's settings, after the account's, for administrators only.
 *
 * Every page here carries its own `AdminOnly` gate, which is why the tabs are
 * shown only to administrators - offering anybody else a row of doors that all
 * say "administrators only" is worse than offering none.
 *
 * Note `/test` is in this list but is not under `/admin/`, which is why the
 * tabs are rendered by the shell rather than by the admin layout.
 */
export const SETTINGS_ADMIN_TABS: SettingsTab[] = [
  { href: '/admin/settings', label: 'General' },
  { href: '/admin/accounts', label: 'Accounts' },
  { href: '/admin/google-sheets', label: 'Google Sheets' },
  { href: '/admin/prompts', label: 'Prompts' },
  { href: '/admin/models', label: 'Models' },
  { href: '/admin/skills', label: 'Skill Library' },
  { href: '/admin/notifications', label: 'Notifications' },
  { href: '/admin/payments', label: 'Payments' },
  { href: '/test', label: 'Prompt Test' },
];

/** Every Settings tab, for deciding whether a route is part of the hub. */
export const SETTINGS_ITEMS: SettingsTab[] = [...SETTINGS_ACCOUNT_TABS, ...SETTINGS_ADMIN_TABS];

export function canSee(item: NavItem, isAdmin: boolean, plan: unknown): boolean {
  if (!item.needs) return true;
  if (item.needs === 'admin') return isAdmin;
  if (item.needs === 'non-admin') return !isAdmin;
  return planAtLeast(plan, item.needs);
}

function matches(pathname: string, href: string): boolean {
  if (!href) return false;
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The one entry to light up, by longest match.
 *
 * A per-item `isActive` predicate cannot get this right: `/jobs` is a prefix of
 * `/jobs/filter`, so on the filter page both entries matched and both
 * highlighted. That was invisible in a horizontal bar of text links and is
 * glaring in a vertical rail, where two rows sit lit on top of each other.
 * Resolving across the whole set and keeping the longest match fixes it once
 * rather than per call site.
 */
export function activeHref(pathname: string, items: readonly { href: string }[]): string | null {
  let best: string | null = null;
  for (const { href } of items) {
    if (!matches(pathname, href)) continue;
    if (best === null || href.length > best.length) best = href;
  }
  return best;
}

const SETTINGS_HREFS = SETTINGS_ITEMS.map((item) => item.href);
const ADMIN_SETTINGS_HREFS = SETTINGS_ADMIN_TABS.map((item) => item.href);

export function isSettingsRoute(pathname: string): boolean {
  return SETTINGS_HREFS.some((href) => matches(pathname, href));
}

/** One of the installation's pages, which are wider than an account's own. */
export function isAdminSettingsRoute(pathname: string): boolean {
  return ADMIN_SETTINGS_HREFS.some((href) => matches(pathname, href));
}

/**
 * Pages drawn without the shell at all.
 *
 * An invoice is a document, opened in a tab of its own and printed: a rail and
 * a top bar around it would be printed too, or need hiding from print one
 * piece at a time.
 */
const BARE_ROUTES = ['/credits/invoice'];

export function isBareRoute(pathname: string): boolean {
  return BARE_ROUTES.some((href) => matches(pathname, href));
}
