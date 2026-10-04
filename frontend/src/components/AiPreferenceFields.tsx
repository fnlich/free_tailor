'use client';

import {
  AIModelRecord,
  AiPreferences,
  LOCK_ICON,
  ProviderLock,
} from '@/lib/api';

/**
 * What inheriting resolves to, so the inherit option can name it.
 *
 * "Use the default" is not much use on its own - the point of the option is
 * that you can see what you are getting without leaving the page.
 */
export type InheritedAiChoice = {
  modelLabel: string;
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
  inherited: InheritedAiChoice;
  /** Where an unset field falls back to: "app default", "profile", ... */
  inheritedFrom: string;
  disabled?: boolean;
  idPrefix: string;
};

/*
 * The kit's field, label and hint (globals.css .tl-input / .tl-label, and the
 * subtle token), with no `dark:` variants: the html.dark shim beats every one
 * of them, and the kit's names are ones it never touches, so these read the
 * same in both themes on the profile form and in the builder.
 */
const SELECT_CLASS = 'tl-input';

const LABEL_CLASS = 'tl-label mb-2';
const HINT_CLASS = 'mt-2 text-sm text-subtle';
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
const LOCK_HINT_CLASS = 'mt-1 text-sm text-subtle';

/**
 * The model select.
 *
 * One component for both places it appears - the profile, where it sets a
 * default, and the builder, where it overrides that for a single run - so the
 * two cannot drift into offering different options or different wording for
 * the same setting.
 */
export default function AiPreferenceFields({
  value,
  onChange,
  models,
  providerLocks = [],
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

  const chooseModel = (modelId: string) => {
    onChange({ ...value, modelId: modelId || undefined });
  };

  return (
    <div className="grid grid-cols-1 gap-4">
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


    </div>
  );
}
