import type { Express } from 'express';

/**
 * Tells Express that ONE reverse proxy sits in front of it.
 *
 * This exists for a single line elsewhere: `routes/auth.ts` marks the session
 * cookie `secure` when `req.protocol` reads https. Behind Caddy or nginx the
 * TLS ends at the proxy and Express is spoken to over plain http on loopback,
 * so without this `req.protocol` is always 'http', the flag is never set, and
 * the session cookie on an https install is one a browser would also send in
 * clear. Nothing else in this backend reads `req.ip`, `req.hostname` or
 * `req.secure`, so that cookie is the whole blast radius - and note that
 * `isOriginAllowed` reads `req.headers.host` directly rather than
 * `req.hostname`, which is why CORS behaves the same either way.
 *
 * `1` rather than `true`. `true` believes the entire X-Forwarded-For chain,
 * which means any client can prepend a hop of its own invention and be taken at
 * its word; `1` trusts only the nearest proxy, which is the one that is ours.
 *
 * Not conditional on an env var, because it does not need to be. With no proxy
 * in front nothing sends X-Forwarded-Proto and `req.protocol` still reports the
 * socket, so the plain-http LAN install the cookie comment describes keeps
 * working. A client that forges the header over http gets a Secure cookie its
 * own browser will then refuse to send back - it can strand itself and nobody
 * else, since no site can make another visitor's browser add that header.
 */
export function applyProxyTrust(app: Express): void {
  app.set('trust proxy', 1);
}
