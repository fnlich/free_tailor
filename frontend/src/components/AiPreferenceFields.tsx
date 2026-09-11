'use client';

import {
  AIModelRecord,
  AiPreferences,
  EFFORT_LABELS,
  EffortLevel,
  LOCK_ICON,
  ProviderLock,
  ProviderTuningSupport,
  THINKING_LABELS,
  ThinkingMode,
  isEffortLevel,
  isThinkingMode,
  providerHonours,
  HYBRID_MODEL_ID,
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
  /**
   * Providers this installation cannot run. Their models are listed too, as
   * unselectable rows behind a padlock - a model that simply vanishes from the
   * menu looks like a bug, and someone who came here to pick it deserves to be
   * told why they cannot.
   */
  providerLocks?: ProviderLock[];
  /**
   * Which providers honour effort and thinking.
   *
   * Empty means "not known yet", and everything stays enabled - see
   * `providerHonours`. Greying a control on a guess is worse than offering one
   * that turns out to be a no-op.
   */
  providerTuning?: ProviderTuningSupport[];
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
const DISABLED_LABEL_CLASS =
  'block text-sm font-medium text-gray-400 dark:text-gray-500 mb-1';
const HINT_CLASS = 'mt-1 text-xs text-gray-500 dark:text-gray-400';
/**
 * The locked-provider note, as plain running text.
 *
 * It used to be an amber panel with a border and a padlock, which made four
 * lines of explanation read as an alarm - and this is not an alarm. Nothing is
 * broken and nothing needs doing: a provider this build does not offer is a
 * fact about the installation, and the sentence is there so the greyed row in
 * the menu above is not a mystery. Quiet grey text under the field it explains
 * says that; a coloured box shouting at somebody who has done nothing wrong
 * does not.
 */
const LOCK_HINT_CLASS = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

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
  providerLocks = [],
  providerTuning = [],
  effortLevels,
  thinkingModes,
  inherited,
  inheritedFrom,
  disabled = false,
  idPrefix,
}: Props) {
  const enabledModels = models.filter((model) => model.enabled);
  const inheritOption = (what: string) => `Use the ${inheritedFrom} (${what})`;
  const lockedModels = providerLocks.flatMap((lock) =>
    lock.models.filter((model) => model.enabled).map((model) => ({ model, lock }))
  );
  // Only the locks with something to show. A provider locked on a build that
  // has no model record for it has nothing to grey out, and an empty group
  // label under the menu would be a heading over nothing.
  const shownLocks = providerLocks.filter((lock) =>
    lockedModels.some((entry) => entry.lock.id === lock.id)
  );

  /**
   * Which provider this profile's calls will reach, for the two knobs below.
   *
   * Hybrid names no single provider, and both of the free accounts it routes
   * between answer the same way - neither has an effort flag or a thinking
   * budget - so it is read as a chat window rather than as "unknown".
   *
   * A blank model means INHERIT, and what it inherits is not known here: the
   * app default is a server-side setting this component is not given. So it
   * stays permissive, on the same reasoning as `providerHonours` - a control
   * greyed on a guess stops somebody choosing something that would have worked.
   */
  const chosenModel = models.find((model) => model.id === value.modelId);
  const chosenProvider =
    value.modelId === HYBRID_MODEL_ID ? 'claude-web' : chosenModel?.provider;
  const honoursEffort = providerHonours(providerTuning, chosenProvider, 'effort');
  const honoursThinking = providerHonours(providerTuning, chosenProvider, 'thinking');
  const notTunable = chosenModel
    ? `${chosenModel.name} is a chat window, which has no such setting.`
    : 'The chosen model is a chat window, which has no such setting.';

  /**
   * Changing the model drops a knob the new one cannot honour.
   *
   * Not merely cosmetic. The select below shows "Use the app default" while it
   * is inactive, so leaving a stored `effort=max` behind would have the form
   * SAY one thing and SEND another - and the stale value would come back the
   * moment somebody switched to a model that does honour it, as a setting they
   * do not remember making.
   */
  const chooseModel = (modelId: string) => {
    const next: AiPreferences = { ...value, modelId: modelId || undefined };
    const provider = modelId === HYBRID_MODEL_ID ? 'claude-web' : models.find((model) => model.id === modelId)?.provider;
    if (!providerHonours(providerTuning, provider, 'effort')) delete next.effort;
    if (!providerHonours(providerTuning, provider, 'thinking')) delete next.thinking;
    onChange(next);
  };

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
          onChange={(event) => chooseModel(event.target.value)}
          className={SELECT_CLASS}
        >
          <option value="">{inheritOption(inherited.modelLabel)}</option>
          {enabledModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
          {lockedModels.map(({ model, lock }) => (
            // `disabled` is what actually prevents the choice; the padlock is
            // there because a greyed row alone does not say why.
            <option key={model.id} value={model.id} disabled title={lock.reason}>
              {LOCK_ICON} {model.name} — locked
            </option>
          ))}
        </select>
        <p className={HINT_CLASS}>Models are configured under Admin &rarr; Models.</p>
        {shownLocks.map((lock) => (
          <p key={lock.id} className={LOCK_HINT_CLASS}>
            {lock.label} is not available in this installation. {lock.reason}
          </p>
        ))}
      </div>

      <div>
        <label
          className={honoursEffort ? LABEL_CLASS : DISABLED_LABEL_CLASS}
          htmlFor={`${idPrefix}-effort`}
        >
          Effort
        </label>
        <select
          id={`${idPrefix}-effort`}
          value={value.effort ?? ''}
          // Inactive rather than hidden. A control that vanishes when you change
          // the model above it reads as a bug; one that is greyed with a reason
          // reads as an answer.
          disabled={disabled || !honoursEffort}
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
        <p className={HINT_CLASS}>
          {honoursEffort ? 'How much reasoning the model spends before answering.' : notTunable}
        </p>
      </div>

      <div>
        <label
          className={honoursThinking ? LABEL_CLASS : DISABLED_LABEL_CLASS}
          htmlFor={`${idPrefix}-thinking`}
        >
          Thinking
        </label>
        <select
          id={`${idPrefix}-thinking`}
          value={value.thinking ?? ''}
          disabled={disabled || !honoursThinking}
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
          {honoursThinking
            ? 'Thinking is on by default and the model decides per answer. Turning it off is faster.'
            : notTunable}
        </p>
      </div>
    </div>
  );
}
