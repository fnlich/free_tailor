import type { ReactNode } from 'react';

/**
 * The account's Settings tabs are built from the shared kit; this file only
 * adds the one piece that is theirs alone - the `<main>` they render into.
 */
export { Field, Notice, Section, StaticValue, Status } from '@/components/ui/kit';

/**
 * The `<main>` every account tab renders into.
 *
 * Same width and gutters as the shell's SettingsHeader above it at this size,
 * so the page's left edge sits exactly under the "Settings" title. No top
 * padding: the first section's own padding is the gap under the tabs.
 */
export function SettingsPage({ children }: { children: ReactNode }) {
  return <main className="mx-auto max-w-5xl px-4 pb-16 sm:px-6 lg:px-8">{children}</main>;
}
