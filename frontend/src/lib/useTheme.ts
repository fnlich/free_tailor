'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';

import type { ThemeMode } from './api';
import {
  applyTheme,
  getStoredTheme,
  resolvePreferredTheme,
  THEME_CHANGE_EVENT,
  THEME_STORAGE_KEY,
} from './theme';

/**
 * The live theme, and a way to set it.
 *
 * Separate from `theme.ts` so that file stays free of React and can be
 * imported by the plain functions that do the actual work.
 *
 * The document is the store. `applyTheme` writes `data-theme` on <html> and
 * announces itself, so subscribing to that event and reading that attribute
 * gives one source of truth for every control - which matters because two
 * pages call `applyTheme` directly on load to adopt the installation's
 * configured default, and a toggle holding its own copy of the answer would
 * quietly disagree with the page it is sitting on.
 */

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  return () => window.removeEventListener(THEME_CHANGE_EVENT, onChange);
}

function getSnapshot(): ThemeMode {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function useTheme(): {
  theme: ThemeMode;
  /** False until hydration settles, when the server's guess could be wrong. */
  mounted: boolean;
  setTheme: (next: ThemeMode) => void;
  toggle: () => void;
} {
  /*
   * The server cannot know which theme this visitor resolved to, so it answers
   * 'light'. useSyncExternalStore is what makes that safe: React uses the
   * server snapshot to hydrate and then re-renders from the client one, which
   * is a correction rather than a mismatch.
   */
  const theme = useSyncExternalStore(subscribe, getSnapshot, () => 'light' as ThemeMode);
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );

  useEffect(() => {
    // Re-derives from storage and RE-APPLIES rather than trusting what is on
    // <html>. The inline script in the root layout has normally already set it,
    // but a Content-Security-Policy that blocks inline scripts, an extension
    // that strips them, or a hydration mismatch severe enough to reset the
    // attributes all leave the DOM lying, and reading it would inherit the lie.
    applyTheme(resolvePreferredTheme());

    // Follow the operating system only while the visitor has expressed no
    // preference of their own. resolvePreferredTheme still prefers the
    // administrator's configured default over the system, so this cannot
    // override that either.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemChange = () => {
      if (getStoredTheme()) return;
      applyTheme(resolvePreferredTheme());
    };

    media.addEventListener('change', onSystemChange);
    return () => media.removeEventListener('change', onSystemChange);
  }, []);

  const setTheme = useCallback((next: ThemeMode) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // A blocked or full store costs the preference on the next load, not this
      // change - so apply it anyway rather than refusing to switch.
    }
    applyTheme(next);
  }, []);

  const toggle = useCallback(() => {
    setTheme(getSnapshot() === 'dark' ? 'light' : 'dark');
  }, [setTheme]);

  return { theme, mounted, setTheme, toggle };
}
