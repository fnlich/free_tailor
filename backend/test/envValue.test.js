const assert = require('node:assert/strict');
const test = require('node:test');

const {
  envBool,
  envEnum,
  envInt,
  envList,
  envRaw,
  envString,
  envUrl,
  isLoopbackHost,
  resetEnvWarningsForTests,
} = require('../dist/config/envValue');

/**
 * The primitives every operational setting is read through.
 *
 * What is pinned here is the POLICY, because each reader that predates this
 * file had its own and they disagreed: unset, empty and whitespace all mean the
 * default (a bare `NAME=` copied from .env.example arrives as ''); junk warns
 * once per name and uses the default; out of range is clamped and warns once;
 * nothing ever throws. Every case passes its own env object, so no test here
 * touches the real process environment.
 */

/** Runs `read` with console.warn captured, so a test can count the warnings. */
function withWarnings(read) {
  resetEnvWarningsForTests();
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const value = read();
    return { value, warnings };
  } finally {
    console.warn = original;
  }
}

const BOUNDS = { min: 10, max: 100 };

/* ------------------------------------------------------------------ envRaw */

test('unset, empty and whitespace-only are all "not set"', () => {
  assert.equal(envRaw('X', {}), null);
  assert.equal(envRaw('X', { X: '' }), null);
  assert.equal(envRaw('X', { X: '   \t ' }), null);
  assert.equal(envRaw('X', { X: '  value ' }), 'value');
});

/* ------------------------------------------------------------------ envInt */

test('envInt: unset and empty use the default without a word', () => {
  const unset = withWarnings(() => envInt('LIMIT', 42, BOUNDS, {}));
  assert.equal(unset.value, 42);
  assert.deepEqual(unset.warnings, []);

  // `NAME=` in .env arrives as '' - the copied-example case.
  const empty = withWarnings(() => envInt('LIMIT', 42, BOUNDS, { LIMIT: '' }));
  assert.equal(empty.value, 42);
  assert.deepEqual(empty.warnings, []);
});

test('envInt: a valid value is used, surrounding whitespace and all', () => {
  const { value, warnings } = withWarnings(() => envInt('LIMIT', 42, BOUNDS, { LIMIT: ' 64 ' }));
  assert.equal(value, 64);
  assert.deepEqual(warnings, []);
});

test('envInt: junk warns once, by name, and uses the default', () => {
  const { value, warnings } = withWarnings(() => {
    const first = envInt('LIMIT', 42, BOUNDS, { LIMIT: 'lots' });
    // A per-call reader asks again on every request; it must not warn again.
    envInt('LIMIT', 42, BOUNDS, { LIMIT: 'lots' });
    envInt('LIMIT', 42, BOUNDS, { LIMIT: 'lots' });
    return first;
  });
  assert.equal(value, 42);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[env\] LIMIT="lots" is not a whole number; using 42/);
});

test('envInt: a unit, a decimal or an exponent is junk, not a number in disguise', () => {
  // parseInt('30s') is 30 and Number('1e3') is 1000 - the permissive readers
  // took a unit typed into a _MS variable as a value a thousand times too small.
  for (const junk of ['30s', '1e3', '12.5', '0x20', '1_000', '--5']) {
    const { value, warnings } = withWarnings(() => envInt('LIMIT', 42, BOUNDS, { LIMIT: junk }));
    assert.equal(value, 42, `${junk} must fall back`);
    assert.equal(warnings.length, 1, `${junk} must warn`);
  }
});

test('envInt: out of range clamps to the nearest bound and warns once', () => {
  const high = withWarnings(() => envInt('LIMIT', 42, { ...BOUNDS, unit: 'ms' }, { LIMIT: '5000' }));
  assert.equal(high.value, 100);
  assert.equal(high.warnings.length, 1);
  assert.match(high.warnings[0], /LIMIT=5000 is outside 10\.\.100; using 100 ms/);

  const low = withWarnings(() => envInt('LIMIT', 42, BOUNDS, { LIMIT: '-3' }));
  assert.equal(low.value, 10);
  assert.equal(low.warnings.length, 1);
});

test("envInt: outOfRange 'fallback' uses the default instead of the nearest bound", () => {
  const { value, warnings } = withWarnings(() =>
    envInt('PORTISH', 3001, { min: 1, max: 65535, outOfRange: 'fallback' }, { PORTISH: '0' })
  );
  assert.equal(value, 3001);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /using 3001/);
});

test('envInt: a null default means "unset", for junk as well as for empty', () => {
  assert.equal(envInt('CAP', null, BOUNDS, {}), null);
  const junk = withWarnings(() => envInt('CAP', null, BOUNDS, { CAP: 'many' }));
  assert.equal(junk.value, null);
  assert.match(junk.warnings[0], /the default \(unset\)/);
  assert.equal(envInt('CAP', null, BOUNDS, { CAP: '50' }), 50);
  assert.equal(withWarnings(() => envInt('CAP', null, BOUNDS, { CAP: '500' })).value, 100);
});

test('envInt: never throws, whatever it is given', () => {
  for (const raw of ['NaN', 'Infinity', '9'.repeat(400), '\u0000', '١٢']) {
    assert.doesNotThrow(() => withWarnings(() => envInt('LIMIT', 42, BOUNDS, { LIMIT: raw })));
  }
});

/* ----------------------------------------------------------------- envBool */

test('envBool: the four spellings of each answer, any case', () => {
  for (const yes of ['1', 'true', 'YES', 'On']) assert.equal(envBool('FLAG', false, {}, { FLAG: yes }), true);
  for (const no of ['0', 'FALSE', 'no', 'off']) assert.equal(envBool('FLAG', true, {}, { FLAG: no }), false);
  assert.equal(envBool('FLAG', true, {}, { FLAG: '' }), true);
});

test('envBool: anything else warns once and uses the default', () => {
  const { value, warnings } = withWarnings(() => envBool('FLAG', true, {}, { FLAG: 'maybe' }));
  assert.equal(value, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /FLAG="maybe"/);
});

/* ----------------------------------------------------------------- envEnum */

test('envEnum: exact by default, case-insensitive when asked, junk falls back', () => {
  const opts = { values: ['low', 'high'] };
  assert.equal(envEnum('LEVEL', 'low', opts, { LEVEL: 'high' }), 'high');
  assert.equal(withWarnings(() => envEnum('LEVEL', 'low', opts, { LEVEL: 'HIGH' })).value, 'low');
  assert.equal(
    envEnum('LEVEL', 'low', { ...opts, caseInsensitive: true }, { LEVEL: 'HIGH' }),
    'high',
    'returns the spelling from the list, not the one typed'
  );
  const junk = withWarnings(() => envEnum('LEVEL', 'low', opts, { LEVEL: 'medium' }));
  assert.equal(junk.value, 'low');
  assert.equal(junk.warnings.length, 1);
});

/* --------------------------------------------------------------- envString */

test('envString: trimmed, empty means the default', () => {
  assert.equal(envString('NAME', 'dflt', {}, { NAME: '  hello world  ' }), 'hello world');
  assert.equal(envString('NAME', 'dflt', {}, { NAME: '   ' }), 'dflt');
});

test('envString: a line break is refused - these values end up in headers and logs', () => {
  const { value, warnings } = withWarnings(() =>
    envString('AGENT', 'safe', {}, { AGENT: 'evil\r\nX-Injected: 1' })
  );
  assert.equal(value, 'safe');
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /\r|\n/, 'the warning itself must stay on one line');
});

test('envString: length, pattern and upper-casing', () => {
  assert.equal(withWarnings(() => envString('S', 'd', { maxLength: 3 }, { S: 'abcd' })).value, 'd');
  assert.equal(envString('S', 'US', { upperCase: true, pattern: /^[A-Z]{2}$/ }, { S: 'gb' }), 'GB');
  const bad = withWarnings(() =>
    envString('S', 'US', { upperCase: true, pattern: /^[A-Z]{2}$/, expected: 'a country code' }, { S: 'USA' })
  );
  assert.equal(bad.value, 'US');
  assert.match(bad.warnings[0], /is not a country code/);
});

/* ----------------------------------------------------------------- envList */

test('envList: commas, spaces or both; empty means the default', () => {
  assert.deepEqual(envList('L', ['A'], {}, { L: 'x, y  z,,w' }), ['x', 'y', 'z', 'w']);
  assert.deepEqual(envList('L', ['A'], {}, { L: '' }), ['A']);
  assert.deepEqual(envList('L', ['A'], { upperCase: true }, { L: 'res' }), ['RES']);
});

test('envList: one bad entry rejects the whole list rather than running with part of it', () => {
  const { value, warnings } = withWarnings(() =>
    envList('L', ['RESIDENTIAL'], { pattern: /^[A-Z_]+$/ }, { L: 'GOOD, bad-one' })
  );
  assert.deepEqual(value, ['RESIDENTIAL']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"bad-one"/);
});

test('envList: the default is copied, so a caller cannot mutate it', () => {
  const fallback = ['A'];
  const value = envList('L', fallback, {}, {});
  value.push('B');
  assert.deepEqual(fallback, ['A']);
});

/* ------------------------------------------------------------------ envUrl */

/** envUrl's answer when it is used, for the cases that are about the URL itself. */
const usedUrl = (raw) => {
  const resolved = envUrl('U', 'https://default.example', {}, { U: raw });
  assert.equal(resolved.ok, true, `${raw} was refused: ${resolved.problem}`);
  return resolved.url;
};

test('envUrl: unset or empty is the fallback', () => {
  for (const env of [{}, { U: '' }, { U: '   ' }]) {
    const { value, warnings } = withWarnings(() => envUrl('U', 'https://d.example', {}, env));
    assert.deepEqual(value, { ok: true, url: 'https://d.example' });
    assert.deepEqual(warnings, []);
  }
});

test('envUrl: an https URL is used, trailing slashes stripped and the host normalized', () => {
  assert.equal(usedUrl('https://GW.example.com/v1/'), 'https://gw.example.com/v1');
  assert.equal(usedUrl('https://gw.example.com//'), 'https://gw.example.com');
  assert.equal(usedUrl('https://gw.example.com:8443'), 'https://gw.example.com:8443');
});

test('envUrl: plain http is used as set, with a warning off this machine', () => {
  for (const local of ['http://localhost:4000', 'http://127.0.0.1:4000/v1', 'http://[::1]:4000', 'http://gw.localhost']) {
    const { value, warnings } = withWarnings(() => envUrl('U', 'https://d.example', {}, { U: local }));
    assert.deepEqual(value, { ok: true, url: local.replace(/\/+$/, '') }, local);
    assert.deepEqual(warnings, [], local);
  }

  // An API key goes to whatever this is, so plain http on a real network is
  // worth a warning - but never a quiet switch to the vendor's endpoint, which
  // would send the traffic somewhere the operator did not choose.
  const remote = withWarnings(() => envUrl('U', 'https://d.example', {}, { U: 'http://gw.example.com/' }));
  assert.deepEqual(remote.value, { ok: true, url: 'http://gw.example.com' });
  assert.equal(remote.warnings.length, 1);
  assert.match(remote.warnings[0], /travels unencrypted/);
});

/** Every shape envUrl refuses, and what the refusal must say. */
const REFUSED = [
  ['gw.example.com', /not an absolute http\(s\) URL/],
  ['localhost:11434/v1', /not an absolute http\(s\) URL/], // parses, as the scheme "localhost:"
  ['192.168.1.10:11434/v1', /not an absolute http\(s\) URL/],
  ['"http://ollama:11434/v1"', /not an absolute http\(s\) URL/], // quotes kept by docker --env-file
  ['not a url', /not an absolute http\(s\) URL/],
  ['ftp://gw.example.com', /not an absolute http\(s\) URL/],
  ['https://user:secret@gw.example.com', /"@"/],
  ['https://gw.example.com/v1?key=1', /query string or fragment/],
  ['https://gw.example.com/#x', /query string or fragment/],
];

test('envUrl: a value that is set but unusable is REFUSED - never replaced by the fallback', () => {
  // The fallback is a vendor's endpoint. A gateway the operator named, typed
  // without its scheme, must not become "send it all to the vendor instead".
  for (const [raw, reason] of REFUSED) {
    const { value, warnings } = withWarnings(() => envUrl('U', 'https://d.example', {}, { U: raw }));
    assert.equal(value.ok, false, raw);
    assert.equal(value.url, undefined, `${raw}: a refusal carries no URL to use`);
    assert.match(value.problem, /^U[ =]/, `${raw}: the problem names the variable`);
    assert.match(value.problem, reason, raw);
    assert.match(value.remedy, /Fix U in the root \.env, or remove it to use https:\/\/d\.example/, raw);
    assert.equal(warnings.length, 1, raw);
    assert.match(warnings[0], /refused, and NOT replaced by https:\/\/d\.example/, raw);
  }
});

test('envUrl: a refusal is warned about once per name, like every other junk value', () => {
  const { warnings } = withWarnings(() => {
    envUrl('U', 'https://d.example', {}, { U: 'gw.example.com' });
    envUrl('U', 'https://d.example', {}, { U: 'gw.example.com' });
  });
  assert.equal(warnings.length, 1);
});

test('envUrl: the warning and the refusal never repeat a secret from the value', () => {
  // Generated passwords contain `/`, `#` and `?`, which stop the URL parsing at
  // all; some gateways take their key as a query parameter. None of it may
  // reach the log, or the error an adapter raises from `problem`.
  const secrets = [
    'https://user:pa/ss-SECRET1@gw.example/v1',
    'https://user:p#ss-SECRET1@gw.example/v1',
    'https://user:p?ss-SECRET1@gw.example/v1',
    'https://user:SECRET1@gw.example/v1',
    'https://user:123/SECRET1@gw.example', // parses, with the host "user" and port 123
    'https://gw.example/v1?api_key=sk-SECRET1',
    'https://gw.example/v1#SECRET1',
    'sk-SECRET1:anything',
  ];
  for (const raw of secrets) {
    const { value, warnings } = withWarnings(() => envUrl('OPENAI_BASE_URL', 'https://d.example', {}, { OPENAI_BASE_URL: raw }));
    assert.equal(value.ok, false, raw);
    assert.equal(warnings.length, 1, raw);
    for (const text of [warnings[0], value.problem, value.remedy]) {
      assert.doesNotMatch(text, /SECRET1/, `${raw} leaked into: ${text}`);
    }
  }
  // What is safe to show still is: a query is cut off, the rest of the URL kept.
  const { warnings } = withWarnings(() =>
    envUrl('U', 'https://d.example', {}, { U: 'https://gw.example/v1?api_key=sk-x' })
  );
  assert.match(warnings[0], /U="https:\/\/gw\.example\/v1" has a query string or fragment/);
});

test('isLoopbackHost', () => {
  for (const host of ['localhost', 'LOCALHOST', 'api.localhost', '127.0.0.1', '127.8.9.10', '[::1]', '::1']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['example.com', '10.0.0.1', '0.0.0.0', 'localhost.example.com', '128.0.0.1']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});
