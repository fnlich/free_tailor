import path from 'path';
import type Database from 'better-sqlite3';

import { envOutputBaseDir } from '../../config/settingDefaults';
import { normalizeOutputBaseDir, sanitizePathSegment } from '../../utils/outputStorage';
import type { MigrationOutcome, MigrationStep } from './index';

/**
 * Step 10, `orders-output-root` (owner decision O4): every run placed before
 * runs recorded their folder gets one, from the files it recorded.
 *
 * A download is claimed by the run whose folder holds the file
 * (`orders.output_root`, database/orderRepository.ts `ownersOfGeneratedFile`).
 * Runs placed by an older build were filed under a fixed tree,
 * `<account>/<date>/<order number>/<profile>/<company>`, and their folder was
 * found by reading the order number back out of a path at a fixed place - a
 * rule that cannot survive a prefix an administrator chooses. So each such run
 * is given the folder its own recorded files name: the path up to and
 * including the folder that is its sanitized order number (`ft_20260920_0001`,
 * `ft_run_...`), under the output folder in effect now - where the download
 * route resolves those files. A run that recorded no file - nothing finished,
 * or every resume failed - is left without one, and claims nothing but what
 * an item records (nothing): its unrecorded leftovers are refused to every
 * account rather than guessed at.
 *
 * Runs placed by this build record their folder as they are placed, so on a
 * fresh database, and on a second run, there is nothing to do (`ran: false`).
 * In one IMMEDIATE transaction, so a run placed by another process meanwhile
 * is neither read half-written nor overwritten.
 */

export const ORDERS_OUTPUT_ROOT_STEP_VERSION = 10;

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((entry) => entry.name === column);
}

/**
 * The output folder in effect, worked out as a settings read does
 * (config/aiModelConfig.ts `composeSettings`): an administrator's stored one,
 * else `OUTPUT_BASE_DIR`, else `generated/` in the checkout. From the row
 * itself rather than through the settings module, which reads the database
 * through the module running this step.
 */
function currentOutputBaseDir(db: Database.Database): string {
  if (hasTable(db, 'app_settings')) {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('app-settings') as
      | { value: string }
      | undefined;
    if (row) {
      try {
        const stored = JSON.parse(row.value) as { outputBaseDir?: unknown } | null;
        if (stored && typeof stored.outputBaseDir === 'string' && stored.outputBaseDir.trim()) {
          return normalizeOutputBaseDir(stored.outputBaseDir);
        }
      } catch {
        // A row that does not parse is the settings read's to report.
      }
    }
  }
  return envOutputBaseDir().value;
}

/** The recorded paths in an item's `files` column, '/'-separated; nothing for one that does not parse. */
function recordedPaths(files: string): string[] {
  try {
    const parsed = JSON.parse(files) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => (entry && typeof entry === 'object' ? (entry as { path?: unknown }).path : undefined))
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      .map((value) => value.replace(/\\/g, '/'));
  } catch {
    return [];
  }
}

/**
 * The run's folder by one of its recorded paths: up to and including the
 * folder named by its order number - a folder, not the file - or null when
 * no folder is, or the path steps outside the output folder.
 */
function folderOf(recorded: string, numberSegment: string): string[] | null {
  const segments = recorded.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  const at = segments.findIndex((segment) => segment.toLowerCase() === numberSegment);
  if (at < 0 || at >= segments.length - 1) return null;
  return segments.slice(0, at + 1);
}

function apply(db: Database.Database): MigrationOutcome {
  if (!hasTable(db, 'orders') || !hasTable(db, 'order_items')) {
    return { ran: false, notes: [], summary: 'there are no runs' };
  }
  if (!hasColumn(db, 'orders', 'output_root')) {
    // addMissingColumns could not add it (it logged why). Not done, and not a
    // failure: the next start tries both again.
    return {
      ran: false,
      deferred: true,
      notes: ['orders.output_root is missing, so runs cannot be given their folders yet.'],
      summary: '',
    };
  }

  const baseDir = currentOutputBaseDir(db);
  return db.transaction((): MigrationOutcome => {
    const rows = db
      .prepare(
        `SELECT o.id AS id, o.number AS number, i.files AS files
         FROM orders o JOIN order_items i ON i.order_id = o.id
         WHERE o.output_root IS NULL
         ORDER BY o.id, i.seq`
      )
      .all() as Array<{ id: string; number: string; files: string | null }>;
    if (rows.length === 0) return { ran: false, notes: [], summary: 'every run records its folder' };

    const found = new Map<string, string | null>();
    for (const row of rows) {
      if (found.get(row.id)) continue;
      const numberSegment = sanitizePathSegment(row.number ?? '');
      let folder: string[] | null = null;
      if (numberSegment) {
        for (const recorded of recordedPaths(row.files ?? '[]')) {
          folder = folderOf(recorded, numberSegment);
          if (folder) break;
        }
      }
      found.set(row.id, folder ? path.join(baseDir, ...folder) : null);
    }

    const update = db.prepare('UPDATE orders SET output_root = ? WHERE id = ? AND output_root IS NULL');
    let given = 0;
    for (const [id, root] of found) {
      if (!root) continue;
      update.run(path.resolve(root), id);
      given += 1;
    }
    const without = found.size - given;
    if (given === 0) {
      return { ran: false, notes: [], summary: `none of the ${without} run(s) without a folder recorded a file in one` };
    }
    return {
      ran: true,
      notes: [],
      summary:
        `${given} run(s) given the folder their files were recorded under, in ${baseDir}` +
        (without > 0 ? `; ${without} recorded no file in one and claim only what their items record` : ''),
    };
  }).immediate();
}

export const ordersOutputRootStep: MigrationStep = {
  version: ORDERS_OUTPUT_ROOT_STEP_VERSION,
  label: 'Migration 10 (orders-output-root)',
  apply,
};
