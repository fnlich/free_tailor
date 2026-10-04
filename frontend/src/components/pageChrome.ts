/**
 * The card and caption a few older pages still draw by name.
 *
 * Both now point at the shared kit: `.tl-card` is the bordered box every page
 * uses after the redesign, and the caption is in the `text-subtle` token. They
 * used to carry `dark:` variants for the html.dark shim to override; the kit's
 * classes and tokens are names the shim has never heard of, so what they say
 * is what renders in both themes. New code should reach for
 * components/ui/kit.tsx (Card, Field...) rather than these strings.
 */

/** A framed section of a page. */
export const CARD = 'tl-card p-6';

/** The small uppercase caption above a value. */
export const LABEL = 'text-xs font-medium uppercase tracking-wide text-subtle';
