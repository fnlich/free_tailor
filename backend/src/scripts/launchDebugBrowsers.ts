// FIRST, before anything reads process.env. Every module below is evaluated
// before this file's own statements run, so a dotenv call in the body would
// land after aiModelConfig had already captured AI_WEB_CDP_PORT and after
// sqlite.ts had resolved DB_DIR. src/index.ts and the other scripts here open
// the same way, and for the same reason: without it this launcher reads a
// different .env from the backend it is starting browsers for, and the only
// symptom is "could not reach a debug browser" from a window plainly open.
import '../config/env';
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import {
  BROWSER_CHAT_PORT_MAX,
  BROWSER_CHAT_PORT_MIN,
  getBrowserChatEndpoints,
  getBrowserChatEnvDefaults,
  updateAppSettings,
  type BrowserChatEndpoint,
} from '../config/aiModelConfig';
import { getDatabasePath } from '../database/sqlite';
import { findInstalledBrowser } from '../config/browser';
import { getProviderLabel } from '../config/providerCatalog';
import { probeDebugBrowser, type DebugBrowserStatus } from '../services/debugBrowser';
import { isChatSiteId, readChatSite, type ChatSiteId } from '../services/ai/providers/browserChat/sites';

/**
 * Starts the Chrome windows the browser-chat providers attach to.
 *
 * THE SERVER DOES NOT DO THIS ANY MORE, and that is the point of this file
 * existing. Launching used to be an HTTP endpoint behind a Start button, which
 * meant the backend spawned a desktop process on request; now the operator runs
 * this and the backend only ever attaches to what it finds. The server's remaining
 * interest in these browsers is read-only - `probeDebugBrowser` and the health
 * check - so nothing reachable over HTTP can start a process again.
 *
 * What that costs is a command to run. What it buys, beyond the obvious, is that
 * the browser is no longer a child of a service: it belongs to the person who
 * signed in to it, outlives a backend restart, and cannot be started by anyone
 * who can reach the admin API.
 *
 * The four rules this script exists to get right, every one of which bites when
 * it is done by hand:
 *
 * A PROFILE DIRECTORY PER PORT. Chrome ignores `--remote-debugging-port` when a
 * browser is already running on that profile - it opens a tab in the existing
 * window and exits, so the port never comes up and the failure looks like
 * nothing happening. One profile per port also keeps the sign-ins apart, which
 * is what anyone would expect from two windows.
 *
 * A REAL BROWSER, NOT THE AUTOMATION ONE. The installed Chrome/Edge/Brave, never
 * puppeteer's Chrome for Testing: sign-in flows reject a browser in automation
 * mode ("This browser or app may not be secure"), and the whole design is that a
 * human signs in here.
 *
 * LOOPBACK, AND NEVER `--remote-allow-origins`. That flag turns off the DevTools
 * origin check, which is the only thing stopping a web page the operator visits
 * from opening a socket to 127.0.0.1, driving this browser, and reading the
 * accounts signed in to it. Measured against Chrome 148.0.7778.97: with the flag
 * a socket carrying `Origin: https://evil.example.com` is accepted; without it
 * Chrome answers 403. Nothing here needs it - puppeteer connects from Node and
 * sends no Origin header, so the check never applies to it.
 *
 * FLAGS AGAINST BACKGROUND THROTTLING. Several of these windows run at once and
 * only one can be focused. Chrome throttles and eventually freezes a window it
 * thinks nobody is looking at, and a DOM read against a frozen renderer does not
 * fail - it never returns.
 *
 *   npm run browser:debug                          # every registered browser
 *   npm run browser:debug -- --port 9333 --site chatgpt-web
 *   npm run browser:debug -- --list
 */

export const DEFAULT_DEBUG_PROFILE_DIR = path.join(os.homedir(), '.free-tailor-chrome');

/** One profile directory per port. See the file docstring. */
export function defaultProfileDirFor(port: number): string {
  return `${DEFAULT_DEBUG_PROFILE_DIR}-${port}`;
}

/**
 * How long to wait for the port to come up before calling it a failure.
 *
 * Generous, because reporting a failure for a browser that IS starting is the
 * worse mistake: it leaves a window running that the operator was told did not
 * open. Measured here, a cold profile took past 12s - a first run on Windows
 * with antivirus in the way can take longer still.
 */
export const STARTUP_WAIT_MS = 45_000;
const STARTUP_POLL_MS = 300;
const TAB_REQUEST_TIMEOUT_MS = 1_500;

export class DebugBrowserError extends Error {
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = 'DebugBrowserError';
    this.hint = hint;
  }
}

export function assertUsablePort(value: unknown): number {
  // Digits and nothing else, rather than `parseInt` on its own.
  //
  // `parseInt` stops at the first character it does not understand, so
  // "9222; rm -rf /" parses to 9222 and "9222abc" to 9222. Neither can reach a
  // shell from here - `spawn` is handed an argv array and what goes into it is
  // the parsed integer - but silently starting a browser on a port nobody typed
  // is its own bug, and the same laxness somewhere with a shell behind it would
  // be a much worse one. Refusing the input says what happened.
  const raw = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  const port = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isInteger(port) || port < BROWSER_CHAT_PORT_MIN || port > BROWSER_CHAT_PORT_MAX) {
    throw new DebugBrowserError(
      `"${String(value)}" is not a usable debug port.`,
      `Choose a whole number between ${BROWSER_CHAT_PORT_MIN} and ${BROWSER_CHAT_PORT_MAX}. ` +
        'Ports below 1024 need administrator rights on every platform this app runs on.'
    );
  }
  return port;
}

/**
 * Extra flags for an install that needs them, minus the one that must not come back.
 *
 * `AI_WEB_BROWSER_ARGS` exists for a real case: a machine with no display and no
 * sandbox needs `--headless=new --no-sandbox` or Chrome exits immediately. (A
 * headless browser cannot be signed in to by hand, so that only makes sense
 * against a profile that already is - but that is the operator's call.)
 *
 * `--remote-allow-origins` is stripped whatever it is set to, and that is the
 * point of parsing the list rather than splatting it. An escape hatch that can
 * reopen the hole the rest of this file is built to keep shut is not an escape
 * hatch, it is the hole with extra steps.
 */
export function sanitizeBrowserArgs(env: NodeJS.ProcessEnv): string[] {
  const raw = (env.AI_WEB_BROWSER_ARGS ?? '').trim();
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .filter((flag) => {
      if (/^--remote-allow-origins\b/i.test(flag)) {
        console.warn(
          '[browser] ignoring --remote-allow-origins from AI_WEB_BROWSER_ARGS: it would let any ' +
            'web page drive this browser and read the accounts signed in to it.'
        );
        return false;
      }
      // The port and the profile are decided here, not there; a second copy of
      // either would be ambiguous at best.
      return !/^--remote-debugging-(port|address)\b/i.test(flag) && !/^--user-data-dir\b/i.test(flag);
    });
}

/**
 * The exact argv Chrome is started with.
 *
 * Its own function so the security properties above can be asserted against the
 * real thing rather than against a grep of this file's source. A test that reads
 * source text passes on a comment and fails on an explanation; this one cannot.
 */
export function buildBrowserArgv(input: {
  port: number;
  profileDir: string;
  url: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  return [
    `--remote-debugging-port=${input.port}`,
    `--user-data-dir=${input.profileDir}`,
    // Loopback only, and no --remote-allow-origins. See the file docstring.
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    // Keep a window nobody is looking at answering DOM reads.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    ...sanitizeBrowserArgs(input.env),
    // ONE url on the command line. Chrome refuses to start with more than one
    // URL argument in headless mode ("Multiple targets are not supported in
    // headless mode", exit 13), and headless is exactly how a machine with no
    // display runs this. Anything else is opened over DevTools once the port
    // is up, which behaves identically in both modes.
    input.url,
  ];
}

function fileExists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Which browser to launch, and why not simply `CHROME_PATH`.
 *
 * `AI_WEB_BROWSER_PATH` is a separate variable on purpose. `CHROME_PATH` names
 * the browser this app RENDERS PDFs with, and on a lot of machines that is
 * puppeteer's Chrome for Testing - precisely the browser that must not be used
 * here. Honouring CHROME_PATH would take the one setting most likely to be
 * wrong for this job and make it authoritative.
 */
export function resolveLaunchBrowser(
  env: NodeJS.ProcessEnv,
  profileDir: string,
  port: number
): { executablePath: string; label: string } {
  const configured = (env.AI_WEB_BROWSER_PATH ?? '').trim();
  if (configured) {
    if (!fileExists(configured)) {
      throw new DebugBrowserError(
        `AI_WEB_BROWSER_PATH points at ${configured}, and there is no file there.`,
        'Correct the path, or unset it to let this script find an installed browser on its own.'
      );
    }
    return { executablePath: configured, label: 'the configured browser' };
  }

  const found = findInstalledBrowser({ platform: process.platform, env, fileExists });
  if (!found) {
    throw new DebugBrowserError(
      'No installed Chrome, Chromium, Edge or Brave was found on this machine.',
      'Install one of them, set AI_WEB_BROWSER_PATH to the one you want used, or start a ' +
        `browser yourself with --remote-debugging-port=${port} --user-data-dir="${profileDir}".`
    );
  }
  return found;
}

async function waitForPort(
  port: number,
  env: NodeJS.ProcessEnv,
  onWaiting?: (secondsWaited: number) => void
): Promise<DebugBrowserStatus> {
  const startedAt = Date.now();
  const expiry = startedAt + STARTUP_WAIT_MS;
  let announced = 0;
  for (;;) {
    const status = await probeDebugBrowser(port, env);
    if (status.running) return status;
    if (Date.now() >= expiry) return status;
    // Said out loud, because the alternative is 45s of nothing per browser -
    // and with several registered that is minutes of a terminal that looks
    // hung, which is how an operator ctrl-Cs into a half-started state.
    const waited = Math.floor((Date.now() - startedAt) / 1000);
    if (onWaiting && waited >= announced + 5) {
      announced = waited;
      onWaiting(waited);
    }
    await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS));
  }
}

/**
 * Opens a tab for a site a running browser has none for.
 *
 * `PUT /json/new?<url>` is the DevTools endpoint for it. A site that already has
 * a tab is left alone: that tab is where the operator signed in, and replacing
 * it would cost them the conversation for no gain.
 */
async function openMissingTab(
  port: number,
  status: DebugBrowserStatus,
  siteId: ChatSiteId,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const site = status.sites.find((entry) => entry.id === siteId);
  if (!site || site.open) return;
  const url = readChatSite(siteId, env).url;
  await new Promise<void>((resolve) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'PUT',
        path: `/json/new?${encodeURIComponent(url)}`,
        timeout: TAB_REQUEST_TIMEOUT_MS,
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve());
      }
    );
    request.on('timeout', () => request.destroy());
    // A tab that will not open is not worth failing the whole launch for: the
    // browser IS up, and the status reported below shows the site as not open.
    request.on('error', () => resolve());
    request.end();
  });
}

export type LaunchOutcome = {
  siteId: ChatSiteId;
  port: number;
  /** True when a browser was ALREADY listening and nothing was launched. */
  reused: boolean;
  browserLabel: string;
  profileDir: string;
  status: DebugBrowserStatus;
};

export async function launchOne(input: {
  siteId: ChatSiteId;
  port: number;
  profileDir?: string;
  env?: NodeJS.ProcessEnv;
  onWaiting?: (secondsWaited: number) => void;
}): Promise<LaunchOutcome> {
  const env = input.env ?? process.env;
  const port = assertUsablePort(input.port);
  if (!isChatSiteId(input.siteId)) {
    throw new DebugBrowserError(
      `"${String(input.siteId)}" is not a chat site this app knows.`,
      'Choose one of: claude-web, chatgpt-web.'
    );
  }
  const profileDir = input.profileDir?.trim() || defaultProfileDirFor(port);

  // Already up: do NOT start a second one. Chrome would either refuse the port
  // or - worse - quietly open a tab in the existing window and exit, which looks
  // like success and leaves the operator wondering why nothing changed.
  const existing = await probeDebugBrowser(port, env);
  if (existing.running) {
    await openMissingTab(port, existing, input.siteId, env);
    return {
      siteId: input.siteId,
      port,
      reused: true,
      browserLabel: existing.browser ?? 'a browser',
      profileDir,
      status: await probeDebugBrowser(port, env),
    };
  }

  const found = resolveLaunchBrowser(env, profileDir, port);
  const url = readChatSite(input.siteId, env).url;
  const child = spawn(found.executablePath, buildBrowserArgv({ port, profileDir, url, env }), {
    // Detached, because the browser has to outlive this script - the operator
    // signs in to it by hand afterwards, and closing the terminal must not close
    // the window they just signed in to. stdio ignored for the same reason: a
    // pipe nobody drains fills and blocks the child.
    detached: true,
    stdio: 'ignore',
  });

  const spawnFailure = await new Promise<Error | null>((resolve) => {
    const onError = (error: Error): void => resolve(error);
    child.once('error', onError);
    setTimeout(() => {
      child.removeListener('error', onError);
      resolve(null);
    }, 250);
  });

  if (spawnFailure) {
    throw new DebugBrowserError(
      `Could not start ${found.label}: ${spawnFailure.message}`,
      `Check that ${found.executablePath} is still there and this user may run it.`
    );
  }

  child.unref();

  let status = await waitForPort(port, env, input.onWaiting);
  if (status.running) {
    await openMissingTab(port, status, input.siteId, env);
    status = await probeDebugBrowser(port, env);
  }
  if (!status.running) {
    throw new DebugBrowserError(
      `${found.label} was started but nothing is listening on port ${port}.`,
      'The commonest cause is another copy of that browser already running with the same ' +
        'profile directory: Chrome then opens a tab in the existing window and never opens the ' +
        'port. Close every window of that browser and try again. If it was simply slow to ' +
        'start, running this again picks up the window that is now running rather than opening ' +
        'a second one.'
    );
  }

  return {
    siteId: input.siteId,
    port,
    reused: false,
    browserLabel: found.label,
    profileDir,
    status,
  };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function describe(endpoint: BrowserChatEndpoint): string {
  return `${getProviderLabel(endpoint.siteId)} on port ${endpoint.port}`;
}

/**
 * The registered browser list, without letting a read create or break anything.
 *
 * `getBrowserChatEndpoints` goes through `readSettings`, and that path does
 * three things a launcher must not inherit. It opens the database, which
 * CREATES it - schema and migrations and all - so running this with DB_DIR
 * unset or pointed somewhere else quietly makes an empty database and then
 * starts the .env defaults while looking as though it honoured a saved list.
 * It can WRITE, because the stored-key purge saves the row back. And it
 * asserts an enabled provider and a runnable model, so an unrelated bad model
 * row throws and takes the launcher with it.
 *
 * None of those should stop an operator starting a browser. So: no database,
 * no read; a read that throws falls back to the .env defaults and says so.
 */
async function readRegisteredEndpoints(quiet = false): Promise<BrowserChatEndpoint[]> {
  const databasePath = getDatabasePath();
  if (!fs.existsSync(databasePath)) {
    // Quiet when the caller is about to WRITE this list rather than act on it.
    // Otherwise registering a browser prints "nothing is registered yet" a line
    // before "registered", which reads like a contradiction.
    if (!quiet) {
      console.warn(`[browser] No database at ${databasePath}, so nothing is registered yet.`);
      console.warn('[browser] Using the .env defaults. Register browsers under Admin -> Settings,');
      console.warn('[browser] or name one here: npm run browser:debug -- --port 9222 --site claude-web');
    }
    return getBrowserChatEnvDefaults();
  }

  try {
    return await getBrowserChatEndpoints();
  } catch (error) {
    if (!quiet) {
      console.warn(
        `[browser] Could not read the saved browser list (${
          error instanceof Error ? error.message : String(error)
        }); using the .env defaults.`
      );
    }
    return getBrowserChatEnvDefaults();
  }
}

/**
 * Which browsers to start.
 *
 * The REGISTERED LIST by default, which is the point of registering them: the
 * providers read that same list to decide where to send a request, so starting
 * from it is the only way the two cannot disagree. `--port`/`--site` override it
 * for a one-off, and register what they started so the providers know about it -
 * a browser running on a port the app has never heard of is a browser nothing
 * will use.
 */
async function resolveTargets(): Promise<{ targets: BrowserChatEndpoint[]; register: boolean }> {
  const portFlag = flag('port');
  const siteFlag = flag('site');

  if (!portFlag && !siteFlag) {
    return { targets: await readRegisteredEndpoints(), register: false };
  }

  if (!portFlag || !siteFlag) {
    throw new DebugBrowserError(
      '--port and --site go together.',
      'One browser shows one chat tab, so a port belongs to exactly one site: ' +
        'npm run browser:debug -- --port 9333 --site chatgpt-web'
    );
  }

  const port = assertUsablePort(portFlag);
  if (!isChatSiteId(siteFlag)) {
    throw new DebugBrowserError(
      `"${siteFlag}" is not a chat site this app knows.`,
      'Choose one of: claude-web, chatgpt-web.'
    );
  }

  const target: BrowserChatEndpoint = { siteId: siteFlag, port };
  return { targets: [target], register: !hasFlag('no-register') };
}

/**
 * Records a browser in the list the providers read.
 *
 * Called only AFTER the browser is up, which is the whole ordering question:
 * registering first would leave a port in the list that nothing is listening
 * on, and the providers would then hand requests to it and retry their way
 * around a browser that never started.
 *
 * A port owns its site outright - one browser, one chat tab - so a row for this
 * port under a different site is replaced rather than kept beside it.
 */
async function registerEndpoint(target: BrowserChatEndpoint): Promise<boolean> {
  const current = await readRegisteredEndpoints(true);
  if (current.some((entry) => entry.siteId === target.siteId && entry.port === target.port)) {
    return false;
  }
  await updateAppSettings({
    browserChatEndpoints: [...current.filter((entry) => entry.port !== target.port), target],
  });
  return true;
}

async function main(): Promise<number> {
  if (hasFlag('help') || hasFlag('h')) {
    console.log(
      [
        'Start the Chrome windows the browser-chat providers attach to.',
        '',
        '  npm run browser:debug                                   every registered browser',
        '  npm run browser:debug -- --port 9333 --site claude-web  one, and register it',
        '  npm run browser:debug -- --port 9333 --site claude-web --no-register',
        '  npm run browser:debug -- --list                         show what is registered',
        '',
        'Sites: claude-web, chatgpt-web.',
        'Register browsers under Admin -> Settings -> Browser Chat (free).',
      ].join('\n')
    );
    return 0;
  }

  if (hasFlag('list')) {
    const endpoints = await readRegisteredEndpoints();
    if (endpoints.length === 0) {
      console.log('[browser] No browsers are registered.');
      return 0;
    }
    for (const endpoint of endpoints) {
      const status = await probeDebugBrowser(endpoint.port);
      const site = status.sites.find((entry) => entry.id === endpoint.siteId);
      const state = !status.running
        ? 'not running'
        : site?.open
          ? 'running, tab open'
          : 'running, no tab yet';
      console.log(`[browser] ${describe(endpoint)} - ${state}`);
    }
    return 0;
  }

  const { targets, register } = await resolveTargets();

  if (targets.length === 0) {
    console.error(
      [
        '[browser] No browsers are registered, so there is nothing to start.',
        '[browser] Register one under Admin -> Settings -> Browser Chat (free), or name it here:',
        '[browser]   npm run browser:debug -- --port 9222 --site claude-web',
      ].join('\n')
    );
    return 1;
  }

  console.log(`[browser] Starting ${targets.length} browser${targets.length === 1 ? '' : 's'}.`);

  let failures = 0;
  for (const target of targets) {
    // One at a time, not Promise.all. Each of these opens a window and several
    // of them racing for the foreground is how an operator ends up signing in to
    // the wrong one - and a cold Chrome profile is disk-bound anyway, so the
    // parallelism would buy little.
    console.log(`[browser]   ${describe(target)}: starting...`);
    try {
      const outcome = await launchOne({
        ...target,
        onWaiting: (seconds) =>
          console.log(
            `[browser]     still waiting for port ${target.port} (${seconds}s of ${
              STARTUP_WAIT_MS / 1000
            }s)`
          ),
      });
      const site = outcome.status.sites.find((entry) => entry.id === target.siteId);
      console.log(
        `[browser]   ${describe(target)}: ${outcome.reused ? 'already running' : `started ${outcome.browserLabel}`}` +
          `${site?.open ? ', tab open' : ', tab not open yet'}`
      );
      console.log(`[browser]     profile: ${outcome.profileDir}`);
      if (register && (await registerEndpoint(target))) {
        console.log(`[browser]     registered, so the providers will use it`);
      }
    } catch (error) {
      failures += 1;
      if (error instanceof DebugBrowserError) {
        console.error(`[browser]   ${describe(target)}: ${error.message}`);
        console.error(`[browser]     ${error.hint}`);
      } else {
        console.error(
          `[browser]   ${describe(target)}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  console.log('[browser]');
  console.log('[browser] Sign in to each chat tab IN THE WINDOW IT OPENED, and leave it open.');
  console.log('[browser] The backend attaches to these; it never starts one of its own.');
  console.log('[browser] Admin -> Settings -> Browser Chat (free) shows which are active.');

  return failures > 0 ? 1 : 0;
}

// Only when run as a script. Imported by the tests, which must not launch
// anything by requiring this file.
if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      if (error instanceof DebugBrowserError) {
        console.error(`[browser] ${error.message}`);
        console.error(`[browser] ${error.hint}`);
      } else {
        console.error(`[browser] ${error instanceof Error ? error.message : String(error)}`);
      }
      process.exitCode = 1;
    });
}
