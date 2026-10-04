import type Database from 'better-sqlite3';

/**
 * Removes what the metered API providers left in the database.
 *
 * `claude` (the Anthropic Messages API), `openai` and `deepseek` billed every
 * token to an API key in `.env`. The app runs on subscription seats only now -
 * the `claude`, `codex` and `gemini` CLIs, signed in on the server - and holds
 * no key for anything. Like the browser chat providers before them (006), the
 * three are retired with nothing to repoint them to: an API model name is not a
 * seat alias (`gpt-5-nano` is API-only and Codex refuses it), and moving a
 * record onto a seat would change what the run costs behind its owner's back.
 * Their records are deleted, and everything that named them falls back to what
 * it would have used had it named nothing at all.
 *
 * Raw JSON and raw SQL, for the reason 001 gives: it must never call
 * `readSettings`, `normalizeSettings` or `normalizePromptModelSelection`, the
 * validators the data may not yet satisfy. And every id is spelled out here
 * rather than imported from the provider catalog: a migration records what was
 * true when it was written, and the catalog no longer knows these ids at all.
 *
 * A convenience, not a prerequisite - exactly as 001 and 006 are. It sits
 * behind 003 in the chain, which waits for the first administrator, and a
 * restored backup, a hand-edited row or `npm run migrate:legacy` can bring the
 * residue back after it has run. So every read path tolerates the rows this
 * rewrites (see `RETIRED_PROVIDER_IDS` in config/providerCatalog), and what
 * this adds is that the residue goes for good, with a record of what it was.
 * It is idempotent by inspection rather than by stamp for the same reason:
 * `npm run ai:rollback` clears the version stamp and restores 001's snapshot,
 * which is full of metered records, so this runs again after it and must find
 * nothing to do on rows it has already cleaned - or clean what came back and
 * add to its log rather than replace it.
 *
 * What it changes, in one transaction:
 *
 *   1. App settings. The metered model records, their enable flags, the flat
 *      flags an older row carries (`claudeEnabled`, `openaiEnabled`,
 *      `deepseekEnabled`) and any stored API key store go. A default that named
 *      a removed model is repointed, and an install left with no enabled seat
 *      or no runnable model gets a seat back - never anything billed per token.
 *      A snapshot of the row is taken first, once, under `SETTINGS_BACKUP_KEY`:
 *      verbatim, apart from the API key store, which must not outlive the row.
 *   2. Prompts. A model override naming a removed provider is cleared - cleared
 *      means "use the model chosen for the run" - after the row is copied into
 *      `PROMPTS_BACKUP_TABLE`.
 *   3. Profiles. A stored model preference naming a removed model is cleared;
 *      the previous values are kept in the migration log, which a later run
 *      appends to and never overwrites.
 *   4. 001's snapshot. `LEGACY_SNAPSHOT_KEY` is the last plaintext copy of the
 *      API keys an older release stored, keys nothing here can use any more;
 *      they are deleted from it and the rest of the snapshot is kept.
 *
 * A settings row that is not valid JSON but plainly names a metered provider
 * makes the whole step wait, as 006 waits: the ids of an administrator's own
 * metered models are only in that row, and stamping the version past it would
 * mean they were never learned once the row is repaired.
 *
 * Queued generation tasks are deliberately NOT touched. The restore path
 * resolves a model again for a task that named a retired provider and puts it in
 * the lane of what it resolves to - which covers a task restored before this
 * step has run, too.
 */

export const METERED_REMOVAL_SCHEMA_VERSION = 7;
export const SETTINGS_KEY = 'app-settings';
export const SETTINGS_BACKUP_KEY = 'app-settings.backup.pre-metered-removal';
export const MIGRATION_LOG_KEY = 'migration-log.provider-schema-7';
export const PROMPTS_BACKUP_TABLE = 'prompts_backup_pre_metered_removal';
/** 001's snapshot, taken verbatim - stored API keys included. */
export const LEGACY_SNAPSHOT_KEY = 'app-settings.backup.pre-claude-cli';

const RETIRED_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'openai', 'deepseek']);

/** Every metered seed id a release ever shipped. */
const RETIRED_MODEL_IDS: ReadonlySet<string> = new Set([
  'openai-gpt-5-1',
  'openai-gpt-5',
  'openai-gpt-5-mini',
  'openai-gpt-5-nano',
  'claude-claude-sonnet-4-20250514',
  'deepseek-deepseek-v4-flash',
  'deepseek-deepseek-v4-pro',
]);

/**
 * The variables an older release named a metered seed after, and the provider
 * each seeded: with one set, the seed list held `<provider>-<slug of it>` in
 * place of the shipped default. Model names, not keys - the only thing this
 * step reads from them is the id a row with no list of its own inherited.
 */
const SEED_MODEL_VARIABLES: ReadonlyArray<{ variable: string; provider: string }> = [
  { variable: 'OPENAI_MODEL', provider: 'openai' },
  { variable: 'CLAUDE_MODEL', provider: 'claude' },
  { variable: 'DEEPSEEK_MODEL', provider: 'deepseek' },
];

/** Settings keys that only ever configured the metered providers. */
const RETIRED_SETTINGS_KEYS = ['apiKeys', 'claudeEnabled', 'openaiEnabled', 'deepseekEnabled'];

/**
 * The seats this build runs, in catalog order, and the flat flag an older row
 * may carry for each. Needed to decide whether anything is still switched on,
 * the way the settings reader decides it: a seat with no entry in
 * `providersEnabled` reads its flat flag, and with neither it reads as ON.
 */
const SEATS: ReadonlyArray<{ id: string; legacyFlags: string[] }> = [
  { id: 'claude-cli', legacyFlags: ['claudeCliEnabled', 'openrouterEnabled'] },
  { id: 'codex-cli', legacyFlags: [] },
  { id: 'gemini-cli', legacyFlags: [] },
];

const SEAT_DEFAULT_MODEL_ID = 'claude-cli-sonnet';

type SeedModel = {
  id: string;
  name: string;
  provider: string;
  modelName: string;
  description: string;
  creditsPerResume: number;
};

/**
 * What each seat is restored with, and which of its models a revived seat
 * switches back on - the seed list of this release, so a model this restores
 * reads exactly like a fresh install's.
 */
const SEAT_SEEDS: Readonly<Record<string, { defaultModelName: string; models: SeedModel[] }>> = {
  'claude-cli': {
    defaultModelName: 'sonnet',
    models: [
      {
        id: 'claude-cli-sonnet',
        name: 'Claude Sonnet',
        provider: 'claude-cli',
        modelName: 'sonnet',
        description: 'Balanced default for tailoring, analysis and extraction on the subscription seat.',
        creditsPerResume: 1,
      },
      {
        id: 'claude-cli-opus',
        name: 'Claude Opus',
        provider: 'claude-cli',
        modelName: 'opus',
        description: 'Highest-capability model on the subscription seat, for the most demanding prompts.',
        creditsPerResume: 1,
      },
      {
        id: 'claude-cli-haiku',
        name: 'Claude Haiku',
        provider: 'claude-cli',
        modelName: 'haiku',
        description: 'Fastest model on the subscription seat, for classification and short extractions.',
        creditsPerResume: 1,
      },
    ],
  },
  'codex-cli': {
    defaultModelName: 'default',
    models: [
      {
        id: 'codex-cli-default',
        name: 'Codex',
        provider: 'codex-cli',
        modelName: 'default',
        description:
          "Runs the local codex CLI on your ChatGPT subscription, using that account's own default model.",
        creditsPerResume: 1,
      },
    ],
  },
  'gemini-cli': {
    defaultModelName: 'auto',
    models: [
      {
        id: 'gemini-cli-auto',
        name: 'Gemini',
        provider: 'gemini-cli',
        modelName: 'auto',
        description:
          'Runs the local gemini CLI on the signed-in Google account, letting it choose the model per request.',
        creditsPerResume: 1,
      },
    ],
  },
};

/**
 * The provider lock, read the way config/providerCatalog reads it: two env
 * lists, comma or space separated, with the unlock winning.
 *
 * The one machine fact this reads that decides anything, and it has to: a lock
 * is how an operator says a seat cannot run here, and a repair that switched on
 * - or repointed the default onto - a locked seat would write a row the
 * settings reader still cannot run, then stamp the version so nothing ever
 * looked at it again. Spelled out rather than imported, by the rule every
 * migration here keeps. No `*_API_KEY` is read: nothing this brings back bills.
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

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRetiredProvider(value: unknown): boolean {
  return typeof value === 'string' && RETIRED_PROVIDERS.has(value.trim());
}

function slug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'model'
  );
}

/**
 * The metered seed ids this environment's leftover `*_MODEL` variables
 * produced. One that would look like a seat's id (`CLAUDE_MODEL=cli-sonnet`)
 * belongs to the seat and is left out.
 */
function envDerivedModelIds(): string[] {
  const ids: string[] = [];
  for (const { variable, provider } of SEED_MODEL_VARIABLES) {
    const value = (process.env[variable] ?? '').trim();
    if (!value) continue;
    const id = `${provider}-${slug(value)}`;
    if (SEATS.some((seat) => id.startsWith(`${seat.id}-`))) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The shipped metered seed ids, and the ones this machine's `.env` derived. */
function retiredModelIds(): Set<string> {
  return new Set([...RETIRED_MODEL_IDS, ...envDerivedModelIds()]);
}

/**
 * The id a stored model record goes by. A record saved without one is given
 * `<provider>-<slug>` when it is read, so a reference to it uses that.
 */
function modelIdOf(model: Json): string {
  if (typeof model.id === 'string' && model.id.trim()) return model.id.trim();
  const provider = typeof model.provider === 'string' ? model.provider.trim() : '';
  return `${provider}-${slug(typeof model.modelName === 'string' ? model.modelName : '')}`;
}

function readSettingRow(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value?: string } | undefined;
  return row?.value ?? null;
}

function writeSettingRow(db: Database.Database, key: string, value: string, at: string): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, at);
}

/** A provider key, a record's provider, the key store or a flat flag, in a row that does not parse. */
const UNPARSEABLE_RESIDUE = new RegExp(
  [
    '"(?:claude|openai|deepseek)"\\s*:',
    '"provider"\\s*:\\s*"(?:claude|openai|deepseek)"',
    '"apiKeys"',
    '"(?:claude|openai|deepseek)Enabled"',
  ].join('|')
);

function settingsHaveResidue(raw: string): boolean {
  let settings: unknown;
  try {
    settings = JSON.parse(raw);
  } catch {
    // Unreadable. Said once by the run itself, which leaves the row alone; the
    // substring is the only test there is for a row that does not parse.
    return UNPARSEABLE_RESIDUE.test(raw);
  }
  if (!isObject(settings)) return false;

  if (RETIRED_SETTINGS_KEYS.some((key) => Object.prototype.hasOwnProperty.call(settings, key))) return true;
  if (isObject(settings.providersEnabled) && Object.keys(settings.providersEnabled).some(isRetiredProvider)) {
    return true;
  }
  if (
    Array.isArray(settings.aiModels) &&
    settings.aiModels.some((model) => isObject(model) && isRetiredProvider(model.provider))
  ) {
    return true;
  }
  return typeof settings.defaultModelId === 'string' && retiredModelIds().has(settings.defaultModelId.trim());
}

/** Prompt rows whose override names a removed provider. */
function promptsWithResidue(db: Database.Database): Array<{ id: string; data: string; record: Json }> {
  // Narrowed on the key, never on a provider name: `openai` and `claude` are
  // words a prompt's own text can use.
  const candidates = db
    .prepare(`SELECT id, data FROM prompts WHERE data LIKE '%"modelProvider"%'`)
    .all() as Array<{ id: string; data: string }>;

  const found: Array<{ id: string; data: string; record: Json }> = [];
  for (const row of candidates) {
    let record: unknown;
    try {
      record = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (isObject(record) && isRetiredProvider(record.modelProvider)) found.push({ ...row, record });
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
  const candidates = db
    .prepare(`SELECT id, data FROM profiles WHERE data LIKE '%"modelId"%'`)
    .all() as Array<{ id: string; data: string }>;

  const found: Array<{ id: string; document: Json; modelId: string }> = [];
  for (const row of candidates) {
    let document: unknown;
    try {
      document = JSON.parse(row.data);
    } catch {
      // Left exactly as it is: writing a repaired blob over a row this build
      // cannot parse would destroy whatever it holds.
      continue;
    }
    if (!isObject(document)) continue;
    const modelId = profileModelId(document);
    if (modelId && modelIds.has(modelId)) found.push({ id: row.id, document, modelId });
  }
  return found;
}

/** 001's snapshot, parsed, when it still holds an API key store. */
function legacySnapshotWithKeys(db: Database.Database): Json | null {
  const raw = readSettingRow(db, LEGACY_SNAPSHOT_KEY);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isObject(parsed) && Object.prototype.hasOwnProperty.call(parsed, 'apiKeys') ? parsed : null;
}

/** True when anything in the database still names the removed providers. */
export function hasMeteredResidue(db: Database.Database): boolean {
  const raw = readSettingRow(db, SETTINGS_KEY);
  if (raw !== null && settingsHaveResidue(raw)) return true;
  if (promptsWithResidue(db).length > 0) return true;
  if (legacySnapshotWithKeys(db) !== null) return true;
  return profilesNaming(db, retiredModelIds()).length > 0;
}

export type MeteredRemovalReport = {
  ran: boolean;
  /**
   * True when the settings row names a metered provider but cannot be parsed:
   * the step waits, unstamped, for the row to be repaired. See `migrate007`.
   */
  deferred: boolean;
  settingsRewritten: boolean;
  /** Metered model records deleted from the settings row. */
  removedModels: number;
  /**
   * Every id a reference to a metered model may use: the records deleted from
   * the row, and the seed ids this machine's `*_MODEL` variables derived, which
   * a row with no model list of its own inherited without storing them. Read
   * back by the settings reader, so they keep reading as the default after a
   * restart and after those variables are gone.
   */
  removedModelIds: string[];
  /** `providersEnabled` entries deleted. */
  removedProviderFlags: string[];
  /** Settings keys deleted. `apiKeys` is named here; what it held never is. */
  removedSettingsKeys: string[];
  /** Seats switched on so the install is left with one that runs. */
  enabledProviders: string[];
  /** Seat models added so the install is left with one that runs. */
  seededModels: number;
  /** Existing seat models switched back on, for the same reason. */
  reenabledModels: string[];
  /** The default model, when it named a removed model. */
  repointedDefaultModel: { from: string; to: string } | null;
  /** Prompt rows whose model override was cleared. */
  clearedPromptOverrides: number;
  /** Profiles whose stored model preference was cleared, and what it was. */
  clearedProfilePreferences: Array<{ profileId: string; modelId: string }>;
  /** True when the API keys were deleted from 001's snapshot. */
  scrubbedLegacySnapshot: boolean;
  /**
   * What the run left the settings row running on, or null when it did not
   * rewrite the row: every seat's switch as the settings reader will read it,
   * and the ids of the models left switched on, sorted - null there when the
   * row has no list of its own and inherits the seed models.
   *
   * Kept in the log because the reader repairs a row that can run nothing only
   * while it is still the row the latest removal left. Once an administrator
   * has changed which seats or models are on, a lock added later is theirs to
   * answer, and the reader names it rather than undo their choice.
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
  return recordedSwitch(settings, providersEnabled, id) ?? true;
}

/** What the row records for `id`, or null when it records nothing. */
function recordedSwitch(settings: Json, providersEnabled: Json, id: string): boolean | null {
  if (typeof providersEnabled[id] === 'boolean') return providersEnabled[id] as boolean;
  const seat = SEATS.find((entry) => entry.id === id);
  if (!seat) return null;
  for (const flag of seat.legacyFlags) {
    if (typeof settings[flag] === 'boolean') return settings[flag] as boolean;
  }
  return null;
}

function migrateSettings(db: Database.Database, report: MeteredRemovalReport, removedIds: Set<string>): void {
  const raw = readSettingRow(db, SETTINGS_KEY);
  if (raw === null) {
    // Fresh install: the defaults describe a build with no metered provider.
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
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
  // than a reconstruction - except for the API key store, which would otherwise
  // be a permanent plaintext credential under a key nobody reads. Written once:
  // a second run must not overwrite the original with a row already cleaned.
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
      `The copy of the settings row under "${SETTINGS_BACKUP_KEY}" leaves out its stored API keys; nothing ` +
        'in this release uses an API key.'
    );
  }

  const now = new Date().toISOString();

  // 1. The model records. Deleted, not remapped: an API model name is not a
  //    seat alias, and a record moved onto a seat would change its price.
  const hasExplicitModels = Array.isArray(settings.aiModels);
  let models: unknown[] = hasExplicitModels ? (settings.aiModels as unknown[]) : [];
  if (hasExplicitModels) {
    const kept: unknown[] = [];
    for (const model of models) {
      if (isObject(model) && isRetiredProvider(model.provider)) {
        const id = modelIdOf(model);
        removedIds.add(id);
        if (!report.removedModelIds.includes(id)) report.removedModelIds.push(id);
        continue;
      }
      kept.push(model);
    }
    report.removedModels = models.length - kept.length;
    models = kept;
  }

  // 2. The enable flags, the flat ones an older row carries, and the key store.
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

  // 3. Something must still run. An operator who used the APIs alone - the
  //    seats unticked, or their models switched off - would otherwise come back
  //    to a row nothing can run on. A seat is what comes back, never a model
  //    billed per token.
  //
  //    "Can run" is the reader's test, lock included: switching a locked seat
  //    on would repair nothing, and the stamp written after this would stop
  //    anything from looking at the row again.
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
    SEATS.some((seat) => seat.id === model.provider) &&
    usable(model.provider);

  /**
   * The seat to bring back: one not locked here; one the row explicitly
   * switched on, then one it records nothing for, then one it switched off;
   * one with a model already switched on before one without; catalog order
   * after that. The settings reader repairs a row it reads by the same rule.
   */
  const repairTarget = (): string | null => {
    const hasEnabledModel = (id: string): boolean =>
      !hasExplicitModels ||
      models.some((model) => isObject(model) && model.provider === id && model.enabled !== false);
    const rank = (id: string): number => {
      const recorded = recordedSwitch(settings, providersEnabled, id);
      return (recorded === true ? 0 : recorded === null ? 1 : 2) * 2 + (hasEnabledModel(id) ? 0 : 1);
    };
    // A stable sort, so equal ranks keep catalog order.
    const candidates = SEATS.filter((seat) => !lockedHere(seat.id)).sort((a, b) => rank(a.id) - rank(b.id));
    return candidates[0]?.id ?? null;
  };

  /**
   * Said when the repair lands on a seat the row records no choice for - a seat
   * new since the row was saved reads as switched on, so it can win over one
   * the operator switched off. That is the rule, and the note is how they find
   * out it applied.
   */
  const unrecordedNote = (id: string): string =>
    recordedSwitch(settings, providersEnabled, id) === null
      ? ` The row recorded no choice for ${id}, which reads as switched on; switch it off under Admin > ` +
        'Settings if that is wrong.'
      : '';

  const lockedNote =
    'every subscription seat is locked on this machine (AI_LOCKED_PROVIDERS), so the row was left that way. ' +
    'Nothing can run until a seat is unlocked; the settings reader names the locks.';

  if (!SEATS.some((seat) => usable(seat.id))) {
    const target = repairTarget();
    if (target) {
      const note = unrecordedNote(target);
      switchOn(target);
      report.notes.push(
        'No seat this machine can run would have been left enabled once the metered API providers were ' +
          `removed, so ${target} was switched on. Review it under Admin > Settings.${note}`
      );
    } else {
      report.notes.push(`No provider would have been left enabled, and ${lockedNote}`);
    }
  }

  if (hasExplicitModels && !models.some(runnable)) {
    const target = repairTarget();
    if (target) {
      const note = unrecordedNote(target);
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

      // The seat's models were there all along and switched off. One comes
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
        'No model this machine can run would have been left once the metered API models were removed, ' +
          `so ${target}'s models were restored (${report.seededModels} added` +
          (report.reenabledModels.length ? `, ${report.reenabledModels.join(', ')} switched back on` : '') +
          `). Review them under Admin > Models.${note}`
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

  // 4. The default model, when it named a model that no longer exists - the
  //    common case on an install whose seats were locked, where the seed
  //    default was a metered model. The Claude seat's default model first,
  //    then the first runnable model in seat order rather than list order, so
  //    the repoint does not depend on where an operator happened to add a row.
  const currentDefault = typeof settings.defaultModelId === 'string' ? settings.defaultModelId.trim() : '';
  if (currentDefault && removedIds.has(currentDefault)) {
    let replacement = '';
    if (hasExplicitModels) {
      const candidates = models.filter(runnable);
      const pick =
        candidates.find((model) => modelIdOf(model) === SEAT_DEFAULT_MODEL_ID) ??
        SEATS.map((seat) => candidates.find((model) => model.provider === seat.id)).find(Boolean);
      replacement = pick ? modelIdOf(pick) : '';
    } else {
      // No explicit list: the row inherits the seed models, which include each
      // seat's default.
      const seat = SEATS.find((entry) => usable(entry.id));
      const seeds = seat ? SEAT_SEEDS[seat.id] : undefined;
      replacement = seeds?.models.find((model) => model.modelName === seeds.defaultModelName)?.id ?? '';
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
      SEATS.map((seat) => [seat.id, providerOn(settings, providersEnabled, seat.id)])
    ),
    enabledModelIds: hasExplicitModels
      ? models
          .filter((model): model is Json => isObject(model) && model.enabled !== false)
          .map((model) => modelIdOf(model))
          .sort()
      : null,
  };

  writeSettingRow(db, SETTINGS_KEY, JSON.stringify(settings), now);
  report.settingsRewritten = true;
}

function migratePrompts(db: Database.Database, report: MeteredRemovalReport): void {
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
    // Cleared on EVERY prompt, shipped or custom, and never repointed: a
    // dated Anthropic API id is not what the Claude seat expects, and an OpenAI
    // API-only name fails on Codex. A cleared override runs the prompt on the
    // model chosen for the run, as it would have had nobody set one.
    delete row.record.modelProvider;
    delete row.record.modelName;
    update.run(JSON.stringify(row.record), now, row.id);
    report.clearedPromptOverrides += 1;
  }
}

function migrateProfiles(db: Database.Database, report: MeteredRemovalReport, removedIds: Set<string>): void {
  const write = db.prepare('UPDATE profiles SET data = ? WHERE id = ?');
  for (const row of profilesNaming(db, removedIds)) {
    // Only the model id goes. An absent model means INHERIT: the app default,
    // as it already resolves on read.
    const ai = (row.document.profileSettings as Json).ai as Json;
    delete ai.modelId;
    write.run(JSON.stringify(row.document), row.id);
    report.clearedProfilePreferences.push({ profileId: row.id, modelId: row.modelId });
  }
}

/**
 * 001 snapshotted the settings row verbatim, API key store and all, and that
 * snapshot is what `npm run ai:rollback` restores. Nothing can use those keys
 * now, so they go; the rest of the snapshot is history and is kept, and a
 * rollback restores a row without keys, which the reader treats the same.
 */
function scrubLegacySnapshot(db: Database.Database, report: MeteredRemovalReport): void {
  const snapshot = legacySnapshotWithKeys(db);
  if (!snapshot) return;
  const { apiKeys: _discarded, ...withoutKeys } = snapshot;
  writeSettingRow(db, LEGACY_SNAPSHOT_KEY, JSON.stringify(withoutKeys), new Date().toISOString());
  report.scrubbedLegacySnapshot = true;
  report.notes.push(
    `Deleted the stored API keys from "${LEGACY_SNAPSHOT_KEY}", the last copy of them; nothing in this ` +
      'release uses an API key. The rest of that snapshot is kept.'
  );
}

/**
 * Appended, never replaced, because this log is the ONLY record of the profile
 * preferences a run clears, and the settings reader reads every entry of it:
 * the model ids each run removed, and what the latest run that rewrote the row
 * left it running on. A log row somebody edited into something that is not an
 * object is left alone, and the run goes under its own dated key.
 */
function writeMigrationLog(db: Database.Database, report: MeteredRemovalReport): void {
  const at = new Date().toISOString();
  const entry = { ...report, at };
  const existing = readSettingRow(db, MIGRATION_LOG_KEY);

  let key = MIGRATION_LOG_KEY;
  let value: Json = entry;
  if (existing !== null) {
    let previous: unknown;
    try {
      previous = JSON.parse(existing);
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

  writeSettingRow(db, key, JSON.stringify(value), at);
}

/**
 * Applies the metered provider removal. Idempotent by inspection as well as by
 * version stamp, because a stamp can be cleared - `ai:rollback` does exactly
 * that - while the data it describes cannot be.
 */
export function migrate007(db: Database.Database): MeteredRemovalReport {
  const report: MeteredRemovalReport = {
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
    scrubbedLegacySnapshot: false,
    leftRunning: null,
    notes: [],
  };

  if (!hasMeteredResidue(db)) {
    return report;
  }

  // A settings row that names a metered provider but does not parse. Nothing
  // is written, and the step WAITS rather than running without it: the ids of
  // an administrator's own metered models are in that row and nowhere else.
  const raw = readSettingRow(db, SETTINGS_KEY);
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
        'The settings row names a metered API provider but is not valid JSON, so the metered provider ' +
          'removal waits until it is repaired and runs on the first start after that.'
      );
      return report;
    }
  }

  // Every model id that meant a metered API: the shipped seeds, the ones this
  // machine's `*_MODEL` variables derived, and whatever the settings pass finds
  // in the row - an administrator's own metered model has a random id that only
  // the row it is deleted from can name.
  const removedIds = retiredModelIds();
  // The derived ids are logged whether or not a record carried them: a row
  // with no list of its own inherited them, and once those variables are
  // deleted the log is the only thing that still knows them.
  report.removedModelIds.push(...envDerivedModelIds());

  db.transaction(() => {
    migrateSettings(db, report, removedIds);
    migratePrompts(db, report);
    migrateProfiles(db, report, removedIds);
    scrubLegacySnapshot(db, report);

    report.ran = true;
    if (report.clearedProfilePreferences.length > 0) {
      report.notes.push(
        `Cleared the stored model of ${report.clearedProfilePreferences.length} profile(s) that named a ` +
          'metered API model; they now use the app default. The previous values are in ' +
          `app_settings["${MIGRATION_LOG_KEY}"].`
      );
    }
    writeMigrationLog(db, report);
  })();

  return report;
}
