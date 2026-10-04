import { getDb } from './sqlite';

type SettingRow = { value: string; updated_at: string | null };

/** Reads the raw JSON string stored under a settings key, or null when unset. */
export function getSettingRaw(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    | Pick<SettingRow, 'value'>
    | undefined;
  return row ? row.value : null;
}

/**
 * The raw values stored under `key` and under every `key.<suffix>`, in key
 * order - for a record that spills over into dated keys of its own, as a
 * migration log does when the row it appends to has been edited into
 * something it cannot append to. Compared by prefix rather than LIKE, so an
 * underscore in a key is not a wildcard.
 */
export function getSettingFamilyRaw(key: string): string[] {
  const rows = getDb()
    .prepare('SELECT value FROM app_settings WHERE key = ? OR substr(key, 1, ?) = ? ORDER BY key')
    .all(key, key.length + 1, `${key}.`) as Array<Pick<SettingRow, 'value'>>;
  return rows.map((row) => row.value);
}

/**
 * Reads and parses a JSON settings value.
 * Throws when the stored value is not valid JSON so corrupted data is surfaced instead of silently replaced.
 */
export function getSetting<T>(key: string): T | null {
  const raw = getSettingRaw(key);
  if (raw === null) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(
      `Settings record "${key}" contains invalid JSON: ${error instanceof Error ? error.message : 'Unknown parse error'}`
    );
  }
}

export function setSetting(key: string, value: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (@key, @value, @updated_at)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run({ key, value: JSON.stringify(value), updated_at: new Date().toISOString() });
}

