import {
  composePrompt,
  composerHolds,
  fingerprint,
  INITIAL_POLL_STATE,
  isEcho,
  pickReply,
  poll,
  usableBusySelectors,
  type ChatMessage,
  type Fingerprint,
} from './conversation';
import type { ChatPage } from './page';
import type { ChatSite } from './sites';

export class ChatTurnError extends Error {
  readonly kind: 'page' | 'timeout' | 'empty' | 'echo';

  constructor(kind: 'page' | 'timeout' | 'empty' | 'echo', message: string) {
    super(message);
    this.name = 'ChatTurnError';
    this.kind = kind;
  }
}

export type ChatTabOptions = {
  /** How long any single UI action may take. */
  actionMs?: number;
  /** Gap between reads while waiting for the answer. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
};

const DEFAULT_ACTION_MS = 15_000;
const DEFAULT_POLL_MS = 1_500;

/**
 * How far past the deadline the outer guard waits.
 *
 * The polling loop owns the ordinary timeout, and its message is the useful
 * one - it can say whether a reply ever rendered, which points at a signed-out
 * tab or a stale selector. The guard exists only for the case the loop cannot
 * reach: a DevTools call that never returns at all. Firing them at the same
 * instant made the two race, and the guard's vaguer message won about half the
 * time. A short grace lets the specific error through whenever there is one.
 */
const GUARD_GRACE_MS = 5_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One chat tab, driven for one prompt at a time.
 *
 * The shape is taken from the miner in fnlich/scope, whose docstrings record
 * which parts were failure modes in production rather than caution: identify
 * the reply rather than reading "the last message", treat it as finished only
 * when the stop control is gone AND the text repeats, refuse a reply that is
 * the prompt coming back, and bound every wait - a chat UI will happily wait
 * forever for a node that a redesign renamed.
 */
export class ChatTab {
  private readonly page: ChatPage;
  private readonly site: ChatSite;
  private readonly actionMs: number;
  private readonly pollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  /** Busy candidates, once the always-true ones have been screened out. */
  private busySelectors: string[] | null = null;
  private warnedEcho = false;

  constructor(page: ChatPage, site: ChatSite, options: ChatTabOptions = {}) {
    this.page = page;
    this.site = site;
    this.actionMs = options.actionMs ?? DEFAULT_ACTION_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.warn(message));
  }

  /** First candidate present on the page right now, or null. */
  private async firstMatch(candidates: string[]): Promise<string | null> {
    for (const candidate of candidates) {
      if ((await this.page.count(candidate)) > 0) return candidate;
    }
    return null;
  }

  /**
   * Drops busy candidates that match an idle page.
   *
   * Run once against a page with no answer in flight. One that is always true
   * makes every reply look unfinished forever, which spends the whole deadline
   * on every call rather than failing fast on one.
   */
  async screenBusySelectors(): Promise<string[]> {
    const present: string[] = [];
    for (const candidate of this.site.busy) {
      if ((await this.page.count(candidate)) > 0) present.push(candidate);
    }
    const usable = usableBusySelectors(this.site.busy, present);
    for (const dropped of present) {
      this.log(
        `[ai] ${this.site.id}: busy selector "${dropped}" matches an idle page and was ignored; ` +
          'left in, every answer would look unfinished.'
      );
    }
    this.busySelectors = usable;
    return usable;
  }

  private async isBusy(): Promise<boolean> {
    const candidates = this.busySelectors ?? this.site.busy;
    for (const candidate of candidates) {
      if ((await this.page.count(candidate)) > 0) return true;
    }
    return false;
  }

  private async readMessages(): Promise<ChatMessage[]> {
    const selector = await this.firstMatch(this.site.assistant);
    if (!selector) return [];
    return this.page.messages(selector, this.site.messageIdAttr);
  }

  /**
   * A fresh conversation, so nothing earlier can steer this answer.
   *
   * The site's own new-chat control first, because it is an in-app transition
   * rather than a full page load. Nothing matching is not a failure: loading
   * the URL always works, so a stale candidate costs a second, not the turn.
   */
  async startFreshConversation(): Promise<void> {
    const control = await this.firstMatch(this.site.newChat);
    if (control) {
      try {
        await this.page.click(control, this.actionMs);
        await this.sleep(this.pollMs);
        if ((await this.readMessages()).length === 0) return;
      } catch {
        // Fall through to the reload, which is the path that always works.
      }
    }
    await this.page.goto(this.site.url, this.actionMs);
  }

  /**
   * Puts the prompt in the composer ALONE and presses send.
   *
   * The box is emptied, the text inserted, and then READ BACK and compared
   * before anything is submitted. That check is the point of the method: the
   * one thing it must never do is send a job description wrapped in the
   * remains of a previous prompt, which is a plausible-looking answer to a
   * question nobody asked.
   */
  private async submit(prompt: string): Promise<void> {
    const composer = await this.firstMatch(this.site.composer);
    if (!composer) {
      throw new ChatTurnError(
        'page',
        `no composer found on ${this.site.label}. Tried ${JSON.stringify(this.site.composer)}. ` +
          `Sign in to ${this.site.url} in the debug browser, or set the selector override.`
      );
    }

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await this.page.focus(composer, this.actionMs);
      await this.page.clearFocused();
      // insertText, never typing: a typed newline submits the half-written
      // prompt on both sites.
      await this.page.insertText(prompt);
      const seen = await this.page.readText(composer);
      if (composerHolds(prompt, seen)) break;
      if (attempt === 2) {
        throw new ChatTurnError('page', 'the composer does not hold the prompt as typed, twice over');
      }
      this.log(`[ai] ${this.site.id}: the composer did not hold the prompt; typing it again, once`);
    }

    const send = await this.firstMatch(this.site.send);
    if (!send) {
      // Both composers also submit on Enter. Safe here ONLY because the whole
      // prompt, newlines included, is already in the box.
      await this.page.pressEnter();
      return;
    }
    await this.page.click(send, this.actionMs);
  }

  /**
   * Sends one prompt and returns the finished reply.
   *
   * `deadlineMs` bounds the whole turn. A turn cut off by it throws rather than
   * returning what had arrived: this app's contract is that a completion is
   * never partial, and half a tailored resume parses as valid JSON far too
   * often to be caught downstream.
   */
  async ask(body: string, deadlineMs: number): Promise<string> {
    // Raced against the deadline as a whole, not just polled against it. The
    // loop below already stops at the deadline, but a single CDP call can block
    // past it - a frozen background tab never answers one at all - and this
    // app's contract is that a completion never outlives its budget.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new ChatTurnError(
            'timeout',
            `${this.site.label} stopped responding and did not answer within ` +
              `${Math.round((deadlineMs + GUARD_GRACE_MS) / 1000)}s. If its tab is in another ` +
              'window or minimised, Chrome may have frozen it.'
          )
        );
      }, deadlineMs + GUARD_GRACE_MS);
    });

    try {
      return await Promise.race([this.turn(body, deadlineMs), guard]);
    } finally {
      // Cleared either way: left running, the timer keeps the process alive
      // long after a turn that already answered.
      if (timer) clearTimeout(timer);
    }
  }

  private async turn(body: string, deadlineMs: number): Promise<string> {
    const prompt = composePrompt(body, this.site.nudge);
    const expiry = this.now() + deadlineMs;

    // Before anything is read: a background tab is frozen, and every DOM read
    // against a frozen renderer blocks instead of returning.
    await this.page.activate();
    await this.startFreshConversation();
    if (this.busySelectors === null) await this.screenBusySelectors();

    const before: Fingerprint = fingerprint(await this.readMessages());
    await this.submit(prompt);

    let state = INITIAL_POLL_STATE;
    let latched: string | null = null;
    let everRendered = false;

    while (this.now() < expiry) {
      await this.sleep(this.pollMs);
      const busy = await this.isBusy();
      const messages = await this.readMessages();
      const picked = pickReply(before, messages, latched);

      if (!picked) continue;
      everRendered = true;
      latched = picked.id;

      if (isEcho(prompt, picked.reply.text)) {
        if (!this.warnedEcho) {
          this.warnedEcho = true;
          this.log(
            `[ai] ${this.site.id}: an assistant selector is matching the message this app sent. ` +
              `Set the assistant selector override for ${this.site.label}; until then every answer ` +
              'would be the prompt handed back.'
          );
        }
        throw new ChatTurnError('echo', `${this.site.label} returned the prompt rather than an answer`);
      }

      const outcome = poll(state, picked.reply.text, busy);
      state = outcome.state;
      if (outcome.done) return outcome.done;
    }

    throw new ChatTurnError(
      'timeout',
      everRendered
        ? `${this.site.label} was still writing when the deadline passed`
        : `${this.site.label} showed no reply before the deadline. The tab may not be signed in, ` +
          'or the assistant selector may no longer match.'
    );
  }
}
