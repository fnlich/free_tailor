'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { isProfileLimit, profilesApi, resumeApi, templatesApi, type Profile, type Template } from '@/lib/api';
import {
  NewProfileTile,
  ProfileCard,
  profileEditorHref,
  saveTextFile,
  type DuplicateState,
} from '@/components/profile/ProfileCards';
import { editorFont } from '@/components/profile/editorFont';
import editorCss from '@/components/profile/profileEditor.module.css';
import css from '@/components/profile/profilePages.module.css';
import { SUBSCRIPTION_PAGE, useLockedFeature } from '@/components/subscription/LockedFeature';
import { ErrorNotice, Notice, Spinner } from '@/components/ui/kit';
import { useAuth } from '@/contexts/AuthContext';
import { describeProfileUsage, isAtProfileLimit } from '@/lib/auth';
import { savableModelChoice } from '@/lib/profileModel';
import { NEW_PROFILE_PATH, duplicateProfileBody, profileFileName, profileFileText } from '@/lib/profileGallery';
import { describeLock, describeProfileLimitRefusal } from '@/lib/subscriptions';

/** How often the cards' "Edited ... ago" moves on. */
const CLOCK_MS = 60_000;

/**
 * The account's profiles, as FlowCV's "My Resumes": a dashed New profile tile,
 * then a card per profile - its first page as the server draws it, its name,
 * when it was edited and its template - with Edit, Duplicate, Download,
 * Disable and Delete under ⋮. New profile goes to the template chooser
 * (/admin/profiles/new), where an existing resume can be imported too; a card
 * opens the profile's editor (/admin/profiles/<id>).
 *
 * app/admin/layout.tsx gives this route a bare <main>, so the page lays out
 * the same warm desk as the chooser and the editor.
 */
export default function ProfilesPage() {
  const router = useRouter();
  const { account, loading: authLoading, refresh } = useAuth();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  /** One of the page's own sentences, or a caught failure for <ErrorNotice> to word. */
  const [error, setError] = useState<unknown>(null);
  /** For each card's template name. Empty until it arrives, which only costs the names. */
  const [templates, setTemplates] = useState<Template[]>([]);
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const loadProfiles = useCallback(async () => {
    try {
      setProfiles(await profilesApi.getAll({ includeDisabled: true }));
    } catch (err) {
      setError(err ?? 'Failed to load your profiles.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
    templatesApi.getAll().then(setTemplates, () => undefined);
    const clock = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(clock);
  }, [loadProfiles]);

  /**
   * The cap, measured against the list rather than the account's snapshot.
   *
   * `profilesUsed` comes from the last /auth/me and goes stale the moment
   * somebody deletes a profile here. Reading it directly would leave the banner
   * telling them to delete one and New profile still off after they did. The
   * list is this page's own fetch and includes disabled profiles, which is
   * exactly what the server counts.
   */
  const liveAccount = account ? { ...account, profilesUsed: profiles.length } : null;
  const atLimit = liveAccount ? isAtProfileLimit(liveAccount) : false;

  /**
   * Off while the account is still arriving: the profile list and /auth/me
   * are independent fetches, and in the window between them every way to add
   * a profile would otherwise be on with no banner - the "let them do the
   * work, then refuse" this page exists to stop.
   */
  const blockedReason = authLoading ? 'Checking your subscription...' : undefined;
  /**
   * At the limit, New profile and Duplicate are LOCKED rather than off: each
   * opens the lock's dialog, which names the subscription with room for one
   * more and leads to the Subscription page.
   */
  const locked = useLockedFeature();
  const profileLock = !authLoading && atLimit && liveAccount ? describeLock('more-profiles', liveAccount) : null;
  const duplicate: DuplicateState = blockedReason
    ? { kind: 'waiting', reason: blockedReason }
    : profileLock
      ? { kind: 'locked', lock: profileLock, onLocked: locked.open }
      : { kind: 'open' };

  const handleDelete = async (profile: Profile) => {
    if (!window.confirm(`Delete ${profile.name || 'this profile'}? This cannot be undone.`)) return;
    setNotice('');
    try {
      await profilesApi.delete(profile.id);
      await loadProfiles();
      await refresh();
    } catch (err) {
      setError(err ?? 'Failed to delete the profile.');
    }
  };

  const handleToggleDisabled = async (profile: Profile) => {
    setNotice('');
    try {
      await profilesApi.update(profile.id, { disabled: !profile.disabled });
      await loadProfiles();
    } catch (err) {
      setError(err ?? 'Failed to update the profile.');
    }
  };

  /**
   * A copy of everything the profile holds, as a new profile, without its
   * template: each profile has its own, so the copy is drawn with the default
   * until one is chosen. A model choice no longer offered goes back to the app
   * default (savableModelChoice), because the server refuses a new profile one.
   */
  const handleDuplicate = async (profile: Profile) => {
    setNotice('');
    setError(null);
    try {
      const models = await resumeApi.getModels().then(
        (settings) => ({ loaded: true, ids: settings.models.map((model) => model.id) }),
        () => ({ loaded: false, ids: [] as string[] })
      );
      const ai = savableModelChoice(profile.profileSettings?.ai ?? {}, {
        modelsLoaded: models.loaded,
        offeredIds: models.ids,
      });
      await profilesApi.create(duplicateProfileBody(profile, ai));
      await loadProfiles();
      await refresh();
      setNotice(
        `Duplicated ${profile.name || 'the profile'}. The copy has no template of its own yet: it is drawn with the default until you choose one in its editor.`
      );
    } catch (err) {
      await refresh();
      // At the limit after all - another tab added one, or the subscription
      // lapsed under this page: the lock says what to do about it, worded from
      // the refusal and the list read again, never from the count and tier
      // this page had, which said the account had room.
      if (isProfileLimit(err)) {
        const fresh = await profilesApi.getAll({ includeDisabled: true }).catch(() => null);
        if (fresh) setProfiles(fresh);
        locked.open(
          describeProfileLimitRefusal(
            { limit: err.number('limit'), used: (fresh ?? profiles).length },
            account
          )
        );
        return;
      }
      setError(err ?? 'Failed to duplicate the profile.');
    }
  };

  const handleDownload = (profile: Profile) => {
    saveTextFile(profileFileName(profile), profileFileText(profile));
  };

  if (isLoading) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <Spinner label="Loading profiles..." />
      </div>
    );
  }

  return (
    <div className={`${editorCss.editor} ${editorFont.variable}`}>
      <div className={css.page}>
        <h1 className={css.title}>My Profiles</h1>
        <p className={css.subtitle}>
          {liveAccount ? (
            <>
              {describeProfileUsage(liveAccount)} profiles used
              {liveAccount.role === 'admin'
                ? ' (administrators have no limit)'
                : ` on the ${liveAccount.subscriptionLabel} subscription`}
              . Each one is the content of a resume, tailored to every job you build it for.
            </>
          ) : (
            'Each profile is the content of a resume, tailored to every job you build it for.'
          )}
        </p>

        <div className={css.notices}>
          {atLimit && liveAccount && (
            <Notice tone="warn">
              <p className="font-semibold">
                You are using all {liveAccount.profileLimit} profile
                {liveAccount.profileLimit === 1 ? '' : 's'} on the {liveAccount.subscriptionLabel} subscription.
              </p>
              <p className="mt-1">
                Delete one below to make room, or move up to a higher subscription.{' '}
                <Link href={SUBSCRIPTION_PAGE} className="font-medium underline underline-offset-2">
                  Go to subscription
                </Link>
              </p>
            </Notice>
          )}
          {notice && <Notice tone="success">{notice}</Notice>}
          <ErrorNotice error={error} onDismiss={() => setError(null)} />
        </div>

        <ul className={css.profileGrid}>
          <li>
            <NewProfileTile
              onClick={() => router.push(NEW_PROFILE_PATH)}
              blockedReason={blockedReason}
              locked={profileLock ? { lock: profileLock, onLocked: locked.open } : null}
            />
          </li>
          {profiles.map((profile) => (
            <li key={`${profile.id}:${profile.updatedAt}`}>
              <ProfileCard
                profile={profile}
                templates={templates}
                now={now}
                onEdit={() => router.push(profileEditorHref(profile))}
                onDuplicate={() => void handleDuplicate(profile)}
                duplicate={duplicate}
                onDownload={() => handleDownload(profile)}
                onToggleDisabled={() => void handleToggleDisabled(profile)}
                onDelete={() => void handleDelete(profile)}
              />
            </li>
          ))}
        </ul>
      </div>
      {locked.dialog}
    </div>
  );
}
