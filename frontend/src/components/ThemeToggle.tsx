'use client';

import { useEffect, useState } from 'react';
import { applyTheme, getStoredTheme, THEME_STORAGE_KEY } from '@/lib/theme';

type Theme = 'light' | 'dark';

function getResolvedTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const syncTheme = () => {
      setTheme(getResolvedTheme());
      setMounted(true);
    };

    const handleSystemThemeChange = () => {
      if (getStoredTheme()) return;

      const nextTheme: Theme = mediaQuery.matches ? 'dark' : 'light';
      applyTheme(nextTheme);
      setTheme(nextTheme);
    };

    syncTheme();
    mediaQuery.addEventListener('change', handleSystemThemeChange);

    return () => {
      mediaQuery.removeEventListener('change', handleSystemThemeChange);
    };
  }, []);

  const toggleTheme = () => {
    const nextTheme: Theme = theme === 'dark' ? 'light' : 'dark';
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    applyTheme(nextTheme);
    setTheme(nextTheme);
  };

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="app-theme-toggle fixed bottom-6 right-6 inline-flex items-center gap-3 rounded-full border border-slate-300/80 bg-white/90 px-4 py-3 text-sm font-medium text-slate-900 shadow-xl backdrop-blur transition hover:bg-slate-50 dark:border-slate-700/80 dark:bg-slate-950/85 dark:text-slate-100 dark:hover:bg-slate-900"
      aria-label={mounted && theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-pressed={mounted && theme === 'dark'}
      title={mounted && theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      <span
        className={`inline-flex h-7 w-12 items-center rounded-full border transition ${
          mounted && theme === 'dark'
            ? 'justify-end border-slate-700 bg-slate-800'
            : 'justify-start border-slate-300 bg-slate-100'
        }`}
        aria-hidden
      >
        <span
          className={`mx-1 flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold transition ${
            mounted && theme === 'dark'
              ? 'bg-sky-300 text-slate-900'
              : 'bg-amber-300 text-slate-900'
          }`}
        >
          {mounted && theme === 'dark' ? 'D' : 'L'}
        </span>
      </span>
      <span>{mounted && theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
    </button>
  );
}
