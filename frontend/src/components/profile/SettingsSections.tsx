'use client';

import AiPreferenceFields from '@/components/AiPreferenceFields';
import { Field, Section } from '@/components/ui/kit';
import type { AiPreferences, HardSkillOrdering, PromptSummary, UserAppSettings } from '@/lib/api';
import { DEFAULT_PROFILE_SETTINGS, type DraftSettings, type ProfileDraft } from '@/lib/profileDraft';
import type { UpdateDraft } from './parts';

/**
 * The settings that change how this profile is generated rather than how its
 * page looks: the model, the prompts, the order a job puts skills in, and the
 * file names. An untailored preview has no job to tailor to, so none of them
 * changes it.
 */

const HARD_SKILL_ORDERING_OPTIONS: Array<{ value: HardSkillOrdering; label: string; description: string }> = [
  {
    value: 'library',
    label: 'Skill library priority',
    description: 'Order hard skills by the priority stored in the skill library.',
  },
  {
    value: 'job-priority',
    label: 'Job relevance',
    description: 'Order hard skills by how strongly the analyzed job description asks for them.',
  },
];

const FILE_NAME_TOKENS = '{{profile name}}, {{company name}}, {{row number}}, {{job title}}, {{date}}';
const FOLDER_NAME_TOKENS = '{{company name}}, {{row number}}';

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

  // No analysis prompt here any more: a posting is analysed once, for every
  // profile, by the one Analyze Job Description prompt - a profile choosing
  // its own would need a second analysis of the same posting.
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
          label="Hard skill ordering"
          htmlFor="profile-hard-skill-ordering"
          hint={HARD_SKILL_ORDERING_OPTIONS.find((option) => option.value === settings.hardSkillOrdering)?.description}
        >
          <select
            id="profile-hard-skill-ordering"
            value={settings.hardSkillOrdering}
            onChange={(event) => set('hardSkillOrdering', event.target.value as HardSkillOrdering, true)}
            className="tl-input"
          >
            {HARD_SKILL_ORDERING_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
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
        <Field
          label="Company folder name"
          htmlFor="profile-company-folder-name"
          hint={<>Available tokens: {FOLDER_NAME_TOKENS}</>}
        >
          <input
            id="profile-company-folder-name"
            type="text"
            value={settings.companyFolderNameTemplate}
            onChange={(event) => set('companyFolderNameTemplate', event.target.value)}
            className="tl-input"
            placeholder={DEFAULT_PROFILE_SETTINGS.companyFolderNameTemplate}
          />
        </Field>
      </div>
    </Section>
  );
}
