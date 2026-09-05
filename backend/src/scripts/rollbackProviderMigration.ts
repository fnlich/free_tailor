import '../config/env';
import { getDb, getDatabasePath } from '../database/sqlite';
import {
  PROMPTS_BACKUP_TABLE,
  SETTINGS_BACKUP_KEY,
  SETTINGS_KEY,
} from '../database/migrations/001_openrouter_to_claude_cli';

/**
 * Undoes the provider migration by restoring the rows it backed up.
 *
 * The migration copies the settings row verbatim before rewriting it and the
 * affected prompt rows into a side table, so a rollback is a copy rather than a
 * reconstruction. Run this together with reverting the code - restoring an
 * `openrouter` settings row under the new code is harmless (the read-time
 * coercion handles it) but pointless.
 *
 *   npm run ai:rollback
 */
function main(): void {
  const db = getDb();
  console.log(`Database: ${getDatabasePath()}`);

  const backup = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTINGS_BACKUP_KEY) as
    | { value?: string }
    | undefined;

  if (!backup?.value) {
    console.log(`No settings backup found under "${SETTINGS_BACKUP_KEY}"; nothing to restore.`);
  } else {
    db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(SETTINGS_KEY, backup.value, new Date().toISOString());
    console.log('Restored the pre-migration settings row.');
  }

  const hasPromptBackups = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(PROMPTS_BACKUP_TABLE);

  if (hasPromptBackups) {
    const rows = db.prepare(`SELECT id, data FROM ${PROMPTS_BACKUP_TABLE}`).all() as Array<{
      id: string;
      data: string;
    }>;
    const update = db.prepare('UPDATE prompts SET data = ?, updated_at = ? WHERE id = ?');
    const now = new Date().toISOString();
    for (const row of rows) {
      update.run(row.data, now, row.id);
    }
    console.log(`Restored ${rows.length} prompt record(s).`);
  } else {
    console.log('No prompt backups found; nothing to restore.');
  }

  // Clearing the stamp lets the migration run again on the next boot, which is
  // what makes the rollback reversible rather than one-way.
  db.prepare('DELETE FROM schema_meta WHERE key = ?').run('provider_schema_version');
  console.log('Cleared the migration version stamp.');
}

main();
