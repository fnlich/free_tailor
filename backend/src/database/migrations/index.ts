import type Database from 'better-sqlite3';
import {
  migrate001,
  PROVIDER_SCHEMA_VERSION,
  type MigrationReport,
} from './001_openrouter_to_claude_cli';

/**
 * Data migrations, run once per process on the first database use.
 *
 * Distinct from the schema DDL: `db.exec(SCHEMA)` creates tables, this rewrites
 * rows whose SHAPE is still valid but whose CONTENT names something the code no
 * longer knows about.
 */

const VERSION_KEY = 'provider_schema_version';

function readVersion(db: Database.Database): number {
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(VERSION_KEY) as
    | { value?: string }
    | undefined;
  const parsed = Number.parseInt(row?.value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function writeVersion(db: Database.Database, version: number): void {
  db.prepare(
    `INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(VERSION_KEY, String(version), new Date().toISOString());
}

function describe(report: MigrationReport): string {
  const parts: string[] = [];
  if (report.settingsRewritten) parts.push('settings rewritten');
  if (report.removedModels) parts.push(`${report.removedModels} OpenRouter model(s) removed`);
  if (report.seededModels) parts.push(`${report.seededModels} subscription model(s) added`);
  if (report.rewrittenPrompts) parts.push(`${report.rewrittenPrompts} prompt override(s) repointed`);
  if (report.clearedPromptOverrides) parts.push(`${report.clearedPromptOverrides} shipped prompt override(s) cleared`);
  return parts.length ? parts.join(', ') : 'nothing to change';
}

/**
 * Never throws. A migration that cannot run must not stop the server from
 * starting: the admin UI is the only place an operator can fix whatever went
 * wrong, and the read-time provider coercion means a un-migrated row still
 * works.
 */
export function runDataMigrations(db: Database.Database): void {
  try {
    if (readVersion(db) >= PROVIDER_SCHEMA_VERSION) {
      return;
    }

    const report = migrate001(db);
    if (report.ran) {
      console.log(`[db] Provider migration applied: ${describe(report)}.`);
      for (const note of report.notes) {
        console.warn(`[db] ${note}`);
      }
    }
    writeVersion(db, PROVIDER_SCHEMA_VERSION);
  } catch (error) {
    console.error(
      '[db] Provider migration failed; stored records naming the removed "openrouter" provider will be ' +
        'read as "claude-cli" at runtime instead.',
      error
    );
  }
}

export { PROVIDER_SCHEMA_VERSION };
export type { MigrationReport };
