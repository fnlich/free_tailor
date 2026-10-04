import type { ReactNode } from 'react';

/**
 * The building blocks every page is made of, after the reference design the
 * shell follows (textverified's dashboard): a large page title with one line
 * under it, sections ruled off by hairlines, bordered cards and tables, solid
 * primary buttons, outlined secondary ones, and small status pills.
 *
 * Thin wrappers over the .tl-* classes in globals.css - those classes are the
 * real source, so markup that cannot use a component (the JSX bid assistant,
 * a table cell) can use the class and come out identical. Nothing here fetches
 * or holds state.
 *
 * Why classes and tokens at all, rather than Tailwind's colour utilities: the
 * html.dark shim at the end of globals.css is unlayered and beats every
 * utility and every `dark:` variant, so `bg-white dark:bg-slate-900` renders
 * the shim's colour, not the variant's. The tokens (text-ink, text-muted,
 * bg-surface...) and these classes are names the shim has never heard of, so
 * what they say is what renders, in both themes.
 */

type Width = 'narrow' | 'default' | 'wide' | 'full';

const WIDTHS: Record<Width, string> = {
  narrow: 'max-w-5xl',
  default: 'max-w-6xl',
  wide: 'max-w-7xl',
  full: 'max-w-none',
};

/** The page's own `<main>`: centred, gutters that grow with the screen. */
export function Page({
  width = 'default',
  className = '',
  children,
}: {
  width?: Width;
  className?: string;
  children: ReactNode;
}) {
  return (
    <main className={`mx-auto w-full ${WIDTHS[width]} px-4 py-10 sm:px-6 lg:px-8 ${className}`}>
      {children}
    </main>
  );
}

/**
 * The title row: what this page is, one sentence on what it is for, and the
 * page's main action on the right - Purchase Credits, New Profile.
 */
export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Under the title row - tabs, a filter bar. */
  children?: ReactNode;
}) {
  return (
    <header className="mb-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold tracking-tight text-ink">{title}</h1>
          {description && <p className="mt-2 max-w-3xl text-base text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
      </div>
      {children && <div className="mt-6">{children}</div>}
    </header>
  );
}

/** A block of settings or a form: heading, one line, its fields - ruled off below. */
export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="tl-section">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold text-ink">{title}</h2>
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-6 space-y-6">{children}</div>}
    </section>
  );
}

/** A bordered box, with an optional ruled-off title row. */
export function Card({
  title,
  description,
  actions,
  padded = true,
  className = '',
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** False for a card whose body is a table or a list that brings its own padding. */
  padded?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`tl-card ${className}`}>
      {(title || actions) && (
        <div className="tl-card-header">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children && <div className={padded ? 'p-5' : ''}>{children}</div>}
    </div>
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
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="tl-label">
          {label}
        </label>
      ) : (
        <p className="tl-label">{label}</p>
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
 * through the side of the page rather than wrap.
 */
export function StaticValue({ children }: { children: ReactNode }) {
  return (
    <div className="tl-field-static">
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

export type Tone = 'info' | 'success' | 'warn' | 'error';

/** A framed message: what is wrong, what to do, or what happened. */
export function Notice({
  tone = 'info',
  role,
  className = '',
  children,
}: {
  tone?: Tone | 'neutral';
  role?: 'alert' | 'status';
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`tl-notice ${className}`} data-tone={tone} role={role}>
      {children}
    </div>
  );
}

/** One line under a control saying what just happened: saved, or why not. */
export function Status({ tone, children }: { tone: 'ok' | 'error'; children: ReactNode }) {
  return (
    <p className="tl-status mt-3" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}

export type PillTone = 'green' | 'amber' | 'red' | 'sky' | 'violet' | 'grey';

/** A small labelled state: Completed, Pending, Built-in, Admin. */
export function Pill({ tone = 'grey', children }: { tone?: PillTone; children: ReactNode }) {
  return (
    <span className="tl-pill" data-tone={tone}>
      {children}
    </span>
  );
}

/** Nothing here yet, and what would put something here. */
export function EmptyState({
  title,
  action,
  children,
}: {
  title: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="tl-card px-6 py-12 text-center">
      <p className="text-base font-semibold text-ink">{title}</p>
      {children && <div className="mx-auto mt-2 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-6 flex justify-center">{action}</div>}
    </div>
  );
}

/** A load in progress, said out loud as well as drawn. */
export function Spinner({ label = 'Loading...' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-sm text-muted" role="status">
      <span className="tl-spinner" aria-hidden />
      <span>{label}</span>
    </div>
  );
}
