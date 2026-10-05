import type { NextFunction, Request, Response } from 'express';

import { resolveSession } from '../database/userRepository';
import type { UserAccount } from '../types/account';

import { canBuildResumes } from '../config/accountRoles';
import {
  MULTI_PROFILE_SUBSCRIPTION,
  SUBSCRIPTIONS,
  subscriptionAtLeast,
  type AccountSubscriptionId,
} from '../config/accountSubscriptions';
import { PublicError } from './publicError';

/**
 * Who is making this request.
 *
 * Until v2 this file was a stub: `authMiddleware` called `next()` and
 * `validatePassword` returned true for every input. That was honest for a
 * single-user app on one machine, and is not honest now that accounts own
 * data - so it is a real check, and the pass-through is gone rather than
 * kept behind a flag somebody could leave on.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The signed-in account, when there is one. */
      user?: UserAccount;
      /** The raw session token, so /logout can revoke exactly this session. */
      sessionToken?: string;
    }
  }
}

export const SESSION_COOKIE = 'ft_session';

/**
 * The session token on a request.
 *
 * Two places, and both are needed. The cookie is what the browser sends by
 * itself, which is what makes a reload stay signed in; the Authorization header
 * is what a script or a curl can send, and is also what the frontend uses for
 * the streaming endpoints, where a cookie on a cross-origin fetch depends on
 * credentials mode being right on every call site.
 */
export function readSessionToken(req: Request): string {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) return token;
  }

  // Parsed by hand rather than with cookie-parser: one cookie is wanted, and a
  // dependency plus an app-wide middleware to read it is not worth it.
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return part.slice(index + 1).trim();
    }
  }
  return '';
}

/**
 * Attaches the account when there is a valid session, and never refuses.
 *
 * Mounted app-wide, so any route can read `req.user` - including the ones that
 * behave differently for an admin without being admin-only.
 */
export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const token = readSessionToken(req);
  if (token) {
    try {
      const account = resolveSession(token);
      if (account) {
        req.user = account;
        req.sessionToken = token;
      }
    } catch (error) {
      // A database that cannot be read is not this request's problem to
      // report; it arrives as "not signed in", and the route says so.
      console.error('[auth] Could not resolve a session token.', error);
    }
  }
  next();
}

/**
 * What a reporter is told by every route that is not theirs.
 *
 * One sentence for all of them, about their own account and nothing about how
 * the installation is run, ending in the words the pages turn into a "Contact
 * admin" link: a reporter who thinks they should have the builder can ask for
 * it. The page normally never shows it - the shell sends a reporter to Report
 * Jobs before any other page asks for anything - so this is what an old tab or
 * a hand-made request meets.
 */
export const ROLE_NOT_ALLOWED_MESSAGE =
  'That part of the app is not available for your account. Ask your administrator if you need it.';

/**
 * A signed-in account whose ROLE does not cover this route: 403
 * `role-not-allowed`. Today that is a reporter on anything for building
 * resumes or buying credits (config/accountRoles.ts).
 */
export class RoleNotAllowedError extends PublicError {
  constructor() {
    super(ROLE_NOT_ALLOWED_MESSAGE, { status: 403, code: 'role-not-allowed' });
    this.name = 'RoleNotAllowedError';
  }
}

function refuseRole(res: Response): void {
  const refusal = new RoleNotAllowedError();
  res.status(refusal.status).json({ error: refusal.message, code: refusal.code });
}

/**
 * Signed in with ANY role, or 401.
 *
 * For the few places every account belongs, a reporter included: their own
 * account (/api/auth/account), balance and ledger, notifications, job sheet,
 * their own refund requests, and the reporter routes themselves. Opt-in on
 * purpose - see `requireUser` for why the default is the narrower check.
 */
export function requireAccount(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Sign in to do that.', code: 'not-signed-in' });
    return;
  }
  next();
}

/**
 * Signed in as an account that builds resumes - a user or an administrator -
 * or 401/403.
 *
 * It used to mean "signed in", and every router in the app uses it, which is
 * exactly why it changed meaning instead of a new guard being added beside
 * it: a third role, `reporter`, has no business with the builder, profiles,
 * orders, groups, templates, scrapers or payments, and making THIS the narrow
 * check closes every one of those routers - and every router written later -
 * without anybody visiting it. The few places a reporter belongs ask for
 * `requireAccount` instead. A refusal is 403 `role-not-allowed`, never 401:
 * they are signed in, and "sign in" would send them round a loop.
 */
export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Sign in to do that.', code: 'not-signed-in' });
    return;
  }
  if (!canBuildResumes(req.user.role)) {
    refuseRole(res);
    return;
  }
  next();
}

/**
 * Signed in AND an admin, or 401/403.
 *
 * The two are kept apart because the fixes differ: 401 means sign in, 403 means
 * you are signed in as the wrong person, and a page that showed "sign in" to
 * somebody already signed in would send them round a loop.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Sign in to do that.', code: 'not-signed-in' });
    return;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({
      error: 'That is an administrator-only part of this installation.',
      code: 'not-an-admin',
    });
    return;
  }
  next();
}

/**
 * Whether an account's subscription reaches `minimum` - and an administrator's
 * always does.
 *
 * Administrators are exempt (owner decision B1), as they already are from
 * credits and the profile cap. It used to be the other way: a subscription was
 * read as an entitlement quite separate from the admin ROLE, so an
 * administrator who had not moved themselves off Default was refused Groups,
 * and would have been refused every multi-profile build below. An
 * administrator runs the installation and can change their own subscription in
 * a click, so the refusal protected nothing and cost them a trip to Admin ->
 * Accounts. The entitlement and the role are still two checks; this is the one
 * place they meet.
 */
export function hasSubscription(account: Pick<UserAccount, 'role' | 'subscription'> | null | undefined, minimum: AccountSubscriptionId): boolean {
  if (!account) return false;
  if (account.role === 'admin') return true;
  return subscriptionAtLeast(account.subscription, minimum);
}

/**
 * A request this account's subscription does not cover: 403
 * `subscription-too-low`, naming the subscription it needs, in words the
 * account holder can act on (they can ask for a higher one).
 */
export class SubscriptionTooLowError extends PublicError {
  constructor(minimum: AccountSubscriptionId, message?: string) {
    super(
      message ?? `That part of this installation needs a ${SUBSCRIPTIONS[minimum].label} subscription or higher.`,
      { status: 403, code: 'subscription-too-low', extra: { requiredSubscription: minimum } }
    );
    this.name = 'SubscriptionTooLowError';
  }
}

/**
 * Signed in AND on a subscription at least this high (or an administrator),
 * or 401/403.
 *
 * Satisfied by being an administrator - see `hasSubscription`. A subscription
 * is a tier of the resume builder, so a role that may not build is refused
 * first, by the same 403 `role-not-allowed` as `requireUser`, whatever tier
 * the account happens to hold: a reporter moved off Premium keeps the column.
 */
export function requireSubscription(minimum: AccountSubscriptionId) {
  return function subscriptionGuard(req: Request, res: Response, next: NextFunction): void {
    if (!req.user) {
      res.status(401).json({ error: 'Sign in to do that.', code: 'not-signed-in' });
      return;
    }
    if (!canBuildResumes(req.user.role)) {
      refuseRole(res);
      return;
    }
    if (!hasSubscription(req.user, minimum)) {
      const refusal = new SubscriptionTooLowError(minimum);
      res.status(refusal.status).json({ error: refusal.message, code: refusal.code, ...refusal.extra });
      return;
    }
    next();
  };
}

/**
 * Refuses a run that would build for more than one profile, unless the
 * account's subscription includes that (owner decisions B1-B3).
 *
 * The real lock behind the builder's disabled Multiple / All profiles /
 * Specific group / Select Group: a Default subscription supports ONE profile,
 * so anything that targets more than one is refused - in manual mode and in
 * sheet mode, as Generate Immediately and as an Order alike. Ordering itself
 * is not locked; a single-profile run of either kind is accepted on every
 * subscription.
 *
 * A run is multi-profile when it RESOLVES to more than one profile, or when it
 * names none at all: an omitted `profileIds` means "all profiles", which is
 * one of the locked choices whatever the account happens to hold today. Read
 * after the profiles are resolved and before anything is charged or asked of
 * a model, so a refusal costs nothing.
 */
export function assertProfileScopeAllowed(
  account: Pick<UserAccount, 'role' | 'subscription'> | null | undefined,
  scope: { profileIds: unknown; resolvedCount: number }
): void {
  const multiple = !Array.isArray(scope.profileIds) || scope.resolvedCount > 1;
  if (!multiple || hasSubscription(account, MULTI_PROFILE_SUBSCRIPTION)) return;
  throw new SubscriptionTooLowError(
    MULTI_PROFILE_SUBSCRIPTION,
    `Building for more than one profile needs a ${SUBSCRIPTIONS[MULTI_PROFILE_SUBSCRIPTION].label} ` +
      'subscription or higher. Choose a single profile.'
  );
}

/**
 * The old name, kept pointing at the real check.
 *
 * Every existing route imports `authMiddleware`, and it used to mean "let
 * anything through". Re-exporting `requireUser` under that name means those
 * routes become protected by this change rather than staying open until each
 * one is visited - which is the direction a mistake here should fail in. The
 * same reasoning, one role later, is why it is the builder check and not
 * `requireAccount`.
 */
export const authMiddleware = requireUser;

export function isAdmin(req: Request): boolean {
  return req.user?.role === 'admin';
}
