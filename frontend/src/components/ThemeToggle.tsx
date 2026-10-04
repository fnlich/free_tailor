'use client';

import { IconMoon, IconSun } from '@/components/icons';
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
      // The kit's outlined button, pinned to the corner. No shadow: the bare
      // `shadow*` utilities are ones the dark-mode shim rewrites.
      className="app-theme-toggle tl-button-quiet fixed bottom-6 right-6"
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-pressed={dark}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {dark ? (
        <IconSun className="h-[18px] w-[18px]" />
      ) : (
        <IconMoon className="h-[18px] w-[18px]" />
      )}
      <span>{dark ? 'Light mode' : 'Dark mode'}</span>
    </button>
  );
}
