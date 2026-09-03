'use client';

import { useEffect, useState } from 'react';
import { adminApi, AdminAppSettings, AIModelRecord, AIProvider, getAIProviderLabel } from '@/lib/api';

type ModelDraft = {
  name: string;
  provider: AIProvider;
  modelName: string;
  description: string;
  enabled: boolean;
};

const EMPTY_DRAFT: ModelDraft = {
  name: '',
  provider: 'deepseek',
  modelName: '',
  description: '',
  enabled: true,
};

function toDraft(model: AIModelRecord): ModelDraft {
  return {
    name: model.name,
    provider: model.provider,
    modelName: model.modelName,
    description: model.description,
    enabled: model.enabled,
  };
}

export default function ModelsPage() {
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
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-blue-600" />
      </div>
    );
  }

  const providerEnabled = {
    openai: settings.openaiEnabled,
    claude: settings.claudeEnabled,
    openrouter: settings.openrouterEnabled,
    deepseek: settings.deepseekEnabled,
  } satisfies Record<AIProvider, boolean>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Models</h1>
        <p className="mt-2 text-sm text-gray-600">
          Manage the runtime model library used by Resume Builder and prompt overrides.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {status && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {status}
        </div>
      )}

      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              {editingId ? 'Edit Model' : 'Add Model'}
            </h2>
            <p className="text-sm text-gray-600">
              Save a provider, display name, and exact runtime model string.
            </p>
          </div>
          {editingId && (
            <button
              type="button"
              onClick={resetDraft}
              disabled={isSaving}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel Edit
            </button>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700">Display name</label>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft((current) => ({ ...current, name: e.target.value }))}
              disabled={isSaving}
              placeholder="GPT-5 mini"
              className="w-full rounded-lg border border-gray-300 px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700">Provider</label>
            <select
              value={draft.provider}
              onChange={(e) =>
                setDraft((current) => ({ ...current, provider: e.target.value as AIProvider }))
              }
              disabled={isSaving}
              className="w-full rounded-lg border border-gray-300 px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="openai">OpenAI</option>
              <option value="claude">Claude</option>
              <option value="openrouter">OpenRouter</option>
              <option value="deepseek">DeepSeek</option>
            </select>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700">Model name</label>
            <input
              type="text"
              value={draft.modelName}
              onChange={(e) => setDraft((current) => ({ ...current, modelName: e.target.value }))}
              disabled={isSaving}
              placeholder="gpt-5-mini, claude-sonnet-4, or deepseek-v4-flash"
              className="w-full rounded-lg border border-gray-300 px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700">Description</label>
            <input
              type="text"
              value={draft.description}
              onChange={(e) => setDraft((current) => ({ ...current, description: e.target.value }))}
              disabled={isSaving}
              placeholder="Fast structured extraction model"
              className="w-full rounded-lg border border-gray-300 px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <label className="mt-4 flex items-center gap-3 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft((current) => ({ ...current, enabled: e.target.checked }))}
            disabled={isSaving}
          />
          Enable this model immediately
        </label>

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={isSaving}
            className="rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-400"
          >
            {isSaving ? 'Saving...' : editingId ? 'Save Model' : 'Create Model'}
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">Model Library</h2>
        </div>

        <div className="divide-y divide-gray-200">
          {settings.aiModels.map((model) => {
            const isDefault = settings.defaultModelId === model.id;
            const providerIsEnabled = providerEnabled[model.provider];

            return (
              <div key={model.id} className="flex flex-col gap-4 px-6 py-5 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-base font-semibold text-gray-900">{model.name}</div>
                    <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
                      {getAIProviderLabel(model.provider)}
                    </span>
                    {isDefault && (
                      <span className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-700">
                        Default
                      </span>
                    )}
                    {!model.enabled && (
                      <span className="rounded-full bg-red-100 px-2.5 py-1 text-xs font-medium text-red-700">
                        Disabled
                      </span>
                    )}
                    {model.enabled && !providerIsEnabled && (
                      <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700">
                        Provider off
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-gray-800">{model.modelName}</div>
                  <div className="text-sm text-gray-600">
                    {model.description || 'No description provided.'}
                  </div>
                  <div className="text-xs text-gray-500">
                    Updated {new Date(model.updatedAt).toLocaleString()}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => handleEdit(model)}
                    disabled={isSaving}
                    className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleToggleEnabled(model)}
                    disabled={isSaving}
                    className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    {model.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSetDefault(model)}
                    disabled={isSaving || !model.enabled || !providerIsEnabled || isDefault}
                    className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-300"
                  >
                    Set Default
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(model)}
                    disabled={isSaving}
                    className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:bg-red-300"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
