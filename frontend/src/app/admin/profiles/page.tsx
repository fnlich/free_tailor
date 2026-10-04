'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import {
  isProfileLimit,
  profilesApi,
  readProfileImportFile,
  Profile,
  CreateProfileDTO,
} from '@/lib/api';
import ProfileForm from '@/components/admin/ProfileForm';
import chrome from '@/components/admin/profileTemplateChrome.module.css';
import { IconClose } from '@/components/icons';
import { EmptyState, Notice, PageHeader, Pill, Spinner } from '@/components/ui/kit';
import { useAuth } from '@/contexts/AuthContext';
import { describeProfileUsage, isAtProfileLimit } from '@/lib/auth';

export default function ProfilesPage() {
  const { account, loading: authLoading, refresh } = useAuth();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [notice, setNotice] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadProfiles();
  }, []);

  const loadProfiles = async () => {
    try {
      const data = await profilesApi.getAll({ includeDisabled: true });
      setProfiles(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load profiles');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreate = async (data: CreateProfileDTO) => {
    try {
      await profilesApi.create(data);
      await loadProfiles();
      // The account's own count feeds the menu in the layout above, which would
      // otherwise read one behind this page until the next navigation.
      await refresh();
      setShowForm(false);
    } catch (err) {
      // Rethrown so ProfileForm shows it in the modal the user is looking at.
      // The re-sync matters for the race: two tabs at the limit, one wins, and
      // the loser should find its buttons disabled rather than keep trying.
      if (isProfileLimit(err)) await refresh();
      throw err;
    }
  };

  const handleUpdate = async (data: CreateProfileDTO) => {
    if (!editingProfile) return;
    try {
      await profilesApi.update(editingProfile.id, data);
      await loadProfiles();
      setEditingProfile(null);
      setShowForm(false);
    } catch (err) {
      throw err;
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this profile?')) return;
    try {
      await profilesApi.delete(id);
      await loadProfiles();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete profile');
    }
  };

  const handleToggleDisabled = async (profile: Profile) => {
    try {
      await profilesApi.update(profile.id, { disabled: !profile.disabled });
      await loadProfiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update profile status');
    }
  };

  const openCreateForm = () => {
    setEditingProfile(null);
    setShowForm(true);
  };

  const openEditForm = (profile: Profile) => {
    setEditingProfile(profile);
    setShowForm(true);
  };

  const closeForm = () => {
    setEditingProfile(null);
    setShowForm(false);
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.type !== 'application/pdf') {
      setError('Please upload a PDF file');
      return;
    }

    setIsUploading(true);
    setUploadProgress('Uploading PDF...');
    setError('');
    setNotice('');

    try {
      setUploadProgress('Extracting profile information with AI...');
      const profile = await profilesApi.uploadResume(file);
      await loadProfiles();
      await refresh();
      setUploadProgress('');
      // Open edit form with the extracted profile so user can review/edit
      setEditingProfile(profile);
      setShowForm(true);
    } catch (err) {
      if (isProfileLimit(err)) await refresh();
      setError(err instanceof Error ? err.message : 'Failed to extract profile from PDF');
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

      if (result.imported === 1) {
        // Straight into the form, like the PDF path: one imported profile is
        // something you are about to look over anyway.
        setEditingProfile(result.profiles[0]);
        setShowForm(true);
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
      setError(err instanceof Error ? err.message : 'Failed to import profiles');
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
    ? 'Checking your plan...'
    : liveAccount
      ? `The ${liveAccount.planLabel} plan allows ${liveAccount.profileLimit} profile${liveAccount.profileLimit === 1 ? '' : 's'}. Delete one, or ask an administrator for a larger plan.`
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
              {liveAccount.role === 'admin' ? ' (administrators have no limit)' : ` on ${liveAccount.planLabel}`}
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
              title={addBlocked ? blockedReason : undefined}
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
              {liveAccount.profileLimit === 1 ? '' : 's'} on the {liveAccount.planLabel} plan.
            </p>
            <p className="mt-1">
              Delete one below to make room, or ask an administrator of this installation to move your
              account to a larger plan.{' '}
              <Link href="/settings/plan" className="font-medium underline underline-offset-2">
                See your plan
              </Link>
              .
            </p>
          </Notice>
        )}

        {notice && <Notice tone="success">{notice}</Notice>}

        {error && (
          <Notice tone="error" role="alert">
            {error}
          </Notice>
        )}
      </div>

      {showForm && (
        <div className="tl-backdrop">
          <div
            className="tl-dialog max-w-4xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-form-title"
          >
            <div className={chrome.dialogHead}>
              <h2 id="profile-form-title" className="text-xl font-bold tracking-tight text-ink">
                {editingProfile ? 'Edit Profile' : 'Create Profile'}
              </h2>
              <button type="button" onClick={closeForm} className="tl-icon-button" aria-label="Close">
                <IconClose className="h-5 w-5" />
              </button>
            </div>
            <div className="px-6 pb-6">
              <ProfileForm
                initialData={editingProfile || undefined}
                onSubmit={editingProfile ? handleUpdate : handleCreate}
                onCancel={closeForm}
              />
            </div>
          </div>
        </div>
      )}

      {profiles.length === 0 ? (
        <EmptyState
          title="No profiles"
          action={
            <button onClick={openCreateForm} className="tl-button">
              Add Profile
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
                  <h3 className="text-base font-semibold text-ink">{profile.name}</h3>
                  {profile.disabled && <Pill tone="grey">Disabled</Pill>}
                </div>
                {profile.title && <p className="mt-0.5 truncate text-sm text-muted">{profile.title}</p>}
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => openEditForm(profile)}
                  className="tl-button-quiet"
                  data-size="sm"
                >
                  Edit
                </button>
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
