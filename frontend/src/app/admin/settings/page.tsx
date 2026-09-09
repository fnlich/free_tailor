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
  ProviderHealthReport,
  ThemeMode,
} from '@/lib/api';
import { applyTheme, getStoredTheme, setStoredDefaultTheme } from '@/lib/theme';

type SettingsFormState = {
  providersEnabled: Record<AIProvider, boolean>;
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
};

type SaveSection = 'output' | 'providers' | 'defaults';

function buildPathPreview(template: string): string {
  const normalized = (template || '').trim() || '/{{profile name}}/{{date}}/{{company name}}/{{job title}}';
  return normalized
    .replace(/\{\{\s*date\s*\}\}/gi, '2026-04-10')
    .replace(/\{\{\s*profile name\s*\}\}/gi, 'jane_doe')
    .replace(/\{\{\s*company name\s*\}\}/gi, 'acme_inc')
    .replace(/\{\{\s*(row number|sheet row|source row|row)\s*\}\}/gi, '12')
    .replace(/\{\{\s*(job title|role)\s*\}\}/gi, 'senior_engineer');
}

function describeProviderHealth(
  health: ProviderHealthReport | null,
  provider: AIProvider,
  healthError = ''
): string {
  if (healthError) return `Could not read provider status: ${healthError}`;
  if (!health) return 'Checking the sign-in on the server...';
  const entry = health.providers.find((item) => item.id === provider);
  if (!entry) return 'No status reported.';
  return entry.warning ? `${entry.detail} ${entry.warning}` : entry.detail;
}

function formatPercent(value: number | null): string {
  return value === null ? 'unknown' : `${Math.round(value * 100)}%`;
}

/**
 * Readiness of the Claude subscription seat.
 *
 * A seat fails in ways an API key cannot - the binary is not on PATH, the
 * sign-in expired, the five-hour window is spent - and none of those are
 * visible from a settings page that only knows how to render a key.
 */
function SubscriptionCard({
  health,
  healthError,
}: {
  health: ProviderHealthReport | null;
  healthError: string;
}) {
  const provider = health?.providers.find((item) => item.id === 'claude-cli');
  const seat = health?.subscription.seat;
  const outages = health?.subscription.outages ?? [];
  // This provider's own numbers. The process-wide totals include every metered
  // provider, and reporting those here would credit them to the seat.
  const usage = health?.usage.byProvider['claude-cli'];

  const tone = healthError
    ? { dot: 'bg-red-500', box: 'border-red-200 bg-red-50' }
    : !health
    ? { dot: 'bg-gray-300', box: 'border-gray-200 bg-gray-50' }
    : provider?.ok && !provider.warning
      ? { dot: 'bg-green-500', box: 'border-green-200 bg-green-50' }
      : provider?.ok
        ? { dot: 'bg-amber-500', box: 'border-amber-200 bg-amber-50' }
        : { dot: 'bg-red-500', box: 'border-red-200 bg-red-50' };

  return (
    <section className={`space-y-3 rounded-md border p-4 ${tone.box}`}>
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${tone.dot}`} aria-hidden />
        <h2 className="text-lg font-semibold text-gray-900">Claude Subscription</h2>
      </div>

      <p className="text-sm text-gray-700">
        {healthError
          ? `Could not read provider status: ${healthError}`
          : health
            ? provider?.detail ?? 'No status reported.'
            : 'Checking the Claude CLI on the server...'}
      </p>
      {provider?.warning && <p className="text-sm font-medium text-amber-800">{provider.warning}</p>}

      <dl className="grid gap-x-6 gap-y-1 text-sm text-gray-700 sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-gray-500">Sign-in</dt>
          <dd>{provider?.authMethod === 'oauth_token' ? 'Subscription (OAuth)' : provider?.authMethod ?? 'unknown'}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-gray-500">Usage window</dt>
          <dd>
            {formatPercent(seat?.utilization ?? null)}
            {seat?.resetsAt ? ` (resets ${new Date(seat.resetsAt).toLocaleTimeString()})` : ''}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-gray-500">In flight</dt>
          <dd>
            {health?.concurrency['claude-cli']
              ? `${health.concurrency['claude-cli'].inFlight} of ${health.concurrency['claude-cli'].limit}` +
                (health.concurrency['claude-cli'].queued ? `, ${health.concurrency['claude-cli'].queued} queued` : '')
              : 'idle'}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-gray-500">Calls this run</dt>
          <dd>
            {usage?.calls ?? 0}
            {usage?.failures ? `, ${usage.failures} failed` : ''}
          </dd>
        </div>
      </dl>

      {outages.length > 0 && (
        <ul className="space-y-1 text-sm text-red-800">
          {outages.map((outage) => (
            <li key={`${outage.scope}-${outage.expiresAt}`}>
              {outage.scope === '*' ? 'All models' : outage.scope} paused until{' '}
              {new Date(outage.expiresAt).toLocaleTimeString()}: {outage.reason}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function toFormState(settings: AdminAppSettings): SettingsFormState {
  return {
    providersEnabled: { ...settings.providersEnabled },
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
      providersEnabled: { ...updated.providersEnabled },
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

  const [health, setHealth] = useState<ProviderHealthReport | null>(null);
  const [healthError, setHealthError] = useState('');

  useEffect(() => {
    loadSettings();
    // Provider readiness is a separate, slower call (it shells out to check
    // the CLI sign-in), so it must not hold up the settings form. A failure is
    // recorded separately from "not loaded yet" - collapsing the two left the
    // card reading "Checking..." forever.
    adminApi
      .getAiHealth()
      .then((report) => {
        setHealth(report);
        setHealthError('');
      })
      .catch((err) => setHealthError(err instanceof Error ? err.message : 'Could not read provider status'));
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
    if (!Object.values(form.providersEnabled).some(Boolean)) {
      setError('At least one AI model must remain enabled.');
      return;
    }

    await saveSection('providers', { providersEnabled: form.providersEnabled }, 'AI providers saved.');
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

  if (isLoading || !form || !settings) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  const providerEnabled = form.providersEnabled;
  const availableDefaultModels = settings.aiModels.filter(
    (model) => model.enabled && providerEnabled[model.provider]
  );
  const outputPathPreview = buildPathPreview(form.outputPathTemplate);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="mt-2 text-sm text-gray-600">
          Configure builder defaults, enabled providers, and output storage.
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

        <SubscriptionCard health={health} healthError={healthError} />

        <section className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">AI Providers</h2>
            <p className="text-sm text-gray-600">
              Disabled providers are hidden in Resume Builder and rejected by the backend. Claude
              Code runs on your subscription; the metered providers are keyed from{' '}
              <code className="rounded bg-gray-100 px-1">.env</code> (<code className="rounded bg-gray-100 px-1">ANTHROPIC_API_KEY</code>,{' '}
              <code className="rounded bg-gray-100 px-1">OPENAI_API_KEY</code>,{' '}
              <code className="rounded bg-gray-100 px-1">DEEPSEEK_API_KEY</code>) and this app does
              not store keys of its own. Each row below shows what the provider reports right now.
            </p>
          </div>

          {AI_PROVIDERS.map((provider) => (
            <label key={provider} className="flex items-center justify-between border rounded-md p-4">
              <div>
                <div className="font-medium text-gray-900">{getAIProviderLabel(provider)}</div>
                <div className="text-sm text-gray-500">
                  {describeProviderHealth(health, provider, healthError)}
                </div>
              </div>
              <input
                type="checkbox"
                checked={providerEnabled[provider]}
                disabled={savingSection === 'providers'}
                onChange={(e) =>
                  setField('providersEnabled', { ...form.providersEnabled, [provider]: e.target.checked })
                }
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

      </div>
    </div>
  );
}
