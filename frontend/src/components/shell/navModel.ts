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

/** The primary destinations. */
export const SIDEBAR_MAIN: NavItem[] = [
  // "Profile" here is the resume profile - the career data a resume is built
  // from. The account you are signed in as lives in the top bar instead.
  { href: '/admin/profiles', label: 'Profile', icon: 'profile' },
  { href: '/admin/groups', label: 'Groups', icon: 'groups', needs: 'premium' },
  { href: '/', label: 'Build Resumes', icon: 'build' },
  { href: '/orders', label: 'Orders', icon: 'orders' },
];

/** Everything to do with finding work, below a divider. */
export const SIDEBAR_TOOLS: NavItem[] = [
  { href: '/jobs', label: 'Job Search', icon: 'search' },
  { href: '/jobs/filter', label: 'Job Filter', icon: 'filter' },
  { href: '/bid-assistant', label: 'Bid Assistant', icon: 'bid' },
  { href: '/calendar', label: 'Calendar', icon: 'calendar' },
];

/**
 * Pinned to the bottom of the rail.
 *
 * "Find Jobs" has no href of its own - it opens the account's own spreadsheet,
 * whose URL is fetched once by the shell. It is the app's first non-admin-only
 * entry: an administrator manages the installation rather than working a job
 * sheet, and the sheet an admin would open is their own, which is not what the
 * entry is for.
 */
export const SIDEBAR_BOTTOM: NavItem[] = [
  {
    href: '',
    label: 'Find Jobs',
    icon: 'external',
    needs: 'non-admin',
    external: true,
    title: "Opens today's tab of your job sheet in a new tab",
  },
  { href: '/admin/settings', label: 'Settings', icon: 'settings', needs: 'admin' },
  { href: '/admin/accounts', label: 'Manage Accounts', icon: 'accounts', needs: 'admin' },
];

/**
 * The Settings hub.
 *
 * Every page here is administrator-only and each carries its own `AdminOnly`
 * gate, which is why the sub-nav is shown only to administrators - offering
 * anybody else a row of seven doors that all say "administrators only" is worse
 * than offering none.
 *
 * Note `/test` is in this list but is not under `/admin/`, which is why the
 * sub-nav is rendered by the shell rather than by the admin layout.
 */
export const SETTINGS_ITEMS = [
  { href: '/admin/settings', label: 'General' },
  { href: '/admin/google-sheets', label: 'Google Sheets' },
  { href: '/admin/prompts', label: 'Prompts' },
  { href: '/admin/models', label: 'Models' },
  { href: '/admin/skills', label: 'Skill Library' },
  { href: '/admin/notifications', label: 'Notifications' },
  { href: '/admin/payments', label: 'Payments' },
  { href: '/test', label: 'Prompt Test' },
] as const;

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

export function isSettingsRoute(pathname: string): boolean {
  return SETTINGS_HREFS.some((href) => matches(pathname, href));
}
