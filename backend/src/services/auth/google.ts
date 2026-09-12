import { OAuth2Client } from 'google-auth-library';

/**
 * Verifying a Google sign-in.
 *
 * The browser does the whole Google dance itself and hands the server one ID
 * token. That token is the ONLY thing trusted here, and it is verified against
 * Google's published keys rather than decoded: an unverified JWT is a string a
 * caller chose, so reading an email out of one without checking the signature
 * would let anybody sign in as anybody.
 *
 * The audience check matters as much as the signature. A token signed by Google
 * for some other application is perfectly valid and says nothing about whether
 * its holder meant to sign in HERE, so it is refused unless it names this
 * client id.
 */

export class GoogleNotConfiguredError extends Error {
  constructor() {
    super(
      'Google sign-in is not configured on this server: GOOGLE_CLIENT_ID is not set. ' +
        'Set it in .env and restart, or sign in with an emailed code.'
    );
    this.name = 'GoogleNotConfiguredError';
  }
}

export class GoogleTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleTokenError';
  }
}

export function getGoogleClientId(env: NodeJS.ProcessEnv = process.env): string {
  return env.GOOGLE_CLIENT_ID?.trim() ?? '';
}

export function isGoogleConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return getGoogleClientId(env).length > 0;
}

export type GoogleIdentity = {
  email: string;
  name: string;
  picture: string;
  googleSub: string;
};

let cached: { clientId: string; client: OAuth2Client } | null = null;

function getClient(clientId: string): OAuth2Client {
  if (cached?.clientId === clientId) return cached.client;
  const client = new OAuth2Client(clientId);
  cached = { clientId, client };
  return client;
}

export function resetGoogleClientForTests(): void {
  cached = null;
}

/**
 * The verified identity behind an ID token.
 *
 * `email_verified` is required, not merely read. Google will issue a token for
 * an unverified address on some account types, and accepting one would let
 * somebody claim an address they do not control - which, since the email is
 * this app's identity, is the whole account.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<GoogleIdentity> {
  const clientId = getGoogleClientId(env);
  if (!clientId) throw new GoogleNotConfiguredError();
  if (!idToken || typeof idToken !== 'string') {
    throw new GoogleTokenError('No Google credential was sent.');
  }

  let payload;
  try {
    const ticket = await getClient(clientId).verifyIdToken({ idToken, audience: clientId });
    payload = ticket.getPayload();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new GoogleTokenError(`Google could not verify that sign-in: ${reason}`);
  }

  if (!payload) throw new GoogleTokenError('Google returned a sign-in with no account details.');
  if (!payload.email) throw new GoogleTokenError('That Google account has no email address.');
  if (!payload.email_verified) {
    throw new GoogleTokenError(
      'That Google account has not verified its email address, so it cannot be used to sign in.'
    );
  }

  return {
    email: payload.email,
    name: payload.name ?? '',
    picture: payload.picture ?? '',
    googleSub: payload.sub,
  };
}
