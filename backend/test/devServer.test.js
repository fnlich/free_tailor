const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

/**
 * Which dev server `npm run dev` starts (README, "Run", and its
 * Troubleshooting row on a tab that reloads itself), and what the wrapper does
 * when that server dies on Windows.
 *
 * Next's webpack hot-reload server broadcasts `SYNC {hash}` to every open tab
 * when a new one connects, and a tab holding an older hash - anything compiled
 * since it opened, such as the page the second tab asked for - reloads itself.
 * That reload's pagehide released a Generate Immediately run going in it, so
 * opening a second tab STOPPED the first tab's run. test/e2e/dev-reload.js
 * reproduces it in a browser, and measured, on 16.1.6 and again on 16.3.8:
 * webpack (`dev:live`) reloaded tab A and cancelled its run; Turbopack
 * (`dev:turbo`) and the production-style `dev` did neither. The root `dev`
 * therefore runs Turbopack, and webpack stays available, by name, for whoever
 * needs it.
 *
 * On Windows, Turbopack's `next dev` can die natively with 0xC0000005 a moment
 * after "Ready" (vercel/next.js#95015 - the owner's log: `npm run dev:turbo
 * --prefix frontend exited with code 3221225477`). frontend/scripts/next.mjs
 * then builds and starts the production-style server in its place, once
 * (owner's decision). What it runs and when is decided in nextLaunch.mjs,
 * imported and run here; next.mjs launches Next the moment it is evaluated,
 * so it is read as text - or run as a COPY beside a stand-in Next that records
 * what it was asked to do. The fallback cannot be produced on Linux (an exit
 * code is a byte here, and the platform is not win32), so the copy that
 * exercises it has exactly two lines injected, both by text: the platform and
 * the stand-in's exit code. The shipped script has no hook for a test.
 */

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'frontend', 'scripts');
const WRAPPER = path.join(SCRIPTS, 'next.mjs');
const LAUNCH = path.join(SCRIPTS, 'nextLaunch.mjs');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const loadLaunch = () => import(pathToFileURL(LAUNCH).href);

const ADDRESS = { hostname: '127.0.0.1', port: '3159' };
const UNSIGNED = 3221225477; // 0xC0000005, what Node reports on Windows
const SIGNED = -1073741819; // the same 32 bits as cmd and PowerShell print them

test('the root dev runs the frontend on Turbopack; the webpack dev server is opt-in', async () => {
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

  // `next dev` with no bundler flag is Turbopack in Next 16; webpack is asked for.
  const { MODES } = await loadLaunch();
  assert.deepEqual({ ...MODES }, {
    dev: ['dev'],
    'dev-webpack': ['dev', '--webpack'],
    build: ['build'],
    start: ['start'],
  });
  assert.equal(MODES.constructor, undefined, 'an inherited name is not a mode');
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

// -- nextLaunch.mjs: the decisions ------------------------------------------ //

test('describeNativeExit names 0xC0000005 in both spellings, other NTSTATUS codes generically, and nothing else', async () => {
  const { describeNativeExit } = await loadLaunch();

  for (const code of [UNSIGNED, SIGNED]) {
    assert.deepEqual(describeNativeExit(code), {
      status: UNSIGNED,
      hex: '0xC0000005',
      name: 'STATUS_ACCESS_VIOLATION',
      label: '0xC0000005 STATUS_ACCESS_VIOLATION',
    });
  }

  // A Rust abort ends as STACK_BUFFER_OVERRUN on Windows; Ctrl-C is named so
  // that it never reads as a crash.
  assert.equal(describeNativeExit(0xc0000409).label, '0xC0000409 STATUS_STACK_BUFFER_OVERRUN');
  assert.equal(describeNativeExit(-1073741510).name, 'STATUS_CONTROL_C_EXIT'); // 0xC000013A signed
  const unnamed = describeNativeExit(0xc0000017);
  assert.deepEqual(unnamed, {
    status: 0xc0000017,
    hex: '0xC0000017',
    name: null,
    label: '0xC0000017, a Windows NTSTATUS error',
  });

  // Ordinary exits, signals' 128+n, exit(-1)'s 0xFFFFFFFF, below the error
  // range, outside 32 bits, and anything that is not an integer.
  for (const code of [0, 1, 5, 130, 143, 255, -1, 0xffffffff, 0xbfffffff, -0x80000000, 2 ** 32 + 5, -(2 ** 31) - 1]) {
    assert.equal(describeNativeExit(code), null, `exit code ${code}`);
  }
  for (const code of [null, undefined, '3221225477', 3221225477.5, NaN, Infinity, {}]) {
    assert.equal(describeNativeExit(code), null, `exit code ${String(code)}`);
  }
});

test('nextArgs gives a server its host and port, and leaves both off next build', async () => {
  const { MODES, nextArgs } = await loadLaunch();
  assert.deepEqual(nextArgs(MODES.dev, ADDRESS), ['dev', '--hostname', '127.0.0.1', '--port', '3159']);
  assert.deepEqual(nextArgs(MODES['dev-webpack'], ADDRESS), [
    'dev', '--webpack', '--hostname', '127.0.0.1', '--port', '3159',
  ]);
  assert.deepEqual(nextArgs(MODES.start, ADDRESS), ['start', '--hostname', '127.0.0.1', '--port', '3159']);
  assert.deepEqual(nextArgs(MODES.build, ADDRESS), ['build']);
  assert.deepEqual(nextArgs(['build', '--webpack'], ADDRESS), ['build', '--webpack']);
});

const crash = (overrides = {}) => ({
  mode: 'dev',
  platform: 'win32',
  code: UNSIGNED,
  signal: null,
  alreadyFellBack: false,
  address: ADDRESS,
  ...overrides,
});

test('the fallback is Turbopack dev on Windows ending with 0xC0000005, once: build --webpack, then start where dev was', async () => {
  const { fallbackSteps } = await loadLaunch();
  const steps = [['build', '--webpack'], ['start', '--hostname', '127.0.0.1', '--port', '3159']];

  assert.deepEqual(fallbackSteps(crash()), steps);
  assert.deepEqual(fallbackSteps(crash({ code: SIGNED })), steps);
  // The address is the wrapper's, whatever it is.
  assert.deepEqual(fallbackSteps(crash({ address: { hostname: '0.0.0.0', port: '3000' } }))[1], [
    'start', '--hostname', '0.0.0.0', '--port', '3000',
  ]);

  // Not on another platform, even with the code (an exit code there is a byte anyway).
  for (const platform of ['linux', 'darwin', 'freebsd', undefined]) {
    assert.equal(fallbackSteps(crash({ platform })), null, `platform ${platform}`);
  }
  // Not in another mode: webpack's dev server, a build and a server are not the crash.
  for (const mode of ['dev-webpack', 'build', 'start', undefined]) {
    assert.equal(fallbackSteps(crash({ mode })), null, `mode ${mode}`);
  }
  // Once.
  assert.equal(fallbackSteps(crash({ alreadyFellBack: true })), null);
  // Not another ending: a clean exit, an error, Ctrl-C's own code, another native fault.
  for (const code of [0, 1, 130, 0xc000013a, 0xc0000409, -1, null]) {
    assert.equal(fallbackSteps(crash({ code })), null, `exit code ${code}`);
  }
  // A signal is never a reason to start anything.
  assert.equal(fallbackSteps(crash({ code: null, signal: 'SIGINT' })), null);
  assert.equal(fallbackSteps(crash({ signal: 'SIGTERM' })), null);
});

const start = (overrides = {}) => ({
  mode: 'dev',
  platform: 'win32',
  address: ADDRESS,
  fellBack: false,
  pending: [],
  ...overrides,
});

test('afterExit runs the fallback a step at a time, and ends as the last step ended', async () => {
  const { afterExit } = await loadLaunch();
  const dev = ['dev', '--hostname', '127.0.0.1', '--port', '3159'];
  const serve = ['start', '--hostname', '127.0.0.1', '--port', '3159'];

  // The crash: the build first, the server pending, and the crash named once.
  const first = afterExit(start(), { args: dev, code: UNSIGNED, signal: null });
  assert.deepEqual(first.run, ['build', '--webpack']);
  assert.deepEqual(first.state.pending, [serve]);
  assert.equal(first.state.fellBack, true);
  assert.equal(first.crash.label, '0xC0000005 STATUS_ACCESS_VIOLATION');

  // The build succeeded: the server, and nothing more to say.
  const second = afterExit(first.state, { args: first.run, code: 0, signal: null });
  assert.deepEqual(second.run, serve);
  assert.deepEqual(second.state.pending, []);
  assert.equal(second.crash, null);

  // The server ends, however it ends - even with the same crash: passed through.
  for (const ended of [{ code: 0, signal: null }, { code: UNSIGNED, signal: null }, { code: null, signal: 'SIGINT' }]) {
    assert.deepEqual(afterExit(second.state, { args: serve, ...ended }), { end: true, note: null });
  }

  // A build that failed ends the wrapper (with the build's code - next.mjs
  // passes `code` through), after one line saying the server was not started.
  const failed = afterExit(first.state, { args: first.run, code: 1, signal: null });
  assert.equal(failed.end, true);
  assert.match(failed.note, /^\[next\] The production-style build ended with exit code 1, so the server was not started\./);
  assert.match(failed.note, /npm run dev:live/);
  const nativeBuild = afterExit(first.state, { args: first.run, code: UNSIGNED, signal: null });
  assert.match(nativeBuild.note, /exit code 3221225477 \(0xC0000005 STATUS_ACCESS_VIOLATION\)/);
  assert.match(nativeBuild.note, /Windows ended the build natively too, so it printed nothing/);
  assert.doesNotMatch(failed.note, /natively/);
  assert.equal(nativeBuild.run, undefined, 'no second fallback');

  // Ctrl-C during the build: it ends, quietly, and the server never starts.
  assert.deepEqual(afterExit(first.state, { args: first.run, code: null, signal: 'SIGINT' }), {
    end: true,
    note: null,
  });
});

test('afterExit passes every other ending through untouched', async () => {
  const { afterExit } = await loadLaunch();
  const ends = [
    [start({ platform: 'linux' }), { args: ['dev'], code: UNSIGNED, signal: null }],
    [start({ platform: 'darwin' }), { args: ['dev'], code: 5, signal: null }],
    [start({ mode: 'dev-webpack' }), { args: ['dev', '--webpack'], code: UNSIGNED, signal: null }],
    [start({ mode: 'build' }), { args: ['build'], code: UNSIGNED, signal: null }],
    [start({ mode: 'start' }), { args: ['start'], code: UNSIGNED, signal: null }],
    [start(), { args: ['dev'], code: 0, signal: null }],
    [start(), { args: ['dev'], code: 1, signal: null }],
    [start(), { args: ['dev'], code: 0xc000013a, signal: null }],
    [start(), { args: ['dev'], code: null, signal: 'SIGINT' }],
    [start(), { args: ['dev'], code: null, signal: 'SIGTERM' }],
    // A build that is the wrapper's own mode says nothing extra when it fails.
    [start({ mode: 'build', platform: 'linux' }), { args: ['build'], code: 1, signal: null }],
  ];
  for (const [state, ended] of ends) {
    assert.deepEqual(afterExit(state, ended), { end: true, note: null }, JSON.stringify([state, ended]));
  }
});

test('the fallback explains itself once: the code, the issue, the Next, what runs now and what to run instead', async () => {
  const { describeNativeExit, fallbackExplanation } = await loadLaunch();
  const text = fallbackExplanation({
    code: UNSIGNED,
    crash: describeNativeExit(UNSIGNED),
    installed: '16.3.5',
    address: ADDRESS,
  });

  assert.match(text, /exit code 3221225477, 0xC0000005 STATUS_ACCESS_VIOLATION/);
  assert.match(text, /https:\/\/github\.com\/vercel\/next\.js\/issues\/95015/);
  assert.match(text, /Next\.js 16\.3\.5/);
  assert.match(text, /next build --webpack, then next start/);
  assert.match(text, /port 3159/);
  assert.match(text, /will NOT hot-reload/);
  assert.match(text, /npm run dev:live/);
  assert.match(text, /npm run dev --prefix frontend/);
  // Root commands: the fallback also fires under `cd frontend && npm run
  // dev:turbo`, where neither dev:backend nor --prefix frontend works.
  assert.match(text, /npm run dev again \(from the repository root\)/);
  assert.match(text, /To choose for yourself, from the repository root: npm run dev:live/);
  for (const line of text.split('\n').filter(Boolean)) {
    assert.match(line, /^\[next\] /, 'every line is the wrapper\'s, so concurrently prefixes it readably');
  }

  // An install whose version could not be read still explains itself.
  const unread = fallbackExplanation({ code: SIGNED, crash: describeNativeExit(SIGNED), installed: null, address: ADDRESS });
  assert.match(unread, /Native code in Next\.js touched/);
  assert.match(unread, /exit code -1073741819, 0xC0000005/);
});

test('installedVersionProblem names an exact pin the install does not match, and nothing else', async () => {
  const { installedVersionProblem } = await loadLaunch();

  assert.equal(
    installedVersionProblem('16.3.5', '16.3.8'),
    '[next] Next.js 16.3.5 is installed, but frontend/package.json pins 16.3.8. Run npm run install:all.'
  );
  // A machine whose Next is a whole minor release behind the pin.
  assert.equal(
    installedVersionProblem('16.1.6', '16.3.8'),
    '[next] Next.js 16.1.6 is installed, but frontend/package.json pins 16.3.8. Run npm run install:all.'
  );
  assert.match(installedVersionProblem('16.3.8', '16.3.0-canary.49'), /pins 16\.3\.0-canary\.49\./);
  assert.match(installedVersionProblem('16.3.7', '=16.3.8'), /pins 16\.3\.8\./);
  assert.match(installedVersionProblem('16.3.7', 'v16.3.8'), /pins 16\.3\.8\./);

  // Equal; a range, a tag, an alias, a path or a URL; missing or odd data.
  for (const [installed, pinned] of [
    ['16.3.8', '16.3.8'],
    [' 16.3.8 ', '16.3.8'],
    ['16.3.0-canary.49', '16.3.0-canary.49'],
    ['16.3.5', '^16.3.8'],
    ['16.3.5', '~16.3.8'],
    ['16.3.5', '>=16.3.3'],
    ['16.3.5', '16.3.x'],
    ['16.3.5', '16'],
    ['16.3.5', 'latest'],
    ['16.3.5', 'canary'],
    ['16.3.5', 'npm:next@16.3.8'],
    ['16.3.5', 'file:../next'],
    ['16.3.5', 'https://example.com/next.tgz'],
    ['16.3.5', ''],
    ['', '16.3.8'],
    [undefined, '16.3.8'],
    ['16.3.5', undefined],
    [null, null],
    [16.3, '16.3.8'],
    ['16.3.5', { version: '16.3.8' }],
  ]) {
    assert.equal(installedVersionProblem(installed, pinned), null, JSON.stringify([installed, pinned]));
  }
});

/*
 * The README tells the owner what the frontend prints - the line the Windows
 * log ended on, the explanation that now replaces it, and the drift warning -
 * so it must quote the launcher's own words, for the Next this release pins.
 * Whitespace is folded: the README wraps some quotes across lines.
 */
test('the README quotes the launcher in its own words, for the pinned Next', async () => {
  const { describeNativeExit, fallbackExplanation, installedVersionProblem, TURBOPACK_WINDOWS_CRASH } = await loadLaunch();
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');
  const pinnedNext = readJson('frontend/package.json').dependencies.next;

  assert.ok(readme.includes(`**Next.js ${pinnedNext}**`), `the Tech Stack names the pinned Next, ${pinnedNext}`);
  // The drift line it quotes: the owner's, a Next moved by hand.
  for (const installed of ['16.3.5']) {
    const warning = installedVersionProblem(installed, pinnedNext);
    // Checked first: String#includes(null) looks for the text "null", which
    // the README has, so a silenced warning would pass the search below.
    assert.equal(typeof warning, 'string', `${installed} against ${pinnedNext} is drift`);
    assert.ok(readme.includes(warning), `the README quotes "${warning}"`);
  }
  const firstLine = fallbackExplanation({
    code: UNSIGNED,
    crash: describeNativeExit(UNSIGNED),
    installed: pinnedNext,
    address: ADDRESS,
  })
    .split('\n')
    .find(Boolean);
  assert.ok(readme.includes(firstLine), `the Troubleshooting row quotes "${firstLine}"`);
  assert.ok(readme.includes(`npm run dev:turbo --prefix frontend exited with code ${UNSIGNED}`), 'and the line it replaces');
  assert.ok(readme.includes(TURBOPACK_WINDOWS_CRASH), 'and links the upstream issue');
});

/** Source without its comments, which name what the code must not do. */
const codeOf = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

test('nextLaunch.mjs has no side effects: nothing in it reaches a process, a file or the environment', () => {
  const source = codeOf(LAUNCH);
  assert.doesNotMatch(source, /^\s*import\s/m, 'it imports nothing');
  assert.doesNotMatch(source, /\brequire\(/);
  assert.doesNotMatch(source, /\bprocess\./);
  assert.doesNotMatch(source, /\bconsole\./);
});

// -- next.mjs: reads what they need and runs what they decide ---------------- //

test('next.mjs takes its decisions from nextLaunch.mjs and still launches Next under this Node', () => {
  const wrapper = fs.readFileSync(WRAPPER, 'utf8');

  const imported = /import \{([^}]*)\} from '\.\/nextLaunch\.mjs';/.exec(wrapper)?.[1] ?? '';
  for (const name of ['afterExit', 'fallbackExplanation', 'installedVersionProblem', 'MODES', 'nextArgs']) {
    assert.match(imported, new RegExp(`\\b${name}\\b`), `next.mjs imports ${name}`);
  }
  assert.doesNotMatch(wrapper, /const MODES = /, 'the modes live in nextLaunch.mjs only');

  // Next's JS entry point, under this Node, with no shell (DEP0190).
  assert.match(wrapper, /nextBin = require\.resolve\('next\/dist\/bin\/next'\);/);
  assert.match(wrapper, /spawn\(process\.execPath, \[nextBin, \.\.\.args\], \{ stdio: 'inherit' \}\)/);
  assert.doesNotMatch(codeOf(WRAPPER), /shell:\s*true/);
  // The installed version through the same require, so it is the Next that runs.
  assert.match(wrapper, /require\('next\/package\.json'\)\.version/);
  // The real platform decides; every step goes through afterExit.
  assert.match(wrapper, /platform: process\.platform/);
  assert.match(wrapper, /afterExit\(state, \{ args, code, signal \}\)/);
  assert.match(wrapper, /launch\(nextArgs\(baseArgs, address\)\);/);

  // The pass-through, as it was: a signal re-raised, else the child's code.
  assert.match(
    wrapper,
    /if \(signal\) \{[\s\S]*?process\.kill\(process\.pid, signal\);\s*return;\s*\} catch \{\s*process\.exit\(1\);\s*\}\s*\}\s*process\.exit\(code \?\? 0\);/
  );
  // No handler of its own: Ctrl-C ends the wrapper with Next, so a fallback
  // step never starts after one.
  assert.doesNotMatch(wrapper, /process\.on\('SIG/);
});

// -- a copy of next.mjs, run beside a stand-in Next -------------------------- //

/*
 * The stand-in: records each command line it is given, one JSON array per
 * line, says so on stderr, and ends as FAKE_NEXT_PLAN says for that command -
 * a number is an exit code, a string a signal it sends itself.
 */
const FAKE_NEXT = `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_NEXT_LOG, JSON.stringify(args) + '\\n');
process.stderr.write('fake next: ' + args.join(' ') + '\\n');
const key = args[0] + (args.includes('--webpack') ? ' --webpack' : '');
const outcome = JSON.parse(process.env.FAKE_NEXT_PLAN || '{}')[key] ?? 0;
if (typeof outcome === 'string') {
  process.kill(process.pid, outcome);
  setTimeout(() => {}, 5000);
} else {
  process.exit(outcome);
}
`;

/*
 * The two lines the fallback's run injects into its copy: Windows, and the
 * stand-in's exit code 5 read as 0xC0000005, as Windows would report it. Each
 * anchor must be in next.mjs exactly once, so a reshaped wrapper fails here
 * rather than running uninjected.
 */
const AS_WINDOWS = [
  ['platform: process.platform', "platform: 'win32'"],
  [
    "child.on('exit', (code, signal) => {",
    "child.on('exit', (code, signal) => {\n    if (code === 5) code = 3221225477;",
  ],
];
function injectWindows(source) {
  let out = source;
  for (const [anchor, replacement] of AS_WINDOWS) {
    assert.equal(out.split(anchor).length, 2, `next.mjs has \`${anchor}\` exactly once`);
    out = out.replace(anchor, replacement);
  }
  return out;
}

function runWrapper(mode, { installed = '16.3.8', pinned = '16.3.8', plan = {}, windows = false, nextPackage } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'next-wrapper-'));
  const scripts = path.join(root, 'frontend', 'scripts');
  const nextDir = path.join(root, 'frontend', 'node_modules', 'next');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(path.join(nextDir, 'dist', 'bin'), { recursive: true });

  const wrapper = fs.readFileSync(WRAPPER, 'utf8');
  fs.writeFileSync(path.join(scripts, 'next.mjs'), windows ? injectWindows(wrapper) : wrapper);
  fs.copyFileSync(LAUNCH, path.join(scripts, 'nextLaunch.mjs'));
  fs.writeFileSync(path.join(root, 'frontend', 'package.json'), JSON.stringify({ dependencies: { next: pinned } }));
  fs.writeFileSync(
    path.join(nextDir, 'package.json'),
    nextPackage ?? JSON.stringify({ name: 'next', version: installed })
  );
  fs.writeFileSync(path.join(nextDir, 'dist', 'bin', 'next'), FAKE_NEXT);

  const log = path.join(root, 'next-calls.jsonl');
  const env = { ...process.env, FRONTEND_HOST: '127.0.0.1', FRONTEND_PORT: '3159', FAKE_NEXT_LOG: log };
  env.FAKE_NEXT_PLAN = JSON.stringify(plan);
  const result = spawnSync(process.execPath, [path.join(scripts, 'next.mjs'), mode], {
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  const calls = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  fs.rmSync(root, { recursive: true, force: true });
  return { status: result.status, signal: result.signal, stderr: result.stderr, calls };
}

const HOST_PORT = ['--hostname', '127.0.0.1', '--port', '3159'];
const ISSUE = 'https://github.com/vercel/next.js/issues/95015';

test('the real wrapper runs each mode once, with its arguments, and ends with Next\'s own code', () => {
  assert.deepEqual(runWrapper('build').calls, [['build']]);
  assert.deepEqual(runWrapper('dev-webpack').calls, [['dev', '--webpack', ...HOST_PORT]]);

  const start = runWrapper('start', { plan: { start: 3 } });
  assert.deepEqual(start.calls, [['start', ...HOST_PORT]]);
  assert.equal(start.status, 3);

  // On this platform a dev server that dies is passed through, never replaced.
  const dev = runWrapper('dev', { plan: { dev: 5 } });
  assert.deepEqual(dev.calls, [['dev', ...HOST_PORT]]);
  assert.equal(dev.status, 5);
  assert.ok(!dev.stderr.includes(ISSUE), dev.stderr);
});

test('the real wrapper re-raises the signal that ended Next', { skip: process.platform === 'win32' && 'POSIX signals' }, () => {
  const dev = runWrapper('dev', { plan: { dev: 'SIGTERM' } });
  assert.deepEqual(dev.calls, [['dev', ...HOST_PORT]]);
  assert.equal(dev.signal, 'SIGTERM');
});

test('the real wrapper warns before launching when the installed Next is not the pinned one', () => {
  const drift = runWrapper('build', { installed: '16.3.5', pinned: '16.3.8' });
  const line = '[next] Next.js 16.3.5 is installed, but frontend/package.json pins 16.3.8. Run npm run install:all.';
  assert.ok(drift.stderr.includes(line), drift.stderr);
  assert.ok(drift.stderr.indexOf(line) < drift.stderr.indexOf('fake next: build'), 'before Next starts');
  assert.equal(drift.status, 0, 'a warning, never a refusal');

  for (const options of [
    { installed: '16.3.8', pinned: '16.3.8' },
    { installed: '16.3.5', pinned: '^16.3.8' },
    { installed: '16.3.5', pinned: 'latest' },
    { nextPackage: JSON.stringify({ name: 'next' }) },
  ]) {
    const quiet = runWrapper('build', options);
    assert.doesNotMatch(quiet.stderr, /is installed, but/, JSON.stringify(options));
    assert.deepEqual(quiet.calls, [['build']], 'and it still launches');
  }

  // A package.json Node cannot parse stops Node's own resolution of Next
  // before the version is ever read: the wrapper's one line, never a stack.
  const broken = runWrapper('build', { nextPackage: '{ not json' });
  assert.equal(broken.status, 1);
  assert.equal(broken.stderr.trim(), 'Could not find next. Run `npm install` in the frontend directory first.');
  assert.deepEqual(broken.calls, []);
});

test('as Windows: a Turbopack crash is explained once, then build --webpack and start run where dev was', () => {
  // The owner's state: 16.3.5 installed, 16.3.8 pinned. The explanation names
  // the Next that crashed - the installed one, never the pin.
  const run = runWrapper('dev', { windows: true, installed: '16.3.5', pinned: '16.3.8', plan: { dev: 5 } });
  assert.deepEqual(run.calls, [['dev', ...HOST_PORT], ['build', '--webpack'], ['start', ...HOST_PORT]]);
  assert.equal(run.status, 0, 'the server\'s own ending');
  assert.equal(run.stderr.split(ISSUE).length, 2, 'one explanation');
  assert.match(run.stderr, /exit code 3221225477, 0xC0000005 STATUS_ACCESS_VIOLATION/);
  assert.match(run.stderr, /Native code in Next\.js 16\.3\.5 touched/);
  assert.doesNotMatch(run.stderr, /Next\.js 16\.3\.8 touched/, 'the installed Next, not the pinned one');
  assert.ok(
    run.stderr.includes('[next] Next.js 16.3.5 is installed, but frontend/package.json pins 16.3.8.'),
    'and the drift line'
  );
  assert.ok(
    run.stderr.indexOf(ISSUE) < run.stderr.indexOf('fake next: build --webpack'),
    'explained before the build starts'
  );
});

test('as Windows: a failed build ends the wrapper with its code, and the server is not started', () => {
  const run = runWrapper('dev', { windows: true, plan: { dev: 5, 'build --webpack': 7 } });
  assert.deepEqual(run.calls, [['dev', ...HOST_PORT], ['build', '--webpack']]);
  assert.equal(run.status, 7);
  assert.match(run.stderr, /The production-style build ended with exit code 7, so the server was not started\./);
});

test('as Windows: the server crashing too is passed through, never a second fallback', () => {
  const run = runWrapper('dev', { windows: true, plan: { dev: 5, start: 5 } });
  assert.deepEqual(run.calls, [['dev', ...HOST_PORT], ['build', '--webpack'], ['start', ...HOST_PORT]]);
  assert.notEqual(run.status, 0);
  assert.equal(run.stderr.split(ISSUE).length, 2, 'still one explanation');
});

test('as Windows: a signal during the build stops the fallback; nothing else starts', { skip: process.platform === 'win32' && 'POSIX signals' }, () => {
  const run = runWrapper('dev', { windows: true, plan: { dev: 5, 'build --webpack': 'SIGINT' } });
  assert.deepEqual(run.calls, [['dev', ...HOST_PORT], ['build', '--webpack']]);
  assert.equal(run.signal, 'SIGINT');
});

test('as Windows: only dev falls back, and only on that code', () => {
  for (const mode of ['dev-webpack', 'build', 'start']) {
    const key = mode === 'dev-webpack' ? 'dev --webpack' : mode;
    const run = runWrapper(mode, { windows: true, plan: { [key]: 5 } });
    assert.equal(run.calls.length, 1, `${mode} is not replaced`);
  }
  const other = runWrapper('dev', { windows: true, plan: { dev: 1 } });
  assert.deepEqual(other.calls, [['dev', ...HOST_PORT]]);
  assert.equal(other.status, 1);
});
