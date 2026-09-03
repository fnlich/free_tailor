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

export function getStoredTheme(): ThemeMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    return storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : null;
  } catch {
    return null;
  }
}

export function setStoredDefaultTheme(theme: ThemeMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DEFAULT_THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage errors.
  }
}
