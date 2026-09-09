/**
 * The decisions a chat-driving turn has to make, separated from the browser.
 *
 * Everything here is a pure function over a snapshot of the page, so the rules
 * that are actually hard - which message is this send's reply, has it finished,
 * is the page handing our own prompt back - can be tested without a Chrome,
 * a login, or a network. `tab.ts` reads the page and calls these.
 */

/** One assistant message, as read off the page. */
export type ChatMessage = {
  /** The site's message id, where it has one. Null identifies by position. */
  id: string | null;
  text: string;
};

/** How the conversation looked before the prompt went in. */
export type Fingerprint = {
  count: number;
  lastId: string | null;
};

export function fingerprint(messages: ChatMessage[]): Fingerprint {
  return {
    count: messages.length,
    lastId: messages.length ? messages[messages.length - 1].id : null,
  };
}

/**
 * The reply to THIS send, latched so the rest of the turn reads the same one.
 *
 * One prompt can produce more than one assistant message - ChatGPT sometimes
 * streams two candidate answers side by side. Reading "the last message" then
 * means reading whichever branch is last at that instant, and while both are
 * streaming that flips, so the text never settles and the turn spends its whole
 * budget without ever seeing two identical reads. The FIRST message that was
 * not there before is committed to instead. With a single reply this is exactly
 * "the new message".
 *
 * `latchedId` survives the branches being reordered, which an index does not.
 */
export function pickReply(
  before: Fingerprint,
  messages: ChatMessage[],
  latchedId: string | null
): { reply: ChatMessage; id: string | null } | null {
  if (latchedId !== null) {
    const held = messages.find((message) => message.id === latchedId);
    // A missing latch is not proof the answer is gone: a chat UI re-renders a
    // streaming message and can swap its id underneath. Fall through to the
    // positional pick rather than giving up on the turn.
    if (held) return { reply: held, id: latchedId };
  }
  if (messages.length <= before.count) return null;
  const reply = messages[before.count];
  return { reply, id: reply.id };
}

/**
 * Is the page handing back the prompt we just sent?
 *
 * Only possible when an assistant selector also matches the user's own turn,
 * which is why no generic candidate is offered for that role. Left unguarded it
 * is a total failure that looks like a success: no error, no empty reply, just
 * a resume tailored to the instruction text instead of to the job.
 */
export function isEcho(sent: string, seen: string): boolean {
  // Folded the same way `composerHolds` folds it, and for the same reason: the
  // text on the page has been through a rich-text editor that curls the quotes
  // and turns ` - ` into an en dash. Comparing raw, a prompt handed straight
  // back fails to match its own first 80 characters, so the guard passes and
  // the echo is returned as the answer - which is the exact failure this
  // function exists to catch.
  const head = collapse(canonicalPunctuation(sent)).slice(0, 80);
  if (!head) return false;
  return collapse(canonicalPunctuation(seen)).startsWith(head);
}

function collapse(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(' ');
}

/**
 * Punctuation folded to one spelling, so a rich-text editor's autocorrect does
 * not read as somebody else's text.
 *
 * Both composers rewrite as you type: straight quotes become curly, ` - `
 * becomes an en dash, `...` becomes an ellipsis, and runs of spaces become
 * non-breaking ones. Every one of those is the SAME prompt. Straight and curly
 * quotes fold to the same character on purpose - the two are indistinguishable
 * as intent, and keeping them apart is what made the first version of this
 * reject a prompt that had arrived perfectly.
 */
function canonicalPunctuation(value: string): string {
  return value
    .replace(/[\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F"]/g, "'")
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/\u2026/g, '...');
}

/**
 * Did the composer keep the prompt as typed?
 *
 * The one check that must never be skipped: what it prevents is sending a job
 * description wrapped in the remains of a previous prompt, which comes back as
 * a confident answer to a question nobody asked.
 *
 * Compared on words and folded punctuation rather than on bytes, because the
 * editors rewrite as they go. The failure to avoid in BOTH directions: too
 * strict and it refuses a prompt that arrived intact, too loose and it sends
 * one that did not.
 */
export function composerHolds(typed: string, seen: string): boolean {
  const a = collapse(canonicalPunctuation(typed));
  const b = collapse(canonicalPunctuation(seen));
  if (a === b) return true;
  // A composer that renders markdown drops the syntax characters from what it
  // shows back, so compare again with them gone from both sides.
  const strip = (value: string) => value.replace(/[*_`#>~-]/g, '').replace(/\s+/g, ' ').trim();
  const strippedA = strip(a);
  return strippedA.length > 0 && strippedA === strip(b);
}

export type PollState = {
  /** The reply text at the previous poll, or null before the first read. */
  previous: string | null;
  /** How many consecutive polls have read exactly the same text. */
  stableReads: number;
};

export const INITIAL_POLL_STATE: PollState = { previous: null, stableReads: 0 };

export type PollOutcome = {
  state: PollState;
  /** The finished answer, or null while it is still arriving. */
  done: string | null;
};

/**
 * How many unchanged reads end a turn when the stop control is TRUSTED.
 *
 * One repeat, because `busy` is already carrying the argument: the site says
 * it has stopped generating and the text has not moved since. The repeat only
 * covers the beat between the stop button going and the last chunk painting.
 */
export const STABLE_READS_WITH_BUSY_SIGNAL = 1;

/**
 * How many unchanged reads end a turn when NOTHING ever reported busy.
 *
 * With no stop control the only evidence a reply has finished is that it
 * stopped growing, and a model pausing mid-answer looks exactly like that. One
 * repeat at a 1.5s poll means any pause over ~3s truncates the answer - and a
 * truncated tailored resume is still valid JSON, so nothing downstream catches
 * it. Eight repeats is ~12s of complete silence, which a streaming answer does
 * not do. The cost lands only on turns with no busy signal at all, and it is
 * latency rather than a wrong answer.
 */
export const STABLE_READS_WITHOUT_BUSY_SIGNAL = 8;

/**
 * One poll: has the reply finished?
 *
 * Finished means all three: the site is no longer showing a stop control, the
 * text is non-empty, and it read the same `requiredStableReads` times running.
 * The last is what separates a finished answer from a pause between tokens,
 * and it is why a busy check alone is not enough - both sites drop the stop
 * button a beat before the final chunk renders, so a reply taken on `!busy`
 * alone loses its last sentence. Which, for a tailored resume, is a silently
 * truncated one.
 *
 * `requiredStableReads` is a parameter because the whole rule rests on `busy`
 * being real. When no busy candidate has EVER matched - the site renamed its
 * stop button, or every candidate was screened out as always-true - `!busy` is
 * not a fact about the page, it is the absence of one, and the repeat count is
 * the only remaining evidence. The caller raises it in that case.
 */
export function poll(
  state: PollState,
  text: string,
  busy: boolean,
  requiredStableReads: number = STABLE_READS_WITH_BUSY_SIGNAL
): PollOutcome {
  const trimmed = text.trim();
  const stableReads = state.previous !== null && state.previous === trimmed ? state.stableReads + 1 : 0;
  const next: PollState = { previous: trimmed, stableReads };
  const required = Math.max(1, requiredStableReads);
  const done = !busy && trimmed.length > 0 && stableReads >= required ? trimmed : null;
  return { state: next, done };
}

/**
 * The site refusing to answer, read off the page it put up instead.
 *
 * A usage wall is not a slow answer, but it looks like one to everything else
 * here: no reply node ever appears, so the turn polls until the deadline and
 * then reports that the tab may not be signed in or the selector may have
 * changed. Both are wrong, and both send the operator to edit selectors that
 * were fine. Matched on the page's own text rather than a selector because
 * neither site gives these banners a stable hook, and the wording is the part
 * that has stayed put.
 */
export type Refusal = {
  reason: string;
  /**
   * Will waiting fix it?
   *
   * A usage limit resets on its own, so the call is worth retrying unchanged
   * and the caller should say so. A signed-out tab or a captcha needs a person
   * at the browser, and reporting THAT as "try again shortly" wastes the
   * operator's time on a queue that can never drain.
   */
  retryable: boolean;
};

const REFUSALS: Array<{ pattern: RegExp; refusal: Refusal }> = [
  {
    // `'` covers the curly apostrophe too: `canonicalPunctuation` folds it
    // before any of these are tried.
    pattern:
      /(reached|hit) (your|the) [a-z ]{0,12}(usage|message|rate) limit|(usage|message) limit reached|out of free messages|you've reached the limit|limit reached[^.]{0,40}(resets|try again)|upgrade to (continue|keep)/i,
    refusal: { reason: 'the account has hit its chat usage limit', retryable: true },
  },
  {
    pattern:
      /you're sending messages too (quickly|fast)|slow down[^.]{0,20}too many|too many requests/i,
    refusal: { reason: 'the site is rate limiting this account', retryable: true },
  },
  {
    pattern: /(log|sign) ?in to continue|please (log|sign) ?in\b|create an account to continue/i,
    refusal: { reason: 'the tab is signed out', retryable: false },
  },
  {
    pattern:
      /verify you are (a )?human|confirm you are (a )?human|complete the (captcha|security check)|unusual activity from your (device|computer)/i,
    refusal: { reason: 'the site is asking for a human verification check', retryable: false },
  },
];

export function refusalReason(pageText: string): Refusal | null {
  const text = collapse(canonicalPunctuation(pageText));
  if (!text) return null;
  for (const { pattern, refusal } of REFUSALS) {
    if (pattern.test(text)) return refusal;
  }
  return null;
}

/**
 * Busy candidates that are not simply always true.
 *
 * A "still generating" selector matching an idle page makes every reply look
 * unfinished, so every turn burns its entire budget and then fails - and it
 * fails that way for every call, not just some. Screening the candidates
 * against a page known to be idle costs one pass at connect time and turns
 * that into a candidate quietly dropped.
 */
export function usableBusySelectors(candidates: string[], presentOnIdlePage: string[]): string[] {
  const alwaysTrue = new Set(presentOnIdlePage);
  return candidates.filter((candidate) => !alwaysTrue.has(candidate));
}

/** A URL's hostname, or '' for one that has none (`file:`, `about:blank`). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * The site's own host, or a subdomain of it - never merely a name ending in it.
 *
 * `endsWith` alone adopts `notclaude.ai` and `claude.ai.example.com` as the
 * Claude tab, and what gets typed into that tab is a resume and a job
 * description. A lookalike left open in the operator's browser is exactly the
 * case where that matters.
 */
export function matchesHost(host: string, siteHost: string): boolean {
  if (!host || !siteHost) return false;
  return host === siteHost || host.endsWith(`.${siteHost}`);
}

/** The prompt as it goes into the composer. */
export function composePrompt(body: string, nudge: string): string {
  const trimmed = body.trim();
  if (!nudge.trim()) return trimmed;
  return `${trimmed}\n\n${nudge.trim()}`;
}
