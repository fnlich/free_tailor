'use client';

import { useEffect, useState } from 'react';
import { AdminOnly } from '@/components/auth/AuthGate';
import ContactEditor from '@/components/contact/ContactEditor';
import OutputPathBox from '@/components/settings/OutputPathBox';
import SettingSource from '@/components/ui/SettingSource';
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
import { OUTPUT_PREFIX_TOKEN_CHIPS } from '@/lib/outputPath';
import { appSettingSourceLabel, canReset, changedSettings, resetBody, type AppSettingKey } from '@/lib/settingSources';
import { ApiResponseError } from '@/lib/api';
import { Card, ErrorNotice, Field, Notice, Pill, Section, Spinner } from '@/components/ui/kit';
import { messageWithDetail } from '@/lib/userMessage';
import { seatHolds } from '@/lib/seatHolds';
import {
  describeLane,
  describeSignIn,
  describeTypeHealth,
  PROVIDER_TYPE_NAMES,
  type AdminAIProvider,
} from '@/lib/providerDisplay';
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
  outputPathPrefix: string;
};

type SaveSection = 'output' | 'providers' | 'defaults' | 'reset';

/** The Builder Defaults fields that have a `.env` default: each shows where it came from, and saves only when changed. */
const BUILDER_SETTING_KEYS = [
  'defaultMode',
  'defaultTheme',
  'defaultResumeSelection',
  'defaultModelId',
  'defaultResumeDocxEnabled',
  'defaultCoverLetterDocxEnabled',
] as const satisfies readonly AppSettingKey[];

/** The Output Storage fields, likewise. */
const OUTPUT_SETTING_KEYS = ['outputBaseDir', 'outputPathPrefix'] as const satisfies readonly AppSettingKey[];

/**
 * A type's row: its one provider's own words, or - with several, each a
 * sign-in of its own - how many of them can take work now.
 */
function describeProviderHealth(
  health: ProviderHealthReport | null,
  provider: AIProvider,
  healthError = ''
): string {
  if (healthError) return `Could not read provider status: ${healthError}`;
  if (!health) return 'Checking the sign-in on the server...';
  return describeTypeHealth(health.providers, provider);
}

function formatPercent(value: number | null): string {
  return value === null ? 'unknown' : `${Math.round(value * 100)}%`;
}

/**
 * Readiness of one PROVIDER - one sign-in of a seat's CLI.
 *
 * A seat fails in ways a settings form cannot see - the binary is not on PATH,
 * the sign-in expired, the five-hour window is spent - so each one gets a card
 * that says which.
 *
 * One card per provider, not per type: two Claude providers are two sign-ins
 * (Admin -> Models -> Providers), and one signed out says nothing about the
 * other. Hard-coded to `claude-cli`, this card once left the Codex seat with
 * no readiness anywhere: the numbers were already on the wire and simply never
 * read, so an operator whose `codex` was unsigned-in or off PATH had nothing
 * on the page saying so.
 *
 * `seatWindow` is opt-in for the same honest reason: `subscription` on the wire
 * is ONE object, the built-in Claude provider's, because only that CLI reports
 * a usage window - inventing the shape of one nobody has seen produces a
 * confidently wrong message at the worst moment. An absent window on the other
 * cards is the truth; an absent in-flight row was not.
 *
 * Holds are per provider - see `seatHolds`.
 */
function SubscriptionCard({
  health,
  healthError,
  provider: entry,
  sharesType,
  seatWindow = false,
}: {
  health: ProviderHealthReport | null;
  healthError: string;
  provider: AdminAIProvider;
  /** Another provider of its type exists, so the type's call totals are not this one's alone. */
  sharesType: boolean;
  seatWindow?: boolean;
}) {
  const providerId = entry.id;
  const provider = health?.providers.find((item) => item.id === providerId);
  const seat = seatWindow ? health?.subscription.seat ?? undefined : undefined;
  const outages = seatHolds(health, providerId);
  // Calls are counted per TYPE (a model is a type's), so with two providers
  // of one type the line says it is both of theirs rather than crediting one
  // with the other's calls.
  const usage = health?.usage.byProvider[entry.type];
  // In flight is this provider's own: its own limit, its own semaphore.
  const concurrency = health?.concurrency[providerId];
  const lane = describeLane(provider?.queue ?? null);
  const title = entry.builtIn ? entry.label : `${entry.label} (${PROVIDER_TYPE_NAMES[entry.type]})`;

  // The seat's state as a coloured dot beside its name - the colours live in
  // page.module.css, stated for both themes.
  const tone = healthError
    ? 'error'
    : !health
    ? 'unknown'
    : !entry.enabled
      ? 'unknown'
      : provider?.ok && provider.ready && !provider.warning
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
              {describeSignIn(provider?.authMethod)}
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
            <dt className="text-subtle">Resumes</dt>
            <dd className="text-ink">{lane || 'none waiting'}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-subtle">
              {sharesType ? `Calls this run, all ${PROVIDER_TYPE_NAMES[entry.type]}` : 'Calls this run'}
            </dt>
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
    outputPathPrefix: settings.outputPathPrefix,
  };
}

/** The box a Reset to default puts back, from the settings it answered with. */
function pickResetField(updated: AdminAppSettings, key: AppSettingKey): Partial<SettingsFormState> {
  switch (key) {
    case 'defaultMode':
    case 'defaultTheme':
    case 'defaultResumeSelection':
    case 'defaultModelId':
    case 'defaultResumeDocxEnabled':
    case 'defaultCoverLetterDocxEnabled':
    case 'outputBaseDir':
    case 'outputPathPrefix':
      return { [key]: updated[key] };
    default:
      return {};
  }
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
      outputPathPrefix: updated.outputPathPrefix,
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

function AdminSettingsPageBody() {
  const [settings, setSettings] = useState<AdminAppSettings | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [form, setForm] = useState<SettingsFormState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [savingSection, setSavingSection] = useState<SaveSection | null>(null);
  const [isBrowsingDirectory, setIsBrowsingDirectory] = useState(false);
  const [error, setError] = useState('');
  /** A save's refusal of the output prefix, in the server's words, under its box until it is edited. */
  const [prefixRefusal, setPrefixRefusal] = useState('');
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
      if ('defaultTheme' in payload) {
        applySavedThemeDefault(updated.defaultTheme);
      }
      setSuccessMessage(nextMessage);
      return true;
    } catch (err) {
      // The server names the prefix box when it refuses one: the sentence goes under it.
      if (err instanceof ApiResponseError && err.body?.field === 'outputPathPrefix') {
        setPrefixRefusal(err.message);
      } else {
        setError(messageWithDetail(err, 'Failed to update settings'));
      }
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

  /**
   * Reset to default: the field sent as `null`, a save of its own. The value
   * in effect comes back from .env, or the code, and the box shows it.
   */
  const handleReset = async (key: AppSettingKey, name: string) => {
    if (!form) return;
    try {
      setSavingSection('reset');
      setError('');
      setSuccessMessage('');
      const updated = await adminApi.updateSettings(resetBody(key));
      setSettings(updated);
      setForm((current) => (current ? { ...current, ...pickResetField(updated, key) } : toFormState(updated)));
      if (key === 'outputPathPrefix') setPrefixRefusal('');
      if (key === 'defaultTheme') applySavedThemeDefault(updated.defaultTheme);
      setSuccessMessage(`${name} reset to its default.`);
    } catch (err) {
      setError(messageWithDetail(err, `Could not reset ${name.toLowerCase()}`));
    } finally {
      setSavingSection(null);
    }
  };

  const handleSaveOutputStorage = async () => {
    if (!form || !settings) return;
    // Only what changed: a box saved as it came would stop following .env.
    const changes = changedSettings(
      { outputBaseDir: form.outputBaseDir.trim(), outputPathPrefix: form.outputPathPrefix.trim() },
      settings,
      OUTPUT_SETTING_KEYS
    );
    if (Object.keys(changes).length === 0) {
      setSuccessMessage('Nothing to save: the output folder and prefix are as they were.');
      return;
    }
    await saveSection('output', changes, 'Output storage saved.');
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

    if (!settings) return;
    const intended = {
      ...form,
      defaultGroupId: form.defaultResumeSelection === 'group' ? form.defaultGroupId : '',
      defaultProfileId: form.defaultResumeSelection === 'single' ? form.defaultProfileId : '',
    };
    /*
     * Only what changed. The six with a .env default are stored only once an
     * administrator sets them, so sending one unchanged would freeze the
     * value .env gives today; the group and profile have no .env default and
     * go with them when they changed.
     */
    const changes = changedSettings(intended, settings, [...BUILDER_SETTING_KEYS, 'defaultGroupId', 'defaultProfileId']);
    if (Object.keys(changes).length === 0) {
      setSuccessMessage('Nothing to save: the builder defaults are as they were.');
      return;
    }
    await saveSection('defaults', changes, 'Builder defaults saved.');
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
  const sources = settings.settingSources;
  const defaults = settings.settingDefaults;
  const resetting = savingSection === 'reset';
  /** A box's source line: where its value came from and, while it is set here, Reset to default. */
  const sourceOf = (key: AppSettingKey, name: string, gives: string) => (
    <SettingSource
      label={appSettingSourceLabel(sources, key)}
      resettable={canReset(sources[key])}
      gives={gives}
      name={name.toLowerCase()}
      busy={resetting}
      onReset={() => void handleReset(key, name)}
    />
  );
  const modelName = (id: string) => settings.aiModels.find((model) => model.id === id)?.name || id || 'no model';
  const onOff = (value: boolean) => (value ? 'on' : 'off');
  const MODE_LABELS = { preview: 'Preview first', generate: 'Generate directly' } as const;
  const TARGET_LABELS = { single: 'Single profile', all: 'All profiles', group: 'Specific group' } as const;
  /* One card per PROVIDER of every type this installation could run - two
     Claude sign-ins are two cards. Keyed on the LOCK, not on the enabled
     tick: a seat an admin has unticked is exactly the one whose readiness
     they want to read while deciding whether to tick it back on, and a locked
     seat cannot run here however it is ticked. */
  const seatProviders: AdminAIProvider[] = settings.aiProviders.filter((entry) => !isProviderLocked(settings, entry.type));
  const providersOfType = (type: AIProvider) => seatProviders.filter((entry) => entry.type === type).length;

  return (
    <div>
      {/* The shell already says "Settings" above the tabs, so this is the
          page's own name - the tab it sits under - at the smaller size. */}
      <header>
        <h2 className="text-2xl font-bold tracking-tight text-ink">General</h2>
        <p className="mt-1 text-sm text-muted">
          Configure builder defaults, enabled providers, where resumes are filed, and how people contact you. Each
          setting says where its value comes from: set here, a line of the server&apos;s .env, or the built-in
          default - and Reset to default hands one set here back to .env. The default and analysis models are
          chosen under Models.
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
        description={
          <>
            Every resume is filed under the output folder, then the prefix below, then the folder path of the account
            that ordered it - <code className={styles.code}>{'<output folder>/<prefix>/<folder path>/<file>'}</code>.
            Each account sets its own folder path under Settings, Profile, Resume files.
          </>
        }
      >
        <Field
          label="Output folder"
          htmlFor="output-base-dir"
          hint="An absolute folder on the server. Browse opens the folder picker on the backend machine, so mounted shared drives and network folders are selectable if that machine can access them."
        >
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              id="output-base-dir"
              type="text"
              value={form.outputBaseDir}
              onChange={(e) => setField('outputBaseDir', e.target.value)}
              disabled={savingSection === 'output' || isBrowsingDirectory}
              placeholder="/mnt/resume-archive"
              className="tl-input font-mono"
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
          {sourceOf('outputBaseDir', 'Output folder', defaults.outputBaseDir)}
        </Field>

        <OutputPathBox
          id="output-path-prefix"
          label="Output prefix"
          value={form.outputPathPrefix}
          onChange={(next) => {
            setField('outputPathPrefix', next);
            setPrefixRefusal('');
          }}
          chips={OUTPUT_PREFIX_TOKEN_CHIPS}
          preview={(text, signal) => adminApi.previewOutputPrefix(text, signal)}
          placeholder="/{{user_email}}/{{order_number}}"
          disabled={savingSection === 'output'}
          refusal={prefixRefusal}
          hint={
            <>
              The first folders of every resume&apos;s path, the same for everybody. It may use{' '}
              <code className={styles.code}>{'{{user_email}}'}</code>,{' '}
              <code className={styles.code}>{'{{order_number}}'}</code> and{' '}
              <code className={styles.code}>{'{{date}}'}</code>, with text around them, and must hold{' '}
              <code className={styles.code}>{'{{order_number}}'}</code> exactly once, alone in its folder - it is what
              gives every run a folder of its own, and what says whose a file is. The preview adds the default folder
              path after it, with sample values. A run keeps the folder it was placed in; a change reaches only the
              runs placed after it.
            </>
          }
          source={sourceOf('outputPathPrefix', 'Output prefix', defaults.outputPathPrefix)}
        />

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
                key={seatProvider.id}
                health={health}
                healthError={healthError}
                provider={seatProvider}
                sharesType={providersOfType(seatProvider.type) > 1}
                seatWindow={seatProvider.id === 'claude-cli'}
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
            <code className={styles.code}>gemini</code> command-line tool, signed in on the server - more
            than one sign-in of a type are added, changed and removed under Models, Providers, and a type
            whose every provider is switched off there runs nothing. Each row below shows what the type
            reports right now.
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
          {sourceOf('defaultMode', 'Default mode', MODE_LABELS[defaults.defaultMode])}
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
          {sourceOf('defaultTheme', 'Default theme', defaults.defaultTheme === 'dark' ? 'Dark' : 'Light')}
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
            {sourceOf('defaultResumeSelection', 'Default resume target', TARGET_LABELS[defaults.defaultResumeSelection])}
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
          {sourceOf('defaultModelId', 'Default model', modelName(defaults.defaultModelId))}
          <p className="mt-2 text-sm text-subtle">
            This is the default model used by Resume Builder when no prompt-level override is set. Models also
            sets it, and the model job postings are analysed on.
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
          <div className="grid gap-x-6 sm:grid-cols-2">
            <div>
              <p className="mt-3 text-xs font-medium text-muted">DOCX resume</p>
              {sourceOf('defaultResumeDocxEnabled', 'DOCX resume default', onOff(defaults.defaultResumeDocxEnabled))}
            </div>
            <div>
              <p className="mt-3 text-xs font-medium text-muted">DOCX cover letter</p>
              {sourceOf(
                'defaultCoverLetterDocxEnabled',
                'DOCX cover letter default',
                onOff(defaults.defaultCoverLetterDocxEnabled)
              )}
            </div>
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
