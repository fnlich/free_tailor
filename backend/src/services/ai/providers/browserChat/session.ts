import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';
import { wrapPuppeteerPage } from './page';
import { ChatTab, type ChatTabOptions } from './tab';
import type { ChatSite, ChatSiteId } from './sites';

/**
 * Attaching to a Chrome the operator started, rather than launching one.
 *
 * This is the whole design, and it is not an inconvenience to be engineered
 * away. A browser started by an automation driver announces itself as one -
 * `navigator.webdriver` is true and the build is distinctive - and sign-in
 * flows reject it; Google's answers "This browser or app may not be secure."
 * A browser the operator started is not in automation mode, and attaching to
 * it afterwards does not change that. So: they start Chrome with a debug port,
 * sign in by hand, and this connects.
 *
 *   Ubuntu:   google-chrome --remote-debugging-port=9222 \
 *               --user-data-dir="$HOME/.free-tailor-chrome"
 *   Windows:  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ^
 *               --remote-debugging-port=9222 ^
 *               --user-data-dir="%USERPROFILE%\\free-tailor-chrome"
 *
 * A separate `--user-data-dir` is deliberate: Chrome refuses to open a debug
 * port on a profile that is already running, so without one this only works
 * when every other Chrome window is closed.
 */

export const DEFAULT_DEBUG_PORT = 9222;

/** Longest any single DevTools command may take before it is a failure. */
const PROTOCOL_TIMEOUT_MS = 30_000;

export class BrowserSessionError extends Error {
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = 'BrowserSessionError';
    this.hint = hint;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function debugEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.AI_WEB_CDP_URL ?? '').trim();
  if (configured) return configured;
  const port = Number.parseInt((env.AI_WEB_CDP_PORT ?? '').trim(), 10);
  return `http://127.0.0.1:${Number.isFinite(port) && port > 0 ? port : DEFAULT_DEBUG_PORT}`;
}

function startupHint(endpoint: string): string {
  return (
    `Start Chrome with a debug port and sign in first, then retry:\n` +
    `  chrome --remote-debugging-port=${new URL(endpoint).port || DEFAULT_DEBUG_PORT} ` +
    `--user-data-dir=<a folder just for this>\n` +
    'Use a separate user-data-dir: Chrome will not open a debug port on a profile that is ' +
    'already running. Set AI_WEB_CDP_URL to point somewhere else.'
  );
}

/**
 * A connection to the operator's browser, held open between calls.
 *
 * Reconnecting per call would cost a round trip and, worse, lose the tab -
 * every call would land on whatever tab happened to be frontmost.
 */
export class BrowserChatSession {
  private browser: Browser | null = null;
  private readonly pages = new Map<ChatSiteId, Page>();
  private readonly tabs = new Map<ChatSiteId, ChatTab>();

  constructor(
    private readonly endpoint: string = debugEndpoint(),
    private readonly tabOptions: ChatTabOptions = {}
  ) {}

  private async connect(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    try {
      this.browser = await puppeteer.connect({
        browserURL: this.endpoint,
        // The operator's window is theirs; do not resize it to a viewport of
        // this app's choosing just because a page got driven.
        defaultViewport: null,
        // Puppeteer's default is 180s per protocol command, which is far longer
        // than any DOM read here should take and long enough that a wedged tab
        // looks like a hang rather than a failure.
        protocolTimeout: PROTOCOL_TIMEOUT_MS,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new BrowserSessionError(
        `Could not reach a debug browser at ${this.endpoint}: ${detail}`,
        startupHint(this.endpoint)
      );
    }
    this.browser.once('disconnected', () => {
      // A tab handle from a dead connection is not reusable, and reusing one
      // is how a driver ends up reporting healthy while answering nothing.
      this.browser = null;
      this.pages.clear();
      this.tabs.clear();
    });
    return this.browser;
  }

  /**
   * The tab showing this site, opening one if the browser has none.
   *
   * An existing tab is preferred over a new one because that is where the
   * operator signed in - and because leaving a trail of new tabs in somebody's
   * browser is rude.
   */
  private async pageFor(site: ChatSite): Promise<Page> {
    const held = this.pages.get(site.id);
    if (held && !held.isClosed()) return held;

    const browser = await this.connect();
    const open = await browser.pages();
    const existing = open.find((page) => {
      const host = hostOf(page.url());
      return host.length > 0 && host.endsWith(site.host);
    });

    const page = existing ?? (await browser.newPage());
    if (!existing) {
      await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    this.pages.set(site.id, page);
    this.tabs.delete(site.id);
    return page;
  }

  async tabFor(site: ChatSite): Promise<ChatTab> {
    const page = await this.pageFor(site);
    const held = this.tabs.get(site.id);
    if (held) return held;
    const tab = new ChatTab(wrapPuppeteerPage(page), site, this.tabOptions);
    this.tabs.set(site.id, tab);
    return tab;
  }

  /** Whether the browser is reachable and this site has a usable tab. */
  async probe(site: ChatSite): Promise<{ ok: boolean; detail: string; hint?: string }> {
    try {
      const page = await this.pageFor(site);
      const chatPage = wrapPuppeteerPage(page);
      for (const candidate of site.composer) {
        if ((await chatPage.count(candidate)) > 0) {
          // The hostname when there is one, the whole URL otherwise: a file://
          // or opaque URL has an empty hostname, and "Signed in at ." tells an
          // operator nothing about which tab was found.
          const where = hostOf(page.url()) || page.url();
          return { ok: true, detail: `Signed in at ${where}.` };
        }
      }
      return {
        ok: false,
        detail: `Reached ${page.url()} but found no message box.`,
        hint:
          `Sign in to ${site.url} in the debug browser. If you are signed in, the page's markup ` +
          'has changed - set the composer selector override.',
      };
    } catch (error) {
      if (error instanceof BrowserSessionError) {
        return { ok: false, detail: error.message, hint: error.hint };
      }
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, detail, hint: startupHint(this.endpoint) };
    }
  }

  /** Lets go of the operator's browser without closing it. */
  async dispose(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.pages.clear();
    this.tabs.clear();
    // `disconnect`, never `close`: closing would shut a window the operator
    // opened, signed into, and is probably still using.
    if (browser?.connected) await browser.disconnect();
  }
}
