'use client';

import { useState, type FormEvent } from 'react';
import { editorFont } from '@/components/resume/editorFont';
import editorCss from '@/components/resume/resumeEditor.module.css';
import { ChoiceCard, ProfileLimitLink } from '@/components/subscription/LockedFeature';
import Dialog from '@/components/ui/Dialog';
import { ErrorNotice } from '@/components/ui/kit';
import { ApiResponseError, isProfileLimit, profilesApi, type ProfileSummary, type Resume } from '@/lib/api';
import { deleteProfileWording, resumeLabel } from '@/lib/profileDashboard';
import type { LockSpec } from '@/lib/subscriptions';
import { KeywordChips } from './KeywordChips';
import { resumeCountText } from './ProfileCards';
import css from './profiles.module.css';

/*
 * The dialogs of the Profiles pages. Each is a kit Dialog carrying the
 * editor's tokens and font (the panel is portalled to <body>, outside the desk
 * that defines them), mounted only while open so its fields start afresh every
 * time. A press that the subscription's profile limit refuses (402) goes to
 * `onLimit` when the page gave one - it closes the dialog and opens the lock -
 * and is otherwise said inside the dialog, with the way to a subscription.
 */

const DIALOG_CLASS = `${css.dialog} ${editorCss.tokens} ${editorFont.variable}`;

/** Asked for a profile's name; a person's name is what a profile is called. */
const NAME_LIMIT = 100;

/** The value of the radio for "A new profile". Never a profile's id. */
const NEW_PROFILE = '__new-profile__';

/**
 * A failure that says what the page shows is out of date: the profile or resume is gone (404) or the
 * state it was changed from is not the state now (409). The dialog says the server's sentence and
 * calls `onStale`, so the page reads its lists again instead of leaving a dead card to fail the same way.
 */
export function isStaleRefusal(error: unknown): boolean {
  return error instanceof ApiResponseError && (error.status === 404 || error.status === 409);
}

/* ------------------------------------------------------ name a profile */

export function ProfileNameDialog(props: {
  open: boolean;
  mode: 'create' | 'rename';
  /** The current name, when renaming. */
  initialName?: string;
  /** The profile to rename. */
  profileId?: string;
  onClose: () => void;
  onSaved: (profile: ProfileSummary) => void;
  onLimit?: (error: ApiResponseError) => void;
  /** The profile is gone or changed meanwhile (404, 409): read the page's lists again. */
  onStale?: () => void;
}) {
  if (!props.open) return null;
  return <ProfileNameBody {...props} />;
}

function ProfileNameBody({
  mode,
  initialName = '',
  profileId,
  onClose,
  onSaved,
  onLimit,
  onStale,
}: {
  mode: 'create' | 'rename';
  initialName?: string;
  profileId?: string;
  onClose: () => void;
  onSaved: (profile: ProfileSummary) => void;
  onLimit?: (error: ApiResponseError) => void;
  onStale?: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const creating = mode === 'create';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const text = name.trim();
    if (!text) {
      setError('Give the profile a name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = creating
        ? await profilesApi.create({ name: text })
        : await profilesApi.update(profileId ?? '', { name: text });
      onSaved(saved);
    } catch (err) {
      if (isProfileLimit(err) && onLimit) onLimit(err);
      else {
        setError(err ?? 'Failed to save the profile.');
        if (isStaleRefusal(err)) onStale?.();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={creating ? 'New profile' : 'Rename profile'}
      subtitle={creating ? 'A profile is a person you build resumes for.' : undefined}
      onClose={() => {
        if (!busy) onClose();
      }}
      className={DIALOG_CLASS}
      footer={
        <>
          <button type="button" className="tl-button-quiet" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="profile-name-form" className="tl-button" disabled={busy}>
            {busy ? 'Saving...' : creating ? 'Create profile' : 'Save'}
          </button>
        </>
      }
    >
      <form id="profile-name-form" className={css.dialogBody} onSubmit={submit} noValidate>
        <label className={css.fieldLabel}>
          <span className="tl-label">Profile name</span>
          <input
            className="tl-input"
            value={name}
            maxLength={NAME_LIMIT}
            autoFocus
            autoComplete="off"
            placeholder="Jane Doe"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {error !== null && (
          <div className={css.dialogError}>
            <ErrorNotice error={error}>
              <ProfileLimitLink error={error} />
            </ErrorNotice>
          </div>
        )}
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------ delete a profile */

/**
 * The owner's warning, before the press: deleting a profile deletes every
 * resume in it, and they cannot be recovered (lib/profileDashboard's
 * `deleteProfileWording`).
 */
export function DeleteProfileDialog({
  profile,
  onClose,
  onDeleted,
  onStale,
}: {
  profile: ProfileSummary | null;
  onClose: () => void;
  onDeleted: (profile: ProfileSummary, deletedResumes: number) => void;
  /** The profile is gone or changed meanwhile (404, 409): read the page's lists again. */
  onStale?: () => void;
}) {
  if (!profile) return null;
  return <DeleteProfileBody profile={profile} onClose={onClose} onDeleted={onDeleted} onStale={onStale} />;
}

function DeleteProfileBody({
  profile,
  onClose,
  onDeleted,
  onStale,
}: {
  profile: ProfileSummary;
  onClose: () => void;
  onDeleted: (profile: ProfileSummary, deletedResumes: number) => void;
  onStale?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const wording = deleteProfileWording(profile.name, profile.resumeCount);

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await profilesApi.delete(profile.id);
      onDeleted(profile, result.deletedResumes);
    } catch (err) {
      setError(err ?? 'Failed to delete the profile.');
      if (isStaleRefusal(err)) onStale?.();
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={wording.title}
      onClose={() => {
        if (!busy) onClose();
      }}
      className={DIALOG_CLASS}
      footer={
        <>
          <button type="button" className="tl-button-quiet" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="tl-button" data-tone="danger" onClick={() => void remove()} disabled={busy}>
            {busy ? 'Deleting...' : wording.confirm}
          </button>
        </>
      }
    >
      <div className={css.dialogBody}>
        <p>{wording.body}</p>
        {error !== null && (
          <div className={css.dialogError}>
            <ErrorNotice error={error} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

/* --------------------------------------- the profiles to choose among */

/**
 * A radio list of profiles and "A new profile", which is LOCKED at the limit
 * (the lock beside it, the press opening the lock's dialog), with the new
 * profile's name box when it is chosen.
 */
function ProfileChoices({
  legend,
  profiles,
  target,
  onTarget,
  lock,
  onLocked,
  newName,
  onNewName,
}: {
  legend: string;
  profiles: readonly ProfileSummary[];
  target: string;
  onTarget: (target: string) => void;
  lock: LockSpec | null;
  onLocked: (lock: LockSpec) => void;
  newName: string;
  onNewName: (name: string) => void;
}) {
  return (
    <>
      <fieldset className={css.choiceList}>
        <legend>{legend}</legend>
        {profiles.map((profile) => (
          <ChoiceCard
            key={profile.id}
            name="profile-target"
            value={profile.id}
            checked={target === profile.id}
            onSelect={() => onTarget(profile.id)}
            onLocked={onLocked}
            hint={resumeCountText(profile.resumeCount)}
          >
            {profile.name.trim() || 'Untitled Profile'}
          </ChoiceCard>
        ))}
        <ChoiceCard
          name="profile-target"
          value={NEW_PROFILE}
          checked={target === NEW_PROFILE && lock === null}
          onSelect={() => onTarget(NEW_PROFILE)}
          lock={lock}
          onLocked={onLocked}
        >
          A new profile
        </ChoiceCard>
      </fieldset>
      {target === NEW_PROFILE && lock === null && (
        <label className={css.fieldLabel}>
          <span className="tl-label">New profile name</span>
          <input
            className="tl-input"
            value={newName}
            maxLength={NAME_LIMIT}
            autoComplete="off"
            onChange={(event) => onNewName(event.target.value)}
          />
        </label>
      )}
    </>
  );
}

/** The first choice: another profile if there is one, else a new profile unless that is locked. */
function firstTarget(profiles: readonly ProfileSummary[], lock: LockSpec | null): string {
  return profiles[0]?.id ?? (lock ? '' : NEW_PROFILE);
}

/* -------------------------------------------------- move resumes across */

export interface MoveResult {
  targetId: string;
  targetName: string;
  moved: number;
}

/**
 * "Move {label}": into another of the person's profiles - a radio list - or
 * into a new one, which counts against the subscription's profile limit (so it
 * is locked there). ALL OR NOTHING, on the server.
 */
export function MoveResumesDialog(props: {
  open: boolean;
  resumes: readonly Resume[];
  profiles: readonly ProfileSummary[];
  /** The profile they are leaving; not offered. */
  fromProfileId?: string | null;
  lock: LockSpec | null;
  onLocked: (lock: LockSpec) => void;
  onClose: () => void;
  onMoved: (result: MoveResult) => void;
  onLimit?: (error: ApiResponseError) => void;
  /** A resume or profile is gone or changed meanwhile (404, 409): read the page's lists again. */
  onStale?: () => void;
}) {
  if (!props.open || props.resumes.length === 0) return null;
  return <MoveResumesBody {...props} />;
}

function MoveResumesBody({
  resumes,
  profiles,
  fromProfileId,
  lock,
  onLocked,
  onClose,
  onMoved,
  onLimit,
  onStale,
}: {
  resumes: readonly Resume[];
  profiles: readonly ProfileSummary[];
  fromProfileId?: string | null;
  lock: LockSpec | null;
  onLocked: (lock: LockSpec) => void;
  onClose: () => void;
  onMoved: (result: MoveResult) => void;
  onLimit?: (error: ApiResponseError) => void;
  onStale?: () => void;
}) {
  const others = profiles.filter((profile) => profile.id !== fromProfileId);
  const [target, setTarget] = useState(() => firstTarget(others, lock));
  const [newName, setNewName] = useState(() => resumes[0]?.name?.trim() ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ids = resumes.map((resume) => resume.id);
  const creating = target === NEW_PROFILE && lock === null;
  const ready = !busy && target !== '' && (!creating || newName.trim() !== '') && !(target === NEW_PROFILE && lock !== null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        const created = await profilesApi.create({ name: newName.trim(), resumeIds: ids });
        onMoved({ targetId: created.id, targetName: created.name, moved: ids.length });
      } else {
        const answer = await profilesApi.move(target, ids);
        const into = answer.profiles.find((profile) => profile.id === target) ?? profiles.find((profile) => profile.id === target);
        onMoved({ targetId: target, targetName: into?.name ?? 'the profile', moved: answer.moved });
      }
    } catch (err) {
      if (isProfileLimit(err) && onLimit) onLimit(err);
      else {
        setError(err ?? 'Failed to move the resume.');
        if (isStaleRefusal(err)) onStale?.();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={resumes.length === 1 ? `Move ${resumeLabel(resumes[0])}` : `Move ${resumes.length} resumes`}
      subtitle="A resume is in one profile at a time. It keeps its address, its template and its settings."
      onClose={() => {
        if (!busy) onClose();
      }}
      className={DIALOG_CLASS}
      footer={
        <>
          <button type="button" className="tl-button-quiet" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="move-resumes-form" className="tl-button" disabled={!ready}>
            {busy ? 'Moving...' : 'Move'}
          </button>
        </>
      }
    >
      <form id="move-resumes-form" className={css.dialogBody} onSubmit={submit} noValidate>
        <ProfileChoices
          legend="Move to"
          profiles={others}
          target={target}
          onTarget={setTarget}
          lock={lock}
          onLocked={onLocked}
          newName={newName}
          onNewName={setNewName}
        />
        {others.length === 0 && <p>You have no other profile yet.</p>}
        {error !== null && (
          <div className={css.dialogError}>
            <ErrorNotice error={error}>
              <ProfileLimitLink error={error} />
            </ErrorNotice>
          </div>
        )}
      </form>
    </Dialog>
  );
}

/* ---------------------------------------------------------- keywords */

/** "Keywords": the job titles and the skills and technologies the server read from a resume. */
export function KeywordsDialog({ resume, onClose }: { resume: Resume | null; onClose: () => void }) {
  if (!resume) return null;
  return (
    <Dialog
      open
      title="Keywords"
      subtitle={resumeLabel(resume)}
      onClose={onClose}
      className={DIALOG_CLASS}
      footer={
        <button type="button" className="tl-button-quiet" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className={css.dialogBody}>
        <p>
          What this resume says it is for. Choose Suitable Resume and Partial Tailor compare them with each posting to
          pick the best-matching resume of a profile.
        </p>
        <KeywordChips keywords={resume.matchKeywords} />
      </div>
    </Dialog>
  );
}

/* -------------------------------------------------------- a new resume */

/**
 * "New resume", from All resumes: whose is it? Pick one of the profiles - or a
 * new one, locked at the limit - and the chooser opens for it. With no profile
 * yet it asks only for a name; the page skips the dialog altogether when there
 * is exactly one.
 */
export function NewResumeDialog(props: {
  open: boolean;
  profiles: readonly ProfileSummary[];
  lock: LockSpec | null;
  onLocked: (lock: LockSpec) => void;
  onClose: () => void;
  /** The profile to file the new resume under; the page goes to the chooser for it. */
  onPicked: (profileId: string) => void;
  onLimit?: (error: ApiResponseError) => void;
}) {
  if (!props.open) return null;
  return <NewResumeBody {...props} />;
}

function NewResumeBody({
  profiles,
  lock,
  onLocked,
  onClose,
  onPicked,
  onLimit,
}: {
  profiles: readonly ProfileSummary[];
  lock: LockSpec | null;
  onLocked: (lock: LockSpec) => void;
  onClose: () => void;
  onPicked: (profileId: string) => void;
  onLimit?: (error: ApiResponseError) => void;
}) {
  const [target, setTarget] = useState(() => firstTarget(profiles, lock));
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const noProfiles = profiles.length === 0;
  const creating = noProfiles || (target === NEW_PROFILE && lock === null);
  const ready = !busy && (creating ? newName.trim() !== '' : target !== '' && target !== NEW_PROFILE);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    if (!creating) {
      onPicked(target);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await profilesApi.create({ name: newName.trim() });
      onPicked(created.id);
    } catch (err) {
      if (isProfileLimit(err) && onLimit) onLimit(err);
      else setError(err ?? 'Failed to create the profile.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="New resume"
      subtitle={
        noProfiles
          ? 'A resume lives in a profile: the person it is for. Name that person first.'
          : 'Which profile is the new resume for?'
      }
      onClose={() => {
        if (!busy) onClose();
      }}
      className={DIALOG_CLASS}
      footer={
        <>
          <button type="button" className="tl-button-quiet" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="new-resume-form" className="tl-button" disabled={!ready}>
            {busy ? 'Creating...' : 'Continue'}
          </button>
        </>
      }
    >
      <form id="new-resume-form" className={css.dialogBody} onSubmit={submit} noValidate>
        {noProfiles ? (
          <label className={css.fieldLabel}>
            <span className="tl-label">Profile name</span>
            <input
              className="tl-input"
              value={newName}
              maxLength={NAME_LIMIT}
              autoFocus
              autoComplete="off"
              placeholder="Jane Doe"
              onChange={(event) => setNewName(event.target.value)}
            />
          </label>
        ) : (
          <ProfileChoices
            legend="Profile"
            profiles={profiles}
            target={target}
            onTarget={setTarget}
            lock={lock}
            onLocked={onLocked}
            newName={newName}
            onNewName={setNewName}
          />
        )}
        {error !== null && (
          <div className={css.dialogError}>
            <ErrorNotice error={error}>
              <ProfileLimitLink error={error} />
            </ErrorNotice>
          </div>
        )}
      </form>
    </Dialog>
  );
}
