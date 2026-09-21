'use client';

import { useCallback, useEffect, useRef } from 'react';

/**
 * A modal for the payment form.
 *
 * The form itself is unchanged - this only decides where it sits. A dialog
 * rather than the page, because paying is one short errand: it should not push
 * the balance and the credit history off the screen, and closing it should put
 * the person back exactly where they were rather than re-rendering the page
 * around them.
 *
 * The behaviour a dialog has to get right is the behaviour people expect from
 * every other dialog: Escape closes it, clicking the backdrop closes it, the
 * page behind does not scroll, and focus starts inside rather than wherever it
 * happened to be. None of that is decoration - a modal that traps somebody with
 * no way out is worse than no modal.
 */
export default function PayDialog({
  open,
  title,
  subtitle,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
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
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm sm:items-center"
      // The backdrop closes, but only when the backdrop itself was clicked:
      // without this check a drag that ends outside the panel closes the dialog
      // in the middle of filling in a card number.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="my-8 w-full max-w-md rounded-2xl bg-white p-6 shadow-xl outline-none dark:bg-slate-900 sm:my-0"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
            {subtitle && (
              <p className="mt-0.5 text-sm text-gray-600 dark:text-slate-300">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="-mr-1 -mt-1 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden="true">
              <path
                d="M5 5l10 10M15 5L5 15"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="mt-5">{children}</div>
      </div>
    </div>
  );
}
