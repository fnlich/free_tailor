import type { FocusEvent } from 'react';

/**
 * A table's action column held at its box's right edge while the table
 * scrolls sideways under it (`data-sticky-end`, globals.css - Find Jobs'
 * Details). It is opaque, and a browser scrolls a focused control into view
 * only when none of it is inside the box: a Title link the Tab key had just
 * reached could sit half or wholly under the Details cell, focused and out of
 * sight (WCAG 2.2, 2.4.11). The box's focus handler scrolls it clear - a
 * control the keyboard focused, and only that.
 *
 * No runtime import: backend/test/frontendFindJobs.test.js runs the sum and
 * the handler.
 */

/** A box's or a control's left and right edges, in the viewport's pixels. */
export interface HorizontalSpan {
  left: number;
  right: number;
}

/** The room kept between a focused control and the box's left edge, or the held column. */
export const STICKY_END_GAP_PX = 8;

/**
 * How far to scroll the box sideways (added to its `scrollLeft`) so that
 * `target` sits between the box's left edge and the held column, which starts
 * at `stickyLeft`: 0 when it does already; leftwards when its start is cut off
 * at the box's left edge; rightwards when its end is under the column - no
 * further than keeps its start in sight, so one wider than the room shows its
 * start.
 */
export function stickyEndShift(
  box: HorizontalSpan,
  stickyLeft: number,
  target: HorizontalSpan,
  gap: number = STICKY_END_GAP_PX
): number {
  const start = box.left + gap;
  const end = stickyLeft - gap;
  if (target.left < start) return target.left - start;
  if (target.right <= end) return 0;
  return Math.min(target.right - end, target.left - start);
}

/**
 * The scroll box's `onFocus` (React's, which hears a focus anywhere inside
 * it): a control the keyboard focused in a row is scrolled clear of that
 * row's held column - unless it is in that column itself, which is always in
 * view. A mouse press or a tap focuses a checkbox or a link too, on its way
 * down, and moving the box then took the control out from under the pointer
 * before it came up: the click landed on the cell, so a box half cut off went
 * unticked and a Title link half under Details unopened. `:focus-visible` is
 * the browser's own answer to "did the keyboard put the focus here" - true
 * after Tab or Shift+Tab, false after a press or a tap.
 */
export function keepFocusClearOfStickyEnd(event: FocusEvent<HTMLElement>): void {
  const box = event.currentTarget;
  const target: Element = event.target;
  if (!target.matches(':focus-visible')) return;
  const held = target.closest('tr')?.querySelector(':scope > [data-sticky-end]');
  if (!held || held.contains(target)) return;
  const shift = stickyEndShift(box.getBoundingClientRect(), held.getBoundingClientRect().left, target.getBoundingClientRect());
  if (shift !== 0) box.scrollLeft += shift;
}
