const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage } = require('./helpers');

/**
 * Whether the session cookie is marked Secure, which depends entirely on
 * Express being told a proxy is in front of it.
 *
 * `routes/auth.ts` sets `secure: req.protocol === 'https'`. On a
 * reverse-proxied install the TLS ends at the proxy and Express is spoken to
 * over plain http on loopback, so `req.protocol` reads 'http' and the flag is
 * silently dropped unless `trust proxy` is set. Nothing in the app fails when
 * that happens - sign-in works, the cookie is just weaker than it looks - which
 * is why it needs a test rather than a look.
 *
 * Both directions are pinned. Marking it Secure unconditionally would break the
 * plain-http LAN install the cookie comment describes, where a Secure cookie is
 * never sent at all and sign-in appears to work and then does not.
 */

async function serve(name) {
  useTempStorage(name);
  const express = require('express');

  const users = loadFresh('../dist/database/userRepository');
  const { applyProxyTrust } = loadFresh('../dist/config/proxyTrust');
  const routes = loadFresh('../dist/routes/auth');

  const app = express();
  applyProxyTrust(app);
  app.use(express.json());
  app.use('/api/auth', routes.default);

  const server = app.listen(0);
  const port = server.address().port;

  return {
    users,
    close: () => server.close(),
    /** Signs in with a code planted straight into the database, so no mail is sent. */
    verify: (email, code, headers = {}) =>
      fetch(`http://127.0.0.1:${port}/api/auth/email/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ email, code }),
      }),
  };
}

test('a request the proxy says arrived over https gets a Secure session cookie', async () => {
  const server = await serve('cookie-https');
  try {
    server.users.storeLoginCode('forwarded@example.com', '123456');
    const response = await server.verify('forwarded@example.com', '123456', {
      'x-forwarded-proto': 'https',
    });

    assert.equal(response.status, 200, await response.text());
    const cookie = response.headers.get('set-cookie');
    assert.ok(cookie, 'the sign-in must set a session cookie');
    assert.match(cookie, /^ft_session=/);
    assert.match(cookie, /Secure/, 'X-Forwarded-Proto: https must reach req.protocol');
    // Asserted alongside, so a cookie that lost httpOnly while gaining Secure
    // cannot pass this file.
    assert.match(cookie, /HttpOnly/);
  } finally {
    server.close();
  }
});

test('a request that really is plain http does not get one', async () => {
  const server = await serve('cookie-http');
  try {
    server.users.storeLoginCode('direct@example.com', '654321');
    const response = await server.verify('direct@example.com', '654321');

    assert.equal(response.status, 200, await response.text());
    const cookie = response.headers.get('set-cookie');
    assert.ok(cookie, 'the sign-in must set a session cookie');
    assert.doesNotMatch(
      cookie,
      /Secure/,
      'a Secure cookie over http is never sent, so sign-in would appear to work and then not'
    );
  } finally {
    server.close();
  }
});
