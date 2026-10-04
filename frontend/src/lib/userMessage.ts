import { ApiResponseError, ApiUnreachableError } from './api';

/**
 * What a person is shown when something failed.
 *
 * The rule the whole app follows: somebody using Tailor is told what went wrong
 * in words they can act on, and nothing about how this installation is run -
 * no environment variables, commands, provider or model ids, paths, hosts or
 * third-party error text. The SERVER decides what is safe: every refusal it
 * sends has an `error` sentence written for whoever asked, a `ref` when the
 * failure was logged, and - for an administrator only - a `detail` with the
 * real cause. So this module only has to cover what the server never sees:
 * a request that did not reach it, and the client's own exceptions.
 *
 * `operatorDetail` (lib/api.ts) stays the one channel for the administrator's
 * half; the kit's <ErrorNotice> renders both.
 */

/** Nothing answered: the API is down, or the address the build points at is wrong. */
export const UNREACHABLE_MESSAGE =
  "We can't reach the server right now. Please try again in a moment, or contact your administrator if this continues.";

/** When there is nothing more specific to say. */
export const GENERIC_MESSAGE = 'Something went wrong. Please try again, or contact your administrator.';

/**
 * What a person is told when no AI model can run for them: every model is
 * switched off, or every seat behind them is locked. The reason is an
 * administrator's business, so the sentence only says who can fix it.
 */
export const AI_UNAVAILABLE_MESSAGE =
  "AI generation isn't available right now. Please contact your administrator.";

/*
 * Errors whose technical text has been written to the console already.
 *
 * <ErrorNotice> calls `userMessage` while rendering, so the same error would
 * otherwise log once per render - a dozen identical warnings for one failure,
 * which buries the one worth reading.
 */
const warned = new WeakSet<object>();

function warnOnce(error: Error): void {
  if (warned.has(error)) return;
  warned.add(error);
  console.warn('[tailor] request failed before reaching the server:', error.message);
}

/**
 * The reference the server logged a failure under, e.g. `ERR-7F3A9C`.
 *
 * It is what makes a generic sentence useful to an administrator: the person
 * quotes it, and the log line carrying the same reference has the real cause.
 */
export function errorRef(error: unknown): string | null {
  if (!(error instanceof ApiResponseError)) return null;
  const ref = error.body.ref;
  return typeof ref === 'string' && ref.trim() ? ref.trim() : null;
}

function withRef(message: string, ref: string | null): string {
  if (!ref || message.includes(ref)) return message;
  return `${message} (Ref: ${ref})`;
}

/**
 * A caller's fallback ("Could not load your orders") turned into a whole
 * sentence that says who can help - the same shape the server gives its own
 * generic failures, so the two read alike on one page.
 */
function fallbackSentence(fallback: string): string {
  const said = fallback.trim();
  if (!said) return GENERIC_MESSAGE;
  if (/administrator/i.test(said)) return said;
  const ended = /[.!?]$/.test(said) ? said : `${said}.`;
  return `${ended} Please try again, or contact your administrator.`;
}

/**
 * The sentence to show for a failure.
 *
 * - The server answered: its `error` sentence (already safe for whoever is
 *   signed in), plus "(Ref: ...)" when it logged the failure. A response with
 *   no sentence - a proxy's HTML error page, say - gets the fallback.
 * - Nothing answered (or `fetch` itself threw, which is a TypeError): the
 *   unreachable sentence. The technical text, which names the URLs tried and
 *   the port in the build, goes to the console for whoever is debugging.
 * - An `Error` the app threw itself (`new Error('Pick a profile first')`): its
 *   message - those are written for the reader already.
 * - Anything else, including a library's own exception classes whose text was
 *   never written for a person: the fallback.
 */
export function userMessage(error: unknown, fallback: string = GENERIC_MESSAGE): string {
  if (error instanceof ApiResponseError) {
    const said = typeof error.body.error === 'string' ? error.body.error.trim() : '';
    return withRef(said || fallbackSentence(fallback), errorRef(error));
  }
  if (error instanceof ApiUnreachableError || error instanceof TypeError) {
    warnOnce(error);
    return UNREACHABLE_MESSAGE;
  }
  // `name === 'Error'` is what marks the app's own: a SyntaxError from a
  // mangled body, a DOMException or a RangeError is a library talking.
  if (error instanceof Error && error.name === 'Error' && error.message.trim()) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) return error;
  return fallbackSentence(fallback);
}