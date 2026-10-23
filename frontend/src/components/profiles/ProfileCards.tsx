'use client';

import Link from 'next/link';
import { IconFolder, IconLock, IconMoreVertical, IconPencil, IconPlus, IconStar, IconTrash } from '@/components/icons';
import { ActionMenu, type ActionMenuItem } from '@/components/resume/ActionMenu';
import { PageThumb, ThumbState } from '@/components/resume/PageThumb';
import { NewResumeTile, ResumeThumb } from '@/components/resume/ResumeCards';
import resumeCss from '@/components/resume/resumePages.module.css';
import { lockLabel } from '@/components/subscription/LockedFeature';
import type { ProfileSummary, Resume } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { profilePageHref, resumeLabel } from '@/lib/profileDashboard';
import { editedAgo } from '@/lib/resumeGallery';
import type { LockSpec } from '@/lib/subscriptions';
import css from './profiles.module.css';

/** "3 resumes", "1 resume". */
export function resumeCountText(count: number): string {
  return `${count} resume${count === 1 ? '' : 's'}`;
}

function profileName(profile: Pick<ProfileSummary, 'name'>): string {
  return profile.name.trim() || 'Untitled Profile';
}

function editedLine(profile: Pick<ProfileSummary, 'lastEditedAt'>, now: number): string {
  return editedAgo(profile.lastEditedAt, now) ?? `Edited ${formatDate(profile.lastEditedAt, { style: 'date' })}`;
}

/**
 * The dashed tile first in a grid: "New profile" on the Profiles tab,
 * "New resume" on All resumes and on a profile's page.
 *
 * A new PROFILE is what a subscription counts, so that tile is LOCKED at the
 * limit - pressable, with the lock and "Needs <tier>", and the press opens the
 * lock's dialog rather than naming a profile. A resume is never counted, so
 * its tile is never locked. Either is off, with the reason as its tooltip,
 * while the page cannot yet say what it may do.
 */
export function NewTile({
  kind,
  onClick,
  blockedReason,
  locked,
}: {
  kind: 'profile' | 'resume';
  onClick: () => void;
  blockedReason?: string;
  locked?: { lock: LockSpec; onLocked: (lock: LockSpec) => void } | null;
}) {
  if (kind === 'resume') return <NewResumeTile onClick={onClick} blockedReason={blockedReason} />;
  const tip = locked ? lockLabel(locked.lock) : undefined;
  return (
    <button
      type="button"
      className={resumeCss.newTile}
      onClick={locked ? () => locked.onLocked(locked.lock) : onClick}
      disabled={Boolean(blockedReason)}
      title={blockedReason ?? tip}
      aria-haspopup={locked ? 'dialog' : undefined}
      data-new-tile="profile"
      data-locked-feature={locked ? locked.lock.feature : undefined}
    >
      <span className={resumeCss.newIcon} aria-hidden="true">
        {locked ? <IconLock className="h-7 w-7" strokeWidth={2.2} /> : <IconPlus className="h-7 w-7" strokeWidth={2.4} />}
      </span>
      <span className={resumeCss.newLabel}>New profile</span>
      <span className={resumeCss.newHint}>
        {locked ? `Needs ${locked.lock.needsLabel}` : 'A person you build resumes for'}
      </span>
    </button>
  );
}

/** A profile's ⋮ menu: Open, Rename, New resume, then Delete. */
export function profileMenuItems(actions: {
  onOpen: () => void;
  onRename: () => void;
  onNewResume: () => void;
  onDelete: () => void;
}): ActionMenuItem[] {
  return [
    { key: 'open', label: 'Open', icon: IconFolder, onSelect: actions.onOpen },
    { key: 'rename', label: 'Rename', icon: IconPencil, onSelect: actions.onRename },
    { key: 'new-resume', label: 'New resume', icon: IconPlus, onSelect: actions.onNewResume },
    { key: 'delete', label: 'Delete', icon: IconTrash, tone: 'danger', ruleBefore: true, onSelect: actions.onDelete },
  ];
}

/**
 * A profile on the Profiles tab's grid: the first page of its default resume
 * (a link to the profile's page), the person's name, how many resumes it holds
 * and when it was last edited, and ⋮ with `items` (profileMenuItems).
 */
export function ProfileCard({
  profile,
  defaultResume,
  now,
  items,
}: {
  profile: ProfileSummary;
  /** The profile's effective default resume, when it has one and the page has read it. */
  defaultResume: Resume | null;
  now: number;
  items: readonly ActionMenuItem[];
}) {
  const name = profileName(profile);
  return (
    <article className={resumeCss.card} data-profile-card={profile.id}>
      <div className={resumeCss.cardThumb} data-disabled="false">
        {defaultResume ? (
          <ResumeThumb resume={defaultResume} label={`${name}, ${resumeLabel(defaultResume)}`} />
        ) : (
          <PageThumb title={`${name} has no resume yet`} placeholder={<ThumbState>No resumes yet</ThumbState>} />
        )}
        <Link
          href={profilePageHref(profile.id)}
          className={resumeCss.cover}
          aria-label={`Open ${name}, ${resumeCountText(profile.resumeCount)}`}
        />
      </div>
      <div className={resumeCss.cardFoot}>
        <div className={resumeCss.cardText}>
          <h2 className={resumeCss.cardTitle} title={name}>
            <Link href={profilePageHref(profile.id)}>{name}</Link>
          </h2>
          <p className={resumeCss.cardMeta}>{resumeCountText(profile.resumeCount)}</p>
          <p className={resumeCss.cardMeta}>{editedLine(profile, now)}</p>
        </div>
        <ActionMenu
          triggerClassName={resumeCss.menuButton}
          triggerLabel={`Actions for ${name}`}
          triggerContent={<IconMoreVertical className="h-5 w-5" strokeWidth={2.2} />}
          items={items}
        />
      </div>
    </article>
  );
}

/** The same profile as a row of the List view: name, resumes, ★ default, edited, ⋮. */
export function ProfileRow({
  profile,
  defaultResume,
  now,
  items,
}: {
  profile: ProfileSummary;
  defaultResume: Resume | null;
  now: number;
  items: readonly ActionMenuItem[];
}) {
  const name = profileName(profile);
  return (
    <li className={`${css.listRow} ${css.rowProfile}`} data-profile-row={profile.id}>
      <div className={css.cellMain}>
        <Link href={profilePageHref(profile.id)} title={name}>
          {name}
        </Link>
      </div>
      <div className={css.cell}>{resumeCountText(profile.resumeCount)}</div>
      <div className={css.cell}>
        {defaultResume ? (
          <span className={css.starLabel} title={resumeLabel(defaultResume)}>
            <IconStar className="h-4 w-4" fill="currentColor" />
            {resumeLabel(defaultResume)}
          </span>
        ) : (
          'No default yet'
        )}
      </div>
      <div className={css.cell}>{editedLine(profile, now)}</div>
      <div className={css.cellMenu}>
        <ActionMenu
          triggerClassName={css.rowMenuButton}
          triggerLabel={`Actions for ${name}`}
          triggerContent={<IconMoreVertical className="h-5 w-5" strokeWidth={2.2} />}
          items={items}
        />
      </div>
    </li>
  );
}
