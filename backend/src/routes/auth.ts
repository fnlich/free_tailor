import { Router, type Request, type Response } from 'express';

import { listAccountPlans, resolveAccountPlan, type AccountPlan } from '../config/accountPlans';
import { countProfilesForOwner } from '../database/profileRepository';
import { destroySession, updateUser } from '../database/userRepository';
import { requireUser, SESSION_COOKIE } from '../middleware/auth';
import {
  AuthError,
  describeSignInOptions,
  requestLoginCode,
  signInWithCode,
  signInWithGoogle,
  type SignInResult,
} from '../services/auth/authService';
import { GoogleNotConfiguredError, GoogleTokenError } from '../services/auth/google';
import { MailNotConfiguredError, MailSendError } from '../services/auth/mailer';
import type { UserAccount } from '../types/account';

const router = Router();

/**
 * How long the session cookie lives. Matches the session row's own expiry, so
 * the browser stops sending a token at about the moment the server stops
 * accepting it - a cookie that outlived its row would mean a silent 401 on
 * every request with nothing to clear it.
 */
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Sets the session cookie.
 *
 * `sameSite: 'lax'` rather than 'strict': the app is opened by following a link
 * as often as by typing the address, and 'strict' drops the cookie on that
 * first navigation, so the user lands signed out and signs in again for no
 * reason. 'lax' still withholds it from cross-site POSTs, which is the case
 * that matters.
 *
 * `secure` follows the request rather than being hard-coded on. This app is
 * routinely run over plain http on a LAN address, and a Secure cookie there is
 * never sent at all - which would make signing in appear to succeed and then
 * not work.
 */
function setSessionCookie(req: Request, res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/',
  });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export type AccountView = UserAccount & {
  plan: UserAccount['plan'];
  planLabel: string;
  planSummary: string;
  /** null means unlimited. */
  profileLimit: number | null;
  profilesUsed: number;
};

/** The account plus what the plan entitles it to, which the UI always wants together. */
export function describeAccount(account: UserAccount): AccountView {
  const plan: AccountPlan = resolveAccountPlan(account.plan);
  return {
    ...account,
    planLabel: plan.label,
    planSummary: plan.summary,
    profileLimit: plan.profileLimit,
    profilesUsed: countProfilesForOwner(account.id),
  };
}

function respondWithSession(req: Request, res: Response, result: SignInResult): void {
  setSessionCookie(req, res, result.token);
  res.json({
    // Also in the body, so a non-browser caller and the streaming endpoints
    // have something to send as a Bearer token.
    token: result.token,
    account: describeAccount(result.account),
    created: result.created,
  });
}

function fail(res: Response, error: unknown): void {
  if (error instanceof AuthError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof GoogleTokenError) {
    res.status(401).json({ error: error.message });
    return;
  }
  if (error instanceof GoogleNotConfiguredError || error instanceof MailNotConfiguredError) {
    // 503, not 400: nothing the caller sent was wrong, and the fix is on the
    // server. A 400 would have the login page blame the address they typed.
    res.status(503).json({ error: error.message });
    return;
  }
  if (error instanceof MailSendError) {
    console.error('[auth] Sending a sign-in code failed.', error.cause ?? error);
    res.status(502).json({ error: error.message });
    return;
  }
  console.error('[auth] Unexpected sign-in failure.', error);
  res.status(500).json({ error: 'Something went wrong signing in. Try again.' });
}

/** What the login page can offer. Unauthenticated by design. */
router.get('/options', (_req: Request, res: Response) => {
  res.json(describeSignInOptions());
});

/** The plan catalog, so the subscription panel is not a second copy of it. */
router.get('/plans', (_req: Request, res: Response) => {
  res.json({ plans: listAccountPlans() });
});

router.post('/google', async (req: Request, res: Response) => {
  try {
    const credential = String(req.body?.credential ?? req.body?.idToken ?? '');
    respondWithSession(req, res, await signInWithGoogle(credential));
  } catch (error) {
    fail(res, error);
  }
});

router.post('/email/request', async (req: Request, res: Response) => {
  try {
    const result = await requestLoginCode(String(req.body?.email ?? ''));
    res.json({
      sent: true,
      email: result.email,
      expiresInMinutes: result.expiresInMinutes,
      message: `A six-digit code is on its way to ${result.email}. It expires in ${result.expiresInMinutes} minutes.`,
    });
  } catch (error) {
    fail(res, error);
  }
});

router.post('/email/verify', (req: Request, res: Response) => {
  try {
    respondWithSession(
      req,
      res,
      signInWithCode(String(req.body?.email ?? ''), String(req.body?.code ?? ''))
    );
  } catch (error) {
    fail(res, error);
  }
});

/**
 * Who am I.
 *
 * 200 with `account: null` rather than 401 when signed out: every page calls
 * this on mount to decide what to render, and a 401 on the ordinary
 * not-signed-in path would fill the console with errors that are not errors.
 */
router.get('/me', (req: Request, res: Response) => {
  res.json({ account: req.user ? describeAccount(req.user) : null });
});

router.post('/logout', (req: Request, res: Response) => {
  // Not behind requireUser: logging out with a token the server has already
  // forgotten must still clear the cookie, or the browser is stuck sending a
  // dead token with no way to stop.
  if (req.sessionToken) destroySession(req.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
});

/** The signed-in account's own details, refreshed. */
router.get('/account', requireUser, (req: Request, res: Response) => {
  res.json({ account: describeAccount(req.user!) });
});

/** The one thing a user may change about themselves. */
router.patch('/account', requireUser, (req: Request, res: Response) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : undefined;
  if (name === undefined) {
    res.status(400).json({ error: 'There is nothing to change.' });
    return;
  }
  if (name.length === 0 || name.length > 120) {
    res.status(400).json({ error: 'A display name is between 1 and 120 characters.' });
    return;
  }

  const updated = updateUser(req.user!.id, { name });
  res.json({ account: describeAccount(updated ?? req.user!) });
});

export default router;
