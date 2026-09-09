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
  const head = collapse(sent).slice(0, 80);
  if (!head) return false;
  return collapse(seen).startsWith(head);
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
 * One poll: has the reply finished?
 *
 * Finished means all three: the site is no longer showing a stop control, the
 * text is non-empty, and it read the same twice running. The last is what
 * separates a finished answer from a pause between tokens, and it is why a
 * busy check alone is not enough - both sites drop the stop button a beat
 * before the final chunk renders, so a reply taken on `!busy` alone loses its
 * last sentence. Which, for a tailored resume, is a silently truncated one.
 */
export function poll(state: PollState, text: string, busy: boolean): PollOutcome {
  const trimmed = text.trim();
  const stableReads = state.previous !== null && state.previous === trimmed ? state.stableReads + 1 : 0;
  const next: PollState = { previous: trimmed, stableReads };
  const done = !busy && trimmed.length > 0 && stableReads >= 1 ? trimmed : null;
  return { state: next, done };
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

/** The prompt as it goes into the composer. */
export function composePrompt(body: string, nudge: string): string {
  const trimmed = body.trim();
  if (!nudge.trim()) return trimmed;
  return `${trimmed}\n\n${nudge.trim()}`;
}
