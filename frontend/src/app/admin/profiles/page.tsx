'use client';

import { Suspense, useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { IconLock, IconPlus, IconUpload } from '@/components/icons';
import { focusCard, neighbourOf } from '@/components/profiles/focusAfterRemoval';
import { clearFlashNotice, peekFlashNotice } from '@/components/profiles/flashNotice';
import { NewTile, ProfileCard, ProfileRow, profileMenuItems } from '@/components/profiles/ProfileCards';
import {
  DeleteProfileDialog,
  NewResumeDialog,
  ProfileNameDialog,
} from '@/components/profiles/ProfileDialogs';
import { SearchBox } from '@/components/profiles/SearchBox';
import { ViewToggle, useViewMode } from '@/components/profiles/ViewToggle';
import { useProfileLimit, useResumeActions } from '@/components/profiles/useResumeActions';
import profileCss from '@/components/profiles/profiles.module.css';
import { ActionMenu } from '@/components/resume/ActionMenu';
import { ResumeCard, ResumeRow } from '@/components/resume/ResumeCards';
import { editorFont } from '@/components/resume/editorFont';
import editorCss from '@/components/resume/resumeEditor.module.css';
import css from '@/components/resume/resumePages.module.css';
import { JSON_ACCEPT, PDF_ACCEPT, chooseFile, useResumeImport } from '@/components/resume/useResumeImport';
import { ProfileLimitLink, SUBSCRIPTION_PAGE, lockLabel, useLockedFeature } from '@/components/subscription/LockedFeature';
import { ErrorNotice, Notice, Spinner } from '@/components/ui/kit';
import { useAuth } from '@/contexts/AuthContext';
import { profilesApi, resumesApi, templatesApi, type ProfileSummary, type Resume, type Template } from '@/lib/api';
import { describeProfileUsage } from '@/lib/auth';
import {
  dashboardHref,
  describeHoldings,
  describeMatches,
  filterProfiles,
  filterResumes,
  newResumeHref,
  profilePageHref,
  readDashboardTab,
  resumeLabel,
  sortProfiles,
  type DashboardTab,
} from '@/lib/profileDashboard';

/** How often the cards' "Edited ... ago" moves on. */
const CLOCK_MS = 60_000;

const TAB_IDS: Record<DashboardTab, { tab: string; panel: string }> = {
  profiles: { tab: 'dashboard-tab-profiles', panel: 'dashboard-panel-profiles' },
  resumes: { tab: 'dashboard-tab-resumes', panel: 'dashboard-panel-resumes' },
};

/** Newest edit first, then by id: the same order whatever order the server answered in. */
function sortResumes(resumes: readonly Resume[]): Resume[] {
  return [...resumes].sort((a, b) => {
    const byTime = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * My Profiles, the dashboard: a profile is a PERSON, and holds that person's
 * resumes. Two tabs - Profiles, a card per person (the first page of their
 * default resume), and All resumes, a card per resume - each with a search and
 * a Grid / List view. A card opens the profile's page
 * (/admin/profiles/<id>) or the resume's editor (/admin/resumes/<id>); New
 * profile names a person, New resume goes to the template chooser for one of
 * them, and Import reads a resume PDF or JSON file and files each resume under
 * its person.
 *
 * A subscription counts PROFILES, never resumes: only New profile (the tile,
 * Create New on the Profiles tab, and "A new profile" in the Move and New
 * resume dialogs) is locked at the limit.
 *
 * app/admin/layout.tsx gives this route a bare <main>, so the page lays out
 * the same warm desk as the chooser and the editor and pads its own loading
 * and error states. `useSearchParams` (the tab) needs the Suspense boundary.
 */
export default function ProfilesPage() {
  return (
    <Suspense
      fallback={
        <div className={`${editorCss.editor} ${editorFont.variable}`}>
          <div className={css.page}>
            <Spinner label="Loading profiles..." />
          </div>
        </div>
      }
    >
      <ProfilesDashboard />
    </Suspense>
  );
}

function ProfilesDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = readDashboardTab(searchParams.get('tab'));
  const { account, loading: authLoading, refresh } = useAuth();
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  /** True once both lists have been read; until then there is nothing true to draw counts or locks from. */
  const [loaded, setLoaded] = useState(false);
  /** One of the page's own sentences, or a caught failure for <ErrorNotice> to word. */
  const [error, setError] = useState<unknown>(null);
  /** For each card's template name. Empty until it arrives, which only costs the names. */
  const [templates, setTemplates] = useState<Template[]>([]);
  /** What a page before this one left to say (a profile deleted on its own page), then what this page does. */
  const [notice, setNotice] = useState(() => peekFlashNotice());
  const [now, setNow] = useState(() => Date.now());
  const [view, setView] = useViewMode();
  const [profileQuery, setProfileQuery] = useState('');
  const [resumeQuery, setResumeQuery] = useState('');
  const [naming, setNaming] = useState(false);
  const [renaming, setRenaming] = useState<ProfileSummary | null>(null);
  const [deleting, setDeleting] = useState<ProfileSummary | null>(null);
  const [choosing, setChoosing] = useState(false);
  const importer = useResumeImport();

  /** Both lists, together: a change to either can move the other (a move, a delete, an import). */
  const load = useCallback(async () => {
    try {
      const [people, documents] = await Promise.all([profilesApi.getAll(), resumesApi.getAll({ includeDisabled: true })]);
      setProfiles(people);
      setResumes(documents);
      setLoaded(true);
    } catch (err) {
      setError(err ?? 'Failed to load your profiles.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    clearFlashNotice();
    void load();
    templatesApi.getAll().then(setTemplates, () => undefined);
    const clock = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(clock);
  }, [load]);

  const locked = useLockedFeature();
  const limit = useProfileLimit(profiles.length, locked);
  const liveAccount = limit.liveAccount;

  const orderedProfiles = useMemo(() => sortProfiles(profiles), [profiles]);
  const orderedResumes = useMemo(() => sortResumes(resumes), [resumes]);
  const shownProfiles = useMemo(
    () => filterProfiles(orderedProfiles, resumes, profileQuery),
    [orderedProfiles, resumes, profileQuery]
  );
  const shownResumes = useMemo(
    () => filterResumes(orderedResumes, profiles, resumeQuery),
    [orderedResumes, profiles, resumeQuery]
  );
  const profileById = (id: string | undefined): ProfileSummary | null => profiles.find((profile) => profile.id === id) ?? null;
  const defaultResumeOf = (profile: ProfileSummary): Resume | null =>
    resumes.find((resume) => resume.id === profile.defaultResumeId) ?? null;

  const actions = useResumeActions({
    profiles,
    visibleIds: shownResumes.map((resume) => resume.id),
    reload: load,
    locked,
    onNotice: setNotice,
    onError: setError,
  });

  const selectTab = (next: DashboardTab, focus = false) => {
    router.replace(dashboardHref(next), { scroll: false });
    if (focus) window.requestAnimationFrame(() => document.getElementById(TAB_IDS[next].tab)?.focus());
  };

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const order: DashboardTab[] = ['profiles', 'resumes'];
    const at = order.indexOf(tab);
    if (event.key === 'ArrowRight') selectTab(order[(at + 1) % order.length], true);
    else if (event.key === 'ArrowLeft') selectTab(order[(at + order.length - 1) % order.length], true);
    else if (event.key === 'Home') selectTab('profiles', true);
    else if (event.key === 'End') selectTab('resumes', true);
    else return;
    event.preventDefault();
  };

  /** A new person. Locked at the limit: the press opens the lock rather than naming one. */
  const newProfile = () => {
    if (limit.lock) locked.open(limit.lock);
    else setNaming(true);
  };

  /** A new resume: straight to the chooser for the one profile there is, else ask whose it is. */
  const newResume = () => {
    if (profiles.length === 1) router.push(newResumeHref(profiles[0].id));
    else setChoosing(true);
  };

  const importFile = async (kind: 'pdf' | 'json') => {
    setNotice('');
    setError(null);
    const file = await chooseFile(kind === 'pdf' ? PDF_ACCEPT : JSON_ACCEPT);
    if (!file) return;
    if (kind === 'pdf') {
      const resume = await importer.importPdf(file);
      if (!resume) return;
      await load();
      setNotice(`Imported ${resumeLabel(resume)} as a new resume.`);
      return;
    }
    const result = await importer.importJson(file);
    if (!result) return;
    await load();
    const made = result.createdProfiles ?? [];
    setNotice(
      `Imported ${result.imported} resume${result.imported === 1 ? '' : 's'}` +
        (made.length > 0 ? ` and made the profile${made.length === 1 ? '' : 's'} ${made.map((profile) => profile.name).join(', ')}` : '') +
        '.'
    );
  };

  const profileItems = (profile: ProfileSummary) =>
    profileMenuItems({
      onOpen: () => router.push(profilePageHref(profile.id)),
      onRename: () => setRenaming(profile),
      onNewResume: () => router.push(newResumeHref(profile.id)),
      onDelete: () => setDeleting(profile),
    });

  const profileLock = limit.lock ? { lock: limit.lock, onLocked: locked.open } : null;
  const waiting = authLoading ? 'Checking your subscription...' : undefined;
  const importing = importer.busy !== null;


  if (isLoading) {
    return (
      <div className={`${editorCss.editor} ${editorFont.variable}`}>
        <div className={css.page}>
          <Spinner label="Loading profiles..." />
        </div>
      </div>
    );
  }

  // The first read failed: say so and offer to try again, rather than draw "0 profiles", "No profiles
  // yet" and an unlocked Create New for an account whose lists were simply not read.
  if (!loaded) {
    return (
      <div className={`${editorCss.editor} ${editorFont.variable}`}>
        <div className={css.page}>
          <div className="space-y-4">
            <ErrorNotice error={error} fallback="Could not load your profiles" />
            <button
              type="button"
              className="tl-button-quiet"
              onClick={() => {
                setError(null);
                setIsLoading(true);
                void load();
              }}
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  const profilesTab = tab === 'profiles';

  return (
    <div className={`${editorCss.editor} ${editorFont.variable}`}>
      <div className={css.page}>
        <div className={profileCss.head}>
          <div className={profileCss.headText}>
            <h1 className={css.title}>My Profiles</h1>
            <p className={css.subtitle}>{describeHoldings(account?.name ?? '', profiles.length, resumes.length)}</p>
            {liveAccount && (
              <p className={profileCss.usage}>
                {describeProfileUsage(liveAccount)} profiles used
                {liveAccount.role === 'admin'
                  ? ' (administrators have no limit)'
                  : ` on the ${liveAccount.subscriptionLabel} subscription`}
                .
              </p>
            )}
          </div>
          <div className={profileCss.headActions}>
            <ActionMenu
              triggerClassName={css.importButton}
              triggerContent={
                <>
                  <IconUpload className="h-[18px] w-[18px]" />
                  Import
                </>
              }
              triggerTitle="Read a resume PDF or a resume JSON file; each resume is filed under its person"
              disabled={importing}
              items={[
                {
                  key: 'pdf',
                  label: 'Resume PDF',
                  hint: `An AI reads it into a new resume. Up to ${importer.uploadMaxMb} MB.`,
                  onSelect: () => void importFile('pdf'),
                },
                {
                  key: 'json',
                  label: 'Resume JSON file',
                  hint: 'A resume downloaded from this app, or several.',
                  onSelect: () => void importFile('json'),
                },
              ]}
            />
            {profilesTab ? (
              <button
                type="button"
                className={profileCss.createButton}
                onClick={newProfile}
                disabled={Boolean(waiting)}
                title={waiting ?? (limit.lock ? lockLabel(limit.lock) : undefined)}
                aria-haspopup={limit.lock ? 'dialog' : undefined}
                data-locked-feature={limit.lock ? limit.lock.feature : undefined}
                data-new-fallback="profile"
              >
                {limit.lock ? <IconLock className="h-[18px] w-[18px]" /> : <IconPlus className="h-[18px] w-[18px]" strokeWidth={2.4} />}
                Create New
              </button>
            ) : (
              <button type="button" className={profileCss.createButton} onClick={newResume} data-new-fallback="resume">
                <IconPlus className="h-[18px] w-[18px]" strokeWidth={2.4} />
                Create New
              </button>
            )}
          </div>
        </div>

        {importing && (
          <p className={profileCss.working} role="status">
            <span className="tl-spinner" aria-hidden />
            {importer.busy === 'pdf' ? 'Reading your resume. This can take a minute.' : 'Importing your resumes...'}
          </p>
        )}

        <div className={css.notices}>
          {limit.overLimit && liveAccount ? (
            <Notice tone="warn">
              <p className="font-semibold">
                You have {profiles.length} profile{profiles.length === 1 ? '' : 's'} and the {liveAccount.subscriptionLabel}{' '}
                subscription allows {liveAccount.profileLimit}: all are kept, but you cannot add another.
              </p>
              <p className="mt-1">
                Delete one to make room, or move up to a higher subscription.{' '}
                <Link href={SUBSCRIPTION_PAGE} className="font-medium underline underline-offset-2">
                  Go to subscription
                </Link>
              </p>
            </Notice>
          ) : (
            limit.atLimit &&
            liveAccount && (
              <Notice tone="warn">
                <p className="font-semibold">
                  You are using all {liveAccount.profileLimit} profile{liveAccount.profileLimit === 1 ? '' : 's'} on the{' '}
                  {liveAccount.subscriptionLabel} subscription.
                </p>
                <p className="mt-1">
                  Delete one to make room, or move up to a higher subscription.{' '}
                  <Link href={SUBSCRIPTION_PAGE} className="font-medium underline underline-offset-2">
                    Go to subscription
                  </Link>
                </p>
              </Notice>
            )
          )}
          {notice && <Notice tone="success">{notice}</Notice>}
          <ErrorNotice error={error} onDismiss={() => setError(null)}>
            <ProfileLimitLink error={error} />
          </ErrorNotice>
          {importer.error !== null && (
            <ErrorNotice error={importer.error} onDismiss={() => importer.setError(null)}>
              <ProfileLimitLink error={importer.error} />
            </ErrorNotice>
          )}
        </div>

        <div role="tablist" aria-label="Profiles and resumes" className={profileCss.tabs} onKeyDown={onTabKey}>
          <button
            type="button"
            role="tab"
            id={TAB_IDS.profiles.tab}
            aria-selected={profilesTab}
            aria-controls={TAB_IDS.profiles.panel}
            tabIndex={profilesTab ? 0 : -1}
            className={profileCss.tab}
            onClick={() => selectTab('profiles')}
          >
            Profiles ({profiles.length})
          </button>
          <button
            type="button"
            role="tab"
            id={TAB_IDS.resumes.tab}
            aria-selected={!profilesTab}
            aria-controls={TAB_IDS.resumes.panel}
            tabIndex={profilesTab ? -1 : 0}
            className={profileCss.tab}
            onClick={() => selectTab('resumes')}
          >
            All resumes ({resumes.length})
          </button>
        </div>

        {profilesTab ? (
          <div role="tabpanel" id={TAB_IDS.profiles.panel} aria-labelledby={TAB_IDS.profiles.tab}>
            <div className={profileCss.controls}>
              <SearchBox id="profiles-search" label="Search profiles" value={profileQuery} onChange={setProfileQuery} />
              <ViewToggle value={view} onChange={setView} />
            </div>
            <p className={profileCss.matchStatus} role="status">
              {profileQuery.trim() ? describeMatches(shownProfiles.length, profiles.length, 'profile') : ''}
            </p>

            {view === 'grid' ? (
              <ul className={css.resumeGrid}>
                <li>
                  <NewTile kind="profile" onClick={newProfile} blockedReason={waiting} locked={profileLock} />
                </li>
                {shownProfiles.map((profile) => (
                  <li key={profile.id}>
                    <ProfileCard profile={profile} defaultResume={defaultResumeOf(profile)} now={now} items={profileItems(profile)} />
                  </li>
                ))}
              </ul>
            ) : (
              shownProfiles.length > 0 && (
                <ul className={profileCss.list}>
                  <li className={`${profileCss.listHead} ${profileCss.rowProfile}`} aria-hidden="true">
                    <span>Profile</span>
                    <span>Resumes</span>
                    <span>Default resume</span>
                    <span>Edited</span>
                    <span />
                  </li>
                  {shownProfiles.map((profile) => (
                    <ProfileRow
                      key={profile.id}
                      profile={profile}
                      defaultResume={defaultResumeOf(profile)}
                      now={now}
                      items={profileItems(profile)}
                    />
                  ))}
                </ul>
              )
            )}

            {profiles.length === 0 && (
              <div className={profileCss.empty}>
                <p className={profileCss.emptyTitle}>No profiles yet</p>
                <p className={profileCss.emptyBody}>
                  A profile is a person you build resumes for. Create one, then add their resumes.
                </p>
                {view === 'list' && (
                  <div className={profileCss.emptyActions}>
                    <button type="button" className={profileCss.createButton} onClick={newProfile}>
                      Create profile
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div role="tabpanel" id={TAB_IDS.resumes.panel} aria-labelledby={TAB_IDS.resumes.tab}>
            <div className={profileCss.controls}>
              <SearchBox id="resumes-search" label="Search resumes" value={resumeQuery} onChange={setResumeQuery} />
              <ViewToggle value={view} onChange={setView} />
            </div>
            <p className={profileCss.matchStatus} role="status">
              {resumeQuery.trim() ? describeMatches(shownResumes.length, resumes.length, 'resume') : ''}
            </p>

            {view === 'grid' ? (
              <ul className={css.resumeGrid}>
                <li>
                  <NewTile kind="resume" onClick={newResume} blockedReason={waiting} />
                </li>
                {shownResumes.map((resume) => {
                  const profile = profileById(resume.profileId);
                  return (
                    <li key={resume.id}>
                      <ResumeCard
                        resume={resume}
                        templates={templates}
                        now={now}
                        isDefault={profile?.defaultResumeId === resume.id}
                        profile={profile}
                        items={actions.itemsFor(resume)}
                      />
                    </li>
                  );
                })}
              </ul>
            ) : (
              shownResumes.length > 0 && (
                <ul className={profileCss.list}>
                  <li className={`${profileCss.listHead} ${profileCss.rowResume}`} aria-hidden="true">
                    <span>Resume</span>
                    <span>Profile</span>
                    <span>Template</span>
                    <span>Edited</span>
                    <span />
                  </li>
                  {shownResumes.map((resume) => {
                    const profile = profileById(resume.profileId);
                    return (
                      <ResumeRow
                        key={resume.id}
                        resume={resume}
                        templates={templates}
                        now={now}
                        isDefault={profile?.defaultResumeId === resume.id}
                        profile={profile}
                        items={actions.itemsFor(resume)}
                      />
                    );
                  })}
                </ul>
              )
            )}

            {resumes.length === 0 && (
              <div className={profileCss.empty}>
                <p className={profileCss.emptyTitle}>No resumes yet</p>
                <p className={profileCss.emptyBody}>Add a resume to one of your profiles.</p>
                {view === 'list' && (
                  <div className={profileCss.emptyActions}>
                    <button type="button" className={profileCss.createButton} onClick={newResume}>
                      New resume
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <ProfileNameDialog
        open={naming}
        mode="create"
        onClose={() => setNaming(false)}
        onSaved={(profile) => {
          setNaming(false);
          void refresh();
          router.push(profilePageHref(profile.id));
        }}
        onLimit={(err) => {
          setNaming(false);
          void limit.refused(err).then(() => load());
        }}
      />
      <ProfileNameDialog
        open={renaming !== null}
        mode="rename"
        profileId={renaming?.id}
        initialName={renaming?.name ?? ''}
        onClose={() => setRenaming(null)}
        onSaved={(profile) => {
          setRenaming(null);
          setNotice(`Renamed the profile to ${profile.name}.`);
          void load();
        }}
        onStale={() => void load()}
      />
      <DeleteProfileDialog
        profile={deleting}
        onClose={() => setDeleting(null)}
        onStale={() => void load()}
        onDeleted={(profile, deletedResumes) => {
          const next = neighbourOf(shownProfiles.map((candidate) => candidate.id), [profile.id]);
          setDeleting(null);
          void Promise.all([load(), refresh()]).then(() => {
            setNotice(deletedResumes > 0 ? `Deleted ${profile.name} and its resumes.` : `Deleted ${profile.name}.`);
            focusCard('profile', next);
          });
        }}
      />
      <NewResumeDialog
        open={choosing}
        profiles={orderedProfiles}
        lock={limit.lock}
        onLocked={locked.open}
        onClose={() => setChoosing(false)}
        onPicked={(profileId) => {
          setChoosing(false);
          void refresh();
          router.push(newResumeHref(profileId));
        }}
        onLimit={(err) => {
          setChoosing(false);
          void limit.refused(err).then(() => load());
        }}
      />
      {actions.dialogs}
      {locked.dialog}
    </div>
  );
}
