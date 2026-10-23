'use client';

import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { IconMoreVertical, IconPencil, IconPlus, IconTrash, IconUpload } from '@/components/icons';
import { clearFlashNotice, setFlashNotice } from '@/components/profiles/flashNotice';
import { NewTile, resumeCountText } from '@/components/profiles/ProfileCards';
import { DeleteProfileDialog, ProfileNameDialog } from '@/components/profiles/ProfileDialogs';
import { ViewToggle, useViewMode } from '@/components/profiles/ViewToggle';
import { useResumeActions } from '@/components/profiles/useResumeActions';
import profileCss from '@/components/profiles/profiles.module.css';
import { ActionMenu } from '@/components/resume/ActionMenu';
import { ResumeCard, ResumeRow } from '@/components/resume/ResumeCards';
import { editorFont } from '@/components/resume/editorFont';
import editorCss from '@/components/resume/resumeEditor.module.css';
import css from '@/components/resume/resumePages.module.css';
import { JSON_ACCEPT, PDF_ACCEPT, chooseFile, useResumeImport } from '@/components/resume/useResumeImport';
import { ProfileLimitLink, useLockedFeature } from '@/components/subscription/LockedFeature';
import { ErrorNotice, Notice, Spinner } from '@/components/ui/kit';
import { useAuth } from '@/contexts/AuthContext';
import {
  ApiResponseError,
  profilesApi,
  resumesApi,
  templatesApi,
  type ProfileSummary,
  type Resume,
  type Template,
} from '@/lib/api';
import { formatDate } from '@/lib/format';
import { dashboardHref, newResumeHref, resumeLabel } from '@/lib/profileDashboard';
import { editedAgo } from '@/lib/resumeGallery';

/** How often the cards' "Edited ... ago" moves on. */
const CLOCK_MS = 60_000;

type ProfileData = { profile: ProfileSummary; profiles: ProfileSummary[]; resumes: Resume[] };

type Loaded =
  | { status: 'loading' }
  | { status: 'ready'; data: ProfileData }
  | { status: 'missing' }
  | { status: 'failed'; error: unknown };

function isNotFound(error: unknown): boolean {
  return error instanceof ApiResponseError && error.status === 404;
}

/** The default resume first, then the newest edit, then by id. */
function orderResumes(resumes: readonly Resume[], defaultId: string | null): Resume[] {
  return [...resumes].sort((a, b) => {
    if (a.id === defaultId) return -1;
    if (b.id === defaultId) return 1;
    const byTime = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * One profile - one person - and the resumes in it: a card (or row) for each
 * with the default marked, New resume and Import resume (both filed under this
 * profile), and the same ⋮ menu as the dashboard's All resumes tab (Edit, Set
 * as default, Duplicate, Move to another profile..., Keywords, Download JSON,
 * Disable / Enable, Delete).
 *
 * The id in the address may be anything an old bookmark held. `new` is the
 * chooser's old address and goes to it, query string and all; a RESUME's id
 * (the address used to be a resume's editor) goes to that resume's editor; any
 * other id is said not to be a profile. app/admin/layout.tsx gives this route a
 * bare <main>, so the page lays out the editor's desk and pads its own loading
 * and error states.
 */
export default function ProfilePage() {
  const params = useParams<{ profileId: string }>();
  const profileId = typeof params?.profileId === 'string' ? params.profileId : '';
  return (
    <Suspense fallback={<Desk><Spinner label="Loading the profile..." /></Desk>}>
      <ProfileBody key={profileId} profileId={profileId} />
    </Suspense>
  );
}

function Desk({ children }: { children: ReactNode }) {
  return (
    <div className={`${editorCss.editor} ${editorFont.variable}`}>
      <div className={css.page}>{children}</div>
    </div>
  );
}

function ProfileBody({ profileId }: { profileId: string }) {
  const router = useRouter();
  const search = useSearchParams().toString();
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });

  /** The profile, the account's profiles (for Move) and this profile's resumes. */
  const fetchAll = useCallback(async (): Promise<ProfileData> => {
    const [profile, everyone, documents] = await Promise.all([
      profilesApi.get(profileId),
      profilesApi.getAll().catch(() => [] as ProfileSummary[]),
      resumesApi.getAll({ includeDisabled: true }),
    ]);
    return {
      profile,
      profiles: everyone.some((candidate) => candidate.id === profile.id) ? everyone : [profile, ...everyone],
      resumes: documents.filter((resume) => resume.profileId === profile.id),
    };
  }, [profileId]);

  useEffect(() => {
    if (!profileId) return;
    if (profileId === 'new') {
      router.replace('/admin/resumes/new' + (search ? `?${search}` : ''));
      return;
    }
    let live = true;
    fetchAll().then(
      (data) => {
        if (live) setLoaded({ status: 'ready', data });
      },
      async (error) => {
        if (!live) return;
        if (!isNotFound(error)) {
          setLoaded({ status: 'failed', error: error ?? 'Failed to load the profile.' });
          return;
        }
        // An old bookmark: /admin/profiles/<resume id> used to be the resume's editor.
        const resume = await resumesApi.getById(profileId).catch(() => null);
        if (!live) return;
        if (resume) router.replace(`/admin/resumes/${encodeURIComponent(resume.id)}`);
        else setLoaded({ status: 'missing' });
      }
    );
    return () => {
      live = false;
    };
  }, [fetchAll, profileId, router, search]);

  if (loaded.status === 'loading') {
    return (
      <Desk>
        <Spinner label="Loading the profile..." />
      </Desk>
    );
  }

  if (loaded.status === 'failed') {
    return (
      <Desk>
        <div className="space-y-4">
          <ErrorNotice error={loaded.error} fallback="Could not load this profile" />
          <Link href={dashboardHref('profiles')} className="tl-button-quiet">
            Back to My Profiles
          </Link>
        </div>
      </Desk>
    );
  }

  if (loaded.status === 'missing') {
    return (
      <Desk>
        <div className="space-y-4">
          <Notice tone="warn">That profile was not found. It may have been deleted.</Notice>
          <Link href={dashboardHref('profiles')} className="tl-button-quiet">
            Back to My Profiles
          </Link>
        </div>
      </Desk>
    );
  }

  return <ProfileView data={loaded.data} setData={(data) => setLoaded({ status: 'ready', data })} onGone={() => setLoaded({ status: 'missing' })} fetchAll={fetchAll} />;
}

function ProfileView({
  data,
  setData,
  onGone,
  fetchAll,
}: {
  data: ProfileData;
  setData: (data: ProfileData) => void;
  onGone: () => void;
  fetchAll: () => Promise<ProfileData>;
}) {
  const router = useRouter();
  const { refresh } = useAuth();
  const { profile, profiles, resumes } = data;
  const [templates, setTemplates] = useState<Template[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [view, setView] = useViewMode();
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const importer = useResumeImport(profile.id);
  const locked = useLockedFeature();
  useEffect(() => {
    clearFlashNotice();
    templatesApi.getAll().then(setTemplates, () => undefined);
    const clock = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(clock);
  }, []);

  /** Everything read again after a change; a profile that is gone meanwhile is said so. */
  const reload = useCallback(async () => {
    try {
      setData(await fetchAll());
    } catch (err) {
      if (isNotFound(err)) onGone();
      else setError(err ?? 'Failed to load the profile.');
    }
  }, [fetchAll, onGone, setData]);

  const ordered = useMemo(() => orderResumes(resumes, profile.defaultResumeId), [resumes, profile.defaultResumeId]);
  const actions = useResumeActions({
    profiles,
    visibleIds: ordered.map((resume) => resume.id),
    reload,
    locked,
    onNotice: setNotice,
    onError: setError,
    leavesOnMove: true,
  });

  const name = profile.name.trim() || 'Untitled Profile';
  const edited = editedAgo(profile.lastEditedAt, now) ?? `Edited ${formatDate(profile.lastEditedAt, { style: 'date' })}`;
  const importing = importer.busy !== null;

  const chosen = resumes.find((resume) => resume.id === profile.chosenDefaultResumeId) ?? null;
  const effective = resumes.find((resume) => resume.id === profile.defaultResumeId) ?? null;
  const defaultLine = (() => {
    if (resumes.length > 0 && profile.enabledResumeCount === 0) {
      return 'Every resume in this profile is disabled, so it cannot be built until one is enabled.';
    }
    if (chosen?.disabled && effective && effective.id !== chosen.id) {
      return `${resumeLabel(chosen)} is disabled, so Fully Tailor builds ${resumeLabel(effective)} until it is enabled.`;
    }
    return '';
  })();

  const newResume = () => router.push(newResumeHref(profile.id));

  const importFile = async (kind: 'pdf' | 'json') => {
    setNotice('');
    setError(null);
    const file = await chooseFile(kind === 'pdf' ? PDF_ACCEPT : JSON_ACCEPT);
    if (!file) return;
    if (kind === 'pdf') {
      const resume = await importer.importPdf(file);
      if (!resume) return;
      await reload();
      setNotice(`Imported ${resumeLabel(resume)} into ${name}.`);
      return;
    }
    const result = await importer.importJson(file);
    if (!result) return;
    await reload();
    setNotice(`Imported ${result.imported} resume${result.imported === 1 ? '' : 's'} into ${name}.`);
  };

  return (
    <div className={`${editorCss.editor} ${editorFont.variable}`}>
      <div className={css.page}>
        <Link href={dashboardHref('profiles')} className={css.back}>
          <span aria-hidden="true">‹</span> My Profiles
        </Link>

        <div className={profileCss.head}>
          <div className={profileCss.headText}>
            <div className={profileCss.profileTitleRow}>
              <h1 className={`${css.title} ${profileCss.profileName}`}>{name}</h1>
              <button
                type="button"
                className={profileCss.iconButton}
                aria-label="Rename profile"
                title="Rename profile"
                onClick={() => setRenaming(true)}
              >
                <IconPencil className="h-[18px] w-[18px]" />
              </button>
            </div>
            <p className={profileCss.profileMeta}>
              {resumeCountText(profile.resumeCount)} · {edited}
            </p>
            <p className={profileCss.explain}>
              ★ is the default resume: Fully Tailor builds it. Choose Suitable Resume and Partial Tailor pick, for each
              job, the resume here whose keywords match the posting best.
            </p>
          </div>
          <div className={profileCss.headActions}>
            <ActionMenu
              triggerClassName={profileCss.iconButton}
              triggerLabel={`Actions for ${name}`}
              triggerContent={<IconMoreVertical className="h-5 w-5" strokeWidth={2.2} />}
              items={[
                { key: 'rename', label: 'Rename', icon: IconPencil, onSelect: () => setRenaming(true) },
                {
                  key: 'delete',
                  label: 'Delete profile',
                  icon: IconTrash,
                  tone: 'danger',
                  ruleBefore: true,
                  onSelect: () => setDeleting(true),
                },
              ]}
            />
            <Link href={newResumeHref(profile.id)} className={profileCss.createButton} data-new-fallback="resume">
              <IconPlus className="h-[18px] w-[18px]" strokeWidth={2.4} />
              New resume
            </Link>
          </div>
        </div>

        <div className={css.notices}>
          {defaultLine && <Notice tone="warn">{defaultLine}</Notice>}
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

        <div className={profileCss.pageToolbar}>
          <div className={profileCss.importWrap}>
            <ActionMenu
              triggerClassName={css.importButton}
              triggerContent={
                <>
                  <IconUpload className="h-[18px] w-[18px]" />
                  Import resume
                </>
              }
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
            {importing && (
              <span className={profileCss.working} role="status">
                <span className="tl-spinner" aria-hidden />
                {importer.busy === 'pdf' ? 'Reading your resume. This can take a minute.' : 'Importing your resumes...'}
              </span>
            )}
          </div>
          <ViewToggle value={view} onChange={setView} />
        </div>

        {view === 'grid' ? (
          <ul className={css.resumeGrid}>
            <li>
              <NewTile kind="resume" onClick={newResume} />
            </li>
            {ordered.map((resume) => (
              <li key={resume.id}>
                <ResumeCard
                  resume={resume}
                  templates={templates}
                  now={now}
                  isDefault={profile.defaultResumeId === resume.id}
                  items={actions.itemsFor(resume)}
                />
              </li>
            ))}
          </ul>
        ) : (
          ordered.length > 0 && (
            <ul className={profileCss.list}>
              <li className={`${profileCss.listHead} ${profileCss.rowResume}`} aria-hidden="true">
                <span>Resume</span>
                <span>Name on resume</span>
                <span>Template</span>
                <span>Edited</span>
                <span />
              </li>
              {ordered.map((resume) => (
                <ResumeRow
                  key={resume.id}
                  resume={resume}
                  templates={templates}
                  now={now}
                  isDefault={profile.defaultResumeId === resume.id}
                  items={actions.itemsFor(resume)}
                />
              ))}
            </ul>
          )
        )}

        {ordered.length === 0 && (
          <div className={profileCss.empty}>
            <p className={profileCss.emptyTitle}>No resumes in this profile yet.</p>
            <p className={profileCss.emptyBody}>Start one from a template, or import a resume PDF or JSON file.</p>
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

      <ProfileNameDialog
        open={renaming}
        mode="rename"
        profileId={profile.id}
        initialName={profile.name}
        onClose={() => setRenaming(false)}
        onSaved={(saved) => {
          setRenaming(false);
          setNotice(`Renamed the profile to ${saved.name}.`);
          void reload();
        }}
        onStale={() => void reload()}
      />
      <DeleteProfileDialog
        profile={deleting ? profile : null}
        onClose={() => setDeleting(false)}
        onStale={() => void reload()}
        onDeleted={(deleted, deletedResumes) => {
          setDeleting(false);
          setFlashNotice(deletedResumes > 0 ? `Deleted ${deleted.name} and its resumes.` : `Deleted ${deleted.name}.`);
          void refresh();
          router.push(dashboardHref('profiles'));
        }}
      />
      {actions.dialogs}
      {locked.dialog}
    </div>
  );
}
