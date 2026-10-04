import crypto from 'crypto';
import { getSetting, setSetting } from '../../database/settingsRepository';

/**
 * Which model wrote a preview, as proof the server issued.
 *
 * A preview is free and hands its tailored content back; finalising sends that
 * content to `/resume/generate` or `/generation/batches`, which build files
 * from it without running the model again - and charge for it. The charge has
 * to be the price of the model that WROTE the content, and the request cannot
 * say which that was: the page's model picker may have moved since, the
 * multi-profile preview used each profile's own model, and a request is free to
 * name the cheapest model while supplying the dearest one's work. So the
 * preview hands out this token beside the content, naming the account, the
 * profile and the model, and finalising charges the model it names.
 *
 * Not bound to the content itself, on purpose: the builder lets a person edit
 * the tailored JSON by hand before finalising, and that is still the same
 * model's work.
 *
 * Signed with a secret kept in the settings table, created on first use, so a
 * token survives a restart between preview and finalise. It lives a day,
 * which is longer than any page holds a preview.
 */

const SECRET_KEY = 'preview-token-secret';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

type TokenClaims = { u: string; p: string; m: string; t: number };

function signingSecret(): Buffer {
  const stored = getSetting<string>(SECRET_KEY);
  if (typeof stored === 'string' && /^[0-9a-f]{64}$/.test(stored)) return Buffer.from(stored, 'hex');
  const fresh = crypto.randomBytes(32).toString('hex');
  setSetting(SECRET_KEY, fresh);
  return Buffer.from(fresh, 'hex');
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', signingSecret()).update(payload).digest('base64url');
}

export function issuePreviewToken(
  input: { userId: string; profileId: string; modelId: string },
  now: number = Date.now()
): string {
  const claims: TokenClaims = { u: input.userId, p: input.profileId, m: input.modelId, t: now };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/**
 * The model id a token names, when it is genuine, unexpired and was issued to
 * this account for this profile; otherwise null. Never throws: a token is a
 * hint the request carries, and a bad one is simply not there.
 */
export function readPreviewToken(
  token: unknown,
  expected: { userId: string; profileId: string },
  now: number = Date.now()
): string | null {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [payload, signature, ...rest] = token.split('.');
  if (!payload || !signature || rest.length > 0) return null;

  const wanted = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (wanted.length !== given.length || !crypto.timingSafeEqual(wanted, given)) return null;

  let claims: Partial<TokenClaims>;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<TokenClaims>;
  } catch {
    return null;
  }
  if (claims.u !== expected.userId || claims.p !== expected.profileId) return null;
  if (typeof claims.m !== 'string' || !claims.m) return null;
  if (typeof claims.t !== 'number' || now - claims.t > TOKEN_TTL_MS || claims.t - now > 60_000) return null;
  return claims.m;
}
