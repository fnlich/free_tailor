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
  /**
   * Is the first match something a click would actually reach?
   *
   * Disabled, aria-disabled, or laid out with no box. The distinction matters
   * because a click on a disabled button is not an error: Chrome dispatches no
   * event at all and puppeteer returns happily, so the driver believes it sent
   * a prompt that is still sitting in the composer. Both chat sites keep their
   * send button disabled until the composer has content and re-enable it on a
   * React re-render, which is a race this app loses on a page under load.
   */
  isActionable(selector: string): Promise<boolean>;
  focus(selector: string, timeoutMs: number): Promise<void>;
  /** Empties the focused composer, whatever kind of editor it is. */
  clearFocused(): Promise<void>;
  /** Inserts text without keystrokes, so newlines cannot submit early. */
  insertText(text: string): Promise<void>;
  pressEnter(): Promise<void>;
  readText(selector: string): Promise<string>;
  /**
   * The END of the page's own visible text, capped.
   *
   * For reading what the site put up INSTEAD of an answer - a usage wall, a
   * sign-in prompt, a captcha - none of which has a selector worth depending
   * on. Capped because it is read on a page whose length nothing here controls.
   *
   * The end, not the beginning, and the difference is the whole feature. What
   * this app types into the composer is a resume and a job description: a real
   * one measures about 27,000 characters. Taken from the front, the window
   * closes some 23,000 characters before the prompt even finishes, so the
   * banner - which the site renders BELOW the prompt - is never once inside it.
   * Read from the front this returns nothing but the app's own text, which is
   * then filtered out as already known, and the check can never fire at all.
   */
  visibleTailText(maxChars: number): Promise<string>;
  /**
   * Every match's id and rendered text, in document order, in one round trip.
   *
   * Null means the READ FAILED, and it is a separate answer from the empty
   * list on purpose. The two mean opposite things to the caller that takes the
   * opening fingerprint: "no messages yet" is the normal state of a fresh
   * conversation, while "could not tell" must not be recorded as a count of
   * zero - that count is what decides which message is this turn's reply, and
   * a zero recorded by mistake makes the FIRST message already on screen the
   * answer this app returns.
   */
  messages(selector: string, idAttribute: string | null): Promise<ChatMessage[] | null>;
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
    isActionable: (selector) =>
      page
        // $$eval, not $eval: ANY match being clickable makes the candidate
        // usable. Judging only the first is wrong in the exact shape both sites
        // ship - a mobile and a desktop copy of the composer controls, one of
        // them hidden - where the hidden one comes first in document order and
        // the real one sits behind it. Measured on such a page: count 2,
        // first-match verdict false, and the driver then waits out its whole
        // enable budget on a button that was ready from the start.
        .$$eval(selector, (nodes) =>
          nodes.some((node) => {
            const element = node as unknown as {
              hasAttribute(name: string): boolean;
              getAttribute(name: string): string | null;
              getClientRects(): { length: number };
            };
            if (element.hasAttribute('disabled')) return false;
            if (element.getAttribute('aria-disabled') === 'true') return false;
            // No box means nothing to click: display:none, or a node the site
            // keeps in the tree for a state it is not currently in.
            return element.getClientRects().length > 0;
          })
        )
        // A selector that matches nothing is not actionable either, and that is
        // the caller's cue to try the next candidate rather than to fail.
        .catch(() => false),
    click: async (selector, timeoutMs) => {
      // Wait for it, then click the first CLICKABLE match - not simply the
      // first. A hidden duplicate ahead of the real control is the ordinary
      // shape of a responsive composer, and clicking it dispatches nothing at
      // all, which is indistinguishable from a site that did not answer.
      await page.waitForSelector(selector, { timeout: timeoutMs });
      const handles = await page.$$(selector);
      if (handles.length === 0) throw new Error(`no node matched ${selector}`);

      let target = handles[0];
      for (const handle of handles) {
        const usable = await handle
          .evaluate((node) => {
            const element = node as unknown as {
              hasAttribute(name: string): boolean;
              getAttribute(name: string): string | null;
              getClientRects(): { length: number };
            };
            return (
              !element.hasAttribute('disabled') &&
              element.getAttribute('aria-disabled') !== 'true' &&
              element.getClientRects().length > 0
            );
          })
          .catch(() => false);
        if (usable) {
          target = handle;
          break;
        }
      }

      // Bounded. `handle.click()` takes no timeout of its own, so it is capped
      // only by the connection-wide protocol timeout - and in a tab the browser
      // is not showing it does not return at all. Measured in a hidden tab:
      // every read came back in milliseconds and the click threw after 30s.
      // Left unbounded, the first click of a turn eats the whole budget.
      await Promise.race([
        target.click(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`clicking ${selector} did not return within ${timeoutMs}ms`)),
            timeoutMs
          )
        ),
      ]);
    },
    focus: async (selector, timeoutMs) => {
      await page.waitForSelector(selector, { timeout: timeoutMs });
      await page.focus(selector);
    },
    clearFocused: async () => {
      // Select-all then delete, rather than reading the length and pressing
      // Backspace: these composers are contenteditable, so a character count
      // is not a keystroke count once anything is formatted. And a keystroke
      // rather than emptying the node from script, because both composers are
      // React-controlled - assigning to the value or the innerText leaves the
      // framework's own state holding the old prompt, which it then puts back.
      //
      // The selection is asked for by NAME, through the protocol's `commands`,
      // not spelled as a chord. A chord has to be the right chord for the
      // platform, and the obvious pairing does not survive contact: measured
      // against Chrome 148, Control+A clears the box and Meta+A does not - it
      // raises `beforeinput` and then nothing at all, because puppeteer sends
      // the keystroke with no command attached and a Mac performs the editing
      // command, not the chord. Naming it sidesteps the question: this works
      // the same on Windows, macOS and Linux, and nothing here has to know
      // which one the browser is running on.
      const cdp = await page.createCDPSession();
      try {
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key: 'a',
          code: 'KeyA',
          windowsVirtualKeyCode: 65,
          commands: ['selectAll'],
        });
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'a',
          code: 'KeyA',
          windowsVirtualKeyCode: 65,
        });
      } finally {
        await cdp.detach().catch(() => undefined);
      }
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
    visibleTailText: (maxChars) =>
      page
        .evaluate((limit) => {
          // Reached through `globalThis` and typed by hand: this function is
          // serialised and run in the BROWSER, but it is compiled by the
          // backend's tsconfig, which has no DOM lib - and adding one would put
          // `document` in scope for every server file that has no business
          // touching it.
          const doc = (globalThis as unknown as { document?: { body?: { innerText?: string } } })
            .document;
          const text = doc?.body?.innerText ?? '';
          // slice(-limit), not slice(0, limit). See `visibleTailText`.
          return text.length > (limit as number) ? text.slice(-(limit as number)) : text;
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
                setAttribute(name: string, value: string): void;
                innerText?: string;
              };

              /**
               * An identity for a site that publishes none.
               *
               * claude.ai has no per-message attribute, so every id came back
               * null - which makes the reply LATCH dead code for it: pickReply
               * falls through to `messages[before.count]` and re-picks by
               * POSITION on every poll. Anything the site inserts at or above
               * that index mid-stream then becomes the answer. Measured: poll
               * one picks the reply, a reasoning panel appears above it, and
               * poll two returns "Thought for 4 seconds" as the completion.
               *
               * So the driver tags the node itself, once, and reads its own tag
               * afterwards. That is stable across reordering and insertion,
               * which is exactly what the latch needs. A node the site REPLACES
               * loses the tag and gets a new one - the same situation a site
               * with real ids is already in, and pickReply handles it.
               *
               * It writes one data attribute onto a message node in the
               * operator's page. Worth naming, and minor next to typing a
               * prompt into it.
               */
              const tagged = (): string => {
                const existing = element.getAttribute('data-free-tailor-msg');
                if (existing) return existing;
                const scope = globalThis as unknown as { __freeTailorMsgSeq?: number };
                scope.__freeTailorMsgSeq = (scope.__freeTailorMsgSeq ?? 0) + 1;
                const id = `ft-${scope.__freeTailorMsgSeq}`;
                element.setAttribute('data-free-tailor-msg', id);
                return id;
              };

              return {
                id: attribute ? element.getAttribute(attribute as string) : tagged(),
                // innerText, not textContent: the answer is prose as rendered,
                // and textContent would run paragraphs and list items together
                // with no whitespace between them.
                text: element.innerText ?? '',
              };
            }),
          idAttribute
        )
        // Null, not an empty list. See `messages` on the interface.
        .catch(() => null),
  };
}
