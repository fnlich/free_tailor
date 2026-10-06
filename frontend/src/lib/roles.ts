/**
 * The three roles an account can hold, and where each may go in the app.
 *
 * A copy of the backend's catalog (backend/src/config/accountRoles.ts) rather
 * than a fetch, for the reason lib/subscriptions.ts is one: the shell decides
 * what to draw - and where to send a reporter - before any request. The
 * backend's guards are the real lock (`requireUser` refuses a reporter with
 * 403 `role-not-allowed` on every builder route); this exists so the app does
 * not open a page whose every request is then refused. Imports nothing at
 * runtime, so backend/test/frontendRoles.test.js loads it and runs it against
 * the backend's own.
 *
 * - `user` builds resumes from their own profiles - every new sign-in;
 * - `reporter` adds job postings to the shared job lake and is paid per job
 *   accepted (owner decisions A3, A4): Report Jobs, Credits, their own job
 *   sheet, Settings -> Profile / Job Sheet, notifications and Contact admin,
 *   and nothing else;
 * - `admin` manages everything the installation shares.
 */

/** In the order the admin Accounts page lists them, as the backend's ACCOUNT_ROLES. */
export const ACCOUNT_ROLES = ['user', 'reporter', 'admin'] as const;

export type UserRole = (typeof ACCOUNT_ROLES)[number];

/** The backend's ROLE_LABELS - what a role reads as, on Settings and Admin -> Accounts. */
export const ROLE_LABELS: Readonly<Record<UserRole, string>> = {
  user: 'User',
  reporter: 'Reporter',
  admin: 'Administrator',
};

export function isAccountRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (ACCOUNT_ROLES as readonly string[]).includes(value);
}

/**
 * A role as a person reads it. An unknown one - a server newer than this page -
 * is shown as what it says rather than as a role it is not.
 */
export function roleLabel(role: unknown): string {
  return isAccountRole(role) ? ROLE_LABELS[role] : String(role ?? '');
}

/**
 * The roles that build resumes: everybody but a reporter. Named for what they
 * MAY do, as the backend's `canBuildResumes` is, so a fourth role added later
 * is offered nothing of the builder until somebody decides otherwise.
 */
export const BUILDER_ROLES: readonly UserRole[] = ['user', 'admin'];

export function canBuildResumes(role: unknown): boolean {
  return role === 'user' || role === 'admin';
}

/* ------------------------------------------------------- where a reporter goes */

/**
 * A reporter's home: Report Jobs. Where AuthGate sends them from any page that
 * is not theirs, and where the logo leads them.
 */
export const REPORTER_HOME = '/report';

/**
 * The pages a reporter may open - an ALLOWLIST, never a list of what to keep
 * them out of: /admin/* holds ordinary users' pages too (/admin/profiles is
 * everybody's resume profiles), so "everything under /admin is for
 * administrators" would be wrong both ways, and a page added later is a
 * reporter's only once somebody adds it here.
 *
 * `exact` pages are the page itself and nothing under it: /credits/invoice and
 * /credits/return are a purchase's, which a reporter cannot make, and
 * /settings/subscription is a builder's tier. Report Jobs is a section of its
 * own, so a page under it (the job lake's later releases) comes with it.
 */
const REPORTER_PAGES: ReadonlyArray<{ path: string; exact: boolean }> = [
  { path: REPORTER_HOME, exact: false },
  { path: '/credits', exact: true },
  { path: '/settings', exact: true },
  { path: '/settings/job-sheet', exact: true },
];

/** `/credits/` and `/credits` are one page; the root stays `/`. */
function normalisePath(pathname: string): string {
  const path = (pathname || '/').split(/[?#]/)[0] || '/';
  return path.length > 1 ? path.replace(/\/+$/, '') || '/' : path;
}

export function reporterMayOpen(pathname: string): boolean {
  const path = normalisePath(pathname);
  return REPORTER_PAGES.some((page) => path === page.path || (!page.exact && path.startsWith(`${page.path}/`)));
}

/**
 * Where AuthGate sends this account instead of drawing `pathname`, or null to
 * draw it. Only a reporter is ever sent anywhere: a user or an administrator
 * opens every page, and the page explains itself if it is not for them
 * (AdminOnly, RequiresSubscription, ReporterOnly).
 */
export function redirectFor(role: unknown, pathname: string): string | null {
  if (role !== 'reporter') return null;
  return reporterMayOpen(pathname) ? null : REPORTER_HOME;
}

/** Where "home" is - the logo in the top bar, the /admin landing path. */
export function homeFor(role: unknown): string {
  return role === 'reporter' ? REPORTER_HOME : '/';
}

/** Report Jobs is a reporter's page, and an administrator may open it (the plan's /report row). */
export function canOpenReportJobs(role: unknown): boolean {
  return role === 'reporter' || role === 'admin';
}

/**
 * The link to a reporter's own job sheet, for their account menu: the shell's
 * read of /sheet when it has arrived (it opens the All tab), else the
 * spreadsheet the session already names - but only as an https address, so a
 * value that is not one is no link rather than a link somewhere else.
 */
export function sheetLinkFor(fetched: string | undefined, stored: string | undefined): string {
  for (const candidate of [fetched, stored]) {
    if (typeof candidate === 'string' && /^https:\/\/[^\s/]+\//i.test(candidate.trim())) return candidate.trim();
  }
  return '';
}

/* ------------------------------------------------ the configured administrator */

/** The setting that makes an address an administrator at every sign-in. */
export type ConfiguredAdminSource = 'ADMIN_EMAILS' | 'SMTP_USER';

/**
 * What Admin -> Accounts says on a row the server makes an administrator again
 * at every sign-in - the short line under its role select and the longer
 * tooltip - naming the setting that does it: the row's
 * `configuredAdminSource`. An install that signs in by email and sets no
 * ADMIN_EMAILS gets its operator from SMTP_USER, and a row that always said
 * ADMIN_EMAILS sent them to edit a setting that was empty. ADMIN_EMAILS for
 * anything else - a backend from before the field - which is what it meant then.
 */
export function configuredAdminNotes(source: unknown): { line: string; title: string } {
  const setting: ConfiguredAdminSource = source === 'SMTP_USER' ? 'SMTP_USER' : 'ADMIN_EMAILS';
  return {
    line: `${setting}: an administrator again at sign-in`,
    title:
      `Named by ${setting}: the server makes this account an administrator again at its next sign-in ` +
      'and at every restart, whatever role is set here.',
  };
}
