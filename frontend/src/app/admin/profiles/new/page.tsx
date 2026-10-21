'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import ProfileEditor from '@/components/profile/ProfileEditor';
import { TemplateChooser } from '@/components/profile/TemplateChooser';
import { editorFont } from '@/components/profile/editorFont';
import editorCss from '@/components/profile/profileEditor.module.css';
import { JSON_ACCEPT, PDF_ACCEPT, chooseFile, useProfileImport } from '@/components/profile/useProfileImport';
import { LockedPanel, ProfileLimitLink } from '@/components/subscription/LockedFeature';
import { ErrorNotice, Notice, Spinner } from '@/components/ui/kit';
import { useAuth } from '@/contexts/AuthContext';
import { profilesApi, templatesApi, type Profile, type Template } from '@/lib/api';
import { isAtProfileLimit } from '@/lib/auth';
import { templatesUsedByOthers } from '@/lib/profileDraft';
import { readStartChoice, startProfileHref } from '@/lib/profileGallery';
import { describeLock } from '@/lib/subscriptions';

/**
 * A new profile, in FlowCV's steps: "Start building your profile" - the
 * template chooser - then the editor on the template chosen, which first asks
 * whether to import an existing resume or start from blank.
 *
 * The step is the address: no `template` shows the chooser, and its "Use this
 * template" goes to `?template=<id>` (`&layout=flat` when the details were
 * showing the Plain layout), so a reload keeps the choice and Back returns to
 * the chooser. `?template=` with nothing after it starts with no template. A
 * template that is not offered (any more) shows the chooser again.
 *
 * The subscription's limit is checked before either step is shown, against the
 * account's live list rather than the sign-in snapshot (which goes stale the
 * moment a profile is deleted) - letting somebody choose a template and fill
 * in a whole profile and then refusing the save is what the gate is for. The
 * server checks again on save and on every import.
 *
 * app/admin/layout.tsx gives this route a bare <main>: the chooser and the
 * editor each lay out their own full-width desk; the waiting and refusal
 * states pad themselves (`PADDED`). `useSearchParams` needs the Suspense
 * boundary around it for the page to prerender.
 */

const PADDED = 'mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8';

export default function NewProfilePage() {
  return (
    <Suspense
      fallback={
        <div className={PADDED}>
          <Spinner label="Loading..." />
        </div>
      }
    >
      <NewProfile />
    </Suspense>
  );
}

function NewProfile() {
  const router = useRouter();
  const params = useSearchParams();
  const { account, loading: authLoading } = useAuth();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [templatesError, setTemplatesError] = useState<unknown>(null);
  const importer = useProfileImport();
  const [imported, setImported] = useState('');

  useEffect(() => {
    let live = true;
    profilesApi.getAll({ includeDisabled: true }).then(
      (list) => live && setProfiles(list),
      (err) => {
        if (!live) return;
        setError(err ?? 'Failed to load your profiles.');
        setProfiles([]);
      }
    );
    // Only the enabled templates, whoever is asking: a resume is never drawn
    // with a disabled one, so neither step offers one.
    templatesApi
      .getAll()
      .then(
        (list) => live && setTemplates(list),
        (err) => live && setTemplatesError(err ?? 'Failed to load the templates.')
      )
      .finally(() => live && setTemplatesLoaded(true));
    return () => {
      live = false;
    };
  }, []);

  if (authLoading || profiles === null) {
    return (
      <div className={PADDED}>
        <Spinner label="Checking your subscription..." />
      </div>
    );
  }

  const liveAccount = account ? { ...account, profilesUsed: profiles.length } : null;
  if (liveAccount && !error && isAtProfileLimit(liveAccount)) {
    return (
      <div className={PADDED}>
        <h1 className="mb-4 text-2xl font-semibold text-ink">New Profile</h1>
        {/* Locked, as New profile is on the list: what the next tier allows, and the way to it. */}
        <LockedPanel lock={describeLock('more-profiles', liveAccount)}>
          <Link href="/admin/profiles" className="tl-button-quiet">
            Back to profiles
          </Link>
        </LockedPanel>
      </div>
    );
  }

  const templateParam = params.get('template');
  // A template named before the list has arrived waits for it, so a link to
  // one that is no longer offered never opens an editor on it.
  if (templateParam && !templatesLoaded) {
    return (
      <div className={PADDED}>
        <Spinner label="Loading the template..." />
      </div>
    );
  }
  // With no list to check against (it failed), the address is taken as it is:
  // the editor still works, and the server falls back for a template it lacks.
  const unchecked: Array<Pick<Template, 'id'>> =
    templatesError !== null && templates.length === 0 && templateParam ? [{ id: templateParam.trim() }] : templates;
  const choice = readStartChoice({ template: templateParam, layout: params.get('layout') }, unchecked);

  if (choice) {
    return (
      <>
        {/* The list failed: the form still works, and the server still enforces the limit on save. */}
        {error !== null && (
          <div className="px-4 pt-4 sm:px-6 lg:px-8">
            <ErrorNotice error={error} />
          </div>
        )}
        <ProfileEditor
          key={`${choice.templateId}:${choice.layout}`}
          profile={null}
          accountProfiles={profiles}
          start={{ ...choice, offerImport: true }}
        />
      </>
    );
  }

  const importPdf = async () => {
    const file = await chooseFile(PDF_ACCEPT);
    if (!file) return;
    setImported('');
    const profile = await importer.importPdf(file);
    // Straight into its editor: what the model read out of a PDF is worth
    // looking over before it is used, and the preview shows it as a resume.
    if (profile) router.push(`/admin/profiles/${encodeURIComponent(profile.id)}`);
  };

  const importJson = async () => {
    const file = await chooseFile(JSON_ACCEPT);
    if (!file) return;
    setImported('');
    const result = await importer.importJson(file);
    if (!result) return;
    if (result.imported === 1 && result.profiles[0]) {
      router.push(`/admin/profiles/${encodeURIComponent(result.profiles[0].id)}`);
      return;
    }
    const reused = result.keptIds > 0 ? ` ${result.keptIds} kept the id from the file.` : '';
    setImported(
      `Imported ${result.imported} profile${result.imported === 1 ? '' : 's'} from ${file.name}.${reused}`
    );
  };

  return (
    <div className={`${editorCss.editor} ${editorFont.variable}`}>
      <TemplateChooser
        templates={templates}
        loaded={templatesLoaded}
        loadError={templatesError}
        usedBy={templatesUsedByOthers(profiles)}
        onUse={(template, layout) => router.push(startProfileHref(template.id, layout))}
        onImportPdf={importPdf}
        onImportJson={importJson}
        importBusy={importer.busy}
        uploadMaxMb={importer.uploadMaxMb}
        notices={
          (importer.busy === 'pdf' || imported || importer.error !== null || error !== null) && (
            <>
              {importer.busy === 'pdf' && (
                <Notice tone="info" role="status" className="flex items-center gap-3">
                  <span className="tl-spinner" aria-hidden />
                  Reading your resume with AI. This can take a minute; its editor opens when it is done.
                </Notice>
              )}
              {imported && (
                <Notice tone="success">
                  {imported}{' '}
                  <Link href="/admin/profiles" className="font-medium underline underline-offset-2">
                    See your profiles
                  </Link>
                </Notice>
              )}
              <ErrorNotice error={importer.error} onDismiss={() => importer.setError(null)}>
                <ProfileLimitLink error={importer.error} />
              </ErrorNotice>
              <ErrorNotice error={error} />
            </>
          )
        }
      />
    </div>
  );
}
