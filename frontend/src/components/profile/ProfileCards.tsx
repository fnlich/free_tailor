'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  IconCopy,
  IconDownload,
  IconEye,
  IconEyeOff,
  IconLock,
  IconMoreVertical,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@/components/icons';
import { lockLabel } from '@/components/subscription/LockedFeature';
import { profilesApi, type Profile, type Template } from '@/lib/api';
import { formatDate } from '@/lib/format';
import type { LockSpec } from '@/lib/subscriptions';
import { drawnTemplate } from '@/lib/profileDraft';
import { editedAgo } from '@/lib/profileGallery';
import { ActionMenu } from './ActionMenu';
import { PageThumb, ThumbLoading, ThumbState } from './PageThumb';
import css from './profilePages.module.css';

/** The editor, on the profile's own route. */
export function profileEditorHref(profile: Pick<Profile, 'id'>): string {
  return `/admin/profiles/${encodeURIComponent(profile.id)}`;
}

/**
 * FlowCV's dashed "New resume" tile, first in the grid: the way to the
 * template chooser. Off, with the reason as its tooltip, while the account is
 * still being read. At the subscription's limit it is LOCKED instead: still
 * pressable, with the lock and "Needs <tier>", and the press opens the lock's
 * dialog (components/subscription/LockedFeature.tsx) rather than the chooser.
 */
export function NewProfileTile({
  onClick,
  blockedReason,
  locked,
}: {
  onClick: () => void;
  blockedReason?: string;
  locked?: { lock: LockSpec; onLocked: (lock: LockSpec) => void } | null;
}) {
  const label = locked ? lockLabel(locked.lock) : undefined;
  return (
    <button
      type="button"
      className={css.newTile}
      onClick={locked ? () => locked.onLocked(locked.lock) : onClick}
      disabled={Boolean(blockedReason)}
      title={blockedReason ?? label}
      aria-haspopup={locked ? 'dialog' : undefined}
      data-locked-feature={locked ? locked.lock.feature : undefined}
    >
      <span className={css.newIcon} aria-hidden="true">
        {locked ? <IconLock className="h-7 w-7" strokeWidth={2.2} /> : <IconPlus className="h-7 w-7" strokeWidth={2.4} />}
      </span>
      <span className={css.newLabel}>New profile</span>
      <span className={css.newHint}>{locked ? `Needs ${locked.lock.needsLabel}` : 'Start from a template'}</span>
    </button>
  );
}

/**
 * Duplicate on a card's menu: on, off while the account is still being read
 * (`reason` as its tooltip), or locked at the subscription's limit - then
 * choosing it opens the lock's dialog.
 */
export type DuplicateState =
  | { kind: 'open' }
  | { kind: 'waiting'; reason: string }
  | { kind: 'locked'; lock: LockSpec; onLocked: (lock: LockSpec) => void };

/**
 * The profile's first page, as the server draws it - the stored profile on
 * its own template and layout, with nothing filled in from the sample person
 * (`sample: false`): an empty section is empty here too. Asked for only once
 * the card is near the screen, and once per version of the profile (the
 * card is keyed by its `updatedAt`).
 */
function ProfileThumb({ profile }: { profile: Profile }) {
  const box = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const controller = new AbortController();
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        profilesApi.preview({ profile: {}, profileId: profile.id, sample: false }, controller.signal).then(
          (answer) => setHtml(answer.html),
          () => {
            if (!controller.signal.aborted) setFailed(true);
          }
        );
      },
      { rootMargin: '300px' }
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      controller.abort();
    };
  }, [profile.id]);

  return (
    <div ref={box}>
      <PageThumb
        srcDoc={html ?? undefined}
        title={`${profile.name || 'Profile'} preview`}
        placeholder={failed ? <ThumbState>No preview</ThumbState> : <ThumbLoading />}
      />
    </div>
  );
}

/**
 * The template line under a card's name, and what to say when the profile is
 * drawn with another one - which is only when its own is not offered any more:
 * every template prints both Technical Skills layouts.
 */
function templateLine(templates: readonly Template[], profile: Profile): { name: string; warning: string } {
  if (templates.length === 0) return { name: '', warning: '' };
  const { stored, drawn } = drawnTemplate(templates, profile);
  if (stored) return { name: stored.name, warning: '' };
  return {
    name: drawn?.name ?? '',
    warning: drawn
      ? `The template this profile names is not offered any more, so it is drawn with ${drawn.name}.`
      : 'The template this profile names is not offered any more.',
  };
}

/**
 * A profile on the list, after FlowCV's resume card: its first page (a link
 * to the editor), its name, "Edited 6 hours ago · <template>", and ⋮ with
 * Edit, Duplicate, Download, Disable / Enable and Delete.
 */
export function ProfileCard({
  profile,
  templates,
  now,
  onEdit,
  onDuplicate,
  duplicate = { kind: 'open' },
  onDownload,
  onToggleDisabled,
  onDelete,
}: {
  profile: Profile;
  templates: readonly Template[];
  /** The page's clock, so every card's "Edited ... ago" moves together. */
  now: number;
  onEdit: () => void;
  onDuplicate: () => void;
  /** Whether Duplicate is on, waiting for the account, or locked at the subscription's limit. */
  duplicate?: DuplicateState;
  onDownload: () => void;
  onToggleDisabled: () => void;
  onDelete: () => void;
}) {
  const name = profile.name || 'Untitled profile';
  const edited = editedAgo(profile.updatedAt, now) ?? `Edited ${formatDate(profile.updatedAt, { style: 'date' })}`;
  const { name: templateName, warning } = templateLine(templates, profile);

  return (
    <article className={css.card}>
      {/* The page under a link the size of it: a frame may not sit inside a link. */}
      <div className={css.cardThumb} data-disabled={profile.disabled ? 'true' : 'false'}>
        <ProfileThumb profile={profile} />
        <Link href={profileEditorHref(profile)} className={css.cover} aria-label={`Edit ${name}`} />
        {profile.disabled && <span className={css.cardBadge}>Disabled</span>}
      </div>
      <div className={css.cardFoot}>
        <div className={css.cardText}>
          <h2 className={css.cardTitle} title={name}>
            <Link href={profileEditorHref(profile)}>{name}</Link>
          </h2>
          <p className={css.cardMeta} title={profile.title || undefined}>
            {edited}
            {templateName && ` · ${templateName}`}
          </p>
          {warning && <p className={css.cardWarning}>{warning}</p>}
        </div>
        <ActionMenu
          triggerClassName={css.menuButton}
          triggerLabel={`Actions for ${name}`}
          triggerContent={<IconMoreVertical className="h-5 w-5" strokeWidth={2.2} />}
          items={[
            { key: 'edit', label: 'Edit', icon: IconPencil, onSelect: onEdit },
            duplicate.kind === 'locked'
              ? {
                  key: 'duplicate',
                  label: 'Duplicate',
                  hint: `Locked: needs ${duplicate.lock.needsLabel}`,
                  icon: IconLock,
                  title: lockLabel(duplicate.lock),
                  onSelect: () => duplicate.onLocked(duplicate.lock),
                }
              : {
                  key: 'duplicate',
                  label: 'Duplicate',
                  icon: IconCopy,
                  disabled: duplicate.kind === 'waiting',
                  title: duplicate.kind === 'waiting' ? duplicate.reason : undefined,
                  onSelect: onDuplicate,
                },
            {
              key: 'download',
              label: 'Download JSON',
              title: 'The profile as a file that Import existing resume takes back',
              icon: IconDownload,
              onSelect: onDownload,
            },
            {
              key: 'toggle',
              label: profile.disabled ? 'Enable' : 'Disable',
              title: profile.disabled ? undefined : 'Kept, but left out of Build Resumes',
              icon: profile.disabled ? IconEye : IconEyeOff,
              onSelect: onToggleDisabled,
            },
            { key: 'delete', label: 'Delete', icon: IconTrash, tone: 'danger', ruleBefore: true, onSelect: onDelete },
          ]}
        />
      </div>
    </article>
  );
}

/** Saves text as a file through a hidden anchor on a `blob:` URL, so the name is honoured and nothing navigates. */
export function saveTextFile(name: string, text: string, type = 'application/json'): void {
  const href = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = name;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Kept a while: the browser reads the blob after the click returns.
    window.setTimeout(() => URL.revokeObjectURL(href), 60_000);
  }
}
