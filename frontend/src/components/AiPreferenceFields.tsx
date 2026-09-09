'use client';

import {
  AIModelRecord,
  AiPreferences,
  EFFORT_LABELS,
  EffortLevel,
  THINKING_LABELS,
  ThinkingMode,
  isEffortLevel,
  isThinkingMode,
} from '@/lib/api';

/**
 * What inheriting resolves to, so the inherit option can name it.
 *
 * "Use the default" is not much use on its own - the point of the option is
 * that you can see what you are getting without leaving the page.
 */
export type InheritedAiChoice = {
  modelLabel: string;
  effort: EffortLevel;
  thinking: ThinkingMode;
};

type Props = {
  value: AiPreferences;
  onChange: (next: AiPreferences) => void;
  models: AIModelRecord[];
  effortLevels: EffortLevel[];
  thinkingModes: ThinkingMode[];
  inherited: InheritedAiChoice;
  /** Where an unset field falls back to: "app default", "profile", ... */
  inheritedFrom: string;
  disabled?: boolean;
  idPrefix: string;
};

const SELECT_CLASS =
  'w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-gray-900 ' +
  'focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500 ' +
  'dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100';

const LABEL_CLASS = 'block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1';
const HINT_CLASS = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

/**
 * The model, effort and thinking selects.
 *
 * One component for both places these appear - the profile, where they set a
 * default, and the builder, where they override it for a single run - so the
 * two cannot drift into offering different options or different wording for
 * the same setting.
 */
export default function AiPreferenceFields({
  value,
  onChange,
  models,
  effortLevels,
  thinkingModes,
  inherited,
  inheritedFrom,
  disabled = false,
  idPrefix,
}: Props) {
  const enabledModels = models.filter((model) => model.enabled);
  const inheritOption = (what: string) => `Use the ${inheritedFrom} (${what})`;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div>
        <label className={LABEL_CLASS} htmlFor={`${idPrefix}-model`}>
          Model
        </label>
        <select
          id={`${idPrefix}-model`}
          value={value.modelId ?? ''}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...value, modelId: event.target.value || undefined })
          }
          className={SELECT_CLASS}
        >
          <option value="">{inheritOption(inherited.modelLabel)}</option>
          {enabledModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
        <p className={HINT_CLASS}>Models are configured under Admin &rarr; Models.</p>
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor={`${idPrefix}-effort`}>
          Effort
        </label>
        <select
          id={`${idPrefix}-effort`}
          value={value.effort ?? ''}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...value,
              effort: isEffortLevel(event.target.value) ? event.target.value : undefined,
            })
          }
          className={SELECT_CLASS}
        >
          <option value="">{inheritOption(EFFORT_LABELS[inherited.effort])}</option>
          {effortLevels.map((level) => (
            <option key={level} value={level}>
              {EFFORT_LABELS[level]}
            </option>
          ))}
        </select>
        <p className={HINT_CLASS}>How much reasoning the model spends before answering.</p>
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor={`${idPrefix}-thinking`}>
          Thinking
        </label>
        <select
          id={`${idPrefix}-thinking`}
          value={value.thinking ?? ''}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...value,
              thinking: isThinkingMode(event.target.value) ? event.target.value : undefined,
            })
          }
          className={SELECT_CLASS}
        >
          <option value="">{inheritOption(THINKING_LABELS[inherited.thinking])}</option>
          {thinkingModes.map((mode) => (
            <option key={mode} value={mode}>
              {THINKING_LABELS[mode]}
            </option>
          ))}
        </select>
        {/* Thinking is on by default on these models and adaptive per turn, so
            the useful choice is whether to allow it, not how much - depth is
            what effort controls. */}
        <p className={HINT_CLASS}>
          Thinking is on by default and the model decides per answer. Turning it off is faster.
        </p>
      </div>
    </div>
  );
}
