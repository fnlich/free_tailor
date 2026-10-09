'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { IconClose } from '@/components/icons';
import { pageDialogs as dialogs } from '@/lib/dialogStack';

/**
 * Joins a modal that draws its own chrome to the stack every kit Dialog is on
 * (lib/dialogStack.ts): the page's scroll is locked while it is open, and
 * Escape reaches `onEscape` only while it is the TOP one - so a Contact admin
 * dialog opened from its error notice closes on Escape alone, and the modal
 * underneath keeps what was typed in it.
 */
export function useDialogLayer(open: boolean, onEscape: () => void): void {
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!open) return;
    const self = dialogs.open(document.body);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dialogs.isTop(self)) onEscapeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      dialogs.close(self, document.body);
    };
  }, [open]);
}

/**
 * The kit's modal: a title, a body, an optional footer of buttons, over a
 * backdrop.
 *
 * What a dialog has to get right is what people expect from every other
 * dialog: Escape closes it, clicking the backdrop closes it, the page behind
 * does not scroll, focus starts inside and goes back where it was. None of
 * that is decoration - a modal that traps somebody with no way out is worse
 * than no modal.
 *
 * Rendered into `document.body` through a portal, because it is opened from
 * places a fixed panel cannot sit: a "Contact admin" link inside an error
 * notice inside a table cell, whose scroll box would clip it (and a `<div>`
 * inside the `<p>` of a status line is not valid HTML at all).
 *
 * Styling note, and it is load-bearing: the chrome is the shared kit's
 * `.tl-backdrop` and `.tl-dialog` plus the `@theme inline` tokens, with no
 * `dark:` variants anywhere - the html.dark shim at the end of globals.css is
 * unlayered and beats them (see components/credits/chrome.ts).
 *
 * It began as the purchase wizard's own (components/credits/BuyCreditsDialog),
 * which is why it has `width="wide"` - the two-column order summary - and
 * `footer`, so every step's Back/Continue pair sits at the bottom of the
 * panel rather than at the bottom of whichever step is mounted.
 *
 * Dialogs stack: a refund dialog's error notice offers "Contact admin", which
 * opens a second dialog over the first. Escape closes only the top one, and
 * the page's scroll comes back only when the last one closes, in whichever
 * order they do (lib/dialogStack.ts).
 */
export default function Dialog({
  open,
  title,
  subtitle,
  width = 'md',
  footer,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  subtitle?: ReactNode;
  /** `wide` for a two-column body (the purchase summary, the refund queue's details); `md` otherwise. */
  width?: 'md' | 'wide';
  footer?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  // Read through a ref, so a parent passing a fresh arrow each render does not
  // re-run the effect - which would steal focus back to the panel from the
  // field somebody is typing in, on every keystroke.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    // A field marked autoFocus has already taken focus; only an empty start
    // moves it to the panel itself.
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();

    return () => {
      // Back where they were, so the keyboard does not start from the top.
      restoreFocusTo.current?.focus?.();
    };
  }, [open]);

  // The page behind must not scroll under the dialog - and this is now the
  // dialog Escape belongs to, until another opens over it.
  useDialogLayer(open, onClose);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="tl-backdrop"
      // Only when the backdrop itself was pressed: without this check a drag
      // that ends outside the panel - selecting text in a field - closes it.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      {/*
        `.tl-dialog` caps its own height and scrolls inside itself, which keeps
        the title and the Close button reachable on a short screen.
      */}
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-width={width}
        className={`tl-dialog p-4 outline-none sm:p-6 ${width === 'wide' ? 'max-w-4xl' : 'max-w-md'}`}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="break-words text-xl font-semibold text-ink">{title}</h2>
            {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={() => onCloseRef.current()}
            aria-label="Close"
            className="tl-icon-button -mr-2 -mt-2 shrink-0"
          >
            <IconClose className="h-[18px] w-[18px]" />
          </button>
        </div>

        {children && <div className="mt-6">{children}</div>}

        {footer && (
          /* `border-t-[1px]`, not the bare `border-t` the dark-mode shim recolours. */
          <div className="mt-6 flex flex-wrap items-center justify-end gap-3 border-t-[1px] border-[color:var(--line-subtle)] pt-5">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
