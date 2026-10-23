'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import ResumeEditor from '@/components/resume/ResumeEditor';
import { TemplateChooser } from '@/components/resume/TemplateChooser';
import { editorFont } from '@/components/resume/editorFont';
import editorCss from '@/components/resume/resumeEditor.module.css';
import { JSON_ACCEPT, PDF_ACCEPT, chooseFile, useResumeImport } from '@/components/resume/useResumeImport';
import { ProfileLimitLink } from '@/components/subscription/LockedFeature';
import { ErrorNotice, Notice, Spinner } from '@/components/ui/kit';
import {
  ApiResponseError,
  profilesApi,
  templatesApi,
  type ProfileSummary,
  type Template,
} from '@/lib/api';
import { profilePageHref, readProfileParam } from '@/lib/profileDashboard';
import { readStartChoice, startResumeHref } from '@/lib/resumeGallery';

/**
 * A new resume, in FlowCV's steps: "Start building a resume" - the template
 * chooser - then the editor on the template chosen, which first asks whether
 * to import an existing resume or start from blank.
 *
 * The step is the address: no `template` shows the chooser, and its "Use this
 * template" goes to `?template=<id>` (`&layout=flat` when the details were
 * showing the Plain layout), so a reload keeps the choice and Back returns to
 * the chooser. `?template=` with nothing after it starts with no template. A
 * template that is not offered (any more) shows the chooser again.
 *
 * `&profile=<id>` names the profile the resume is for, and both steps keep it
 * in their addresses: the chooser says "for {name}", an import is filed under
 * it, and the editor's first save creates the resume there. With none, the
 * server files the resume under the person's name.
 *
 * Resumes are not counted, so nothing gates either step: a profile past its
 * tier's limit is a refusal to make a PROFILE, which a save that has to make
 * one shows (`ProfileLimitLink`).
 *
 * app/admin/layout.tsx gives this route a bare <main>: the chooser and the
 * editor each lay out their own full-width desk; the waiting and refusal
 * states pad themselves (`PADDED`). `useSearchParams` needs the Suspense
 * boundary around it for the page to prerender.
 */

const PADDED = 'mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8';

export default function NewResumePage() {
  return (
    <Suspense
      fallback={
        <div className={PADDED}>
          <Spinner label="Loading..." />
        </div>
      }
    >
      <NewResume />
    </Suspense>
  );
}

function NewResume() {
  const router = useRouter();
  const params = useSearchParams();
  const profileParam = readProfileParam(params.get('profile'));
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [templatesError, setTemplatesError] = useState<unknown>(null);
  /** The profile `?profile=` names, once read: `error` is why it could not be (not the viewer's, or gone). */
  const [named, setNamed] = useState<{ id: string; profile: ProfileSummary | null; error: unknown } | null>(null);
  const importer = useResumeImport(profileParam);
  const [imported, setImported] = useState<{ text: string; href: string } | null>(null);

  useEffect(() => {
    if (!profileParam) return;
    let live = true;
    profilesApi.get(profileParam).then(
      (profile) => live && setNamed({ id: profileParam, profile, error: null }),
      (err) => live && setNamed({ id: profileParam, profile: null, error: err ?? 'Failed to load the profile.' })
    );
    return () => {
      live = false;
    };
  }, [profileParam]);

  useEffect(() => {
    let live = true;
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

  const namedNow = named && named.id === profileParam ? named : null;
  // A profile the server says is not there for this viewer (404; 403 for good measure): the chooser says so,
  // and the resume is started with none named, so it is filed by the person's name instead of being typed
  // out in full for a save that is refused. A read that failed any other way (a network blip) proves nothing.
  const profileUnavailable =
    namedNow?.error instanceof ApiResponseError && (namedNow.error.status === 404 || namedNow.error.status === 403);
  const carriedProfile = profileUnavailable ? null : profileParam;
  const profile = namedNow?.profile ? { id: namedNow.profile.id, name: namedNow.profile.name } : null;

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
        <ResumeEditor
          key={`${choice.templateId}:${choice.layout}:${profileParam ?? ''}`}
          resume={null}
          profileId={profileParam}
          start={{ ...choice, offerImport: true }}
        />
      </>
    );
  }

  const importPdf = async () => {
    const file = await chooseFile(PDF_ACCEPT);
    if (!file) return;
    setImported(null);
    const resume = await importer.importPdf(file);
    // Straight into its editor: what the model read out of a PDF is worth
    // looking over before it is used, and the preview shows it as a resume.
    if (resume) router.push(`/admin/resumes/${encodeURIComponent(resume.id)}`);
  };

  const importJson = async () => {
    const file = await chooseFile(JSON_ACCEPT);
    if (!file) return;
    setImported(null);
    const result = await importer.importJson(file);
    if (!result) return;
    if (result.imported === 1 && result.resumes[0]) {
      router.push(`/admin/resumes/${encodeURIComponent(result.resumes[0].id)}`);
      return;
    }
    const reused = result.keptIds > 0 ? ` ${result.keptIds} kept the id from the file.` : '';
    // Where the resumes landed: the named profile, else the one profile the file's people made or
    // joined, else the dashboard (several people).
    const landed = profileParam ?? (result.profileIds?.length === 1 ? result.profileIds[0] : null);
    setImported({
      text: `Imported ${result.imported} resume${result.imported === 1 ? '' : 's'} from ${file.name}.${reused}`,
      href: landed ? profilePageHref(landed) : '/admin/profiles',
    });
  };

  return (
    <div className={`${editorCss.editor} ${editorFont.variable}`}>
      <TemplateChooser
        templates={templates}
        loaded={templatesLoaded}
        loadError={templatesError}
        profile={profile}
        profileId={carriedProfile}
        onUse={(template, layout) => router.push(startResumeHref(template.id, layout, carriedProfile))}
        onImportPdf={importPdf}
        onImportJson={importJson}
        importBusy={importer.busy}
        uploadMaxMb={importer.uploadMaxMb}
        notices={
          (importer.busy === 'pdf' || imported !== null || importer.error !== null || Boolean(namedNow?.error)) && (
            <>
              {importer.busy === 'pdf' && (
                <Notice tone="info" role="status" className="flex items-center gap-3">
                  <span className="tl-spinner" aria-hidden />
                  Reading your resume with AI. This can take a minute; its editor opens when it is done.
                </Notice>
              )}
              {imported && (
                <Notice tone="success">
                  {imported.text}{' '}
                  <Link href={imported.href} className="font-medium underline underline-offset-2">
                    See your resumes
                  </Link>
                </Notice>
              )}
              <ErrorNotice error={importer.error} onDismiss={() => importer.setError(null)}>
                <ProfileLimitLink error={importer.error} />
              </ErrorNotice>
              <ErrorNotice error={namedNow?.error ?? null} />
            </>
          )
        }
      />
    </div>
  );
}
