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
  // CONTAINS, not starts-with. Both sites group a turn with its reply and put
  // something above the user's text inside that group - an author label, a
  // timestamp, an Edit control - and a prefix test is defeated by any one of
  // them. Measured against this function: the bare echo matched, and the same
  // echo behind a single "You\n" label did not. What that costs is not a
  // missed warning: it is the guard passing, and the PROMPT being returned as
  // the answer. A resume tailored to the instructions, with no error anywhere.
  return collapse(canonicalPunctuation(seen)).includes(head);
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
  // A read taken while the site says it is still generating does not reset the
  // run - it ABANDONS it, baseline and all - and that is the load-bearing part.
  //
  // Letting busy reads contribute would bank the run during the answer: a model
  // pausing mid-sentence with the stop control still up piles up unchanged
  // reads, and the first read after the control drops finds the quota already
  // met and ends the turn with no idle read behind it. Since both sites take
  // the stop button down a beat BEFORE the last chunk paints, that is exactly
  // when the text is still short - the truncation this rule exists to prevent,
  // reached from the other side.
  //
  // Clearing `previous` as well as the count is what makes it whole. Keeping it
  // would let the next idle read match a BUSY read's text and count as a
  // repeat, so a single idle observation would satisfy a rule that means to
  // demand two. Every read in the run has to have been taken while the page was
  // idle, the first one included.
  if (busy) return { state: INITIAL_POLL_STATE, done: null };

  const continues = state.previous !== null && state.previous === trimmed;
  const stableReads = continues ? state.stableReads + 1 : 0;
  const next: PollState = { previous: trimmed, stableReads };
  const required = Math.max(1, requiredStableReads);
  const done = trimmed.length > 0 && stableReads >= required ? trimmed : null;
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

/**
 * The page's text minus anything this app already knew was there.
 *
 * Without this the refusal check is actively harmful. It reads the whole
 * document, and the whole document CONTAINS THE PROMPT THIS APP JUST TYPED - a
 * real resume and a real job description. Run against an infrastructure
 * engineer's resume, "the payment service hit the rate limit and shed load"
 * reads as a usage wall, and the turn is abandoned with an explanation that is
 * not merely wrong but unfalsifiable from the operator's side: nothing is
 * limited, and it happens on every single run for that one candidate.
 *
 * So only text the app did not put there is considered. Comparison is against
 * the whitespace-COLLAPSED prompt rather than line by line, which is what makes
 * it survive the transcript re-wrapping long paragraphs: however the site
 * breaks the prompt up, each resulting line is still a run of characters from
 * inside that one blob.
 */
export function unfamiliarText(pageText: string, known: string[]): string {
  const blobs = known
    .map((entry) => collapse(canonicalPunctuation(entry)).toLowerCase())
    .filter(Boolean);
  const kept: string[] = [];
  for (const raw of pageText.split('\n')) {
    const line = collapse(canonicalPunctuation(raw));
    if (!line) continue;
    const probe = line.toLowerCase();
    if (blobs.some((blob) => blob.includes(probe))) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * The wordings, deliberately narrow.
 *
 * Every one of these demands something a chat UI says and prose does not: the
 * reader addressed in the second person, or a control-panel noun phrase, or an
 * instruction about what to do next. The looser spellings that suggested
 * themselves first - a bare "hit the rate limit", a bare "too many requests" -
 * are ordinary English in this app's own input and are not used. That
 * narrowness is deliberate belt-and-braces: `unfamiliarText` should already
 * have removed the prompt before any of these is tried, and a missed wall costs
 * one confusing timeout while a false one costs every run.
 */
const REFUSALS: Array<{ pattern: RegExp; refusal: Refusal }> = [
  {
    // "You've reached your usage limit", "You're out of free messages",
    // "You have reached our limit of messages per hour".
    pattern:
      /\b(you'?(ve|re)|you (have|are))\b[^.!?]{0,40}\b(reached|hit|used up|out of)\b[^.!?]{0,40}\b(limit|free messages|free responses)\b/i,
    refusal: { reason: 'the account has hit its chat usage limit', retryable: true },
  },
  {
    // A control-panel noun phrase rather than a sentence.
    pattern: /\b(usage|message|conversation|daily|weekly) limit reached\b/i,
    refusal: { reason: 'the account has hit its chat usage limit', retryable: true },
  },
  {
    pattern: /\byour\b[^.!?]{0,24}\b(usage|message|plan|daily|weekly) limit\b/i,
    refusal: { reason: 'the account has hit its chat usage limit', retryable: true },
  },
  {
    // The PLAN has to be named. "upgrade ... to continue" alone is a sentence
    // an infrastructure resume writes without thinking - "led the upgrade to
    // Kubernetes to keep deploys under five minutes" trips it - and a resume is
    // what this app puts on the page.
    pattern: /\bupgrade (to ((chatgpt|claude|a) )?(pro\b|plus\b|premium\b|team\b|paid plan)|your plan\b)/i,
    refusal: { reason: 'the account has hit its chat usage limit', retryable: true },
  },
  {
    // Second person or an instruction, never a bare "too many requests" - that
    // phrase belongs to half the backend resumes this app is given.
    pattern:
      /\byou'?re sending (messages )?too (quickly|fast)\b|\bslow down\b[^.!?]{0,24}too many|\btoo many requests\b[^.!?]{0,30}\b(try again|please wait|slow down)\b/i,
    refusal: { reason: 'the site is rate limiting this account', retryable: true },
  },
  {
    pattern: /\b(log|sign) ?in to continue\b|\bplease (log|sign) ?in\b|\bcreate an account to continue\b/i,
    refusal: { reason: 'the tab is signed out', retryable: false },
  },
  {
    pattern:
      /\bverify you are (a )?human\b|\bconfirm you are (a )?human\b|\bcomplete the (captcha|security check)\b|\bunusual activity from your (device|computer)\b/i,
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

/**
 * Is this tab showing the site?
 *
 * By host normally, and that is the important case - any conversation URL on
 * claude.ai is the Claude tab, not just the /new the table names.
 *
 * A site with NO host is the other case: `AI_WEB_CLAUDE_URL` pointed at a
 * `file:` or `data:` page, which is how this driver is exercised without a
 * signed-in account. Matching on host alone can never find that tab, so the
 * override silently opens a second one on every call and attaches to whichever
 * it finds. Compared without the fragment, since the site owns that.
 */
export function matchesSite(pageUrl: string, site: { host: string; url: string }): boolean {
  const host = hostOf(pageUrl);
  if (site.host) return matchesHost(host, site.host);
  if (host || !site.url) return false;
  const strip = (value: string) => value.split('#')[0];
  return strip(pageUrl) === strip(site.url);
}

/** The prompt as it goes into the composer. */
export function composePrompt(body: string, nudge: string): string {
  const trimmed = body.trim();
  if (!nudge.trim()) return trimmed;
  return `${trimmed}\n\n${nudge.trim()}`;
}
