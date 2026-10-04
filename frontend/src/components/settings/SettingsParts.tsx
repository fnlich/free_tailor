import type { ReactNode } from 'react';

import styles from './settings.module.css';

/**
 * The building blocks of the account's Settings tabs, after the reference's
 * Settings > Profile: a heading and one line of explanation per section, a
 * hairline between sections, and labelled full-width fields under each.
 *
 * Shared by the four account tabs so the gaps, the heading sizes and the label
 * style are decided once. Each page keeps its own data and behaviour; nothing
 * here fetches or holds state.
 */

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

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="tl-section">
      <h2 className="text-xl font-semibold text-ink">{title}</h2>
      <p className="mt-1 text-sm text-muted">{description}</p>
      {children && <div className="mt-6 space-y-6">{children}</div>}
    </section>
  );
}

/**
 * A label over a value or a control.
 *
 * `htmlFor` makes the label a real `<label>` for an input. Without it the
 * value is read-only text, which a `<label>` would mislabel, so the caption is
 * a plain element instead.
 */
export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const caption = 'block text-sm font-medium text-ink';
  return (
    <div className="min-w-0">
      {htmlFor ? (
        <label htmlFor={htmlFor} className={caption}>
          {label}
        </label>
      ) : (
        <p className={caption}>{label}</p>
      )}
      <div className="mt-2">{children}</div>
      {hint && <p className="mt-2 text-sm text-subtle">{hint}</p>}
    </div>
  );
}

/**
 * A read-only value in the shape of an input, like the reference's Email.
 *
 * The inner span is what lets a long value wrap. `.tl-field-static` is a flex
 * box, and a flex item will not shrink below its longest word - which for an
 * email address is the whole address, so on a phone it would push the box out
 * through the side of the page rather than wrap. Wrapped, not truncated: it is
 * somebody's own address, and it should stay readable and selectable.
 */
export function StaticValue({ children }: { children: ReactNode }) {
  return (
    <div className="tl-field-static">
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

/** A framed message standing in for a section's content. */
export function Notice({
  tone = 'info',
  role,
  children,
}: {
  tone?: 'info' | 'warn' | 'error';
  role?: 'alert' | 'status';
  children: ReactNode;
}) {
  return (
    <div className={styles.notice} data-tone={tone} role={role}>
      {children}
    </div>
  );
}

/** One line under a control saying what just happened: saved, or why not. */
export function Status({ tone, children }: { tone: 'ok' | 'error'; children: ReactNode }) {
  return (
    <p className={styles.status} data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}

export { styles as settingsStyles };
