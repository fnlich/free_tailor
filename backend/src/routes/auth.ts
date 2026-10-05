import { Router, type Request, type Response } from 'express';

import { listSubscriptions, resolveSubscription, type AccountSubscription } from '../config/accountSubscriptions';
import { sessionTtlMs } from '../config/operational';
import { countProfilesForOwner } from '../database/profileRepository';
import { destroySession, updateUser } from '../database/userRepository';
import { requireAccount, SESSION_COOKIE } from '../middleware/auth';
import { PublicError, sendPublicError } from '../middleware/publicError';
import { pdfUploadLimitMb } from '../middleware/pdfUpload';
import {
  describeSignInOptions,
  requestLoginCode,
  signInWithCode,
  signInWithGoogle,
  type SignInResult,
} from '../services/auth/authService';
import { GoogleNotConfiguredError } from '../services/auth/google';
import { MailNotConfiguredError, MailSendError } from '../services/auth/mailer';
import type { UserAccount } from '../types/account';

const router = Router();

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
    /*
     * How long the cookie lives: SESSION_TTL_DAYS, through the same getter
     * `createSession` stamps the row's expiry with, so the browser stops sending
     * a token at about the moment the server stops accepting it. A cookie that
     * outlived its row would mean a silent 401 on every request with nothing to
     * clear it.
     */
    maxAge: sessionTtlMs(),
    path: '/',
  });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export type AccountView = UserAccount & {
  subscription: UserAccount['subscription'];
  subscriptionLabel: string;
  subscriptionSummary: string;
  /** null means unlimited. */
  profileLimit: number | null;
  profilesUsed: number;
};

/** The account plus what its subscription entitles it to, which the UI always wants together. */
export function describeAccount(account: UserAccount): AccountView {
  const subscription: AccountSubscription = resolveSubscription(account.subscription);
  return {
    ...account,
    subscriptionLabel: subscription.label,
    subscriptionSummary: subscription.summary,
    profileLimit: subscription.profileLimit,
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

/**
 * What a visitor is told when no sign-in method can be offered, or the one they
 * picked cannot be used right now.
 *
 * Generic on purpose, and for everybody: these routes answer before anybody has
 * signed in, so there is no role to give the reason to. The operator has the
 * reason in the log (under the ref), at startup, and from `npm run mail:doctor`
 * - and a visitor on the sign-in page has no use for the names of SMTP
 * variables or the mail server that refused.
 */
const SIGN_IN_UNAVAILABLE = "Sign-in isn't available right now. Please contact your administrator.";
const SIGN_IN_MAIL_FAILED =
  'We could not send the sign-in email right now. Please try again in a few minutes, or contact your administrator.';

function fail(req: Request, res: Response, error: unknown): void {
  let failure = error;
  if (error instanceof GoogleNotConfiguredError || error instanceof MailNotConfiguredError) {
    // 503, not 400: nothing the caller sent was wrong, and the fix is on the
    // server. A 400 would have the login page blame the address they typed.
    failure = new PublicError(SIGN_IN_UNAVAILABLE, { status: 503, code: 'sign-in-unavailable', detail: error.message });
  } else if (error instanceof MailSendError) {
    failure = new PublicError(SIGN_IN_MAIL_FAILED, {
      status: 502,
      detail: error.message,
      cause: error.cause ?? error,
    });
  }
  // AuthError and GoogleTokenError are public already: a code that is wrong or
  // used, an address that does not look like one, a Google account with no
  // verified email. Anything else is a generic failure with a ref.
  sendPublicError(req, res, failure, 'Something went wrong signing in');
}

/** What the login page can offer. Unauthenticated by design. */
router.get('/options', (_req: Request, res: Response) => {
  // Whether each method is on offer, and the Google client id the button
  // needs (public by design - it is in the page of every site using Google
  // sign-in). Not WHICH settings are missing: the visitor has no role yet,
  // and the operator has the startup log and mail:doctor for that.
  const options = describeSignInOptions();
  res.json({ google: options.google, email: { available: options.email.available } });
});

/** The subscription catalog, so Settings > Subscription is not a second copy of it. */
router.get('/subscriptions', (_req: Request, res: Response) => {
  res.json({ subscriptions: listSubscriptions() });
});

router.post('/google', async (req: Request, res: Response) => {
  try {
    const credential = String(req.body?.credential ?? req.body?.idToken ?? '');
    respondWithSession(req, res, await signInWithGoogle(credential));
  } catch (error) {
    fail(req, res, error);
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
    fail(req, res, error);
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
    fail(req, res, error);
  }
});

/**
 * Who am I.
 *
 * 200 with `account: null` rather than 401 when signed out: every page calls
 * this on mount to decide what to render, and a 401 on the ordinary
 * not-signed-in path would fill the console with errors that are not errors.
 *
 * `uploadMaxMb` rides along because this is the one response every page
 * already has (AuthContext fetches it once, on mount), and the upload pages
 * need the server's PDF cap to say it before a large file is sent. Served
 * rather than duplicated as a NEXT_PUBLIC_ value, which would be compiled into
 * the bundle and could disagree with what the server enforces. It is the number
 * the multer instance was built with, and it is not account data - hence top
 * level, beside `account` rather than in it.
 */
router.get('/me', (req: Request, res: Response) => {
  res.json({
    account: req.user ? describeAccount(req.user) : null,
    uploadMaxMb: pdfUploadLimitMb(),
  });
});

router.post('/logout', (req: Request, res: Response) => {
  // Not behind requireAccount: logging out with a token the server has already
  // forgotten must still clear the cookie, or the browser is stuck sending a
  // dead token with no way to stop.
  if (req.sessionToken) destroySession(req.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
});

/**
 * The signed-in account's own details, refreshed. Any role: Settings > Profile
 * is one of the pages a reporter keeps.
 */
router.get('/account', requireAccount, (req: Request, res: Response) => {
  res.json({ account: describeAccount(req.user!) });
});

/** The one thing a user may change about themselves. */
router.patch('/account', requireAccount, (req: Request, res: Response) => {
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
