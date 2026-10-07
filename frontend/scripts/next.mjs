#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterExit,
  fallbackExplanation,
  installedVersionProblem,
  MODES,
  nextArgs,
} from './nextLaunch.mjs';

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
 * It also stands in for one crash: on Windows, Turbopack's `next dev` can die
 * natively with 0xC0000005 a moment after "Ready" (vercel/next.js#95015), and
 * `dev` then builds and starts the production-style server instead, once. It
 * warns, too, when the Next installed is not the one package.json pins. What
 * to run and when is decided in nextLaunch.mjs, which has no side effects and
 * is tested from backend/test/devServer.test.js; this file runs it.
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
/**
 * Reads a `.env` as text, whatever encoding Windows wrote it in.
 *
 * PowerShell 5.1 - still the default `powershell.exe` on Windows 10 and 11 -
 * writes UTF-16LE from both `>` and `Set-Content`. Read as UTF-8 that file
 * parses into mangled keys with NUL bytes in them, so every variable in it is
 * silently ignored and the frontend builds against the built-in defaults. No
 * error, no warning, and a `.env` that visibly exists but does nothing.
 *
 * backend/src/config/env.ts decodes the same file for the backend and must
 * agree with this; change the two together.
 */
function readEnvText(filePath) {
  const buffer = readFileSync(filePath);

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  // UTF-16BE: Node cannot decode it directly, so swap to LE first.
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

function parseEnvFile(filePath) {
  const parsed = {};
  if (!existsSync(filePath)) {
    return parsed;
  }

  for (const rawLine of readEnvText(filePath).split(/\r?\n/)) {
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

/*
 * The ENVIRONMENT beats the root `.env`: a variable already exported keeps its
 * value, an empty one included. backend/src/config/env.ts applies the same
 * rule to the same file (applyEnvFile in config/envFile.ts), so the two halves
 * agree about every variable - before it did, `PORT=4000` in a shell moved the
 * frontend's derived API URL to 4000 while the backend stayed on the file's
 * port, and every call failed. Change the two together. A name set in both
 * with different values is said once, by NAME only, in the sentence the
 * backend's describeShadowed (config/envFile.ts) builds - this cannot import
 * that, so the two copies must stay alike.
 */
const frontendOwned = keysOwnedByFrontendEnvFiles();
const rootEnvPath = join(repoRoot, '.env');
const shadowed = [];
for (const [key, value] of Object.entries(parseEnvFile(rootEnvPath))) {
  if (key in process.env) {
    if (process.env[key] !== value) shadowed.push(key);
    continue;
  }
  if (frontendOwned.has(key)) {
    continue;
  }
  process.env[key] = value;
}
if (shadowed.length > 0) {
  console.warn(
    `[env] ${shadowed.join(', ')} ${shadowed.length === 1 ? 'is' : 'are'} set both in the environment and in ` +
      `${rootEnvPath}; the environment's value is used.`
  );
}

/**
 * Keeps the frontend's idea of the API port and the backend's `PORT` together.
 *
 * They are two variables that MUST agree - `PORT` is where the backend listens,
 * and the port inside `NEXT_PUBLIC_API_URL` is where the browser looks - and
 * nothing used to check. `.env.example` ships both spelled out, so changing one
 * and not the other is a single-keystroke mistake, and the result is a frontend
 * that builds and runs perfectly while every request fails: the browser cannot
 * tell a wrong port from a stopped server, so the page just says it cannot
 * reach the backend.
 *
 * Two things happen here. If NEXT_PUBLIC_API_URL is not set at all, it is
 * derived from PORT rather than falling back to the hard-coded 3001 in
 * lib/api.ts - so changing PORT alone is now sufficient and correct. If it IS
 * set and points at this machine on a DIFFERENT port, that is a contradiction
 * no deployment wants, and it is called out here and passed to the page so the
 * error the user actually reads can name it.
 *
 * The local-hostname test matters: pointing the frontend at another host is a
 * legitimate split deployment, and the port there has nothing to do with this
 * machine's PORT. Only same-machine disagreement is a mistake.
 */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const backendPort = (process.env.PORT || '3001').trim();

/**
 * `APP_URL` trimmed of trailing slashes, or ''.
 *
 * Its own two lines rather than an import: this is an .mjs and the backend's
 * `config/publicUrl.ts` is TypeScript. Kept to trim-and-strip so there is no
 * second parser to drift from that one - anything cleverer belongs there.
 */
const appUrl = (process.env.APP_URL || '').trim().replace(/\/+$/, '');

if (!process.env.NEXT_PUBLIC_API_URL) {
  // One variable for a single-origin deployment. Without APP_URL this is the
  // old derivation from PORT, so a local install is unchanged.
  process.env.NEXT_PUBLIC_API_URL = appUrl
    ? `${appUrl}/api`
    : `http://localhost:${backendPort}/api`;
} else {
  let configured = null;
  try {
    configured = new URL(process.env.NEXT_PUBLIC_API_URL);
  } catch {
    console.error(
      `[env] NEXT_PUBLIC_API_URL is not a valid URL: ${process.env.NEXT_PUBLIC_API_URL}`
    );
  }

  if (configured && LOCAL_HOSTNAMES.has(configured.hostname) && configured.port !== backendPort) {
    console.warn(
      `\n[env] NEXT_PUBLIC_API_URL points at port ${configured.port || '(default)'} on this machine, ` +
        `but PORT=${backendPort} is where the backend listens.\n` +
        `      Every API call will fail. Set them to the same port in the repository .env, ` +
        `or delete NEXT_PUBLIC_API_URL to derive it from PORT.\n`
    );
    // Read back by lib/api.ts so the message in the UI can say this too. The
    // build-time warning above is easy to scroll past; the page is not.
    process.env.NEXT_PUBLIC_EXPECTED_API_PORT = backendPort;
  }

  /*
   * An http API base under an https public address is the half-configured
   * install: the browser blocks every call as mixed content, and reports that
   * to the page as an unreachable server - the same `TypeError` as a stopped
   * backend. Worth naming here, because nothing downstream can tell them apart.
   */
  if (configured && appUrl.startsWith('https://') && configured.protocol === 'http:') {
    console.warn(
      `\n[env] NEXT_PUBLIC_API_URL is http:// but APP_URL is https://.\n` +
        `      A browser blocks that as mixed content and the page can only say it ` +
        `cannot reach the backend.\n` +
        `      Set NEXT_PUBLIC_API_URL to ${appUrl}/api, or delete it to derive it from APP_URL.\n`
    );
  }
}

const mode = process.argv[2];
const baseArgs = MODES[mode];
if (!baseArgs) {
  console.error(`Usage: node scripts/next.mjs <${Object.keys(MODES).join('|')}>`);
  process.exit(1);
}

// nextArgs leaves both off `next build`, which takes neither. The frontend's
// own env files may set these too, and they are read above.
const address = {
  hostname: process.env.FRONTEND_HOST || '0.0.0.0',
  port: process.env.FRONTEND_PORT || '3000',
};

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

/*
 * Say so before launching when the Next installed is not the one
 * package.json pins - the owner's Windows log ran a Next moved by hand, and
 * nothing said so until its dev server crashed. Read through the same require
 * that found Next above, so it is the version that runs. Anything unreadable
 * says nothing: a check of the install must never stop a launch.
 */
let installedNext = null;
try {
  installedNext = require('next/package.json').version;
} catch {
  // Unreadable: no warning, and the fallback's explanation names no version.
}
let pinnedNext = null;
try {
  pinnedNext = JSON.parse(readFileSync(join(frontendDir, 'package.json'), 'utf8')).dependencies?.next;
} catch {
  // Unreadable: nothing to compare with.
}
const versionProblem = installedVersionProblem(installedNext, pinnedNext);
if (versionProblem) {
  console.warn(versionProblem);
}

/*
 * One step at a time: the mode's command, and - only when Windows ends
 * Turbopack's dev server with ACCESS_VIOLATION (vercel/next.js#95015) - the
 * production-style server in its place, once. nextLaunch.mjs's afterExit
 * decides every step; this only runs them. There is no signal handler here on
 * purpose: Ctrl-C reaches this process along with Next (the terminal's process
 * group, Windows' console) and ends it, so no later step ever starts after one
 * - and a step that a signal or a failure ended is never followed by another
 * anyway. A signal sent to this process ALONE still leaves its Next running,
 * as it always has.
 */
let state = { mode, platform: process.platform, address, fellBack: false, pending: [] };

function launch(args) {
  const child = spawn(process.execPath, [nextBin, ...args], { stdio: 'inherit' });

  child.on('error', (error) => {
    console.error(`Could not start next: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    const next = afterExit(state, { args, code, signal });
    if (next.run) {
      if (next.crash) {
        console.warn(fallbackExplanation({ code, crash: next.crash, installed: installedNext, address }));
      }
      state = next.state;
      launch(next.run);
      return;
    }
    if (next.note) {
      console.warn(next.note);
    }

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
}

launch(nextArgs(baseArgs, address));
