'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * A media query as React state, safe to call while rendering on the server.
 *
 * `useSyncExternalStore` rather than `useState` + an effect, because the effect
 * version renders once with a guess and then corrects itself - which is a
 * flash of the wrong layout on every single page load, and a hydration warning
 * if the guess is used in markup.
 *
 * The server snapshot answers `false`. Every caller here asks "is this a narrow
 * viewport", so `false` means desktop, which is the layout the CSS also paints
 * by default - server and first client paint agree, and only a genuinely narrow
 * viewport re-renders.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query]
  );

  const getSnapshot = useCallback(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  }, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * Below the app's mobile/desktop line.
 *
 * 768px is `md`, which is where the rest of the app already switches, and the
 * shell's own CSS breakpoint is written against the same number. The two must
 * agree: the CSS decides whether the sidebar is a drawer, this decides whether
 * its links are in the tab order.
 */
export function useIsCompact(): boolean {
  return useMediaQuery('(max-width: 767.98px)');
}
