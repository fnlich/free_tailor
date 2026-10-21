'use client';

import Link from 'next/link';
import { useCallback, useMemo, useState, type ReactNode } from 'react';

import { IconLock } from '@/components/icons';
import Dialog from '@/components/ui/Dialog';
import { isProfileLimit } from '@/lib/api';
import type { LockSpec } from '@/lib/subscriptions';
import css from './subscription.module.css';

/**
 * A feature the account's subscription does not include, drawn LOCKED rather
 * than hidden - with the lock icon, never a "Premium" pill - so the account
 * learns what a higher subscription adds. Pressing the lock, or the locked
 * choice itself, opens "Locked: <what>": what it needs, and **Go to
 * subscription**, where the account can buy it (Settings -> Subscription).
 * The words are lib/subscriptions.ts `describeLock`'s.
 *
 * The server is the real lock every time (403 `subscription-too-low`, 402
 * `profile-limit`); this only stops a page offering a door it would refuse.
 *
 *   const locked = useLockedFeature();
 *   <LockButton lock={describeLock('groups', account)} onOpen={locked.open} />
 *   {locked.dialog}
 */

/** Where every lock leads. */
export const SUBSCRIPTION_PAGE = '/settings/subscription';

/** A lock's name for a screen reader and a tooltip: "Locked: Groups. Needs Premium." */
export function lockLabel(lock: LockSpec): string {
  return `Locked: ${lock.title}. Needs ${lock.needsLabel}.`;
}

/** "Locked: <what>", with Go to subscription and Close. A kit Dialog: Escape and the backdrop close it. */
export function LockedFeatureDialog({ lock, onClose }: { lock: LockSpec | null; onClose: () => void }) {
  return (
    <Dialog
      open={lock !== null}
      title={lock ? `Locked: ${lock.title}` : ''}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="tl-button-quiet">
            Close
          </button>
          <Link href={SUBSCRIPTION_PAGE} onClick={onClose} className="tl-button" data-locked-go>
            Go to subscription
          </Link>
        </>
      }
    >
      {lock && (
        <div className="flex items-start gap-3" data-locked-feature-dialog={lock.feature}>
          <span className={css.panelIcon} aria-hidden>
            <IconLock className="h-5 w-5" />
          </span>
          <p className="text-base text-ink">{lock.body}</p>
        </div>
      )}
    </Dialog>
  );
}

/** The lock dialog's state: `open(lock)` from anything locked, and the `dialog` to render once on the page. */
export function useLockedFeature(): { open: (lock: LockSpec) => void; close: () => void; dialog: ReactNode } {
  const [lock, setLock] = useState<LockSpec | null>(null);
  const open = useCallback((next: LockSpec) => setLock(next), []);
  const close = useCallback(() => setLock(null), []);
  const dialog = useMemo(() => <LockedFeatureDialog lock={lock} onClose={close} />, [lock, close]);
  return { open, close, dialog };
}

/**
 * The lock beside a locked choice: a real button, so a keyboard reaches it
 * (the choice itself is disabled). Its press goes no further than the lock -
 * never to the label or the card around it.
 */
export function LockButton({
  lock,
  onOpen,
  className = '',
}: {
  lock: LockSpec;
  onOpen: (lock: LockSpec) => void;
  className?: string;
}) {
  const label = lockLabel(lock);
  return (
    <button
      type="button"
      className={`${css.lockButton} ${className}`}
      data-locked-feature={lock.feature}
      aria-haspopup="dialog"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen(lock);
      }}
    >
      <IconLock className="h-4 w-4" />
    </button>
  );
}

/**
 * A `.tl-choice` radio card, which a subscription may lock: then the radio is
 * disabled, pressing anywhere on the card opens the lock, and a LockButton
 * sits beside the label - outside it, since a button inside a <label> is not
 * valid HTML - for the keyboard. `data-locked-choice` marks the pair.
 */
export function ChoiceCard({
  name,
  value,
  checked,
  onSelect,
  disabled = false,
  lock = null,
  onLocked,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  onSelect: () => void;
  disabled?: boolean;
  /** Set while the subscription does not include this choice. */
  lock?: LockSpec | null;
  onLocked: (lock: LockSpec) => void;
  children: ReactNode;
}) {
  const card = (
    <label className="tl-choice" data-on={checked} onClick={lock ? () => onLocked(lock) : undefined}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onSelect}
        disabled={disabled || lock !== null}
      />
      <span className="text-sm font-medium text-ink">{children}</span>
    </label>
  );
  if (!lock) return card;
  return (
    <div className={css.lockedChoice} data-locked-choice={value}>
      {card}
      <LockButton lock={lock} onOpen={onLocked} />
    </div>
  );
}

/**
 * The same, standing in for a page or a part of one that the subscription
 * does not include - the Groups page, a new profile past the limit: the lock,
 * what it needs, Go to subscription, and whatever the page adds after it
 * (`children`: Back to profiles).
 */
export function LockedPanel({ lock, children }: { lock: LockSpec; children?: ReactNode }) {
  return (
    <section className={css.panel} aria-label={`Locked: ${lock.title}`} data-locked-panel={lock.feature}>
      <span className={css.panelIcon} aria-hidden>
        <IconLock className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <p className="text-lg font-semibold text-ink">Locked: {lock.title}</p>
        <p className="mt-1 text-sm text-muted">{lock.body}</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Link href={SUBSCRIPTION_PAGE} className="tl-button">
            Go to subscription
          </Link>
          {children}
        </div>
      </div>
    </section>
  );
}

/**
 * After a save or an import refused at the subscription's profile limit (402
 * `profile-limit`): the way to a subscription with room for it, to put inside
 * the <ErrorNotice> that says so. Nothing for any other failure.
 */
export function ProfileLimitLink({ error }: { error: unknown }) {
  if (!isProfileLimit(error)) return null;
  return (
    <p className="mt-2">
      <Link href={SUBSCRIPTION_PAGE} className="font-semibold underline underline-offset-2">
        Go to subscription
      </Link>
    </p>
  );
}

/** The class of the locked Select Group button (components/builder/ProfileTargets.tsx). */
export const LOCKED_INPUT_CLASS = css.lockedInput;
