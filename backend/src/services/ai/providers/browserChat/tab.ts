import {
  composePrompt,
  composerHolds,
  fingerprint,
  hostOf,
  INITIAL_POLL_STATE,
  isEcho,
  matchesHost,
  pickReply,
  poll,
  refusalReason,
  STABLE_READS_WITH_BUSY_SIGNAL,
  STABLE_READS_WITHOUT_BUSY_SIGNAL,
  unfamiliarText,
  usableBusySelectors,
  type ChatMessage,
  type Fingerprint,
  type Refusal,
} from './conversation';
import type { ChatPage } from './page';
import type { ChatSite } from './sites';

/**
 * `refused` is the site declining rather than the driver failing: a usage wall,
 * a rate limit, a signed-out tab, a captcha. Kept apart from `page` because the
 * two want opposite things done - one is waited out or routed to another
 * provider, the other is a selector to fix - and because only this one is
 * worth retrying later unchanged.
 */
export type ChatTurnErrorKind = 'page' | 'timeout' | 'empty' | 'echo' | 'refused' | 'cancelled';

export class ChatTurnError extends Error {
  readonly kind: ChatTurnErrorKind;
  /** Set on a `refused` that waiting alone would clear. */
  readonly retryable: boolean;

  constructor(kind: ChatTurnErrorKind, message: string, retryable = false) {
    super(message);
    this.name = 'ChatTurnError';
    this.kind = kind;
    this.retryable = retryable;
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

/**
 * How long a turn waits before asking the page why it is silent, and how often.
 *
 * The check reads the whole document's text, so it is not something to do every
 * poll. It also must not fire early: for the first seconds of a normal turn the
 * page legitimately shows no reply, and calling that a refusal would turn every
 * slow answer into a wrong diagnosis. By the time nothing has rendered for this
 * long, something IS wrong and it is worth naming.
 *
 * What it reads is filtered first - see `unfamiliarText`. The document contains
 * the prompt this app just typed, which is somebody's real resume, and matching
 * a usage wall against that is how a check meant to explain a failure becomes
 * one.
 */
const REFUSAL_CHECK_AFTER_MS = 12_000;
const REFUSAL_CHECK_EVERY_MS = 10_000;

/**
 * How much of the END of the page is read when looking for a refusal.
 *
 * Enough to hold a banner plus the tail of the prompt it sits below, since the
 * prompt's tail is what identifies the rest as the site's own words. Not the
 * whole document: `innerText` of a long transcript is a big string to move
 * across the wire every ten seconds, for a check that only ever needs the last
 * screenful.
 */
const REFUSAL_TEXT_CHARS = 6_000;

/**
 * Empty reads before a latched assistant selector is given up on.
 *
 * More than one, so a gap between renders does not cost the latch; small enough
 * that the turn still has most of its deadline left to use the replacement.
 */
const LATCH_MISSES_BEFORE_RELEASE = 3;

/**
 * Longest a new turn waits for an abandoned one to let go of the tab.
 *
 * Sized against the connection's protocol timeout, which is what actually
 * bounds the blocked call the abandoned turn is sitting in.
 */
const ABANDONED_WAIT_MS = 35_000;

/**
 * How long, and how closely, the turn watches for the stop control after a send.
 *
 * Long enough for a site that raises the control a few hundred milliseconds
 * after the request goes out; close enough to catch one that goes up and comes
 * down again inside a single ordinary poll. Both ends matter, and they pull in
 * opposite directions, which is why this is a short fine-grained watch rather
 * than one look at a fixed moment.
 */
const BUSY_WATCH_MS = 1_500;
const BUSY_WATCH_STEP_MS = 100;

function refusalError(site: ChatSite, refusal: Refusal): ChatTurnError {
  return new ChatTurnError(
    'refused',
    `${site.label} did not answer because ${refusal.reason}. ` +
      (refusal.retryable
        ? 'Wait for it to reset, or use another provider.'
        : `Open ${site.url} in the debug browser and put it right by hand.`),
    refusal.retryable
  );
}

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
  private warnedMultiple = false;

  /**
   * The assistant candidate this TURN is reading, fixed once one matches.
   *
   * Re-resolving per poll is the bug this exists to prevent: `before.count`
   * would be a count of one candidate's matches and the polled count another's,
   * so `messages[before.count]` indexes into a list the fingerprint never
   * described. A candidate list ordered specific-first makes that concrete -
   * `div[data-is-streaming]` matches only while a reply streams, so it wins the
   * lookup mid-answer and loses it once the attribute flips, silently changing
   * which nodes are being counted in the middle of the turn.
   *
   * Reset per turn rather than per tab, so a page redesign between calls is
   * picked up on the next one.
   */
  private assistantSelector: string | null = null;

  /** Consecutive polls on which the latched selector has matched nothing. */
  private assistantMisses = 0;

  /** The host the tab settled on for this turn, after any redirects. */
  private landedHost = '';

  /** A turn the guard walked away from, still running. See `ask`. */
  private abandoned: Promise<void> | null = null;

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
   * First candidate to APPEAR, within the budget.
   *
   * For the roles whose absence is fatal. A single-page app renders its
   * composer after `domcontentloaded`, so a look taken the instant a navigation
   * resolves reports a page with no message box on one that simply has not
   * painted yet.
   */
  private async waitForAny(candidates: string[], budgetMs: number): Promise<string | null> {
    const expiry = this.now() + budgetMs;
    for (;;) {
      const found = await this.firstMatch(candidates);
      if (found) return found;
      if (this.now() >= expiry) return null;
      await this.sleep(Math.min(250, this.pollMs));
    }
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
    // Sampled on a page that is IDLE. Run while an answer is streaming, the
    // site's real stop button is present and would be discarded as
    // "always true" - permanently, for the life of the tab - after which
    // nothing reports busy and every answer is taken at the first pause
    // between tokens. That is a truncated resume, silently.
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
    if (usable.length === 0) {
      // Worth saying out loud, because the turn still works and the operator
      // would otherwise never learn the safety net came off. Without a stop
      // control the only evidence an answer has finished is that it stopped
      // growing, so turns get slower and a long pause mid-answer becomes a way
      // to lose the tail of one.
      this.log(
        `[ai] ${this.site.id}: no usable "still generating" selector. Answers will be read only ` +
          'once the text has stopped changing for several seconds, which is slower and less ' +
          `certain. Set the busy selector override for ${this.site.label}.`
      );
    }
    this.busySelectors = usable;
    return usable;
  }

  /**
   * Whether the stop control shows at all in the moments after a send.
   *
   * Returns as soon as it does. Its only job is to establish that the busy
   * selector WORKS, so that its later absence can be read as evidence the
   * answer is finished rather than as a selector that never matches anything.
   */
  private async watchForBusy(budgetMs: number): Promise<boolean> {
    // Nothing to watch for. Screening has already established that not one of
    // this site's busy candidates means anything on this page, so the answer is
    // known and waiting 1.5s to hear it again only delays the turn - and, since
    // an empty candidate list makes `isBusy` read nothing at all, a caller
    // whose clock advances on page reads would never leave this loop.
    if ((this.busySelectors ?? this.site.busy).length === 0) return false;

    const expiry = this.now() + budgetMs;
    for (;;) {
      if (await this.isBusy()) return true;
      if (this.now() >= expiry) return false;
      await this.sleep(Math.min(BUSY_WATCH_STEP_MS, this.pollMs));
    }
  }

  private async isBusy(): Promise<boolean> {
    const candidates = this.busySelectors ?? this.site.busy;
    for (const candidate of candidates) {
      if ((await this.page.count(candidate)) > 0) return true;
    }
    return false;
  }

  /**
   * The assistant messages on the page, always read through ONE selector.
   *
   * The first call of a turn resolves the candidate; every call after it reads
   * the same one. See `assistantSelector` for why that matters.
   */
  private async readMessages(): Promise<ChatMessage[] | null> {
    const selector = this.assistantSelector ?? (await this.firstMatch(this.site.assistant));
    if (!selector) return [];
    this.assistantSelector = selector;
    return this.page.messages(selector, this.site.messageIdAttr);
  }

  /**
   * Lets go of a latched selector that has stopped matching anything.
   *
   * The latch is what keeps the count and the list coming from one place, but
   * held unconditionally it becomes its own failure: a candidate that matched
   * when the turn opened and then disappeared - a container the site swaps out
   * as the conversation starts - leaves the turn reading a selector that can
   * never return anything again, and it waits out the whole deadline with the
   * answer plainly on the page.
   *
   * Released only after several consecutive empty reads, and only when some
   * OTHER candidate is matching, so an ordinary gap between renders does not
   * cost the latch. The fingerprint is re-taken against the new selector,
   * because a count from the old one describes nothing in the new list. That
   * trades one failure for a smaller one: if the reply had already rendered it
   * is now counted as pre-existing and the turn times out - exactly what it did
   * before - while in every other case the turn recovers.
   */
  private async releaseStaleLatch(): Promise<Fingerprint | null> {
    if (!this.assistantSelector) return null;
    if ((await this.page.count(this.assistantSelector)) > 0) {
      this.assistantMisses = 0;
      return null;
    }
    this.assistantMisses += 1;
    if (this.assistantMisses < LATCH_MISSES_BEFORE_RELEASE) return null;

    const stale = this.assistantSelector;
    this.assistantSelector = null;
    this.assistantMisses = 0;
    const replacement = await this.firstMatch(this.site.assistant);
    if (!replacement || replacement === stale) {
      this.assistantSelector = replacement;
      return null;
    }
    this.log(
      `[ai] ${this.site.id}: "${stale}" stopped matching mid-answer; reading "${replacement}" ` +
        'instead for the rest of this turn.'
    );
    this.assistantSelector = replacement;
    const rebased = await this.readMessages();
    // A failed read is not a baseline. Keep the old one and try again next poll
    // rather than recording a count that describes nothing.
    return rebased ? fingerprint(rebased) : null;
  }

  /**
   * Where the tab has gone, if it is no longer on the site.
   *
   * A tab the operator clicks a link in mid-turn is not slow, it is gone - but
   * it looks identical to slow from here, so the turn would poll a page that
   * can never answer until the deadline and then blame the selectors.
   *
   * Taken from the URL actually being loaded rather than `site.host`, so a
   * malformed URL override degrades to skipping the check instead of failing
   * every turn: `readChatSite` falls back to the built-in host when it cannot
   * parse one, and a check that then disagreed with the tab lookup would reject
   * the very tab that lookup had just chosen. Only meaningful for a site
   * addressed by host at all - one pointed at a `file:` or `data:` URL has none
   * to compare, which is also the shape the tests use.
   */
  private async navigatedAway(): Promise<string | null> {
    const anchor = this.landedHost || hostOf(this.site.url);
    if (!anchor) return null;
    const current = this.page.currentUrl();
    const host = hostOf(current);
    if (matchesHost(host, anchor)) return null;

    // A different host is NOT yet evidence of anything, and treating it as such
    // is how this check becomes worse than not having it. These sites bounce a
    // new conversation between names of their own - apex to www, an identity
    // host and back, a migration to a new domain entirely - and some of that
    // happens client-side, a beat after the page has loaded, which no snapshot
    // taken at the start of the turn can anticipate. Judging by name alone, the
    // day a site changes where it redirects to is the day every call fails.
    //
    // So ask the page instead of the address bar. A tab that merely followed
    // its own redirect still has the composer this app just typed into; a tab
    // that went somewhere else does not. That is the thing actually being
    // asked - can this page still answer - rather than a proxy for it.
    const stillTheSite = await this.firstMatch(this.site.composer);
    if (stillTheSite) {
      this.landedHost = host;
      return null;
    }
    // Host only. The full address of a chat page carries the conversation id,
    // and this string goes into an error that is written to the server log.
    return host || 'a page with no address of its own';
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
        // A read that failed is not an empty transcript. Fall through to the
        // reload, which is the path that always works.
        if ((await this.readMessages())?.length === 0) return;
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
    // Waited for, not sampled. `startFreshConversation` may have just reloaded,
    // and `domcontentloaded` fires long before either of these single-page apps
    // has rendered its composer - so an instantaneous look finds nothing and
    // fails the turn on a page that was about to be perfectly fine.
    const composer = await this.waitForAny(this.site.composer, this.actionMs);
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
  async ask(body: string, deadlineMs: number, signal?: AbortSignal): Promise<string> {
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

    // An abandoned predecessor is waited out before this turn touches anything.
    //
    // When the guard below wins, `turn()` is not cancelled - nothing can cancel
    // a DevTools call already in flight - it is merely walked away from, and it
    // keeps driving the tab until that call returns. The caller meanwhile
    // treats the turn as over and releases its slot, so the next request starts
    // typing into a composer the abandoned turn is still clearing. Both answers
    // are lost, and neither caller is told.
    //
    // It is bounded: the abandoned turn's own deadline has already passed, so
    // it exits at its next loop check, and the blocked call it is sitting in is
    // capped by the connection's protocol timeout.
    await this.awaitAbandoned(deadlineMs);

    const running = this.turn(body, deadlineMs, signal);
    // Held so the NEXT turn can wait for this one if the guard walks away from
    // it, and swallowed here so that walking away does not raise an unhandled
    // rejection when the blocked call finally fails.
    this.abandoned = running.then(
      () => undefined,
      () => undefined
    );

    try {
      return await Promise.race([running, guard]);
    } finally {
      // Cleared either way: left running, the timer keeps the process alive
      // long after a turn that already answered.
      if (timer) clearTimeout(timer);
    }
  }

  private async awaitAbandoned(deadlineMs: number): Promise<void> {
    const pending = this.abandoned;
    if (!pending) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = Symbol('gaveUp');
    const waited = await Promise.race([
      pending.then(() => undefined),
      new Promise<typeof gaveUp>((resolve) => {
        timer = setTimeout(() => resolve(gaveUp), Math.min(deadlineMs, ABANDONED_WAIT_MS));
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (waited === gaveUp) {
      throw new ChatTurnError(
        'page',
        `the previous ${this.site.label} turn is still driving its tab and has not let go. ` +
          'Check that tab in the debug browser; if it is stuck, closing it lets this recover.'
      );
    }
    this.abandoned = null;
  }

  private async turn(body: string, deadlineMs: number, signal?: AbortSignal): Promise<string> {
    const prompt = composePrompt(body, this.site.nudge);
    const expiry = this.now() + deadlineMs;

    // Before anything is read: a background tab is frozen, and every DOM read
    // against a frozen renderer blocks instead of returning.
    await this.page.activate();

    // Cleared BEFORE anything reads the page, not after. `startFreshConversation`
    // asks "did the new-chat click actually empty the transcript?", and it asks
    // through `readMessages` - so a latch left over from the previous turn
    // decides the answer to that question using a selector chosen against a
    // conversation that no longer exists.
    this.assistantSelector = null;
    this.assistantMisses = 0;

    await this.startFreshConversation();
    if (this.busySelectors === null) await this.screenBusySelectors();

    // Where the tab ended up once the site had finished redirecting. Everything
    // after this point is judged against THIS host.
    this.landedHost = hostOf(this.page.currentUrl());

    const opening = await this.readMessages();
    if (!opening) {
      // Refused rather than guessed. This count decides which message is this
      // turn's reply; recorded wrongly as zero, the first message already on
      // screen becomes the answer this app hands back - a wrong answer, with
      // nothing anywhere to notice it.
      throw new ChatTurnError(
        'page',
        `could not read the ${this.site.label} transcript before sending. The tab may be busy ` +
          'or closing; try again.'
      );
    }
    let before: Fingerprint = fingerprint(opening);

    // What the page said BEFORE this app typed anything into it. Together with
    // the prompt itself, this is everything the refusal check must ignore -
    // see `unfamiliarText`, and note that without it the check reads the
    // operator's own resume and can find a usage wall in it.
    const pageBefore = await this.page.visibleTailText(REFUSAL_TEXT_CHARS);

    // A wall that is ALREADY up is caught here, before anything is typed.
    //
    // Two reasons to look now rather than only later. It is the one moment the
    // page can be read without the prompt on it, so nothing has to be filtered
    // out - and once the wall is in `pageBefore`, the filter would treat it as
    // known and never report it at all. And it is the difference between
    // failing a call and typing somebody's resume and salary history into a
    // page that was never going to answer.
    const standing = refusalReason(pageBefore);
    if (standing) throw refusalError(this.site, standing);

    if (this.now() >= expiry) {
      // Nothing is sent on a budget that is already gone. The prompt is tens of
      // thousands of characters of somebody's resume, and putting it into a
      // conversation whose answer will be thrown away leaves it in that
      // account's history for nothing.
      throw new ChatTurnError(
        'timeout',
        `no time left to ask ${this.site.label}: the budget was spent before the prompt was sent`
      );
    }

    await this.submit(prompt);

    let state = INITIAL_POLL_STATE;
    let latched: string | null = null;
    let everRendered = false;
    /**
     * Has the stop control been seen at all this turn?
     *
     * The completion rule leans on `!busy`, and `!busy` is only evidence when
     * something CAN report busy. Until it has actually been observed once, the
     * absence of it is not a fact about the page - it is a selector that may
     * simply never match - so the turn falls back to demanding a much longer
     * run of unchanged reads.
     */
    let sawBusy = false;

    // Watched for closely, right after the send, rather than waited for.
    //
    // The stop control goes up a moment after the request leaves and comes
    // down the moment the answer lands, so a reply that finishes inside one
    // poll interval is never once seen to be busy - and the turn then treats a
    // perfectly good busy selector as though the site had renamed it, sitting
    // out the whole blind stability run for nothing. One look at a fixed moment
    // does not solve it either: too early and the control is not up yet, too
    // late and it is already gone.
    sawBusy = await this.watchForBusy(BUSY_WATCH_MS);

    let nextRefusalCheck = this.now() + REFUSAL_CHECK_AFTER_MS;

    while (this.now() < expiry) {
      await this.sleep(this.pollMs);
      // A caller that gave up - a closed browser tab on the builder page, a
      // cancelled batch - should stop the turn rather than have the operator's
      // browser driven for the rest of the deadline on its behalf.
      if (signal?.aborted) {
        // 'page', not 'timeout'. Nothing ran out of time - the caller went away,
        // usually because the browser tab that asked for this was closed - and
        // reporting it as a timeout tells whoever reads the log to raise a
        // per-call budget that was never the problem.
        throw new ChatTurnError('cancelled', `${this.site.label}: the request was cancelled`);
      }

      const elsewhere = await this.navigatedAway();
      if (elsewhere) {
        // Asked WHY before it is reported as merely where. The commonest reason
        // a chat tab leaves mid-answer is not somebody clicking a link - it is
        // the session expiring and the site bouncing the tab to a sign-in page.
        // "Navigated to accounts.example.com, leave the browser alone" is true
        // and useless; "the tab is signed out" is what has to be done about it.
        const bounced = refusalReason(await this.page.visibleTailText(REFUSAL_TEXT_CHARS));
        if (bounced) throw refusalError(this.site, bounced);
        throw new ChatTurnError(
          'page',
          `the ${this.site.label} tab was navigated to ${elsewhere} while it was answering. ` +
            'Leave the debug browser on the chat page, or give this app a tab of its own.'
        );
      }

      // Only while nothing has been committed to. Once a reply has been picked,
      // swapping the selector underneath it is the very thing the latch exists
      // to prevent.
      if (!everRendered) {
        const rebased = await this.releaseStaleLatch();
        if (rebased) before = rebased;
      }

      const busy = await this.isBusy();
      if (busy) sawBusy = true;
      const messages = await this.readMessages();
      // A read that failed says nothing about the page. Skipping the poll costs
      // one interval; treating it as an empty transcript would restart the
      // stability run and, worse, feed a bogus count into `pickReply`.
      if (!messages) continue;
      const picked = pickReply(before, messages, latched);

      // Gated on there being no ANSWER yet, not on there being no node.
      //
      // A container that renders before its text is the ordinary case on both
      // sites, and gating on the node alone switches this check off at that
      // moment - for the rest of the turn. A wall that appears a second later
      // then reads as an answer that never finishes, and the turn spends its
      // whole budget before reporting that the site was "still writing".
      const nothingYet = !picked || picked.reply.text.trim().length === 0;
      if (nothingYet && this.now() >= nextRefusalCheck) {
        nextRefusalCheck = this.now() + REFUSAL_CHECK_EVERY_MS;
        const refusal = refusalReason(
          unfamiliarText(await this.page.visibleTailText(REFUSAL_TEXT_CHARS), [pageBefore, prompt])
        );
        if (refusal) throw refusalError(this.site, refusal);
      }

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

      // A second new message alongside the one committed to.
      //
      // The turn deliberately takes the FIRST message that was not there
      // before, because when a site streams two candidate answers side by side
      // their order flips while both are growing and "the last message" never
      // settles. But that choice is only right while the extra nodes ARE
      // alternative answers. If a site starts rendering a reasoning trace as a
      // separate node before the answer, the first new message is the trace and
      // this returns it as the reply - a wrong answer, of exactly the shape
      // nothing downstream can catch.
      //
      // Not guessed at, because guessing reintroduces the flipping. Said out
      // loud instead, once, so that a page whose shape no longer matches the
      // assumption is visible in the log rather than only in the output.
      if (!this.warnedMultiple && messages.length > before.count + 1) {
        this.warnedMultiple = true;
        this.log(
          `[ai] ${this.site.id}: this send produced ${messages.length - before.count} assistant ` +
            'messages, and the first is being read as the reply. If answers come back looking ' +
            `like reasoning or a preamble, narrow the assistant selector for ${this.site.label}.`
        );
      }

      const outcome = poll(
        state,
        picked.reply.text,
        busy,
        sawBusy ? STABLE_READS_WITH_BUSY_SIGNAL : STABLE_READS_WITHOUT_BUSY_SIGNAL
      );
      state = outcome.state;
      if (outcome.done) return outcome.done;
    }

    throw new ChatTurnError('timeout', this.timeoutReason(everRendered));
  }

  /**
   * Why the deadline passed, in the terms the operator has to act on.
   *
   * The three cases want three different things done, and the old single
   * message sent every one of them to check the selectors. "No node ever
   * matched" is the only one that is actually about selectors; "matched but
   * nothing new arrived" means the send did not land or the tab is signed out;
   * "still writing" means the answer is real and the budget was too small.
   */
  private timeoutReason(everRendered: boolean): string {
    if (everRendered) return `${this.site.label} was still writing when the deadline passed`;
    if (this.assistantSelector) {
      return (
        `${this.site.label} rendered no new message before the deadline, though ` +
        `"${this.assistantSelector}" does match the page. The prompt may not have been sent, or ` +
        'the tab may be signed out - open it in the debug browser and look.'
      );
    }
    return (
      `${this.site.label} showed no reply before the deadline, and none of its assistant ` +
      `selectors ${JSON.stringify(this.site.assistant)} matched anything at all. The tab may not ` +
      'be signed in, or the page markup has changed - set the assistant selector override.'
    );
  }
}
