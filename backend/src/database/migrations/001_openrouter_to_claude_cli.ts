import type Database from 'better-sqlite3';

/**
 * Rewrites stored records that name the removed `openrouter` provider.
 *
 * Written with raw JSON and raw SQL on purpose. It must never call
 * `readSettings`, `normalizeSettings` or `normalizePromptModelSelection` -
 * those are the validators the data may not yet satisfy, and running the
 * migration through them would mean it only works on rows that did not need
 * migrating.
 *
 * This is a convenience, not a prerequisite. `coerceProviderId` reads a stale
 * `openrouter` correctly whether or not this ever runs, which is what makes a
 * restored backup, a hand-edited row and the legacy JSON importer all safe.
 */

export const PROVIDER_SCHEMA_VERSION = 1;
export const SETTINGS_KEY = 'app-settings';
export const SETTINGS_BACKUP_KEY = 'app-settings.backup.pre-claude-cli';
export const MIGRATION_LOG_KEY = 'migration-log.provider-schema-1';
export const PROMPTS_BACKUP_TABLE = 'prompts_backup_pre_claude_cli';

const LEGACY_PROVIDER = 'openrouter';
const NEW_PROVIDER = 'claude-cli';
const NEW_DEFAULT_MODEL = 'sonnet';
const NEW_DEFAULT_MODEL_ID = 'claude-cli-sonnet';

/** Prompt records shipped as static files; a DB row shadows the file. */
const SHIPPED_PROMPT_IDS = new Set(['analyze-job-description', 'tailor-resume']);

type Json = Record<string, unknown>;

const CLI_SEED_MODELS = [
  {
    id: 'claude-cli-sonnet',
    name: 'Claude Sonnet (subscription)',
    provider: NEW_PROVIDER,
    modelName: 'sonnet',
    description: 'Balanced default for tailoring, analysis and extraction on the subscription seat.',
  },
  {
    id: 'claude-cli-opus',
    name: 'Claude Opus (subscription)',
    provider: NEW_PROVIDER,
    modelName: 'opus',
    description: 'Highest-capability model on the subscription seat, for the most demanding prompts.',
  },
  {
    id: 'claude-cli-haiku',
    name: 'Claude Haiku (subscription)',
    provider: NEW_PROVIDER,
    modelName: 'haiku',
    description: 'Fastest model on the subscription seat, for classification and short extractions.',
  },
];

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when anything in the database still names the removed provider. */
export function hasOpenRouterResidue(db: Database.Database): boolean {
  const settingsRow = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(SETTINGS_KEY) as { value?: string } | undefined;
  if (settingsRow?.value?.includes(`"${LEGACY_PROVIDER}"`) || settingsRow?.value?.includes('openrouterEnabled')) {
    return true;
  }

  const promptRow = db
    .prepare(`SELECT id FROM prompts WHERE data LIKE '%"${LEGACY_PROVIDER}"%' LIMIT 1`)
    .get() as { id?: string } | undefined;
  return Boolean(promptRow);
}

export type MigrationReport = {
  ran: boolean;
  settingsRewritten: boolean;
  removedModels: number;
  seededModels: number;
  discardedApiKeys: number;
  rewrittenPrompts: number;
  clearedPromptOverrides: number;
  notes: string[];
};

function migrateSettings(db: Database.Database, report: MigrationReport): void {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTINGS_KEY) as
    | { value?: string }
    | undefined;

  if (!row?.value) {
    // Fresh install: the defaults already describe the new world.
    return;
  }

  let settings: unknown;
  try {
    settings = JSON.parse(row.value);
  } catch (error) {
    // `getSetting` deliberately throws on invalid JSON so corruption surfaces
    // rather than being silently replaced. The migration honours that: it
    // leaves the row exactly as it found it and says so.
    report.notes.push(
      `Left the settings row untouched because it is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return;
  }

  if (!isObject(settings)) {
    report.notes.push('Left the settings row untouched because it is not a JSON object.');
    return;
  }

  // Verbatim backup BEFORE any rewrite, so a rollback is a copy rather than a
  // reconstruction. Written only once: re-running must not overwrite the
  // original snapshot with an already-migrated one.
  const existingBackup = db.prepare('SELECT key FROM app_settings WHERE key = ?').get(SETTINGS_BACKUP_KEY);
  if (!existingBackup) {
    db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO NOTHING`
    ).run(SETTINGS_BACKUP_KEY, row.value, new Date().toISOString());
  }

  // 1. Enable flags. `openrouterEnabled` is what the admin chose for the
  //    provider `claude-cli` replaces, so it carries over rather than being
  //    dropped - an install whose only enabled provider was OpenRouter must
  //    not come back with no enabled provider at all.
  const providersEnabled = isObject(settings.providersEnabled) ? { ...settings.providersEnabled } : {};
  const flags: Array<[string, string]> = [
    ['claude-cli', 'openrouterEnabled'],
    ['claude', 'claudeEnabled'],
    ['openai', 'openaiEnabled'],
    ['deepseek', 'deepseekEnabled'],
  ];
  for (const [id, legacyField] of flags) {
    if (typeof providersEnabled[id] === 'boolean') continue;
    const legacy = settings[legacyField];
    providersEnabled[id] = typeof legacy === 'boolean' ? legacy : true;
  }
  if (!Object.values(providersEnabled).some(Boolean)) {
    providersEnabled['claude-cli'] = true;
    report.notes.push('No provider would have been left enabled, so the subscription provider was switched on.');
  }
  settings.providersEnabled = providersEnabled;
  delete settings.openrouterEnabled;

  // 2. Model records. OpenRouter model names ("openai/gpt-5.4-nano",
  //    "google/gemini-2.5-flash") mean nothing to the Claude CLI, so they are
  //    removed rather than remapped - remapping six of them onto one alias
  //    would just produce six duplicates of the same model.
  const now = new Date().toISOString();
  const hasExplicitModels = Array.isArray(settings.aiModels);

  // A row with no `aiModels` key inherits the full default catalogue at read
  // time, and the defaults already include the subscription models. Writing an
  // explicit list here would freeze that inheritance into a CLI-only list and
  // permanently remove every OpenAI, Anthropic and DeepSeek model from an
  // install that had simply never customised its model library.
  if (hasExplicitModels) {
    const models = settings.aiModels as unknown[];
    const kept = models.filter((model) => !(isObject(model) && model.provider === LEGACY_PROVIDER));
    report.removedModels = models.length - kept.length;

    const haveCli = new Set(
      kept.filter((model) => isObject(model) && model.provider === NEW_PROVIDER).map((model) => (model as Json).id)
    );
    const seeds = CLI_SEED_MODELS.filter((seed) => !haveCli.has(seed.id)).map((seed) => ({
      ...seed,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }));
    report.seededModels = seeds.length;
    settings.aiModels = [...seeds, ...kept];
  }

  // 3. The default model, when it pointed at a model that no longer exists.
  if (typeof settings.defaultModelId === 'string' && settings.defaultModelId.startsWith(`${LEGACY_PROVIDER}-`)) {
    settings.defaultModelId = NEW_DEFAULT_MODEL_ID;
  }

  // 4. Key stores. The subscription provider needs an (empty) entry so the
  //    admin page's Record<AIProvider, ...> index cannot be undefined; the
  //    OpenRouter keys go, but the backup above still holds them.
  if (isObject(settings.apiKeys)) {
    const apiKeys = settings.apiKeys as Json;
    const legacyStore = apiKeys[LEGACY_PROVIDER];
    if (isObject(legacyStore) && Array.isArray(legacyStore.entries)) {
      report.discardedApiKeys = legacyStore.entries.length;
    }
    delete apiKeys[LEGACY_PROVIDER];
    if (!isObject(apiKeys[NEW_PROVIDER])) {
      apiKeys[NEW_PROVIDER] = { activeKeyId: '', entries: [] };
    }
  }

  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(SETTINGS_KEY, JSON.stringify(settings), now);

  report.settingsRewritten = true;
  if (report.discardedApiKeys > 0) {
    // Said precisely, because "discarded" alone would be false: the key is
    // gone from the live settings but the verbatim backup still holds it, and
    // an operator who reads "discarded" would reasonably stop treating it as a
    // live credential.
    report.notes.push(
      `Removed ${report.discardedApiKeys} OpenRouter API key(s) from the active settings. They are still ` +
        `present in the pre-migration snapshot under app_settings["${SETTINGS_BACKUP_KEY}"], which is what ` +
        `makes "npm run ai:rollback" possible. Once you no longer need to roll back, run that command (it ` +
        `deletes the snapshot) or revoke the key at the provider.`
    );
  }
}

function migratePrompts(db: Database.Database, report: MigrationReport): void {
  const rows = db
    .prepare(`SELECT id, data FROM prompts WHERE data LIKE '%"${LEGACY_PROVIDER}"%'`)
    .all() as Array<{ id: string; data: string }>;

  if (rows.length === 0) {
    return;
  }

  db.exec(`CREATE TABLE IF NOT EXISTS ${PROMPTS_BACKUP_TABLE} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  const backup = db.prepare(
    `INSERT INTO ${PROMPTS_BACKUP_TABLE} (id, data) VALUES (?, ?) ON CONFLICT(id) DO NOTHING`
  );
  const update = db.prepare('UPDATE prompts SET data = ?, updated_at = ? WHERE id = ?');
  const now = new Date().toISOString();

  for (const row of rows) {
    let record: unknown;
    try {
      record = JSON.parse(row.data);
    } catch {
      report.notes.push(`Left prompt "${row.id}" untouched because its stored data is not valid JSON.`);
      continue;
    }
    if (!isObject(record) || record.modelProvider !== LEGACY_PROVIDER) {
      continue;
    }

    backup.run(row.id, row.data);

    if (SHIPPED_PROMPT_IDS.has(row.id)) {
      // These two shipped with a hard model override, which silently beat the
      // model the user picked in the UI for the two heaviest calls in the app.
      // Clearing it is what makes the picker work for them.
      delete record.modelProvider;
      delete record.modelName;
      report.clearedPromptOverrides += 1;
    } else {
      record.modelProvider = NEW_PROVIDER;
      record.modelName = NEW_DEFAULT_MODEL;
      report.rewrittenPrompts += 1;
    }

    update.run(JSON.stringify(record), now, row.id);
  }
}

/**
 * Applies the provider migration. Idempotent by inspection as well as by
 * version stamp, because a version stamp can be lost by a partial restore
 * while the data it describes cannot.
 */
export function migrate001(db: Database.Database): MigrationReport {
  const report: MigrationReport = {
    ran: false,
    settingsRewritten: false,
    removedModels: 0,
    seededModels: 0,
    discardedApiKeys: 0,
    rewrittenPrompts: 0,
    clearedPromptOverrides: 0,
    notes: [],
  };

  if (!hasOpenRouterResidue(db)) {
    return report;
  }

  const apply = db.transaction(() => {
    migrateSettings(db, report);
    migratePrompts(db, report);
  });
  apply();

  report.ran = true;
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(MIGRATION_LOG_KEY, JSON.stringify({ ...report, at: new Date().toISOString() }), new Date().toISOString());

  return report;
}
