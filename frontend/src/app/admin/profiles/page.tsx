'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  isProfileLimit,
  profilesApi,
  readProfileImportFile,
  templatesApi,
  Profile,
  Template,
} from '@/lib/api';
import { EmptyState, ErrorNotice, Notice, PageHeader, Pill, Spinner } from '@/components/ui/kit';
import { LAYOUT_LABELS, drawnTemplate, normalizeTechnicalSkillsLayout } from '@/lib/profileDraft';
import { useAuth } from '@/contexts/AuthContext';
import { describeProfileUsage, isAtProfileLimit } from '@/lib/auth';
import { pdfSizeRefusal } from '@/lib/upload';

/**
 * The account's profiles. Creating and editing one happen on their own routes
 * (/admin/profiles/new, /admin/profiles/[id]), where the form has a live
 * preview beside it; this page lists them and holds the ways in - new, a resume
 * PDF, a JSON file.
 */
export default function ProfilesPage() {
  const router = useRouter();
  // uploadMaxMb is the server's UPLOAD_MAX_MB, served on /auth/me - see lib/upload.ts.
  const { account, loading: authLoading, refresh, uploadMaxMb, refreshUploadMaxMb } = useAuth();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  /** One of the page's own sentences, or a caught failure for <ErrorNotice> to word. */
  const [error, setError] = useState<unknown>('');
  /** For each row's template name. Empty until it arrives, which only costs the names. */
  const [templates, setTemplates] = useState<Template[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [notice, setNotice] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadProfiles();
    templatesApi.getAll().then(setTemplates, () => undefined);
  }, []);

  const loadProfiles = async () => {
    try {
      const data = await profilesApi.getAll({ includeDisabled: true });
      setProfiles(data);
    } catch (err) {
      setError(err ?? 'Failed to load your profiles.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this profile?')) return;
    try {
      await profilesApi.delete(id);
      await loadProfiles();
      await refresh();
    } catch (err) {
      setError(err ?? 'Failed to delete the profile.');
    }
  };

  const handleToggleDisabled = async (profile: Profile) => {
    try {
      await profilesApi.update(profile.id, { disabled: !profile.disabled });
      await loadProfiles();
    } catch (err) {
      setError(err ?? 'Failed to update the profile.');
    }
  };

  const openCreateForm = () => {
    router.push('/admin/profiles/new');
  };

  /** The editor, on the profile's own route. */
  const editorHref = (profile: Pick<Profile, 'id'>) => `/admin/profiles/${encodeURIComponent(profile.id)}`;

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.type !== 'application/pdf') {
      setError('Please upload a PDF file');
      return;
    }
    const tooLarge = await pdfSizeRefusal(file, uploadMaxMb, refreshUploadMaxMb);
    if (tooLarge) {
      setError(tooLarge);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setIsUploading(true);
    setUploadProgress('Uploading PDF...');
    setError('');
    setNotice('');

    try {
      setUploadProgress('Extracting profile information with AI...');
      const profile = await profilesApi.uploadResume(file);
      await refresh();
      setUploadProgress('');
      // Straight into the editor: what the model read out of a PDF is worth
      // looking over before it is used, and the preview shows it as a resume.
      router.push(editorHref(profile));
    } catch (err) {
      if (isProfileLimit(err)) await refresh();
      setError(err ?? 'Failed to read a profile from that PDF.');
    } finally {
      setIsUploading(false);
      setUploadProgress('');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const triggerFileUpload = () => {
    fileInputRef.current?.click();
  };

  /**
   * Imports profiles from a JSON file.
   *
   * No AI call and nothing to extract - the file already IS a profile, so this
   * is the path for moving one between installs, restoring a backup, or
   * writing one by hand. The server decides whether the file is really a
   * profile and says which entry is wrong if it is not.
   */
  const handleJsonImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setUploadProgress(`Reading ${file.name}...`);
    setError('');
    setNotice('');

    try {
      // Not named `document`: that shadows the global one inside this handler,
      // which is a trap for whatever gets added here next.
      const parsed = await readProfileImportFile(file);
      const result = await profilesApi.importJson(parsed);
      await loadProfiles();
      await refresh();

      if (result.imported === 1 && result.profiles[0]) {
        // Straight into the editor, like the PDF path: one imported profile is
        // something you are about to look over anyway.
        router.push(editorHref(result.profiles[0]));
        return;
      }

      const reused = result.keptIds > 0 ? ` ${result.keptIds} kept the id from the file.` : '';
      setNotice(
        `Imported ${result.imported} profile${result.imported === 1 ? '' : 's'} from ${file.name}.${reused}`
      );
    } catch (err) {
      // A file with more profiles than the remaining room is only knowable
      // server-side - the count is unreadable until the file is picked - so the
      // cap refusal arrives here and re-syncs the gate.
      if (isProfileLimit(err)) await refresh();
      setError(err ?? 'Failed to import the profiles.');
    } finally {
      setIsUploading(false);
      setUploadProgress('');
      if (jsonInputRef.current) {
        jsonInputRef.current.value = '';
      }
    }
  };

  const triggerJsonImport = () => {
    jsonInputRef.current?.click();
  };

  /**
   * The cap, measured against the list rather than the account's snapshot.
   *
   * `profilesUsed` comes from the last /auth/me and goes stale the moment
   * somebody deletes a profile here. Reading it directly would leave the banner
   * telling them to delete one and the buttons still disabled after they did.
   * The list is this page's own fetch and includes disabled profiles, which is
   * exactly what the server counts.
   */
  const liveAccount = account ? { ...account, profilesUsed: profiles.length } : null;
  const atLimit = liveAccount ? isAtProfileLimit(liveAccount) : false;

  /**
   * Disabled while the account is still arriving, too.
   *
   * The profile list and /auth/me are independent fetches. Without this, the
   * window between them renders every Add button enabled with no banner - which
   * is precisely the "let them do the work, then refuse" this page exists to
   * stop, just narrowed to the first few hundred milliseconds.
   */
  const addBlocked = atLimit || authLoading;
  const blockedReason = authLoading
    ? 'Checking your subscription...'
    : liveAccount
      ? `The ${liveAccount.subscriptionLabel} subscription allows ${liveAccount.profileLimit} profile${liveAccount.profileLimit === 1 ? '' : 's'}. Delete one, or ask an administrator for a higher subscription.`
      : '';

  if (isLoading) {
    return <Spinner label="Loading profiles..." />;
  }

  /*
   * No <main> or <Page> here: app/admin/layout.tsx already wraps every
   * /admin/* route in one, with the gutters and the width.
   */
  return (
    <div>
      <PageHeader
        title="Profiles"
        description={
          liveAccount && (
            <>
              {describeProfileUsage(liveAccount)} profiles used
              {liveAccount.role === 'admin' ? ' (administrators have no limit)' : ` on the ${liveAccount.subscriptionLabel} subscription`}
            </>
          )
        }
        actions={
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              onChange={handleFileUpload}
              className="hidden"
            />
            <button
              onClick={triggerFileUpload}
              disabled={isUploading || addBlocked}
              title={addBlocked ? blockedReason : `Build a profile from a resume PDF, max ${uploadMaxMb}MB`}
              className="tl-button-quiet"
            >
              {isUploading ? (
                <>
                  <span className="tl-spinner" aria-hidden />
                  Extracting...
                </>
              ) : (
                'Upload Resume PDF'
              )}
            </button>
            <input
              ref={jsonInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleJsonImport}
              className="hidden"
            />
            <button
              onClick={triggerJsonImport}
              disabled={isUploading || addBlocked}
              title={addBlocked ? blockedReason : 'Create profiles from a profile JSON file'}
              className="tl-button-quiet"
            >
              Import JSON
            </button>
            <button
              onClick={openCreateForm}
              disabled={addBlocked}
              title={addBlocked ? blockedReason : undefined}
              className="tl-button"
              data-shape="pill"
            >
              New Profile
            </button>
          </>
        }
      />

      <div className="mb-6 space-y-3 empty:hidden">
        {uploadProgress && (
          <Notice tone="info" role="status" className="flex items-center gap-3">
            <span className="tl-spinner" aria-hidden />
            {uploadProgress}
          </Notice>
        )}

        {atLimit && liveAccount && (
          <Notice tone="warn">
            <p className="font-semibold">
              You are using all {liveAccount.profileLimit} profile
              {liveAccount.profileLimit === 1 ? '' : 's'} on the {liveAccount.subscriptionLabel}{' '}
              subscription.
            </p>
            <p className="mt-1">
              Delete one below to make room, or ask an administrator of this installation to move your
              account to a higher subscription.{' '}
              <Link href="/settings/subscription" className="font-medium underline underline-offset-2">
                See your subscription
              </Link>
              .
            </p>
          </Notice>
        )}

        {notice && <Notice tone="success">{notice}</Notice>}

        <ErrorNotice error={error} />
      </div>

      {profiles.length === 0 ? (
        <EmptyState
          title="No profiles"
          action={
            <button onClick={openCreateForm} className="tl-button">
              New Profile
            </button>
          }
        >
          Get started by creating a new profile.
        </EmptyState>
      ) : (
        <ul className="tl-rows">
          {profiles.map((profile) => (
            <li
              key={profile.id}
              className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3"
            >
              {/* At least 12rem, so on a phone the buttons drop under the
                  name instead of squeezing the title down to "Full-st...". */}
              <div className="min-w-[12rem] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold text-ink">
                    <Link href={editorHref(profile)} className="hover:underline underline-offset-2">
                      {profile.name || 'Untitled profile'}
                    </Link>
                  </h3>
                  {profile.disabled && <Pill tone="grey">Disabled</Pill>}
                </div>
                {profile.title && <p className="mt-0.5 truncate text-sm text-muted">{profile.title}</p>}
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-subtle">
                  {/* What the next resume looks like, without opening the editor:
                      the template it is DRAWN with, which is not the stored one
                      when that cannot print this profile's layout. */}
                  {templates.length > 0 && <DrawnTemplate templates={templates} profile={profile} />}
                  <Pill tone="sky">
                    {LAYOUT_LABELS[normalizeTechnicalSkillsLayout(profile.profileSettings?.technicalSkillsLayout)]}
                  </Pill>
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Link href={editorHref(profile)} className="tl-button-quiet" data-size="sm">
                  Edit
                </Link>
                <button
                  onClick={() => handleToggleDisabled(profile)}
                  className="tl-button-quiet"
                  data-size="sm"
                >
                  {profile.disabled ? 'Enable' : 'Disable'}
                </button>
                <button
                  onClick={() => handleDelete(profile.id)}
                  className="tl-button-quiet"
                  data-size="sm"
                  data-tone="danger"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The template a profile's resumes are drawn with, and - when that is not the
 * one it names - which one it names and why it is not used, in the words the
 * editor's picker uses.
 */
function DrawnTemplate({ templates, profile }: { templates: readonly Template[]; profile: Profile }) {
  const { stored, drawn, layout } = drawnTemplate(templates, profile);
  if (!stored) {
    return <span>{drawn ? `Template no longer offered - drawn with ${drawn.name}` : 'Template no longer offered'}</span>;
  }
  if (!drawn || drawn.id === stored.id) return <span>{stored.name}</span>;
  return (
    <>
      <span>Drawn with {drawn.name}</span>
      <Pill tone="amber">
        {stored.name}: not for {LAYOUT_LABELS[layout]}
      </Pill>
    </>
  );
}
