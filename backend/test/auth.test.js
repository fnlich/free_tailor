const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage } = require('./helpers');

/**
 * The middleware that decides who is making a request.
 *
 * This file used to pin the opposite: that `authMiddleware` called next() for
 * everybody and `validatePassword` returned true for every input, including an
 * empty string. That was accurate for a single-user app and is the exact
 * behaviour v2 had to remove, so the assertions are inverted rather than
 * deleted - a regression back to "let everything through" must fail here.
 */

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function run(middleware, req) {
  const res = makeRes();
  let passed = false;
  middleware(req, res, () => {
    passed = true;
  });
  return { passed, res };
}

test('an unauthenticated request is refused, not waved through', () => {
  useTempStorage('auth-refuses');
  const { requireUser, requireAdmin } = loadFresh('../dist/middleware/auth');

  const user = run(requireUser, { headers: {} });
  assert.equal(user.passed, false, 'requireUser must not call next for a stranger');
  assert.equal(user.res.statusCode, 401);
  assert.equal(user.res.body.code, 'not-signed-in');

  const admin = run(requireAdmin, { headers: {} });
  assert.equal(admin.passed, false);
  assert.equal(admin.res.statusCode, 401);
});

test('a signed-in user is not an admin, and the two refusals differ', () => {
  useTempStorage('auth-roles');
  const { requireUser, requireAdmin } = loadFresh('../dist/middleware/auth');

  const req = { headers: {}, user: { id: 'u1', role: 'user' } };

  assert.equal(run(requireUser, req).passed, true, 'a user may do user things');

  const denied = run(requireAdmin, req);
  assert.equal(denied.passed, false);
  // 403, not 401. The fixes differ - one is "sign in", the other is "you are
  // signed in as the wrong person" - and a page that showed "sign in" to
  // somebody already signed in would loop them.
  assert.equal(denied.res.statusCode, 403);
  assert.equal(denied.res.body.code, 'not-an-admin');

  assert.equal(run(requireAdmin, { headers: {}, user: { id: 'a1', role: 'admin' } }).passed, true);
});

test('a reporter is signed in but may not build: requireUser refuses them, requireAccount does not', () => {
  useTempStorage('auth-reporter');
  const { requireAccount, requireAdmin, requireSubscription, requireUser, ROLE_NOT_ALLOWED_MESSAGE } =
    loadFresh('../dist/middleware/auth');

  const reporter = { headers: {}, user: { id: 'r1', role: 'reporter', subscription: 'premium-max' } };

  const refused = run(requireUser, reporter);
  assert.equal(refused.passed, false);
  // 403 with its own code, never 401: they ARE signed in, and the page must
  // not treat it as a lapsed session and sign them out.
  assert.equal(refused.res.statusCode, 403);
  assert.equal(refused.res.body.code, 'role-not-allowed');
  assert.equal(refused.res.body.error, ROLE_NOT_ALLOWED_MESSAGE);
  // About their own account, nothing about the installation - and in the
  // words the pages turn into a Contact admin link.
  assert.match(refused.res.body.error, /not available for your account\. Ask your administrator/);
  assert.equal(Object.keys(refused.res.body).sort().join(','), 'code,error');

  assert.equal(run(requireAccount, reporter).passed, true, 'their own account, credits, sheet...');
  assert.equal(run(requireAdmin, reporter).res.body.code, 'not-an-admin');
  // A subscription is a tier of the builder: whatever the column says, a
  // reporter is refused by role first.
  const tiered = run(requireSubscription('premium'), reporter);
  assert.equal(tiered.passed, false);
  assert.equal(tiered.res.body.code, 'role-not-allowed');

  for (const role of ['user', 'admin']) {
    const req = { headers: {}, user: { id: role, role, subscription: 'premium' } };
    assert.equal(run(requireUser, req).passed, true, `${role} builds`);
    assert.equal(run(requireAccount, req).passed, true);
  }
  // Whoever MAY build is a list, so a role nobody decided about is refused.
  assert.equal(run(requireUser, { headers: {}, user: { id: 'x', role: 'auditor' } }).res.body.code, 'role-not-allowed');

  const stranger = run(requireAccount, { headers: {} });
  assert.equal(stranger.passed, false);
  assert.equal(stranger.res.statusCode, 401);
  assert.equal(stranger.res.body.code, 'not-signed-in');
});

test('the old authMiddleware name now means the real check', () => {
  useTempStorage('auth-alias');
  const { authMiddleware, requireUser } = loadFresh('../dist/middleware/auth');

  // Every pre-v2 route imports this name. Pointing it at requireUser is what
  // made those routes protected by the change rather than one at a time.
  assert.equal(authMiddleware, requireUser);
  assert.equal(run(authMiddleware, { headers: {} }).passed, false);
});

test('the session token is read from a Bearer header or the cookie', () => {
  useTempStorage('auth-token-source');
  const { readSessionToken, SESSION_COOKIE } = loadFresh('../dist/middleware/auth');

  assert.equal(readSessionToken({ headers: { authorization: 'Bearer abc123' } }), 'abc123');
  assert.equal(
    readSessionToken({ headers: { cookie: `other=1; ${SESSION_COOKIE}=xyz789; more=2` } }),
    'xyz789'
  );
  // The header wins, so a script can act as somebody other than whoever the
  // browser's cookie belongs to without clearing it first.
  assert.equal(
    readSessionToken({ headers: { authorization: 'Bearer header', cookie: `${SESSION_COOKIE}=cookie` } }),
    'header'
  );
  assert.equal(readSessionToken({ headers: {} }), '');
  assert.equal(readSessionToken({ headers: { authorization: 'Bearer   ' } }), '');
});

test('attachUser resolves a real session and never refuses', () => {
  useTempStorage('auth-attach');
  const repository = loadFresh('../dist/database/userRepository');
  const { attachUser } = loadFresh('../dist/middleware/auth');

  const account = repository.createUser({ email: 'signed-in@example.com' });
  const token = repository.createSession(account.id);

  const req = { headers: { authorization: `Bearer ${token}` } };
  assert.equal(run(attachUser, req).passed, true);
  assert.equal(req.user?.email, 'signed-in@example.com');
  assert.equal(req.sessionToken, token);

  // A junk token attaches nobody and still passes: refusing is the job of
  // requireUser, so a public route stays public.
  const stranger = { headers: { authorization: 'Bearer not-a-token' } };
  assert.equal(run(attachUser, stranger).passed, true);
  assert.equal(stranger.user, undefined);
});
