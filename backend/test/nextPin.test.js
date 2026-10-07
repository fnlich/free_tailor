const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

/**
 * Which Next the frontend runs, held where `npm run install:all` reads it.
 *
 * The owner's Windows log printed `Next.js 16.3.5` while the repository pinned
 * 16.1.6: Next had been moved by hand on that machine (`npm audit` calls 16.1.6
 * critical), and its Turbopack dev server then died natively a moment after
 * "Ready" (vercel/next.js#95015). Going back is not the remedy - every Next
 * below 16.3.3 carries GHSA-p293-qw3h-jr36, unauthenticated remote code
 * execution on a Windows-hosted server, and 16.1.6 also brings a postcss that
 * leaks files through a sourceMappingURL - so the pin moved forward, to an
 * exact release (owner decision: 16.3.8), and these hold it there:
 *
 *   - exact, never a range: a caret would let a plain `npm install` move Next
 *     under code and measurements made on one release (test/e2e/dev-reload.js
 *     per mode, README);
 *   - eslint-config-next released with it, as Next ships them together;
 *   - the lockfile agreeing, so `npm ci` and every checkout install the Next
 *     package.json names - a package.json edited by hand, without
 *     `npm install --prefix frontend` after it, would not;
 *   - no postcss the audit flags, nested under next or not.
 *
 * Read as data: nothing here starts Next.
 */

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(FRONTEND, file), 'utf8'));

const EXACT = /^\d+\.\d+\.\d+$/;
/** -1, 0 or 1, for two plain `major.minor.patch` versions. */
function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/** The first Next without GHSA-p293-qw3h-jr36 (and the other criticals `npm audit` lists up to 16.3.2). */
const FIRST_SAFE_NEXT = '16.3.3';
/** postcss <= 8.5.22 is flagged (GHSA-fxqj-rqcc-2cmp, the last of the sourceMappingURL reads). */
const FIRST_SAFE_POSTCSS = '8.5.23';

const manifest = readJson('package.json');
const lock = readJson('package-lock.json');
const pinned = manifest.dependencies.next;

test('next and eslint-config-next are pinned exactly, to the same release', () => {
  assert.match(pinned, EXACT, `frontend/package.json pins next as "${pinned}", not an exact version`);
  assert.equal(
    manifest.devDependencies['eslint-config-next'],
    pinned,
    'eslint-config-next is released with Next and pinned to the same version'
  );
});

test(`the pin is ${FIRST_SAFE_NEXT} or later, never back to a release with the Windows RCE`, () => {
  assert.ok(
    compareVersions(pinned, FIRST_SAFE_NEXT) >= 0,
    `next ${pinned} is below ${FIRST_SAFE_NEXT}, which fixed GHSA-p293-qw3h-jr36`
  );
});

test('the lockfile installs exactly what package.json pins', () => {
  const root = lock.packages[''];
  assert.equal(root.dependencies.next, pinned);
  assert.equal(root.devDependencies['eslint-config-next'], pinned);
  for (const name of ['next', '@next/env', 'eslint-config-next', '@next/eslint-plugin-next']) {
    assert.equal(
      lock.packages[`node_modules/${name}`]?.version,
      pinned,
      `${name} in frontend/package-lock.json is not ${pinned}: regenerate it with npm install --prefix frontend`
    );
  }
});

test('no postcss in the lockfile is one the audit flags', () => {
  const found = Object.entries(lock.packages).filter(([key]) => /(^|\/)node_modules\/postcss$/.test(key));
  assert.ok(found.length > 0, 'postcss is in the lockfile');
  for (const [key, entry] of found) {
    assert.ok(
      compareVersions(entry.version, FIRST_SAFE_POSTCSS) >= 0,
      `${key} is ${entry.version}, below ${FIRST_SAFE_POSTCSS}`
    );
  }
});

test('next dev does not write AGENTS.md and CLAUDE.md into frontend/', () => {
  // Next 16.3 writes both when an AI coding agent starts `next dev` and they
  // lack its block: untracked files on every such start, and a second
  // CLAUDE.md loaded on top of the repository's own.
  const config = fs.readFileSync(path.join(FRONTEND, 'next.config.ts'), 'utf8');
  assert.match(config, /^\s*agentRules: false,$/m);
});
