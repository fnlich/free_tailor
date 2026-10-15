'use client';

import { useEffect, useState } from 'react';
import { AdminOnly } from '@/components/auth/AuthGate';
import SettingSource from '@/components/ui/SettingSource';
import {
  adminApi,
  AdminAppSettings,
  AdminAppSettingsUpdate,
  AIModelRecord,
  AIProvider,
  describeProviderModel,
  findProviderModelOption,
  formatPricePerResume,
  getAIProviderLabel,
  isProviderLocked,
  isProviderOffered,
  LOCK_ICON,
} from '@/lib/api';
import { appSettingSourceLabel, canReset, resetBody } from '@/lib/settingSources';
import { ErrorNotice, Field, Notice, Pill, Section, Spinner, StaticValue } from '@/components/ui/kit';
import { messageWithDetail } from '@/lib/userMessage';
import { freeEnabledModels } from './modelPrice';
import ModelDialog from './ModelDialog';
import ProvidersSection from './ProvidersSection';

function lockReason(settings: AdminAppSettings, provider: AIProvider): string {
  return settings.providerLocks.find((lock) => lock.id === provider)?.reason ?? '';
}

/** A model's display name, or its id when it has none (an id the list no longer holds). */
function modelLabel(settings: AdminAppSettings, id: string): string {
  return settings.aiModels.find((model) => model.id === id)?.name || id;
}

function ModelsPageBody() {
  const [settings, setSettings] = useState<AdminAppSettings | null>(null);
  /** The dialog: a model to edit, null for Create New Model, absent while it is closed. */
  const [editor, setEditor] = useState<{ model: AIModelRecord | null } | null>(null);
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
      setSettings(await adminApi.getSettings());
    } catch (err) {
      setLoadError(err);
    } finally {
      setIsLoading(false);
    }
  };

  /** One change, its answer adopted and said; a refusal in the server's words. */
  const change = async (run: () => Promise<AdminAppSettings>, said: (updated: AdminAppSettings) => string, failed: string) => {
    try {
      setIsSaving(true);
      setError('');
      setStatus('');
      const updated = await run();
      setSettings(updated);
      setStatus(said(updated));
    } catch (err) {
      setError(messageWithDetail(err, failed));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = (model: AIModelRecord) => {
    if (!window.confirm(`Delete model "${model.name}"?`)) return;
    void change(() => adminApi.deleteModel(model.id), () => 'Model deleted.', 'Failed to delete model');
  };

  // `{enabled}` alone: the server keeps every other field, the price
  // included, so a toggle can never reprice a model by accident.
  const handleToggleEnabled = (model: AIModelRecord) =>
    void change(
      () => adminApi.updateModel(model.id, { enabled: !model.enabled }),
      () => `${model.name} ${model.enabled ? 'disabled' : 'enabled'}.`,
      'Failed to update model'
    );

  /** Set default, Use for analysis, and the two resets: one field of the settings each. */
  const saveChoice = (body: AdminAppSettingsUpdate, said: (updated: AdminAppSettings) => string) =>
    void change(() => adminApi.updateSettings(body), said, 'Failed to update the model choice');

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
  const freeModels = freeEnabledModels(settings);
  /** What the server would run: enabled, on a provider this installation offers. */
  const canRun = (model: AIModelRecord) => model.enabled && isProviderOffered(settings, model.provider, providerEnabled);
  /*
   * The analysis model as the server resolves it (`resolveAnalysisModel`):
   * the chosen one while it can run, else the default model. A stored choice
   * that stopped running - switched off, its provider off or locked - is
   * named for what it is rather than silently shown as another model.
   */
  const analysisId = settings.analysisModelId;
  const chosenAnalysis = analysisId ? settings.aiModels.find((model) => model.id === analysisId) ?? null : null;
  const analysisStale = Boolean(analysisId) && !(chosenAnalysis && canRun(chosenAnalysis));
  const analysisRunsOn = analysisId && !analysisStale ? analysisId : settings.defaultModelId;
  const defaultName = settings.defaultModelId ? modelLabel(settings, settings.defaultModelId) : '';
  const theDefaultModel = defaultName ? `the default model (${defaultName})` : 'the default model';
  const sources = settings.settingSources;
  const analysisSource =
    sources.analysisModelId === 'default'
      ? 'Default (the default model)'
      : appSettingSourceLabel(sources, 'analysisModelId');
  const analysisGives = settings.settingDefaults.analysisModelId
    ? modelLabel(settings, settings.settingDefaults.analysisModelId)
    : theDefaultModel;
  const defaultGives = settings.settingDefaults.defaultModelId
    ? modelLabel(settings, settings.settingDefaults.defaultModelId)
    : 'no model';

  return (
    <div>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-3xl">
          <h2 className="text-2xl font-bold tracking-tight text-ink">Models</h2>
          <p className="mt-1 text-sm text-muted">
            The models people choose from in the Resume Builder and on their profiles, by the display name
            you give each one, and what one resume on it costs - and, under Providers, every place each type
            of model runs.
          </p>
        </div>
        <button
          type="button"
          className="tl-button"
          onClick={() => {
            setError('');
            setStatus('');
            setEditor({ model: null });
          }}
          disabled={isSaving}
        >
          Create New Model
        </button>
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
        title="Default and analysis"
        description="Each job posting is analysed once, by the analysis model, and never again - its keywords by the Analyze Job Description prompt and its facts, job field included, by the Job Facts (Filter) prompt: every profile, model, order and Job Filter run that needs the posting builds on that one analysis, so every posting is read - and classified into a job field - the same way. Set either one from a row of the library below."
      >
        <div className="grid gap-6 md:grid-cols-2">
          <div data-choice="default">
            <Field label="Default model" hint="What Resume Builder runs when nobody chooses a model - a profile's or a prompt's choice wins.">
              <StaticValue>
                <span data-default-model>{defaultName || 'None - no model can run'}</span>
              </StaticValue>
              <SettingSource
                label={appSettingSourceLabel(sources, 'defaultModelId')}
                resettable={canReset(sources.defaultModelId)}
                gives={defaultGives}
                name="the default model"
                busy={isSaving}
                onReset={() =>
                  saveChoice(resetBody('defaultModelId'), (updated) =>
                    `The default model is ${modelLabel(updated, updated.defaultModelId) || 'none'} again.`
                  )
                }
              />
            </Field>
          </div>
          <div data-choice="analysis">
            <Field
              label="Analysis model"
              hint="Changing it changes how postings never analysed before are read. Stored analyses are kept as they are; nothing is analysed again."
            >
              <StaticValue>
                <span data-analysis-model>
                  {!analysisId
                    ? `The default model${defaultName ? ` (${defaultName})` : ''}`
                    : chosenAnalysis
                      ? chosenAnalysis.name
                      : `A model that is gone (${analysisId})`}
                </span>
              </StaticValue>
              <SettingSource
                label={analysisSource}
                resettable={canReset(sources.analysisModelId)}
                gives={analysisGives}
                name="the analysis model"
                busy={isSaving}
                onReset={() => saveChoice(resetBody('analysisModelId'), () => 'The analysis model is back to its default.')}
              />
              {analysisStale && (
                <Notice tone="warn" className="mt-3">
                  {chosenAnalysis ? `"${chosenAnalysis.name}"` : 'The chosen analysis model'} cannot run here - it is
                  switched off, or its provider is switched off or locked - so postings are analysed on{' '}
                  {theDefaultModel} until it can, or another is chosen.
                </Notice>
              )}
            </Field>
          </div>
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
                // Where postings are analysed: the chosen model, or the
                // default while none is chosen or the chosen one cannot run.
                const isAnalysis = analysisRunsOn === model.id;
                const isChosenForAnalysis = analysisId === model.id;
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
                  <tr key={model.id} data-model-id={model.id}>
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
                        {isAnalysis && (
                          <span title={analysisId ? 'Job postings are analysed on this model' : 'Job postings are analysed on the default model'}>
                            <Pill tone="violet">Analysis</Pill>
                          </span>
                        )}
                        {isChosenForAnalysis && analysisStale && <Pill tone="amber">Analysis - cannot run</Pill>}
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
                          onClick={() => {
                            setError('');
                            setStatus('');
                            setEditor({ model });
                          }}
                          disabled={isSaving}
                          className="tl-button-quiet"
                          data-size="sm"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleEnabled(model)}
                          disabled={isSaving}
                          className="tl-button-quiet"
                          data-size="sm"
                        >
                          {model.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            saveChoice({ defaultModelId: model.id }, () => `Default model set to ${model.name}.`)
                          }
                          disabled={isSaving || !canRun(model) || isDefault}
                          className="tl-button-quiet"
                          data-size="sm"
                        >
                          Set default
                        </button>
                        {isChosenForAnalysis ? (
                          // Chosen already: the other way is back to the
                          // default model - '' is that choice, and it beats
                          // ANALYSIS_MODEL in .env.
                          <button
                            type="button"
                            onClick={() =>
                              saveChoice({ analysisModelId: '' }, () => 'Job postings are analysed on the default model now.')
                            }
                            disabled={isSaving}
                            className="tl-button-quiet"
                            data-size="sm"
                          >
                            Use the default model
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() =>
                              saveChoice({ analysisModelId: model.id }, () => `Job postings are analysed on ${model.name} now.`)
                            }
                            disabled={isSaving || !canRun(model)}
                            className="tl-button-quiet"
                            data-size="sm"
                          >
                            Use for analysis
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleDelete(model)}
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
        // Status column above and Set default follow the list it answers with.
        onProvidersChange={(next) => setSettings((current) => (current ? { ...current, aiProviders: next } : current))}
      />

      {editor && (
        <ModelDialog
          // A fresh form for each model it opens on.
          key={editor.model?.id ?? 'new'}
          model={editor.model}
          settings={settings}
          onClose={() => setEditor(null)}
          onSaved={(updated, said) => {
            setSettings(updated);
            setStatus(said);
            setEditor(null);
          }}
        />
      )}
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
