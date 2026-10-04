import type Database from 'better-sqlite3';
import {
  migrate001,
  PROVIDER_SCHEMA_VERSION,
  type MigrationReport,
} from './001_openrouter_to_claude_cli';
import {
  migrate003,
  OWNERSHIP_SCHEMA_VERSION,
  type OwnershipMigrationReport,
} from './003_assign_owners';
import {
  migrate004,
  CREDIT_LEDGER_SCHEMA_VERSION,
  type CreditLedgerMigrationReport,
} from './004_credit_opening_balances';
import {
  migrate005,
  CODEX_MODEL_SCHEMA_VERSION,
  type CodexModelMigrationReport,
} from './005_seed_codex_model';
import {
  migrate006,
  BROWSER_CHAT_REMOVAL_SCHEMA_VERSION,
  type BrowserChatRemovalReport,
} from './006_remove_browser_chat';
import {
  migrate007,
  METERED_REMOVAL_SCHEMA_VERSION,
  type MeteredRemovalReport,
} from './007_remove_metered_providers';
import {
  migrate008,
  GEMINI_SEED_SCHEMA_VERSION,
  type GeminiSeedMigrationReport,
} from './008_seed_gemini_and_rename_seeds';

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

function describeOwnership(report: OwnershipMigrationReport): string {
  const parts: string[] = [];
  if (report.profiles) parts.push(`${report.profiles} profile(s)`);
  if (report.groups) parts.push(`${report.groups} group(s)`);
  return parts.length ? `${parts.join(' and ')} assigned to ${report.ownerEmail}` : 'nothing to change';
}

function describeCodexModel(report: CodexModelMigrationReport): string {
  return report.seededModels ? 'Codex model record added' : 'nothing to change';
}

function describeCreditLedger(report: CreditLedgerMigrationReport): string {
  return report.accounts
    ? `${report.units} credit(s) across ${report.accounts} account(s) given an opening entry`
    : 'nothing to change';
}

function describeBrowserChatRemoval(report: BrowserChatRemovalReport): string {
  const parts: string[] = [];
  if (report.removedModels) parts.push(`${report.removedModels} browser chat model(s) removed`);
  if (report.removedProviderFlags.length || report.removedSettingsKeys.length) {
    parts.push('browser chat settings removed');
  }
  if (report.enabledProviders.length) parts.push(`${report.enabledProviders.join(' and ')} switched on`);
  if (report.seededModels) parts.push(`${report.seededModels} subscription model(s) added`);
  if (report.reenabledModels.length) parts.push(`${report.reenabledModels.join(', ')} switched back on`);
  if (report.repointedDefaultModel) {
    parts.push(
      `default model ${report.repointedDefaultModel.from} -> ${report.repointedDefaultModel.to || '(app default)'}`
    );
  }
  if (report.clearedPromptOverrides) parts.push(`${report.clearedPromptOverrides} prompt override(s) cleared`);
  if (report.clearedProfilePreferences.length) {
    parts.push(`${report.clearedProfilePreferences.length} profile model preference(s) cleared`);
  }
  return parts.length ? parts.join(', ') : 'nothing to change';
}

function describeMeteredRemoval(report: MeteredRemovalReport): string {
  const parts: string[] = [];
  if (report.removedModels) parts.push(`${report.removedModels} metered API model(s) removed`);
  if (report.removedProviderFlags.length || report.removedSettingsKeys.length) {
    parts.push('metered API settings removed');
  }
  if (report.enabledProviders.length) parts.push(`${report.enabledProviders.join(' and ')} switched on`);
  if (report.seededModels) parts.push(`${report.seededModels} subscription model(s) added`);
  if (report.reenabledModels.length) parts.push(`${report.reenabledModels.join(', ')} switched back on`);
  if (report.repointedDefaultModel) {
    parts.push(
      `default model ${report.repointedDefaultModel.from} -> ${report.repointedDefaultModel.to || '(app default)'}`
    );
  }
  if (report.clearedPromptOverrides) parts.push(`${report.clearedPromptOverrides} prompt override(s) cleared`);
  if (report.clearedProfilePreferences.length) {
    parts.push(`${report.clearedProfilePreferences.length} profile model preference(s) cleared`);
  }
  if (report.scrubbedLegacySnapshot) parts.push('API keys deleted from the 001 snapshot');
  return parts.length ? parts.join(', ') : 'nothing to change';
}

function describeGeminiSeed(report: GeminiSeedMigrationReport): string {
  const parts: string[] = [];
  if (report.appendedModelIds.length) parts.push('Gemini model record added');
  if (report.renamedModels.length) {
    parts.push(`${report.renamedModels.length} seed model(s) renamed without "(subscription)"`);
  }
  return parts.length ? parts.join(', ') : 'nothing to change';
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
 *
 * Version 2 is missing, and that is deliberate. It seeded the browser chat
 * models, which 6 removes; kept, it would add them to an install still at
 * version 1 only for 6 to take them out again. The runner compares
 * `current >= version`, so a gap in the numbers costs nothing - an install at 1
 * goes straight on to 3.
 *
 * The chain is 1, 3-8, and a step that defers stops the ones after it: 3 waits
 * for the first administrator, 6 and 7 each wait on a settings row that names
 * what they remove but does not parse, and 8 on one whose model list does not.
 * So 7 can stay unrun for as long as 3 does, and the read-time tolerance for
 * what it removes has to stand on its own.
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
  {
    version: CREDIT_LEDGER_SCHEMA_VERSION,
    label: 'Credit ledger migration',
    apply: (db) => {
      const report = migrate004(db);
      return { ran: report.ran, notes: report.notes, summary: describeCreditLedger(report) };
    },
  },
  {
    version: CODEX_MODEL_SCHEMA_VERSION,
    label: 'Codex model migration',
    apply: (db) => {
      const report = migrate005(db);
      return { ran: report.ran, notes: report.notes, summary: describeCodexModel(report) };
    },
  },
  {
    version: BROWSER_CHAT_REMOVAL_SCHEMA_VERSION,
    label: 'Browser chat removal',
    apply: (db) => {
      const report = migrate006(db);
      return {
        ran: report.ran,
        deferred: report.deferred,
        notes: report.notes,
        summary: describeBrowserChatRemoval(report),
      };
    },
  },
  {
    version: METERED_REMOVAL_SCHEMA_VERSION,
    label: 'Metered provider removal',
    apply: (db) => {
      const report = migrate007(db);
      return {
        ran: report.ran,
        deferred: report.deferred,
        notes: report.notes,
        summary: describeMeteredRemoval(report),
      };
    },
  },
  {
    version: GEMINI_SEED_SCHEMA_VERSION,
    label: 'Gemini model and seed name migration',
    apply: (db) => {
      const report = migrate008(db);
      return {
        ran: report.ran,
        deferred: report.deferred,
        notes: report.notes,
        summary: describeGeminiSeed(report),
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
        // A step that waits on something only the operator can fix says what,
        // every boot until it is fixed; one that waits for an administrator has
        // nothing to say here, because the no-administrator warning says it.
        for (const note of report.notes) {
          console.warn(`[db] ${migration.label} is waiting: ${note}`);
        }
        // Not done, and not a failure: it is waiting on something a later boot
        // will have. STOP rather than skip - the version is a single monotonic
        // number, so letting a LATER migration run and write its own higher
        // version would put the database past this step and it would never be
        // retried. Every migration after a deferred one waits for it, which is
        // the same order they would have run in anyway.
        return;
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

export {
  PROVIDER_SCHEMA_VERSION,
  OWNERSHIP_SCHEMA_VERSION,
  CREDIT_LEDGER_SCHEMA_VERSION,
  CODEX_MODEL_SCHEMA_VERSION,
  BROWSER_CHAT_REMOVAL_SCHEMA_VERSION,
  METERED_REMOVAL_SCHEMA_VERSION,
  GEMINI_SEED_SCHEMA_VERSION,
};
export type {
  MigrationReport,
  OwnershipMigrationReport,
  CreditLedgerMigrationReport,
  CodexModelMigrationReport,
  BrowserChatRemovalReport,
  MeteredRemovalReport,
  GeminiSeedMigrationReport,
};
