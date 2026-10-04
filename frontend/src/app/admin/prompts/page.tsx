'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AdminOnly } from '@/components/auth/AuthGate';
import {
  type PromptCategoryId,
  adminApi,
  AIModelOption,
  AIProvider,
  DEFAULT_PUBLIC_APP_SETTINGS,
  getAIProviderLabel,
  isProviderOffered,
  promptsApi,
  PromptFeatureKey,
  PromptPreviewResult,
  PromptRecord,
  PromptResponseFormat,
  PromptSummary,
  PromptValidation,
  PromptVariableDefinition,
  PublicAppSettings,
} from '@/lib/api';
import { formatDate } from '@/lib/format';
import { Field, Notice, Pill, Spinner, StaticValue } from '@/components/ui/kit';

import styles from './prompts.module.css';

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
  category: PromptCategoryId;
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

/**
 * The two kinds of prompt, in the order the app runs them.
 *
 * Extracting turns source material into structured data; building turns that
 * data into what the user receives. The server sends each prompt's category and
 * its label, so this list decides the ORDER of the headings and nothing else -
 * a category the server adds appears without a change here.
 */
const CATEGORY_ORDER: PromptCategoryId[] = ['extracting', 'building', 'other'];

function categoryRank(category: PromptCategoryId): number {
  const index = CATEGORY_ORDER.indexOf(category);
  return index === -1 ? CATEGORY_ORDER.length : index;
}

function getFeatureRank(featureKey: PromptFeatureKey): number {
  const index = FEATURE_ORDER.indexOf(featureKey);
  return index === -1 ? FEATURE_ORDER.length : index;
}

function PromptsPageBody() {
  const [prompts, setPrompts] = useState<PromptSummary[]>([]);
  const [modelOptions, setModelOptions] = useState<AIModelOption[]>([]);
  // Seeded empty rather than optimistically all-true: an all-true seed made
  // the model dropdown briefly offer models from providers the admin had
  // disabled, with no "(provider disabled)" suffix to say so.
  const [enabledProviders, setEnabledProviders] = useState<Record<AIProvider, boolean>>(
    () => ({}) as Record<AIProvider, boolean>
  );
  /*
   * The locks and the browser-mode flag, kept so the disabled check below can be
   * the SHARED rule rather than a private copy of half of it.
   *
   * This page was safe only by accident: the option list arrives already
   * filtered server-side, so its own predicate never had to be right. That is a
   * fragile reason to be correct, and it is one release from being wrong.
   */
  const [offerSettings, setOfferSettings] = useState<
    Pick<PublicAppSettings, 'providerLocks' | 'browserChatEnabled'>
  >(() => ({
    providerLocks: DEFAULT_PUBLIC_APP_SETTINGS.providerLocks,
    browserChatEnabled: DEFAULT_PUBLIC_APP_SETTINGS.browserChatEnabled,
  }));
  const providerOffered = (provider: AIProvider): boolean =>
    isProviderOffered(offerSettings, provider, enabledProviders);
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
        category: prompt.category,
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
      .sort((left, right) => {
        // Category first, so the headings below are contiguous; the existing
        // feature order still decides within each one.
        const byCategory = categoryRank(left.category) - categoryRank(right.category);
        return byCategory !== 0 ? byCategory : getFeatureRank(left.key) - getFeatureRank(right.key);
      });
  }, [prompts]);

  /**
   * The sidebar's sections, each a category with the features under it.
   *
   * Derived from the sorted list rather than grouped again from `prompts`, so
   * the order inside a section is exactly the order above and cannot drift.
   */
  const featureSections = useMemo(() => {
    const sections: Array<{ category: PromptCategoryId; label: string; groups: FeatureGroup[] }> = [];
    for (const group of featureGroups) {
      const last = sections[sections.length - 1];
      if (last?.category === group.category) {
        last.groups.push(group);
        continue;
      }
      const label =
        prompts.find((prompt) => prompt.category === group.category)?.categoryLabel ?? group.category;
      sections.push({ category: group.category, label, groups: [group] });
    }
    return sections;
  }, [featureGroups, prompts]);

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
          category: promptsForFeature[0]?.category ?? 'other',
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
        setOfferSettings({
          providerLocks: settings.providerLocks,
          browserChatEnabled: settings.browserChatEnabled,
        });
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
    return <Spinner label="Loading prompts..." />;
  }

  return (
    <div className="space-y-6 pb-8">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-ink">Prompt Library</h2>
        <p className="mt-1 text-sm text-muted">
          The prompt every feature sends to the model. Pick a feature to edit its variants, preview them, and choose the live one.
        </p>
      </div>

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

      <div className="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="tl-card self-start overflow-hidden lg:sticky lg:top-24">
          <div className="tl-card-header">
            <h3 className="text-base font-semibold text-ink">Prompts</h3>
            {isLoadingList && <span className="text-xs text-subtle">Refreshing...</span>}
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            {featureSections.map((section) => (
              <div key={section.category} className={styles.section}>
                <h4 className={styles.group}>{section.label}</h4>
                {section.groups.map((group) => (
                  <button
                    key={group.key}
                    onClick={() => void handleSelectFeature(group.key)}
                    className={styles.item}
                    data-active={selectedFeatureKey === group.key}
                    aria-current={selectedFeatureKey === group.key ? 'true' : undefined}
                  >
                    <span className="min-w-0 truncate">{group.label}</span>
                    <span className="flex flex-none items-center gap-2">
                      <Pill>{group.prompts.length}</Pill>
                      {group.activePrompt && <span className={styles.live}></span>}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </aside>

        <section className="min-w-0 space-y-6">
          <section className="tl-card">
            <div className="tl-card-header">
              <h3 className="text-base font-semibold text-ink">
                {selectedFeatureGroup ? selectedFeatureGroup.label : 'Prompt List'}
              </h3>
              {selectedFeatureGroup && (
                <div className="flex flex-wrap gap-2">
                  <button onClick={handleNewVariant} className="tl-button-quiet" data-size="sm">
                    New Variant
                  </button>
                  <button onClick={handleDuplicate} disabled={!draft} className="tl-button-quiet" data-size="sm">
                    Duplicate
                  </button>
                  <button
                    onClick={() => void refreshPrompts(selectedFeatureGroup.key, selectedId)}
                    className="tl-button-quiet"
                    data-size="sm"
                  >
                    Reload
                  </button>
                  {!isProfileScopedFeature(selectedFeatureGroup.key) && (
                    <button
                      type="button"
                      onClick={() => void handleSaveSelectedPrompt()}
                      disabled={!activeCandidateId || !selectedFeatureHasPendingChange}
                      className="tl-button"
                      data-size="sm"
                    >
                      Save Active
                    </button>
                  )}
                </div>
              )}
            </div>

            {!selectedFeatureGroup ? (
              <div className="p-5 text-sm text-muted">No feature selected.</div>
            ) : (
              <div className="space-y-3 p-5">
                {selectedFeatureGroup.prompts.map((prompt) => (
                  <label
                    key={prompt.id}
                    className="tl-choice"
                    data-on={activeCandidateId === prompt.id}
                  >
                    <input
                      type="radio"
                      name={`active-prompt-${selectedFeatureGroup.key}`}
                      checked={activeCandidateId === prompt.id}
                      onChange={() => void handleSelectPromptVariant(prompt)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="font-medium text-ink">{prompt.name}</div>
                        <Pill tone={prompt.isBuiltIn ? 'sky' : 'grey'}>
                          {prompt.isBuiltIn ? 'Built-in' : 'Custom'}
                        </Pill>
                        {prompt.isActiveForFeature && !isProfileScopedFeature(prompt.featureKey) && (
                          <Pill tone="green">Live</Pill>
                        )}
                      </div>
                      {prompt.description && (
                        <div className="mt-1 text-sm text-muted">{prompt.description}</div>
                      )}
                      {prompt.modelProvider && prompt.modelName && (
                        <div className="mt-2 text-xs text-subtle">
                          {getAIProviderLabel(prompt.modelProvider)} / {prompt.modelName}
                        </div>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            )}
          </section>

          {!draft ? (
            <section className="tl-card p-8 text-sm text-muted">Select a prompt variant.</section>
          ) : (
            <>
              <section className="tl-card">
                <div className="tl-card-header">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-lg font-semibold text-ink">
                        {draft.id ? draft.name : 'New Prompt Variant'}
                      </h3>
                      <Pill tone={draft.isBuiltIn ? 'sky' : 'grey'}>
                        {draft.isBuiltIn ? 'Built-in' : 'Custom'}
                      </Pill>
                      <Pill tone="violet">{draft.responseFormat.toUpperCase()}</Pill>
                      {draft.isActiveForFeature && !isProfileScopedFeature(draft.featureKey) && (
                        <Pill tone="green">Live</Pill>
                      )}
                      {isDirty && <Pill tone="amber">Unsaved</Pill>}
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-subtle">
                      {draft.id ? `ID: ${draft.id}` : 'ID will be generated on save'}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={handleValidate}
                      disabled={isValidating || isSaving || isLoadingPrompt}
                      className="tl-button-quiet"
                    >
                      {isValidating ? 'Validating...' : 'Validate'}
                    </button>
                    <button
                      onClick={handlePreview}
                      disabled={isPreviewing || isSaving || isLoadingPrompt}
                      className="tl-button-quiet"
                    >
                      {isPreviewing ? 'Previewing...' : 'Preview'}
                    </button>
                    <button
                      onClick={handleSavePrompt}
                      disabled={isSaving || isLoadingPrompt}
                      className="tl-button"
                    >
                      {isSaving ? 'Saving...' : 'Save Prompt'}
                    </button>
                    <button
                      onClick={handleDelete}
                      disabled={!draft.id || draft.isBuiltIn || isSaving}
                      className="tl-button-quiet"
                      data-tone="danger"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                <div className="space-y-6 p-5">
                  {isLoadingPrompt && (
                    <div className="flex items-center gap-3 text-sm text-muted" role="status">
                      <span className="tl-spinner" aria-hidden />
                      Loading prompt...
                    </div>
                  )}

                  <div className="grid gap-6 md:grid-cols-2">
                    <Field label="Name" htmlFor="prompt-name">
                      <input
                        id="prompt-name"
                        type="text"
                        value={draft.name}
                        disabled={draft.isBuiltIn}
                        onChange={(event) =>
                          updateDraft((current) => ({ ...current, name: event.target.value }))
                        }
                        className={`tl-input ${styles.locked}`}
                      />
                    </Field>
                    <Field label="Feature">
                      <StaticValue>{draft.featureLabel || draft.featureKey || 'No feature assigned'}</StaticValue>
                    </Field>
                  </div>

                  <Field
                    label="Runtime Model"
                    htmlFor="prompt-model"
                    hint={
                      draft.modelProvider && draft.modelName
                        ? `Saved override: ${getAIProviderLabel(draft.modelProvider)} / ${draft.modelName}`
                        : undefined
                    }
                  >
                    <select
                      id="prompt-model"
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
                      className="tl-input"
                    >
                      <option value="">Use runtime default</option>
                      {modelOptions.map((option) => (
                        <option
                          key={option.id}
                          value={option.id}
                          disabled={!providerOffered(option.provider)}
                        >
                          {option.label}{!providerOffered(option.provider) ? ' (provider disabled)' : ''}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <Field label="Description" htmlFor="prompt-description">
                    <input
                      id="prompt-description"
                      type="text"
                      value={draft.description}
                      disabled={draft.isBuiltIn}
                      onChange={(event) =>
                        updateDraft((current) => ({ ...current, description: event.target.value }))
                      }
                      className={`tl-input ${styles.locked}`}
                    />
                  </Field>

                  <div>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <label htmlFor="prompt-content" className="tl-label">
                        Prompt Content
                      </label>
                      <div className="text-xs text-subtle">
                        Created: {formatDate(draft.createdAt, { empty: '-' })} | Updated: {formatDate(draft.updatedAt, { empty: '-' })}
                      </div>
                    </div>
                    <textarea
                      id="prompt-content"
                      value={draft.content}
                      onChange={(event) =>
                        updateDraft((current) => ({ ...current, content: event.target.value }))
                      }
                      className="tl-input mt-2 font-mono"
                      // Inline because `textarea.tl-input` is unlayered CSS and
                      // outranks any min-height or text-size utility.
                      style={{ minHeight: '720px', fontSize: '0.8125rem', lineHeight: 1.6 }}
                      spellCheck={false}
                    />
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <h4 className="tl-label">Variables</h4>
                      {!draft.featureKey && !draft.isBuiltIn && (
                        <button onClick={addVariable} className="tl-button-quiet" data-size="sm">
                          Add Variable
                        </button>
                      )}
                    </div>

                    {draft.allowedVariables.length === 0 && (
                      <Notice tone="neutral">No variables defined.</Notice>
                    )}

                    {draft.allowedVariables.length > 0 && (
                      <div className="tl-rows">
                        {draft.allowedVariables.map((variable, index) => (
                          <div key={`${variable.name}-${index}`} className="p-4">
                            {draft.featureKey || draft.isBuiltIn ? (
                              <div className="space-y-2">
                                <div className="font-mono text-sm font-medium text-ink">{variable.name}</div>
                                {variable.description && (
                                  <div className="text-sm text-muted">{variable.description}</div>
                                )}
                                {variable.sampleValue && (
                                  <div className="whitespace-pre-wrap rounded-md bg-surface-muted p-3 text-xs text-muted">
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
                                  aria-label="Variable name"
                                  className="tl-input font-mono"
                                />
                                <input
                                  type="text"
                                  value={variable.description ?? ''}
                                  onChange={(event) => updateVariable(index, 'description', event.target.value)}
                                  placeholder="Description"
                                  aria-label="Variable description"
                                  className="tl-input"
                                />
                                <input
                                  type="text"
                                  value={variable.sampleValue ?? ''}
                                  onChange={(event) => updateVariable(index, 'sampleValue', event.target.value)}
                                  placeholder="Sample value for preview"
                                  aria-label="Sample value"
                                  className="tl-input"
                                />
                                <button
                                  onClick={() => removeVariable(index)}
                                  className="tl-button-quiet"
                                  data-tone="danger"
                                  style={{ minHeight: '2.5rem' }}
                                >
                                  Remove
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </section>

              <div className="grid gap-6 xl:grid-cols-2">
                <section className="tl-card">
                  <div className="tl-card-header">
                    <h3 className="text-base font-semibold text-ink">Validation</h3>
                  </div>
                  <div className="space-y-5 p-5">
                    <div>
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">Used Variables</div>
                      <div className="flex flex-wrap gap-2">
                        {validation.usedVariables.length === 0 ? (
                          <span className="text-sm text-muted">No placeholders detected.</span>
                        ) : (
                          validation.usedVariables.map((name) => (
                            <Pill key={name}>{name}</Pill>
                          ))
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">Unknown Variables</div>
                      <div className="flex flex-wrap gap-2">
                        {validation.unknownVariables.length === 0 ? (
                          <span className="tl-status" data-tone="ok">None.</span>
                        ) : (
                          validation.unknownVariables.map((name) => (
                            <Pill key={name} tone="red">{name}</Pill>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                </section>

                <section className="tl-card">
                  <div className="tl-card-header">
                    <h3 className="text-base font-semibold text-ink">Preview</h3>
                    {preview && (
                      <span className="text-xs text-subtle">
                        {Object.keys(preview.sampleValues).length} sample values injected
                      </span>
                    )}
                  </div>
                  <div className="p-5">
                    <div className="min-h-[220px] overflow-auto whitespace-pre-wrap rounded-md bg-surface-muted p-4 text-sm text-muted">
                      {preview?.renderedContent ?? 'Run Preview to render this prompt with sample values.'}
                    </div>
                  </div>
                </section>
              </div>
            </>
          )}
        </section>
      </div>
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
export default function PromptsPage() {
  return (
    <AdminOnly>
      <PromptsPageBody />
    </AdminOnly>
  );
}
