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

export function deleteSetting(key: string): void {
  getDb().prepare('DELETE FROM app_settings WHERE key = ?').run(key);
}
