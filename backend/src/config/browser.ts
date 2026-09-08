import fs from 'fs';
import os from 'os';
import path from 'path';
import puppeteer from 'puppeteer';
import type { Browser, LaunchOptions } from 'puppeteer';

/**
 * Finding a Chrome to render with.
 *
 * Puppeteer downloads its own Chrome from a postinstall script and remembers
 * where it put it, but nothing guarantees that download ever happened: an
 * `npm install --ignore-scripts`, a proxy that blocks the CDN, a puppeteer
 * upgrade that wants a newer build than the one in the cache, or a machine
 * where the cache directory was cleaned. The failure then surfaces at the
 * moment someone clicks Generate, as `Could not find Chrome (ver. ...)`, which
 * names a cache path and a version but not what to do about it.
 *
 * So the executable is resolved here, once, ahead of the click:
 *
 *   1. `PUPPETEER_EXECUTABLE_PATH` or `CHROME_PATH`, if set - an explicit
 *      choice always wins, and both names are ones people already reach for.
 *   2. Puppeteer's own download, when the file is actually on disk. This is
 *      the version puppeteer is built against, so it stays the default.
 *   3. A Chrome, Chromium, Edge or Brave already installed on the machine.
 *      Every Windows install has Edge, and it is the same rendering engine,
 *      so this turns a hard failure into a working PDF on the machines where
 *      the download did not happen.
 *
 * If none of those exist, the error says which command to run rather than
 * which cache directory was empty.
 */

export type BrowserSource =
  | 'PUPPETEER_EXECUTABLE_PATH'
  | 'CHROME_PATH'
  | 'puppeteer download'
  | 'installed browser';

export interface ResolvedBrowser {
  executablePath: string;
  source: BrowserSource;
  /** The browser's product name, for the installed-browser case. */
  label: string;
  /**
   * Whether the file is really there.
   *
   * Only ever false for an explicitly configured path, which is honoured
   * whether or not it exists - but saying so is the difference between the
   * startup log reporting a problem and reporting a browser that will fail on
   * the first click.
   */
  exists: boolean;
}

export interface BrowserResolutionDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  fileExists(candidate: string): boolean;
  /** Where puppeteer says its own download lives; it does not check the file. */
  puppeteerExecutablePath(): string | null;
}

interface BrowserCandidate {
  label: string;
  /** Path fragments, joined onto each of `roots`. */
  relative: string[];
  /** Environment variables naming a directory the browser installs under. */
  roots?: string[];
  /** Absolute paths, used as-is. */
  absolute?: string[];
}

/**
 * Where each Chromium-based browser puts its executable, per platform.
 *
 * Ordered by preference: real Chrome first, then Chromium, then the other
 * Chromium forks. Edge is last of the shipped-by-default browsers only
 * because Chrome is the engine puppeteer is tested against, not because it
 * works less well.
 */
const WINDOWS_CANDIDATES: BrowserCandidate[] = [
  {
    label: 'Google Chrome',
    roots: ['LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'ProgramW6432'],
    relative: ['Google', 'Chrome', 'Application', 'chrome.exe'],
  },
  {
    label: 'Chromium',
    roots: ['LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)'],
    relative: ['Chromium', 'Application', 'chrome.exe'],
  },
  {
    label: 'Microsoft Edge',
    roots: ['PROGRAMFILES(X86)', 'PROGRAMFILES', 'ProgramW6432', 'LOCALAPPDATA'],
    relative: ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
  },
  {
    label: 'Brave',
    roots: ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'],
    relative: ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
  },
];

const MACOS_CANDIDATES: BrowserCandidate[] = [
  {
    label: 'Google Chrome',
    roots: ['HOME'],
    relative: ['Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'],
    absolute: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  },
  {
    label: 'Chromium',
    roots: ['HOME'],
    relative: ['Applications', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    absolute: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
  },
  {
    label: 'Microsoft Edge',
    roots: ['HOME'],
    relative: ['Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'],
    absolute: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  },
  {
    label: 'Brave',
    roots: ['HOME'],
    relative: ['Applications', 'Brave Browser.app', 'Contents', 'MacOS', 'Brave Browser'],
    absolute: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  },
];

const LINUX_CANDIDATES: BrowserCandidate[] = [
  {
    label: 'Google Chrome',
    relative: [],
    absolute: [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/opt/google/chrome/chrome',
    ],
  },
  {
    label: 'Chromium',
    relative: [],
    absolute: [
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/lib/chromium/chromium',
    ],
  },
  {
    label: 'Microsoft Edge',
    relative: [],
    absolute: ['/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge'],
  },
  {
    label: 'Brave',
    relative: [],
    absolute: ['/usr/bin/brave-browser', '/usr/bin/brave'],
  },
];

function candidatesFor(platform: NodeJS.Platform): BrowserCandidate[] {
  if (platform === 'win32') return WINDOWS_CANDIDATES;
  if (platform === 'darwin') return MACOS_CANDIDATES;
  return LINUX_CANDIDATES;
}

/**
 * Every path a candidate could live at, in preference order.
 *
 * Joined with the separator of the TARGET platform, not the host's. Plain
 * `path.join` is the host's, which would build `C:\Program Files/Google/...`
 * anywhere but Windows - correct in production, silently wrong the moment the
 * Windows candidates are exercised from anywhere else, tests included.
 */
function expandCandidate(
  candidate: BrowserCandidate,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string[] {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const paths: string[] = [];
  for (const root of candidate.roots ?? []) {
    const base = env[root];
    if (base) paths.push(join(base, ...candidate.relative));
  }
  paths.push(...(candidate.absolute ?? []));
  return paths;
}

export function findInstalledBrowser(
  deps: Pick<BrowserResolutionDeps, 'platform' | 'env' | 'fileExists'>
): { executablePath: string; label: string } | null {
  for (const candidate of candidatesFor(deps.platform)) {
    for (const executablePath of expandCandidate(candidate, deps.platform, deps.env)) {
      if (deps.fileExists(executablePath)) {
        return { executablePath, label: candidate.label };
      }
    }
  }
  return null;
}

export function resolveBrowser(deps: BrowserResolutionDeps): ResolvedBrowser | null {
  for (const variable of ['PUPPETEER_EXECUTABLE_PATH', 'CHROME_PATH'] as const) {
    const configured = deps.env[variable]?.trim();
    if (!configured) continue;
    // An explicit setting is honoured even when the file is missing: silently
    // ignoring it and rendering with some other browser would be worse than
    // failing with the path the operator actually asked for. It is still
    // reported as broken rather than as a working browser.
    return {
      executablePath: configured,
      source: variable,
      label: 'configured browser',
      exists: deps.fileExists(configured),
    };
  }

  const downloaded = deps.puppeteerExecutablePath();
  if (downloaded && deps.fileExists(downloaded)) {
    return {
      executablePath: downloaded,
      source: 'puppeteer download',
      label: 'Chrome for Testing',
      exists: true,
    };
  }

  const installed = findInstalledBrowser(deps);
  if (installed) {
    return { ...installed, source: 'installed browser', exists: true };
  }

  return null;
}

/** What to tell someone who has no browser at all. */
export function describeMissingBrowser(deps: Pick<BrowserResolutionDeps, 'platform' | 'env'>): string {
  const join = deps.platform === 'win32' ? path.win32.join : path.posix.join;
  const cacheDir =
    deps.env.PUPPETEER_CACHE_DIR?.trim() ||
    join(deps.env.HOME || deps.env.USERPROFILE || '~', '.cache', 'puppeteer');
  const installedNames =
    deps.platform === 'win32'
      ? 'Chrome, Edge, Chromium or Brave'
      : 'Chrome, Chromium, Edge or Brave';

  return [
    'PDF rendering needs a Chrome to print with, and none was found.',
    `Puppeteer's own copy is not in ${cacheDir}, and no ${installedNames} is installed where this server looks.`,
    'Fix it with either:',
    '  npm run setup:browser              (downloads the Chrome puppeteer expects)',
    '  set CHROME_PATH=<path to chrome>   (uses a browser you already have)',
    'On the second option, put CHROME_PATH in the .env file to make it stick.',
  ].join('\n');
}

const defaultDeps: BrowserResolutionDeps = {
  platform: process.platform,
  env: process.env,
  fileExists: (candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  },
  puppeteerExecutablePath: () => {
    try {
      return puppeteer.executablePath() || null;
    } catch {
      // Thrown when puppeteer cannot work out a path at all, which is itself
      // just another way of saying it has no download to offer.
      return null;
    }
  },
};

let cached: ResolvedBrowser | null | undefined;

/** The browser this process will render with, resolved once. */
export function getResolvedBrowser(deps: BrowserResolutionDeps = defaultDeps): ResolvedBrowser | null {
  if (deps === defaultDeps) {
    if (cached === undefined) cached = resolveBrowser(deps);
    return cached;
  }
  return resolveBrowser(deps);
}

/** Forgets the cached resolution. For tests, and after installing a browser. */
export function resetResolvedBrowser(): void {
  cached = undefined;
}

export class BrowserUnavailableError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'BrowserUnavailableError';
    this.cause = options?.cause;
  }
}

/**
 * The args every launch shares.
 *
 * `--no-sandbox` is needed wherever the server runs as root - containers,
 * most CI - and is harmless elsewhere. The rest keep a headless Chrome from
 * spending time on things no rendering job needs.
 */
const SHARED_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
];

/**
 * The one place this server starts a browser.
 *
 * Every caller goes through here so that the executable is found the same way
 * and a missing browser reports the same, actionable thing wherever it is hit.
 */
export async function launchBrowser(options: LaunchOptions = {}): Promise<Browser> {
  const resolved = getResolvedBrowser();
  if (!resolved) {
    throw new BrowserUnavailableError(describeMissingBrowser(defaultDeps));
  }

  const { args = [], ...rest } = options;
  try {
    return await puppeteer.launch({
      headless: true,
      executablePath: resolved.executablePath,
      ...rest,
      args: [...SHARED_LAUNCH_ARGS, ...args],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BrowserUnavailableError(
      `Could not start ${resolved.label} at ${resolved.executablePath} (found via ${resolved.source}).\n` +
        `${detail}\n\n${describeMissingBrowser(defaultDeps)}`,
      { cause: error }
    );
  }
}

/** A one-line summary for the startup log and the health endpoint. */
export function describeBrowser(deps: BrowserResolutionDeps = defaultDeps): string {
  const resolved = getResolvedBrowser(deps);
  if (!resolved) return 'no Chrome found - PDF rendering will fail until one is installed';
  const missing = resolved.exists ? '' : ' - but there is no file there';
  return `${resolved.label} via ${resolved.source} (${resolved.executablePath})${missing}`;
}

/** Where a temporary Chrome profile should live, per process. */
export function browserProfileDir(name: string): string {
  return path.join(os.tmpdir(), `free-tailor-${name}-${process.pid}`);
}
