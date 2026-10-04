'use client';

import { useCallback, useEffect, useRef } from 'react';
import { IconClose } from '@/components/icons';

/**
 * A modal for the payment flow.
 *
 * A dialog rather than the page, because paying is one short errand: it should
 * not push the balance and the credit history off the screen, and closing it
 * should put the person back exactly where they were rather than re-rendering
 * the page around them.
 *
 * The behaviour a dialog has to get right is the behaviour people expect from
 * every other dialog: Escape closes it, clicking the backdrop closes it, the
 * page behind does not scroll, and focus starts inside rather than wherever it
 * happened to be. None of that is decoration - a modal that traps somebody with
 * no way out is worse than no modal.
 *
 * Two props carry the purchase flow. `width` because the order summary is two
 * columns and does not fit in the `max-w-md` a single card form wanted, and
 * `footer` because every step of a wizard ends in the same Back/Continue pair
 * and putting it here keeps it in one place at the bottom of the panel instead
 * of at the bottom of whichever step happens to be mounted.
 *
 * Styling note, and it is load-bearing: the chrome here is the shared kit's
 * `.tl-backdrop` and `.tl-dialog` plus the `@theme inline` tokens (`text-ink`,
 * `text-muted`), with no `dark:` variants anywhere. The html.dark shim at the
 * end of globals.css is unlayered while Tailwind utilities live in `@layer
 * utilities`, so it beats `dark:` outright - this panel used to say `bg-white
 * shadow-xl dark:bg-slate-900` and the dark: half of that never once applied.
 */
export default function PayDialog({
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
  subtitle?: string;
  /** `wide` is for the two-column order summary; everything else is `md`. */
  width?: 'md' | 'wide';
  footer?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    if (!open) return;

    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    panel.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);

    // The page behind must not scroll under the dialog.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      // Back where they were, so the keyboard does not start from the top.
      restoreFocusTo.current?.focus?.();
    };
  }, [open, close]);

  if (!open) return null;

  return (
    <div
      className="tl-backdrop"
      // The backdrop closes, but only when the backdrop itself was clicked:
      // without this check a drag that ends outside the panel closes the dialog
      // in the middle of filling in a card number.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      {/*
        The kit's dialog, which is never taller than the window: `.tl-dialog`
        caps its own height and scrolls inside itself. That is what keeps the
        title and the Close button reachable on a short laptop screen, where
        the two-column summary is taller than the window - centring a panel
        that could grow past the window used to push it off BOTH ends, and the
        half above the top was unreachable because scrolling cannot go past
        zero.
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
            <h2 className="text-xl font-semibold text-ink">{title}</h2>
            {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="tl-icon-button -mr-2 -mt-2 shrink-0"
          >
            <IconClose className="h-[18px] w-[18px]" />
          </button>
        </div>

        <div className="mt-6">{children}</div>

        {footer && (
          /* `border-t-[1px]`, not the bare `border-t` the dark-mode shim recolours. */
          <div className="mt-6 flex flex-wrap items-center justify-end gap-3 border-t-[1px] border-[color:var(--line-subtle)] pt-5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
