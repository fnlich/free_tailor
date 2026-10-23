'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { IconMoreVertical, IconPlus, IconStar } from '@/components/icons';
import profileCss from '@/components/profiles/profiles.module.css';
import { resumesApi, type Resume, type Template } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { profilePageHref, resumeLabel } from '@/lib/profileDashboard';
import { drawnTemplate } from '@/lib/resumeDraft';
import { editedAgo } from '@/lib/resumeGallery';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { PageThumb, ThumbLoading, ThumbState } from './PageThumb';
import css from './resumePages.module.css';

/** The editor, on the resume's own route. */
export function resumeEditorHref(resume: Pick<Resume, 'id'>): string {
  return `/admin/resumes/${encodeURIComponent(resume.id)}`;
}

/**
 * FlowCV's dashed "New resume" tile, first in the grid: the way to the
 * template chooser. Never locked - resumes are not counted, only profiles are -
 * and off, with the reason as its tooltip, only while the page cannot yet say
 * where the resume goes.
 */
export function NewResumeTile({ onClick, blockedReason }: { onClick: () => void; blockedReason?: string }) {
  return (
    <button
      type="button"
      className={css.newTile}
      onClick={onClick}
      disabled={Boolean(blockedReason)}
      title={blockedReason}
      data-new-tile="resume"
    >
      <span className={css.newIcon} aria-hidden="true">
        <IconPlus className="h-7 w-7" strokeWidth={2.4} />
      </span>
      <span className={css.newLabel}>New resume</span>
      <span className={css.newHint}>Start from a template</span>
    </button>
  );
}

/*
 * The thumbnails of a dashboard are asked for once per version of a resume,
 * not once per card drawn: switching tabs or between Grid and List unmounts
 * every card, and a fresh POST /resumes/preview for each of them would draw the
 * same pages again. The last 24 pages are kept here, by resume id and
 * `updatedAt` (a save is a new key), and a request in flight is shared by the
 * cards that ask for the same page.
 */
const THUMB_CACHE_SIZE = 24;
const thumbPages = new Map<string, string>();
const thumbRequests = new Map<string, Promise<string>>();

function thumbKey(resume: Pick<Resume, 'id' | 'updatedAt'>): string {
  return `${resume.id}:${resume.updatedAt}`;
}

/** A kept page; reading it changes nothing (a render may read it, only an effect `touchThumb`s). */
function cachedThumb(key: string): string | undefined {
  return thumbPages.get(key);
}

/** A page just used is the newest of the kept ones, so the pages on screen are the last to go. */
function touchThumb(key: string): void {
  const html = thumbPages.get(key);
  if (html === undefined) return;
  thumbPages.delete(key);
  thumbPages.set(key, html);
}

function rememberThumb(key: string, html: string): void {
  thumbPages.delete(key);
  thumbPages.set(key, html);
  while (thumbPages.size > THUMB_CACHE_SIZE) {
    const oldest = thumbPages.keys().next().value;
    if (oldest === undefined) break;
    thumbPages.delete(oldest);
  }
}

function loadThumb(resume: Pick<Resume, 'id' | 'updatedAt'>): Promise<string> {
  const key = thumbKey(resume);
  const pending = thumbRequests.get(key);
  if (pending) return pending;
  const request = resumesApi
    .preview({ resume: {}, resumeId: resume.id, sample: false })
    .then((answer) => {
      rememberThumb(key, answer.html);
      return answer.html;
    })
    .finally(() => {
      thumbRequests.delete(key);
    });
  thumbRequests.set(key, request);
  return request;
}

/**
 * The resume's first page, as the server draws it - the stored resume on
 * its own template and layout, with nothing filled in from the sample person
 * (`sample: false`): an empty section is empty here too. Asked for only once
 * the card is near the screen, and once per version of the resume (the cache
 * above, keyed `id:updatedAt`).
 */
export function ResumeThumb({ resume, label }: { resume: Pick<Resume, 'id' | 'updatedAt'> & Partial<Resume>; label?: string }) {
  const { id, updatedAt } = resume;
  const key = thumbKey({ id, updatedAt });
  const box = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<{ key: string; html: string } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const kept = cachedThumb(key);
  const html = kept ?? (loaded?.key === key ? loaded.html : null);
  const isKept = kept !== undefined;

  useEffect(() => {
    if (isKept) {
      touchThumb(thumbKey({ id, updatedAt }));
      return;
    }
    const element = box.current;
    if (!element) return;
    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        loadThumb({ id, updatedAt }).then(
          (page) => {
            if (!cancelled) setLoaded({ key: thumbKey({ id, updatedAt }), html: page });
          },
          () => {
            if (!cancelled) setFailedKey(thumbKey({ id, updatedAt }));
          }
        );
      },
      { rootMargin: '300px' }
    );
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [id, updatedAt, isKept]);

  return (
    <div ref={box}>
      <PageThumb
        srcDoc={html ?? undefined}
        title={`${label || resume.name || 'Resume'} preview`}
        placeholder={failedKey === key ? <ThumbState>No preview</ThumbState> : <ThumbLoading />}
      />
    </div>
  );
}

/**
 * The template line under a card's name, and what to say when the resume is
 * drawn with another one - which is only when its own is not offered any more:
 * every template prints both Technical Skills layouts.
 */
function templateLine(templates: readonly Template[], resume: Resume): { name: string; warning: string } {
  if (templates.length === 0) return { name: '', warning: '' };
  const { stored, drawn } = drawnTemplate(templates, resume);
  if (stored) return { name: stored.name, warning: '' };
  return {
    name: drawn?.name ?? '',
    warning: drawn
      ? `The template this resume names is not offered any more, so it is drawn with ${drawn.name}.`
      : 'The template this resume names is not offered any more.',
  };
}

/** The words under a resume's title: "Edited 6 hours ago", or the date once it is a week old. */
function editedLine(resume: Pick<Resume, 'updatedAt'>, now: number): string {
  return editedAgo(resume.updatedAt, now) ?? `Edited ${formatDate(resume.updatedAt, { style: 'date' })}`;
}

/** What a resume's ★ Default and Disabled say, beside its title or over its page. */
function ResumeBadges({ isDefault, disabled, inline }: { isDefault: boolean; disabled: boolean; inline: boolean }) {
  const base = inline ? profileCss.badgeInline : profileCss.badge;
  return (
    <>
      {isDefault && (
        <span className={`${base} ${inline ? '' : profileCss.badgeDefault}`} data-default-resume>
          <IconStar className="h-3.5 w-3.5" fill="currentColor" />
          Default
        </span>
      )}
      {disabled && <span className={base}>Disabled</span>}
    </>
  );
}

/**
 * A resume on a card, after FlowCV's resume card: its first page (a link to
 * the editor), its headline, the profile it is in (a link to that profile's
 * page, on the All resumes tab), "Edited 6 hours ago · <template>", ★ Default
 * and Disabled badges over the page, and ⋮ with the menu `items` the page's
 * actions (components/profiles/useResumeActions) built.
 */
export function ResumeCard({
  resume,
  templates,
  now,
  isDefault = false,
  profile = null,
  items,
}: {
  resume: Resume;
  templates: readonly Template[];
  /** The page's clock, so every card's "Edited ... ago" moves together. */
  now: number;
  /** The profile's effective default resume. */
  isDefault?: boolean;
  /** Named under the headline, with a link to its page; none on a profile's own page. */
  profile?: { id: string; name: string } | null;
  items: readonly ActionMenuItem[];
}) {
  const label = resumeLabel(resume);
  const { name: templateName, warning } = templateLine(templates, resume);

  return (
    <article className={css.card} data-resume-card={resume.id}>
      {/* The page under a link the size of it: a frame may not sit inside a link. */}
      <div className={css.cardThumb} data-disabled={resume.disabled ? 'true' : 'false'}>
        <ResumeThumb resume={resume} label={label} />
        <Link href={resumeEditorHref(resume)} className={css.cover} aria-label={`Edit ${label}`} />
        {(isDefault || resume.disabled) && (
          <span className={profileCss.thumbBadges}>
            <ResumeBadges isDefault={isDefault} disabled={Boolean(resume.disabled)} inline={false} />
          </span>
        )}
      </div>
      <div className={css.cardFoot}>
        <div className={css.cardText}>
          <h2 className={css.cardTitle} title={label}>
            <Link href={resumeEditorHref(resume)}>{label}</Link>
          </h2>
          {profile && (
            <p className={css.cardMeta} title={profile.name}>
              <Link href={profilePageHref(profile.id)} className={profileCss.profileLink}>
                {profile.name}
              </Link>
            </p>
          )}
          <p className={css.cardMeta}>
            {editedLine(resume, now)}
            {templateName && ` · ${templateName}`}
          </p>
          {warning && <p className={css.cardWarning}>{warning}</p>}
        </div>
        <ActionMenu
          triggerClassName={css.menuButton}
          triggerLabel={`Actions for ${label}`}
          triggerContent={<IconMoreVertical className="h-5 w-5" strokeWidth={2.2} />}
          items={items}
        />
      </div>
    </article>
  );
}

/**
 * The same resume as a row of the List view: headline (with its badges),
 * profile, template, when it was edited, and ⋮. On a profile's own page
 * (`profile` none) the profile's column says the name printed on the resume.
 */
export function ResumeRow({
  resume,
  templates,
  now,
  isDefault = false,
  profile = null,
  items,
}: {
  resume: Resume;
  templates: readonly Template[];
  now: number;
  isDefault?: boolean;
  profile?: { id: string; name: string } | null;
  items: readonly ActionMenuItem[];
}) {
  const label = resumeLabel(resume);
  const { name: templateName } = templateLine(templates, resume);

  return (
    <li className={`${profileCss.listRow} ${profileCss.rowResume}`} data-resume-row={resume.id} data-disabled={resume.disabled ? 'true' : 'false'}>
      <div className={profileCss.cellMain}>
        <Link href={resumeEditorHref(resume)} title={label}>
          {label}
        </Link>
        <ResumeBadges isDefault={isDefault} disabled={Boolean(resume.disabled)} inline />
      </div>
      <div className={profileCss.cell}>
        {profile ? (
          <Link href={profilePageHref(profile.id)} className={profileCss.profileLink}>
            {profile.name}
          </Link>
        ) : (
          resume.name
        )}
      </div>
      <div className={profileCss.cell}>{templateName}</div>
      <div className={profileCss.cell}>{editedLine(resume, now)}</div>
      <div className={profileCss.cellMenu}>
        <ActionMenu
          triggerClassName={profileCss.rowMenuButton}
          triggerLabel={`Actions for ${label}`}
          triggerContent={<IconMoreVertical className="h-5 w-5" strokeWidth={2.2} />}
          items={items}
        />
      </div>
    </li>
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
