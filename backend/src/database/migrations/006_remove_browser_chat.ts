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
 * the chain, which waits for the first administrator, and a restored backup or a
 * hand-edited row can bring the residue back after it has run. So every read
 * path tolerates the rows this rewrites (see `RETIRED_PROVIDER_IDS` in
 * config/providerCatalog), and what this adds is that the residue goes for good,
 * with a record of what it was. It is idempotent by inspection rather than by
 * stamp for the same reason: `npm run ai:rollback` clears the version stamp (it
 * restores only 001's snapshot, which is older than browser chat), so this runs
 * again after it, and must find nothing to do on rows it has already cleaned -
 * or, when something written since put residue back, clean that and add to its
 * log rather than replace it.
 *
 * What it changes, in one transaction:
 *
 *   1. App settings. The browser chat model records, their enable flags, and the
 *      browser-mode switch and debug-browser list go. A default that named one of
 *      them is repointed, and an install left with no enabled provider or no
 *      runnable model gets one back - a subscription seat where one is not
 *      locked on this machine, else a metered API it already has a model for,
 *      the one whose key is set first. A snapshot of the row is taken first,
 *      once, under `SETTINGS_BACKUP_KEY`: verbatim, apart from any API key
 *      store an older release left in it, which the settings reader deletes
 *      from the row and which must not outlive it here.
 *   2. Prompts. A model override naming a removed provider is cleared - cleared
 *      means "use the model chosen for the run" - after the row is copied into
 *      `PROMPTS_BACKUP_TABLE`.
 *   3. Profiles. A stored model preference naming a removed model is cleared;
 *      the previous values are kept in the migration log, which a later run
 *      appends to and never overwrites.
 *
 * A settings row that is not valid JSON but plainly names a browser provider
 * makes the whole step wait, as 003 waits for an administrator: the ids of an
 * administrator's own browser models are only in that row, and stamping the
 * version past it would mean they were never learned once the row is repaired.
 *
 * Queued generation tasks are deliberately NOT touched. Their rows are transient
 * and only running batches are ever restored; the restore path resolves a model
 * again for a task that named a browser provider and puts it in the lane of what
 * it resolves to - which covers a task restored before this step has run, too.
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
 * reads its flat flag, and with neither it reads as ON. A metered provider
 * names the variable its key comes from, because one with no key repairs
 * nothing - every call on it fails.
 */
const PROVIDERS: ReadonlyArray<{ id: string; legacyFlags: string[]; keyless: boolean; envKey?: string }> = [
  { id: 'claude-cli', legacyFlags: ['claudeCliEnabled', 'openrouterEnabled'], keyless: true },
  { id: 'codex-cli', legacyFlags: [], keyless: true },
  { id: 'claude', legacyFlags: ['claudeEnabled'], keyless: false, envKey: 'ANTHROPIC_API_KEY' },
  { id: 'openai', legacyFlags: ['openaiEnabled'], keyless: false, envKey: 'OPENAI_API_KEY' },
  { id: 'deepseek', legacyFlags: ['deepseekEnabled'], keyless: false, envKey: 'DEEPSEEK_API_KEY' },
];

const SEAT_DEFAULT_MODEL_ID = 'claude-cli-sonnet';

type SeedModel = { id: string; name: string; provider: string; modelName: string; description: string };

/**
 * What each subscription seat is restored with, and which of its models a
 * revived seat switches back on. The Claude seat's as 001 seeds them and the
 * Codex seat's as 005 does, so a model this restores reads exactly like a fresh
 * install's. The metered providers have no entry: a key-billed model is never
 * ADDED behind the operator's back, only one they already had switched back on.
 */
const SEAT_SEEDS: Readonly<Record<string, { defaultModelName: string; models: SeedModel[] }>> = {
  'claude-cli': {
    defaultModelName: 'sonnet',
    models: [
      {
        id: 'claude-cli-sonnet',
        name: 'Claude Sonnet (subscription)',
        provider: 'claude-cli',
        modelName: 'sonnet',
        description: 'Balanced default for tailoring, analysis and extraction on the subscription seat.',
      },
      {
        id: 'claude-cli-opus',
        name: 'Claude Opus (subscription)',
        provider: 'claude-cli',
        modelName: 'opus',
        description: 'Highest-capability model on the subscription seat, for the most demanding prompts.',
      },
      {
        id: 'claude-cli-haiku',
        name: 'Claude Haiku (subscription)',
        provider: 'claude-cli',
        modelName: 'haiku',
        description: 'Fastest model on the subscription seat, for classification and short extractions.',
      },
    ],
  },
  'codex-cli': {
    defaultModelName: 'default',
    models: [
      {
        id: 'codex-cli-default',
        name: 'Codex (subscription)',
        provider: 'codex-cli',
        modelName: 'default',
        description:
          "Runs on your ChatGPT subscription through the local codex CLI - no API key, nothing metered. Uses " +
          'whatever model that account is configured with.',
      },
    ],
  },
};

/**
 * The provider lock, read the way config/providerCatalog reads it: two env
 * lists, comma or space separated, with the unlock winning.
 *
 * One of the two machine facts this reads, and it has to. A lock is how an
 * operator says a seat cannot run here, and a repair that switched on - or
 * repointed the default onto - a locked seat would write a row the settings
 * reader still refuses, then stamp the version so nothing ever looked at it
 * again. Spelled out rather than imported, by the rule every migration here
 * keeps. No provider is locked by the catalog itself, so the environment is the
 * whole answer.
 */
function envProviderList(name: string): Set<string> {
  const raw = process.env[name];
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

function lockedHere(id: string): boolean {
  if (envProviderList('AI_UNLOCKED_PROVIDERS').has(id)) return false;
  return envProviderList('AI_LOCKED_PROVIDERS').has(id);
}

/**
 * The other machine fact: whether a metered provider has its key here. Keys
 * come from the environment only, read the way the settings reader reads them.
 * With both seats locked the repair has to pick a metered API, and the one
 * whose key is set is the one that runs; picking by list order alone stored the
 * Anthropic API on a box that only had an OpenAI key, and every generation
 * failed on the missing key.
 */
function keyedHere(provider: (typeof PROVIDERS)[number]): boolean {
  return Boolean(provider.envKey && process.env[provider.envKey]?.trim());
}

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
  /**
   * True when the settings row names a browser provider but cannot be parsed:
   * the step waits, unstamped, for the row to be repaired. See `migrate006`.
   */
  deferred: boolean;
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
  /**
   * What the run left the settings row running on, or null when it did not
   * rewrite the row: every provider's switch as the settings reader will read
   * it, and the ids of the models left switched on, sorted - null there when
   * the row has no list of its own and inherits the seed models.
   *
   * Kept in the log because the reader repairs a row that can run nothing only
   * while it is still the row this left. Once an administrator has changed
   * which providers or models are on, a lock added later is theirs to answer,
   * and the reader names it rather than undo their choice.
   */
  leftRunning: { providersEnabled: Record<string, boolean>; enabledModelIds: string[] | null } | null;
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
  // than a reconstruction. Written once: a second run - after the stamp is
  // cleared, say - must not overwrite the original with a row that was already
  // cleaned.
  //
  // Verbatim except for one key. A row an older release wrote can still hold
  // the API key store, which the settings reader deletes from the live row on
  // its first read because keys come from the environment only. On a normal
  // boot this runs BEFORE that read, so a verbatim copy would be the one place
  // those secrets survived - a permanent plaintext credential under a key
  // nobody reads and nothing ever deletes.
  const hasKeyStore = Object.prototype.hasOwnProperty.call(settings, 'apiKeys');
  let snapshot = raw;
  if (hasKeyStore) {
    const { apiKeys: _discarded, ...withoutKeys } = settings;
    snapshot = JSON.stringify(withoutKeys);
  }
  const snapshotWritten =
    db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO NOTHING`
      )
      .run(SETTINGS_BACKUP_KEY, snapshot, new Date().toISOString()).changes > 0;
  if (hasKeyStore && snapshotWritten) {
    report.notes.push(
      `The copy of the settings row under "${SETTINGS_BACKUP_KEY}" leaves out its stored API keys; keys ` +
        'come from the environment only, and the settings reader deletes them from the row itself.'
    );
  }

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
  //    with it the Settings page they would fix it from. A subscription seat is
  //    what comes back, as the Claude seat did in 001 for an install that ran
  //    only on OpenRouter.
  //
  //    "Can run" is the reader's test, lock included. A seat locked on this
  //    machine is exactly what pushed many installs onto the browsers in the
  //    first place, and switching it back on would repair nothing: the reader
  //    would still refuse the row, and the stamp written after this would stop
  //    anything from looking at it again.
  const usable = (id: string): boolean => providerOn(settings, providersEnabled, id) && !lockedHere(id);

  const switchOn = (id: string): void => {
    if (providerOn(settings, providersEnabled, id)) return;
    providersEnabled[id] = true;
    report.enabledProviders.push(id);
  };

  const runnable = (model: unknown): model is Json =>
    isObject(model) &&
    model.enabled !== false &&
    typeof model.provider === 'string' &&
    PROVIDERS.some((provider) => provider.id === model.provider) &&
    usable(model.provider);

  /**
   * The provider to bring back: one not locked here; a keyless seat, then a
   * metered API whose key is set here, then one whose key is not; one already
   * switched on before one that has to be; one with a model already switched
   * on before one without; catalog order after that. A key outranks the
   * operator's switch, because a metered API with no key repairs nothing. The
   * settings reader repairs a row it reads by the same rule. A metered provider
   * qualifies only when the row already has a model for it, because this never
   * adds a key-billed model nobody chose - only switches one of theirs back on.
   */
  const repairTarget = (): string | null => {
    const ownModels = (id: string): Json[] =>
      hasExplicitModels ? models.filter((model): model is Json => isObject(model) && model.provider === id) : [];
    const candidates = PROVIDERS.filter(
      (provider) =>
        !lockedHere(provider.id) && (provider.keyless || !hasExplicitModels || ownModels(provider.id).length > 0)
    );
    const rank = (provider: (typeof PROVIDERS)[number]): number =>
      (provider.keyless ? 0 : keyedHere(provider) ? 4 : 8) +
      (providerOn(settings, providersEnabled, provider.id) ? 0 : 2) +
      (!hasExplicitModels || ownModels(provider.id).some((model) => model.enabled !== false) ? 0 : 1);
    return [...candidates].sort((a, b) => rank(a) - rank(b))[0]?.id ?? null;
  };

  /** What the note says about a metered provider's key; nothing for a seat. */
  const keyNote = (id: string): string => {
    const provider = PROVIDERS.find((entry) => entry.id === id);
    if (!provider || provider.keyless) return '';
    return keyedHere(provider)
      ? ` It bills per token, on the ${provider.envKey} set in .env.`
      : ` No ${provider.envKey} is set in .env, so it cannot run until one is - and nothing else here can.`;
  };

  const lockedNote =
    'nothing this migration may bring back can run on this machine - the subscription seats are locked ' +
    '(AI_LOCKED_PROVIDERS), and it adds no metered model nobody chose - so the row was left that way. The ' +
    'settings reader repairs it in memory where it can - adding a metered API\'s own models there, which ' +
    'this never stores - and names the locks where it cannot.';

  if (!PROVIDERS.some((provider) => usable(provider.id))) {
    const target = repairTarget();
    if (target) {
      switchOn(target);
      report.notes.push(
        'No provider this machine can run would have been left enabled once the browser chat providers ' +
          `were removed, so ${target} was switched on. Review it under Admin > Settings.${keyNote(target)}`
      );
    } else {
      report.notes.push(`No provider would have been left enabled, and ${lockedNote}`);
    }
  }

  if (hasExplicitModels && !models.some(runnable)) {
    const target = repairTarget();
    if (target) {
      switchOn(target);
      const seat = SEAT_SEEDS[target];
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
      const seeds = (seat?.models ?? [])
        .filter((seed) => !presentIds.has(seed.id) && !presentPairs.has(`${seed.provider}:${seed.modelName}`))
        .map((seed) => ({ ...seed, enabled: true, createdAt: now, updatedAt: now }));
      report.seededModels = seeds.length;
      models = [...seeds, ...models];

      // The provider's models were there all along and switched off. One comes
      // back on - the seat's default one where it exists - because a row
      // nothing can run on is worse than an untick being undone, and the note
      // says which.
      if (!models.some(runnable)) {
        const ownModels = models.filter((model): model is Json => isObject(model) && model.provider === target);
        const revive =
          ownModels.find(
            (model) => String(model.modelName ?? '').trim().toLowerCase() === seat?.defaultModelName
          ) ?? ownModels[0];
        if (revive) {
          models = models.map((model) => (model === revive ? { ...revive, enabled: true, updatedAt: now } : model));
          report.reenabledModels.push(modelIdOf(revive));
        }
      }

      report.notes.push(
        'No model this machine can run would have been left once the browser chat models were removed, ' +
          `so ${target}'s models were restored (${report.seededModels} added` +
          (report.reenabledModels.length ? `, ${report.reenabledModels.join(', ')} switched back on` : '') +
          `). Review them under Admin > Models.${keyNote(target)}`
      );
    } else {
      report.notes.push(`No model would have been left runnable, and ${lockedNote}`);
    }
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
  //    a default nobody chose. The Claude seat's default model first, then any
  //    keyless model, and a metered one only when nothing else can run - one
  //    whose key is set before one whose key is not - all of them models this
  //    machine can run, so a locked Claude seat lands on the Codex seat, as a
  //    fresh install with that lock does.
  const currentDefault = typeof settings.defaultModelId === 'string' ? settings.defaultModelId.trim() : '';
  if (currentDefault && (RETIRED_MODEL_IDS.has(currentDefault) || removedIds.has(currentDefault))) {
    let replacement = '';
    if (hasExplicitModels) {
      const candidates = models.filter(runnable);
      const providerOf = (model: Json) => PROVIDERS.find((provider) => provider.id === model.provider);
      const keyless = (model: Json): boolean => providerOf(model)?.keyless === true;
      const keyed = (model: Json): boolean => {
        const provider = providerOf(model);
        return provider !== undefined && keyedHere(provider);
      };
      const pick =
        candidates.find((model) => modelIdOf(model) === SEAT_DEFAULT_MODEL_ID) ??
        candidates.find(keyless) ??
        candidates.find(keyed) ??
        candidates[0];
      replacement = pick ? modelIdOf(pick) : '';
    } else {
      // No explicit list: the row inherits the seed models, which include each
      // seat's default.
      const seat = PROVIDERS.find((provider) => provider.keyless && usable(provider.id));
      const seed = seat
        ? SEAT_SEEDS[seat.id]?.models.find((model) => model.modelName === SEAT_SEEDS[seat.id]?.defaultModelName)
        : undefined;
      replacement = seed?.id ?? '';
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

  report.leftRunning = {
    providersEnabled: Object.fromEntries(
      PROVIDERS.map((provider) => [provider.id, providerOn(settings, providersEnabled, provider.id)])
    ),
    enabledModelIds: hasExplicitModels
      ? models
          .filter((model): model is Json => isObject(model) && model.enabled !== false)
          .map((model) => modelIdOf(model))
          .sort()
      : null,
  };

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
 * What a run is recorded under: the first run's report, with every later run
 * appended to it.
 *
 * Appended, never replaced, because this log is the ONLY record of the profile
 * preferences a run clears. A later run - the stamp cleared, and residue written
 * since, say a page left open from before the upgrade saving a profile - finds
 * the earlier profiles already clean; a report that replaced the first would
 * lose what they were for good. A log row somebody edited into something that
 * is not an object is left alone, and the run goes under its own dated key.
 *
 * The settings reader reads it as well, every entry of it: the model ids each
 * run removed - so a page left open from before the upgrade that names an
 * administrator's own browser model still runs on the default after a restart,
 * when the record itself is long gone - and what the latest run that rewrote
 * the row left it running on.
 */
function writeMigrationLog(db: Database.Database, report: BrowserChatRemovalReport): void {
  const at = new Date().toISOString();
  const entry = { ...report, at };
  const existing = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(MIGRATION_LOG_KEY) as
    | { value?: string }
    | undefined;

  let key = MIGRATION_LOG_KEY;
  let value: Json = entry;
  if (existing?.value !== undefined) {
    let previous: unknown;
    try {
      previous = JSON.parse(existing.value);
    } catch {
      previous = null;
    }
    if (isObject(previous)) {
      const laterRuns = Array.isArray(previous.laterRuns) ? previous.laterRuns : [];
      value = { ...previous, laterRuns: [...laterRuns, entry] };
    } else {
      key = `${MIGRATION_LOG_KEY}.${at}`;
    }
  }

  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), at);
}

/**
 * Applies the browser chat removal. Idempotent by inspection as well as by
 * version stamp, because a stamp can be cleared - `ai:rollback` does exactly
 * that - while the data it describes cannot be.
 */
export function migrate006(db: Database.Database): BrowserChatRemovalReport {
  const report: BrowserChatRemovalReport = {
    ran: false,
    deferred: false,
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
    leftRunning: null,
    notes: [],
  };

  if (!hasBrowserChatResidue(db)) {
    return report;
  }

  // A settings row that names a browser provider but does not parse. Nothing is
  // written - `getSetting` refuses such a row so that corruption surfaces, and
  // a repaired blob over it would destroy whatever it holds - and the step
  // WAITS rather than running without it. The ids of an administrator's own
  // browser models are in that row and nowhere else; stamped past it, this
  // would never learn them once the operator repaired the row, and a profile
  // pinned to one would fail as "not found" from then on.
  const raw = readSettingsRow(db);
  if (raw !== null && settingsHaveResidue(raw)) {
    let parses = true;
    try {
      JSON.parse(raw);
    } catch {
      parses = false;
    }
    if (!parses) {
      report.deferred = true;
      report.notes.push(
        'The settings row names a browser chat provider but is not valid JSON, so the browser chat ' +
          'removal waits until it is repaired and runs on the first start after that.'
      );
      return report;
    }
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
    writeMigrationLog(db, report);
  })();

  return report;
}
