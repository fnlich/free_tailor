'use client';

import AiPreferenceFields from '@/components/AiPreferenceFields';
import { Field } from '@/components/ui/kit';
import type { AiPreferences, PromptSummary, UserAppSettings } from '@/lib/api';
import { DEFAULT_RESUME_SETTINGS, type DraftSettings, type ResumeDraft } from '@/lib/resumeDraft';
import { SettingsCard, type UpdateDraft } from './parts';

/**
 * The settings that change how this resume is generated rather than how its
 * page looks: the model, the building prompt and the file names. An untailored
 * preview has no job to tailor to, so none of them changes it - which is why
 * the card sits last of the three on the Customize tab. (There is no skill
 * ordering here any more: a tailored resume prints the skill groups the model
 * wrote, in its order, and an untailored one prints the source resume's skills
 * in the order they were entered.)
 *
 * There is no Tailoring choice: Choose Suitable Resume, Partial Tailor and
 * Fully Tailor are the RUN's mode, chosen in the builder.
 */

/** What the Building prompt is used for, now that the mode is the run's. */
const BUILDING_PROMPT_HINT =
  'Used when this resume is built with Partial Tailor. Fully Tailor runs Tailor Resume (Fully); Choose Suitable Resume builds the resume as written.';

/** The folder path's spellings (Settings > Account > Resume files), and two of the run's. */
const FILE_NAME_TOKENS =
  '{{profile_name}}, {{company_name}}, {{role}}, {{row_number}}, {{date}}, {{order_number}}, {{user_email}}';

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

export function GenerationSettingsCard({
  draft,
  update,
  appSettings,
  modelsLoaded,
  prompts,
}: {
  draft: ResumeDraft;
  update: UpdateDraft;
  appSettings: UserAppSettings;
  modelsLoaded: boolean;
  prompts: PromptSummary[];
}) {
  const settings = draft.settings;
  const set = <K extends keyof DraftSettings>(field: K, value: DraftSettings[K], immediate = false) =>
    update((current) => ({ ...current, settings: { ...current.settings, [field]: value } }), { immediate });

  // Only the tailoring prompt is a resume's to choose. A posting is analysed
  // once, for every resume, by the Analyze Job Description and Job Facts
  // (Filter) prompts - a resume choosing its own would need a second
  // analysis of the same posting - and the revise pass, the cover letter and
  // Write Entry Bullets have one prompt each, which every resume runs.
  const resumePrompts = prompts.filter((prompt) => prompt.featureKey === 'tailor-resume');

  return (
    <SettingsCard
      title="Generation"
      description="The model, the building prompt and the file names, used whenever this resume is generated. How much of it is rewritten is the run's choice, made in the builder. The builder can override the model for a single run; none of this changes the preview."
    >
      <AiPreferenceFields
        idPrefix="resume-ai"
        value={settings.ai}
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
      <div className="grid grid-cols-1 gap-6 @lg:grid-cols-2">
        <Field
          label="Building prompt"
          htmlFor="resume-prompt"
          hint={BUILDING_PROMPT_HINT}
        >
          <PromptSelect
            id="resume-prompt"
            value={settings.resumePromptId}
            prompts={resumePrompts}
            builtInId={DEFAULT_RESUME_SETTINGS.resumePromptId}
            builtInLabel="Built-in Resume Prompt"
            onChange={(value) => set('resumePromptId', value)}
          />
        </Field>
        <Field
          label="Resume file name"
          htmlFor="resume-file-name"
          hint={<>Available tokens: {FILE_NAME_TOKENS}</>}
        >
          <input
            id="resume-file-name"
            type="text"
            value={settings.resumeFileNameTemplate}
            onChange={(event) => set('resumeFileNameTemplate', event.target.value)}
            className="tl-input"
            placeholder={DEFAULT_RESUME_SETTINGS.resumeFileNameTemplate}
          />
        </Field>
        <Field
          label="Cover letter file name"
          htmlFor="resume-cover-letter-file-name"
          hint={<>Available tokens: {FILE_NAME_TOKENS}</>}
        >
          <input
            id="resume-cover-letter-file-name"
            type="text"
            value={settings.coverLetterFileNameTemplate}
            onChange={(event) => set('coverLetterFileNameTemplate', event.target.value)}
            className="tl-input"
            placeholder={DEFAULT_RESUME_SETTINGS.coverLetterFileNameTemplate}
          />
        </Field>
      </div>
    </SettingsCard>
  );
}
