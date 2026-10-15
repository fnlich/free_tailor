'use client';

import AiPreferenceFields from '@/components/AiPreferenceFields';
import { Field, Section } from '@/components/ui/kit';
import type { AiPreferences, PromptSummary, UserAppSettings } from '@/lib/api';
import { DEFAULT_PROFILE_SETTINGS, type DraftSettings, type ProfileDraft } from '@/lib/profileDraft';
import type { UpdateDraft } from './parts';

/**
 * The settings that change how this profile is generated rather than how its
 * page looks: the model, the tailoring prompt and the file names. An
 * untailored preview has no job to tailor to, so none of them changes it.
 * (There is no skill ordering here any more: a tailored resume prints the
 * skill groups the model wrote, in its order, and an untailored one prints
 * the profile's skills in the order they were entered.)
 */

/** The folder path's spellings (Settings > Profile > Resume files), and two of the run's. */
const FILE_NAME_TOKENS =
  '{{profile_name}}, {{company_name}}, {{role}}, {{row_number}}, {{date}}, {{order_number}}, {{user_email}}';

export function AiDefaultsSection({
  draft,
  update,
  appSettings,
  modelsLoaded,
}: {
  draft: ProfileDraft;
  update: UpdateDraft;
  appSettings: UserAppSettings;
  modelsLoaded: boolean;
}) {
  return (
    <Section
      title="AI defaults"
      description="Used whenever this profile is generated. The builder can override it for a single run."
    >
      <AiPreferenceFields
        idPrefix="profile-ai"
        value={draft.settings.ai}
        onChange={(ai: AiPreferences) => update((current) => ({ ...current, settings: { ...current.settings, ai } }))}
        models={appSettings.models}
        modelsLoaded={modelsLoaded}
        inheritedFrom="app default"
        inherited={{
          modelLabel:
            appSettings.models.find((model) => model.id === appSettings.defaultModelId)?.name ||
            'the first enabled model',
        }}
      />
    </Section>
  );
}

/** A prompt <select> that keeps showing a stored choice the list no longer has. */
function PromptSelect({
  id,
  value,
  prompts,
  builtInId,
  builtInLabel,
  onChange,
}: {
  id: string;
  value: string;
  prompts: PromptSummary[];
  builtInId: string;
  builtInLabel: string;
  onChange: (value: string) => void;
}) {
  return (
    <select id={id} value={value} onChange={(event) => onChange(event.target.value)} className="tl-input">
      {!prompts.some((prompt) => prompt.id === value) && (
        <option value={value}>{value === builtInId ? builtInLabel : `Saved prompt (${value})`}</option>
      )}
      {prompts.map((prompt) => (
        <option key={prompt.id} value={prompt.id}>
          {prompt.name}
        </option>
      ))}
    </select>
  );
}

export function GenerationSettingsSection({
  draft,
  update,
  prompts,
}: {
  draft: ProfileDraft;
  update: UpdateDraft;
  prompts: PromptSummary[];
}) {
  const settings = draft.settings;
  const set = <K extends keyof DraftSettings>(field: K, value: DraftSettings[K], immediate = false) =>
    update((current) => ({ ...current, settings: { ...current.settings, [field]: value } }), { immediate });

  // Only the tailoring prompt is a profile's to choose. A posting is analysed
  // once, for every profile, by the Analyze Job Description and Job Facts
  // (Filter) prompts - a profile choosing its own would need a second
  // analysis of the same posting - and the revise pass and the cover letter
  // have one prompt each, which every profile runs.
  const resumePrompts = prompts.filter((prompt) => prompt.featureKey === 'tailor-resume');

  return (
    <Section title="Prompts and files" description="How this profile is tailored, and what its files are called.">
      <div className="grid grid-cols-1 gap-6 @lg:grid-cols-2">
        <Field label="Building prompt" htmlFor="profile-resume-prompt">
          <PromptSelect
            id="profile-resume-prompt"
            value={settings.resumePromptId}
            prompts={resumePrompts}
            builtInId={DEFAULT_PROFILE_SETTINGS.resumePromptId}
            builtInLabel="Built-in Resume Prompt"
            onChange={(value) => set('resumePromptId', value)}
          />
        </Field>
        <Field
          label="Resume file name"
          htmlFor="profile-resume-file-name"
          hint={<>Available tokens: {FILE_NAME_TOKENS}</>}
        >
          <input
            id="profile-resume-file-name"
            type="text"
            value={settings.resumeFileNameTemplate}
            onChange={(event) => set('resumeFileNameTemplate', event.target.value)}
            className="tl-input"
            placeholder={DEFAULT_PROFILE_SETTINGS.resumeFileNameTemplate}
          />
        </Field>
        <Field
          label="Cover letter file name"
          htmlFor="profile-cover-letter-file-name"
          hint={<>Available tokens: {FILE_NAME_TOKENS}</>}
        >
          <input
            id="profile-cover-letter-file-name"
            type="text"
            value={settings.coverLetterFileNameTemplate}
            onChange={(event) => set('coverLetterFileNameTemplate', event.target.value)}
            className="tl-input"
            placeholder={DEFAULT_PROFILE_SETTINGS.coverLetterFileNameTemplate}
          />
        </Field>
      </div>
    </Section>
  );
}
