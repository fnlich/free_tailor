import type { NextFunction, Request, Response } from 'express';

import { resolveSession } from '../database/userRepository';
import type { UserAccount } from '../types/account';

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

/** Signed in, or 401. */
export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Sign in to do that.', code: 'not-signed-in' });
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
 * The old name, kept pointing at the real check.
 *
 * Every existing route imports `authMiddleware`, and it used to mean "let
 * anything through". Re-exporting `requireUser` under that name means those
 * routes become protected by this change rather than staying open until each
 * one is visited - which is the direction a mistake here should fail in.
 */
export const authMiddleware = requireUser;

export function isAdmin(req: Request): boolean {
  return req.user?.role === 'admin';
}
