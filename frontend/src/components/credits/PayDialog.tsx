'use client';

/**
 * The purchase wizard's modal - the kit's Dialog (components/ui/Dialog.tsx),
 * under the name the wizard has always imported.
 *
 * It began here, as the payment flow's own: a dialog rather than the page,
 * because paying is one short errand that should not push the balance and the
 * credit history off the screen. Its two extra props are why the kit's has
 * them - `width="wide"` for the two-column order summary, and `footer`, so
 * every step's Back/Continue pair sits in one place at the bottom of the panel
 * rather than at the bottom of whichever step is mounted. It moved to the kit
 * when the refund and contact dialogs needed the same behaviour, so there is
 * one copy of Escape, the backdrop, the scroll lock and the focus return.
 */
export { default } from '@/components/ui/Dialog';
