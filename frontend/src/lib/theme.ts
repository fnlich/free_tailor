import type { ThemeMode } from './api';

export const THEME_STORAGE_KEY = 'tailor-theme';
export const DEFAULT_THEME_STORAGE_KEY = 'tailor-default-theme';

export function applyTheme(theme: ThemeMode): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

function readStoredTheme(key: string): ThemeMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(key);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

export function getStoredTheme(): ThemeMode | null {
  return readStoredTheme(THEME_STORAGE_KEY);
}

export function getStoredDefaultTheme(): ThemeMode | null {
  return readStoredTheme(DEFAULT_THEME_STORAGE_KEY);
}

export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * The theme this visitor should see: their own choice, else the administrator's
 * default, else the operating system's preference.
 *
 * This deliberately MIRRORS the inline script in app/layout.tsx, which has to
 * be self-contained because it runs before any bundle is loaded. The two must
 * agree; change them together. The duplication buys a first paint with the
 * right theme, which is the whole point of the inline script.
 */
export function resolvePreferredTheme(): ThemeMode {
  return getStoredTheme() ?? getStoredDefaultTheme() ?? (systemPrefersDark() ? 'dark' : 'light');
}

export function setStoredDefaultTheme(theme: ThemeMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DEFAULT_THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage errors.
  }
}
