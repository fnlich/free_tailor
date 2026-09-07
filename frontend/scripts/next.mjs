#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
const repoRoot = join(here, '..', '..');

/**
 * A deliberately small `.env` reader: `KEY=value` lines, `#` comments, and
 * optional surrounding quotes. Enough for this file, and it keeps the frontend
 * free of a dependency it would otherwise need only here.
 *
 * Values already present in the environment win, so `FRONTEND_PORT=4000 npm
 * run dev` still does what it looks like it does.
 */
function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
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
    if (key in process.env) {
      continue;
    }

    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(join(repoRoot, '.env'));

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
// `next build` takes neither, and passing them would fail the command.
if (mode !== 'build') {
  args.push('--hostname', process.env.FRONTEND_HOST || '0.0.0.0');
  args.push('--port', process.env.FRONTEND_PORT || '3000');
}

// `next` rather than `npx next`, resolved through node_modules/.bin, which npm
// has already put on PATH for a script it is running. `shell: true` is what
// makes the .cmd shim on Windows resolvable.
const child = spawn('next', args, { stdio: 'inherit', shell: true });

child.on('error', (error) => {
  console.error(`Could not start next: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
