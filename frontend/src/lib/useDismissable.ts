'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Close on an outside click, and close on Escape.
 *
 * Three copies of this existed - the settings dropdown and the mobile menu in
 * the old top bar, and the account menu - and they had already drifted: two
 * listened for Escape and one did not. A dropdown that cannot be dismissed by
 * somebody who opened it by accident and is not holding a mouse is the one
 * keyboard behaviour these have to get right, so it belongs in one place.
 *
 * Listens on `mousedown` rather than `click` deliberately: a click fires after
 * the button it landed on has already done its work, so a toggle button would
 * reopen the panel this just closed.
 */
export function useDismissable(
  open: boolean,
  onDismiss: () => void,
  /** Clicks inside any of these do not dismiss. Nulls are ignored. */
  ...within: Array<RefObject<HTMLElement | null>>
): void {
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (within.some((ref) => ref.current?.contains(target))) return;
      onDismiss();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
    // `within` is a rest array, so it is a new identity every render; the refs
    // inside it are stable and are read at event time rather than closed over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onDismiss]);
}
