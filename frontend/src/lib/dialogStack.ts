/**
 * The bookkeeping behind the kit's Dialog (components/ui/Dialog.tsx) when more
 * than one is open at once - which happens: a refund dialog's error notice
 * offers "Contact admin", and that opens a second dialog over the first. A
 * modal that draws its own chrome joins the same stack through
 * `useDialogLayer` (also components/ui/Dialog.tsx), or, if it manages the
 * page's scroll itself, at least asks `pageDialogs.size()` before it takes an
 * Escape that a kit dialog opened over it should have had.
 *
 *  - **Escape belongs to the top one.** Every open dialog listens for it on
 *    the document, so without an order both would close - and the one
 *    underneath takes the reason somebody was typing with it.
 *  - **The page's scroll is locked once,** however many are open, and comes
 *    back as it was when the LAST one closes, whichever order they close in.
 *    Each dialog saving and restoring `overflow` for itself gets that wrong as
 *    soon as an outer one is unmounted before an inner one: the inner puts
 *    back the `hidden` it found, and the page never scrolls again.
 *
 * No React and no DOM in here - the body is passed in - so backend/test can
 * load it and check both rules.
 */

/** Whatever holds the page's scroll: `document.body` in the browser. */
export type ScrollHolder = { style: { overflow: string } };

export type DialogStack = {
  /** A dialog has opened: it is now the top one, and the page does not scroll. */
  open: (body: ScrollHolder) => symbol;
  /** Whether this dialog is the top one - the one Escape closes. */
  isTop: (id: symbol) => boolean;
  /** A dialog has closed. Closing one twice, or one never opened, changes nothing. */
  close: (id: symbol, body: ScrollHolder) => void;
  /** How many are open. */
  size: () => number;
};

export function createDialogStack(): DialogStack {
  const opened: symbol[] = [];
  let overflowBefore = '';

  return {
    open(body) {
      if (opened.length === 0) {
        overflowBefore = body.style.overflow;
        body.style.overflow = 'hidden';
      }
      const id = Symbol('dialog');
      opened.push(id);
      return id;
    },
    isTop(id) {
      return opened.length > 0 && opened[opened.length - 1] === id;
    },
    close(id, body) {
      const at = opened.indexOf(id);
      if (at < 0) return;
      opened.splice(at, 1);
      if (opened.length === 0) body.style.overflow = overflowBefore;
    },
    size() {
      return opened.length;
    },
  };
}

/**
 * The page's one stack, shared by every kit Dialog and every modal that joins
 * it. Module state rather than React context, because the modals that need it
 * - a hand-rolled one on the payments page, the calendar's - are not under any
 * one provider, and there is only ever one page.
 */
export const pageDialogs: DialogStack = createDialogStack();
