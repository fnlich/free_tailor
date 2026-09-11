import http from 'http';
import { getProviderLabel } from '../config/providerCatalog';
import { readChatSite, type ChatSiteId } from './ai/providers/browserChat/sites';

/**
 * Reading the state of the browsers the chat providers attach to.
 *
 * READ-ONLY, and that is the whole design. This file used to start Chrome too,
 * from a Start button on the Settings page - so the backend spawned a desktop
 * process on an HTTP request. Launching now lives in
 * `src/scripts/launchDebugBrowsers.ts`, which the operator runs themselves, and
 * nothing reachable over HTTP can start a process any more.
 *
 * What is left is a probe: ask the DevTools HTTP endpoint on a registered port
 * whether a browser is answering, and which of this app's chat sites has a tab
 * open in it. It opens no sockets to anything but loopback, sends no commands,
 * and changes nothing.
 */

/** How long a probe waits for the DevTools endpoint to answer. */
const PROBE_TIMEOUT_MS = 1_500;

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
