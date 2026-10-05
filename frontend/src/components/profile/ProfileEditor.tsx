'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  DEFAULT_USER_APP_SETTINGS,
  HARD_SKILL_CATEGORIES,
  isProfileLimit,
  profilesApi,
  promptsApi,
  resumeApi,
  templatesApi,
  type AiPreferences,
  type Profile,
  type ProfilePreviewResult,
  type PromptSummary,
  type Template,
  type TechnicalSkillsLayout,
  type UserAppSettings,
} from '@/lib/api';
import { ErrorNotice, Notice, PageHeader, Pill } from '@/components/ui/kit';
import { useAuth } from '@/contexts/AuthContext';
import { savableModelChoice } from '@/lib/profileModel';
import {
  LAYOUT_LABELS,
  draftFromProfile,
  draftToPayload,
  draftToPreviewProfile,
  effectiveTemplateId,
  hasSkill,
  normalizeTechnicalSkillsLayout,
  sampledNotice,
  templateForLayout,
  templateOffersLayout,
  templateOptions,
  templateShowsCertifications,
  templatesUsedByOthers,
  type ProfileDraft,
} from '@/lib/profileDraft';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { BasicsSection, ContactSection, SummarySection } from './ContentSections';
import { CertificationsSection, EducationSection, ExperienceSection } from './HistorySections';
import type { UpdateDraft } from './parts';
import ProfilePreview, { type PreviewRequest } from './ProfilePreview';
import { AiDefaultsSection, GenerationSettingsSection } from './SettingsSections';
import { SoftSkillsSection, StrengthsSection, TechnicalSkillsSection } from './SkillSections';
import { TemplateSection } from './TemplateSection';
import css from './profileEditor.module.css';

/** The shared <datalist> of the hard-skill library, rendered once for every skill input. */
const LIBRARY_LIST_ID = 'profile-hard-skill-library';

/** How long typing must pause before the preview is redrawn. */
const TYPING_DEBOUNCE_MS = 400;

/** Where the two columns stop fitting; the CSS module draws the same line. */
const NARROW_QUERY = '(max-width: 1099.98px)';

type Pane = 'form' | 'preview';

/**
 * The profile editor: the form on the left, the resume it makes on the right.
 *
 * Owns the draft. Each section gets the draft and an `update` that changes it;
 * nothing is saved until Save, and leaving with changes asks first. The
 * preview is sent the draft as it stands, so a template, a layout, a switch or
 * a word typed shows on the page - see ProfilePreview for how often.
 *
 * `accountProfiles` is the account's list, which the page already loaded for
 * its own reasons; the editor reads which templates the other profiles use
 * from it rather than fetching it again.
 */
export default function ProfileEditor({
  profile,
  accountProfiles,
}: {
  /** The stored profile, or null for a new one. */
  profile: Profile | null;
  accountProfiles: Profile[];
}) {
  const router = useRouter();
  const { refresh } = useAuth();

  const [initial] = useState(() => draftFromProfile(profile));
  const [draft, setDraft] = useState<ProfileDraft>(initial);
  const baseline = useMemo(() => JSON.stringify(initial), [initial]);
  /** Whether the last change was a discrete choice, which the preview should not debounce. */
  const [quickPreview, setQuickPreview] = useState(true);
  const [layoutNotice, setLayoutNotice] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>('form');
  const narrow = useMediaQuery(NARROW_QUERY);

  const [templates, setTemplates] = useState<Template[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [prompts, setPrompts] = useState<PromptSummary[]>([]);
  const [library, setLibrary] = useState<string[]>([]);
  const [appSettings, setAppSettings] = useState<UserAppSettings>(DEFAULT_USER_APP_SETTINGS);
  /**
   * Whether the model list really arrived. An empty list from a failed request
   * must not be read as "nothing is available": that would drop a perfectly
   * good saved choice on the next save.
   */
  const [modelsLoaded, setModelsLoaded] = useState(false);

  const [saving, setSaving] = useState(false);
  /** A caught failure, which <ErrorNotice> words for the reader. */
  const [saveError, setSaveError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    // Only the enabled templates, whoever is asking: a resume is never drawn
    // with a disabled one, so the picker must not offer one either.
    templatesApi
      .getAll()
      .then((list) => live && setTemplates(list))
      .catch(() => undefined)
      .finally(() => live && setTemplatesLoaded(true));
    promptsApi
      .getAll()
      .then((list) => live && setPrompts(list))
      .catch(() => undefined);
    resumeApi
      .listSkills('hard')
      .then((answer) => live && setLibrary(answer.skills))
      .catch(() => undefined);
    // The model list and the app's own default, so the inherit option can say
    // what inheriting actually gets you.
    resumeApi
      .getModels()
      .then((settings) => {
        if (!live) return;
        setAppSettings(settings);
        setModelsLoaded(true);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const update: UpdateDraft = useCallback((recipe, options) => {
    setDraft((current) => recipe(current));
    setQuickPreview(options?.immediate === true);
  }, []);

  const dirty = JSON.stringify(draft) !== baseline;

  // Closing the tab or reloading with changes asks first. Leaving through the
  // page's own buttons asks too (see `leave`); a click on the rail does not,
  // because the App Router offers no way to hold a navigation.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const layout = normalizeTechnicalSkillsLayout(draft.settings.technicalSkillsLayout);
  const selectedId = effectiveTemplateId(draft);
  const selectedTemplate = templates.find((template) => template.id === selectedId) ?? null;
  const usedByOthers = useMemo(
    () => templatesUsedByOthers(accountProfiles, profile?.id),
    [accountProfiles, profile?.id]
  );
  const storedTemplateId = profile?.preferredTemplate || undefined;
  const options = templateOptions(templates, layout, {
    usedByOthers,
    ownTemplateIds: [storedTemplateId ?? '', selectedId],
  });
  const templateCounts = templatesLoaded
    ? {
        categorized: templates.filter((template) => templateOffersLayout(template, 'categorized')).length,
        flat: templates.filter((template) => templateOffersLayout(template, 'flat')).length,
      }
    : null;

  const templateName = useCallback(
    (id: string) => templates.find((template) => template.id === id)?.name ?? id,
    [templates]
  );

  const selectTemplate = (templateId: string) => {
    update((current) => ({ ...current, preferredTemplate: templateId }), { immediate: true });
    setLayoutNotice(null);
  };

  /**
   * A layout the chosen template cannot print moves the profile to one that
   * can - its stored template if that one can, else `default`, else the first -
   * and says so once, beside the control that caused it.
   */
  const changeLayout = (next: TechnicalSkillsLayout) => {
    if (next === layout) return;
    const label = LAYOUT_LABELS[next];
    let preferredTemplate = draft.preferredTemplate;
    let notice: string | null = null;
    if (selectedTemplate && !templateOffersLayout(selectedTemplate, next)) {
      const pick = templateForLayout(
        templateOptions(templates, next, { usedByOthers, ownTemplateIds: [storedTemplateId ?? ''] }),
        [storedTemplateId]
      );
      if (pick) {
        preferredTemplate = pick;
        notice = `${selectedTemplate.name} has no ${label} layout, so this profile now uses ${templateName(pick)}.`;
      } else {
        notice = `${selectedTemplate.name} has no ${label} layout, and every template that has one is used by another profile. Until one is free, resumes are drawn with the closest template the server finds.`;
      }
    }
    update(
      (current) => ({
        ...current,
        preferredTemplate,
        settings: { ...current.settings, technicalSkillsLayout: next },
      }),
      { immediate: true }
    );
    setLayoutNotice(notice);
  };

  /**
   * The library's spelling of a skill, adding it to the shared library first
   * when the library does not know it.
   *
   * Through `confirmSkill`, not the library's own add: that one belongs to the
   * administrator's Skill Library page, needs a category and a priority this
   * form never asks for (so it refused every new skill here), and is
   * admin-only. Confirm infers both, exactly as the builder does for a skill
   * it finds. Throws, for the section that asked to show.
   */
  const ensureLibrarySkill = useCallback(
    async (value: string) => {
      const known = library.find((skill) => skill.toLowerCase() === value.toLowerCase());
      if (known) return known;
      const answer = await resumeApi.confirmSkill({ type: 'hard', skill: value });
      const skill = answer.skill || value;
      setLibrary((current) =>
        hasSkill(current, skill) ? current : [...current, skill].sort((a, b) => a.localeCompare(b))
      );
      return skill;
    },
    [library]
  );

  // The library's headings, plus any this profile already uses. A profile
  // imported from a file may carry headings this build has never heard of, and
  // dropping them from the menu would silently reassign them on the next save.
  const headingOptions = useMemo(
    () =>
      [
        ...HARD_SKILL_CATEGORIES,
        ...Object.values(draft.skillCategoryBySkill).map((heading) => heading.trim()),
      ].filter((heading, index, all) => heading && all.indexOf(heading) === index),
    [draft.skillCategoryBySkill]
  );

  const previewRequest = useMemo<PreviewRequest>(
    () => ({
      profile: draftToPreviewProfile(draft, HARD_SKILL_CATEGORIES),
      ...(profile ? { profileId: profile.id } : {}),
    }),
    [draft, profile]
  );

  const previewNotes = (shown: ProfilePreviewResult, request: PreviewRequest) => {
    // What the page filled in for the fields left empty: said, so nobody
    // takes the sample person's phone number for their own.
    const sample = sampledNotice(shown.sampled);
    const sampleNote = sample ? (
      <p className={css.sampleNote} role="status">
        {sample} It fills what is empty, here only: it is never saved, printed or sent to tailoring.
      </p>
    ) : null;

    const wanted = request.profile.preferredTemplate || 'default';
    if (!templatesLoaded || shown.templateId === wanted) return sampleNote;
    const wantedTemplate = templates.find((template) => template.id === wanted);
    const shownLayout = LAYOUT_LABELS[normalizeTechnicalSkillsLayout(request.profile.profileSettings?.technicalSkillsLayout)];
    const reason = wantedTemplate
      ? `${wantedTemplate.name} has no ${shownLayout} layout`
      : 'the template this profile names is not offered any more';
    return (
      <>
        <Notice tone="info" role="status">
          Drawn with {templateName(shown.templateId)}: {reason}. A generated resume falls back the same way.
        </Notice>
        {sampleNote}
      </>
    );
  };

  const leave = () => {
    if (dirty && !window.confirm('Leave without saving? The changes you made to this profile will be lost.')) {
      return;
    }
    router.push('/admin/profiles');
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaveError(null);
    setSaving(true);
    try {
      const ai: AiPreferences = savableModelChoice(draft.settings.ai, {
        modelsLoaded,
        offeredIds: appSettings.models.map((model) => model.id),
        storedModelId: profile?.profileSettings?.ai?.modelId,
      });
      const payload = draftToPayload(draft, ai, HARD_SKILL_CATEGORIES);
      if (profile) {
        await profilesApi.update(profile.id, payload);
      } else {
        await profilesApi.create(payload);
        // The account's own count feeds the subscription line on the list, which would
        // otherwise read one behind until the next sign-in check.
        await refresh();
      }
      // Still "saving" while the list loads, so a second press cannot send it twice.
      router.push('/admin/profiles');
    } catch (err) {
      // Two tabs at the subscription's limit: one wins, and the other should find the
      // limit re-read rather than keep trying.
      if (isProfileLimit(err)) await refresh();
      setSaveError(err ?? 'Failed to save the profile.');
      setSaving(false);
    }
  };

  const templateSupports = (field: 'supportsStrengths' | 'supportsSoftSkills') =>
    templatesLoaded && selectedTemplate ? selectedTemplate[field] !== false : null;
  const selectedName = selectedTemplate?.name ?? 'This template';

  return (
    <div>
      <PageHeader
        title={profile ? 'Edit Profile' : 'New Profile'}
        description="Each change shows in the preview as you make it. Nothing is saved until you press Save."
        actions={
          <button type="button" onClick={leave} className="tl-button-quiet">
            Back to profiles
          </button>
        }
      />

      <div className={css.switcher}>
        <div className="tl-tabs" role="tablist" aria-label="Editor">
          {(['form', 'preview'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={pane === value}
              data-active={pane === value ? 'true' : 'false'}
              className="tl-tab"
              onClick={() => setPane(value)}
            >
              {value === 'form' ? 'Form' : 'Preview'}
            </button>
          ))}
        </div>
      </div>

      <div className={css.workspace} data-pane={pane}>
        <form className={css.formPane} onSubmit={handleSubmit}>
          <datalist id={LIBRARY_LIST_ID}>
            {library.map((skill) => (
              <option key={skill} value={skill} />
            ))}
          </datalist>

          <TemplateSection
            options={options}
            templates={templates}
            loaded={templatesLoaded}
            selectedId={selectedId}
            layout={layout}
            onSelect={selectTemplate}
          />
          <BasicsSection draft={draft} update={update} />
          <ContactSection draft={draft} update={update} />
          <SummarySection draft={draft} update={update} />
          <ExperienceSection
            draft={draft}
            update={update}
            libraryListId={LIBRARY_LIST_ID}
            ensureLibrarySkill={ensureLibrarySkill}
          />
          <EducationSection draft={draft} update={update} />
          <CertificationsSection
            draft={draft}
            update={update}
            templatePrintsThem={templatesLoaded && selectedTemplate ? templateShowsCertifications(selectedTemplate) : null}
            templateName={selectedName}
          />
          <TechnicalSkillsSection
            draft={draft}
            update={update}
            onLayoutChange={changeLayout}
            layoutNotice={layoutNotice}
            templateCounts={templateCounts}
            headingOptions={headingOptions}
            libraryListId={LIBRARY_LIST_ID}
            ensureLibrarySkill={ensureLibrarySkill}
          />
          <SoftSkillsSection
            draft={draft}
            update={update}
            templateSupports={templateSupports('supportsSoftSkills')}
            templateName={selectedName}
          />
          <StrengthsSection
            draft={draft}
            update={update}
            templateSupports={templateSupports('supportsStrengths')}
            templateName={selectedName}
          />
          <AiDefaultsSection draft={draft} update={update} appSettings={appSettings} modelsLoaded={modelsLoaded} />
          <GenerationSettingsSection draft={draft} update={update} prompts={prompts} />

          <div className={css.saveBar}>
            {saveError !== null && (
              <div className={css.saveError}>
                <ErrorNotice error={saveError} onDismiss={() => setSaveError(null)} />
              </div>
            )}
            <div className="min-w-0">
              {dirty ? (
                <Pill tone="amber">Unsaved changes</Pill>
              ) : (
                <span className="text-sm text-subtle">{profile ? 'No changes yet' : 'Nothing entered yet'}</span>
              )}
            </div>
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={leave} className="tl-button-quiet">
                Cancel
              </button>
              <button type="submit" disabled={saving} className="tl-button">
                {saving ? 'Saving...' : profile ? 'Save Profile' : 'Create Profile'}
              </button>
            </div>
          </div>
        </form>

        <aside className={css.previewPane} aria-label="Resume preview">
          <ProfilePreview
            request={previewRequest}
            active={!narrow || pane === 'preview'}
            debounceMs={quickPreview ? 0 : TYPING_DEBOUNCE_MS}
            templateName={templateName}
            notes={previewNotes}
          />
        </aside>
      </div>
    </div>
  );
}
