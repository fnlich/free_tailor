/**
 * The class strings the purchase dialog shares, and one rule worth knowing.
 *
 * **Nothing here carries a `dark:` variant, and that is not a style choice.**
 * The `html.dark` shim at the end of `globals.css` is UNLAYERED while every
 * Tailwind utility lives inside `@layer utilities`, and unlayered CSS beats
 * layered CSS on cascade layer - which nothing but `!important` can out-bid.
 * So `bg-white dark:bg-slate-900` resolves to the shim's colour in dark mode
 * and the `dark:` half is simply ignored. The `@theme inline` tokens
 * (`bg-surface`, `border-line`, `text-ink`, `text-muted`, `text-subtle`,
 * `bg-accent-soft`) sidestep it: they re-resolve against whatever `html.dark`
 * set, in one class, and the shim has never heard of them.
 *
 * The same trap has a second face. The shim rewrites the border COLOUR of the
 * bare `.border` (and `.border-t/r/b/l`), so `border border-accent` comes out
 * neutral in dark mode. It does not touch `.border-2`. Hence the rule below:
 *
 *   - a neutral hairline      -> `border border-line`  (both resolve to the
 *                                same variable, so the shim agrees with it)
 *   - a border whose COLOUR   -> `border-2`, always
 *     carries meaning
 *
 * Status colours are likewise limited to the ones the shim actually covers -
 * red, blue and emerald at 50/200/700. Amber has no dark-mode rule at all,
 * which is why the panels below are red and blue rather than red and amber.
 */

/** A framed region inside the dialog. */
export const PANEL = 'rounded-xl border border-line bg-surface p-4';

/** A small uppercase caption, as used across the rest of the app. */
export const LABEL = 'text-xs font-medium uppercase tracking-wide text-subtle';

/**
 * A choice: a payment method, a preset amount, a saved card.
 *
 * `border-2` even when unselected, so selecting one changes a colour and never
 * a size - a chip that grows by 1px on selection nudges every chip after it.
 *
 * **`min-w-0` is load-bearing, and it is not the same `min-w-0` as the one
 * inside the chip.** Every one of these sits in a `grid`, and a grid item's
 * default `min-width` is `auto`, not `0` - so it refuses to shrink below the
 * MIN-CONTENT width of whatever is inside it, and a long unbroken line pushes
 * the chip straight out through the side of the dialog instead. `truncate` on
 * an inner element does not save it: `white-space: nowrap` makes that inner
 * text's min-content width the whole sentence, so it is the thing that causes
 * the blow-out rather than the thing that prevents it, and the chip never gets
 * narrow enough for the ellipsis to appear. A `min-w-0` on an inner span is
 * powerless here too - the constraint is a level up, on the grid item itself.
 * Measured on the crypto row with its setup instructions: a 398px track held a
 * 1291px button whose right edge was 868px past the dialog.
 */
export const CHOICE =
  'min-w-0 rounded-xl border-2 border-line bg-surface p-3 text-left transition-colors ' +
  'hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-55 ' +
  'disabled:hover:border-line';

export const CHOICE_ON =
  'min-w-0 rounded-xl border-2 border-accent bg-accent-soft p-3 text-left';

/** The one button on each step that moves the purchase forward. */
export const PRIMARY =
  'rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-opacity ' +
  'hover:opacity-90 disabled:cursor-not-allowed disabled:bg-gray-400 disabled:hover:opacity-100';

/** Back, Close, Cancel: present, but not competing with PRIMARY. */
export const QUIET =
  'rounded-xl border border-line px-4 py-2.5 text-sm font-medium text-muted ' +
  'transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-55';

/** A text field or a number box. The shim styles bare inputs in dark mode. */
export const FIELD =
  'rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 ' +
  'focus:ring-blue-500';
