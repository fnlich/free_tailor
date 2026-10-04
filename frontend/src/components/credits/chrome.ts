/**
 * The class strings the purchase dialog shares, and one rule worth knowing.
 *
 * They point at the shared kit (.tl-card, .tl-choice, .tl-button,
 * .tl-button-quiet, .tl-input in globals.css), so the dialog is drawn with the
 * same boxes, choices and buttons as every other page after the redesign.
 *
 * **Nothing here carries a `dark:` variant, and that is not a style choice.**
 * The `html.dark` shim at the end of `globals.css` is UNLAYERED while every
 * Tailwind utility lives inside `@layer utilities`, and unlayered CSS beats
 * layered CSS on cascade layer - which nothing but `!important` can out-bid.
 * So `bg-white dark:bg-slate-900` resolves to the shim's colour in dark mode
 * and the `dark:` half is simply ignored. The kit's classes and the `@theme
 * inline` tokens (`text-ink`, `text-muted`, `text-subtle`) sidestep it: they
 * state both themes themselves, and the shim has never heard of them.
 *
 * The same layering has a second face, and it is the one to remember when
 * adding a utility to one of these: **the kit classes are unlayered too, so
 * they beat a utility that sets the same property.** `${PRIMARY} px-3` keeps
 * the button's own padding, `${FIELD} w-24` stays full width, `${CHOICE}
 * items-center` stays top-aligned. Size a button with `data-size="sm"`, narrow
 * a field by wrapping it, and set anything else on an inner element or an
 * attribute the kit reads. Utilities for properties the class does not set -
 * margins, `min-w-0`, `text-left`, `relative` - work as usual.
 *
 * Status colours come from the kit as well (.tl-notice, .tl-status), which
 * states amber for both themes - so the refunds panel is a warning again
 * rather than the red it had to borrow while amber had no dark-mode rule.
 */

/** A framed region inside the dialog. */
export const PANEL = 'tl-card p-4';

/**
 * A caption over a group: "Card", "Choose an amount", "Paying with".
 *
 * The kit's label look written as utilities rather than `.tl-label`, because
 * that class is `display: block` - unlayered - and the payment options step
 * lays this heading out as a flex row with the price range at its far end.
 */
export const LABEL = 'text-sm font-medium text-ink';

/**
 * A choice: a payment method, a preset amount.
 *
 * `.tl-choice` draws the box and its selected state, which it reads from
 * `data-on="true"` on the element. Its border is the same width either way, so
 * selecting one changes a colour and never a size - a chip that grows by 1px
 * on selection nudges every chip after it.
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
export const CHOICE = 'tl-choice min-w-0 text-left disabled:opacity-55';

/**
 * The selected choice. The same class: `.tl-choice` draws the selection from
 * `data-on="true"`, so a selected chip carries that attribute as well.
 */
export const CHOICE_ON = CHOICE;

/** The one button on each step that moves the purchase forward. */
export const PRIMARY = 'tl-button';

/** Back, Close, Cancel: present, but not competing with PRIMARY. */
export const QUIET = 'tl-button-quiet';

/**
 * A text field or a number box. Full width, like every `.tl-input` - narrow
 * one by wrapping it in a box of the width wanted.
 */
export const FIELD = 'tl-input';
