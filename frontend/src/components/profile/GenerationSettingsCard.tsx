'use client';

import { useRef } from 'react';
import AiPreferenceFields from '@/components/AiPreferenceFields';
import { Field } from '@/components/ui/kit';
import type { AiPreferences, PromptSummary, TailorMode, UserAppSettings } from '@/lib/api';
import {
  DEFAULT_PROFILE_SETTINGS,
  TAILOR_MODE_CHOICES,
  type DraftSettings,
  type ProfileDraft,
} from '@/lib/profileDraft';
import { SettingsCard, type UpdateDraft } from './parts';
import css from './profileEditor.module.css';

/**
 * The settings that change how this profile is generated rather than how its
 * page looks: how it is tailored, the model, the tailoring prompt and the file
 * names. An untailored preview has no job to tailor to, so none of them
 * changes it - which is why the card sits last on the Customize tab. (There is
 * no skill ordering here any more: a tailored resume prints the skill groups
 * the model wrote, in its order, and an untailored one prints the profile's
 * skills in the order they were entered.)
 *
 * Tailoring is Partial or Fully tailor (the owner's request of 2026-10-20). A
 * profile that never chose follows the default the server names
 * (`defaultTailorMode`, `.env`'s DEFAULT_TAILOR_MODE); choosing either pins it,
 * and "Use the default" lets it go again (saved as `null`).
 */

/** The folder path's spellings (Settings > Profile > Resume files), and two of the run's. */
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
  draft: ProfileDraft;
  update: UpdateDraft;
  appSettings: UserAppSettings;
  modelsLoaded: boolean;
  prompts: PromptSummary[];
}) {
  const settings = draft.settings;
  const set = <K extends keyof DraftSettings>(field: K, value: DraftSettings[K], immediate = false) =>
    update((current) => ({ ...current, settings: { ...current.settings, [field]: value } }), { immediate });

  // Only the tailoring prompt is a profile's to choose. A posting is analysed
  // once, for every profile, by the Analyze Job Description and Job Facts
  // (Filter) prompts - a profile choosing its own would need a second
  // analysis of the same posting - and the revise pass, the cover letter and
  // Write Entry Bullets have one prompt each, which every profile runs.
  const resumePrompts = prompts.filter((prompt) => prompt.featureKey === 'tailor-resume');
  const chosenMode = settings.tailorMode;
  // The default is the server's (GET /resume/models), so until it has said -
  // or if it cannot be read - no mode is drawn as the default: a profile that
  // follows `full` must never show Partial ticked for a moment, or for good.
  const defaultMode = modelsLoaded ? appSettings.defaultTailorMode : null;
  const mode = chosenMode ?? defaultMode;
  const defaultLabel = TAILOR_MODE_CHOICES.find((choice) => choice.value === defaultMode)?.label ?? null;
  const radios = useRef<Partial<Record<TailorMode, HTMLInputElement | null>>>({});
  // A click on the mode already shown pins it too: following the default, the
  // default's own radio is checked, so no change event would ever fire for it.
  const choose = (value: TailorMode) => {
    if (chosenMode !== value) set('tailorMode', value);
  };
  // "Use the default" takes itself away as it is pressed, so focus goes to the
  // radio now checked rather than to the page.
  const followDefault = () => {
    set('tailorMode', null);
    const target = defaultMode ?? TAILOR_MODE_CHOICES[0].value;
    requestAnimationFrame(() => radios.current[target]?.focus());
  };

  return (
    <SettingsCard
      title="Generation"
      description="How this profile is tailored, the model, the tailoring prompt and the file names, used whenever it is generated. The builder can override the model for a single run; none of this changes the preview."
    >
      <fieldset aria-describedby="profile-tailor-source">
        <legend className="tl-label">Tailoring</legend>
        <div className={`${css.choices} mt-3`}>
          {TAILOR_MODE_CHOICES.map((choice) => (
            <label
              key={choice.value}
              htmlFor={`profile-tailor-${choice.value}`}
              className="tl-choice"
              data-on={mode === choice.value ? 'true' : 'false'}
            >
              <input
                id={`profile-tailor-${choice.value}`}
                ref={(element) => {
                  radios.current[choice.value] = element;
                }}
                type="radio"
                name="profile-tailor-mode"
                value={choice.value}
                checked={mode === choice.value}
                onChange={() => choose(choice.value)}
                onClick={() => choose(choice.value)}
              />
              <span className="min-w-0">
                <span className="block font-semibold text-ink">{choice.label}</span>
                <span className="mt-1 block text-sm text-muted">{choice.description}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted" id="profile-tailor-source">
          {chosenMode ? (
            <>
              <span>Your choice for this profile.</span>
              <button type="button" className="tl-button-quiet" data-size="sm" onClick={followDefault}>
                {defaultLabel ? `Use the default (${defaultLabel})` : 'Use the default'}
              </button>
            </>
          ) : (
            <span>
              {defaultLabel
                ? `This profile follows the default, ${defaultLabel}. Choose one to keep it whatever the default becomes.`
                : 'This profile follows the default, which could not be shown yet. Choose one to set it for this profile.'}
            </span>
          )}
          <span>Either way, Technical Skills leads with the job&apos;s own hard skills.</span>
        </p>
      </fieldset>
      <AiPreferenceFields
        idPrefix="profile-ai"
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
          htmlFor="profile-resume-prompt"
          hint={
            mode === 'full'
              ? 'Used for Partial tailor. Fully tailor runs its own prompt, Tailor Resume (Fully).'
              : undefined
          }
        >
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
    </SettingsCard>
  );
}
