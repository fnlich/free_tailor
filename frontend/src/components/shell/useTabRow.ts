'use client';

import { useEffect, useRef } from 'react';

/**
 * A row of `.tl-tabs` or `.tl-subtabs` that says when it holds more than it
 * shows, and that never opens with its current tab out of sight.
 *
 * The rows scroll sideways rather than wrap, and hide their scrollbar - so on
 * a phone the Settings row ended at "Plan" with nothing to say Administration
 * was one swipe away, and arriving on /admin/notifications showed a second
 * row whose lit tab was off the right edge. Both are fixed here:
 *
 * - The active tab is scrolled into the row's view whenever `key` changes
 *   (the route, or the selected tab). The row's own scrollLeft, not
 *   `scrollIntoView`, which would also move the page.
 * - `data-more` is set to `start`, `end` or `both` while there is more to
 *   either side, and globals.css fades that edge.
 *
 * Written straight to the DOM rather than kept in state: it changes on every
 * scroll event, and nothing React renders depends on it.
 */
export function useTabRow<T extends HTMLElement>(key: string) {
  const ref = useRef<T>(null);

  useEffect(() => {
    const row = ref.current;
    if (!row) return;

    const active = row.querySelector<HTMLElement>('[data-active="true"]');
    if (active) {
      const box = row.getBoundingClientRect();
      const tab = active.getBoundingClientRect();
      // A little past the edge, so the tab is not left flush against the fade.
      if (tab.right > box.right) row.scrollLeft += tab.right - box.right + 32;
      else if (tab.left < box.left) row.scrollLeft -= box.left - tab.left + 32;
    }

    const update = () => {
      const max = row.scrollWidth - row.clientWidth;
      const start = row.scrollLeft > 1;
      const end = row.scrollLeft < max - 1;
      const more = start && end ? 'both' : start ? 'start' : end ? 'end' : '';
      if (more) row.dataset.more = more;
      else delete row.dataset.more;
    };

    update();
    row.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(row);
    return () => {
      row.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [key]);

  return ref;
}
