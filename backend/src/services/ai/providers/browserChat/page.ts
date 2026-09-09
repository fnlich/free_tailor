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
  /** Every match's id and rendered text, in document order, in one round trip. */
  messages(selector: string, idAttribute: string | null): Promise<ChatMessage[]>;
}

export function wrapPuppeteerPage(page: Page): ChatPage {
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
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
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
