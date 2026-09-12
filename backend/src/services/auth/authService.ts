import { getDb } from '../../database/sqlite';
import { runDataMigrations } from '../../database/migrations';
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
  storeLoginCode,
} from '../../database/userRepository';
import type { UserAccount } from '../../types/account';
import { describeMailConfig, sendLoginCode } from './mailer';
import { isGoogleConfigured, verifyGoogleIdToken } from './google';

/**
 * The two sign-in paths, and what they have in common.
 *
 * Both prove control of an email address and then do exactly the same thing
 * with it: find or create the account, open a session. Keeping that shared half
 * in one function is what stops the two paths drifting into two slightly
 * different notions of what a signed-in user is.
 */

export class AuthError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

export type SignInResult = {
  token: string;
  account: UserAccount;
  created: boolean;
};

/**
 * Everything that happens once an address is proven.
 *
 * The migration re-run is the subtle part. Ownership migration 003 defers while
 * there is no admin, and on a fresh install that is every boot until somebody
 * signs in - which is THIS moment. Running the migrations again here means the
 * pre-account profiles are adopted the instant an admin exists, rather than on
 * the next restart, which on a long-running server could be weeks.
 */
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

  if (created && account.role === 'admin') {
    try {
      runDataMigrations(getDb());
    } catch (error) {
      // Never fatal: the sign-in itself succeeded, and the worst case is that
      // the pre-account profiles wait for the next restart.
      console.warn('[auth] Could not adopt pre-account data for the first admin.', error);
    }
  }

  markSignedIn(account.id);
  return { token: createSession(account.id), account, created };
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
