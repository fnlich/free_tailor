'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { AdminOnly } from '@/components/auth/AuthGate';
import {
  AI_PROVIDERS,
  adminApi,
  // The browser-mode switch has to govern exactly the set the backend gate
  // does, so the list comes from there rather than being retyped here.
  BROWSER_CHAT_PROVIDERS,
  AdminAppSettings,
  AdminAppSettingsUpdate,
  BrowserChatEndpoint,
  DebugBrowserReport,
  AIProvider,
  DefaultMode,
  DefaultResumeSelection,
  getAIProviderLabel,
  Group,
  groupsApi,
  isPlatformActive,
  isProviderLocked,
  isProviderOffered,
  LOCK_ICON,
  Profile,
  profilesApi,
  ProviderHealthReport,
  ThemeMode,
} from '@/lib/api';
import { applyTheme, getStoredTheme, setStoredDefaultTheme } from '@/lib/theme';
import { Card, Field, Notice, Pill, Section, Spinner, Status } from '@/components/ui/kit';
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
  browserChatEndpoints: BrowserChatEndpoint[];
};

type SaveSection = 'output' | 'providers' | 'defaults' | 'browserChat' | 'modelControls';

/**
 * A switch that saves the moment it is flipped.
 *
 * No Save button, unlike the sections around it: these two withdraw a control
 * from every other page in the app, so "did that take?" is a question worth
 * answering immediately rather than after a second click somewhere below.
 */
function SettingSwitch({
  id,
  checked,
  onChange,
  disabled,
  title,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
  title: string;
  children: ReactNode;
}) {
  // A choice box, so the explanation sits inside the thing being switched.
  return (
    <label className="tl-choice" data-on={checked} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{title}</span>
        <span className="mt-1 block text-sm text-muted">{children}</span>
      </span>
    </label>
  );
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
 * Readiness of one subscription seat.
 *
 * A seat fails in ways an API key cannot - the binary is not on PATH, the
 * sign-in expired, the five-hour window is spent - and none of those are
 * visible from a settings page that only knows how to render a key.
 *
 * Takes the PROVIDER, because there are two seats now. Hard-coded to
 * `claude-cli`, this card left the Codex seat with no readiness anywhere: the
 * numbers were already on the wire (`concurrency` and `usage.byProvider` are
 * both keyed per provider) and simply never read, so an operator whose `codex`
 * was unsigned-in or off PATH had nothing on the page saying so.
 *
 * `seatWindow` is opt-in for the same honest reason: `subscription` on the wire
 * is ONE object, the Claude adapter's, because the Codex adapter deliberately
 * models no usage window or outage table - inventing the shape of a refusal
 * nobody has seen produces a confidently wrong message at the worst moment. An
 * absent window on the Codex card is the truth; an absent in-flight row was not.
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
  const outages = seatWindow ? health?.subscription.outages ?? [] : [];
  // This provider's own numbers. The process-wide totals include every metered
  // provider, and reporting those here would credit them to the seat.
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
              {provider?.authMethod === 'oauth_token' ? 'Subscription (OAuth)' : provider?.authMethod ?? 'unknown'}
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
    browserChatEndpoints: settings.browserChatEndpoints.map((entry) => ({ ...entry })),
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

  if (section === 'browserChat') {
    return {
      ...current,
      browserChatEndpoints: updated.browserChatEndpoints.map((entry) => ({ ...entry })),
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
  const [debugReport, setDebugReport] = useState<DebugBrowserReport | null>(null);
  const [debugError, setDebugError] = useState('');
  const [debugCheckedAt, setDebugCheckedAt] = useState('');
  const [isChecking, setIsChecking] = useState(false);
  const [newBrowserSite, setNewBrowserSite] = useState<AIProvider>('claude-web');
  const [newBrowserPort, setNewBrowserPort] = useState('');
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

      /*
       * The debug-browser reading, and only once the settings say to.
       *
       * It used to fire from the mount effect, before this call had resolved, so
       * every load of this page probed the debug ports even on an install with
       * browser mode off - where the panel that would show the answer is not
       * rendered at all. Moved here because that flag is the thing that decides,
       * and it is not known until now.
       *
       * Still fire-and-forget: probing a port is a round trip that can simply
       * not answer, and the form must render either way. Silent on failure -
       * nothing listening is the ordinary state before the operator presses the
       * button, and a banner on arrival would read as something being broken.
       */
      if (settingsData.browserChatEnabled) {
        adminApi
          .getDebugBrowsers()
          .then((report) => {
            setDebugReport(report);
            setDebugError('');
          })
          .catch(() => setDebugReport(null));
      }
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
      setError(err instanceof Error ? err.message : 'Failed to update settings');
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

  /**
   * Re-reads the browser state, and the sign-in state alongside it.
   *
   * Both, because "active" is the two together: a port probe says a window is
   * up, and only the provider health check knows whether its tab is signed in.
   * Refreshing one without the other leaves the panel disagreeing with itself.
   *
   * It also stamps when it ran. Nothing re-probes on its own any more - the app
   * no longer starts these browsers, so there is no success moment to hang a
   * refresh on - and a panel that says "not running" with no indication of how
   * old that reading is looks broken right after a successful script run.
   */
  const refreshDebugBrowsers = async () => {
    setIsChecking(true);
    try {
      const [report, healthReport] = await Promise.all([
        adminApi.getDebugBrowsers(),
        adminApi.getAiHealth().catch((err: unknown) => (err instanceof Error ? err : new Error('failed'))),
      ]);
      setDebugReport(report);
      const healthOk = !(healthReport instanceof Error);
      if (healthOk) {
        setHealth(healthReport);
        setHealthError('');
      } else {
        // Said out loud rather than swallowed. Active/Not active comes from
        // this half, so a silent failure would leave the last reading on
        // screen under a timestamp claiming it was just checked.
        setHealthError(healthReport.message || 'Could not read provider status');
      }
      setDebugError('');
      setDebugCheckedAt(
        `${new Date().toLocaleTimeString()}${healthOk ? '' : ' (ports only - sign-in check failed)'}`
      );
    } catch (err) {
      setDebugReport(null);
      setDebugError(err instanceof Error ? err.message : 'Could not check the debug browsers');
    } finally {
      setIsChecking(false);
    }
  };

  /**
   * Registering a port WRITES, rather than staging an edit to be saved later.
   *
   * This list is not a preference - it is the address book the providers send
   * requests to, and now also the list the launcher script reads. While a Start
   * button existed it saved the list as a side effect of starting a browser, so
   * the two could not drift far. Without it, a staged edit means an operator
   * adds a port, switches to a terminal, runs the script, and the script starts
   * the OLD list with nothing anywhere saying why.
   */
  const registerBrowser = async () => {
    if (!form) return;
    const port = Number.parseInt(newBrowserPort.trim(), 10);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setDebugError('The debug port must be a whole number between 1024 and 65535.');
      return;
    }
    if (form.browserChatEndpoints.some((entry) => entry.port === port)) {
      setDebugError(
        `Port ${port} is already registered. One browser shows one chat tab, so each port ` +
          'belongs to exactly one site.'
      );
      return;
    }
    setDebugError('');
    const next = [...form.browserChatEndpoints, { siteId: newBrowserSite, port }];
    const saved = await saveSection(
      'browserChat',
      { browserChatEndpoints: next },
      `Registered ${getAIProviderLabel(newBrowserSite)} on port ${port}. Run npm run browser:debug to start it.`
    );
    if (!saved) {
      // Keep what they typed. Clearing it on failure means retyping the port to
      // retry, and the reason is a banner three sections up the page.
      setDebugError(`Port ${port} was not registered - see the error above.`);
      return;
    }
    setNewBrowserPort('');
    // Re-read, because the row list and the Active panel come from different
    // places: the rows render the form, which has just changed, and the panel
    // renders the server's report, which has not. Without this the panel keeps
    // saying "no debug port registered" directly under the row that was just
    // registered. Not awaited - the panel says "Checking..." while it settles.
    void refreshDebugBrowsers();
  };

  const unregisterBrowser = async (port: number) => {
    if (!form) return;
    setDebugError('');
    await saveSection(
      'browserChat',
      { browserChatEndpoints: form.browserChatEndpoints.filter((entry) => entry.port !== port) },
      `Unregistered port ${port}. A browser already running on it is not closed.`
    );
    void refreshDebugBrowsers();
  };

  const handleSaveProviders = async () => {
    if (!form || !settings) return;
    // `isProviderOffered`, not just the lock: a browser provider ticked before
    // browser mode was switched off keeps its stored `true` (its row is not
    // rendered, so nothing unticks it), and counting it here let an admin untick
    // everything else and save an install where nothing could actually run.
    const runnable = AI_PROVIDERS.filter(
      (provider) => isProviderOffered(settings, provider, form.providersEnabled)
    );
    if (runnable.length === 0) {
      setError(
        'At least one AI provider that can run here must remain enabled. Locked providers, and the ' +
          'browser ones while browser mode is off, cannot run however they are ticked.'
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

  if (isLoading || !form || !settings) {
    return <Spinner />;
  }

  const providerEnabled = form.providersEnabled;
  // Admin settings carry the RAW model list so every record stays manageable,
  // so the offer rule has to be applied here rather than relied on upstream.
  const availableDefaultModels = settings.aiModels.filter(
    (model) => model.enabled && isProviderOffered(settings, model.provider, providerEnabled)
  );
  const outputPathPreview = buildPathPreview(form.outputPathTemplate);
  /* One card per seat this installation could run. Keyed on the LOCK, not on
     the enabled tick: a seat an admin has unticked is exactly the one whose
     readiness they want to read while deciding whether to tick it back on,
     and a locked seat cannot run here however it is ticked. */
  const seatProviders = (['claude-cli', 'codex-cli'] as const).filter(
    (seatProvider) => !isProviderLocked(settings, seatProvider)
  );

  return (
    <div>
      {/* The shell already says "Settings" above the tabs, so this is the
          page's own name - the tab it sits under - at the smaller size. */}
      <header>
        <h2 className="text-2xl font-bold tracking-tight text-ink">General</h2>
        <p className="mt-1 text-sm text-muted">
          Configure builder defaults, enabled providers, and output storage.
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
                title={seatProvider === 'codex-cli' ? 'ChatGPT Subscription (Codex)' : 'Claude Subscription'}
                seatWindow={seatProvider === 'claude-cli'}
              />
            ))}
          </div>
        </div>
      )}

      <Section
        title="Model controls"
        description="What the model select offers, everywhere it appears - the builder and every profile alike."
      >
        <SettingSwitch
          id="browserChatEnabled"
          checked={settings.browserChatEnabled}
          disabled={savingSection !== null}
          onChange={(next) =>
            void saveSection(
              'modelControls',
              { browserChatEnabled: next },
              next
                ? 'Browser mode is offered again.'
                : 'Browser mode is hidden, and no request can reach it.'
            )
          }
          title="Offer browser-tab mode"
        >
          <strong>Default (browser)</strong> needs a Chrome running on this server that you have
          signed in to by hand, which a headless box cannot have. Switch this off and the option
          disappears from every model menu - here and on the builder - and a request naming it is
          refused rather than left waiting for a browser that will never answer. The per-site
          preferences below are kept, so switching it back on restores them.
        </SettingSwitch>
      </Section>

      {/* Gone entirely when browser mode is off, rather than greyed: there is
          nothing here to read or fix on an installation that has withdrawn it,
          and the switch that brings it back lives in Model controls above - so
          hiding this cannot strand anyone. */}
      {settings.browserChatEnabled && (
        <Section
          title="Browser Chat (free)"
          description={
            <>
              <strong>Default (browser)</strong> drives chat tabs in browsers you start here and
              sign in to yourself. Nothing is metered and no API key is stored - the chat plan you
              already have is the quota. Claude and ChatGPT are both used; which one a given resume
              lands on is whichever browser is free, so there is one choice to make rather than
              three.
              {/* A block span rather than a second <p>: the kit puts the
                  description inside one paragraph already. */}
              <span className="mt-2 block">
                One browser shows <strong>one</strong> chat tab, on its own port. That is not a
                preference: a second tab in the same window is a background tab, and Chrome freezes
                those. So <strong>every browser you add runs one more resume at a time</strong>.
                There are two queues - one shared by every browser, one for the Claude CLI seat - and
                neither has a length limit: whenever a browser frees, it takes the task that has
                waited longest.
              </span>
            </>
          }
        >
          {form.browserChatEndpoints.length === 0 ? (
            <Notice tone="neutral">
              No debug ports registered yet. Register one below, then start it with{' '}
              <code className={styles.code}>npm run browser:debug</code> and sign in.
            </Notice>
          ) : (
            <ul className="tl-rows">
              {form.browserChatEndpoints.map((entry) => {
                const live = debugReport?.browsers.find((row) => row.port === entry.port);
                const site = live?.status.sites.find((row) => row.id === entry.siteId);
                return (
                  <li key={entry.port} className="flex flex-wrap items-center gap-3">
                    <span className="min-w-[9rem] text-sm font-medium text-ink">
                      {getAIProviderLabel(entry.siteId)}
                    </span>
                    <span className="text-sm text-muted">port {entry.port}</span>
                    <span className="text-sm">
                      {!live || !live.status.running ? (
                        <Pill tone="grey">not running</Pill>
                      ) : site?.open ? (
                        <Pill tone="green">running, tab open</Pill>
                      ) : (
                        <Pill tone="amber">running, no tab yet</Pill>
                      )}
                    </span>
                    <span className="ml-auto flex gap-2">
                      <button
                        type="button"
                        onClick={() => void unregisterBrowser(entry.port)}
                        disabled={savingSection !== null}
                        className="tl-button-quiet"
                        data-size="sm"
                      >
                        Unregister
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full sm:w-56">
              <label className="tl-label" htmlFor="newBrowserSite">
                Register a browser for
              </label>
              <select
                id="newBrowserSite"
                value={newBrowserSite}
                onChange={(event) => setNewBrowserSite(event.target.value as AIProvider)}
                className="tl-input mt-2"
              >
                {BROWSER_CHAT_PROVIDERS.map((provider) => (
                  <option key={provider} value={provider}>
                    {getAIProviderLabel(provider)}
                  </option>
                ))}
              </select>
            </div>
            <div className="w-32">
              <label className="tl-label" htmlFor="newBrowserPort">
                on port
              </label>
              <input
                id="newBrowserPort"
                type="number"
                min={1024}
                max={65535}
                value={newBrowserPort}
                placeholder="9222"
                onChange={(event) => setNewBrowserPort(event.target.value)}
                className="tl-input mt-2"
              />
            </div>
            <button
              type="button"
              onClick={() => void registerBrowser()}
              disabled={savingSection !== null}
              className="tl-button"
            >
              {savingSection === 'browserChat' ? 'Registering...' : 'Register'}
            </button>
            <button
              type="button"
              onClick={() => void refreshDebugBrowsers()}
              disabled={isChecking || savingSection !== null}
              className="tl-button-quiet"
              // The primary beside it is 2.5rem; matched here, inline, because
              // .tl-button-quiet is unlayered and outranks a min-h utility.
              style={{ minHeight: '2.5rem' }}
            >
              {isChecking ? 'Checking...' : 'Check status'}
            </button>
            {debugCheckedAt ? (
              <span className="self-center text-xs text-subtle">
                Last checked {debugCheckedAt}
              </span>
            ) : null}
          </div>

          {/* The answer to "is this thing working", above the per-port detail.
              A registered port with a running browser and an open tab can still
              be SIGNED OUT, so `active` comes from the provider's own probe
              rather than from the port. */}
          {debugReport ? (
            <ul className="grid gap-3 sm:grid-cols-2">
              {debugReport.platforms.map((platform) => {
                // Three states, not two. The port probe answers in milliseconds
                // and the health check shells out and drives a tab, so for the
                // seconds between them `health` is null - and rendering that as
                // "Not active" tells an operator whose browsers are all fine
                // that they are not, before flipping. "Checking" is the honest
                // reading of "the answer has not arrived".
                const healthKnown = health !== null || Boolean(healthError);
                const active = isPlatformActive(health, platform);
                const state =
                  platform.registeredPorts.length === 0
                    ? 'unregistered'
                    : !healthKnown
                      ? 'checking'
                      : active
                        ? 'active'
                        : 'inactive';
                return (
                  <li key={platform.id} className="tl-card p-4">
                    <div className="flex items-center gap-2">
                      {/* The frontend's label, not the one the server sent.
                          The rows above render getAIProviderLabel, and the two
                          vocabularies differ, so using the server's would put
                          one provider under two names in a single panel. */}
                      <span className="text-sm font-medium text-ink">
                        {getAIProviderLabel(platform.id)}
                      </span>
                      <span className="ml-auto">
                        <Pill tone={state === 'active' ? 'green' : state === 'checking' ? 'sky' : 'grey'}>
                          {state === 'active'
                            ? 'Active'
                            : state === 'checking'
                              ? 'Checking...'
                              : 'Not active'}
                        </Pill>
                      </span>
                    </div>
                    <p className="mt-2 break-words text-xs text-muted">
                      {state === 'unregistered'
                        ? 'No debug port registered for this platform yet. Register one below.'
                        : describeProviderHealth(health, platform.id, healthError)}
                    </p>
                    {platform.registeredPorts.length > 0 && (
                      <p className="mt-1 text-xs text-subtle">
                        {`Port${platform.registeredPorts.length === 1 ? '' : 's'} ` +
                          `${platform.registeredPorts.join(', ')} registered · ` +
                          `${platform.runningPorts.length} reachable · ` +
                          `${platform.tabPorts.length} showing the site`}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}

          {debugReport && Object.keys(debugReport.queues).length > 0 ? (
            <div className="tl-card p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-subtle">Queues</p>
              <ul className="mt-2 space-y-1">
                {Object.entries(debugReport.queues).map(([siteId, stats]) => (
                  <li key={siteId} className="text-sm text-muted">
                    {getAIProviderLabel(siteId as AIProvider)}: {stats.tabs} tab
                    {stats.tabs === 1 ? '' : 's'}, {stats.inUse} in use, {stats.queued} waiting
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <Notice tone="neutral">
            <p className="font-medium">Starting these browsers</p>
            <p className="mt-1 text-muted">
              This app never starts one. Register the port here, then run the launcher yourself on
              the machine the backend is on:
            </p>
            <pre className={styles.command}>npm run browser:debug</pre>
            <p className="mt-2 text-muted">
              It starts every browser registered above, skipping any already running, and opens each
              one on its own chat site. Sign in inside each window once and leave it open. Each gets
              a profile directory of its own, because Chrome ignores the debug port on a profile
              that is already running.
            </p>
          </Notice>

          {debugError ? <Status tone="error">{debugError}</Status> : null}
        </Section>
      )}

      <Section
        title="AI Providers"
        description={
          <>
            Disabled providers are hidden in Resume Builder and rejected by the backend. A{' '}
            {LOCK_ICON} provider is one this installation cannot run at all, and its switch is
            fixed until that changes on the server. The free browser-chat providers drive a chat
            tab you signed in to; the metered providers are keyed from{' '}
            <code className={styles.code}>.env</code> (<code className={styles.code}>ANTHROPIC_API_KEY</code>,{' '}
            <code className={styles.code}>OPENAI_API_KEY</code>,{' '}
            <code className={styles.code}>DEEPSEEK_API_KEY</code>) and this app does
            not store keys of its own. Each row below shows what the provider reports right now.
          </>
        }
      >
        <ul className="tl-rows overflow-hidden">
          {AI_PROVIDERS.filter(
            // A provider this installation has withdrawn has no row: there is
            // nothing to toggle and nothing to read, and a live health line
            // against a browser nobody can sign in to is worse than silence.
            (provider) => settings.browserChatEnabled || !BROWSER_CHAT_PROVIDERS.includes(provider)
          ).map((provider) => {
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
