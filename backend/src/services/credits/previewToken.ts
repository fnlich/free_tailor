import crypto from 'crypto';
import { getSetting, setSetting } from '../../database/settingsRepository';
import { isBuildMode, type BuildMode } from '../../config/buildModes';

/**
 * Which build mode wrote a preview, as proof the server issued.
 *
 * A preview hands its tailored content back; finalising sends that content to
 * `/generation/batches`, which builds files from it without running the model
 * again - and charges for it. The charge has to be the price of the MODE that
 * wrote the content (Partial Tailor or Fully Tailor), and the request cannot
 * say which that was: a request is free to name the cheapest mode while
 * supplying the dearest one's work. So the preview hands out this token beside
 * the content, naming the account, the resume and the build mode, and
 * finalising charges the mode it names. Content without a token valid for the
 * run's own (account, resume, mode) is charged the dearest mode price
 * (services/resumeChoice.ts `priceRun`).
 *
 * Not bound to the content itself, on purpose: the builder lets a person edit
 * the tailored JSON by hand before finalising, and that is still the same
 * mode's work.
 *
 * KNOWN GAP (owner decision needed, reviewed in F2): because the token is not
 * bound to the content, an account can preview one resume in Fully Tailor
 * (keeping the content) and in Partial Tailor (keeping that token), then
 * finalise Partial with the Fully content and pay Partial's price for Fully's
 * work. Previews are free, so it costs the account nothing to try. Closing it
 * means binding the token to a hash of the content, which makes a hand-edited
 * preview the "content nobody vouches for" (the dearest mode's price) - a
 * change to the builder's Manual Edits that is the owner's to make. Until then
 * the gap is exactly the difference between the Partial and Fully prices, and
 * only on resumes the account previewed twice.
 *
 * Signed with a secret kept in the settings table, created on first use, so a
 * token survives a restart between preview and finalise. It lives a day,
 * which is longer than any page holds a preview.
 */

const SECRET_KEY = 'preview-token-secret';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

type TokenClaims = { u: string; r: string; b: BuildMode; t: number };

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
  input: { userId: string; resumeId: string; buildMode: BuildMode },
  now: number = Date.now()
): string {
  const claims: TokenClaims = { u: input.userId, r: input.resumeId, b: input.buildMode, t: now };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/**
 * The build mode a token names, when it is genuine, unexpired and was issued
 * to this account for this resume; otherwise null (an old-format token, which
 * named a model, included). Never throws: a token is a hint the request
 * carries, and a bad one is simply not there.
 */
export function readPreviewToken(
  token: unknown,
  expected: { userId: string; resumeId: string },
  now: number = Date.now()
): BuildMode | null {
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
  if (claims.u !== expected.userId || claims.r !== expected.resumeId) return null;
  if (!isBuildMode(claims.b)) return null;
  if (typeof claims.t !== 'number' || now - claims.t > TOKEN_TTL_MS || claims.t - now > 60_000) return null;
  return claims.b;
}
