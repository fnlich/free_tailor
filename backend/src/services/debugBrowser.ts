import { spawn } from 'child_process';
import http from 'http';
import os from 'os';
import path from 'path';
import {
  BROWSER_CHAT_PORT_MAX,
  BROWSER_CHAT_PORT_MIN,
} from '../config/aiModelConfig';
import { findInstalledBrowser } from '../config/browser';
import { getProviderLabel } from '../config/providerCatalog';
import { readChatSite, type ChatSiteId } from './ai/providers/browserChat/sites';

/**
 * Starting the browser the chat providers attach to, from the Settings page.
 *
 * This spawns a process on the server, so it is worth being explicit about what
 * is and is not taken from the request. The EXECUTABLE is resolved by the same
 * resolver the rest of the app uses and never comes from the caller. The URLS
 * are this app's own configured chat sites, looked up by id from a two-entry
 * allowlist. The only caller-supplied value is the PORT, which is validated to
 * an integer in range before it is put in a flag - and nothing here goes near a
 * shell: `spawn` is given an argv array, so even a value that got past the
 * check would be one argument rather than a command.
 *
 * The rest of the design is inherited from `scripts/startDebugBrowser.js`, and
 * for the same reasons documented there: a profile directory of its own,
 * because Chrome ignores `--remote-debugging-port` on a profile that is already
 * running; the installed browser rather than puppeteer's, because sign-in flows
 * reject one in automation mode; and no `--remote-allow-origins`, because that
 * flag is what would let any web page the operator visits drive this browser
 * and read the accounts in it.
 */

export const DEFAULT_DEBUG_PROFILE_DIR = path.join(os.homedir(), '.free-tailor-chrome');

/** How long a probe waits for the DevTools endpoint to answer. */
const PROBE_TIMEOUT_MS = 1_500;

/** How long `start` waits for the port to come up before reporting back. */
const STARTUP_WAIT_MS = 12_000;
const STARTUP_POLL_MS = 300;

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
  // the parsed integer - but silently starting a browser on a port the operator
  // did not type is its own bug, and the same laxness in a place with a shell
  // behind it would be a much worse one. Refusing the input says what happened.
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

type JsonTab = { type?: string; url?: string; title?: string };

/** A GET against the DevTools HTTP endpoint, bounded and never proxied. */
function getJson<T>(port: number, route: string, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: '127.0.0.1',
        port,
        path: route,
        // Explicit: an HTTP_PROXY in the server's environment must not be
        // consulted for a call to the operator's own loopback interface.
        agent: new http.Agent({ keepAlive: false }),
        timeout: timeoutMs,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          resolve(null);
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body) as T);
          } catch {
            resolve(null);
          }
        });
      }
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

export type DebugSiteStatus = {
  id: ChatSiteId;
  label: string;
  url: string;
  /** A tab is open on this site's host. */
  open: boolean;
};

export type DebugBrowserStatus = {
  port: number;
  running: boolean;
  /** The browser's own version string, when one answered. */
  browser: string | null;
  sites: DebugSiteStatus[];
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function tabMatches(tabUrl: string, siteHost: string, siteUrl: string): boolean {
  // A site addressed by host is matched by host, so any conversation URL on it
  // counts - which is the whole point, since the tab the operator signed in to
  // is on /chat/<id> and not on the /new the site table names.
  if (siteHost) {
    const host = hostOf(tabUrl);
    if (!host) return false;
    return host === siteHost || host.endsWith(`.${siteHost}`);
  }
  // A site with no host at all - a `file:` or `data:` override, which is how
  // this is tested - has nothing to match on but the address itself. Without
  // this branch such a tab is reported as missing however plainly it is open,
  // and a second copy of it is opened on every start.
  if (!siteUrl) return false;
  const strip = (value: string) => value.split('#')[0];
  return strip(tabUrl) === strip(siteUrl);
}

const SITE_IDS: ChatSiteId[] = ['claude-web', 'chatgpt-web'];

export async function probeDebugBrowser(
  port: number,
  env: NodeJS.ProcessEnv = process.env
): Promise<DebugBrowserStatus> {
  const version = await getJson<{ Browser?: string }>(port, '/json/version', PROBE_TIMEOUT_MS);
  const sites = SITE_IDS.map((id) => {
    const site = readChatSite(id, env);
    return { id, label: getProviderLabel(id), url: site.url, host: hostOf(site.url), open: false };
  });

  if (!version) {
    return { port, running: false, browser: null, sites: sites.map(({ host, ...rest }) => rest) };
  }

  const tabs = (await getJson<JsonTab[]>(port, '/json/list', PROBE_TIMEOUT_MS)) ?? [];
  const pages = tabs.filter((tab) => tab.type === 'page' && typeof tab.url === 'string');
  for (const site of sites) {
    site.open = pages.some((tab) => tabMatches(tab.url as string, site.host, site.url));
  }

  return {
    port,
    running: true,
    browser: version.Browser ?? 'a browser',
    sites: sites.map(({ host, ...rest }) => rest),
  };
}

export type StartDebugBrowserInput = {
  port: number;
  /** Which chat sites to open tabs for. Ids only; the URLs are this app's. */
  siteIds?: ChatSiteId[];
  profileDir?: string;
  env?: NodeJS.ProcessEnv;
};

export type StartDebugBrowserResult = {
  started: boolean;
  /** True when a browser was ALREADY listening and nothing was launched. */
  reused: boolean;
  executable: string;
  browserLabel: string;
  profileDir: string;
  status: DebugBrowserStatus;
};

export async function startDebugBrowser(
  input: StartDebugBrowserInput
): Promise<StartDebugBrowserResult> {
  const env = input.env ?? process.env;
  const port = assertUsablePort(input.port);
  const profileDir = input.profileDir?.trim() || DEFAULT_DEBUG_PROFILE_DIR;
  const siteIds = (input.siteIds?.length ? input.siteIds : SITE_IDS).filter((id) =>
    SITE_IDS.includes(id)
  );

  // Already up: do NOT start a second one. Chrome would either refuse the port
  // or - worse - quietly open a tab in the existing window and exit, which
  // looks like success and leaves the operator wondering why nothing changed.
  const existing = await probeDebugBrowser(port, env);
  if (existing.running) {
    await openMissingTabs(port, existing, siteIds, env);
    return {
      started: false,
      reused: true,
      executable: '',
      browserLabel: existing.browser ?? 'a browser',
      profileDir,
      status: await probeDebugBrowser(port, env),
    };
  }

  const found = resolveLaunchBrowser(env, profileDir, port);

  // ONE url on the command line, and the rest opened over DevTools afterwards.
  //
  // Not a style choice: Chrome refuses to start with more than one URL argument
  // in headless mode - "Multiple targets are not supported in headless mode",
  // exit 13 - and headless is exactly the shape a containerised install runs
  // in. Opening the remainder through `/json/new` once the port is up behaves
  // identically in both modes, and is the same code path that adds a missing
  // tab to a browser that was already running.
  const urls = siteIds.map((id) => readChatSite(id, env).url).slice(0, 1);
  const child = spawn(
    found.executablePath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      // Loopback only, and no `--remote-allow-origins`. See the file docstring.
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      ...sanitizeBrowserArgs(env),
      ...urls,
    ],
    // Detached, because the browser has to outlive this HTTP request - the
    // operator signs in to it by hand afterwards. stdio ignored for the same
    // reason: a pipe nobody drains fills and blocks the child.
    { detached: true, stdio: 'ignore' }
  );

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

  let status = await waitForPort(port, env);
  if (status.running) {
    await openMissingTabs(port, status, siteIds, env);
    status = await probeDebugBrowser(port, env);
  }
  if (!status.running) {
    throw new DebugBrowserError(
      `${found.label} was started but nothing is listening on port ${port}.`,
      'The commonest cause is another copy of that browser already running with the same ' +
        'profile directory: Chrome then opens a tab in the existing window and never opens the ' +
        'port. Close every window of that browser and try again, or choose a different profile.'
    );
  }

  return {
    started: true,
    reused: false,
    executable: found.executablePath,
    browserLabel: found.label,
    profileDir,
    status,
  };
}


/**
 * Which browser to launch, and why not simply `CHROME_PATH`.
 *
 * `AI_WEB_BROWSER_PATH` is a separate variable on purpose. `CHROME_PATH` names
 * the browser this app RENDERS PDFs with, and on a lot of machines that is
 * puppeteer's Chrome for Testing - which is precisely the browser that must not
 * be used here, because sign-in flows reject one in automation mode and the
 * whole point of this window is that a human signs in to it. Honouring
 * CHROME_PATH would take the one setting most likely to be wrong for this job
 * and make it authoritative.
 *
 * Otherwise the standard install locations, via the same resolver the launcher
 * script uses.
 */
/**
 * Extra flags for an install that needs them, minus the one that must not come back.
 *
 * `AI_WEB_BROWSER_ARGS` exists for a real case: a backend in a container has no
 * display and no sandbox, and Chrome there needs `--headless=new --no-sandbox`
 * or it exits immediately. (A headless browser cannot be signed in to by hand,
 * so that configuration only makes sense against a profile that is already
 * signed in - but that is the operator's call to make, not this file's.)
 *
 * `--remote-allow-origins` is stripped whatever it is set to, and this is the
 * point of parsing the list rather than splatting it. That flag turns off the
 * DevTools origin check, which is the only thing stopping a web page the
 * operator visits from driving this browser and reading the accounts in it.
 * An escape hatch that can reopen the hole the rest of this file is built to
 * keep shut is not an escape hatch, it is the hole with extra steps.
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

function resolveLaunchBrowser(
  env: NodeJS.ProcessEnv,
  profileDir: string,
  port: number
): { executablePath: string; label: string } {
  const exists = (candidate: string): boolean => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('fs').statSync(candidate).isFile();
    } catch {
      return false;
    }
  };

  const configured = (env.AI_WEB_BROWSER_PATH ?? '').trim();
  if (configured) {
    if (!exists(configured)) {
      throw new DebugBrowserError(
        `AI_WEB_BROWSER_PATH points at ${configured}, and there is no file there.`,
        'Correct the path, or unset it to let this app find an installed browser on its own.'
      );
    }
    return { executablePath: configured, label: 'the configured browser' };
  }

  const found = findInstalledBrowser({ platform: process.platform, env, fileExists: exists });
  if (!found) {
    throw new DebugBrowserError(
      'No installed Chrome, Chromium, Edge or Brave was found on this machine.',
      'Install one of them, set AI_WEB_BROWSER_PATH to the one you want used, or start a ' +
        `browser yourself with --remote-debugging-port=${port} --user-data-dir="${profileDir}".`
    );
  }
  return found;
}

async function waitForPort(port: number, env: NodeJS.ProcessEnv): Promise<DebugBrowserStatus> {
  const expiry = Date.now() + STARTUP_WAIT_MS;
  for (;;) {
    const status = await probeDebugBrowser(port, env);
    if (status.running) return status;
    if (Date.now() >= expiry) return status;
    await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS));
  }
}

/**
 * Opens tabs for the sites a running browser has none for.
 *
 * `PUT /json/new?<url>` is the DevTools endpoint for it. Sites that already
 * have a tab are left alone: that tab is where the operator signed in, and
 * replacing it would sign them out of nothing but cost them the conversation.
 */
async function openMissingTabs(
  port: number,
  status: DebugBrowserStatus,
  siteIds: ChatSiteId[],
  env: NodeJS.ProcessEnv
): Promise<void> {
  for (const id of siteIds) {
    const site = status.sites.find((entry) => entry.id === id);
    if (!site || site.open) continue;
    const url = readChatSite(id, env).url;
    await new Promise<void>((resolve) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'PUT',
          path: `/json/new?${encodeURIComponent(url)}`,
          timeout: PROBE_TIMEOUT_MS,
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve());
        }
      );
      request.on('timeout', () => request.destroy());
      // A tab that will not open is not worth failing the whole call for: the
      // browser IS up, which is the thing that was asked for, and the status
      // returned to the caller will show the site as not open.
      request.on('error', () => resolve());
      request.end();
    });
  }
}
