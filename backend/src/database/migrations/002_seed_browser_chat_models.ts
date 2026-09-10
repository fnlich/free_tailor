import type Database from 'better-sqlite3';

/**
 * Gives an existing install the browser-chat models it never got.
 *
 * Claude (free) and ChatGPT (free) were added to the seed list, and a seed
 * list is only ever read by a FRESH install: `writeSettings` persists the
 * whole settings object, so any install that had once saved anything carried
 * an explicit `aiModels` array that the new seeds could not reach. The two
 * providers were enabled, their adapters were registered, the debug browsers
 * were configured on the Settings page - and no model in the picker named
 * them, so there was no way to run one. That is what this fixes.
 *
 * Raw JSON and raw SQL, for the same reason as 001: a migration that runs
 * through the validators only works on rows that did not need migrating.
 */

export const BROWSER_CHAT_SCHEMA_VERSION = 2;
export const SETTINGS_KEY = 'app-settings';

type Json = Record<string, unknown>;

const BROWSER_CHAT_SEED_MODELS = [
  {
    id: 'claude-web-chat',
    name: 'Claude (free)',
    provider: 'claude-web',
    modelName: 'chat',
    description:
      'Free. Drives claude.ai in a Chrome you started and signed in to - no API key, nothing metered.',
  },
  {
    id: 'chatgpt-web-chat',
    name: 'ChatGPT (free)',
    provider: 'chatgpt-web',
    modelName: 'chat',
    description:
      'Free. Drives chatgpt.com in a Chrome you started and signed in to - no API key, nothing metered.',
  },
];

/**
 * Providers this migration must not leave as the only enabled ones.
 *
 * Spelled out here rather than imported from the catalog: a migration records
 * what was true when it was written. If a later release unlocks the CLI seat
 * or locks something else, an install that already ran this must not be
 * rewritten a second time to a different answer.
 */
const LOCKED_AT_WRITE_TIME = new Set(['claude-cli']);

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type BrowserChatMigrationReport = {
  ran: boolean;
  settingsRewritten: boolean;
  seededModels: number;
  enabledProviders: string[];
  repointedDefaultModel: boolean;
  notes: string[];
};

export function migrate002(db: Database.Database): BrowserChatMigrationReport {
  const report: BrowserChatMigrationReport = {
    ran: true,
    settingsRewritten: false,
    seededModels: 0,
    enabledProviders: [],
    repointedDefaultModel: false,
    notes: [],
  };

  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTINGS_KEY) as
    | { value?: string }
    | undefined;

  if (!row?.value) {
    // Fresh install: the seed list already has both models.
    return report;
  }

  let settings: unknown;
  try {
    settings = JSON.parse(row.value);
  } catch (error) {
    report.notes.push(
      `Left the settings row untouched because it is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return report;
  }

  if (!isObject(settings)) {
    report.notes.push('Left the settings row untouched because it is not a JSON object.');
    return report;
  }

  const now = new Date().toISOString();
  let changed = false;

  // 1. The model records. Only where the row pins an explicit list: a row
  //    without one inherits the seed list at read time and already has both,
  //    and writing a list here would freeze that inheritance for good.
  if (Array.isArray(settings.aiModels)) {
    const models = settings.aiModels as unknown[];
    // Keyed on the PROVIDER, not the seed id. An operator who already added a
    // Claude (free) row of their own under a different name has the provider
    // covered, and a second row for it would be a duplicate in their picker.
    const providersPresent = new Set(
      models.filter(isObject).map((model) => model.provider)
    );
    const seeds = BROWSER_CHAT_SEED_MODELS.filter(
      (seed) => !providersPresent.has(seed.provider)
    ).map((seed) => ({ ...seed, enabled: true, createdAt: now, updatedAt: now }));

    if (seeds.length > 0) {
      // Appended, not prepended: these are the operator's own model list and
      // whatever they put first is what an unset default falls back to.
      settings.aiModels = [...models, ...seeds];
      report.seededModels = seeds.length;
      changed = true;
    }
  }

  // 2. Enable flags. A row whose only enabled providers are locked here would
  //    save as "at least one provider enabled" and still run nothing, so the
  //    two free providers are switched on to carry it.
  const providersEnabled = isObject(settings.providersEnabled)
    ? { ...settings.providersEnabled }
    : {};
  const hasUnlockedEnabled = Object.entries(providersEnabled).some(
    ([id, enabled]) => enabled === true && !LOCKED_AT_WRITE_TIME.has(id)
  );
  if (Object.keys(providersEnabled).length > 0 && !hasUnlockedEnabled) {
    for (const seed of BROWSER_CHAT_SEED_MODELS) {
      providersEnabled[seed.provider] = true;
      report.enabledProviders.push(seed.provider);
    }
    settings.providersEnabled = providersEnabled;
    report.notes.push(
      'Every provider this install had enabled is locked in this build, so the two free browser-chat ' +
        'providers were switched on. Untick them under Admin > Settings if that is not what you want.'
    );
    changed = true;
  }

  // 3. The default model, when the stored one cannot run here.
  //
  //    Read time already falls back to the first runnable model, and that
  //    fallback is exactly the problem: on an upgraded install the list starts
  //    with the subscription models, so the first RUNNABLE one is whichever
  //    metered API model happens to come next - and an install would quietly
  //    start billing tokens for a default nobody chose. Repointing at a free
  //    browser-chat model instead keeps "the default costs nothing" true,
  //    which is what it was before the lock.
  if (typeof settings.defaultModelId === 'string') {
    const models = (Array.isArray(settings.aiModels) ? (settings.aiModels as unknown[]) : []).filter(isObject);
    const runnable = (model: Json): boolean =>
      model.enabled !== false &&
      typeof model.provider === 'string' &&
      !LOCKED_AT_WRITE_TIME.has(model.provider) &&
      providersEnabled[model.provider] !== false;

    const current = models.find((model) => model.id === settings.defaultModelId);
    if (!current || !runnable(current)) {
      const free = new Set(BROWSER_CHAT_SEED_MODELS.map((seed) => seed.provider));
      const replacement =
        models.find((model) => runnable(model) && free.has(model.provider as string)) ??
        models.find(runnable);
      if (replacement && typeof replacement.id === 'string' && replacement.id !== settings.defaultModelId) {
        settings.defaultModelId = replacement.id;
        report.repointedDefaultModel = true;
        changed = true;
      }
    }
  }

  if (!changed) {
    return report;
  }

  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(SETTINGS_KEY, JSON.stringify(settings), now);
  report.settingsRewritten = true;

  return report;
}
