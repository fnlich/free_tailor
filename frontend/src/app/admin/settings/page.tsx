'use client';

import { useEffect, useState } from 'react';
import {
  AI_PROVIDERS,
  adminApi,
  AdminAppSettings,
  AdminAppSettingsUpdate,
  AIProvider,
  DefaultMode,
  DefaultResumeSelection,
  getAIProviderLabel,
  Group,
  groupsApi,
  Profile,
  profilesApi,
  ThemeMode,
} from '@/lib/api';
import { applyTheme, getStoredTheme, setStoredDefaultTheme } from '@/lib/theme';

type PendingApiKey = {
  clientId: string;
  name: string;
  value: string;
};

type ApiKeyProviderFormState = {
  activeKeyId: string;
  pendingName: string;
  pendingValue: string;
  pendingAdds: PendingApiKey[];
  removeIds: string[];
};

type SettingsFormState = {
  openaiEnabled: boolean;
  claudeEnabled: boolean;
  openrouterEnabled: boolean;
  deepseekEnabled: boolean;
  defaultMode: DefaultMode;
  defaultTheme: ThemeMode;
  defaultResumeSelection: DefaultResumeSelection;
  defaultGroupId: string;
  defaultProfileId: string;
  defaultModelId: string;
  defaultResumeDocxEnabled: boolean;
  defaultCoverLetterDocxEnabled: boolean;
  outputBaseDir: string;
  outputPathTemplate: string;
  apiKeys: Record<AIProvider, ApiKeyProviderFormState>;
};

type SaveSection = 'output' | 'providers' | 'defaults' | 'keys';

function createClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `new:${crypto.randomUUID()}`;
  }
  return `new:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function maskValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'Not set';
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function buildPathPreview(template: string): string {
  const normalized = (template || '').trim() || '/{{profile name}}/{{date}}/{{company name}}/{{job title}}';
  return normalized
    .replace(/\{\{\s*date\s*\}\}/gi, '2026-04-10')
    .replace(/\{\{\s*profile name\s*\}\}/gi, 'jane_doe')
    .replace(/\{\{\s*company name\s*\}\}/gi, 'acme_inc')
    .replace(/\{\{\s*(row number|sheet row|source row|row)\s*\}\}/gi, '12')
    .replace(/\{\{\s*(job title|role)\s*\}\}/gi, 'senior_engineer');
}

function toApiKeyFormState(settings: AdminAppSettings['apiKeys']): Record<AIProvider, ApiKeyProviderFormState> {
  const next = {} as Record<AIProvider, ApiKeyProviderFormState>;

  for (const provider of AI_PROVIDERS) {
    next[provider] = {
      activeKeyId: settings[provider].activeSource === 'stored' ? (settings[provider].activeKeyId ?? '') : '',
      pendingName: '',
      pendingValue: '',
      pendingAdds: [],
      removeIds: [],
    };
  }

  return next;
}

function toFormState(settings: AdminAppSettings): SettingsFormState {
  return {
    openaiEnabled: settings.openaiEnabled,
    claudeEnabled: settings.claudeEnabled,
    openrouterEnabled: settings.openrouterEnabled,
    deepseekEnabled: settings.deepseekEnabled,
    defaultMode: settings.defaultMode,
    defaultTheme: settings.defaultTheme,
    defaultResumeSelection: settings.defaultResumeSelection,
    defaultGroupId: settings.defaultGroupId,
    defaultProfileId: settings.defaultProfileId,
    defaultModelId: settings.defaultModelId,
    defaultResumeDocxEnabled: settings.defaultResumeDocxEnabled,
    defaultCoverLetterDocxEnabled: settings.defaultCoverLetterDocxEnabled,
    outputBaseDir: settings.outputBaseDir,
    outputPathTemplate: settings.outputPathTemplate,
    apiKeys: toApiKeyFormState(settings.apiKeys),
  };
}

function mergeSavedSection(
  current: SettingsFormState,
  updated: AdminAppSettings,
  section: SaveSection
): SettingsFormState {
  if (section === 'output') {
    return {
      ...current,
      outputBaseDir: updated.outputBaseDir,
      outputPathTemplate: updated.outputPathTemplate,
    };
  }

  if (section === 'providers') {
    return {
      ...current,
      openaiEnabled: updated.openaiEnabled,
      claudeEnabled: updated.claudeEnabled,
      openrouterEnabled: updated.openrouterEnabled,
      deepseekEnabled: updated.deepseekEnabled,
    };
  }

  if (section === 'defaults') {
    return {
      ...current,
      defaultMode: updated.defaultMode,
      defaultTheme: updated.defaultTheme,
      defaultResumeSelection: updated.defaultResumeSelection,
      defaultGroupId: updated.defaultGroupId,
      defaultProfileId: updated.defaultProfileId,
      defaultModelId: updated.defaultModelId,
      defaultResumeDocxEnabled: updated.defaultResumeDocxEnabled,
      defaultCoverLetterDocxEnabled: updated.defaultCoverLetterDocxEnabled,
    };
  }

  return {
    ...current,
    apiKeys: toApiKeyFormState(updated.apiKeys),
  };
}

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<AdminAppSettings | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [form, setForm] = useState<SettingsFormState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [savingSection, setSavingSection] = useState<SaveSection | null>(null);
  const [isBrowsingDirectory, setIsBrowsingDirectory] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setIsLoading(true);
      setError('');
      const [settingsData, groupsData, profilesData] = await Promise.all([
        adminApi.getSettings(),
        groupsApi.getAll().catch(() => []),
        profilesApi.getAll({ includeDisabled: true }).catch(() => []),
      ]);
      setSettings(settingsData);
      setGroups(groupsData);
      setProfiles(profilesData.filter((profile) => !profile.disabled));
      setForm(toFormState(settingsData));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setIsLoading(false);
    }
  };

  const setField = <K extends keyof SettingsFormState>(field: K, value: SettingsFormState[K]) => {
    setForm((current) => (current ? { ...current, [field]: value } : current));
  };

  const setApiKeysForProvider = (
    provider: AIProvider,
    updater: (current: ApiKeyProviderFormState) => ApiKeyProviderFormState
  ) => {
    setForm((current) =>
      current
        ? {
            ...current,
            apiKeys: {
              ...current.apiKeys,
              [provider]: updater(current.apiKeys[provider]),
            },
          }
        : current
    );
  };

  const applySavedThemeDefault = (theme: ThemeMode) => {
    setStoredDefaultTheme(theme);
    if (!getStoredTheme()) {
      applyTheme(theme);
    }
  };

  const saveSection = async (
    section: SaveSection,
    payload: AdminAppSettingsUpdate,
    nextMessage: string
  ) => {
    if (!form) return;

    try {
      setSavingSection(section);
      setError('');
      setSuccessMessage('');
      const updated = await adminApi.updateSettings(payload);
      setSettings(updated);
      setForm((current) => (current ? mergeSavedSection(current, updated, section) : toFormState(updated)));
      if (section === 'defaults') {
        applySavedThemeDefault(updated.defaultTheme);
      }
      setSuccessMessage(nextMessage);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update settings');
    } finally {
      setSavingSection(null);
    }
  };

  const handleBrowseDirectory = async () => {
    if (!form) return;

    try {
      setIsBrowsingDirectory(true);
      setError('');
      setSuccessMessage('');
      const result = await adminApi.browseOutputDirectory(form.outputBaseDir);
      if (result.selectedPath) {
        setField('outputBaseDir', result.selectedPath);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open folder picker');
    } finally {
      setIsBrowsingDirectory(false);
    }
  };

  const handleSaveOutputStorage = async () => {
    if (!form) return;

    await saveSection(
      'output',
      {
        outputBaseDir: form.outputBaseDir.trim(),
        outputPathTemplate: form.outputPathTemplate.trim(),
      },
      'Output storage saved.'
    );
  };

  const handleSaveProviders = async () => {
    if (!form) return;
    if (!form.openaiEnabled && !form.claudeEnabled && !form.openrouterEnabled && !form.deepseekEnabled) {
      setError('At least one AI model must remain enabled.');
      return;
    }

    await saveSection(
      'providers',
      {
        openaiEnabled: form.openaiEnabled,
        claudeEnabled: form.claudeEnabled,
        openrouterEnabled: form.openrouterEnabled,
        deepseekEnabled: form.deepseekEnabled,
      },
      'AI providers saved.'
    );
  };

  const handleSaveDefaults = async () => {
    if (!form) return;
    if (form.defaultResumeSelection === 'group' && !form.defaultGroupId) {
      setError('Select a default group or switch the default resume target.');
      return;
    }

    await saveSection(
      'defaults',
      {
        defaultMode: form.defaultMode,
        defaultTheme: form.defaultTheme,
        defaultResumeSelection: form.defaultResumeSelection,
        defaultGroupId: form.defaultResumeSelection === 'group' ? form.defaultGroupId : '',
        defaultProfileId: form.defaultResumeSelection === 'single' ? form.defaultProfileId : '',
        defaultModelId: form.defaultModelId,
        defaultResumeDocxEnabled: form.defaultResumeDocxEnabled,
        defaultCoverLetterDocxEnabled: form.defaultCoverLetterDocxEnabled,
      },
      'Builder defaults saved.'
    );
  };

  const queuePendingApiKey = (provider: AIProvider) => {
    if (!form) return;

    const providerState = form.apiKeys[provider];
    const value = providerState.pendingValue.trim();
    if (!value) {
      setError('Enter an API key before adding it.');
      return;
    }

    setError('');
    setApiKeysForProvider(provider, (current) => {
      const nextEntry: PendingApiKey = {
        clientId: createClientId(),
        name: current.pendingName.trim(),
        value,
      };
      return {
        ...current,
        pendingName: '',
        pendingValue: '',
        pendingAdds: [...current.pendingAdds, nextEntry],
        activeKeyId: current.activeKeyId || nextEntry.clientId,
      };
    });
  };

  const removeApiKeyOption = (provider: AIProvider, id: string, isPending: boolean) => {
    if (!form || !settings) return;

    setApiKeysForProvider(provider, (current) => {
      const nextPendingAdds = isPending
        ? current.pendingAdds.filter((entry) => entry.clientId !== id)
        : current.pendingAdds;
      const nextRemoveIds = isPending
        ? current.removeIds
        : current.removeIds.includes(id)
          ? current.removeIds
          : [...current.removeIds, id];

      const remainingStoredIds = settings.apiKeys[provider].entries
        .filter((entry) => !nextRemoveIds.includes(entry.id))
        .map((entry) => entry.id);
      const remainingPendingIds = nextPendingAdds.map((entry) => entry.clientId);
      const nextActiveId = (() => {
        const options = [...remainingStoredIds, ...remainingPendingIds];
        if (options.includes(current.activeKeyId)) return current.activeKeyId;
        if (settings.apiKeys[provider].environmentPreview) return '';
        return options[0] ?? '';
      })();

      return {
        ...current,
        pendingAdds: nextPendingAdds,
        removeIds: nextRemoveIds,
        activeKeyId: nextActiveId,
      };
    });
  };

  const handleSaveApiKeys = async () => {
    if (!form) return;

    const providerPayload: NonNullable<AdminAppSettingsUpdate['apiKeys']> = {};

    for (const provider of AI_PROVIDERS) {
      const providerState = form.apiKeys[provider];
      const draftValue = providerState.pendingValue.trim();
      const pendingAdds = draftValue
        ? [
            ...providerState.pendingAdds,
            {
              clientId: createClientId(),
              name: providerState.pendingName.trim(),
              value: draftValue,
            },
          ]
        : providerState.pendingAdds;

      providerPayload[provider] = {
        activeKeyId: providerState.activeKeyId,
        add: pendingAdds.map((entry) => ({
          clientId: entry.clientId,
          name: entry.name.trim(),
          value: entry.value,
        })),
        removeIds: providerState.removeIds,
        useEnvironmentFallback: providerState.activeKeyId === '',
      };
    }

    await saveSection(
      'keys',
      { apiKeys: providerPayload },
      'API keys saved.'
    );
  };

  if (isLoading || !form || !settings) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  const providerEnabled = {
    openai: form.openaiEnabled,
    claude: form.claudeEnabled,
    openrouter: form.openrouterEnabled,
    deepseek: form.deepseekEnabled,
  } satisfies Record<AIProvider, boolean>;
  const availableDefaultModels = settings.aiModels.filter(
    (model) => model.enabled && providerEnabled[model.provider]
  );
  const outputPathPreview = buildPathPreview(form.outputPathTemplate);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="mt-2 text-sm text-gray-600">
          Configure builder defaults, enabled providers, output storage, and API keys.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md">
          {error}
        </div>
      )}

      {successMessage && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-md">
          {successMessage}
        </div>
      )}

      <div className="bg-white rounded-lg shadow p-6 space-y-8">
        <section className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Output Storage</h2>
            <p className="text-sm text-gray-600">
              Generated resumes are saved under the base directory below, using the folder template you define.
            </p>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-900">Base directory</label>
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                type="text"
                value={form.outputBaseDir}
                onChange={(e) => setField('outputBaseDir', e.target.value)}
                disabled={savingSection === 'output' || isBrowsingDirectory}
                placeholder="/mnt/resume-archive"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={handleBrowseDirectory}
                disabled={savingSection === 'output' || isBrowsingDirectory}
                className="inline-flex items-center justify-center rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 sm:min-w-36"
              >
                {isBrowsingDirectory ? 'Opening...' : 'Browse...'}
              </button>
            </div>
            <p className="text-xs text-gray-500">
              Browse opens the folder picker on the backend machine, so mounted shared drives and network folders are selectable if that machine can access them.
            </p>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-900">Folder template</label>
            <input
              type="text"
              value={form.outputPathTemplate}
              onChange={(e) => setField('outputPathTemplate', e.target.value)}
              disabled={savingSection === 'output'}
              placeholder="/{{date}}/{{profile name}}/{{company name}}"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700 space-y-2">
              <div>
                <span className="font-medium text-gray-900">Supported tokens:</span>{' '}
                <code>{'{{date}}'}</code>, <code>{'{{profile name}}'}</code>, <code>{'{{company name}}'}</code>,{' '}
                <code>{'{{row number}}'}</code>, <code>{'{{job title}}'}</code>
              </div>
              <div><span className="font-medium text-gray-900">Preview:</span> {outputPathPreview}</div>
              <div><span className="font-medium text-gray-900">Saved preview:</span> {settings.outputPathPreview}</div>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleSaveOutputStorage}
              disabled={savingSection !== null && savingSection !== 'output'}
              className="px-5 py-2.5 bg-blue-600 text-white font-medium rounded-md hover:bg-blue-700 disabled:bg-blue-400"
            >
              {savingSection === 'output' ? 'Saving...' : 'Save Output Storage'}
            </button>
          </div>
        </section>

        <section className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">AI Providers</h2>
            <p className="text-sm text-gray-600">
              Disabled providers are hidden in Resume Builder and rejected by the backend.
            </p>
          </div>

          {AI_PROVIDERS.map((provider) => (
            <label key={provider} className="flex items-center justify-between border rounded-md p-4">
              <div>
                <div className="font-medium text-gray-900">{getAIProviderLabel(provider)}</div>
                <div className="text-sm text-gray-500">
                  {settings.apiKeys[provider].configured
                    ? `Active key: ${settings.apiKeys[provider].activePreview}`
                    : 'No API key configured'}
                </div>
              </div>
              <input
                type="checkbox"
                checked={providerEnabled[provider]}
                disabled={savingSection === 'providers'}
                onChange={(e) => {
                  if (provider === 'openai') setField('openaiEnabled', e.target.checked);
                  if (provider === 'claude') setField('claudeEnabled', e.target.checked);
                  if (provider === 'openrouter') setField('openrouterEnabled', e.target.checked);
                  if (provider === 'deepseek') setField('deepseekEnabled', e.target.checked);
                }}
              />
            </label>
          ))}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleSaveProviders}
              disabled={savingSection !== null && savingSection !== 'providers'}
              className="px-5 py-2.5 bg-blue-600 text-white font-medium rounded-md hover:bg-blue-700 disabled:bg-blue-400"
            >
              {savingSection === 'providers' ? 'Saving...' : 'Save AI Providers'}
            </button>
          </div>
        </section>

        <section className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Builder Defaults</h2>
            <p className="text-sm text-gray-600">
              These values seed the main resume builder when it loads.
            </p>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium text-gray-900">Default mode</div>
            <div className="flex gap-6">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={form.defaultMode === 'preview'}
                  onChange={() => setField('defaultMode', 'preview')}
                  disabled={savingSection === 'defaults'}
                />
                <span>Preview first</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={form.defaultMode === 'generate'}
                  onChange={() => setField('defaultMode', 'generate')}
                  disabled={savingSection === 'defaults'}
                />
                <span>Generate directly</span>
              </label>
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium text-gray-900">Default theme</div>
            <div className="flex gap-6">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={form.defaultTheme === 'light'}
                  onChange={() => setField('defaultTheme', 'light')}
                  disabled={savingSection === 'defaults'}
                />
                <span>Light</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={form.defaultTheme === 'dark'}
                  onChange={() => setField('defaultTheme', 'dark')}
                  disabled={savingSection === 'defaults'}
                />
                <span>Dark</span>
              </label>
            </div>
          </div>

          <div className="space-y-3">
            <div className="text-sm font-medium text-gray-900">Default resume target</div>
            <div className="flex flex-wrap gap-6">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={form.defaultResumeSelection === 'single'}
                  onChange={() => setField('defaultResumeSelection', 'single')}
                  disabled={savingSection === 'defaults'}
                />
                <span>Single profile</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={form.defaultResumeSelection === 'all'}
                  onChange={() => setField('defaultResumeSelection', 'all')}
                  disabled={savingSection === 'defaults'}
                />
                <span>All profiles</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={form.defaultResumeSelection === 'group'}
                  onChange={() => setField('defaultResumeSelection', 'group')}
                  disabled={savingSection === 'defaults'}
                />
                <span>Specific group</span>
              </label>
            </div>

            {form.defaultResumeSelection === 'single' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Default profile</label>
                <select
                  value={form.defaultProfileId}
                  onChange={(e) => setField('defaultProfileId', e.target.value)}
                  disabled={savingSection === 'defaults'}
                  className="w-full max-w-md px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Choose automatically</option>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
                {profiles.length === 0 && (
                  <p className="mt-2 text-sm text-amber-700">
                    No enabled profiles exist yet. Create one in Admin &gt; Profiles before setting a default.
                  </p>
                )}
              </div>
            )}

            {form.defaultResumeSelection === 'group' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Default group</label>
                <select
                  value={form.defaultGroupId}
                  onChange={(e) => setField('defaultGroupId', e.target.value)}
                  disabled={savingSection === 'defaults'}
                  className="w-full max-w-md px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Choose a group...</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name} ({group.profileIds.length})
                    </option>
                  ))}
                </select>
                {groups.length === 0 && (
                  <p className="mt-2 text-sm text-amber-700">
                    No groups exist yet. Create one in Admin &gt; Groups before using this default.
                  </p>
                )}
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Default AI model</label>
            <select
              value={form.defaultModelId}
              onChange={(e) => setField('defaultModelId', e.target.value)}
              disabled={savingSection === 'defaults' || availableDefaultModels.length === 0}
              className="w-full max-w-xl px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {availableDefaultModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {`${getAIProviderLabel(model.provider)} · ${model.name} (${model.modelName})`}
                </option>
              ))}
            </select>
            <p className="mt-2 text-sm text-gray-600">
              This is the default model used by Resume Builder when no prompt-level override is set.
            </p>
            {availableDefaultModels.length === 0 && (
              <p className="mt-2 text-sm text-amber-700">
                No enabled models are currently available. Add one in Settings &gt; Models or re-enable a provider.
              </p>
            )}
          </div>

          <div className="space-y-3">
            <div className="text-sm font-medium text-gray-900">Default generated files</div>
            <p className="text-sm text-gray-600">
              PDF files are always generated. Enable DOCX only for the outputs you want by default.
            </p>
            <div className="space-y-2">
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={form.defaultResumeDocxEnabled}
                  onChange={(e) => setField('defaultResumeDocxEnabled', e.target.checked)}
                  disabled={savingSection === 'defaults'}
                />
                <span>Generate DOCX resume by default</span>
              </label>
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={form.defaultCoverLetterDocxEnabled}
                  onChange={(e) => setField('defaultCoverLetterDocxEnabled', e.target.checked)}
                  disabled={savingSection === 'defaults'}
                />
                <span>Generate DOCX cover letter by default</span>
              </label>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleSaveDefaults}
              disabled={savingSection !== null && savingSection !== 'defaults'}
              className="px-5 py-2.5 bg-blue-600 text-white font-medium rounded-md hover:bg-blue-700 disabled:bg-blue-400"
            >
              {savingSection === 'defaults' ? 'Saving...' : 'Save Builder Defaults'}
            </button>
          </div>
        </section>

        <section className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">API Keys</h2>
            <p className="text-sm text-gray-600">
              Save multiple keys per provider and choose which stored key is active.
            </p>
          </div>

          {AI_PROVIDERS.map((provider) => {
            const providerSettings = settings.apiKeys[provider];
            const providerForm = form.apiKeys[provider];
            const visibleStoredKeys = providerSettings.entries.filter((entry) => !providerForm.removeIds.includes(entry.id));

            return (
              <div key={provider} className="border rounded-md p-4 space-y-4">
                <div>
                  <div className="font-medium text-gray-900">{getAIProviderLabel(provider)}</div>
                  <div className="text-sm text-gray-500">
                    {providerSettings.activeSource === 'stored' && providerSettings.activePreview
                      ? `Stored active key: ${providerSettings.activePreview}`
                      : providerSettings.activeSource === 'environment' && providerSettings.environmentPreview
                        ? `Using environment fallback: ${providerSettings.environmentPreview}`
                        : 'No active key configured'}
                  </div>
                </div>

                <div className="space-y-2">
                  {providerSettings.environmentPreview && (
                    <label className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2">
                      <div>
                        <div className="text-sm font-medium text-gray-900">Environment fallback</div>
                        <div className="text-xs text-gray-500">{providerSettings.environmentPreview}</div>
                      </div>
                      <input
                        type="radio"
                        name={`${provider}-active-key`}
                        checked={providerForm.activeKeyId === ''}
                        onChange={() => setApiKeysForProvider(provider, (current) => ({ ...current, activeKeyId: '' }))}
                        disabled={savingSection === 'keys'}
                      />
                    </label>
                  )}

                  {visibleStoredKeys.map((entry) => (
                    <div key={entry.id} className="flex items-center justify-between gap-3 rounded-md border border-gray-200 px-3 py-2">
                      <label className="flex items-center gap-3 min-w-0">
                        <input
                          type="radio"
                          name={`${provider}-active-key`}
                          checked={providerForm.activeKeyId === entry.id}
                          onChange={() => setApiKeysForProvider(provider, (current) => ({ ...current, activeKeyId: entry.id }))}
                          disabled={savingSection === 'keys'}
                        />
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-gray-900 truncate">{entry.name}</div>
                          <div className="text-xs text-gray-500">{entry.preview}</div>
                        </div>
                      </label>
                      <button
                        type="button"
                        onClick={() => removeApiKeyOption(provider, entry.id, false)}
                        disabled={savingSection === 'keys'}
                        className="px-3 py-2 text-sm border border-red-200 text-red-700 rounded-md hover:bg-red-50 disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  ))}

                  {providerForm.pendingAdds.map((entry) => (
                    <div key={entry.clientId} className="flex items-center justify-between gap-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2">
                      <label className="flex items-center gap-3 min-w-0">
                        <input
                          type="radio"
                          name={`${provider}-active-key`}
                          checked={providerForm.activeKeyId === entry.clientId}
                          onChange={() => setApiKeysForProvider(provider, (current) => ({ ...current, activeKeyId: entry.clientId }))}
                          disabled={savingSection === 'keys'}
                        />
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-gray-900 truncate">
                            {entry.name.trim() || 'New key'}
                          </div>
                          <div className="text-xs text-gray-500">{maskValue(entry.value)} (pending save)</div>
                        </div>
                      </label>
                      <button
                        type="button"
                        onClick={() => removeApiKeyOption(provider, entry.clientId, true)}
                        disabled={savingSection === 'keys'}
                        className="px-3 py-2 text-sm border border-red-200 text-red-700 rounded-md hover:bg-red-50 disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>

                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
                  <input
                    type="text"
                    value={providerForm.pendingName}
                    onChange={(e) => setApiKeysForProvider(provider, (current) => ({ ...current, pendingName: e.target.value }))}
                    disabled={savingSection === 'keys'}
                    placeholder="Label (optional)"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <input
                    type="password"
                    value={providerForm.pendingValue}
                    onChange={(e) => setApiKeysForProvider(provider, (current) => ({ ...current, pendingValue: e.target.value }))}
                    disabled={savingSection === 'keys'}
                    placeholder={`Paste ${getAIProviderLabel(provider)} API key`}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={() => queuePendingApiKey(provider)}
                    disabled={savingSection === 'keys'}
                    className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 disabled:opacity-50"
                  >
                    Add Key
                  </button>
                </div>
              </div>
            );
          })}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleSaveApiKeys}
              disabled={savingSection !== null && savingSection !== 'keys'}
              className="px-5 py-2.5 bg-blue-600 text-white font-medium rounded-md hover:bg-blue-700 disabled:bg-blue-400"
            >
              {savingSection === 'keys' ? 'Saving...' : 'Save API Keys'}
            </button>
          </div>
        </section>

      </div>
    </div>
  );
}
