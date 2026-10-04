import type Database from 'better-sqlite3';

/**
 * Gives an existing install the Codex model record it never got.
 *
 * Worth stating plainly, because adding a provider will keep looking finished
 * without a migration like this one. Three facts combine:
 *
 * - The seed list is only ever read by a FRESH install. `normalizeAIModelRecords`
 *   takes the stored `aiModels` array VERBATIM when there is one and never
 *   unions it with the defaults, so a row that has saved anything can never
 *   grow a new seed.
 * - `normalizeProvidersEnabled` ends in `?? true`, and Codex has no legacy flag
 *   to read instead, so `providersEnabled['codex-cli']` comes out TRUE on every
 *   upgraded install.
 * - The model picker lists models, not providers.
 *
 * So without this, Admin -> Settings shows Codex enabled with a green health
 * line while the builder, the profile picker and the app default have no way to
 * choose it - a provider that looks ready and cannot be reached. Recovery was
 * possible (add a record by hand under Admin -> Models) but nothing on screen
 * said it was needed.
 *
 * Raw JSON and raw SQL, for the same reason as 001: a migration that runs
 * through the validators only works on rows that did not need migrating.
 */

export const CODEX_MODEL_SCHEMA_VERSION = 5;
export const SETTINGS_KEY = 'app-settings';

type Json = Record<string, unknown>;

/**
 * One record, and `modelName: 'default'` is a sentinel meaning "pass no -m".
 *
 * Codex resolves its catalog from the signed-in account at runtime, so there is
 * no id that is true for every plan; whatever that account uses is the only
 * model name this can seed. A specific model is a record an operator adds under
 * Admin -> Models, which takes a free-text model name for any provider.
 *
 * Spelled out here rather than imported from the seed list, by the rule every
 * migration here follows: a migration records what was true when it was
 * written, so a later change to the seed text cannot rewrite an install that
 * already ran.
 */
const CODEX_SEED_MODEL = {
  id: 'codex-cli-default',
  name: 'Codex (subscription)',
  provider: 'codex-cli',
  modelName: 'default',
  description:
    "Runs on your ChatGPT subscription through the local codex CLI - no API key, nothing metered. Uses " +
    'whatever model that account is configured with.',
};

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type CodexModelMigrationReport = {
  ran: boolean;
  settingsRewritten: boolean;
  seededModels: number;
  notes: string[];
};

export function migrate005(db: Database.Database): CodexModelMigrationReport {
  const report: CodexModelMigrationReport = {
    ran: true,
    settingsRewritten: false,
    seededModels: 0,
    notes: [],
  };

  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTINGS_KEY) as
    | { value?: string }
    | undefined;

  if (!row?.value) {
    // Fresh install: the seed list already has the record.
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

  // Only where the row pins an explicit list: a row without one inherits the
  // seed list at read time and already has this, and writing a list here would
  // freeze that inheritance for good.
  if (!Array.isArray(settings.aiModels)) {
    return report;
  }

  const models = (settings.aiModels as unknown[]).filter(isObject);
  // Keyed on the PROVIDER, not the seed id: an operator who has already added a
  // Codex row of their own has the provider covered, and a second row for it
  // would be a duplicate in their picker.
  if (models.some((model) => model.provider === 'codex-cli')) {
    return report;
  }

  const now = new Date().toISOString();
  // Appended, never prepended. This is the operator's own model list and
  // whatever stands first is what an unset default falls back to - a new
  // provider must not become the default of an install that never chose it.
  settings.aiModels = [
    ...(settings.aiModels as unknown[]),
    { ...CODEX_SEED_MODEL, enabled: true, createdAt: now, updatedAt: now },
  ];
  report.seededModels = 1;

  // `defaultModelId` is deliberately NOT touched. Nothing here can strand it:
  // this migration only adds a row, so whatever the default pointed at still
  // resolves exactly as it did before.

  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(SETTINGS_KEY, JSON.stringify(settings), now);
  report.settingsRewritten = true;

  return report;
}
