import type { IconName } from '@/components/icons';
import { BUILDER_ROLES, REPORTER_HOME, type UserRole } from '@/lib/roles';
import { subscriptionAtLeast, type AccountSubscriptionId, type LockedFeatureId } from '@/lib/subscriptions';

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
 *
 * A ROLE hides an entry; a SUBSCRIPTION never does. An entry a builder's tier
 * does not include is drawn LOCKED (`isNavLocked`): the lock icon, and a
 * press that says what it needs and leads to the Subscription page - so the
 * account learns what a higher subscription adds, instead of never seeing it.
 */

/** The lowest account subscription that includes the entry. */
export type NavNeeds = AccountSubscriptionId;

/**
 * The roles that see an entry, when they are not the builders.
 *
 * Absent means users and administrators - the resume builder's roles - and
 * NOT a reporter: an entry added later is kept from reporters until somebody
 * names them here, the same safe default as the backend's `requireUser` and
 * the reporter allowlist in lib/roles.ts. backend/test/frontendRoles.test.js
 * fails when a reporter is offered an entry that allowlist would send them
 * away from.
 */
type Roles = readonly UserRole[];

const EVERYBODY: Roles = ['user', 'reporter', 'admin'];

export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  /** Who sees it, by role. Absent means the builders: users and administrators. */
  roles?: Roles;
  /**
   * The subscription it needs, on top of the role: below it the entry is drawn
   * locked, never hidden. Absent means every subscription.
   */
  needs?: NavNeeds;
  /** What a locked entry's dialog says it is (lib/subscriptions.ts `describeLock`). Set with `needs`. */
  feature?: LockedFeatureId;
  /**
   * Other paths that light this entry: Profiles stays lit in the resume
   * editor and the template chooser, which live under /admin/resumes.
   */
  alsoActiveOn?: readonly string[];
};

/**
 * The primary destinations, in the order the rail shows them - every one a
 * page of the app.
 *
 * Find Jobs (/jobs) searches the Job Data Lake, exports the jobs picked into
 * the account's own sheet and orders resumes for them; "Go to my sheet" on
 * that page opens the sheet itself. It sits after Profiles because
 * it is the next thing in the day's loop: the stored profiles first, then the jobs those
 * resumes are for, then the resumes built for those jobs.
 */
export const SIDEBAR_MAIN: NavItem[] = [
  /*
   * A reporter's home (owner decision A3), and first for them because it is
   * the whole of their work. Reporters only: an administrator may open the
   * page, but it is not theirs to do every day.
   */
  { href: REPORTER_HOME, label: 'Report Jobs', icon: 'report', roles: ['reporter'] },
  // The people the account builds resumes for, and each person's resumes - the
  // career data a built resume starts from. Open to every builder on every
  // subscription (a tier only caps how many profiles are kept). The resume
  // editor and the template chooser live under /admin/resumes and light it
  // too. The account you are signed in as lives under Settings instead.
  { href: '/admin/profiles', label: 'Profiles', icon: 'resume', alsoActiveOn: ['/admin/resumes'] },
  { href: '/jobs', label: 'Find Jobs', icon: 'search' },
  { href: '/', label: 'Build Resumes', icon: 'build' },
  { href: '/orders', label: 'Orders', icon: 'orders' },
  // A reporter's too: their earnings and the payouts recorded against them.
  { href: '/credits', label: 'Credits', icon: 'credits', roles: EVERYBODY },
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
 * Templates is shared by the whole installation - every user and administrator
 * can look (a reporter is refused /api/templates, so it names no roles), only
 * an administrator can change one - and Settings is everybody's: an account's own
 * tabs for everyone, the installation's on top of them for an administrator.
 */
export const SIDEBAR_BOTTOM: NavItem[] = [
  { href: '/admin/templates', label: 'Templates', icon: 'templates' },
  { href: '/settings', label: 'Settings', icon: 'settings', roles: EVERYBODY },
];

/** A Settings tab. `roles` as on a rail entry: absent means users and administrators. */
export type SettingsTab = { href: string; label: string; roles?: Roles };

/**
 * Settings for the account you are signed in as. A reporter gets the first
 * two - their name, and the job sheet their reports come from; cards and a
 * subscription are a builder's.
 */
export const SETTINGS_ACCOUNT_TABS: SettingsTab[] = [
  { href: '/settings', label: 'Account', roles: EVERYBODY },
  { href: '/settings/job-sheet', label: 'Job Sheet', roles: EVERYBODY },
  { href: '/settings/payment-methods', label: 'Payment Methods' },
  { href: '/settings/subscription', label: 'Subscription' },
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
  // The Job Data Lake: what reporters and merged builds added, its rate per
  // job and duplicate window, and the admin sheet it is copied to.
  { href: '/admin/job-lake', label: 'Job Lake' },
  { href: '/test', label: 'Prompt Test' },
];

/** Every Settings tab, for deciding whether a route is part of the hub. */
export const SETTINGS_ITEMS: SettingsTab[] = [...SETTINGS_ACCOUNT_TABS, ...SETTINGS_ADMIN_TABS];

/**
 * Whether an account with this role is offered the entry at all - by the
 * role alone, by name, so an unknown role (a server newer than this page) is
 * offered nothing a builder is. The subscription never hides an entry: it
 * locks it (`isNavLocked`).
 */
export function canSee(item: { roles?: Roles }, role: unknown): boolean {
  const roles = item.roles ?? BUILDER_ROLES;
  return roles.some((allowed) => allowed === role);
}

/**
 * Whether an entry this role is offered is drawn LOCKED for this
 * subscription: it needs a tier the account is below. An administrator is
 * exempt, as from the backend's `requireSubscription` (owner decision B1).
 */
export function isNavLocked(item: { roles?: Roles; needs?: NavNeeds }, role: unknown, subscription: unknown): boolean {
  if (!item.needs || !canSee(item, role)) return false;
  return role !== 'admin' && !subscriptionAtLeast(subscription, item.needs);
}

/** The account tabs of Settings this role is offered, in order. */
export function settingsTabsFor(role: unknown): SettingsTab[] {
  return SETTINGS_ACCOUNT_TABS.filter((tab) => canSee(tab, role));
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
export function activeHref(
  pathname: string,
  items: readonly { href: string; alsoActiveOn?: readonly string[] }[]
): string | null {
  let best: string | null = null;
  let bestLength = -1;
  for (const { href, alsoActiveOn } of items) {
    // An entry answers for its own path and for the ones it also lights on; the
    // longest path that matches decides, and the answer is always the entry's href.
    for (const path of [href, ...(alsoActiveOn ?? [])]) {
      if (!matches(pathname, path)) continue;
      if (best === null || path.length > bestLength) {
        best = href;
        bestLength = path.length;
      }
    }
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
