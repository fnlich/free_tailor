'use client';

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  IconCopy,
  IconDownload,
  IconEye,
  IconEyeOff,
  IconFolder,
  IconPencil,
  IconStar,
  IconText,
  IconTrash,
} from '@/components/icons';
import type { ActionMenuItem } from '@/components/resume/ActionMenu';
import { resumeEditorHref, saveTextFile } from '@/components/resume/ResumeCards';
import type { useLockedFeature } from '@/components/subscription/LockedFeature';
import { useAuth } from '@/contexts/AuthContext';
import { isProfileLimit, profilesApi, resumeApi, resumesApi, type ProfileSummary, type Resume } from '@/lib/api';
import { isAtProfileLimit, type Account } from '@/lib/auth';
import { resumeLabel } from '@/lib/profileDashboard';
import { duplicateResumeBody, resumeExportFileName, resumeExportText } from '@/lib/resumeGallery';
import { savableModelChoice } from '@/lib/resumeModelChoice';
import { describeLock, describeProfileLimitRefusal, type LockSpec } from '@/lib/subscriptions';
import { focusCard, neighbourOf } from './focusAfterRemoval';
import { KeywordsDialog, MoveResumesDialog, isStaleRefusal, type MoveResult } from './ProfileDialogs';

type LockedFeature = ReturnType<typeof useLockedFeature>;

/**
 * Where the account stands against its subscription's profile limit, measured
 * against the page's own list of profiles rather than the account's snapshot.
 *
 * `profilesUsed` comes from the last /auth/me and goes stale the moment
 * somebody deletes a profile here: read directly it would leave the page
 * telling them to delete one after they had, and New profile still locked.
 * The list is the page's own fetch and is what the server counts.
 *
 * `lock` is the "More profiles" lock while a new profile would be refused
 * (and null while the account is still arriving, or has room). `refused`
 * answers a 402 `profile-limit` the server sent anyway - another tab added
 * one, or the subscription lapsed under the page - by opening the same lock
 * worded from the refusal and the list read again, never from the count and
 * tier this page had, which said there was room; it answers whether it was
 * one.
 */
export function useProfileLimit(profileCount: number, locked: LockedFeature) {
  const { account, loading, refresh } = useAuth();
  const liveAccount: Account | null = account ? { ...account, profilesUsed: profileCount } : null;
  const atLimit = liveAccount ? isAtProfileLimit(liveAccount) : false;
  const overLimit =
    liveAccount !== null &&
    liveAccount.role !== 'admin' &&
    liveAccount.profileLimit !== null &&
    liveAccount.profilesUsed > liveAccount.profileLimit;
  const lock: LockSpec | null = !loading && atLimit && liveAccount ? describeLock('more-profiles', liveAccount) : null;

  const { open } = locked;
  const refused = useCallback(
    async (error: unknown): Promise<boolean> => {
      if (!isProfileLimit(error)) return false;
      await refresh();
      const fresh = await profilesApi.getAll().catch(() => null);
      open(describeProfileLimitRefusal({ limit: error.number('limit'), used: fresh?.length ?? profileCount }, account));
      return true;
    },
    [account, open, profileCount, refresh]
  );

  return { account, liveAccount, loading, atLimit, overLimit, lock, refused };
}

/**
 * What a resume's ⋮ does, shared by the dashboard's All resumes tab and a
 * profile's page: Edit, Set as default, Duplicate, Move to another profile...,
 * Keywords, Download JSON, Disable / Enable and Delete - and the two dialogs
 * (Move, Keywords) that some of them open. `itemsFor(resume)` is the menu;
 * `dialogs` is drawn once on the page.
 *
 * The page owns its notice and error lines (`onNotice`, `onError`) and reads
 * both lists again through `reload` after any change. A card that leaves the
 * page - deleted, or moved out of a profile's own page - hands focus to the
 * next card, else the previous, else the New tile (`visibleIds` is the order
 * on screen). Resumes are never counted against the subscription, so no
 * action here is locked; only Move to "A new profile" is, at the profile limit.
 */
export function useResumeActions({
  profiles,
  visibleIds,
  reload,
  locked,
  onNotice,
  onError,
  leavesOnMove = false,
}: {
  /** Every profile of the account: where a resume is, and where it can be moved. */
  profiles: readonly ProfileSummary[];
  visibleIds: readonly string[];
  reload: () => Promise<unknown>;
  locked: LockedFeature;
  onNotice: (message: string) => void;
  onError: (error: unknown) => void;
  /** A profile's own page: a moved resume is no longer in the list. */
  leavesOnMove?: boolean;
}): { itemsFor: (resume: Resume) => ActionMenuItem[]; dialogs: ReactNode } {
  const router = useRouter();
  const { refresh } = useAuth();
  const limit = useProfileLimit(profiles.length, locked);
  const [moving, setMoving] = useState<Resume | null>(null);
  const [viewing, setViewing] = useState<Resume | null>(null);
  /** The ids being duplicated right now. */
  const duplicating = useRef<Set<string>>(new Set());

  const profileOf = (resume: Resume): ProfileSummary | null =>
    profiles.find((profile) => profile.id === resume.profileId) ?? null;

  /** Runs a change: errors to the page, a refused limit to the lock; true when it went through. */
  const attempt = async (fallback: string, work: () => Promise<void>): Promise<boolean> => {
    onNotice('');
    onError(null);
    try {
      await work();
      return true;
    } catch (err) {
      if (await limit.refused(err)) return false;
      onError(err ?? fallback);
      // The resume or profile is gone, or is no longer what the page drew (404, 409): read both lists
      // again, or the dead card stays and every further press on it fails the same way.
      if (isStaleRefusal(err)) void reload();
      return false;
    }
  };

  const setDefault = async (resume: Resume) => {
    const profile = profileOf(resume);
    if (!profile) return;
    const done = await attempt('Failed to set the default resume.', async () => {
      await profilesApi.update(profile.id, { defaultResumeId: resume.id });
    });
    if (!done) return;
    await reload();
    onNotice(`${resumeLabel(resume)} is now ${profile.name}'s default resume.`);
  };

  /**
   * A copy of everything the resume holds, in the same profile and on the same
   * template: any resume may use any template. A model choice no longer
   * offered goes back to the app default (savableModelChoice), because the
   * server refuses a new resume one.
   */
  const duplicate = async (resume: Resume) => {
    // The menu closes on the press but can be opened and pressed again while the first copy is being
    // made, and a create is not idempotent: one press, one copy.
    if (duplicating.current.has(resume.id)) return;
    duplicating.current.add(resume.id);
    try {
      await duplicateOnce(resume);
    } finally {
      duplicating.current.delete(resume.id);
    }
  };

  const duplicateOnce = async (resume: Resume) => {
    const profile = profileOf(resume);
    const done = await attempt('Failed to duplicate the resume.', async () => {
      const models = await resumeApi.getModels().then(
        (settings) => ({ loaded: true, ids: settings.models.map((model) => model.id) }),
        () => ({ loaded: false, ids: [] as string[] })
      );
      const ai = savableModelChoice(resume.resumeSettings?.ai ?? {}, {
        modelsLoaded: models.loaded,
        offeredIds: models.ids,
      });
      await resumesApi.create(duplicateResumeBody(resume, ai), resume.profileId ? { profileId: resume.profileId } : undefined);
    });
    if (!done) return;
    await Promise.all([reload(), refresh()]);
    onNotice(
      `Duplicated ${resumeLabel(resume)}${profile ? ` in ${profile.name}` : ''}. Change its headline in its editor to tell them apart.`
    );
  };

  const toggleDisabled = async (resume: Resume) => {
    const done = await attempt('Failed to update the resume.', async () => {
      await resumesApi.update(resume.id, { disabled: !resume.disabled });
    });
    if (done) await reload();
  };

  const remove = async (resume: Resume) => {
    const label = resumeLabel(resume);
    if (!window.confirm(`Delete ${label}? This can't be undone.`)) return;
    const next = neighbourOf(visibleIds, [resume.id]);
    const done = await attempt('Failed to delete the resume.', async () => {
      await resumesApi.delete(resume.id);
    });
    if (!done) return;
    await Promise.all([reload(), refresh()]);
    onNotice(`Deleted ${label}.`);
    focusCard('resume', next);
  };

  const moved = async (resume: Resume, result: MoveResult) => {
    const next = leavesOnMove ? neighbourOf(visibleIds, [resume.id]) : null;
    setMoving(null);
    await Promise.all([reload(), refresh()]);
    onNotice(`Moved ${resumeLabel(resume)} to ${result.targetName}.`);
    if (leavesOnMove) focusCard('resume', next);
  };

  const itemsFor = (resume: Resume): ActionMenuItem[] => {
    const profile = profileOf(resume);
    const isChosenDefault = profile?.chosenDefaultResumeId === resume.id;
    const defaultTip = !profile
      ? 'This resume is not in a profile yet.'
      : resume.disabled
        ? 'Enable this resume first: a disabled resume cannot be the default.'
        : isChosenDefault
          ? 'Already the default resume.'
          : 'Fully Tailor builds the default resume';
    return [
      { key: 'edit', label: 'Edit', icon: IconPencil, onSelect: () => router.push(resumeEditorHref(resume)) },
      {
        key: 'default',
        label: 'Set as default',
        icon: IconStar,
        disabled: !profile || Boolean(resume.disabled) || isChosenDefault,
        title: defaultTip,
        onSelect: () => void setDefault(resume),
      },
      { key: 'duplicate', label: 'Duplicate', icon: IconCopy, onSelect: () => void duplicate(resume) },
      {
        key: 'move',
        label: 'Move to another profile...',
        icon: IconFolder,
        onSelect: () => setMoving(resume),
      },
      {
        key: 'keywords',
        label: 'Keywords',
        title: 'The job titles and skills this resume is matched on',
        icon: IconText,
        onSelect: () => setViewing(resume),
      },
      {
        key: 'download',
        label: 'Download JSON',
        title: 'The resume as a file that Import takes back',
        icon: IconDownload,
        onSelect: () => saveTextFile(resumeExportFileName(resume), resumeExportText(resume)),
      },
      {
        key: 'toggle',
        label: resume.disabled ? 'Enable' : 'Disable',
        title: resume.disabled ? undefined : 'Kept, but left out of Build Resumes',
        icon: resume.disabled ? IconEye : IconEyeOff,
        onSelect: () => void toggleDisabled(resume),
      },
      { key: 'delete', label: 'Delete', icon: IconTrash, tone: 'danger', ruleBefore: true, onSelect: () => void remove(resume) },
    ];
  };

  const dialogs = (
    <>
      <MoveResumesDialog
        open={moving !== null}
        resumes={moving ? [moving] : []}
        profiles={profiles}
        fromProfileId={moving?.profileId}
        lock={limit.lock}
        onLocked={locked.open}
        onClose={() => setMoving(null)}
        onMoved={(result) => {
          if (moving) void moved(moving, result);
        }}
        onLimit={(error) => {
          setMoving(null);
          void limit.refused(error);
        }}
        onStale={() => void reload()}
      />
      <KeywordsDialog resume={viewing} onClose={() => setViewing(null)} />
    </>
  );

  return { itemsFor, dialogs };
}
