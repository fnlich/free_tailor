import type Database from 'better-sqlite3';
import {
  migrate001,
  PROVIDER_SCHEMA_VERSION,
  type MigrationReport,
} from './001_openrouter_to_claude_cli';
import {
  migrate002,
  BROWSER_CHAT_SCHEMA_VERSION,
  type BrowserChatMigrationReport,
} from './002_seed_browser_chat_models';
import {
  migrate003,
  OWNERSHIP_SCHEMA_VERSION,
  type OwnershipMigrationReport,
} from './003_assign_owners';

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

/** The version a fully migrated database is at. */
export const CURRENT_SCHEMA_VERSION = OWNERSHIP_SCHEMA_VERSION;

function describe(report: MigrationReport): string {
  const parts: string[] = [];
  if (report.settingsRewritten) parts.push('settings rewritten');
  if (report.removedModels) parts.push(`${report.removedModels} OpenRouter model(s) removed`);
  if (report.seededModels) parts.push(`${report.seededModels} subscription model(s) added`);
  if (report.rewrittenPrompts) parts.push(`${report.rewrittenPrompts} prompt override(s) repointed`);
  if (report.clearedPromptOverrides) parts.push(`${report.clearedPromptOverrides} shipped prompt override(s) cleared`);
  return parts.length ? parts.join(', ') : 'nothing to change';
}

function describeBrowserChat(report: BrowserChatMigrationReport): string {
  const parts: string[] = [];
  if (report.seededModels) parts.push(`${report.seededModels} browser-chat model(s) added`);
  if (report.enabledProviders.length) parts.push(`${report.enabledProviders.join(' and ')} switched on`);
  if (report.repointedDefaultModel) parts.push('default model repointed off a locked provider');
  return parts.length ? parts.join(', ') : 'nothing to change';
}

function describeOwnership(report: OwnershipMigrationReport): string {
  const parts: string[] = [];
  if (report.profiles) parts.push(`${report.profiles} profile(s)`);
  if (report.groups) parts.push(`${report.groups} group(s)`);
  return parts.length ? `${parts.join(' and ')} assigned to ${report.ownerEmail}` : 'nothing to change';
}

/**
 * What the runner needs back from a migration, whatever else it reports.
 *
 * `deferred` says the step could not run yet through no fault of its own, and
 * the version must NOT be written - it has to be tried again on the next boot.
 * Distinct from `ran: false`, which means it looked and found nothing to do and
 * never needs to look again.
 */
type MigrationOutcome = { ran: boolean; notes: string[]; summary: string; deferred?: boolean };

type MigrationStep = {
  /** The version the database is at once this step has run. */
  version: number;
  label: string;
  apply: (db: Database.Database) => MigrationOutcome;
};

/**
 * The migrations, in order.
 *
 * A list rather than a single call so that an install already at version 1
 * runs only what it is missing - and so the version is written after EACH
 * step: a later migration that throws must not roll the earlier one's version
 * back and have it re-run against rows it has already rewritten. Each step
 * narrows its own report here, which is what keeps the runner from having to
 * know the shape of any of them.
 */
const MIGRATIONS: readonly MigrationStep[] = [
  {
    version: PROVIDER_SCHEMA_VERSION,
    label: 'Provider migration',
    apply: (db) => {
      const report = migrate001(db);
      return { ran: report.ran, notes: report.notes, summary: describe(report) };
    },
  },
  {
    version: BROWSER_CHAT_SCHEMA_VERSION,
    label: 'Browser-chat model migration',
    apply: (db) => {
      const report = migrate002(db);
      return { ran: report.ran, notes: report.notes, summary: describeBrowserChat(report) };
    },
  },
  {
    version: OWNERSHIP_SCHEMA_VERSION,
    label: 'Ownership migration',
    apply: (db) => {
      const report = migrate003(db);
      return {
        ran: report.ran,
        deferred: report.deferred,
        notes: report.notes,
        summary: describeOwnership(report),
      };
    },
  },
];

/**
 * Never throws. A migration that cannot run must not stop the server from
 * starting: the admin UI is the only place an operator can fix whatever went
 * wrong, and the read-time provider coercion means a un-migrated row still
 * works.
 */
export function runDataMigrations(db: Database.Database): void {
  let current = 0;
  try {
    current = readVersion(db);
  } catch (error) {
    console.error('[db] Could not read the schema version; skipping data migrations.', error);
    return;
  }

  for (const migration of MIGRATIONS) {
    if (current >= migration.version) {
      continue;
    }
    try {
      const report = migration.apply(db);
      if (report.ran) {
        console.log(`[db] ${migration.label} applied: ${report.summary}.`);
        for (const note of report.notes) {
          console.warn(`[db] ${note}`);
        }
      }
      if (report.deferred) {
        // Not done, and not a failure: it is waiting on something a later boot
        // will have. Leaving the version alone is what brings it back.
        continue;
      }
      writeVersion(db, migration.version);
      current = migration.version;
    } catch (error) {
      console.error(
        `[db] ${migration.label} failed. The stored rows are unchanged and the app reads them with the ` +
          'runtime fallbacks instead; it will be retried on the next start.',
        error
      );
      return;
    }
  }
}

export { PROVIDER_SCHEMA_VERSION, BROWSER_CHAT_SCHEMA_VERSION, OWNERSHIP_SCHEMA_VERSION };
export type { MigrationReport, BrowserChatMigrationReport, OwnershipMigrationReport };
