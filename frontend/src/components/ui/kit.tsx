import type { ReactNode } from 'react';

import { ContactAdminLink } from '@/components/contact/ContactAdminDialog';
import { operatorDetail } from '@/lib/api';
import { asksForAdministrator } from '@/lib/contactChannels';
import { userMessage } from '@/lib/userMessage';

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

/**
 * A sentence, followed by a "Contact admin" link when it tells its reader to
 * contact an administrator - "Please try again, or contact your
 * administrator." is a dead end without a way to do it.
 *
 * Only a sentence held as TEXT is read: that is what `userMessage` and
 * `messageWithDetail` produce, and what a page puts in a Notice or a Status
 * after a failure. A notice written as JSX says what it means for itself.
 */
function withContactLink(children: ReactNode, offer: boolean): ReactNode {
  if (!offer || typeof children !== 'string') return children;
  return (
    <>
      {children}
      <ContactAdminFor text={children} />
    </>
  );
}

/**
 * The same link for a sentence drawn OUTSIDE the kit's notices - a row's error
 * cell, a dialog's own banner, the Bid Assistant's error lines: a space and
 * "Contact admin" when `text` asks its reader to contact an administrator,
 * and nothing otherwise. Put it straight after the text.
 */
export function ContactAdminFor({ text }: { text: unknown }) {
  if (!asksForAdministrator(text)) return null;
  return (
    <>
      {' '}
      <ContactAdminLink />
    </>
  );
}

/**
 * A framed message: what is wrong, what to do, or what happened.
 *
 * A warning or an error whose text asks the reader to contact an administrator
 * gets a Contact admin link after it (see `withContactLink`).
 */
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
      {withContactLink(children, tone === 'error' || tone === 'warn')}
    </div>
  );
}

/**
 * A failure, said the way every page says one.
 *
 * `error` is whatever was caught - or a sentence the page wrote itself, for its
 * own validation. A caught error goes through `userMessage`, so the reader gets
 * the server's sentence (with its reference) or the "can't reach the server"
 * one, never a stack of URLs or a library's text. Under it, the server's
 * `detail` - which it sends to administrators only, so no role check is made
 * here: for everybody else there is simply nothing to draw.
 *
 * Renders nothing for a null, undefined or empty `error`, so a page can mount
 * it unconditionally next to the thing that can fail. A sentence that says to
 * contact the administrator - every generic failure with a Ref does - ends in
 * a Contact admin link that opens the channels they listed.
 */
export function ErrorNotice({
  error,
  fallback,
  onDismiss,
  className = '',
  children,
}: {
  error: unknown;
  /** Said when the failure carries no sentence of its own, e.g. "Could not load your orders". */
  fallback?: string;
  /** Adds the × that clears it, for a notice that would otherwise outstay the problem. */
  onDismiss?: () => void;
  className?: string;
  /** After the sentence - a link to the page that fixes it, a retry button. */
  children?: ReactNode;
}) {
  if (error === null || error === undefined || error === '' || error === false) return null;
  const message = typeof error === 'string' ? error : userMessage(error, fallback);
  const detail = operatorDetail(error);
  const body = (
    <>
      <p className="break-words">{withContactLink(message, true)}</p>
      {/* Administrators only: the server withholds `detail` from everyone else. */}
      {detail && <p className="mt-2 whitespace-pre-wrap break-words text-xs opacity-90">{detail}</p>}
      {children}
    </>
  );
  if (!onDismiss) {
    return (
      <Notice tone="error" role="alert" className={className}>
        {body}
      </Notice>
    );
  }
  return (
    <Notice tone="error" role="alert" className={`flex items-start justify-between gap-4 ${className}`}>
      <div className="min-w-0">{body}</div>
      <button
        type="button"
        onClick={onDismiss}
        className="-my-1 shrink-0 px-1 text-lg font-bold leading-none"
        aria-label="Dismiss"
      >
        ×
      </button>
    </Notice>
  );
}

/**
 * One line under a control saying what just happened: saved, or why not - and,
 * when the why says to contact the administrator, a Contact admin link.
 */
export function Status({ tone, children }: { tone: 'ok' | 'error'; children: ReactNode }) {
  return (
    <p className="tl-status mt-3" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      {withContactLink(children, tone === 'error')}
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

/** A load in progress, said out loud as well as drawn. `compact` for inside a small panel. */
export function Spinner({ label = 'Loading...', compact = false }: { label?: string; compact?: boolean }) {
  return (
    <div
      className={`flex items-center justify-center gap-3 text-sm text-muted ${compact ? 'py-3' : 'py-12'}`}
      role="status"
    >
      <span className="tl-spinner" aria-hidden />
      <span>{label}</span>
    </div>
  );
}
