import {
  consumeLoginCode,
  createSession,
  findOrCreateUser,
  generateLoginCode,
  lastCodeSentAt,
  LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_CODE_TTL_MS,
  markSignedIn,
  normalizeEmail,
  promoteConfiguredAdmins,
  promoteIfConfiguredAdmin,
  storeLoginCode,
} from '../../database/userRepository';
import type { UserAccount } from '../../types/account';
import { ensureAccountSheet } from '../sheets/accountSheet';
import { describeMailConfig, sendLoginCode } from './mailer';
import { isGoogleConfigured, verifyGoogleIdToken } from './google';
import { PublicError } from '../../middleware/publicError';

/**
 * The two sign-in paths, and what they have in common.
 *
 * Both prove control of an email address and then do exactly the same thing
 * with it: find or create the account, open a session. Keeping that shared half
 * in one function is what stops the two paths drifting into two slightly
 * different notions of what a signed-in user is.
 */

/** A sign-in refusal about the caller's own address or code, so it is public. */
export class AuthError extends PublicError {
  constructor(message: string, status = 400) {
    super(message, { status });
    this.name = 'AuthError';
  }
}

export type SignInResult = {
  token: string;
  account: UserAccount;
  created: boolean;
};

/** Everything that happens once an address is proven. */
function completeSignIn(input: {
  email: string;
  name?: string;
  picture?: string;
  googleSub?: string;
}): SignInResult {
  const { account, created } = findOrCreateUser(input);

  if (account.disabled) {
    throw new AuthError(
      'That account has been disabled. Ask an administrator of this installation to re-enable it.',
      403
    );
  }

  // An account that predates the current configuration - or that signed up
  // before ADMIN_EMAILS / SMTP_USER named it - is promoted here, on the way in.
  // Without this the operator would have to wait for a restart to administer
  // their own installation.
  const promoted = promoteIfConfiguredAdmin(account);
  if (promoted) account.role = 'admin';

  markSignedIn(account.id);

  // Started, not awaited. Allocating a spreadsheet and adding the day's tab is
  // several round trips to Google, and putting them in front of the session
  // token would both slow every sign-in down and make a Google outage into an
  // outage of logging in. The account page ensures the same thing on read, so
  // nothing is lost by this failing quietly here.
  void ensureAccountSheet(account).catch((error) => {
    console.warn(`[sheets] Could not prepare the sheet for ${account.email}.`, error);
  });

  return { token: createSession(account.id), account, created };
}

/**
 * The startup promotion: an account named by ADMIN_EMAILS or SMTP_USER that
 * already exists becomes an administrator at boot, rather than at its next
 * sign-in. Answers how many were promoted.
 */
export function applyConfiguredAdmins(): number {
  return promoteConfiguredAdmins();
}

export async function signInWithGoogle(idToken: string): Promise<SignInResult> {
  const identity = await verifyGoogleIdToken(idToken);
  return completeSignIn({
    email: identity.email,
    name: identity.name,
    picture: identity.picture,
    googleSub: identity.googleSub,
  });
}

/** How long to make somebody wait before a second code goes to the same address. */
export const CODE_RESEND_COOLDOWN_MS = 60_000;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type CodeRequestResult = {
  email: string;
  expiresInMinutes: number;
};

/**
 * Sends a sign-in code, or says why it could not.
 *
 * Note what this does NOT do: it does not tell the caller whether the address
 * has an account. Both cases send a code and read identically from outside,
 * because the alternative turns this endpoint into a way to ask "is this person
 * a user here?" - and the account is created on verification anyway, so there
 * is nothing to be gained by distinguishing them.
 */
export async function requestLoginCode(rawEmail: string): Promise<CodeRequestResult> {
  const email = normalizeEmail(rawEmail);
  if (!EMAIL_PATTERN.test(email)) {
    throw new AuthError('That does not look like an email address.');
  }

  const sentAt = lastCodeSentAt(email);
  if (sentAt !== null) {
    const waited = Date.now() - sentAt;
    if (waited < CODE_RESEND_COOLDOWN_MS) {
      const seconds = Math.ceil((CODE_RESEND_COOLDOWN_MS - waited) / 1000);
      throw new AuthError(
        `A code was just sent to that address. Wait ${seconds} more second${seconds === 1 ? '' : 's'} ` +
          'before asking for another, and check the spam folder in the meantime.',
        429
      );
    }
  }

  const code = generateLoginCode();
  const ttlMinutes = Math.round(LOGIN_CODE_TTL_MS / 60_000);

  // Sent BEFORE it is stored. The other order would leave a live code that
  // never arrived, and the person would then be inside the resend cooldown for
  // a code they cannot possibly have.
  await sendLoginCode(email, code, ttlMinutes);
  storeLoginCode(email, code);

  return { email, expiresInMinutes: ttlMinutes };
}

const CODE_FAILURE_MESSAGES: Record<string, string> = {
  'no-code': 'That code has already been used, or none was sent to this address. Ask for a new one.',
  expired: 'That code has expired. Ask for a new one.',
  'too-many-attempts':
    `That code was entered wrongly ${LOGIN_CODE_MAX_ATTEMPTS} times and is no longer valid. ` +
    'Ask for a new one.',
  'wrong-code': 'That code is not right. Check the email and try again.',
};

export function signInWithCode(rawEmail: string, code: string): SignInResult {
  const email = normalizeEmail(rawEmail);
  const submitted = String(code ?? '').trim();

  if (!/^\d{6}$/.test(submitted)) {
    throw new AuthError('A sign-in code is six digits.');
  }

  const check = consumeLoginCode(email, submitted);
  if (!check.ok) {
    throw new AuthError(CODE_FAILURE_MESSAGES[check.reason] ?? 'That code could not be used.', 401);
  }

  return completeSignIn({ email });
}

export type SignInOptions = {
  google: { available: boolean; clientId: string };
  email: { available: boolean; missing: string[] };
};

/**
 * What the login page needs to know before it renders.
 *
 * Sent unauthenticated, on purpose: it is the one thing a signed-out browser
 * legitimately needs. It carries the Google client id, which is public by
 * design - it appears in the page of every site using Google sign-in - and the
 * NAMES of missing SMTP variables, never their values.
 */
export function describeSignInOptions(env: NodeJS.ProcessEnv = process.env): SignInOptions {
  const mail = describeMailConfig(env);
  return {
    google: {
      available: isGoogleConfigured(env),
      clientId: env.GOOGLE_CLIENT_ID?.trim() ?? '',
    },
    email: {
      available: mail.configured,
      missing: mail.configured ? [] : mail.missing,
    },
  };
}

/**
 * The startup line for an install nobody can sign in to, or null.
 *
 * The sign-in page names no setting - whoever reads it has no account yet -
 * so with neither path configured the log is the only place an operator can
 * learn which variables to set. Names only, never a value.
 */
export function describeSignInGap(env: NodeJS.ProcessEnv = process.env): string | null {
  const options = describeSignInOptions(env);
  if (options.google.available || options.email.available) return null;
  const smtp = options.email.missing.length ? options.email.missing.join(', ') : 'the SMTP_* variables';
  return (
    '[auth] Nobody can sign in: neither Google sign-in (GOOGLE_CLIENT_ID) nor emailed codes ' +
    `(${smtp} missing) are configured, and the sign-in page says only that sign-in isn't available. ` +
    'Set one of them in .env (see .env.example) and restart; "npm run mail:doctor" in backend/ checks SMTP.'
  );
}
