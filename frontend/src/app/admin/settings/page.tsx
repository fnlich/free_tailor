'use client';

import { useEffect, useState } from 'react';
import { AdminOnly } from '@/components/auth/AuthGate';
import ContactEditor from '@/components/contact/ContactEditor';
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
  isProviderLocked,
  isProviderOffered,
  LOCK_ICON,
  Profile,
  profilesApi,
  ProviderHealthReport,
  ThemeMode,
} from '@/lib/api';
import { applyTheme, getStoredTheme, setStoredDefaultTheme } from '@/lib/theme';
import { Card, ErrorNotice, Field, Notice, Pill, Section, Spinner } from '@/components/ui/kit';
import { messageWithDetail } from '@/lib/userMessage';
import { seatHolds } from '@/lib/seatHolds';
import styles from './page.module.css';

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
  /** '' = the app default model. */
  analysisModelId: string;
};

type SaveSection = 'output' | 'providers' | 'defaults' | 'analysis';

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
 * How a seat's sign-in reads. The raw `authMethod` is shown for anything not
 * named here, so a sign-in this page has never heard of is still visible.
 */
const AUTH_METHOD_LABELS: Record<string, string> = {
  oauth_token: 'Subscription (OAuth)',
  'oauth-personal': 'Google account (OAuth)',
};

/**
 * Readiness of one subscription seat.
 *
 * A seat fails in ways a settings form cannot see - the binary is not on PATH,
 * the sign-in expired, the five-hour window is spent - so each one gets a card
 * that says which.
 *
 * Takes the PROVIDER, one card per seat. Hard-coded to `claude-cli`, this card
 * once left the Codex seat with no readiness anywhere: the numbers were already
 * on the wire (`concurrency` and `usage.byProvider` are both keyed per
 * provider) and simply never read, so an operator whose `codex` was
 * unsigned-in or off PATH had nothing on the page saying so.
 *
 * `seatWindow` is opt-in for the same honest reason: `subscription` on the wire
 * is ONE object, the Claude adapter's, because only that CLI reports a usage
 * window - inventing the shape of one nobody has seen produces a confidently
 * wrong message at the worst moment. An absent window on the other cards is the
 * truth; an absent in-flight row was not.
 *
 * Holds are per seat - see `seatHolds`.
 */
function SubscriptionCard({
  health,
  healthError,
  provider: providerId,
  title,
  seatWindow = false,
}: {
  health: ProviderHealthReport | null;
  healthError: string;
  provider: AIProvider;
  title: string;
  seatWindow?: boolean;
}) {
  const provider = health?.providers.find((item) => item.id === providerId);
  const seat = seatWindow ? health?.subscription.seat : undefined;
  const outages = seatHolds(health, providerId);
  // This provider's own numbers. The process-wide totals include every seat,
  // and reporting those here would credit the others' calls to this one.
  const usage = health?.usage.byProvider[providerId];
  const concurrency = health?.concurrency[providerId];

  // The seat's state as a coloured dot beside its name - the colours live in
  // page.module.css, stated for both themes.
  const tone = healthError
    ? 'error'
    : !health
    ? 'unknown'
    : provider?.ok && !provider.warning
      ? 'ok'
      : provider?.ok
        ? 'warn'
        : 'error';

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <span className={styles.dot} data-tone={tone} aria-hidden />
          {title}
        </span>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">
          {healthError
            ? `Could not read provider status: ${healthError}`
            : health
              ? provider?.detail ?? 'No status reported.'
              : 'Checking the CLI on the server...'}
        </p>
        {provider?.warning && <Notice tone="warn">{provider.warning}</Notice>}

        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="text-subtle">Sign-in</dt>
            <dd className="text-ink">
              {provider?.authMethod
                ? AUTH_METHOD_LABELS[provider.authMethod] ?? provider.authMethod
                : 'unknown'}
            </dd>
          </div>
          {seatWindow && (
            <div className="flex gap-2">
              <dt className="text-subtle">Usage window</dt>
              <dd className="text-ink">
                {formatPercent(seat?.utilization ?? null)}
                {seat?.resetsAt ? ` (resets ${new Date(seat.resetsAt).toLocaleTimeString()})` : ''}
              </dd>
            </div>
          )}
          <div className="flex gap-2">
            <dt className="text-subtle">In flight</dt>
            <dd className="text-ink">
              {concurrency
                ? `${concurrency.inFlight} of ${concurrency.limit}` +
                  (concurrency.queued ? `, ${concurrency.queued} queued` : '')
                : 'idle'}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-subtle">Calls this run</dt>
            <dd className="text-ink">
              {usage?.calls ?? 0}
              {usage?.failures ? `, ${usage.failures} failed` : ''}
            </dd>
          </div>
        </dl>

        {outages.length > 0 && (
          <Notice tone="error">
            <ul className="space-y-1">
              {outages.map((outage) => (
                <li key={`${outage.scope}-${outage.expiresAt}`}>
                  {outage.scope === '*' ? 'All models' : outage.scope} paused until{' '}
                  {new Date(outage.expiresAt).toLocaleTimeString()}: {outage.reason}
                </li>
              ))}
            </ul>
          </Notice>
        )}
      </div>
    </Card>
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
    analysisModelId: settings.analysisModelId,
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

  if (section === 'analysis') {
    return {
      ...current,
      analysisModelId: updated.analysisModelId,
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

function AdminSettingsPageBody() {
  const [settings, setSettings] = useState<AdminAppSettings | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [form, setForm] = useState<SettingsFormState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [savingSection, setSavingSection] = useState<SaveSection | null>(null);
  const [isBrowsingDirectory, setIsBrowsingDirectory] = useState(false);
  const [error, setError] = useState('');
  /**
   * Why the settings could not be read, kept whole rather than as text, so the
   * notice can show the server's sentence, its reference and - this page being
   * an administrator's - the cause. Separate from `error`, which is about a
   * save on a page that did load.
   */
  const [loadError, setLoadError] = useState<unknown>(null);
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
      .catch((err) => setHealthError(messageWithDetail(err, 'Could not read provider status')));

  }, []);

  const loadSettings = async () => {
    try {
      setIsLoading(true);
      setError('');
      setLoadError(null);
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
      setLoadError(err);
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
  ): Promise<boolean> => {
    if (!form) return false;

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
      return true;
    } catch (err) {
      setError(messageWithDetail(err, 'Failed to update settings'));
      return false;
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
      setError(messageWithDetail(err, 'Failed to open folder picker'));
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
    if (!form || !settings) return;
    // `isProviderOffered`, not the bare ticks: a locked provider keeps its
    // stored `true` (its checkbox is fixed, so nothing unticks it), and counting
    // it here would let an admin untick everything else and save an install
    // where nothing could actually run.
    const runnable = AI_PROVIDERS.filter(
      (provider) => isProviderOffered(settings, provider, form.providersEnabled)
    );
    if (runnable.length === 0) {
      setError(
        'At least one AI provider that can run here must remain enabled. Locked providers cannot ' +
          'run however they are ticked.'
      );
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

  const handleSaveAnalysisModel = async () => {
    if (!form) return;
    await saveSection('analysis', { analysisModelId: form.analysisModelId }, 'Analysis model saved.');
  };

  if (isLoading) {
    return <Spinner />;
  }
  /*
   * Loaded, and nothing to show. This used to be the same branch as loading,
   * so a read the server refused - a settings row that does not parse, say -
   * left the spinner turning for ever, with the reason rendered below it where
   * it could never appear.
   */
  if (!form || !settings) {
    return (
      <div>
        <header>
          <h2 className="text-2xl font-bold tracking-tight text-ink">General</h2>
        </header>
        <ErrorNotice className="mt-6" error={loadError ?? 'Failed to load settings'} fallback="Failed to load settings">
          <button type="button" onClick={() => void loadSettings()} className="tl-button-quiet mt-4">
            Try again
          </button>
        </ErrorNotice>
        {/* Its own setting and its own endpoint, so it stays editable when the rest cannot load. */}
        <ContactEditor />
      </div>
    );
  }

  const providerEnabled = form.providersEnabled;
  // Admin settings carry the RAW model list so every record stays manageable,
  // so the offer rule has to be applied here rather than relied on upstream.
  const availableDefaultModels = settings.aiModels.filter(
    (model) => model.enabled && isProviderOffered(settings, model.provider, providerEnabled)
  );
  const outputPathPreview = buildPathPreview(form.outputPathTemplate);
  /*
   * The analysis model as the server resolves it (`resolveAnalysisModel`): the
   * chosen one while it can run, else the app default. A stored choice that
   * stopped running - switched off, its provider off or locked - stays in the
   * select, named for what it is, rather than the select silently showing
   * another model than the one saved.
   */
  const defaultModelName = settings.aiModels.find((model) => model.id === settings.defaultModelId)?.name ?? '';
  const chosenAnalysisModel = form.analysisModelId
    ? settings.aiModels.find((model) => model.id === form.analysisModelId) ?? null
    : null;
  const analysisModelStale =
    Boolean(form.analysisModelId) && !availableDefaultModels.some((model) => model.id === form.analysisModelId);
  /* One card per seat this installation could run. Keyed on the LOCK, not on
     the enabled tick: a seat an admin has unticked is exactly the one whose
     readiness they want to read while deciding whether to tick it back on,
     and a locked seat cannot run here however it is ticked. */
  const seatProviders = AI_PROVIDERS.filter((seatProvider) => !isProviderLocked(settings, seatProvider));

  return (
    <div>
      {/* The shell already says "Settings" above the tabs, so this is the
          page's own name - the tab it sits under - at the smaller size. */}
      <header>
        <h2 className="text-2xl font-bold tracking-tight text-ink">General</h2>
        <p className="mt-1 text-sm text-muted">
          Configure builder defaults, enabled providers, output storage, the job analysis model, and how people
          contact you.
        </p>
      </header>

      {(error || successMessage) && (
        <div className="mt-6 space-y-3">
          {error && (
            <Notice tone="error" role="alert">
              {error}
            </Notice>
          )}
          {successMessage && (
            <Notice tone="success" role="status">
              {successMessage}
            </Notice>
          )}
        </div>
      )}

      <Section
        title="Output Storage"
        description="Generated resumes are saved under the base directory below, using the folder template you define."
      >
        <Field
          label="Base directory"
          htmlFor="output-base-dir"
          hint="Browse opens the folder picker on the backend machine, so mounted shared drives and network folders are selectable if that machine can access them."
        >
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              id="output-base-dir"
              type="text"
              value={form.outputBaseDir}
              onChange={(e) => setField('outputBaseDir', e.target.value)}
              disabled={savingSection === 'output' || isBrowsingDirectory}
              placeholder="/mnt/resume-archive"
              className="tl-input"
            />
            <button
              type="button"
              onClick={handleBrowseDirectory}
              disabled={savingSection === 'output' || isBrowsingDirectory}
              className="tl-button-quiet sm:min-w-36"
            >
              {isBrowsingDirectory ? 'Opening...' : 'Browse...'}
            </button>
          </div>
        </Field>

        <Field label="Folder template" htmlFor="output-path-template">
          <input
            id="output-path-template"
            type="text"
            value={form.outputPathTemplate}
            onChange={(e) => setField('outputPathTemplate', e.target.value)}
            disabled={savingSection === 'output'}
            placeholder="/{{date}}/{{profile name}}/{{company name}}"
            className="tl-input"
          />
          <Notice tone="neutral" className="mt-3 space-y-2">
            <div>
              <span className="font-medium">Supported tokens:</span>{' '}
              <code className={styles.code}>{'{{date}}'}</code>,{' '}
              <code className={styles.code}>{'{{profile name}}'}</code>,{' '}
              <code className={styles.code}>{'{{company name}}'}</code>,{' '}
              <code className={styles.code}>{'{{row number}}'}</code>,{' '}
              <code className={styles.code}>{'{{job title}}'}</code>
            </div>
            <div className="break-all">
              <span className="font-medium">Preview:</span> {outputPathPreview}
            </div>
            <div className="break-all">
              <span className="font-medium">Saved preview:</span> {settings.outputPathPreview}
            </div>
          </Notice>
        </Field>

        <div>
          <button
            type="button"
            onClick={handleSaveOutputStorage}
            disabled={savingSection !== null && savingSection !== 'output'}
            className="tl-button"
          >
            {savingSection === 'output' ? 'Saving...' : 'Save Output Storage'}
          </button>
        </div>
      </Section>

      {seatProviders.length > 0 && (
        <div className="tl-section">
          <div className="grid gap-4 lg:grid-cols-2">
            {seatProviders.map((seatProvider) => (
              <SubscriptionCard
                key={seatProvider}
                health={health}
                healthError={healthError}
                provider={seatProvider}
                title={getAIProviderLabel(seatProvider)}
                seatWindow={seatProvider === 'claude-cli'}
              />
            ))}
          </div>
        </div>
      )}

      <Section
        title="AI Providers"
        description={
          <>
            Disabled providers are hidden in Resume Builder and rejected by the backend. A{' '}
            {LOCK_ICON} provider is one this installation cannot run at all, and its switch is
            fixed until that changes on the server. Every provider is a subscription seat: the{' '}
            <code className={styles.code}>claude</code>, <code className={styles.code}>codex</code> or{' '}
            <code className={styles.code}>gemini</code> command-line tool, signed in on the server.
            Each row below shows what the provider reports right now.
          </>
        }
      >
        <ul className="tl-rows overflow-hidden">
          {AI_PROVIDERS.map((provider) => {
            const lock = settings.providerLocks.find((entry) => entry.id === provider);
            return (
              <li key={provider} className={lock ? 'bg-surface-muted' : undefined}>
                <label className="flex cursor-pointer items-center justify-between gap-4">
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-ink">
                      <span>
                        {lock && <span aria-hidden>{LOCK_ICON} </span>}
                        {getAIProviderLabel(provider)}
                      </span>
                      {lock && <Pill tone="amber">Locked</Pill>}
                    </span>
                    {/* One line, not two: the health probe for a locked provider
                        already answers "locked, and here is why", so rendering
                        the reason underneath it would just say it twice. */}
                    {lock ? (
                      // Plain, not amber. The badge beside the name already
                      // carries the status; colouring the explanation as well
                      // turns four lines of ordinary prose into an alarm about a
                      // situation nobody can or need do anything about here.
                      <span className="mt-1 block break-words text-sm text-muted">{lock.reason}</span>
                    ) : (
                      <span className="mt-1 block break-words text-sm text-muted">
                        {describeProviderHealth(health, provider, healthError)}
                      </span>
                    )}
                  </span>
                  {/* The stored preference still shows through, and is still what
                      comes back if the lock is ever lifted - it is just not
                      something to change while ticking it would change nothing. */}
                  <input
                    type="checkbox"
                    className="tl-check shrink-0"
                    checked={providerEnabled[provider]}
                    disabled={savingSection === 'providers' || Boolean(lock)}
                    onChange={(e) =>
                      setField('providersEnabled', { ...form.providersEnabled, [provider]: e.target.checked })
                    }
                  />
                </label>
              </li>
            );
          })}
        </ul>

        <div>
          <button
            type="button"
            onClick={handleSaveProviders}
            disabled={savingSection !== null && savingSection !== 'providers'}
            className="tl-button"
          >
            {savingSection === 'providers' ? 'Saving...' : 'Save AI Providers'}
          </button>
        </div>
      </Section>

      <Section title="Builder Defaults" description="These values seed the main resume builder when it loads.">
        <Field label="Default mode">
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                className="tl-check"
                checked={form.defaultMode === 'preview'}
                onChange={() => setField('defaultMode', 'preview')}
                disabled={savingSection === 'defaults'}
              />
              <span>Preview first</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                className="tl-check"
                checked={form.defaultMode === 'generate'}
                onChange={() => setField('defaultMode', 'generate')}
                disabled={savingSection === 'defaults'}
              />
              <span>Generate directly</span>
            </label>
          </div>
        </Field>

        <Field label="Default theme">
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                className="tl-check"
                checked={form.defaultTheme === 'light'}
                onChange={() => setField('defaultTheme', 'light')}
                disabled={savingSection === 'defaults'}
              />
              <span>Light</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                className="tl-check"
                checked={form.defaultTheme === 'dark'}
                onChange={() => setField('defaultTheme', 'dark')}
                disabled={savingSection === 'defaults'}
              />
              <span>Dark</span>
            </label>
          </div>
        </Field>

        <div className="space-y-4">
          <Field label="Default resume target">
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  className="tl-check"
                  checked={form.defaultResumeSelection === 'single'}
                  onChange={() => setField('defaultResumeSelection', 'single')}
                  disabled={savingSection === 'defaults'}
                />
                <span>Single profile</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  className="tl-check"
                  checked={form.defaultResumeSelection === 'all'}
                  onChange={() => setField('defaultResumeSelection', 'all')}
                  disabled={savingSection === 'defaults'}
                />
                <span>All profiles</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  className="tl-check"
                  checked={form.defaultResumeSelection === 'group'}
                  onChange={() => setField('defaultResumeSelection', 'group')}
                  disabled={savingSection === 'defaults'}
                />
                <span>Specific group</span>
              </label>
            </div>
          </Field>

          {form.defaultResumeSelection === 'single' && (
            <Field label="Default profile" htmlFor="default-profile">
              <div className="max-w-md">
                <select
                  id="default-profile"
                  value={form.defaultProfileId}
                  onChange={(e) => setField('defaultProfileId', e.target.value)}
                  disabled={savingSection === 'defaults'}
                  className="tl-input"
                >
                  <option value="">Choose automatically</option>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </div>
              {profiles.length === 0 && (
                <Notice tone="warn" className="mt-3">
                  No enabled profiles exist yet. Create one in Admin &gt; Profiles before setting a default.
                </Notice>
              )}
            </Field>
          )}

          {form.defaultResumeSelection === 'group' && (
            <Field label="Default group" htmlFor="default-group">
              <div className="max-w-md">
                <select
                  id="default-group"
                  value={form.defaultGroupId}
                  onChange={(e) => setField('defaultGroupId', e.target.value)}
                  disabled={savingSection === 'defaults'}
                  className="tl-input"
                >
                  <option value="">Choose a group...</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name} ({group.profileIds.length})
                    </option>
                  ))}
                </select>
              </div>
              {groups.length === 0 && (
                <Notice tone="warn" className="mt-3">
                  No groups exist yet. Create one in Admin &gt; Groups before using this default.
                </Notice>
              )}
            </Field>
          )}
        </div>

        <Field label="Default AI model" htmlFor="default-model">
          <div className="max-w-xl">
            <select
              id="default-model"
              value={form.defaultModelId}
              onChange={(e) => setField('defaultModelId', e.target.value)}
              disabled={savingSection === 'defaults' || availableDefaultModels.length === 0}
              className="tl-input"
            >
              {availableDefaultModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {`${getAIProviderLabel(model.provider)} · ${model.name} (${model.modelName})`}
                </option>
              ))}
            </select>
          </div>
          <p className="mt-2 text-sm text-subtle">
            This is the default model used by Resume Builder when no prompt-level override is set.
          </p>
          {availableDefaultModels.length === 0 && (
            <Notice tone="warn" className="mt-3">
              No enabled models are currently available. Add one in Settings &gt; Models or re-enable a provider.
            </Notice>
          )}
        </Field>

        <Field label="Default generated files">
          <p className="text-sm text-muted">
            PDF files are always generated. Enable DOCX only for the outputs you want by default.
          </p>
          <div className="mt-3 space-y-2 text-sm text-ink">
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                className="tl-check"
                checked={form.defaultResumeDocxEnabled}
                onChange={(e) => setField('defaultResumeDocxEnabled', e.target.checked)}
                disabled={savingSection === 'defaults'}
              />
              <span>Generate DOCX resume by default</span>
            </label>
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                className="tl-check"
                checked={form.defaultCoverLetterDocxEnabled}
                onChange={(e) => setField('defaultCoverLetterDocxEnabled', e.target.checked)}
                disabled={savingSection === 'defaults'}
              />
              <span>Generate DOCX cover letter by default</span>
            </label>
          </div>
        </Field>

        <div>
          <button
            type="button"
            onClick={handleSaveDefaults}
            disabled={savingSection !== null && savingSection !== 'defaults'}
            className="tl-button"
          >
            {savingSection === 'defaults' ? 'Saving...' : 'Save Builder Defaults'}
          </button>
        </div>
      </Section>

      <Section
        title="Job Analysis"
        description="Each job posting is analysed once, by this model, and never again: every profile, model, order and Job Filter run that needs the posting builds on that one analysis, so every posting is read - and classified into a job field - the same way."
      >
        <Field
          label="Analysis model"
          htmlFor="analysis-model"
          hint="Changing it changes how postings never analysed before are read. Stored analyses are kept as they are; nothing is analysed again."
        >
          <div className="max-w-xl">
            <select
              id="analysis-model"
              value={form.analysisModelId}
              onChange={(e) => setField('analysisModelId', e.target.value)}
              disabled={savingSection === 'analysis'}
              className="tl-input"
            >
              <option value="">{defaultModelName ? `App default model (${defaultModelName})` : 'App default model'}</option>
              {analysisModelStale && (
                <option value={form.analysisModelId}>
                  {chosenAnalysisModel ? `${chosenAnalysisModel.name} (cannot run here)` : `Saved model (${form.analysisModelId})`}
                </option>
              )}
              {availableDefaultModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {`${model.name} (${getAIProviderLabel(model.provider)})`}
                </option>
              ))}
            </select>
          </div>
          {analysisModelStale && (
            <Notice tone="warn" className="mt-3">
              {chosenAnalysisModel ? `"${chosenAnalysisModel.name}"` : 'The saved analysis model'} cannot run here - it
              is switched off, or its provider is switched off or locked - so postings are analysed on the app
              default model until it can, or another is chosen.
            </Notice>
          )}
        </Field>

        <div>
          <button
            type="button"
            onClick={handleSaveAnalysisModel}
            disabled={savingSection !== null && savingSection !== 'analysis'}
            className="tl-button"
          >
            {savingSection === 'analysis' ? 'Saving...' : 'Save Analysis Model'}
          </button>
        </div>
      </Section>

      <ContactEditor />
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
export default function AdminSettingsPage() {
  return (
    <AdminOnly>
      <AdminSettingsPageBody />
    </AdminOnly>
  );
}
