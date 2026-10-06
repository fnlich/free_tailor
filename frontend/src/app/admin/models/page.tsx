'use client';

import { useEffect, useState } from 'react';
import { AdminOnly } from '@/components/auth/AuthGate';
import {
  adminApi,
  AdminAppSettings,
  AIModelRecord,
  AIProvider,
  coerceProvider,
  describeProviderModel,
  findProviderModelOption,
  formatPricePerResume,
  getAIProviderLabel,
  isProviderLocked,
  isProviderOffered,
  LOCK_ICON,
} from '@/lib/api';
import { formatMoney, toDollarInput } from '@/lib/format';
import { ErrorNotice, Field, Notice, Pill, Section, Spinner } from '@/components/ui/kit';
import { messageWithDetail } from '@/lib/userMessage';
import { blankDraftChoice, displayNameOwner, firstModelName, isTaken, optionsFor } from './modelDraft';
import { freeEnabledModels, readPriceDraft } from './modelPrice';
import ProvidersSection from './ProvidersSection';

type ModelDraft = {
  name: string;
  provider: AIProvider;
  modelName: string;
  /**
   * Dollars per resume, kept as typed ("0.023") so the field can be cleared
   * and retyped; checked as it is typed and sent as typed - the server parses
   * it exactly, in thousandths.
   */
  price: string;
  description: string;
  enabled: boolean;
};

function lockReason(settings: AdminAppSettings, provider: AIProvider): string {
  return settings.providerLocks.find((lock) => lock.id === provider)?.reason ?? '';
}

function toDraft(model: AIModelRecord): ModelDraft {
  return {
    name: model.name,
    provider: model.provider,
    modelName: model.modelName,
    price: toDollarInput(model.pricePerResumeMilli),
    description: model.description,
    enabled: model.enabled,
  };
}

/** A blank form on the first seat with a free model name, on that name. */
function emptyDraft(settings: AdminAppSettings | null): ModelDraft {
  const { provider, modelName } = blankDraftChoice(settings);
  return {
    name: '',
    provider,
    modelName,
    // EMPTY, not a default: a new model is priced by whoever adds it, and the
    // server refuses a create without a price. A pre-filled figure is a price
    // somebody would save without having chosen it.
    price: '',
    description: '',
    enabled: true,
  };
}

function ModelsPageBody() {
  const [settings, setSettings] = useState<AdminAppSettings | null>(null);
  const [draft, setDraft] = useState<ModelDraft>(() => emptyDraft(null));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  /** Why the models could not be read, whole, for the notice's reference and cause. */
  const [loadError, setLoadError] = useState<unknown>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    void loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setIsLoading(true);
      setError('');
      setLoadError(null);
      const loaded = await adminApi.getSettings();
      setSettings(loaded);
      // The blank form needs the seat lists to pick its model name from, and
      // they arrive with the settings.
      setDraft(emptyDraft(loaded));
    } catch (err) {
      setLoadError(err);
    } finally {
      setIsLoading(false);
    }
  };

  const resetDraft = (next: AdminAppSettings | null = settings) => {
    setDraft(emptyDraft(next));
    setEditingId(null);
  };

  const handleProviderChange = (value: string) => {
    if (!settings) return;
    const provider = coerceProvider(value);
    if (!provider) return;
    // The model name belongs to the provider, so a switch starts it over on
    // the new seat's list rather than carrying a name that seat may not have.
    setDraft((current) => ({
      ...current,
      provider,
      modelName:
        provider === current.provider ? current.modelName : firstModelName(settings, provider, editingId),
    }));
  };

  const handleSubmit = async () => {
    const name = draft.name.trim();
    const modelName = draft.modelName.trim();
    const price = readPriceDraft(draft.price);

    if (!name) {
      setError('Display name is required.');
      return;
    }

    const nameOwner = displayNameOwner(settings ?? { aiModels: [] }, name, editingId);
    if (nameOwner) {
      setError(
        `"${nameOwner.name}" is already the name of a ${getAIProviderLabel(nameOwner.provider)} model. ` +
          'People see only display names, so give this one a different name.'
      );
      return;
    }

    if (!modelName) {
      setError('Choose a model.');
      return;
    }

    if (!price.ok) {
      setError(price.message);
      return;
    }

    try {
      setIsSaving(true);
      setError('');
      setStatus('');
      const fields = {
        name,
        provider: draft.provider,
        modelName,
        // As typed: the server reads "0.023" exactly. Sending the parsed
        // number back as a float would be the one way to lose that precision.
        pricePerResumeUsd: draft.price.trim(),
        description: draft.description.trim(),
        enabled: draft.enabled,
      };
      const updated = editingId
        ? await adminApi.updateModel(editingId, fields)
        : await adminApi.createModel(fields);
      setSettings(updated);
      setStatus(editingId ? 'Model updated.' : 'Model created.');
      resetDraft(updated);
    } catch (err) {
      setError(messageWithDetail(err, 'Failed to save model'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleEdit = (model: AIModelRecord) => {
    setDraft(toDraft(model));
    setEditingId(model.id);
    setError('');
    setStatus('');
  };

  const handleDelete = async (model: AIModelRecord) => {
    if (!window.confirm(`Delete model "${model.name}"?`)) return;

    try {
      setIsSaving(true);
      setError('');
      setStatus('');
      const updated = await adminApi.deleteModel(model.id);
      setSettings(updated);
      if (editingId === model.id) {
        resetDraft(updated);
      }
      setStatus('Model deleted.');
    } catch (err) {
      setError(messageWithDetail(err, 'Failed to delete model'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleEnabled = async (model: AIModelRecord) => {
    try {
      setIsSaving(true);
      setError('');
      setStatus('');
      // `{enabled}` alone: the server keeps every other field, the price
      // included, so a toggle can never reprice a model by accident.
      const updated = await adminApi.updateModel(model.id, { enabled: !model.enabled });
      setSettings(updated);
      if (editingId === model.id) {
        setDraft((current) => ({ ...current, enabled: !model.enabled }));
      }
      setStatus(`${model.name} ${model.enabled ? 'disabled' : 'enabled'}.`);
    } catch (err) {
      setError(messageWithDetail(err, 'Failed to update model'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleSetDefault = async (model: AIModelRecord) => {
    try {
      setIsSaving(true);
      setError('');
      setStatus('');
      const updated = await adminApi.updateSettings({ defaultModelId: model.id });
      setSettings(updated);
      setStatus(`Default model set to ${model.name}.`);
    } catch (err) {
      setError(messageWithDetail(err, 'Failed to update default model'));
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return <Spinner />;
  }
  if (!settings) {
    return (
      <div>
        <header>
          <h2 className="text-2xl font-bold tracking-tight text-ink">Models</h2>
        </header>
        <ErrorNotice className="mt-6" error={loadError ?? 'Failed to load models'} fallback="Failed to load models">
          <button type="button" onClick={() => void loadSettings()} className="tl-button-quiet mt-4">
            Try again
          </button>
        </ErrorNotice>
      </div>
    );
  }

  const providerEnabled = settings.providersEnabled;
  const draftOptions = optionsFor(settings, draft.provider);
  /*
   * A record saved with a name the seat's list does not hold - typed before
   * the list existed, or since narrowed through .env - keeps its name as an
   * extra option while it is edited, so its display name, price and
   * description can still be changed. Choosing a listed name replaces it.
   */
  const draftListedOption = findProviderModelOption(settings.providerModelOptions, draft.provider, draft.modelName);
  const draftPrice = readPriceDraft(draft.price);
  const nameOwner = displayNameOwner(settings, draft.name, editingId);
  const freeModels = freeEnabledModels(settings);

  return (
    <div>
      <header>
        <h2 className="text-2xl font-bold tracking-tight text-ink">Models</h2>
        <p className="mt-1 text-sm text-muted">
          The models people choose from in the Resume Builder and on their profiles, by the display name
          you give each one, and what one resume on it costs - and, under Providers, every place each type
          of model runs.
        </p>
      </header>

      {freeModels.length > 0 && (
        /*
         * Red, and above everything, while any model people can pick costs
         * nothing. After credits became dollars every price was reset to
         * $0 (the owner's decision), and a model a migration seeds - or
         * every seed of a fresh install - arrives unpriced too: free on
         * purpose is allowed - 0 is a price - but never without somebody
         * having seen it. The server names the models (`freeEnabledModelIds`),
         * so this lists exactly what it would charge nothing for. The last
         * sentence names no single cause: on a fresh install nothing was
         * reset, and one priced at $0 on purpose was not either.
         */
        <Notice tone="error" role="alert" className="mt-6">
          <p className="font-semibold">
            {freeModels.length === 1
              ? 'One enabled model is free: every resume on it costs $0.'
              : `${freeModels.length} enabled models are free: every resume on them costs $0.`}
          </p>
          <p className="mt-1">
            {freeModels.map((model) => model.name || model.id).join(', ')}. Set a price per resume with
            Edit - in dollars, to $0.001, like 0.023 - or disable the model. A model is free until it is
            given a price - including any priced before credits became dollars, and any an upgrade adds.
          </p>
        </Notice>
      )}

      {(error || status) && (
        <div className="mt-6 space-y-3">
          {error && (
            <Notice tone="error" role="alert">
              {error}
            </Notice>
          )}
          {status && (
            <Notice tone="success" role="status">
              {status}
            </Notice>
          )}
        </div>
      )}

      <Section
        title={editingId ? 'Edit Model' : 'Add Model'}
        description="People see the display name and nothing else; the provider and model name decide what runs."
        actions={
          editingId && (
            <button type="button" onClick={() => resetDraft()} disabled={isSaving} className="tl-button-quiet">
              Cancel Edit
            </button>
          )
        }
      >
        <div className="grid gap-6 md:grid-cols-2">
          <Field
            label="Display name"
            htmlFor="model-display-name"
            hint={
              nameOwner
                ? `Already the name of a ${getAIProviderLabel(nameOwner.provider)} model - people see only this name, so it must differ.`
                : undefined
            }
          >
            <input
              id="model-display-name"
              type="text"
              value={draft.name}
              onChange={(e) => setDraft((current) => ({ ...current, name: e.target.value }))}
              disabled={isSaving}
              placeholder="Claude Sonnet"
              className="tl-input"
            />
          </Field>

          <Field label="Provider" htmlFor="model-provider">
            <select
              id="model-provider"
              value={draft.provider}
              onChange={(e) => handleProviderChange(e.target.value)}
              disabled={isSaving}
              className="tl-input"
            >
              {settings.providerModelOptions.map((entry) => (
                // Still offered, not removed: a model row for a locked
                // provider is worth writing down now so it is simply there if
                // the lock is ever lifted.
                <option key={entry.provider} value={entry.provider}>
                  {isProviderLocked(settings, entry.provider)
                    ? `${LOCK_ICON} ${entry.label} (locked)`
                    : entry.label}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Model name"
            htmlFor="model-runtime-name"
            hint={
              draftOptions.length === 0
                ? 'The server listed no model names for this provider.'
                : undefined
            }
          >
            <select
              id="model-runtime-name"
              // The listed spelling, so a name stored as `Sonnet` still shows
              // as the `sonnet` option; the draft keeps what was stored, so an
              // untouched name is not sent back as a change.
              value={draftListedOption?.value ?? draft.modelName}
              onChange={(e) => setDraft((current) => ({ ...current, modelName: e.target.value }))}
              disabled={isSaving || (draftOptions.length === 0 && !draft.modelName)}
              className="tl-input"
            >
              {draft.modelName && !draftListedOption && (
                <option value={draft.modelName}>{draft.modelName} (current - not in the list)</option>
              )}
              {draftOptions.length === 0 && !draft.modelName && <option value="">No model names</option>}
              {draftOptions.length > 0 && !draft.modelName && (
                // Every name on this seat is taken: nothing is preselected,
                // so the form cannot be saved into the duplicate refusal.
                <option value="" disabled>
                  Choose a model
                </option>
              )}
              {draftOptions.map((option) => {
                const taken = isTaken(settings, draft.provider, option.value, editingId);
                return (
                  <option key={option.value} value={option.value} disabled={taken}>
                    {taken ? `${option.label} (already added)` : option.label}
                  </option>
                );
              })}
            </select>
          </Field>

          <Field
            label="Price per resume ($)"
            htmlFor="model-price-per-resume"
            hint={
              !draftPrice.ok
                ? draft.price.trim() === ''
                  ? 'Required. Dollars to $0.001, like 0.023; 0 makes the model free.'
                  : draftPrice.message
                : draftPrice.milli === 0
                  ? 'Free - a resume on this model costs $0.'
                  : `${formatMoney(draftPrice.milli)} a resume. 0 makes it free.`
            }
          >
            <input
              id="model-price-per-resume"
              // Text, like every other dollar box: a number box hands over
              // what the BROWSER made of the keystrokes, not what was typed.
              // In an en-US Chrome "0,023" becomes "0023" before onChange sees
              // it - $23 a resume, a thousand times the price meant -
              // where the text reaches readPriceDraft and the server as typed
              // and is refused by name. The range and the $0.001 step are
              // theirs to check, not the box's.
              type="text"
              inputMode="decimal"
              autoComplete="off"
              required={!editingId}
              placeholder="0.023"
              value={draft.price}
              onChange={(e) => setDraft((current) => ({ ...current, price: e.target.value }))}
              disabled={isSaving}
              aria-invalid={draft.price.trim() !== '' && !draftPrice.ok}
              className="tl-input"
            />
          </Field>

          <Field label="Description" htmlFor="model-description">
            <input
              id="model-description"
              type="text"
              value={draft.description}
              onChange={(e) => setDraft((current) => ({ ...current, description: e.target.value }))}
              disabled={isSaving}
              placeholder="Optional - a note for administrators"
              className="tl-input"
            />
          </Field>
        </div>

        <label className="flex items-center gap-3 text-sm text-ink">
          <input
            type="checkbox"
            className="tl-check"
            checked={draft.enabled}
            onChange={(e) => setDraft((current) => ({ ...current, enabled: e.target.checked }))}
            disabled={isSaving}
          />
          Enable this model immediately
        </label>

        <div>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={isSaving}
            className="tl-button"
          >
            {isSaving ? 'Saving...' : editingId ? 'Save Model' : 'Create Model'}
          </button>
        </div>
      </Section>

      <Section title="Model Library">
        {/* `relative` so the sr-only Actions heading - absolutely positioned -
            is held by this scroll box; otherwise it escapes the sideways
            scroll and widens the whole page on a phone. */}
        <div className="tl-table-box relative">
          <table className="tl-table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Provider</th>
                <th scope="col">Price</th>
                <th scope="col">Status</th>
                <th scope="col">Updated</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {settings.aiModels.map((model) => {
                const isDefault = settings.defaultModelId === model.id;
                const providerIsLocked = isProviderLocked(settings, model.provider);
                // The same rule the backend gate applies, via the shared helper: a
                // model whose provider this installation has withdrawn is still
                // MANAGEABLE here - that is why the admin list is the raw one - but
                // it must read as off and must not be settable as the default.
                const providerIsEnabled = isProviderOffered(settings, model.provider, providerEnabled);
                // Still runnable - the server never checks a stored name against
                // the list - but worth a look: it may be a name the CLI no longer
                // takes, and it cannot be picked again once changed.
                const isListed = Boolean(
                  findProviderModelOption(settings.providerModelOptions, model.provider, model.modelName)
                );

                return (
                  <tr key={model.id}>
                    <td className="min-w-[16rem]">
                      {/* Colours on inner elements: `.tl-table td` is unlayered
                          and would beat a utility on the cell itself. */}
                      <p className="font-semibold text-ink">{model.name}</p>
                      <p className="mt-0.5 text-xs text-ink">
                        {describeProviderModel(settings.providerModelOptions, model.provider, model.modelName)}
                        {isListed && (
                          <span className="ml-1.5 break-all font-mono text-subtle">{model.modelName}</span>
                        )}
                      </p>
                      <p className="mt-1 text-sm text-muted">
                        {model.description || 'No description provided.'}
                      </p>
                      {providerIsLocked && (
                        // Plain: the Locked badge beside it is the status, and
                        // this is the explanation under it. See the same note on
                        // Settings.
                        <p className="mt-1 text-sm text-muted">{lockReason(settings, model.provider)}</p>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      <Pill tone="grey">{getAIProviderLabel(model.provider)}</Pill>
                    </td>
                    <td className="whitespace-nowrap tabular-nums">
                      {/*
                        Red while it is enabled and free - the notice above names it
                        too. The kit's status colour, on a span: `.tl-table td` is
                        unlayered and would beat a utility on the cell.
                      */}
                      {model.enabled && model.pricePerResumeMilli === 0 ? (
                        <span className="tl-status font-semibold" data-tone="error">
                          {formatPricePerResume(model.pricePerResumeMilli)}
                        </span>
                      ) : (
                        <span className="text-ink">{formatPricePerResume(model.pricePerResumeMilli)}</span>
                      )}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1.5">
                        {isDefault && <Pill tone="sky">Default</Pill>}
                        {model.enabled && providerIsEnabled && <Pill tone="green">Enabled</Pill>}
                        {!model.enabled && <Pill tone="red">Disabled</Pill>}
                        {providerIsLocked && (
                          <span title={lockReason(settings, model.provider)}>
                            <Pill tone="amber">{LOCK_ICON} Locked</Pill>
                          </span>
                        )}
                        {model.enabled && !providerIsEnabled && !providerIsLocked && (
                          <Pill tone="amber">Provider off</Pill>
                        )}
                        {!isListed && <Pill tone="amber">Not in model list</Pill>}
                      </div>
                    </td>
                    {/* The column says "Updated", so the cell is the date alone. */}
                    <td className="whitespace-nowrap text-xs">{new Date(model.updatedAt).toLocaleString()}</td>
                    <td>
                      {/* Wraps rather than widening the row: with the Price
                          column the four buttons pushed Delete off a 1440px
                          screen. */}
                      <div className="flex flex-wrap justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => handleEdit(model)}
                          disabled={isSaving}
                          className="tl-button-quiet"
                          data-size="sm"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleToggleEnabled(model)}
                          disabled={isSaving}
                          className="tl-button-quiet"
                          data-size="sm"
                        >
                          {model.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleSetDefault(model)}
                          disabled={isSaving || !model.enabled || !providerIsEnabled || isDefault}
                          className="tl-button-quiet"
                          data-size="sm"
                        >
                          Set Default
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(model)}
                          disabled={isSaving}
                          className="tl-button-quiet"
                          data-size="sm"
                          data-tone="danger"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <ProvidersSection
        providers={settings.aiProviders}
        // A provider switched on or off changes which models can run - the
        // Status column above and Set Default follow the list it answers with.
        onProvidersChange={(next) => setSettings((current) => (current ? { ...current, aiProviders: next } : current))}
      />
    </div>
  );
}

/**
 * Administrator-only.
 *
 * This page changes things shared by everybody on the installation - the AI
 * providers, the prompts every account's resumes are built from, the shared
 * skill library - so it is not a per-user setting despite living behind a
 * "Settings" menu. `AdminOnly` explains that rather than rendering nothing: a
 * blank page reads as broken.
 */
export default function ModelsPage() {
  return (
    <AdminOnly>
      <ModelsPageBody />
    </AdminOnly>
  );
}
