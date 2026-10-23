import type Database from 'better-sqlite3';
import { getDb } from './sqlite';

export interface StoredDocument {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/** A column's value, or null (a column that is empty for this document, like a resume not yet filed). */
type IndexedColumns = Record<string, string | number | null>;

/**
 * Small helper for tables that persist one JSON document per row alongside a
 * few indexed columns (id, timestamps, and any extra columns the caller maps).
 *
 * Every method takes an optional connection. A write that has to agree with
 * others - the tree of profiles and resumes (database/profileTree.ts) - runs in
 * ONE IMMEDIATE transaction on ONE connection, and a statement sent through a
 * second connection from inside it waits out the 5 s busy timeout and fails
 * with SQLITE_BUSY (a test that reloads database/sqlite leaves an older module
 * holding an older connection). Without one, the shared connection is used.
 */
export class DocumentTable<T extends StoredDocument> {
  constructor(
    private readonly table: string,
    private readonly indexedColumns: (document: T) => IndexedColumns = () => ({}),
    /**
     * Turns what was stored into the document, when reading it as it was
     * stored would hand on keys this build no longer has (a profile's old
     * member list). Not applied to a write: the document saved is the one given.
     */
    private readonly revive?: (raw: unknown) => T
  ) {}

  private parse(row: { data: string }): T {
    const raw = JSON.parse(row.data) as unknown;
    return this.revive ? this.revive(raw) : (raw as T);
  }

  list(db: Database.Database = getDb()): T[] {
    const rows = db
      .prepare(`SELECT data FROM ${this.table} ORDER BY updated_at DESC, id ASC`)
      .all() as Array<{ data: string }>;
    return rows.map((row) => this.parse(row));
  }

  get(id: string, db: Database.Database = getDb()): T | null {
    const row = db
      .prepare(`SELECT data FROM ${this.table} WHERE id = ?`)
      .get(id) as { data: string } | undefined;
    return row ? this.parse(row) : null;
  }

  has(id: string, db: Database.Database = getDb()): boolean {
    const row = db.prepare(`SELECT 1 FROM ${this.table} WHERE id = ?`).get(id);
    return Boolean(row);
  }

  save(document: T, db: Database.Database = getDb()): T {
    const extra = this.indexedColumns(document);
    const columns = ['id', 'data', 'created_at', 'updated_at', ...Object.keys(extra)];
    const placeholders = columns.map((column) => `@${column}`).join(', ');
    const updates = columns
      .filter((column) => column !== 'id')
      .map((column) => `${column} = excluded.${column}`)
      .join(', ');

    db
      .prepare(
        `INSERT INTO ${this.table} (${columns.join(', ')}) VALUES (${placeholders})
         ON CONFLICT(id) DO UPDATE SET ${updates}`
      )
      .run({
        id: document.id,
        data: JSON.stringify(document),
        created_at: document.createdAt,
        updated_at: document.updatedAt,
        ...extra,
      });

    return document;
  }

  /**
   * Saves several documents as one unit.
   *
   * An import is all-or-nothing, and a loop of `save` is not: a failure on the
   * fourth of six leaves three rows behind with nothing to say which. The
   * statements inside are the same ones `save` runs, so there is no second
   * write path to keep in step.
   */
  saveAll(documents: T[], db: Database.Database = getDb()): T[] {
    if (documents.length === 0) {
      return [];
    }
    db.transaction(() => {
      for (const document of documents) {
        this.save(document, db);
      }
    })();
    return documents;
  }

  delete(id: string, db: Database.Database = getDb()): boolean {
    const result = db.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id);
    return result.changes > 0;
  }
}
