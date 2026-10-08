const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

/**
 * The check the root `npm run dev` (and `dev:live`, `dev:poll`) runs first,
 * from npm's `pre` hooks: scripts/checkInstall.mjs, deciding through
 * scripts/installCheck.mjs.
 *
 * The owner's Windows `npm run dev` ended on cmd's "'concurrently' is not
 * recognized as an internal or external command, operable program or batch
 * file." - the root's own node_modules was gone, and nothing said so. Now the
 * hook names what is missing and says to run `npm run install:all` from the
 * repository root, and `install:all` passes --include=dev, so an npm that
 * leaves devDependencies out (NODE_ENV=production, omit=dev) cannot strip
 * concurrently, ts-node-dev, typescript or tailwindcss again.
 *
 * installCheck.mjs is imported and run on fake trees - posix and win32
 * paths alike, as the platform notes in CLAUDE.md ask. checkInstall.mjs is
 * run for real: against this checkout, and against a temporary tree holding
 * copies of the three package.json files. npm's own part - that it runs
 * `predev:live` before `dev:live` and stops when the hook fails - is run
 * through the npm that is running this suite, when there is one.
 */

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const CHECK = path.join(SCRIPTS, 'installCheck.mjs');
const RUNNER = path.join(SCRIPTS, 'checkInstall.mjs');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const loadCheck = () => import(pathToFileURL(CHECK).href);

/*
 * The two tests of this checkout's own install, skipped - saying why - where
 * the root's or the frontend's node_modules was never made: a backend-only
 * install (`npm ci --prefix backend`, then `npm run test --prefix backend`)
 * runs this suite too, and nothing else in it needs either. One that is there
 * but short of a package still fails them, which is what they are for. The
 * backend's own is not asked about: without it this suite does not run.
 */
const CHECKOUT_NOT_INSTALLED = (() => {
  const absent = [
    ['', 'the repository root'],
    ['frontend', 'frontend'],
  ].filter(([dir]) => !fs.existsSync(path.join(ROOT, dir, 'node_modules')));
  return (
    absent.length > 0 &&
    `no node_modules in ${absent.map(([, label]) => label).join(' or ')} here; npm run install:all installs them`
  );
})();

const OWNER_ROOT = 'F:\\Develop\\free_tailor';
const CMD_SENTENCE =
  "'concurrently' is not recognized as an internal or external command, operable program or batch file.";

/*
 * A fake tree: `files` maps a path to its text. `exists` and `read` answer
 * from it, and remember what they were asked.
 */
function fakeFs(files, { join = path.posix.join } = {}) {
  const asked = [];
  return {
    asked,
    join,
    exists: (file) => {
      asked.push(file);
      return Object.prototype.hasOwnProperty.call(files, file);
    },
    read: (file) => {
      if (!Object.prototype.hasOwnProperty.call(files, file)) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT' });
      }
      const value = files[file];
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

const manifest = (dependencies = {}, devDependencies = {}) => JSON.stringify({ dependencies, devDependencies });
const installed = (dir, name, join = path.posix.join) => ({
  [join(dir, 'node_modules', ...name.split('/'), 'package.json')]: '{}',
});

/* The repository as package.json files would have it, every package installed. */
function completeTree(root = '/repo', join = path.posix.join) {
  return {
    [join(root, 'package.json')]: manifest({}, { concurrently: '^10.0.3' }),
    [join(root, 'backend', 'package.json')]: manifest({ express: '^4' }, { typescript: '^5', 'ts-node-dev': '^2' }),
    [join(root, 'frontend', 'package.json')]: manifest(
      { next: '16.3.8', '@stripe/stripe-js': '^9' },
      { tailwindcss: '^4', '@types/node': '^20' }
    ),
    ...installed(root, 'concurrently', join),
    ...installed(join(root, 'backend'), 'express', join),
    ...installed(join(root, 'backend'), 'typescript', join),
    ...installed(join(root, 'backend'), 'ts-node-dev', join),
    ...installed(join(root, 'frontend'), 'next', join),
    ...installed(join(root, 'frontend'), '@stripe/stripe-js', join),
    ...installed(join(root, 'frontend'), 'tailwindcss', join),
    ...installed(join(root, 'frontend'), '@types/node', join),
  };
}

function without(tree, ...files) {
  const out = { ...tree };
  for (const file of files) delete out[file];
  return out;
}

// -- missingPackages --------------------------------------------------------- //

test('missingPackages: a complete tree has nothing missing', async () => {
  const { missingPackages } = await loadCheck();
  assert.deepEqual(missingPackages({ root: '/repo', ...fakeFs(completeTree()) }), []);
});

test("missingPackages: the owner's state - the root's concurrently gone, backend and frontend installed", async () => {
  const { missingPackages } = await loadCheck();
  const tree = without(completeTree(), '/repo/node_modules/concurrently/package.json');
  assert.deepEqual(missingPackages({ root: '/repo', ...fakeFs(tree) }), [
    {
      id: 'root',
      label: 'the repository root',
      dir: '/repo',
      manifest: '/repo/package.json',
      missing: [{ name: 'concurrently', dev: true }],
      unreadable: null,
    },
  ]);
});

test('missingPackages: dependencies and devDependencies of the backend and the frontend are both checked', async () => {
  const { missingPackages } = await loadCheck();
  // What an npm that leaves devDependencies out removes, plus one runtime package.
  const tree = without(
    completeTree(),
    '/repo/backend/node_modules/express/package.json',
    '/repo/backend/node_modules/typescript/package.json',
    '/repo/backend/node_modules/ts-node-dev/package.json',
    '/repo/frontend/node_modules/tailwindcss/package.json'
  );
  const problems = missingPackages({ root: '/repo', ...fakeFs(tree) });
  assert.deepEqual(
    problems.map((p) => [p.id, p.missing]),
    [
      ['backend', [{ name: 'express', dev: false }, { name: 'typescript', dev: true }, { name: 'ts-node-dev', dev: true }]],
      ['frontend', [{ name: 'tailwindcss', dev: true }]],
    ]
  );
});

test('missingPackages: a scoped package is looked for at node_modules/@scope/name, on posix and win32 paths', async () => {
  const { missingPackages } = await loadCheck();

  const posix = fakeFs(completeTree());
  missingPackages({ root: '/repo', ...posix });
  assert.ok(posix.asked.includes('/repo/frontend/node_modules/@stripe/stripe-js/package.json'));
  assert.ok(posix.asked.includes('/repo/frontend/node_modules/@types/node/package.json'));

  // Installed under the wrong folder is not installed.
  const misplaced = without(completeTree(), '/repo/frontend/node_modules/@stripe/stripe-js/package.json');
  misplaced['/repo/frontend/node_modules/stripe-js/package.json'] = '{}';
  assert.deepEqual(
    missingPackages({ root: '/repo', ...fakeFs(misplaced) }).map((p) => p.missing),
    [[{ name: '@stripe/stripe-js', dev: false }]]
  );

  // The owner's machine: the same decisions on Windows paths.
  const join = path.win32.join;
  const win = completeTree(OWNER_ROOT, join);
  const winFs = fakeFs(win, { join });
  assert.deepEqual(missingPackages({ root: OWNER_ROOT, ...winFs }), []);
  assert.ok(winFs.asked.includes('F:\\Develop\\free_tailor\\frontend\\node_modules\\@stripe\\stripe-js\\package.json'));
  const winProblems = missingPackages({
    root: OWNER_ROOT,
    ...fakeFs(without(win, 'F:\\Develop\\free_tailor\\node_modules\\concurrently\\package.json'), { join }),
  });
  assert.equal(winProblems.length, 1);
  assert.equal(winProblems[0].manifest, 'F:\\Develop\\free_tailor\\package.json');
  assert.deepEqual(winProblems[0].missing, [{ name: 'concurrently', dev: true }]);
});

test('missingPackages: a package.json that cannot be read is reported, never thrown, and the others are still checked', async () => {
  const { missingPackages } = await loadCheck();
  const base = without(completeTree(), '/repo/node_modules/concurrently/package.json');

  const cases = [
    [without(base, '/repo/backend/package.json'), 'could not be found'],
    [{ ...base, '/repo/backend/package.json': Object.assign(new Error('EACCES'), { code: 'EACCES' }) }, 'could not be read (EACCES)'],
    [{ ...base, '/repo/backend/package.json': '{ "dependencies": ' }, 'is not valid JSON'],
    [{ ...base, '/repo/backend/package.json': new Error('no code') }, 'could not be read'],
  ];
  for (const [tree, reason] of cases) {
    const problems = missingPackages({ root: '/repo', ...fakeFs(tree) });
    assert.deepEqual(
      problems.map((p) => [p.id, p.unreadable, p.missing.map((m) => m.name)]),
      [
        ['root', null, ['concurrently']],
        ['backend', reason, []],
      ],
      reason
    );
  }

  // A read that throws something that is not an Error, and an exists that throws.
  const odd = {
    ...fakeFs(base),
    read: (file) => {
      if (file === '/repo/frontend/package.json') throw 'a string';
      return base[file];
    },
    exists: (file) => {
      if (file.includes('express')) throw new Error('EIO');
      return Object.prototype.hasOwnProperty.call(base, file);
    },
  };
  assert.deepEqual(
    missingPackages({ root: '/repo', ...odd }).map((p) => [p.id, p.unreadable, p.missing.map((m) => m.name)]),
    [
      ['root', null, ['concurrently']],
      ['backend', null, ['express']],
      ['frontend', 'could not be read', []],
    ]
  );
});

test('missingPackages: reads past a BOM, ignores fields that are not lists of names, and names nobody twice', async () => {
  const { missingPackages } = await loadCheck();
  const tree = {
    ...completeTree(),
    // What some Windows editors save.
    '/repo/package.json': '\uFEFF' + manifest({}, { concurrently: '^10.0.3' }),
    '/repo/backend/package.json': JSON.stringify({
      dependencies: { express: '^4', typescript: '^5' },
      devDependencies: { typescript: '^5' },
      optionalDependencies: { fsevents: '*' },
      peerDependencies: { react: '*' },
    }),
    '/repo/frontend/package.json': JSON.stringify({ dependencies: ['next'], devDependencies: 'tailwindcss' }),
  };
  const fsys = fakeFs(without(tree, '/repo/backend/node_modules/typescript/package.json'));
  assert.deepEqual(
    missingPackages({ root: '/repo', ...fsys }).map((p) => [p.id, p.missing]),
    [['backend', [{ name: 'typescript', dev: false }]]]
  );
  assert.ok(!fsys.asked.some((file) => /fsevents|react/.test(file)), 'optional and peer dependencies are not checked');

  for (const text of ['null', '42', '"text"', '[]', '{}']) {
    const problems = missingPackages({ root: '/repo', ...fakeFs({ ...completeTree(), '/repo/package.json': text }) });
    assert.deepEqual(problems, [], `a root package.json of ${text}`);
  }
});

test('missingPackages: a key that is not a package name is never turned into a path', async () => {
  const { missingPackages } = await loadCheck();
  const tree = {
    ...completeTree(),
    '/repo/package.json': manifest({}, {
      concurrently: '^10.0.3',
      '../escape': '*',
      '.hidden': '*',
      'a/b': '*',
      '@scope': '*',
      '@scope/../x': '*',
      'back\\slash': '*',
      '': '*',
    }),
  };
  const fsys = fakeFs(tree);
  assert.deepEqual(missingPackages({ root: '/repo', ...fsys }), []);
  assert.deepEqual(
    fsys.asked.filter((file) => file.startsWith('/repo/node_modules/')),
    ['/repo/node_modules/concurrently/package.json']
  );
});

test('missingPackages, on this checkout: nothing is missing (npm run install:all)', { skip: CHECKOUT_NOT_INSTALLED }, async () => {
  const { missingPackages } = await loadCheck();
  const problems = missingPackages({
    root: ROOT,
    join: path.join,
    exists: fs.existsSync,
    read: (file) => fs.readFileSync(file, 'utf8'),
  });
  assert.deepEqual(problems, [], JSON.stringify(problems));
});

// -- what npm hands a script ------------------------------------------------ //

test('npmSettingsFrom reads NODE_ENV and the npm settings a script sees, in either case', async () => {
  const { npmSettingsFrom } = await loadCheck();
  assert.deepEqual(npmSettingsFrom({}), { nodeEnv: undefined, omit: undefined, include: undefined, production: undefined });
  assert.deepEqual(npmSettingsFrom(undefined), { nodeEnv: undefined, omit: undefined, include: undefined, production: undefined });
  assert.deepEqual(
    npmSettingsFrom({ NODE_ENV: 'production', npm_config_omit: 'dev\n\noptional', npm_config_include: '', npm_config_production: 'true' }),
    { nodeEnv: 'production', omit: 'dev\n\noptional', include: '', production: 'true' }
  );
  // npm reads npm_config_* in any case, and hands a hand-set NPM_CONFIG_OMIT on as it was spelled.
  assert.equal(npmSettingsFrom({ NPM_CONFIG_OMIT: 'dev' }).omit, 'dev');
  assert.equal(npmSettingsFrom({ Npm_Config_Include: 'dev' }).include, 'dev');
  assert.equal(npmSettingsFrom({ npm_config_omit: 'dev', NPM_CONFIG_OMIT: 'optional' }).omit, 'dev');
});

/*
 * Each row was measured with npm 10.9.4 on a project with one devDependency:
 * what the environment and settings were, what a script then saw (npm sets
 * NODE_ENV=production itself while it omits dev), and whether `npm install`
 * then installed the devDependency. npm passes a setting on only when it
 * differs from its default, and a deprecated one never, so some settings look
 * alike from here - the rows say which - and the check is a hint that points
 * to `npm config get omit`, which agreed with the install on every row.
 */
test('devDependenciesOmitted answers as npm 10 installs, as far as a script can see', async () => {
  const { devDependenciesOmitted } = await loadCheck();
  const rows = [
    // [what the script sees, what the check says]       // measured: devDependency installed?
    [{}, null], // yes
    // NODE_ENV=production: no. So it looks with an .npmrc omit=dev or --omit=dev besides (no: an omit=dev
    // is the default under NODE_ENV=production, so it is not passed on), with an .npmrc production=true and
    // no NODE_ENV (no), and with NODE_ENV=production and a deprecated .npmrc production=false, dev=true or
    // also=dev (yes - the hint's false alarm, which npm config get omit answers).
    [{ nodeEnv: 'production' }, 'node-env'],
    // npm_config_omit=dev, or --omit=dev or an .npmrc omit=dev with NODE_ENV not set beforehand: no
    [{ nodeEnv: 'production', omit: 'dev' }, 'omit'],
    [{ nodeEnv: 'production', omit: 'dev\n\noptional' }, 'omit'], // --omit=dev --omit=optional: no
    [{ omit: 'optional dev' }, null], // npm_config_omit="optional dev": yes, npm splits on a blank line only
    [{ omit: 'optional,dev' }, null], // yes
    // NODE_ENV=production with --omit= or an .npmrc omit= : yes. So it looks with an exported empty
    // npm_config_omit, which npm ignores (no) - the hint's one silence, out of a script's sight.
    [{ nodeEnv: 'production', omit: '' }, null],
    [{ omit: 'dev', include: 'dev' }, null], // .npmrc omit=dev and include=dev: yes (and NODE_ENV is left alone)
    [{ nodeEnv: 'production', include: 'dev' }, null], // NODE_ENV=production --include=dev: yes
    [{ nodeEnv: 'production', omit: 'dev', include: 'dev' }, null], // --omit=dev --include=dev: yes
    [{ nodeEnv: 'production', production: 'true' }, 'production'], // npm_config_production=true: no
    [{ nodeEnv: 'production', production: 'false' }, null], // npm_config_production=false NODE_ENV=production: yes
    [{ production: '' }, null], // npm_config_production= : yes
    [{ nodeEnv: 'development' }, null],
  ];
  for (const [seen, expected] of rows) {
    assert.equal(devDependenciesOmitted(seen), expected, JSON.stringify(seen));
  }
  assert.equal(devDependenciesOmitted(), null);
});

test('scriptBefore names the guarded script a pre hook runs before, and nothing else', async () => {
  const { scriptBefore, GUARDED_SCRIPTS } = await loadCheck();
  assert.deepEqual([...GUARDED_SCRIPTS], ['dev', 'dev:live', 'dev:poll']);
  assert.equal(scriptBefore('predev'), 'dev');
  assert.equal(scriptBefore('predev:live'), 'dev:live');
  assert.equal(scriptBefore('predev:poll'), 'dev:poll');
  for (const event of ['dev', 'pre', 'prepare', 'predev:backend', 'pretest', '', undefined, null, 7]) {
    assert.equal(scriptBefore(event), undefined, String(event));
  }
});

// -- installAdvice ------------------------------------------------------------ //

const ROOT_ONLY = [
  {
    id: 'root',
    label: 'the repository root',
    dir: OWNER_ROOT,
    manifest: `${OWNER_ROOT}\\package.json`,
    missing: [{ name: 'concurrently', dev: true }],
    unreadable: null,
  },
];

/* What the owner's `npm run dev` prints now, in place of cmd's sentence. */
const OWNER_ADVICE = [
  '[install] npm run dev cannot start: packages this repository needs are not installed.',
  '[install]   In the repository root: concurrently',
  '[install] Run npm run install:all from the repository root, F:\\Develop\\free_tailor, then npm run dev again.',
].join('\n');

test("installAdvice: the owner's case, word for word", async () => {
  const { installAdvice } = await loadCheck();
  assert.equal(installAdvice({ root: OWNER_ROOT, missing: ROOT_ONLY, script: 'dev' }), OWNER_ADVICE);
  assert.equal(installAdvice({ root: OWNER_ROOT, missing: [], script: 'dev' }), null, 'nothing missing, nothing said');
  assert.equal(installAdvice({ root: OWNER_ROOT, missing: undefined }), null);

  // Run by hand, there is no script to name.
  assert.equal(
    installAdvice({ root: OWNER_ROOT, missing: ROOT_ONLY }),
    [
      '[install] Packages this repository needs are not installed.',
      '[install]   In the repository root: concurrently',
      '[install] Run npm run install:all from the repository root, F:\\Develop\\free_tailor.',
    ].join('\n')
  );
});

test('installAdvice: names per package, at most five each, then how many more', async () => {
  const { installAdvice } = await loadCheck();
  const names = (list, dev = true) => list.map((name) => ({ name, dev }));
  const missing = [
    ...ROOT_ONLY,
    { id: 'backend', label: 'backend', missing: names(['a', 'b', 'c', 'd', 'e']), unreadable: null },
    { id: 'frontend', label: 'frontend', missing: names(['f', 'g', 'h', 'i', 'j', 'k', 'l', 'm']), unreadable: null },
  ];
  const lines = installAdvice({ root: '/repo', missing, script: 'dev:live' }).split('\n');
  assert.deepEqual(lines, [
    '[install] npm run dev:live cannot start: packages this repository needs are not installed.',
    '[install]   In the repository root: concurrently',
    '[install]   In backend: a, b, c, d, e',
    '[install]   In frontend: f, g, h, i, j, and 3 more',
    '[install] Run npm run install:all from the repository root, /repo, then npm run dev:live again.',
  ]);
  assert.match(installAdvice({ root: '/repo', missing, limit: 2 }), /In backend: a, b, and 3 more/);
});

test('installAdvice: says npm looks set to leave devDependencies out only when its settings say so, and a missing package is one', async () => {
  const { installAdvice } = await loadCheck();
  const advise = (settings, missing = ROOT_ONLY) => installAdvice({ root: OWNER_ROOT, missing, script: 'dev', ...settings });
  const OMIT = /npm looks set to leave devDependencies out/;

  for (const settings of [{}, { nodeEnv: 'development' }, { nodeEnv: 'production', include: 'dev' }, { omit: '' , nodeEnv: 'production' }]) {
    assert.equal(advise(settings), OWNER_ADVICE, JSON.stringify(settings));
  }

  const nodeEnv = advise({ nodeEnv: 'production' });
  assert.ok(nodeEnv.startsWith(`${OWNER_ADVICE}\n`), 'added after the remedy');
  assert.equal(
    nodeEnv.slice(OWNER_ADVICE.length + 1),
    // A hint, not a verdict: NODE_ENV may be hiding an omit=dev (or an .npmrc's production=false may be
    // overruling it), neither of which reaches a script, so it names both ways and npm's own answer.
    '[install] npm looks set to leave devDependencies out of installs here: NODE_ENV is production (in the ' +
      'environment, or set by npm for an omit=dev or production=true in its configuration, or both), and ' +
      'every package missing above is one. npm config get omit says what npm will do: dev in its answer ' +
      'means it leaves them out. npm run install:all passes --include=dev, which installs them whatever ' +
      'those settings say; while they say so, a plain npm install here removes them again.'
  );
  assert.match(advise({ nodeEnv: 'production', omit: 'dev' }), /out of installs here: its omit setting includes dev, and/);
  assert.match(advise({ production: 'true' }), /out of installs here: npm_config_production=true is set in the environment, and/);
  for (const settings of [{ nodeEnv: 'production', omit: 'dev' }, { production: 'true' }]) {
    assert.match(advise(settings), / npm config get omit says what npm will do: /, JSON.stringify(settings));
  }

  // Some missing packages are runtime ones: it says "some".
  const mixed = [
    ...ROOT_ONLY,
    { id: 'backend', label: 'backend', missing: [{ name: 'express', dev: false }], unreadable: null },
  ];
  assert.match(installAdvice({ root: '/repo', missing: mixed, nodeEnv: 'production' }), /and some of the packages missing above are\./);

  // Only runtime packages missing: leaving devDependencies out cannot be why.
  const runtimeOnly = [{ id: 'backend', label: 'backend', missing: [{ name: 'express', dev: false }], unreadable: null }];
  assert.doesNotMatch(installAdvice({ root: '/repo', missing: runtimeOnly, nodeEnv: 'production', omit: 'dev' }), OMIT);
});

test('installAdvice: a package.json that cannot be read is named, with where to look', async () => {
  const { installAdvice } = await loadCheck();
  const missing = [
    ...ROOT_ONLY,
    {
      id: 'backend',
      label: 'backend',
      manifest: `${OWNER_ROOT}\\backend\\package.json`,
      missing: [],
      unreadable: 'could not be found',
    },
  ];
  const lines = installAdvice({ root: OWNER_ROOT, missing, script: 'dev' }).split('\n');
  assert.equal(lines[2], '[install]   In backend: its package.json could not be found (F:\\Develop\\free_tailor\\backend\\package.json).');
  assert.match(lines.at(-1), /^\[install\] A package\.json comes with the checkout, not with an install: git status/);
});

// -- the root package.json ---------------------------------------------------- //

test('the root package.json: every script that starts concurrently runs the check first, and those scripts are as they were', async () => {
  const { GUARDED_SCRIPTS } = await loadCheck();
  const pkg = readJson('package.json');
  const scripts = pkg.scripts;

  const concurrent = Object.keys(scripts).filter((name) => /^concurrently\b/.test(scripts[name]));
  assert.deepEqual(concurrent, [...GUARDED_SCRIPTS], 'the scripts that run concurrently are the guarded ones');
  for (const name of GUARDED_SCRIPTS) {
    assert.equal(scripts[`pre${name}`], 'node scripts/checkInstall.mjs', `pre${name}`);
  }

  // Unchanged: the check stands in front of them, never inside them.
  const both = 'concurrently --names backend,frontend --prefix-colors cyan,magenta';
  assert.equal(scripts.dev, `${both} "npm run dev --prefix backend" "npm run dev:turbo --prefix frontend"`);
  assert.equal(scripts['dev:live'], `${both} "npm run dev --prefix backend" "npm run dev:live --prefix frontend"`);
  assert.equal(scripts['dev:poll'], `${both} "npm run dev:poll --prefix backend" "npm run dev --prefix frontend"`);

  // The root's own package, which the check looks for first.
  assert.deepEqual(Object.keys(pkg.devDependencies), ['concurrently']);
  assert.equal(pkg.dependencies, undefined);
});

test('the root package.json: install:all installs devDependencies in all three, whatever npm is set to omit', () => {
  const steps = readJson('package.json').scripts['install:all'].split('&&').map((step) => step.trim());
  assert.deepEqual(steps, [
    'npm install --include=dev',
    'npm install --include=dev --prefix backend',
    'npm install --include=dev --prefix frontend',
  ]);
});

// -- the docs ---------------------------------------------------------------- //

/*
 * The Troubleshooting row quotes what the owner saw and what the check now
 * prints in its place, in the check's own words. Whitespace is folded: the
 * README wraps.
 */
test('the README quotes cmd, sh and the check in their own words', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(readme.includes(CMD_SENTENCE), 'the line the owner saw');
  assert.ok(readme.includes('sh: 1: concurrently: not found'), "Ubuntu's sh");
  for (const line of OWNER_ADVICE.split('\n')) {
    assert.ok(readme.includes(line.replace(/\s+/g, ' ')), `the README quotes "${line}"`);
  }
  assert.ok(readme.includes('npm install --include=dev --prefix backend'), 'and what install:all runs');
});

// -- the modules themselves --------------------------------------------------- //

/** Source without its comments, which name what the code must not do. */
const codeOf = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

test('installCheck.mjs has no side effects and imports nothing', () => {
  const source = codeOf(CHECK);
  assert.doesNotMatch(source, /^\s*import\s/m, 'it imports nothing');
  assert.doesNotMatch(source, /\bimport\(/);
  assert.doesNotMatch(source, /\brequire\(/);
  assert.doesNotMatch(source, /\bprocess\./);
  assert.doesNotMatch(source, /\bconsole\./);
});

test("checkInstall.mjs needs nothing installed, takes every decision from installCheck.mjs, and lets a console write finish", () => {
  const source = codeOf(RUNNER);
  const imports = [...source.matchAll(/^\s*import\s[^;]*from\s+'([^']+)'/gm)].map((match) => match[1]);
  assert.deepEqual(imports.sort(), ['node:fs', 'node:path', 'node:url']);
  // installCheck.mjs is loaded inside the try, so even a fault in it cannot throw out of the hook.
  assert.match(source, /try \{\s*const \{[^}]*\} = await import\('\.\/installCheck\.mjs'\);/);
  for (const name of ['installAdvice', 'missingPackages', 'npmSettingsFrom', 'scriptBefore']) {
    assert.match(source, new RegExp(`\\b${name}\\(`), `checkInstall.mjs calls ${name}`);
  }
  assert.match(source, /npmSettingsFrom\(process\.env\)/);
  assert.match(source, /scriptBefore\(process\.env\.npm_lifecycle_event\)/);
  assert.match(source, /process\.exitCode = 1;/);
  assert.doesNotMatch(source, /process\.exit\(/, 'process.exit can cut off a write to a Windows console');
});

// -- the real runner ------------------------------------------------------------ //

/*
 * The environment a real run gets: this one, minus what would change the
 * answer - every npm_* variable the npm running `npm test` handed it (its
 * settings, `--prefix backend` among them, and the lifecycle event) and an
 * operator's NODE_ENV - plus `extra`.
 */
function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^npm_/i.test(key) || /^node_env$/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

function runRunner(script, env = cleanEnv()) {
  // From another directory: the root comes from the script's own location.
  const result = spawnSync(process.execPath, [script], { cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 30000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/*
 * A tree like the owner's: copies of the three package.json files and the two
 * scripts. `installed` lists the packages (`backend/express`) to stand in as
 * installed, by a package.json of their own.
 */
function ownerTree({ installedIn = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-check-'));
  for (const dir of ['', 'backend', 'frontend']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.copyFileSync(path.join(ROOT, dir, 'package.json'), path.join(root, dir, 'package.json'));
  }
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(CHECK, path.join(root, 'scripts', 'installCheck.mjs'));
  fs.copyFileSync(RUNNER, path.join(root, 'scripts', 'checkInstall.mjs'));
  for (const dir of installedIn) {
    const pkg = readJson(path.join(dir, 'package.json'));
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const target = path.join(root, dir, 'node_modules', ...name.split('/'));
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
    }
  }
  return root;
}

test('checkInstall.mjs, on this checkout: nothing printed, exit 0', { skip: CHECKOUT_NOT_INSTALLED }, () => {
  const run = runRunner(RUNNER);
  assert.deepEqual(run, { status: 0, stdout: '', stderr: '' });
  // npm's settings do not matter when nothing is missing.
  assert.deepEqual(runRunner(RUNNER, cleanEnv({ NODE_ENV: 'production', npm_config_omit: 'dev' })), run);
});

test("checkInstall.mjs, on a tree with no node_modules: names concurrently and the root, exit 1", () => {
  const root = ownerTree();
  try {
    const script = path.join(root, 'scripts', 'checkInstall.mjs');
    const run = runRunner(script, cleanEnv({ npm_lifecycle_event: 'predev' }));
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    const lines = run.stderr.trimEnd().split('\n');
    assert.equal(lines[0], '[install] npm run dev cannot start: packages this repository needs are not installed.');
    assert.equal(lines[1], '[install]   In the repository root: concurrently');
    assert.match(lines[2], /^\[install\] {3}In backend: .*, and \d+ more$/);
    assert.match(lines[3], /^\[install\] {3}In frontend: .*next.*, and \d+ more$/);
    assert.equal(lines[4], `[install] Run npm run install:all from the repository root, ${root}, then npm run dev again.`);
    assert.equal(lines.length, 5, 'nothing about devDependencies with no setting omitting them');

    const omitted = runRunner(script, cleanEnv({ npm_lifecycle_event: 'predev:poll', NODE_ENV: 'production', npm_config_omit: 'dev' }));
    assert.equal(omitted.status, 1);
    assert.match(omitted.stderr, /npm run dev:poll cannot start/);
    assert.match(omitted.stderr, /out of installs here: its omit setting includes dev, and some of the packages missing above are\./);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checkInstall.mjs, the owner's state - backend and frontend installed, the root not - names concurrently alone", () => {
  const root = ownerTree({ installedIn: ['backend', 'frontend'] });
  try {
    const run = runRunner(path.join(root, 'scripts', 'checkInstall.mjs'), cleanEnv({ npm_lifecycle_event: 'predev' }));
    assert.equal(run.status, 1);
    assert.equal(
      run.stderr,
      [
        '[install] npm run dev cannot start: packages this repository needs are not installed.',
        '[install]   In the repository root: concurrently',
        `[install] Run npm run install:all from the repository root, ${root}, then npm run dev again.`,
        '',
      ].join('\n')
    );

    // Installed again: silent.
    const target = path.join(root, 'node_modules', 'concurrently');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'package.json'), '{}');
    assert.deepEqual(runRunner(path.join(root, 'scripts', 'checkInstall.mjs')), { status: 0, stdout: '', stderr: '' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkInstall.mjs never throws: a broken installCheck.mjs is one line, and the script goes on', () => {
  const root = ownerTree();
  try {
    fs.writeFileSync(path.join(root, 'scripts', 'installCheck.mjs'), 'export const = ;');
    const run = runRunner(path.join(root, 'scripts', 'checkInstall.mjs'));
    assert.equal(run.status, 0);
    assert.match(run.stderr, /^\[install\] Could not check which packages are installed \(.+\); going on\.\n$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/*
 * npm's part, through the npm running this suite (npm_execpath, set for every
 * script npm runs): it runs `predev:live` before `dev:live` - a name with a
 * colon - and, when the hook exits 1, ends there with its code and never
 * reaches concurrently. Skipped when the suite was started without npm.
 */
test(
  'npm runs the check before dev:live and stops there when it fails',
  { skip: !process.env.npm_execpath && 'not started by npm' },
  () => {
    const root = ownerTree({ installedIn: ['backend', 'frontend'] });
    try {
      // ignore-scripts would skip the hook itself, whatever this machine's npmrc says.
      const env = cleanEnv({
        npm_config_update_notifier: 'false',
        npm_config_loglevel: 'warn',
        npm_config_ignore_scripts: 'false',
      });
      const result = spawnSync(process.execPath, [process.env.npm_execpath, 'run', 'dev:live'], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 60000,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /> predev:live\n> node scripts\/checkInstall\.mjs/);
      assert.match(result.stderr, /\[install\] npm run dev:live cannot start/);
      assert.match(result.stderr, /In the repository root: concurrently/);
      assert.doesNotMatch(result.stdout + result.stderr, /> concurrently|concurrently: not found|is not recognized/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

/*
 * What the hint cannot see, through the npm running this suite. npm passes a
 * setting on to a script only when it differs from npm's default, and a
 * deprecated one never: with NODE_ENV=production in the environment, an
 * .npmrc's omit=dev IS the default, so the script sees NODE_ENV alone - just
 * as it does beside a deprecated production=false, under which npm installs
 * devDependencies after all. So the advice names both ways NODE_ENV gets
 * there (clearing NODE_ENV alone would leave the omit=dev) and sends the
 * person to `npm config get omit`, which tells the two apart. The machine's
 * own user and global .npmrc are kept out of it; a user .npmrc of the test's
 * own stands in for `npm config set omit dev`, the case the review measured.
 */
test(
  'npm hides an omit=dev behind NODE_ENV=production: the advice names both ways and points to npm config get omit',
  { skip: !process.env.npm_execpath && 'not started by npm' },
  () => {
    const root = ownerTree({ installedIn: ['backend', 'frontend'] });
    try {
      const env = cleanEnv({
        NODE_ENV: 'production',
        npm_config_update_notifier: 'false',
        npm_config_loglevel: 'warn',
        npm_config_ignore_scripts: 'false',
        npm_config_userconfig: path.join(root, 'user-npmrc'),
        npm_config_globalconfig: path.join(root, 'no-global-npmrc'),
      });
      const npm = (...args) =>
        spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
      const HINT =
        '[install] npm looks set to leave devDependencies out of installs here: NODE_ENV is production (in the ' +
        'environment, or set by npm for an omit=dev or production=true in its configuration, or both), and ' +
        'every package missing above is one. npm config get omit says what npm will do:';
      // [which .npmrc, what it says, what npm config get omit answers]
      for (const [file, npmrc, omits] of [
        ['.npmrc', 'omit=dev\n', 'dev'],
        ['user-npmrc', 'omit=dev\n', 'dev'],
        ['.npmrc', 'production=false\n', ''],
      ]) {
        for (const other of ['.npmrc', 'user-npmrc']) fs.rmSync(path.join(root, other), { force: true });
        fs.writeFileSync(path.join(root, file), npmrc);
        const label = `${file}: ${npmrc.trim()}`;
        assert.equal(npm('config', 'get', 'omit').stdout.trim(), omits, label);
        const run = npm('run', 'dev');
        assert.equal(run.status, 1, run.stderr);
        assert.ok(run.stderr.includes(HINT), `${label}: ${run.stderr}`);
        assert.doesNotMatch(run.stderr, /its omit setting includes dev/, `${label}: the omit=dev never reached the script`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
