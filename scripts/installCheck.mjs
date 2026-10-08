/**
 * What scripts/checkInstall.mjs decides about this repository's install, and
 * nothing else.
 *
 * The root `npm run dev` (and `dev:live`, `dev:poll`) starts with
 * `concurrently`, the root package's only devDependency. When the root's own
 * node_modules is missing - deleted while sorting out a pull, with only the
 * `--prefix` installs run again; stripped by an npm that leaves
 * devDependencies out; half-written by an install Windows interrupted - the
 * person sees only their shell's sentence, cmd's "'concurrently' is not
 * recognized as an internal or external command, operable program or batch
 * file.", which says nothing about why or what to run. npm runs `predev`
 * (and `predev:live`, `predev:poll`) first, so checkInstall.mjs looks before
 * concurrently is ever reached, and says what is missing and the one command
 * that puts it back.
 *
 * Every decision lives here, as functions with no side effects - no process,
 * file, environment or console, and no import, so it loads the same with
 * nothing installed - which backend/test/installCheck.test.js imports and runs
 * on fake trees. The file system and the environment are handed in.
 */

/**
 * The three packages this repository installs, each with its own package.json
 * and node_modules: the root (concurrently), the backend and the frontend.
 * `dir` is relative to the repository root, '' for the root itself.
 */
export const PACKAGE_DIRS = Object.freeze([
  Object.freeze({ id: 'root', dir: '', label: 'the repository root' }),
  Object.freeze({ id: 'backend', dir: 'backend', label: 'backend' }),
  Object.freeze({ id: 'frontend', dir: 'frontend', label: 'frontend' }),
]);

/*
 * The fields whose packages must be installed. Optional and peer dependencies
 * are left out: npm may skip an optional one on a platform it does not fit,
 * and a peer is somebody else's to install.
 */
const DEPENDENCY_FIELDS = Object.freeze([
  ['dependencies', false],
  ['devDependencies', true],
]);

/*
 * A package name as npm writes one into node_modules: unscoped, or
 * `@scope/name`, neither part starting with a dot or holding a path
 * separator. Anything else cannot be in node_modules under its own name, so
 * it is not looked for - and a key like `../x` is never turned into a path.
 */
const PACKAGE_NAME = /^(?:@[^@/\\\s.][^/\\\s]*\/)?[^@/\\\s.][^/\\\s]*$/;

/** Why a package.json could not be used, in words, from what reading it threw. */
function unreadableReason(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  if (code === 'ENOENT') return 'could not be found';
  if (typeof code === 'string' && code) return `could not be read (${code})`;
  return 'could not be read';
}

/**
 * Every package a package.json names that its node_modules does not hold.
 *
 * `root` is the repository root; `join`, `exists` and `read` are the file
 * system's (path.join, fs.existsSync, fs.readFileSync as text), injected so a
 * test can hand in a fake tree. A package counts as installed when
 * `node_modules/<name>/package.json` exists - `node_modules/@scope/name/...`
 * for a scoped one - which is where npm puts every direct dependency of a
 * package, whatever it hoists.
 *
 * The answer lists only the packages with a problem, in PACKAGE_DIRS order:
 * `{ id, label, dir, manifest, missing: [{ name, dev }], unreadable }`, where
 * `unreadable` is null or what is wrong with the package.json (`could not be
 * found`, `could not be read (EACCES)`, `is not valid JSON`) - reported, never
 * thrown, like anything `exists` or `read` throws. An empty array means
 * complete.
 */
export function missingPackages({ root, packages = PACKAGE_DIRS, join, exists, read }) {
  const problems = [];
  for (const pkg of packages) {
    const dir = pkg.dir ? join(root, pkg.dir) : root;
    const manifest = join(dir, 'package.json');
    const entry = { id: pkg.id, label: pkg.label, dir, manifest, missing: [], unreadable: null };

    let parsed;
    try {
      const text = read(manifest);
      try {
        // A BOM is what some Windows editors save; npm reads past it.
        parsed = JSON.parse(String(text).replace(/^\uFEFF/, ''));
      } catch {
        entry.unreadable = 'is not valid JSON';
      }
    } catch (error) {
      entry.unreadable = unreadableReason(error);
    }
    if (entry.unreadable) {
      problems.push(entry);
      continue;
    }

    const seen = new Set();
    for (const [field, dev] of DEPENDENCY_FIELDS) {
      const listed = parsed && typeof parsed === 'object' ? parsed[field] : null;
      if (!listed || typeof listed !== 'object' || Array.isArray(listed)) {
        continue;
      }
      for (const name of Object.keys(listed)) {
        if (seen.has(name) || !PACKAGE_NAME.test(name)) {
          continue;
        }
        seen.add(name);
        let installed = false;
        try {
          installed = exists(join(dir, 'node_modules', ...name.split('/'), 'package.json')) === true;
        } catch {
          installed = false;
        }
        if (!installed) {
          entry.missing.push({ name, dev });
        }
      }
    }
    if (entry.missing.length > 0) {
      problems.push(entry);
    }
  }
  return problems;
}

/*
 * An npm setting as a script sees it: `npm_config_<name>`, whose name npm
 * reads in any case (a hand-set NPM_CONFIG_OMIT works, and reaches the script
 * in the case it was set in), so it is looked up the same way. Undefined when
 * unset - which is not the same as set to '' (`--omit=`).
 */
function npmSetting(env, name) {
  const key = `npm_config_${name}`;
  if (typeof env[key] === 'string') return env[key];
  for (const [envKey, value] of Object.entries(env)) {
    if (envKey.toLowerCase() === key && typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * What installAdvice needs from the environment a script runs in:
 * `{ nodeEnv, omit, include, production }`, each a string or undefined.
 *
 * Measured with npm 10.9.4, which passes a setting on to a script only when
 * it differs from npm's default, and a deprecated one (production, dev, also)
 * never - a variable already in the environment the script just inherits: a
 * script sees `npm_config_omit` (and `npm_config_include`) from an
 * .npmrc, the environment or the command line, several values joined by a
 * blank line (`dev\n\noptional`) - EXCEPT an omit=dev from an .npmrc or the
 * command line while NODE_ENV=production is already in the environment,
 * which makes omit=dev the default, so it is not passed on and the script
 * sees NODE_ENV alone; `npm_config_production` only when it was set in the
 * environment itself, which the script inherits; and NODE_ENV=production
 * both when the environment says so and whenever npm itself is leaving
 * devDependencies out (an omit of dev, or `production=true` in an .npmrc),
 * which npm sets for every script it runs. Out of sight entirely: an
 * .npmrc's production=false, dev=true or also=dev, which make npm install
 * devDependencies under NODE_ENV=production; and an exported empty
 * `npm_config_omit`, which npm ignores (so NODE_ENV=production still omits
 * dev) but which reads exactly like `--omit=` or an .npmrc's `omit=`, which
 * npm obeys. So what this reads is a hint; `npm config get omit` is npm's own
 * answer, and agreed with the install in every case measured.
 */
export function npmSettingsFrom(env) {
  const source = env && typeof env === 'object' ? env : {};
  return {
    nodeEnv: typeof source.NODE_ENV === 'string' ? source.NODE_ENV : undefined,
    omit: npmSetting(source, 'omit'),
    include: npmSetting(source, 'include'),
    production: npmSetting(source, 'production'),
  };
}

/* npm's own split of a list setting from the environment: on a blank line. */
const listOf = (value) =>
  typeof value === 'string'
    ? value
        .split('\n\n')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

/**
 * Whether npm's settings, as far as a script can see them, leave
 * devDependencies out of an install made from this environment, and which
 * one says so: 'omit' (its omit setting includes dev), 'production'
 * (npm_config_production=true), 'node-env' (NODE_ENV=production with no omit
 * setting in sight to say otherwise), or null.
 *
 * The same order npm 10 decides in, as far as a script can see it: an include
 * of dev, or production=false, wins over everything; an omit setting - even an
 * empty one - replaces the default that NODE_ENV=production gives it. A hint,
 * never a verdict - npmSettingsFrom says what a script cannot see - which is
 * why installAdvice words it as what npm looks set to do and points to
 * `npm config get omit`; and 'node-env' may be an omit=dev that NODE_ENV hid.
 */
export function devDependenciesOmitted({ nodeEnv, omit, include, production } = {}) {
  if (listOf(include).includes('dev') || production === 'false') {
    return null;
  }
  if (listOf(omit).includes('dev')) {
    return 'omit';
  }
  if (production === 'true') {
    return 'production';
  }
  if (nodeEnv === 'production' && omit === undefined) {
    return 'node-env';
  }
  return null;
}

/*
 * Which setting the hint saw. 'node-env' names both ways NODE_ENV gets there,
 * and both at once: with NODE_ENV=production in the environment, an omit=dev
 * in an .npmrc or on the command line is npm's default and never reaches the
 * script, so clearing NODE_ENV alone may not be the end of it.
 */
const OMITTED_BECAUSE = Object.freeze({
  omit: 'its omit setting includes dev',
  production: 'npm_config_production=true is set in the environment',
  'node-env':
    'NODE_ENV is production (in the environment, or set by npm for an omit=dev or production=true in its ' +
    'configuration, or both)',
});

/** At most `limit` names, then how many more. */
function nameList(names, limit) {
  if (names.length <= limit) {
    return names.join(', ');
  }
  return `${names.slice(0, limit).join(', ')}, and ${names.length - limit} more`;
}

/**
 * The root scripts whose `pre` hook is this check - the three that start with
 * `concurrently` - in package.json's order. installCheck.test.js holds the
 * root package.json to it: every script that runs concurrently has its hook.
 */
export const GUARDED_SCRIPTS = Object.freeze(['dev', 'dev:live', 'dev:poll']);

/**
 * The script about to start, from npm_lifecycle_event - `dev` for `predev`,
 * `dev:live` for `predev:live` - or undefined for anything else, the check
 * run by hand among them.
 */
export function scriptBefore(lifecycleEvent) {
  if (typeof lifecycleEvent !== 'string' || !lifecycleEvent.startsWith('pre')) {
    return undefined;
  }
  const script = lifecycleEvent.slice(3);
  return GUARDED_SCRIPTS.includes(script) ? script : undefined;
}

/**
 * The one message printed when the install is incomplete, as lines to print
 * together, or null when `missing` (missingPackages' answer) is empty.
 *
 * It names what is missing per package (at most `limit` names each, then
 * "and N more"), and the remedy: `npm run install:all` from the repository
 * root, by its path, since a `--prefix` install never puts the root's own
 * packages back. When npm's settings look set to leave devDependencies out
 * (devDependenciesOmitted on `nodeEnv`, `omit`, `include`, `production`) and
 * a missing package is one, it says so, as a hint: which setting it saw,
 * `npm config get omit` for npm's own answer, and that install:all passes
 * --include=dev, which overrides them, while a plain `npm install` would
 * strip them again.
 * `script` is the npm script that was about to start (`dev`, `dev:live`), or
 * absent when the check was run by hand.
 */
export function installAdvice({
  root,
  missing,
  nodeEnv,
  omit,
  include,
  production,
  script,
  limit = 5,
}) {
  if (!Array.isArray(missing) || missing.length === 0) {
    return null;
  }
  const run = typeof script === 'string' && script ? `npm run ${script}` : null;
  const lines = [
    run
      ? `[install] ${run} cannot start: packages this repository needs are not installed.`
      : '[install] Packages this repository needs are not installed.',
  ];

  let anyDev = false;
  let allDev = true;
  let anyUnreadable = false;
  for (const pkg of missing) {
    if (pkg.unreadable) {
      anyUnreadable = true;
      lines.push(`[install]   In ${pkg.label}: its package.json ${pkg.unreadable} (${pkg.manifest}).`);
      continue;
    }
    const names = pkg.missing.map((item) => item.name);
    anyDev = anyDev || pkg.missing.some((item) => item.dev);
    allDev = allDev && pkg.missing.every((item) => item.dev);
    lines.push(`[install]   In ${pkg.label}: ${nameList(names, limit)}`);
  }

  lines.push(
    `[install] Run npm run install:all from the repository root, ${root}${run ? `, then ${run} again` : ''}.`
  );

  const omitted = devDependenciesOmitted({ nodeEnv, omit, include, production });
  if (omitted && anyDev) {
    lines.push(
      `[install] npm looks set to leave devDependencies out of installs here: ${OMITTED_BECAUSE[omitted]}, ` +
        `and ${allDev ? 'every package missing above is one' : 'some of the packages missing above are'}. ` +
        'npm config get omit says what npm will do: dev in its answer means it leaves them out. ' +
        'npm run install:all passes --include=dev, which installs them whatever those settings say; while ' +
        'they say so, a plain npm install here removes them again.'
    );
  }
  if (anyUnreadable) {
    lines.push(
      '[install] A package.json comes with the checkout, not with an install: git status in the repository ' +
        'root shows whether it was deleted or changed.'
    );
  }
  return lines.join('\n');
}
