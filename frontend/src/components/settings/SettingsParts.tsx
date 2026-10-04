import type { ReactNode } from 'react';

/**
 * The account's Settings tabs are built from the shared kit; this file only
 * adds the one piece that is theirs alone - the `<main>` they render into.
 */
export { ErrorNotice, Field, Notice, Section, StaticValue, Status } from '@/components/ui/kit';

/**
 * The `<main>` every account tab renders into.
 *
 * The outer box is the shell's SettingsHeader box - same width, same gutters -
 * so the page's left edge sits exactly under the "Settings" title at every
 * window size. The inner one is what keeps a form at a readable measure; it
 * narrows from the right and never moves the left edge. No top padding: the
 * first section's own padding is the gap under the tabs.
 */
export function SettingsPage({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
      <div className="max-w-5xl">{children}</div>
    </main>
  );
}
