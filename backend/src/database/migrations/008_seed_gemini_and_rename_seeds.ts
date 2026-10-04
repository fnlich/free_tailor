import type Database from 'better-sqlite3';

/**
 * Gives an existing install the Gemini model record it never got, and drops
 * "(subscription)" from the seed names nobody changed.
 *
 * The Gemini half is 005 again, for the third seat, and for 005's reasons: the
 * seed list is only ever read by a FRESH install - a stored `aiModels` list is
 * taken verbatim and never unioned with the seeds - while the new seat has no
 * flag in an older row and so reads as switched on. Without this an upgraded
 * install shows the Gemini seat enabled in Admin -> Settings with no model
 * anybody can pick. A row with no list of its own inherits the seeds at read
 * time and needs nothing.
 *
 * The rename is because display names are now the only part of a model a user
 * sees, and every model is a subscription seat: "(subscription)" says nothing
 * to them. Only a name EXACTLY as a release shipped it is changed, on the seed's
 * own provider and model - a name an administrator typed, even one that differs
 * by a space, is theirs and stays.
 *
 * Raw JSON and raw SQL, for the reason 001 gives, and every value spelled out
 * here rather than imported: a migration records what was true when it was
 * written. Idempotent by inspection - after `npm run ai:rollback` clears the
 * version stamp it runs again and must find nothing to do on a row it already
 * changed - and logged, appending to the log rather than replacing it.
 *
 * The log is read back: an appended Gemini record changes the set of models a
 * row has switched on, and the settings reader compares that set with what
 * migrations 006 and 007 left, to decide whether a row a lock has since emptied
 * is still the migrations' to repair. It counts what this appended as theirs.
 */

export const GEMINI_SEED_SCHEMA_VERSION = 8;
export const SETTINGS_KEY = 'app-settings';
export const MIGRATION_LOG_KEY = 'migration-log.provider-schema-8';

type Json = Record<string, unknown>;

/** The seed a fresh install of this release gets for the Gemini seat. */
const GEMINI_SEED_MODEL = {
  id: 'gemini-cli-auto',
  name: 'Gemini',
  provider: 'gemini-cli',
  modelName: 'auto',
  description: 'Runs the local gemini CLI on the signed-in Google account, letting it choose the model per request.',
  creditsPerResume: 1,
};

/**
 * Every seed name a release shipped with "(subscription)" in it, on the
 * provider and model it was shipped for. 001 and 006 seeded the three Claude
 * ones, 005 the Codex one, and every release's fresh-install seeds used the
 * same four.
 */
const SEED_RENAMES: ReadonlyArray<{ provider: string; modelName: string; from: string; to: string }> = [
  { provider: 'claude-cli', modelName: 'sonnet', from: 'Claude Sonnet (subscription)', to: 'Claude Sonnet' },
  { provider: 'claude-cli', modelName: 'opus', from: 'Claude Opus (subscription)', to: 'Claude Opus' },
  { provider: 'claude-cli', modelName: 'haiku', from: 'Claude Haiku (subscription)', to: 'Claude Haiku' },
  { provider: 'codex-cli', modelName: 'default', from: 'Codex (subscription)', to: 'Codex' },
];

export type GeminiSeedMigrationReport = {
  ran: boolean;
  deferred: boolean;
  settingsRewritten: boolean;
  appendedModelIds: string[];
  renamedModels: Array<{ id: string; from: string; to: string }>;
  /** Seed names left alone because another record already goes by the new one. */
  skippedRenames: Array<{ id: string; from: string; to: string }>;
  notes: string[];
};

/** 007's reading of the lock variables, spelled out here for the same reason: AI_UNLOCKED_PROVIDERS wins. */
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

/** Trimmed and lower-cased: how two display names look the same to a person. */
function sameName(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/** Appended to, never replaced; a log row that is not an object is left, and the run gets a dated key. */
function writeMigrationLog(db: Database.Database, report: GeminiSeedMigrationReport, at: string): void {
  const entry = {
    at,
    appendedModelIds: report.appendedModelIds,
    renamedModels: report.renamedModels,
    ...(report.skippedRenames.length ? { skippedRenames: report.skippedRenames } : {}),
  };
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

export function migrate008(db: Database.Database): GeminiSeedMigrationReport {
  const report: GeminiSeedMigrationReport = {
    ran: false,
    deferred: false,
    settingsRewritten: false,
    appendedModelIds: [],
    renamedModels: [],
    skippedRenames: [],
    notes: [],
  };

  const raw = readSettingRow(db, SETTINGS_KEY);
  // Fresh install, or a row that never saved: the seed list already has both.
  if (raw === null) return report;

  let settings: unknown;
  try {
    settings = JSON.parse(raw);
  } catch {
    // A list of its own that does not parse: it is the one thing this step
    // exists to change, and stamping the version past it would mean it never
    // gets the Gemini record once it is repaired. So the step waits, as 006 and
    // 007 do; a row with no list has nothing here to wait for.
    if (raw.includes('"aiModels"')) {
      report.deferred = true;
      report.notes.push(
        'The settings row has a model list but is not valid JSON, so adding the Gemini model to it waits ' +
          'until it is repaired and runs on the first start after that.'
      );
    }
    return report;
  }

  if (!isObject(settings) || !Array.isArray(settings.aiModels)) return report;

  const now = new Date().toISOString();
  let models = settings.aiModels as unknown[];

  // One at a time, against the list as renamed so far: users see display
  // names and nothing else, so a rename onto a name another record already
  // goes by - an administrator's own "Claude Sonnet" on another model, say -
  // would make two identical choices. That record keeps its name, this one
  // keeps the old one, and the log says so.
  models = [...models];
  for (const [index, model] of models.entries()) {
    if (!isObject(model)) continue;
    const modelName = typeof model.modelName === 'string' ? model.modelName.trim().toLowerCase() : '';
    const rename = SEED_RENAMES.find(
      (entry) => entry.provider === model.provider && entry.modelName === modelName && entry.from === model.name
    );
    if (!rename) continue;
    const id = typeof model.id === 'string' ? model.id : '';
    const taken = models.some((other, otherIndex) => otherIndex !== index && isObject(other) && sameName(other.name, rename.to));
    if (taken) {
      report.skippedRenames.push({ id, from: rename.from, to: rename.to });
      report.notes.push(
        `Left "${rename.from}" as it is: another model is already called "${rename.to}", and users see only ` +
          'display names. Rename one of the two under Admin > Models.'
      );
      continue;
    }
    report.renamedModels.push({ id, from: rename.from, to: rename.to });
    models[index] = { ...model, name: rename.to, updatedAt: now };
  }

  // Keyed on the PROVIDER, as 005 keys Codex: an administrator who already
  // added a Gemini record of their own has the seat covered, and a second one
  // would be a duplicate in every picker. The id is checked too, so the seed
  // can never collide with a record that happens to hold it.
  const hasGemini = models.some(
    (model) => isObject(model) && (model.provider === GEMINI_SEED_MODEL.provider || model.id === GEMINI_SEED_MODEL.id)
  );
  if (!hasGemini) {
    // Appended, never prepended: whatever stands first in an operator's list
    // is what an unset default falls back to, and a new seat must not become
    // the default of an install that never chose it. `defaultModelId` is not
    // touched - adding a record cannot strand it.
    models = [...models, { ...GEMINI_SEED_MODEL, enabled: true, createdAt: now, updatedAt: now }];
    report.appendedModelIds.push(GEMINI_SEED_MODEL.id);
    // Whether users can pick it now depends on the seat, and the note says
    // which rather than promising a model the pickers will not show.
    const added = `Added "${GEMINI_SEED_MODEL.name}" (${GEMINI_SEED_MODEL.id}) to the model list`;
    const providers = isObject(settings.providersEnabled) ? settings.providersEnabled : {};
    if (lockedHere(GEMINI_SEED_MODEL.provider)) {
      report.notes.push(
        `${added}. The Gemini seat is locked on this machine (AI_LOCKED_PROVIDERS), so users will not see it ` +
          'until the gemini CLI is installed and signed in here and the lock is removed.'
      );
    } else if (providers[GEMINI_SEED_MODEL.provider] === false) {
      report.notes.push(
        `${added}. The Gemini seat is switched off under Admin > Settings, so users will see it once it is ` +
          'switched on - after the gemini CLI is installed and signed in on this server.'
      );
    } else {
      report.notes.push(
        `${added}, so users can pick it now. ` +
          'Install and sign in to the gemini CLI on this server (npm i -g @google/gemini-cli, then run ' +
          '`NO_BROWSER=true gemini` once as the user the server runs as), or switch the Gemini seat off under ' +
          'Admin > Settings.'
      );
    }
  }

  if (report.appendedModelIds.length === 0 && report.renamedModels.length === 0) {
    // A skipped rename changes nothing in the row, but it is still reported -
    // logged and said once - so the clash is not left for somebody to find.
    if (report.skippedRenames.length > 0) {
      writeMigrationLog(db, report, now);
      report.ran = true;
    }
    return report;
  }

  settings.aiModels = models;
  db.transaction(() => {
    writeSettingRow(db, SETTINGS_KEY, JSON.stringify(settings), now);
    writeMigrationLog(db, report, now);
  })();
  report.settingsRewritten = true;
  report.ran = true;
  return report;
}
