'use client';

import { AiPreferences, PublicModelOption } from '@/lib/api';
import { AI_UNAVAILABLE_MESSAGE } from '@/lib/userMessage';
import { useAuth } from '@/contexts/AuthContext';

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
  /**
   * The models this account can run, by display name. Nothing else: which
   * provider runs a model, what it is called on the server and what it costs
   * are an administrator's business, and the cost of a run is shown as its own
   * line by the builder rather than inside an option label.
   */
  models: PublicModelOption[];
  inherited: InheritedAiChoice;
  /** Where an unset field falls back to: "app default", "profile", ... */
  inheritedFrom: string;
  /**
   * Whether `models` is the server's answer yet. Until it is, a saved choice is
   * not called unavailable - an empty list that has not arrived, or that failed
   * to, says nothing about whether the model still exists.
   */
  modelsLoaded?: boolean;
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
  inherited,
  inheritedFrom,
  modelsLoaded = true,
  disabled = false,
  idPrefix,
}: Props) {
  const { account } = useAuth();
  const isAdmin = account?.role === 'admin';
  const inheritOption = (what: string) => `Use the ${inheritedFrom} (${what})`;
  /*
   * A saved choice that is no longer on offer - the model was disabled, removed
   * or can no longer run here. The server already runs such a profile on the
   * app default, so that is what the option says, and it is kept as the
   * selected row: a controlled select whose value matches nothing silently
   * shows its first option, which would claim the choice was "inherit" while
   * the stale id was still in the form.
   */
  const staleModelId =
    modelsLoaded && value.modelId && !models.some((model) => model.id === value.modelId) ? value.modelId : '';

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
          {staleModelId && (
            <option value={staleModelId} disabled>
              Unavailable model - the {inheritedFrom} is used
            </option>
          )}
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
        {/* An empty list that HAS arrived: nothing can run for this account. Why
            is the administrator's to know (Admin -> Models says), so this only
            says who can fix it. */}
        {modelsLoaded && models.length === 0 && <p className={HINT_CLASS}>{AI_UNAVAILABLE_MESSAGE}</p>}
        {staleModelId && (
          <p className={HINT_CLASS}>
            The model chosen here is no longer available, so the {inheritedFrom} is used. Choose another to
            replace it.
          </p>
        )}
        {/* Where the list comes from, for the one person who can change it. */}
        {isAdmin && <p className={HINT_CLASS}>Models are configured under Admin &rarr; Models.</p>}
      </div>
    </div>
  );
}
