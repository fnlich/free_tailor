const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh } = require('./helpers');

/**
 * `APP_URL`, the one variable a single-origin deployment sets.
 *
 * The value is pasted into absolute URLs a real browser is redirected to, so
 * what is rejected matters more than what is accepted: a half-written value
 * that survives here becomes a payment return URL nobody can follow, weeks
 * later, with nothing pointing back to this.
 */

test('an origin is taken only when it is absolute and http(s)', () => {
  const { normalizeOrigin } = loadFresh('../dist/config/publicUrl');

  assert.equal(normalizeOrigin('https://example.org'), 'https://example.org');
  assert.equal(normalizeOrigin('  https://example.org  '), 'https://example.org');
  // An origin has no path, and callers append their own.
  assert.equal(normalizeOrigin('https://example.org/'), 'https://example.org');
  assert.equal(normalizeOrigin('https://example.org/app/'), 'https://example.org');
  assert.equal(normalizeOrigin('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeOrigin('https://example.org:8443'), 'https://example.org:8443');

  assert.equal(normalizeOrigin(undefined), null);
  assert.equal(normalizeOrigin(''), null);
  assert.equal(normalizeOrigin('   '), null);
  // The one that matters: `new URL('example.org')` does not throw - it parses
  // as protocol "example.org:" - so a scheme-less value would sail through a
  // try/catch alone and produce a link no browser can follow.
  assert.equal(normalizeOrigin('example.org'), null);
  assert.equal(normalizeOrigin('//example.org'), null);
  // What a sandboxed iframe or a non-browser client sends.
  assert.equal(normalizeOrigin('null'), null);
  assert.equal(normalizeOrigin('javascript:alert(1)'), null);
  assert.equal(normalizeOrigin('file:///etc/passwd'), null);
});

test('APP_URL is read through that rule, and a bad one is ignored rather than fatal', () => {
  const publicUrl = loadFresh('../dist/config/publicUrl');

  assert.equal(publicUrl.publicBaseUrl({}), null);
  assert.equal(publicUrl.publicBaseUrl({ APP_URL: '' }), null);
  assert.equal(publicUrl.publicBaseUrl({ APP_URL: 'https://example.org/' }), 'https://example.org');

  // Warned about, never thrown: refusing to boot would take down an entire
  // installation over a value most of it does not use.
  publicUrl.resetPublicUrlWarning();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    assert.equal(publicUrl.publicBaseUrl({ APP_URL: 'example.org' }), null);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1, 'a rejected APP_URL must say so');
  assert.match(warnings[0], /APP_URL/);
  assert.match(warnings[0], /example\.org/);
});
