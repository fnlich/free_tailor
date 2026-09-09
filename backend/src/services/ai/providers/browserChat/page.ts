import type { Page } from 'puppeteer';
import type { ChatMessage } from './conversation';

/**
 * The narrow slice of a browser page this driver needs.
 *
 * Named as an interface rather than taking a puppeteer `Page` directly so the
 * turn logic can be driven against a fake in tests - the alternative is a suite
 * that needs a signed-in chatgpt.com, which is neither hermetic nor something
 * CI can have.
 */
export interface ChatPage {
  currentUrl(): string;
  /** Makes this the foreground tab. See `wrapPuppeteerPage`. */
  activate(): Promise<void>;
  goto(url: string, timeoutMs: number): Promise<void>;
  /** How many nodes this selector matches right now. */
  count(selector: string): Promise<number>;
  click(selector: string, timeoutMs: number): Promise<void>;
  focus(selector: string, timeoutMs: number): Promise<void>;
  /** Empties the focused composer, whatever kind of editor it is. */
  clearFocused(): Promise<void>;
  /** Inserts text without keystrokes, so newlines cannot submit early. */
  insertText(text: string): Promise<void>;
  pressEnter(): Promise<void>;
  readText(selector: string): Promise<string>;
  /**
   * The page's own visible text, capped.
   *
   * For reading what the site put up INSTEAD of an answer - a usage wall, a
   * sign-in prompt, a captcha - none of which has a selector worth depending
   * on. Capped because it is read on a page whose length nothing here controls.
   */
  visibleText(maxChars: number): Promise<string>;
  /** Every match's id and rendered text, in document order, in one round trip. */
  messages(selector: string, idAttribute: string | null): Promise<ChatMessage[]>;
}

/**
 * The select-all modifier THIS browser uses, asked of the browser itself.
 *
 * Control+A is not select-all on macOS - it is "move to start of line" - so a
 * mac run would leave the previous prompt in the composer and append to it.
 * The check is the browser's own platform rather than `process.platform`
 * because the two are not required to agree: the endpoint is configurable, and
 * `AI_WEB_CDP_URL` pointed at another machine is a supported way to run this.
 * Resolved once per page and remembered; a browser does not change platform.
 */
async function selectAllModifier(page: Page, cache: { value: 'Control' | 'Meta' | null }) {
  if (cache.value) return cache.value;
  let mac = false;
  try {
    mac = await page.evaluate(() => {
      const data = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
      const platform = data?.platform ?? navigator.platform ?? '';
      return /mac/i.test(platform);
    });
  } catch {
    // A page that will not evaluate is about to fail the turn for a better
    // reason. Control is right everywhere except macOS, so it is the guess to
    // make.
  }
  cache.value = mac ? 'Meta' : 'Control';
  return cache.value;
}

export function wrapPuppeteerPage(page: Page): ChatPage {
  const modifier: { value: 'Control' | 'Meta' | null } = { value: null };

  return {
    currentUrl: () => page.url(),
    /**
     * Bring the tab to the front before driving it.
     *
     * Not cosmetic - without it the driver HANGS. Chrome freezes background
     * tabs, and a frozen renderer never answers `Runtime.callFunctionOn`, so
     * the first DOM read blocks until puppeteer's protocol timeout rather than
     * returning. Measured: the same turn that takes 1.7s in a foreground tab
     * had not returned after 45s once a second tab was opened in front of it -
     * and a second tab is exactly what this app opens when it preflights the
     * OTHER browser provider at startup.
     *
     * The cost is real and worth naming: this steals focus in the operator's
     * browser for the length of a turn. That is why the debug browser is
     * documented as a separate window for this purpose rather than the one
     * they browse in.
     */
    activate: () => page.bringToFront(),
    goto: async (url, timeoutMs) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    },
    count: (selector) => page.$$(selector).then((nodes) => nodes.length),
    click: async (selector, timeoutMs) => {
      // Wait for it, then click the FIRST match. Clicking the handle rather
      // than the selector is what keeps a broad fallback candidate that
      // matches two nodes from throwing - and a throw here fails the turn.
      const handle = await page.waitForSelector(selector, { timeout: timeoutMs });
      if (!handle) throw new Error(`no node matched ${selector}`);
      await handle.click();
    },
    focus: async (selector, timeoutMs) => {
      await page.waitForSelector(selector, { timeout: timeoutMs });
      await page.focus(selector);
    },
    clearFocused: async () => {
      // Select-all then delete, rather than reading the length and pressing
      // Backspace: these composers are contenteditable, so a character count
      // is not a keystroke count once anything is formatted.
      //
      // Keystrokes rather than emptying the node from script, because both
      // composers are React-controlled: assigning to the value or the innerText
      // leaves the framework's own state holding the old prompt, which it then
      // puts back.
      const key = await selectAllModifier(page, modifier);
      await page.keyboard.down(key);
      await page.keyboard.press('KeyA');
      await page.keyboard.up(key);
      await page.keyboard.press('Backspace');
    },
    insertText: async (text) => {
      // `Input.insertText` over CDP, not `keyboard.type`: typing a newline
      // submits the half-written prompt on both sites, and a prompt this app
      // sends is many lines long. Puppeteer's Keyboard has no insert, so the
      // protocol command is used directly.
      const cdp = await page.createCDPSession();
      try {
        await cdp.send('Input.insertText', { text });
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    },
    pressEnter: () => page.keyboard.press('Enter'),
    readText: (selector) =>
      page
        .$eval(selector, (node) => (node as unknown as { innerText?: string }).innerText ?? '')
        .catch(() => ''),
    visibleText: (maxChars) =>
      page
        .evaluate((limit) => {
          // Reached through `globalThis` and typed by hand: this function is
          // serialised and run in the BROWSER, but it is compiled by the
          // backend's tsconfig, which has no DOM lib - and adding one would put
          // `document` in scope for every server file that has no business
          // touching it.
          const doc = (globalThis as unknown as { document?: { body?: { innerText?: string } } })
            .document;
          return (doc?.body?.innerText ?? '').slice(0, limit as number);
        }, maxChars)
        // Swallowed: this is read to EXPLAIN a turn that is already going
        // wrong, and a page too broken to evaluate must not replace that
        // explanation with an error of its own.
        .catch(() => ''),
    messages: (selector, idAttribute) =>
      page
        .$$eval(
          selector,
          (nodes, attribute) =>
            nodes.map((node) => {
              const element = node as unknown as {
                getAttribute(name: string): string | null;
                innerText?: string;
              };
              return {
                id: attribute ? element.getAttribute(attribute as string) : null,
                // innerText, not textContent: the answer is prose as rendered,
                // and textContent would run paragraphs and list items together
                // with no whitespace between them.
                text: element.innerText ?? '',
              };
            }),
          idAttribute
        )
        .catch(() => [] as ChatMessage[]),
  };
}
