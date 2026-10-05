/**
 * The width the profile editor's preview scales its page to.
 *
 * Its own module, with no React and no DOM in it, so the one rule that stops
 * the preview shaking can be tested without a browser
 * (backend/test/frontendEditorHelpers.test.js transpiles it and refuses any
 * runtime import). ProfilePreview reads the numbers off the well and hands
 * them in.
 *
 * The shake it prevents is a feedback loop through a scrollbar. The page is
 * scaled to the width it is given, so its height follows that width; and
 * whatever scrolls it - the well on a wide screen, the window on a narrow
 * one - grows a scrollbar when it overflows. Where scrollbars take room
 * (Windows and Linux Chrome, macOS set to always show them), a one-page
 * resume just taller than the room brought the scrollbar in, the width
 * dropped by the scrollbar's, the page was scaled down ~3% and fitted, the
 * scrollbar went, the page grew back and overflowed - every frame, with
 * nobody touching anything. At 1920x937 that was every one-page document.
 * backend/test/e2e/preview-vibration.js is the probe that saw it, and sees
 * it gone.
 */

/** What ProfilePreview reads off the well and the window, in CSS px. */
export interface WellBox {
  /** The well's border box width - the same with its scrollbar or without. */
  outerWidth: number;
  /** The well's `clientWidth`: its padding box, less any scrollbar of its own. */
  clientWidth: number;
  /** Left plus right border. */
  borderX: number;
  /** Left plus right padding. */
  paddingX: number;
  /** Whether the well scrolls itself (`overflow-y` auto or scroll); otherwise the window does. */
  scrolls: boolean;
  /**
   * The strip the window's scrollbar takes from the page right now, shown or
   * reserved: `innerWidth` less the root element's box width.
   */
  windowBar: number;
}

/** The widest scrollbar strips seen so far, kept between reads. */
export interface Gutters {
  well: number;
  window: number;
}

export const NO_GUTTERS: Gutters = { well: 0, window: 0 };

/** Below this a difference is rounding between two measures, not a scrollbar. */
const ROUNDING_SLACK_PX = 2;

const strip = (width: number) => (width >= ROUNDING_SLACK_PX ? width : 0);

/**
 * The width to scale to, and the scrollbar strips it allowed for.
 *
 * The answer is the width as if the scrollbar that matters were ALWAYS
 * there, so it cannot depend on whether it is, and the strips only ever grow -
 * the widest seen so far. With `scrollbar-gutter: stable` (the well's CSS,
 * and the window's while the editor is open) the strip is reserved from the
 * first frame and the first answer is the last. Where that is not supported,
 * the first scrollbar to appear is remembered and the loop stops after one
 * step instead of running for ever.
 *
 * Which scrollbar matters depends on the layout. A well that scrolls itself
 * (the wide layout) loses its own strip. A well that does not (the narrow
 * layout, one column) is the window's width less fixed padding, so it loses
 * the window's strip instead: when the window's scrollbar is away, the width
 * is taken down by the strip it would take.
 */
export function stablePaneWidth(box: WellBox, known: Gutters = NO_GUTTERS): { width: number; gutters: Gutters } {
  const inside = box.outerWidth - box.borderX - box.paddingX;
  if (box.scrolls) {
    const well = Math.max(known.well, strip(box.outerWidth - box.borderX - box.clientWidth));
    return { width: Math.max(0, inside - well), gutters: { ...known, well } };
  }
  const windowBar = strip(box.windowBar);
  const window = Math.max(known.window, windowBar);
  return { width: Math.max(0, inside - (window - windowBar)), gutters: { ...known, window } };
}
