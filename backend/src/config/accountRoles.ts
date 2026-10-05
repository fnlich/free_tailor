import type { UserRole } from '../types/account';

/**
 * The three roles an account can hold, and the one question most of the app
 * asks of them: may this account build resumes?
 *
 * A leaf, like accountSubscriptions.ts: the auth middleware, the account
 * repository and the accounts route all read it, and none of them may import
 * another for it.
 *
 * WHY "MAY BUILD" IS THE QUESTION. A `reporter` (owner decisions A3, A4) adds
 * job postings to the shared job lake and is paid per job accepted; they see
 * Report Jobs, Credits, their own job sheet, Settings > Profile / Job Sheet,
 * notifications and Contact admin - and nothing else. Everything else in the
 * app - profiles, templates, the builder, orders, groups, prompts, scrapers,
 * the Bid Assistant, buying credits - is for an account that builds resumes,
 * so `requireUser` means exactly that (middleware/auth.ts), and a router added
 * later is closed to reporters without anybody remembering to close it.
 */

/** In the order the admin page's select lists them. */
export const ACCOUNT_ROLES = ['user', 'reporter', 'admin'] as const satisfies readonly UserRole[];

// Fails to compile when UserRole gains a member this list does not name.
type MissingRole = Exclude<UserRole, (typeof ACCOUNT_ROLES)[number]>;
const everyRoleListed: MissingRole extends never ? true : false = true;
void everyRoleListed;

export const ROLE_LABELS: Readonly<Record<UserRole, string>> = {
  user: 'User',
  reporter: 'Reporter',
  admin: 'Administrator',
};

export function isAccountRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (ACCOUNT_ROLES as readonly string[]).includes(value);
}

/**
 * Whether an account with this role may use the resume builder and everything
 * around it. A user or an administrator; never a reporter.
 *
 * Written as a list of who MAY, not of who may not, so a fourth role added
 * later is refused everywhere until somebody decides otherwise.
 */
export function canBuildResumes(role: UserRole | undefined | null): boolean {
  return role === 'user' || role === 'admin';
}

/** The role catalog as the admin Accounts page reads it: `{ id, label }`, in order. */
export function listRoles(): Array<{ id: UserRole; label: string }> {
  return ACCOUNT_ROLES.map((id) => ({ id, label: ROLE_LABELS[id] }));
}
