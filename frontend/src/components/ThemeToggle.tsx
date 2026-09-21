'use client';

import { useTheme } from '@/lib/useTheme';

/**
 * The floating theme control, for the screens that have no top bar.
 *
 * Signed in, the toggle lives in the app's top bar. This is what the sign-in
 * screen, the "cannot reach the server" card and the first-load spinner get
 * instead - the three states `AuthGate` renders before there is any chrome to
 * put a control in.
 *
 * All the logic it used to carry now lives in `useTheme`, which the top bar's
 * icon button shares. That sharing is the point: two independent copies of
 * "which theme is this" drift the moment one of them misses a change.
 */
export default function ThemeToggle() {
  const { theme, mounted, toggle } = useTheme();
  const dark = mounted && theme === 'dark';

  return (
    <button
      type="button"
      onClick={toggle}
      className="app-theme-toggle fixed bottom-6 right-6 inline-flex items-center gap-3 rounded-full border border-slate-300/80 bg-white/90 px-4 py-3 text-sm font-medium text-slate-900 shadow-xl backdrop-blur transition hover:bg-slate-50 dark:border-slate-700/80 dark:bg-slate-950/85 dark:text-slate-100 dark:hover:bg-slate-900"
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-pressed={dark}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      <span
        className={`inline-flex h-7 w-12 items-center rounded-full border transition ${
          dark
            ? 'justify-end border-slate-700 bg-slate-800'
            : 'justify-start border-slate-300 bg-slate-100'
        }`}
        aria-hidden
      >
        <span
          className={`mx-1 flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold transition ${
            dark ? 'bg-sky-300 text-slate-900' : 'bg-amber-300 text-slate-900'
          }`}
        >
          {dark ? 'D' : 'L'}
        </span>
      </span>
      <span>{dark ? 'Light mode' : 'Dark mode'}</span>
    </button>
  );
}
