const assert = require('node:assert/strict');
const test = require('node:test');

const {
  authMiddleware,
  generateToken,
  invalidateToken,
  optionalAuthMiddleware,
  validatePassword,
} = require('../dist/middleware/auth');

test('auth helpers expose current permissive development behavior', () => {
  const token = generateToken();
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(validatePassword('anything'), true);
  assert.doesNotThrow(() => invalidateToken(token));
});

test('auth middleware always calls next and optional auth marks the request authenticated', () => {
  let authNextCalled = false;
  authMiddleware({}, {}, () => {
    authNextCalled = true;
  });
  assert.equal(authNextCalled, true);

  const req = {};
  let optionalNextCalled = false;
  optionalAuthMiddleware(req, {}, () => {
    optionalNextCalled = true;
  });
  assert.equal(optionalNextCalled, true);
  assert.equal(req.isAuthenticated, true);
});
