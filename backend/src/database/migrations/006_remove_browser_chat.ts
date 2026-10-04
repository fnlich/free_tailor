import type Database from 'better-sqlite3';

/**
 * Removes what the browser chat providers left in the database.
 *
 * `claude-web` and `chatgpt-web` drove claude.ai and chatgpt.com in a debug
 * Chrome the operator started and signed in to. They were removed outright, and
 * unlike OpenRouter in 001 there is no provider that takes their place - so
 * nothing here is REPOINTED onto another provider. Their records carry
 * `modelName: 'chat'`, a name that means nothing to either subscription seat;
 * carried across, they would turn into calls that fail at generate time. They
 * are deleted, and everything that named them falls back to what it would have
 * used had it named nothing at all.
 *
 * Raw JSON and raw SQL, for the reason 001 gives: it must never call
 * `readSettings`, `normalizeSettings` or `normalizePromptModelSelection`, the
 * validators the data may not yet satisfy. And every id is spelled out here
 * rather than imported from the provider catalog: a migration records what was
 * true when it was written, and the catalog no longer knows these ids at all.
 *
 * A convenience, not a prerequisite - exactly as 001 is. It sits behind 003 in
 * the chain, which waits for the first administrator, and `npm run ai:rollback`
 * can put back a snapshot from before it and clear the version stamp. So every
 * read path tolerates the rows this rewrites (see `RETIRED_PROVIDER_IDS` in
 * config/providerCatalog), and what this adds is that the residue goes for good,
 * with a record of what it was. It is idempotent by inspection rather than by
 * stamp for the same reason: after a rollback it runs again, and must find
 * nothing to do on rows it has already cleaned.
 *
 * What it changes, in one transaction:
 *
 *   1. App settings. The browser chat model records, their enable flags, and the
 *      browser-mode switch and debug-browser list go. A default that named one of
 *      them is repointed, and an install left with no enabled provider or no
 *      runnable model gets the subscription seat back. A verbatim snapshot of the
 *      row is taken first, once, under `SETTINGS_BACKUP_KEY`.
 *   2. Prompts. A model override naming a removed provider is cleared - cleared
 *      means "use the model chosen for the run" - after the row is copied into
 *      `PROMPTS_BACKUP_TABLE`.
 *   3. Profiles. A stored model preference naming a removed model is cleared;
 *      the previous values are kept in the migration log.
 *
 * Queued generation tasks are deliberately NOT touched. Their rows are transient
 * and only running batches are ever restored; the restore path puts a task from
 * the old browser lane in a lane this build has, and the runner resolves its
 * model again before it starts - which covers a task restored before this step
 * has run, too.
 */

export const BROWSER_CHAT_REMOVAL_SCHEMA_VERSION = 6;
export const SETTINGS_KEY = 'app-settings';
export const SETTINGS_BACKUP_KEY = 'app-settings.backup.pre-browser-chat-removal';
export const MIGRATION_LOG_KEY = 'migration-log.provider-schema-6';
export const PROMPTS_BACKUP_TABLE = 'prompts_backup_pre_browser_chat_removal';

const RETIRED_PROVIDERS: ReadonlySet<string> = new Set(['claude-web', 'chatgpt-web']);

/** The synthesized browser entry, and the two seeded browser records. */
const RETIRED_MODEL_IDS: ReadonlySet<string> = new Set([
  'free-hybrid',
  'claude-web-chat',
  'chatgpt-web-chat',
]);

/** Settings keys that only ever configured browser chat. */
const RETIRED_SETTINGS_KEYS = ['browserChatEnabled', 'browserChatEndpoints', 'browserChatDebugPort'];

/**
 * The providers this build runs, and the flat flag an older row may carry for
 * each. Needed to decide whether anything is still switched on, the way the
 * settings reader decides it: a provider with no entry in `providersEnabled`
 * reads its flat flag, and with neither it reads as ON.
 */
const PROVIDERS: ReadonlyArray<{ id: string; legacyFlags: string[]; keyless: boolean }> = [
  { id: 'claude-cli', legacyFlags: ['claudeCliEnabled', 'openrouterEnabled'], keyless: true },
  { id: 'codex-cli', legacyFlags: [], keyless: true },
  { id: 'claude', legacyFlags: ['claudeEnabled'], keyless: false },
  { id: 'openai', legacyFlags: ['openaiEnabled'], keyless: false },
  { id: 'deepseek', legacyFlags: ['deepseekEnabled'], keyless: false },
];

const SEAT_PROVIDER = 'claude-cli';
const SEAT_DEFAULT_MODEL = 'sonnet';
const SEAT_DEFAULT_MODEL_ID = 'claude-cli-sonnet';

/** As 001 seeds them, so a model this restores reads exactly like a fresh install's. */
const SEAT_SEED_MODELS = [
  {
    id: 'claude-cli-sonnet',
    name: 'Claude Sonnet (subscription)',
    provider: SEAT_PROVIDER,
    modelName: 'sonnet',
    description: 'Balanced default for tailoring, analysis and extraction on the subscription seat.',
  },
  {
    id: 'claude-cli-opus',
    name: 'Claude Opus (subscription)',
    provider: SEAT_PROVIDER,
    modelName: 'opus',
    description: 'Highest-capability model on the subscription seat, for the most demanding prompts.',
  },
  {
    id: 'claude-cli-haiku',
    name: 'Claude Haiku (subscription)',
    provider: SEAT_PROVIDER,
    modelName: 'haiku',
    description: 'Fastest model on the subscription seat, for classification and short extractions.',
  },
];

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRetiredProvider(value: unknown): boolean {
  return typeof value === 'string' && RETIRED_PROVIDERS.has(value.trim());
}

function isRetiredModelId(value: unknown): boolean {
  return typeof value === 'string' && RETIRED_MODEL_IDS.has(value.trim());
}

/**
 * The id a stored model record goes by. A record saved without one is given
 * `<provider>-<slug>` when it is read, so a reference to it uses that.
 */
function modelIdOf(model: Json): string {
  if (typeof model.id === 'string' && model.id.trim()) return model.id.trim();
  const provider = typeof model.provider === 'string' ? model.provider.trim() : '';
  const slug =
    (typeof model.modelName === 'string' ? model.modelName : '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'model';
  return `${provider}-${slug}`;
}

function readSettingsRow(db: Database.Database): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTINGS_KEY) as
    | { value?: string }
    | undefined;
  return row?.value ?? null;
}

function settingsHaveResidue(raw: string): boolean {
  let settings: unknown;
  try {
    settings = JSON.parse(raw);
  } catch {
    // Unreadable. Said once by the run itself, which leaves the row alone; the
    // substring is the only test there is for a row that does not parse.
    return /claude-web|chatgpt-web|browserChat|free-hybrid/.test(raw);
  }
  if (!isObject(settings)) return false;

  if (RETIRED_SETTINGS_KEYS.some((key) => Object.prototype.hasOwnProperty.call(settings, key))) return true;
  if (isObject(settings.providersEnabled) && Object.keys(settings.providersEnabled).some(isRetiredProvider)) {
    return true;
  }
  if (Array.isArray(settings.aiModels) && settings.aiModels.some((model) => isObject(model) && isRetiredProvider(model.provider))) {
    return true;
  }
  return isRetiredModelId(settings.defaultModelId);
}

/** Prompt rows whose override names a removed provider or a removed model id. */
function promptsWithResidue(db: Database.Database): Array<{ id: string; data: string; record: Json }> {
  const candidates = db
    .prepare(
      `SELECT id, data FROM prompts
       WHERE data LIKE '%claude-web%' OR data LIKE '%chatgpt-web%' OR data LIKE '%free-hybrid%'`
    )
    .all() as Array<{ id: string; data: string }>;

  const found: Array<{ id: string; data: string; record: Json }> = [];
  for (const row of candidates) {
    let record: unknown;
    try {
      record = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (!isObject(record)) continue;
    if (isRetiredProvider(record.modelProvider) || isRetiredModelId(record.modelName)) {
      found.push({ ...row, record });
    }
  }
  return found;
}

/** The model id a profile row's stored preference names, or '' for none. */
function profileModelId(document: Json): string {
  const settings = isObject(document.profileSettings) ? document.profileSettings : null;
  const ai = settings && isObject(settings.ai) ? settings.ai : null;
  return ai && typeof ai.modelId === 'string' ? ai.modelId.trim() : '';
}

/** Profile rows whose stored model preference names one of `modelIds`. */
function profilesNaming(
  db: Database.Database,
  modelIds: ReadonlySet<string>
): Array<{ id: string; document: Json; modelId: string }> {
  // Only rows that store a preference at all: a profile never given one is
  // most of them, and there is nothing in it to read.
  const candidates = db
    .prepare(`SELECT id, data FROM profiles WHERE data LIKE '%"modelId"%'`)
    .all() as Array<{ id: string; data: string }>;

  const found: Array<{ id: string; document: Json; modelId: string }> = [];
  for (const row of candidates) {
    let document: unknown;
    try {
      document = JSON.parse(row.data);
    } catch {
      // Left exactly as it is, as 003 leaves one: writing a repaired blob over
      // a row this build cannot parse would destroy whatever it holds.
      continue;
    }
    if (!isObject(document)) continue;
    const modelId = profileModelId(document);
    if (modelId && modelIds.has(modelId)) found.push({ id: row.id, document, modelId });
  }
  return found;
}

/** True when anything in the database still names the removed providers. */
export function hasBrowserChatResidue(db: Database.Database): boolean {
  const raw = readSettingsRow(db);
  if (raw !== null && settingsHaveResidue(raw)) return true;
  if (promptsWithResidue(db).length > 0) return true;
  return profilesNaming(db, RETIRED_MODEL_IDS).length > 0;
}

export type BrowserChatRemovalReport = {
  ran: boolean;
  settingsRewritten: boolean;
  /** Browser chat model records deleted from the settings row. */
  removedModels: number;
  /** Their ids, which is also what a profile or the default may have named. */
  removedModelIds: string[];
  /** `providersEnabled` entries deleted. */
  removedProviderFlags: string[];
  /** Browser-mode settings keys deleted. */
  removedSettingsKeys: string[];
  /** Providers switched on so the install is left with one that runs. */
  enabledProviders: string[];
  /** Subscription seat models added so the install is left with one that runs. */
  seededModels: number;
  /** Existing seat models switched back on, for the same reason. */
  reenabledModels: string[];
  /** The default model, when it named a removed model. */
  repointedDefaultModel: { from: string; to: string } | null;
  /** Prompt rows whose model override was cleared. */
  clearedPromptOverrides: number;
  /** Profiles whose stored model preference was cleared, and what it was. */
  clearedProfilePreferences: Array<{ profileId: string; modelId: string }>;
  notes: string[];
};

/**
 * Whether the settings reader will consider `id` switched on: its entry in
 * `providersEnabled` when there is one, else a flat flag from an older row,
 * else ON.
 */
function providerOn(settings: Json, providersEnabled: Json, id: string): boolean {
  if (typeof providersEnabled[id] === 'boolean') return providersEnabled[id] as boolean;
  const descriptor = PROVIDERS.find((provider) => provider.id === id);
  if (!descriptor) return false;
  for (const flag of descriptor.legacyFlags) {
    if (typeof settings[flag] === 'boolean') return settings[flag] as boolean;
  }
  return true;
}

function migrateSettings(db: Database.Database, report: BrowserChatRemovalReport, removedIds: Set<string>): void {
  const raw = readSettingsRow(db);
  if (raw === null) {
    // Fresh install: the defaults describe a build with no browser chat already.
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // `getSetting` throws on invalid JSON so that corruption surfaces rather
    // than being replaced. Honoured here as 001 honours it: the row is left
    // exactly as it was found, and the note says so.
    report.notes.push(
      `Left the settings row untouched because it is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return;
  }
  if (!isObject(parsed)) {
    report.notes.push('Left the settings row untouched because it is not a JSON object.');
    return;
  }
  if (!settingsHaveResidue(raw)) return;
  const settings: Json = parsed;

  // Verbatim, before anything is rewritten, so recovering it is a copy rather
  // than a reconstruction. Written once: a second run - after a rollback, say -
  // must not overwrite the original with a row that was already cleaned.
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO NOTHING`
  ).run(SETTINGS_BACKUP_KEY, raw, new Date().toISOString());

  const now = new Date().toISOString();

  // 1. The model records. Deleted, not remapped: `chat` is not a model either
  //    seat has, so a remapped record would only fail later and less clearly.
  const hasExplicitModels = Array.isArray(settings.aiModels);
  let models: unknown[] = hasExplicitModels ? (settings.aiModels as unknown[]) : [];
  if (hasExplicitModels) {
    const kept: unknown[] = [];
    for (const model of models) {
      if (isObject(model) && isRetiredProvider(model.provider)) {
        const id = modelIdOf(model);
        removedIds.add(id);
        report.removedModelIds.push(id);
        continue;
      }
      kept.push(model);
    }
    report.removedModels = models.length - kept.length;
    models = kept;
  }

  // 2. The enable flags, and the settings that only configured the browsers.
  const providersEnabled: Json = isObject(settings.providersEnabled) ? { ...settings.providersEnabled } : {};
  for (const key of Object.keys(providersEnabled)) {
    if (isRetiredProvider(key)) {
      delete providersEnabled[key];
      report.removedProviderFlags.push(key);
    }
  }
  for (const key of RETIRED_SETTINGS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      delete settings[key];
      report.removedSettingsKeys.push(key);
    }
  }

  // 3. Something must still run. An operator who used the browsers alone - the
  //    seats and the APIs unticked, or their models switched off - would
  //    otherwise come back to a row the settings reader refuses outright, and
  //    with it the Settings page they would fix it from. The subscription seat
  //    is what comes back, as it did in 001 for an install that ran only on
  //    OpenRouter.
  const switchOn = (id: string): void => {
    if (providerOn(settings, providersEnabled, id)) return;
    providersEnabled[id] = true;
    report.enabledProviders.push(id);
  };

  if (!PROVIDERS.some((provider) => providerOn(settings, providersEnabled, provider.id))) {
    switchOn(SEAT_PROVIDER);
    report.notes.push(
      'No provider would have been left enabled once the browser chat providers were removed, so the ' +
        'subscription provider (claude-cli) was switched on. Review it under Admin > Settings.'
    );
  }

  const runnable = (model: unknown): model is Json =>
    isObject(model) &&
    model.enabled !== false &&
    typeof model.provider === 'string' &&
    PROVIDERS.some((provider) => provider.id === model.provider) &&
    providerOn(settings, providersEnabled, model.provider);

  if (hasExplicitModels && !models.some(runnable)) {
    switchOn(SEAT_PROVIDER);
    // By id AND by provider and model name. The settings reader refuses a row
    // with two records for one provider/model pair, so a seed added beside a
    // seat model the operator created under their own id would break the very
    // row this is repairing.
    const presentIds = new Set(models.filter(isObject).map((model) => modelIdOf(model)));
    const presentPairs = new Set(
      models
        .filter(isObject)
        .map((model) => `${String(model.provider)}:${String(model.modelName ?? '').trim().toLowerCase()}`)
    );
    const seeds = SEAT_SEED_MODELS.filter(
      (seed) => !presentIds.has(seed.id) && !presentPairs.has(`${seed.provider}:${seed.modelName}`)
    ).map((seed) => ({ ...seed, enabled: true, createdAt: now, updatedAt: now }));
    report.seededModels = seeds.length;
    models = [...seeds, ...models];

    // The seat's models were there all along and switched off. One comes back
    // on - the default one where it exists - because a row nothing can run on
    // is worse than an untick being undone, and the note says which.
    if (!models.some(runnable)) {
      const seatModels = models.filter(
        (model): model is Json => isObject(model) && model.provider === SEAT_PROVIDER
      );
      const revive =
        seatModels.find((model) => String(model.modelName ?? '').trim().toLowerCase() === SEAT_DEFAULT_MODEL) ??
        seatModels[0];
      if (revive) {
        models = models.map((model) => (model === revive ? { ...revive, enabled: true, updatedAt: now } : model));
        report.reenabledModels.push(modelIdOf(revive));
      }
    }

    report.notes.push(
      'No model would have been left runnable once the browser chat models were removed, so the ' +
        `subscription models were restored (${report.seededModels} added` +
        (report.reenabledModels.length ? `, ${report.reenabledModels.join(', ')} switched back on` : '') +
        '). Review them under Admin > Models.'
    );
  }

  if (hasExplicitModels) settings.aiModels = models;
  // Written back only where there was a record, or this pass made one: an
  // empty record where a row had none would read the same, but it is a change
  // to a row this did not need to change.
  if (isObject(settings.providersEnabled) || Object.keys(providersEnabled).length > 0) {
    settings.providersEnabled = providersEnabled;
  }

  // 4. The default model, when it named a model that no longer exists. This is
  //    the common case rather than the edge one: an earlier migration moved the
  //    default onto a browser chat model on most upgraded installs.
  //
  //    Repointed rather than left for the reader's fallback, because that
  //    fallback takes the first runnable model in list order - which on an
  //    upgraded install can be a metered API model, quietly billing tokens for
  //    a default nobody chose. The seat's default model first, then any keyless
  //    model, and a metered one only when nothing else can run.
  const currentDefault = typeof settings.defaultModelId === 'string' ? settings.defaultModelId.trim() : '';
  if (currentDefault && (RETIRED_MODEL_IDS.has(currentDefault) || removedIds.has(currentDefault))) {
    let replacement = '';
    if (hasExplicitModels) {
      const candidates = models.filter(runnable);
      const keyless = (model: Json): boolean =>
        PROVIDERS.some((provider) => provider.id === model.provider && provider.keyless);
      const pick =
        candidates.find((model) => modelIdOf(model) === SEAT_DEFAULT_MODEL_ID) ??
        candidates.find(keyless) ??
        candidates[0];
      replacement = pick ? modelIdOf(pick) : '';
    } else if (providerOn(settings, providersEnabled, SEAT_PROVIDER)) {
      // No explicit list: the row inherits the seed models, which include the
      // seat's default.
      replacement = SEAT_DEFAULT_MODEL_ID;
    }

    if (replacement) {
      settings.defaultModelId = replacement;
    } else {
      // Nothing this can name with confidence; the reader resolves an absent
      // default to the seed default or the first runnable model.
      delete settings.defaultModelId;
    }
    report.repointedDefaultModel = { from: currentDefault, to: replacement };
  }

  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(SETTINGS_KEY, JSON.stringify(settings), now);
  report.settingsRewritten = true;
}

function migratePrompts(db: Database.Database, report: BrowserChatRemovalReport): void {
  const rows = promptsWithResidue(db);
  if (rows.length === 0) return;

  db.exec(`CREATE TABLE IF NOT EXISTS ${PROMPTS_BACKUP_TABLE} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  const backup = db.prepare(
    `INSERT INTO ${PROMPTS_BACKUP_TABLE} (id, data) VALUES (?, ?) ON CONFLICT(id) DO NOTHING`
  );
  const update = db.prepare('UPDATE prompts SET data = ?, updated_at = ? WHERE id = ?');
  const now = new Date().toISOString();

  for (const row of rows) {
    backup.run(row.id, row.data);
    // Cleared on EVERY prompt, shipped or custom - where 001 repointed the
    // custom ones. There is no provider to repoint them to, and a cleared
    // override is what the prompt would have done had nobody set one: run on the
    // model chosen for the run.
    delete row.record.modelProvider;
    delete row.record.modelName;
    update.run(JSON.stringify(row.record), now, row.id);
    report.clearedPromptOverrides += 1;
  }
}

function migrateProfiles(db: Database.Database, report: BrowserChatRemovalReport, removedIds: Set<string>): void {
  const write = db.prepare('UPDATE profiles SET data = ? WHERE id = ?');
  for (const row of profilesNaming(db, removedIds)) {
    // Only the model id goes. An absent model means INHERIT, which is what a
    // preference for a model that no longer exists can honestly become: the app
    // default, as it already resolves on read.
    const ai = (row.document.profileSettings as Json).ai as Json;
    delete ai.modelId;
    write.run(JSON.stringify(row.document), row.id);
    report.clearedProfilePreferences.push({ profileId: row.id, modelId: row.modelId });
  }
}

/**
 * Applies the browser chat removal. Idempotent by inspection as well as by
 * version stamp, because a stamp can be cleared - `ai:rollback` does exactly
 * that - while the data it describes cannot be.
 */
export function migrate006(db: Database.Database): BrowserChatRemovalReport {
  const report: BrowserChatRemovalReport = {
    ran: false,
    settingsRewritten: false,
    removedModels: 0,
    removedModelIds: [],
    removedProviderFlags: [],
    removedSettingsKeys: [],
    enabledProviders: [],
    seededModels: 0,
    reenabledModels: [],
    repointedDefaultModel: null,
    clearedPromptOverrides: 0,
    clearedProfilePreferences: [],
    notes: [],
  };

  if (!hasBrowserChatResidue(db)) {
    return report;
  }

  // Every model id that meant a browser: the three shipped ones, and whatever
  // the settings pass finds in the row - an administrator's own browser model
  // has a random id that only the row it is deleted from can name.
  const removedIds = new Set<string>(RETIRED_MODEL_IDS);

  db.transaction(() => {
    migrateSettings(db, report, removedIds);
    migratePrompts(db, report);
    migrateProfiles(db, report, removedIds);

    report.ran = true;
    if (report.clearedProfilePreferences.length > 0) {
      report.notes.push(
        `Cleared the stored model of ${report.clearedProfilePreferences.length} profile(s) that named a ` +
          'browser chat model; they now use the app default. The previous values are in ' +
          `app_settings["${MIGRATION_LOG_KEY}"].`
      );
    }
    db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(
      MIGRATION_LOG_KEY,
      JSON.stringify({ ...report, at: new Date().toISOString() }),
      new Date().toISOString()
    );
  })();

  return report;
}
