'use client';

import { useEffect, useState } from 'react';
import { AdminOnly } from '@/components/auth/AuthGate';
import {
  adminApi,
  AdminAppSettings,
  AI_PROVIDERS,
  AIModelRecord,
  AIProvider,
  coerceProvider,
  getAIProviderLabel,
  isProviderLocked,
  isProviderOffered,
  LOCK_ICON,
  PROVIDER_META,
} from '@/lib/api';
import { Field, Notice, Pill, Section, Spinner } from '@/components/ui/kit';

type ModelDraft = {
  name: string;
  provider: AIProvider;
  modelName: string;
  description: string;
  enabled: boolean;
};

const EMPTY_DRAFT: ModelDraft = {
  name: '',
  // The keyless subscription provider is the sensible default to add to.
  provider: 'claude-cli',
  modelName: '',
  description: '',
  enabled: true,
};

function lockReason(settings: AdminAppSettings, provider: AIProvider): string {
  return settings.providerLocks.find((lock) => lock.id === provider)?.reason ?? '';
}

function toDraft(model: AIModelRecord): ModelDraft {
  return {
    name: model.name,
    provider: model.provider,
    modelName: model.modelName,
    description: model.description,
    enabled: model.enabled,
  };
}

function ModelsPageBody() {
  const [settings, setSettings] = useState<AdminAppSettings | null>(null);
  const [draft, setDraft] = useState<ModelDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    void loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setIsLoading(true);
      setError('');
      setSettings(await adminApi.getSettings());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load models');
    } finally {
      setIsLoading(false);
    }
  };

  const resetDraft = () => {
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
  };

  const handleSubmit = async () => {
    const name = draft.name.trim();
    const modelName = draft.modelName.trim();

    if (!name) {
      setError('Display name is required.');
      return;
    }

    if (!modelName) {
      setError('Provider model name is required.');
      return;
    }

    try {
      setIsSaving(true);
      setError('');
      setStatus('');
      const updated = editingId
        ? await adminApi.updateModel(editingId, {
            name,
            provider: draft.provider,
            modelName,
            description: draft.description.trim(),
            enabled: draft.enabled,
          })
        : await adminApi.createModel({
            name,
            provider: draft.provider,
            modelName,
            description: draft.description.trim(),
            enabled: draft.enabled,
          });
      setSettings(updated);
      setStatus(editingId ? 'Model updated.' : 'Model created.');
      resetDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save model');
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
        resetDraft();
      }
      setStatus('Model deleted.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete model');
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleEnabled = async (model: AIModelRecord) => {
    try {
      setIsSaving(true);
      setError('');
      setStatus('');
      const updated = await adminApi.updateModel(model.id, { enabled: !model.enabled });
      setSettings(updated);
      if (editingId === model.id) {
        setDraft((current) => ({ ...current, enabled: !model.enabled }));
      }
      setStatus(`${model.name} ${model.enabled ? 'disabled' : 'enabled'}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update model');
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
      setError(err instanceof Error ? err.message : 'Failed to update default model');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading || !settings) {
    return <Spinner />;
  }

  const providerEnabled = settings.providersEnabled;

  return (
    <div>
      <header>
        <h2 className="text-2xl font-bold tracking-tight text-ink">Models</h2>
        <p className="mt-1 text-sm text-muted">
          Manage the runtime model library used by Resume Builder and prompt overrides.
        </p>
      </header>

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
        description="Save a provider, display name, and exact runtime model string."
        actions={
          editingId && (
            <button type="button" onClick={resetDraft} disabled={isSaving} className="tl-button-quiet">
              Cancel Edit
            </button>
          )
        }
      >
        <div className="grid gap-6 md:grid-cols-2">
          <Field label="Display name" htmlFor="model-display-name">
            <input
              id="model-display-name"
              type="text"
              value={draft.name}
              onChange={(e) => setDraft((current) => ({ ...current, name: e.target.value }))}
              disabled={isSaving}
              placeholder="GPT-5 mini"
              className="tl-input"
            />
          </Field>

          <Field label="Provider" htmlFor="model-provider">
            <select
              id="model-provider"
              value={draft.provider}
              onChange={(e) =>
                setDraft((current) => ({
                  ...current,
                  provider: coerceProvider(e.target.value) ?? current.provider,
                }))
              }
              disabled={isSaving}
              className="tl-input"
            >
              {AI_PROVIDERS.map((provider) => (
                // Still offered, not removed: a model row for a locked
                // provider is worth writing down now so it is simply there if
                // the lock is ever lifted.
                <option key={provider} value={provider}>
                  {isProviderLocked(settings, provider)
                    ? `${LOCK_ICON} ${getAIProviderLabel(provider)} (locked)`
                    : getAIProviderLabel(provider)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Model name" htmlFor="model-runtime-name">
            <input
              id="model-runtime-name"
              type="text"
              value={draft.modelName}
              onChange={(e) => setDraft((current) => ({ ...current, modelName: e.target.value }))}
              disabled={isSaving}
              placeholder={PROVIDER_META[draft.provider]?.modelNameHint ?? 'model name'}
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
              placeholder="Fast structured extraction model"
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

                return (
                  <tr key={model.id}>
                    <td className="min-w-[16rem]">
                      {/* Colours on inner elements: `.tl-table td` is unlayered
                          and would beat a utility on the cell itself. */}
                      <p className="font-semibold text-ink">{model.name}</p>
                      <p className="mt-0.5 break-all font-mono text-xs text-ink">{model.modelName}</p>
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
                      </div>
                    </td>
                    {/* The column says "Updated", so the cell is the date alone. */}
                    <td className="whitespace-nowrap text-xs">{new Date(model.updatedAt).toLocaleString()}</td>
                    <td>
                      <div className="flex justify-end gap-2">
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
