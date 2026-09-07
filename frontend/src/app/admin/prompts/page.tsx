'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  adminApi,
  AIModelOption,
  AIProvider,
  getAIProviderLabel,
  promptsApi,
  PromptFeatureKey,
  PromptPreviewResult,
  PromptRecord,
  PromptResponseFormat,
  PromptSummary,
  PromptValidation,
  PromptVariableDefinition,
} from '@/lib/api';

type PromptDraft = {
  id?: string;
  name: string;
  description: string;
  featureKey?: PromptFeatureKey;
  featureLabel?: string;
  content: string;
  responseFormat: PromptResponseFormat;
  modelProvider?: AIProvider;
  modelName?: string;
  allowedVariables: PromptVariableDefinition[];
  isBuiltIn: boolean;
  isActiveForFeature?: boolean;
  usage?: string;
  createdAt?: string;
  updatedAt?: string;
};

type FeatureGroup = {
  key: PromptFeatureKey;
  label: string;
  prompts: PromptSummary[];
  activePrompt: PromptSummary | null;
};

const FEATURE_ORDER: PromptFeatureKey[] = [
  'analyze-job-description',
  'tailor-resume',
  'generate-cover-letter',
  'extract-template-from-pdf',
  'extract-profile-from-resume',
  'filter-google-sheet-job',
];

const PROFILE_SCOPED_FEATURES = new Set<PromptFeatureKey>([
  'analyze-job-description',
  'tailor-resume',
]);

function isProfileScopedFeature(featureKey?: PromptFeatureKey | null): boolean {
  return Boolean(featureKey && PROFILE_SCOPED_FEATURES.has(featureKey));
}

function emptyValidation(): PromptValidation {
  return {
    usedVariables: [],
    unknownVariables: [],
  };
}

function makeDraft(record: PromptRecord): PromptDraft {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    featureKey: record.featureKey,
    featureLabel: record.featureLabel,
    content: record.content,
    responseFormat: record.responseFormat,
    modelProvider: record.modelProvider,
    modelName: record.modelName,
    allowedVariables: record.allowedVariables.map((variable) => ({ ...variable })),
    isBuiltIn: record.isBuiltIn,
    isActiveForFeature: record.isActiveForFeature,
    usage: record.usage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function makeBlankDraftForFeature(group: FeatureGroup | null): PromptDraft {
  const template = group?.prompts[0];

  return {
    name: template?.featureLabel ? `${template.featureLabel} Variant` : '',
    description: '',
    featureKey: group?.key,
    featureLabel: group?.label,
    content: '',
    responseFormat: template?.responseFormat ?? 'json',
    modelProvider: undefined,
    modelName: undefined,
    allowedVariables: template?.allowedVariables.map((variable) => ({ ...variable })) ?? [],
    isBuiltIn: false,
    isActiveForFeature: false,
    usage: template?.usage,
  };
}

function makeDuplicateDraft(draft: PromptDraft): PromptDraft {
  return {
    ...draft,
    id: undefined,
    name: draft.name ? `${draft.name} Copy` : 'New Prompt',
    isBuiltIn: false,
    isActiveForFeature: false,
    createdAt: undefined,
    updatedAt: undefined,
  };
}

function formatDate(value?: string): string {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function getFeatureRank(featureKey: PromptFeatureKey): number {
  const index = FEATURE_ORDER.indexOf(featureKey);
  return index === -1 ? FEATURE_ORDER.length : index;
}

export default function PromptsPage() {
  const [prompts, setPrompts] = useState<PromptSummary[]>([]);
  const [modelOptions, setModelOptions] = useState<AIModelOption[]>([]);
  // Seeded empty rather than optimistically all-true: an all-true seed made
  // the model dropdown briefly offer models from providers the admin had
  // disabled, with no "(provider disabled)" suffix to say so.
  const [enabledProviders, setEnabledProviders] = useState<Record<AIProvider, boolean>>(
    () => ({}) as Record<AIProvider, boolean>
  );
  const [selectedFeatureKey, setSelectedFeatureKey] = useState<PromptFeatureKey | null>(null);
  const [activeCandidateId, setActiveCandidateId] = useState('');
  const [draft, setDraft] = useState<PromptDraft | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [validation, setValidation] = useState<PromptValidation>(emptyValidation());
  const [preview, setPreview] = useState<PromptPreviewResult | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [isLoadingList, setIsLoadingList] = useState(true);
  const [isLoadingPrompt, setIsLoadingPrompt] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);

  const featureGroups = useMemo<FeatureGroup[]>(() => {
    const groups = new Map<PromptFeatureKey, FeatureGroup>();

    for (const prompt of prompts) {
      if (!prompt.featureKey) continue;

      const existing = groups.get(prompt.featureKey);
      if (existing) {
        existing.prompts.push(prompt);
        if (prompt.isActiveForFeature && !isProfileScopedFeature(prompt.featureKey)) {
          existing.activePrompt = prompt;
        }
        continue;
      }

      groups.set(prompt.featureKey, {
        key: prompt.featureKey,
        label: prompt.featureLabel || prompt.featureKey,
        prompts: [prompt],
        activePrompt:
          prompt.isActiveForFeature && !isProfileScopedFeature(prompt.featureKey)
            ? prompt
            : null,
      });
    }

    return [...groups.values()]
      .map((group) => ({
        ...group,
        prompts: [...group.prompts].sort((left, right) => {
          if (
            !isProfileScopedFeature(group.key) &&
            (left.isActiveForFeature ? 0 : 1) !== (right.isActiveForFeature ? 0 : 1)
          ) {
            return (left.isActiveForFeature ? 0 : 1) - (right.isActiveForFeature ? 0 : 1);
          }
          if ((left.isBuiltIn ? 0 : 1) !== (right.isBuiltIn ? 0 : 1)) {
            return (left.isBuiltIn ? 0 : 1) - (right.isBuiltIn ? 0 : 1);
          }
          return left.name.localeCompare(right.name);
        }),
      }))
      .sort((left, right) => getFeatureRank(left.key) - getFeatureRank(right.key));
  }, [prompts]);

  const selectedFeatureGroup = useMemo(
    () => featureGroups.find((group) => group.key === selectedFeatureKey) ?? null,
    [featureGroups, selectedFeatureKey]
  );

  const openPrompt = useCallback(async (id: string) => {
    setIsLoadingPrompt(true);
    setError('');
    try {
      const record = await promptsApi.getById(id);
      setDraft(makeDraft(record));
      setSelectedId(record.id);
      setValidation(record.validation);
      setPreview(null);
      setIsDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load prompt');
    } finally {
      setIsLoadingPrompt(false);
    }
  }, []);

  const resetEditor = useCallback((group: FeatureGroup | null) => {
    setDraft(makeBlankDraftForFeature(group));
    setSelectedId(null);
    setValidation(emptyValidation());
    setPreview(null);
    setIsDirty(false);
  }, []);

  const refreshPrompts = useCallback(async (
    preferredFeatureKey?: PromptFeatureKey | null,
    preferredPromptId?: string | null
  ) => {
    setIsLoadingList(true);
    setError('');
    try {
      const data = await promptsApi.getAll();
      setPrompts(data);

      const nextFeatureKey =
        preferredFeatureKey && data.some((prompt) => prompt.featureKey === preferredFeatureKey)
          ? preferredFeatureKey
          : data.find((prompt) => prompt.featureKey)?.featureKey ?? null;

      setSelectedFeatureKey(nextFeatureKey);

      if (!nextFeatureKey) {
        resetEditor(null);
        setActiveCandidateId('');
        return;
      }

      const promptsForFeature = data.filter((prompt) => prompt.featureKey === nextFeatureKey);
      const activePrompt = isProfileScopedFeature(nextFeatureKey)
        ? promptsForFeature[0] ?? null
        : promptsForFeature.find((prompt) => prompt.isActiveForFeature) ?? promptsForFeature[0] ?? null;
      const nextPromptId =
        preferredPromptId && promptsForFeature.some((prompt) => prompt.id === preferredPromptId)
          ? preferredPromptId
          : activePrompt?.id ?? null;

      setActiveCandidateId(activePrompt?.id ?? '');

      if (nextPromptId) {
        await openPrompt(nextPromptId);
      } else {
        resetEditor({
          key: nextFeatureKey,
          label: promptsForFeature[0]?.featureLabel || nextFeatureKey,
          prompts: promptsForFeature,
          activePrompt,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load prompts');
    } finally {
      setIsLoadingList(false);
    }
  }, [openPrompt, resetEditor]);

  useEffect(() => {
    void refreshPrompts();
  }, [refreshPrompts]);

  useEffect(() => {
    let isMounted = true;

    const loadRuntimeConfig = async () => {
      try {
        const [options, settings] = await Promise.all([
          promptsApi.getModelOptions(),
          adminApi.getAIModels(),
        ]);

        if (!isMounted) return;

        setModelOptions(options);
        setEnabledProviders(settings.providersEnabled);
      } catch (err) {
        if (!isMounted) return;
        setError(err instanceof Error ? err.message : 'Failed to load prompt model options');
      }
    };

    void loadRuntimeConfig();

    return () => {
      isMounted = false;
    };
  }, []);

  const confirmDiscard = (): boolean => {
    if (!isDirty) return true;
    return window.confirm('Discard unsaved changes?');
  };

  const handleSelectFeature = async (featureKey: PromptFeatureKey) => {
    if (featureKey === selectedFeatureKey) return;
    if (!confirmDiscard()) return;

    const group = featureGroups.find((entry) => entry.key === featureKey) ?? null;
    setSelectedFeatureKey(featureKey);
    setStatus('');
    setError('');

    const activePrompt = isProfileScopedFeature(featureKey)
      ? group?.prompts[0] ?? null
      : group?.activePrompt ?? group?.prompts[0] ?? null;
    setActiveCandidateId(activePrompt?.id ?? '');

    if (activePrompt?.id) {
      await openPrompt(activePrompt.id);
    } else {
      resetEditor(group);
    }
  };

  const handleSelectPromptVariant = async (prompt: PromptSummary) => {
    if (prompt.id !== activeCandidateId) {
      setActiveCandidateId(prompt.id);
    }
    if (prompt.id === selectedId) return;
    if (!confirmDiscard()) return;
    await openPrompt(prompt.id);
  };

  const handleNewVariant = () => {
    if (!confirmDiscard()) return;
    resetEditor(selectedFeatureGroup);
    setStatus(`Creating a new prompt variant for ${selectedFeatureGroup?.label || 'this feature'}.`);
    setError('');
  };

  const handleDuplicate = () => {
    if (!draft) return;
    setDraft(makeDuplicateDraft(draft));
    setSelectedId(null);
    setValidation(emptyValidation());
    setPreview(null);
    setError('');
    setStatus('Duplicated into a new prompt variant draft.');
    setIsDirty(true);
  };

  const updateDraft = (updater: (current: PromptDraft) => PromptDraft) => {
    setDraft((current) => {
      if (!current) return current;
      return updater(current);
    });
    setIsDirty(true);
    setStatus('');
    setError('');
  };

  const handleValidate = async () => {
    if (!draft) return;
    setIsValidating(true);
    setError('');
    setStatus('');
    try {
      const nextValidation = await promptsApi.validateDraft({
        id: draft.id,
        content: draft.content,
        allowedVariables: draft.featureKey ? undefined : draft.allowedVariables,
      });
      setValidation(nextValidation);
      setStatus('Validation complete.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to validate prompt');
    } finally {
      setIsValidating(false);
    }
  };

  const handlePreview = async () => {
    if (!draft) return;
    setIsPreviewing(true);
    setError('');
    setStatus('');
    try {
      const nextPreview = await promptsApi.previewDraft({
        id: draft.id,
        content: draft.content,
        allowedVariables: draft.featureKey ? undefined : draft.allowedVariables,
      });
      setPreview(nextPreview);
      setValidation(nextPreview.validation);
      setStatus('Preview generated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to preview prompt');
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleSavePrompt = async () => {
    if (!draft) return;
    setIsSaving(true);
    setError('');
    setStatus('');
    try {
      const payload = {
        name: draft.name,
        description: draft.description,
        featureKey: draft.featureKey,
        content: draft.content,
        responseFormat: draft.responseFormat,
        modelProvider: draft.modelProvider,
        modelName: draft.modelName,
        allowedVariables: draft.allowedVariables,
      };

      const saved = draft.id
        ? await promptsApi.update(draft.id, payload)
        : await promptsApi.create(payload);

      await refreshPrompts((saved.featureKey ?? selectedFeatureKey) || null, saved.id);
      setPreview(null);
      setValidation(saved.validation);
      setStatus(draft.id ? 'Prompt variant updated.' : 'Prompt variant created.');
      setIsDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save prompt');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveSelectedPrompt = async () => {
    if (!selectedFeatureGroup || !activeCandidateId) return;
    if (isProfileScopedFeature(selectedFeatureGroup.key)) return;
    setError('');
    setStatus('');
    try {
      const targetPrompt = selectedFeatureGroup.prompts.find((prompt) => prompt.id === activeCandidateId);
      await promptsApi.activate(activeCandidateId);
      await refreshPrompts(selectedFeatureGroup.key, activeCandidateId);
      setStatus(`Saved "${targetPrompt?.name || activeCandidateId}" as the active prompt for ${selectedFeatureGroup.label}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save active prompt selection');
    }
  };

  const handleDelete = async () => {
    if (!draft?.id || draft.isBuiltIn) return;
    if (!window.confirm(`Delete "${draft.name}"?`)) return;

    setError('');
    setStatus('');
    try {
      await promptsApi.delete(draft.id);
      await refreshPrompts(draft.featureKey ?? selectedFeatureKey ?? null);
      setStatus('Prompt deleted.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete prompt');
    }
  };

  const addVariable = () => {
    updateDraft((current) => ({
      ...current,
      allowedVariables: [
        ...current.allowedVariables,
        { name: '', description: '', sampleValue: '' },
      ],
    }));
  };

  const updateVariable = (
    index: number,
    field: keyof PromptVariableDefinition,
    value: string
  ) => {
    updateDraft((current) => ({
      ...current,
      allowedVariables: current.allowedVariables.map((variable, variableIndex) =>
        variableIndex === index ? { ...variable, [field]: value } : variable
      ),
    }));
  };

  const removeVariable = (index: number) => {
    updateDraft((current) => ({
      ...current,
      allowedVariables: current.allowedVariables.filter((_, variableIndex) => variableIndex !== index),
    }));
  };

  const selectedModelOptionId =
    draft?.modelProvider && draft.modelName
      ? (
          modelOptions.find(
            (option) =>
              option.provider === draft.modelProvider && option.modelName === draft.modelName
          )?.id ?? ''
        )
      : '';

  const selectedFeatureHasPendingChange =
    !!selectedFeatureGroup &&
    !isProfileScopedFeature(selectedFeatureGroup.key) &&
    !!selectedFeatureGroup.activePrompt &&
    selectedFeatureGroup.activePrompt.id !== activeCandidateId;

  if (isLoadingList && !draft && featureGroups.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Prompt Library</h1>
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

      <div className="grid gap-6 xl:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
            <h2 className="font-semibold text-gray-900">Features</h2>
            {isLoadingList && <span className="text-xs text-gray-500">Refreshing...</span>}
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            {featureGroups.map((group) => (
              <button
                key={group.key}
                onClick={() => void handleSelectFeature(group.key)}
                className={`w-full border-b border-gray-100 px-4 py-3 text-left hover:bg-gray-50 ${
                  selectedFeatureKey === group.key ? 'bg-blue-50' : ''
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="truncate font-medium text-gray-900">{group.label}</div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                      {group.prompts.length}
                    </span>
                    {group.activePrompt && <span className="h-2 w-2 rounded-full bg-emerald-500"></span>}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <section className="space-y-6">
          <section className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-4">
              <h2 className="font-semibold text-gray-900">
                {selectedFeatureGroup ? selectedFeatureGroup.label : 'Prompt List'}
              </h2>
              {selectedFeatureGroup && (
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={handleNewVariant}
                    className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
                  >
                    New Variant
                  </button>
                  <button
                    onClick={handleDuplicate}
                    disabled={!draft}
                    className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                  >
                    Duplicate
                  </button>
                  <button
                    onClick={() => void refreshPrompts(selectedFeatureGroup.key, selectedId)}
                    className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Reload
                  </button>
                  {!isProfileScopedFeature(selectedFeatureGroup.key) && (
                    <button
                      type="button"
                      onClick={() => void handleSaveSelectedPrompt()}
                      disabled={!activeCandidateId || !selectedFeatureHasPendingChange}
                      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-300"
                    >
                      Save Active
                    </button>
                  )}
                </div>
              )}
            </div>

            {!selectedFeatureGroup ? (
              <div className="p-6 text-sm text-gray-500">No feature selected.</div>
            ) : (
              <div className="space-y-3 p-4">
                {selectedFeatureGroup.prompts.map((prompt) => (
                  <label
                    key={prompt.id}
                    className={`block cursor-pointer rounded-xl border p-4 transition ${
                      activeCandidateId === prompt.id
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="radio"
                        name={`active-prompt-${selectedFeatureGroup.key}`}
                        checked={activeCandidateId === prompt.id}
                        onChange={() => void handleSelectPromptVariant(prompt)}
                        className="mt-1"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="font-medium text-gray-900">{prompt.name}</div>
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              prompt.isBuiltIn
                                ? 'bg-blue-100 text-blue-700'
                                : 'bg-gray-100 text-gray-700'
                            }`}
                          >
                            {prompt.isBuiltIn ? 'Built-in' : 'Custom'}
                          </span>
                          {prompt.isActiveForFeature && !isProfileScopedFeature(prompt.featureKey) && (
                            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                              Live
                            </span>
                          )}
                        </div>
                        {prompt.description && (
                          <div className="mt-1 text-sm text-gray-600">{prompt.description}</div>
                        )}
                        {prompt.modelProvider && prompt.modelName && (
                          <div className="mt-2 text-xs text-gray-500">
                            {getAIProviderLabel(prompt.modelProvider)} / {prompt.modelName}
                          </div>
                        )}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-gray-200 bg-white">
            {!draft ? (
              <div className="p-8 text-sm text-gray-500">Select a prompt variant.</div>
            ) : (
              <div className="space-y-6 p-6">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-xl font-semibold text-gray-900">
                      {draft.id ? draft.name : 'New Prompt Variant'}
                    </h2>
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                        draft.isBuiltIn
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {draft.isBuiltIn ? 'Built-in' : 'Custom'}
                    </span>
                    <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700">
                      {draft.responseFormat.toUpperCase()}
                    </span>
                    {draft.isActiveForFeature && !isProfileScopedFeature(draft.featureKey) && (
                      <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700">
                        Live
                      </span>
                    )}
                    {isDirty && (
                      <span className="rounded-full bg-orange-100 px-2.5 py-1 text-xs font-medium text-orange-700">
                        Unsaved
                      </span>
                    )}
                  </div>
                  <div className="mt-2 text-xs text-gray-500">
                    {draft.id ? `ID: ${draft.id}` : 'ID will be generated on save'}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={handleValidate}
                    disabled={isValidating || isSaving || isLoadingPrompt}
                    className="rounded-lg border border-gray-300 bg-white px-4 py-2 font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {isValidating ? 'Validating...' : 'Validate'}
                  </button>
                  <button
                    onClick={handlePreview}
                    disabled={isPreviewing || isSaving || isLoadingPrompt}
                    className="rounded-lg border border-gray-300 bg-white px-4 py-2 font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {isPreviewing ? 'Previewing...' : 'Preview'}
                  </button>
                  <button
                    onClick={handleSavePrompt}
                    disabled={isSaving || isLoadingPrompt}
                    className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {isSaving ? 'Saving...' : 'Save Prompt'}
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={!draft.id || draft.isBuiltIn || isSaving}
                    className="rounded-lg bg-red-600 px-4 py-2 font-medium text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {isLoadingPrompt && (
                <div className="text-sm text-gray-500">Loading prompt...</div>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Name</label>
                  <input
                    type="text"
                    value={draft.name}
                    disabled={draft.isBuiltIn}
                    onChange={(event) =>
                      updateDraft((current) => ({ ...current, name: event.target.value }))
                    }
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 disabled:bg-gray-100"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Feature</label>
                  <input
                    type="text"
                    value={draft.featureLabel || draft.featureKey || 'No feature assigned'}
                    disabled
                    className="w-full rounded-lg border border-gray-300 bg-gray-100 px-3 py-2"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Runtime Model</label>
                <select
                  value={selectedModelOptionId}
                  onChange={(event) => {
                    const nextId = event.target.value;
                    const nextOption = modelOptions.find((option) => option.id === nextId) ?? null;
                    updateDraft((current) => ({
                      ...current,
                      modelProvider: nextOption?.provider,
                      modelName: nextOption?.modelName,
                    }));
                  }}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2"
                >
                  <option value="">Use runtime default</option>
                  {modelOptions.map((option) => (
                    <option
                      key={option.id}
                      value={option.id}
                      disabled={!enabledProviders[option.provider]}
                    >
                      {option.label}{!enabledProviders[option.provider] ? ' (provider disabled)' : ''}
                    </option>
                  ))}
                </select>
                {draft.modelProvider && draft.modelName && (
                  <p className="mt-1 text-xs text-gray-500">
                    Saved override: {getAIProviderLabel(draft.modelProvider)} / {draft.modelName}
                  </p>
                )}
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
                <input
                  type="text"
                  value={draft.description}
                  disabled={draft.isBuiltIn}
                  onChange={(event) =>
                    updateDraft((current) => ({ ...current, description: event.target.value }))
                  }
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 disabled:bg-gray-100"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-900">Prompt Content</h3>
                  <div className="text-xs text-gray-500">
                    Created: {formatDate(draft.createdAt)} | Updated: {formatDate(draft.updatedAt)}
                  </div>
                </div>
                <textarea
                  value={draft.content}
                  onChange={(event) =>
                    updateDraft((current) => ({ ...current, content: event.target.value }))
                  }
                  className="min-h-[720px] w-full rounded-xl border border-gray-300 px-4 py-3 font-mono text-sm"
                  spellCheck={false}
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-900">Variables</h3>
                  {!draft.featureKey && !draft.isBuiltIn && (
                    <button
                      onClick={addVariable}
                      className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                    >
                      Add Variable
                    </button>
                  )}
                </div>

                {draft.allowedVariables.length === 0 && (
                  <div className="rounded-lg border border-dashed border-gray-300 px-4 py-3 text-sm text-gray-500">
                    No variables defined.
                  </div>
                )}

                <div className="space-y-3">
                  {draft.allowedVariables.map((variable, index) => (
                    <div key={`${variable.name}-${index}`} className="rounded-lg border border-gray-200 p-4">
                      {draft.featureKey || draft.isBuiltIn ? (
                        <div className="space-y-2">
                          <div className="font-mono text-sm text-gray-900">{variable.name}</div>
                          {variable.description && (
                            <div className="text-sm text-gray-600">{variable.description}</div>
                          )}
                          {variable.sampleValue && (
                            <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600 whitespace-pre-wrap">
                              {variable.sampleValue}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="grid gap-3 md:grid-cols-[180px_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-start">
                          <input
                            type="text"
                            value={variable.name}
                            onChange={(event) => updateVariable(index, 'name', event.target.value)}
                            placeholder="variableName"
                            className="rounded-lg border border-gray-300 px-3 py-2"
                          />
                          <input
                            type="text"
                            value={variable.description ?? ''}
                            onChange={(event) => updateVariable(index, 'description', event.target.value)}
                            placeholder="Description"
                            className="rounded-lg border border-gray-300 px-3 py-2"
                          />
                          <input
                            type="text"
                            value={variable.sampleValue ?? ''}
                            onChange={(event) => updateVariable(index, 'sampleValue', event.target.value)}
                            placeholder="Sample value for preview"
                            className="rounded-lg border border-gray-300 px-3 py-2"
                          />
                          <button
                            onClick={() => removeVariable(index)}
                            className="rounded-lg bg-red-50 px-3 py-2 text-red-700 hover:bg-red-100"
                          >
                            Remove
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid gap-4 xl:grid-cols-2">
                <div className="space-y-3 rounded-xl border border-gray-200 p-4">
                  <h3 className="text-sm font-semibold text-gray-900">Validation</h3>
                  <div>
                    <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">Used Variables</div>
                    <div className="flex flex-wrap gap-2">
                      {validation.usedVariables.length === 0 ? (
                        <span className="text-sm text-gray-500">No placeholders detected.</span>
                      ) : (
                        validation.usedVariables.map((name) => (
                          <span key={name} className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
                            {name}
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">Unknown Variables</div>
                    <div className="flex flex-wrap gap-2">
                      {validation.unknownVariables.length === 0 ? (
                        <span className="text-sm text-emerald-700">None.</span>
                      ) : (
                        validation.unknownVariables.map((name) => (
                          <span key={name} className="rounded-full bg-red-100 px-2.5 py-1 text-xs font-medium text-red-700">
                            {name}
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                <div className="space-y-3 rounded-xl border border-gray-200 p-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-900">Preview</h3>
                    {preview && (
                      <span className="text-xs text-gray-500">
                        {Object.keys(preview.sampleValues).length} sample values injected
                      </span>
                    )}
                  </div>
                  <div className="min-h-[220px] overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700 whitespace-pre-wrap">
                    {preview?.renderedContent ?? 'Run Preview to render this prompt with sample values.'}
                  </div>
                </div>
              </div>
              </div>
            )}
          </section>
        </section>
      </div>
    </div>
  );
}
