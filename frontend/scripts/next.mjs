#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Launches Next with the repository's own configuration.
 *
 * It exists for two reasons, both of which used to be papered over by writing
 * `--port ${FRONTEND_PORT:-3000}` directly in the npm script:
 *
 * 1. That is POSIX shell syntax. npm runs scripts through `cmd.exe` on
 *    Windows, which does not expand it, so Next received the literal string
 *    "${FRONTEND_PORT:-3000}" and refused to start.
 *
 * 2. Next only reads `.env` files inside its own directory, and this repo
 *    keeps a single `.env` at the root. So `FRONTEND_PORT`,
 *    `NEXT_PUBLIC_API_URL` and the rest were only ever picked up if the
 *    operator had separately exported them - the documented `.env` did
 *    nothing. Loading it here and handing it to the child fixes that.
 *
 * Usage: node scripts/next.mjs <dev|dev-webpack|build|start>
 */

const here = dirname(fileURLToPath(import.meta.url));
const frontendDir = join(here, '..');
const repoRoot = join(frontendDir, '..');
const require = createRequire(import.meta.url);

/**
 * A deliberately small `.env` reader: `KEY=value` lines, `#` comments, and
 * optional surrounding quotes. Enough for this file, and it keeps the frontend
 * free of a dependency it would otherwise need only here.
 */
function parseEnvFile(filePath) {
  const parsed = {};
  if (!existsSync(filePath)) {
    return parsed;
  }

  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

/**
 * Every key any `frontend/.env*` file defines.
 *
 * The root `.env` is the repository's shared configuration; a frontend env
 * file is more specific and must win. Next loads its own files but does NOT
 * overwrite anything already in `process.env` - verified against @next/env -
 * so injecting a root value for a key that `.env.local` also sets would
 * silently beat the developer's own override, backwards from every Next
 * convention. Skipping those keys here restores the expected precedence:
 *
 *   frontend/.env.local  >  frontend/.env*  >  root .env  >  built-in default
 *
 * Anything already exported in the real environment still beats all of them.
 */
function keysOwnedByFrontendEnvFiles() {
  const owned = new Set();
  let entries = [];
  try {
    entries = readdirSync(frontendDir);
  } catch {
    return owned;
  }

  for (const entry of entries) {
    if (!entry.startsWith('.env')) {
      continue;
    }
    for (const key of Object.keys(parseEnvFile(join(frontendDir, entry)))) {
      owned.add(key);
    }
  }
  return owned;
}

const frontendOwned = keysOwnedByFrontendEnvFiles();
for (const [key, value] of Object.entries(parseEnvFile(join(repoRoot, '.env')))) {
  if (key in process.env || frontendOwned.has(key)) {
    continue;
  }
  process.env[key] = value;
}

const MODES = {
  dev: ['dev'],
  'dev-webpack': ['dev', '--webpack'],
  build: ['build'],
  start: ['start'],
};

const mode = process.argv[2];
const baseArgs = MODES[mode];
if (!baseArgs) {
  console.error(`Usage: node scripts/next.mjs <${Object.keys(MODES).join('|')}>`);
  process.exit(1);
}

const args = [...baseArgs];
// `next build` takes neither, and passing them would fail the command. The
// frontend's own env files may set these too, and they are read above.
if (mode !== 'build') {
  args.push('--hostname', process.env.FRONTEND_HOST || '0.0.0.0');
  args.push('--port', process.env.FRONTEND_PORT || '3000');
}

// Run Next's JS entry point under this Node directly, rather than the `next`
// shim through a shell. A shell would be needed on Windows to resolve
// `next.cmd`, and `shell: true` with arguments is deprecated (DEP0190)
// because the arguments are concatenated rather than escaped - which a path
// containing a space is enough to break.
let nextBin;
try {
  nextBin = require.resolve('next/dist/bin/next');
} catch {
  console.error('Could not find next. Run `npm install` in the frontend directory first.');
  process.exit(1);
}

const child = spawn(process.execPath, [nextBin, ...args], { stdio: 'inherit' });

child.on('error', (error) => {
  console.error(`Could not start next: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) {
    // Re-raise so the shell sees the same cause of death. Windows has no POSIX
    // signals and process.kill only accepts a few names there, so a signal it
    // does not know must not become an unhandled throw out of the launcher.
    try {
      process.kill(process.pid, signal);
      return;
    } catch {
      process.exit(1);
    }
  }
  process.exit(code ?? 0);
});
