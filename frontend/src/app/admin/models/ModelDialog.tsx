'use client';

import { useState } from 'react';
import Dialog from '@/components/ui/Dialog';
import { ErrorNotice, Field, Status } from '@/components/ui/kit';
import {
  adminApi,
  ApiResponseError,
  findProviderModelOption,
  isProviderLocked,
  LOCK_ICON,
  type AdminAppSettings,
  type AIModelRecord,
} from '@/lib/api';
import { messageWithDetail } from '@/lib/userMessage';
import { firstModelName, isTaken, optionsFor } from './modelDraft';
import {
  blankModelDraft,
  createModelBody,
  draftFromModel,
  editModelBody,
  modelDraftProblems,
  modelRefusalField,
  type ModelDraft,
  type ModelField,
  type ModelProblems,
} from './modelForm';

/**
 * Create New Model, or Edit one (owner decision M1): the model's display name,
 * its seat and model name and a note, in a kit Dialog -
 * the pattern Providers' Add / Edit uses.
 *
 * People see the display name and nothing else; the provider and model name
 * decide what runs. Every box is checked as typed in the server's own
 * sentences (modelForm.ts); what only the server can judge comes back as a
 * refusal naming its box (`field`) and is shown under that box, and anything
 * else above the form, in the server's words.
 */
export default function ModelDialog({
  model,
  settings,
  onClose,
  onSaved,
}: {
  /** Null to create one. */
  model: AIModelRecord | null;
  settings: AdminAppSettings;
  onClose: () => void;
  /** The settings the save answered with, and a sentence saying what happened. */
  onSaved: (updated: AdminAppSettings, said: string) => void;
}) {
  const creating = model === null;
  const editingId = model?.id ?? null;
  const [draft, setDraft] = useState<ModelDraft>(() => (model ? draftFromModel(model) : blankModelDraft(settings)));
  const [attempted, setAttempted] = useState(false);
  /** The server's refusals, by box, until that box is edited. */
  const [refused, setRefused] = useState<ModelProblems>({});
  const [formError, setFormError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const local = modelDraftProblems(draft, settings, editingId);
  const problems: ModelProblems = { ...(attempted ? local : {}), ...refused };
  // The name clash is worth saying as soon as it is typed, not only on Save.
  if (local.name && draft.name.trim() && !problems.name) problems.name = local.name;

  const edit = <K extends keyof ModelDraft>(key: K, value: ModelDraft[K], field: ModelField = key as ModelField) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setRefused((current) => {
      if (!(field in current)) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const changeProvider = (value: string) => {
    const entry = settings.providerModelOptions.find((option) => option.provider === value);
    if (!entry) return;
    // The model name belongs to the provider, so a switch starts it over on
    // the new seat's list rather than carrying a name that seat may not have.
    setDraft((current) => ({
      ...current,
      provider: entry.provider,
      modelName:
        entry.provider === current.provider ? current.modelName : firstModelName(settings, entry.provider, editingId),
    }));
    setRefused((current) => {
      const next = { ...current };
      delete next.provider;
      delete next.modelName;
      return next;
    });
  };

  const save = async () => {
    setAttempted(true);
    setFormError(null);
    if (Object.keys(local).length > 0) return;
    const body = model ? editModelBody(model, draft) : createModelBody(draft);
    if (model && Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const updated = model
        ? await adminApi.updateModel(model.id, body)
        : await adminApi.createModel(createModelBody(draft));
      onSaved(updated, model ? `${draft.name.trim()} saved.` : `${draft.name.trim()} created.`);
    } catch (err) {
      const field = err instanceof ApiResponseError ? modelRefusalField(err.body) : null;
      if (field) {
        setRefused((current) => ({ ...current, [field]: messageWithDetail(err, 'That value was refused') }));
      } else {
        setFormError(err);
      }
    } finally {
      setSaving(false);
    }
  };

  const options = optionsFor(settings, draft.provider);
  /*
   * A record saved with a name the seat's list does not hold - typed before
   * the list existed, or since narrowed through .env - keeps its name as an
   * extra option while it is edited, so its display name and description
   * can still be changed. Choosing a listed name replaces it.
   */
  const listedOption = findProviderModelOption(settings.providerModelOptions, draft.provider, draft.modelName);

  const footer = (
    <>
      <button type="button" className="tl-button-quiet" onClick={onClose} disabled={saving}>
        Cancel
      </button>
      <button
        type="button"
        className="tl-button"
        onClick={() => void save()}
        disabled={saving || (attempted && Object.keys(local).length > 0)}
      >
        {saving ? 'Saving...' : creating ? 'Create model' : 'Save model'}
      </button>
    </>
  );

  return (
    <Dialog
      open
      title={model ? `Edit ${model.name}` : 'Create New Model'}
      subtitle="People see the display name and nothing else; the provider and model name decide what runs."
      width="wide"
      onClose={onClose}
      footer={footer}
    >
      <div className="space-y-5">
        {Boolean(formError) && <ErrorNotice error={formError} fallback="Could not save the model" />}

        <div className="grid gap-5 md:grid-cols-2">
          <Field label="Display name" htmlFor="model-display-name">
            <input
              id="model-display-name"
              type="text"
              value={draft.name}
              onChange={(event) => edit('name', event.target.value)}
              disabled={saving}
              placeholder="Claude Sonnet"
              aria-invalid={Boolean(problems.name)}
              className="tl-input"
            />
            {problems.name && <Status tone="error">{problems.name}</Status>}
          </Field>

          <Field label="Provider" htmlFor="model-provider">
            <select
              id="model-provider"
              value={draft.provider}
              onChange={(event) => changeProvider(event.target.value)}
              disabled={saving}
              aria-invalid={Boolean(problems.provider)}
              className="tl-input"
            >
              {settings.providerModelOptions.map((entry) => (
                // Still offered, not removed: a model row for a locked
                // provider is worth writing down now so it is simply there if
                // the lock is ever lifted.
                <option key={entry.provider} value={entry.provider}>
                  {isProviderLocked(settings, entry.provider) ? `${LOCK_ICON} ${entry.label} (locked)` : entry.label}
                </option>
              ))}
            </select>
            {problems.provider && <Status tone="error">{problems.provider}</Status>}
          </Field>

          <Field
            label="Model name"
            htmlFor="model-runtime-name"
            hint={options.length === 0 ? 'The server listed no model names for this provider.' : undefined}
          >
            <select
              id="model-runtime-name"
              // The listed spelling, so a name stored as `Sonnet` still shows
              // as the `sonnet` option; the draft keeps what was stored, so an
              // untouched name is not sent back as a change.
              value={listedOption?.value ?? draft.modelName}
              onChange={(event) => edit('modelName', event.target.value)}
              disabled={saving || (options.length === 0 && !draft.modelName)}
              aria-invalid={Boolean(problems.modelName)}
              className="tl-input"
            >
              {draft.modelName && !listedOption && (
                <option value={draft.modelName}>{draft.modelName} (current - not in the list)</option>
              )}
              {options.length === 0 && !draft.modelName && <option value="">No model names</option>}
              {options.length > 0 && !draft.modelName && (
                // Every name on this seat is taken: nothing is preselected,
                // so the form cannot be saved into the duplicate refusal.
                <option value="" disabled>
                  Choose a model
                </option>
              )}
              {options.map((option) => {
                const taken = isTaken(settings, draft.provider, option.value, editingId);
                return (
                  <option key={option.value} value={option.value} disabled={taken}>
                    {taken ? `${option.label} (already added)` : option.label}
                  </option>
                );
              })}
            </select>
            {problems.modelName && <Status tone="error">{problems.modelName}</Status>}
          </Field>

          <Field label="Description" htmlFor="model-description">
            <input
              id="model-description"
              type="text"
              value={draft.description}
              onChange={(event) => edit('description', event.target.value)}
              disabled={saving}
              placeholder="Optional - a note for administrators"
              className="tl-input"
            />
            {problems.description && <Status tone="error">{problems.description}</Status>}
          </Field>
        </div>

        <label className="flex items-center gap-3 text-sm text-ink">
          <input
            type="checkbox"
            className="tl-check"
            checked={draft.enabled}
            onChange={(event) => edit('enabled', event.target.checked)}
            disabled={saving}
          />
          {creating ? 'Enable this model immediately' : 'Enabled - people can pick it'}
        </label>
        {problems.enabled && <Status tone="error">{problems.enabled}</Status>}
      </div>
    </Dialog>
  );
}
