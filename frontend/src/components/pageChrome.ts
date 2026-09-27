/**
 * The card and caption every ordinary page draws, written once.
 *
 * Six pages had declared the same `CARD` string and five the same `LABEL`, and
 * a card that drifts on one page and not the others is the kind of difference
 * nobody notices until two of them are on screen together.
 *
 * **These keep their `dark:` variants, and `components/credits/chrome.ts`
 * deliberately does not.** That is not an inconsistency, it is the two halves of
 * the state CLAUDE.md describes. The `html.dark` shim at the end of
 * `globals.css` is unlayered, so it beats every `dark:` utility outright: on
 * `bg-white dark:bg-slate-900` the shim wins and the variant is dead weight.
 * Eighteen pages carry no `dark:` at all and theme entirely through that shim,
 * so it stays, and these strings are what the shim expects to find. New chrome
 * uses the `@theme inline` tokens instead - which is why the purchase dialog's
 * `LABEL` is `text-subtle` where this one is `text-gray-500 dark:text-slate-400`.
 * Two names, two values, two eras, and merging them would change what renders.
 *
 * So: moved verbatim, not modernised. A page that wants the token style should
 * say so with tokens rather than by editing this.
 */

/** A framed section of a page. */
export const CARD =
  'rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900';

/** The small uppercase caption above a value. */
export const LABEL = 'text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400';
