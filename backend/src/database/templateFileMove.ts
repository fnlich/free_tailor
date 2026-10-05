import { createHash } from 'crypto';
import type Database from 'better-sqlite3';

import type { Template } from '../types/template';
import {
  canonicalTemplateId,
  isTemplateSource,
  readSavedTemplateFile,
  templateFileId,
  templateFileKind,
  writeTemplateFile,
} from './templateFiles';

/**
 * Moves the saved templates out of the `templates` table into files, once.
 *
 * Saved templates are files in `static/templates` now (templateFiles.ts), and
 * nothing reads the table any more - so a database an older build wrote has
 * to have its rows written out before its templates would vanish from the
 * app. Run from `getDb()`, beside the other in-place upgrades, and NOT as a
 * numbered migration: those wait in a chain behind 003, which waits for an
 * administrator, and every saved template would be missing until one signed
 * in.
 *
 * The promise is that every profile is drawn with the same template after the
 * upgrade as before it. The older build served a row by its EXACT id, which
 * could be `My_Template`, `Navy_Rule` or `_draft` (its importer kept upper
 * case and underscores), and a file name here is lower case and hyphens. So:
 *  - rows whose id already is a file id go first, and keep it: an exact id
 *    always keeps its own file, whatever order the rows were created in;
 *  - any other row is filed under its folded id (`My_Template` ->
 *    `my-template`) when that is free, and otherwise under a fresh `u-` id -
 *    never under a built-in's or another row's, which would hand its profiles
 *    a different design (`Navy_Rule` folds onto the shipped `navy-rule`);
 *  - the profiles naming a renamed row are changed to name its file, in the
 *    same transaction, and the old spelling stays an exact-match alias
 *    (`renamedTemplateId`) that lookups try BEFORE folding, for whatever still
 *    names it: a queued resume, a page left open, a profile import.
 * A fresh id is derived from the old one, not random, so a second pass (after
 * a crash, or after the record below was deleted on purpose) recognises the
 * file it wrote the first time instead of writing another copy.
 *
 * The rows stay where they are, as a backup nothing reads. What it did is
 * recorded in `schema_meta` (`templates_moved_to_files`), row by row: a row
 * that could not be WRITTEN - the directory is not writable, a file is in the
 * way and cannot be read - is tried again at the next start, and only it;
 * the rows already moved are not, so a template deleted or edited since stays
 * as the administrator left it. A row is left in the table for good only when
 * a file of its own exact id is already there - a built-in, which hid it from
 * the older build too, or a different saved template - or its data cannot be
 * read.
 *
 * Inside an IMMEDIATE transaction, so a second process opening the same
 * database at the same moment waits for this one and then finds the record.
 * Never fatal: a template it could not move is a missing template, not a
 * server that will not start.
 */

export const TEMPLATE_MOVE_MARKER = 'templates_moved_to_files';

export type TemplateMoveReport = {
  /** File ids written - or found already written by an earlier pass - in this pass. */
  moved: string[];
  /** Rows filed under another id than their own: `[old id, file id]`. */
  renamed: Array<[string, string]>;
  /** Rows left in the table on purpose, with why. */
  kept: Array<{ id: string; reason: string }>;
  /** Rows that could not be written; the next start tries these again. */
  failed: Array<{ id: string; reason: string }>;
  /** Profiles whose `preferredTemplate` named a renamed row, now naming its file. */
  repointedProfiles: number;
};

/** What `schema_meta` holds: every pass so far, merged, and whether any row is left to try. */
type MoveRecord = TemplateMoveReport & { complete: boolean };

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function reasonList(value: unknown): Array<{ id: string; reason: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string')
    .map((item) => ({ id: (item as { id: string }).id, reason: String((item as { reason?: unknown }).reason ?? '') }));
}

function renameList(value: unknown): Array<[string, string]> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (pair): pair is [string, string] =>
      Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string'
  );
}

/** The record, or null when there is none (or no `schema_meta` table yet). Never throws. */
function readRecord(db: Database.Database): MoveRecord | null {
  try {
    if (!tableExists(db, 'schema_meta')) return null;
    const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(TEMPLATE_MOVE_MARKER) as
      | { value: string }
      | undefined;
    if (!row) return null;
    let parsed: Record<string, unknown> = {};
    try {
      const value = JSON.parse(row.value) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch {
      // A record nobody can read is still a record that the move ran: it is
      // only ever written by this module, and only after a pass.
    }
    return {
      // A record from before rows were tracked one by one was written only
      // when nothing had failed, so it is complete.
      complete: parsed.complete !== false,
      moved: stringList(parsed.moved),
      renamed: renameList(parsed.renamed),
      kept: reasonList(parsed.kept),
      failed: reasonList(parsed.failed),
      repointedProfiles: typeof parsed.repointedProfiles === 'number' ? parsed.repointedProfiles : 0,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------- the old spellings, kept */

/** Per database file, so two databases in one process (the tests) never share one. */
const renamesByDatabase = new Map<string, Map<string, string>>();

function rememberRenames(db: Database.Database, renamed: Array<[string, string]>): void {
  renamesByDatabase.set(db.name, new Map(renamed));
}

/** How an older build matched a reference against a row's id: as written, less a `.json`. */
function referenceKey(id: string): string {
  return id.trim().replace(/\.json$/, '');
}

/**
 * The file id the move gave the row whose EXACT id this was, or null.
 *
 * Only ever an id no file could carry (`My_Template`, `Navy_Rule`, `_draft`):
 * a row whose id already was a file id kept it. Asked before a lookup folds,
 * because folding `Navy_Rule` gives the shipped `navy-rule`, not the row the
 * older build drew a profile naming it with.
 */
export function renamedTemplateId(db: Database.Database, id: string): string | null {
  let renames = renamesByDatabase.get(db.name);
  if (!renames) {
    renames = new Map(readRecord(db)?.renamed ?? []);
    renamesByDatabase.set(db.name, renames);
  }
  if (renames.size === 0) return null;
  return renames.get(id) ?? renames.get(referenceKey(id)) ?? null;
}

/* ------------------------------------------------------------- the pass */

type Row = { id: string; data: string };

function readRow(row: Row): Template | null {
  try {
    const parsed = JSON.parse(row.data) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Template;
  } catch {
    return null;
  }
}

/**
 * A fresh id for a row that cannot have its own, the shape an import mints -
 * derived from the old id, so every pass proposes the same ones in the same
 * order and finds the file an earlier pass wrote.
 */
function derivedId(oldId: string, attempt: number): string {
  return `u-${createHash('sha256').update(`${oldId}\u0000${attempt}`).digest('hex').slice(0, 8)}`;
}

function isNewer(candidate: unknown, than: unknown): boolean {
  const a = typeof candidate === 'string' ? Date.parse(candidate) : NaN;
  const b = typeof than === 'string' ? Date.parse(than) : NaN;
  return Number.isFinite(a) && (!Number.isFinite(b) || a > b);
}

type Placement = 'written' | 'already' | 'built-in' | 'taken' | { failed: string };

function runPass(db: Database.Database, previous: MoveRecord | null): TemplateMoveReport {
  const rows = db.prepare('SELECT id, data FROM templates ORDER BY created_at, id').all() as Row[];
  const done: TemplateMoveReport = { moved: [], renamed: [], kept: [], failed: [], repointedProfiles: 0 };

  // Rows an earlier pass settled are not looked at again: a template moved
  // and then deleted or edited is the administrator's decision now.
  const settled = new Set<string>([
    ...(previous?.moved ?? []),
    ...(previous?.renamed ?? []).map(([from]) => from),
    ...(previous?.kept ?? []).map((kept) => kept.id),
  ]);
  // Every row's own id that is a file id is spoken for, whatever becomes of
  // that row: a renamed row must never land on it.
  const reserved = new Set(rows.map((row) => row.id).filter((id) => templateFileId(id) === id));
  const written = new Set<string>();

  const place = (fileId: string, template: Template): Placement => {
    if (written.has(fileId)) return 'taken';
    const there = templateFileKind(fileId);
    if (there === 'unreadable') return { failed: `${fileId}.json is there but cannot be read` };
    if (there === 'built-in') return 'built-in';
    if (there === 'saved') {
      // The same template - same id (or the same derived one), same creation
      // time - is this row's own file from an earlier pass: one that wrote it
      // and could not record that, or one whose record was deleted so the
      // rows changed under an older build would be moved again. The row
      // replaces it only when the row is the newer of the two.
      const existing = readSavedTemplateFile(fileId);
      const sameTemplate =
        existing !== null && typeof template.createdAt === 'string' && existing.createdAt === template.createdAt;
      if (!sameTemplate) return 'taken';
      if (!isNewer(template.updatedAt, existing.updatedAt)) return 'already';
    }
    const source = isTemplateSource(template.source) ? template.source : template.manualConfig ? 'manual' : 'uploaded';
    try {
      writeTemplateFile({ ...template, id: fileId }, source);
      written.add(fileId);
      return 'written';
    } catch (error) {
      return { failed: error instanceof Error ? error.message : String(error) };
    }
  };

  const pending = rows.filter((row) => !settled.has(row.id));
  const ownIds = pending.filter((row) => templateFileId(row.id) === row.id);
  const otherIds = pending.filter((row) => templateFileId(row.id) !== row.id);

  for (const row of ownIds) {
    const template = readRow(row);
    if (!template) {
      done.kept.push({ id: row.id, reason: 'its data could not be read' });
      continue;
    }
    const placed = place(row.id, template);
    if (placed === 'written' || placed === 'already') {
      done.moved.push(row.id);
    } else if (placed === 'built-in') {
      done.kept.push({
        id: row.id,
        reason: `a built-in template is already ${row.id}.json, and it hid this row before the upgrade too`,
      });
    } else if (placed === 'taken') {
      done.kept.push({
        id: row.id,
        reason: `a different saved template is already ${row.id}.json, and a profile naming "${row.id}" is drawn with that one`,
      });
    } else {
      done.failed.push({ id: row.id, reason: placed.failed });
    }
  }

  for (const row of otherIds) {
    const template = readRow(row);
    if (!template) {
      done.kept.push({ id: row.id, reason: 'its data could not be read' });
      continue;
    }
    const folded = canonicalTemplateId(row.id);
    const candidates = [
      ...(folded && !reserved.has(folded) ? [folded] : []),
      ...Array.from({ length: 8 }, (_, attempt) => derivedId(row.id, attempt)).filter((id) => !reserved.has(id)),
    ];
    let fileId: string | null = null;
    let failure: string | null = null;
    for (const candidate of candidates) {
      const placed = place(candidate, template);
      if (placed === 'written' || placed === 'already') {
        fileId = candidate;
        break;
      }
      if (typeof placed === 'object') {
        failure = placed.failed;
        break;
      }
      // A built-in, or another template: the next name.
    }
    if (fileId) {
      done.moved.push(fileId);
      done.renamed.push([row.id, fileId]);
    } else {
      done.failed.push({ id: row.id, reason: failure ?? 'every file name tried for it is taken' });
    }
  }

  done.repointedProfiles = repointProfiles(db, done.renamed);
  return done;
}

/**
 * Changes every profile naming a renamed row to name its file instead, so the
 * profile editor, the Profiles list and the one-template-per-profile rule -
 * which compare ids as they are - agree with the server about which template
 * it is. `updated_at` is left alone: nobody edited these profiles.
 */
function repointProfiles(db: Database.Database, renamed: Array<[string, string]>): number {
  if (renamed.length === 0 || !tableExists(db, 'profiles')) return 0;
  const to = new Map(renamed);
  const update = db.prepare('UPDATE profiles SET data = ? WHERE id = ?');
  let changed = 0;
  for (const row of db.prepare('SELECT id, data FROM profiles').all() as Row[]) {
    let profile: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.data) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      profile = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const named = profile.preferredTemplate;
    if (typeof named !== 'string' || !named.trim()) continue;
    const target = to.get(named) ?? to.get(referenceKey(named));
    if (!target) continue;
    update.run(JSON.stringify({ ...profile, preferredTemplate: target }), row.id);
    changed += 1;
  }
  return changed;
}

export function moveTemplateRowsToFiles(db: Database.Database): TemplateMoveReport | null {
  let report: TemplateMoveReport | null = null;
  let record: MoveRecord | null = null;
  try {
    // Read first, outside any lock: every start after the move finds a
    // complete record here, and should not queue for the write lock to learn it.
    const before = readRecord(db);
    if (before?.complete) {
      rememberRenames(db, before.renamed);
      return null;
    }
    db.transaction(() => {
      if (!tableExists(db, 'templates') || !tableExists(db, 'schema_meta')) return;
      const previous = readRecord(db);
      if (previous?.complete) {
        record = previous;
        return;
      }
      const done = runPass(db, previous);
      const merged: MoveRecord = {
        complete: done.failed.length === 0,
        moved: [...new Set([...(previous?.moved ?? []), ...done.moved])],
        renamed: [...(previous?.renamed ?? []), ...done.renamed],
        kept: [...(previous?.kept ?? []), ...done.kept],
        // Only what failed THIS time: a row that failed before and was moved
        // now is in `moved`.
        failed: done.failed,
        repointedProfiles: (previous?.repointedProfiles ?? 0) + done.repointedProfiles,
      };
      db.prepare(
        `INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run(TEMPLATE_MOVE_MARKER, JSON.stringify(merged), new Date().toISOString());
      record = merged;
      report = done;
    }).immediate();
  } catch (error) {
    // Forgotten, so the next lookup reads whatever the database does hold.
    renamesByDatabase.delete(db.name);
    console.warn(
      '[templates] Could not move saved templates out of the database; trying again at the next start.',
      error
    );
    return null;
  }

  const settledRecord = record as MoveRecord | null;
  if (settledRecord) rememberRenames(db, settledRecord.renamed);
  const result = report as TemplateMoveReport | null;
  if (result) describeMove(result);
  return result;
}

function describeMove(report: TemplateMoveReport): void {
  if (report.moved.length > 0) {
    console.log(
      `[templates] Moved ${report.moved.length} saved template(s) from the database to files in static/templates; ` +
        'the rows are kept as a backup.'
    );
  }
  for (const [from, to] of report.renamed) {
    console.log(
      `[templates] Template "${from}" is now ${to}.json: profiles naming "${from}" were changed to name "${to}", ` +
        `and anything else still naming "${from}" finds it.`
    );
  }
  if (report.repointedProfiles > 0) {
    console.log(`[templates] ${report.repointedProfiles} profile(s) now name their template by its new id.`);
  }
  for (const kept of report.kept) {
    console.warn(`[templates] Template "${kept.id}" was left in the database and is not offered: ${kept.reason}.`);
  }
  for (const failed of report.failed) {
    console.warn(
      `[templates] Template "${failed.id}" could not be written to a file and is not offered until it is: ` +
        `${failed.reason}. The next start tries again.`
    );
  }
}
