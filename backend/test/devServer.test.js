const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

/**
 * Which dev server `npm run dev` starts (README, "Run", and its
 * Troubleshooting row on a tab that reloads itself).
 *
 * Next 16.1's webpack hot-reload server broadcasts `SYNC {hash}` to every open
 * tab when a new one connects, and a tab holding an older hash - anything
 * compiled since it opened, such as the page the second tab asked for -
 * reloads itself. That reload's pagehide released a Generate Immediately run
 * going in it, so opening a second tab STOPPED the first tab's run.
 * test/e2e/dev-reload.js reproduces it in a browser, and measured: webpack
 * (`dev:live`) reloaded tab A and cancelled its run; Turbopack (`dev:turbo`)
 * and the production-style `dev` did neither. The root `dev` therefore runs
 * Turbopack, and webpack stays available, by name, for whoever needs it.
 *
 * Read as text, not run: next.mjs launches Next the moment it is evaluated.
 */

const ROOT = path.join(__dirname, '..', '..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));

test('the root dev runs the frontend on Turbopack; the webpack dev server is opt-in', () => {
  const root = readJson('package.json').scripts;
  const frontend = readJson('frontend/package.json').scripts;

  assert.match(root.dev, /"npm run dev --prefix backend"/);
  assert.match(root.dev, /"npm run dev:turbo --prefix frontend"/);
  assert.doesNotMatch(root.dev, /dev:live/, 'the root dev must not start the webpack dev server');
  // Still there, by name.
  assert.match(root['dev:live'], /"npm run dev:live --prefix frontend"/);
  assert.equal(root['dev:frontend-live'], 'npm run dev:live --prefix frontend');
  assert.equal(root['dev:frontend-turbo'], 'npm run dev:turbo --prefix frontend');

  // Every frontend script goes through the wrapper (CLAUDE.md), and the two
  // dev servers are its two dev modes.
  assert.equal(frontend['dev:turbo'], 'node scripts/next.mjs dev');
  assert.equal(frontend['dev:live'], 'node scripts/next.mjs dev-webpack');

  const wrapper = fs.readFileSync(path.join(ROOT, 'frontend', 'scripts', 'next.mjs'), 'utf8');
  const modes = /const MODES = \{([\s\S]*?)\};/.exec(wrapper)?.[1] ?? '';
  // `next dev` with no bundler flag is Turbopack in Next 16; webpack is asked for.
  assert.match(modes, /\bdev: \['dev'\],/);
  assert.match(modes, /'dev-webpack': \['dev', '--webpack'\],/);
});

test('the reproduction names every mode it was measured in', () => {
  const script = fs.readFileSync(path.join(__dirname, 'e2e', 'dev-reload.js'), 'utf8');
  for (const mode of ['dev:live', 'dev:turbo', 'dev (production-style)']) {
    assert.ok(script.includes(mode), `dev-reload.js says how to run it against ${mode}`);
  }
  // It checks the run as well as the page: a reload that left the run going
  // would be a smaller bug, and one that stopped it is the owner's.
  assert.match(script, /the run was not stopped by the second tab/);
});
