import { getDb } from './sqlite';

export interface StoredDocument {
  id: string;
  createdAt: string;
  updatedAt: string;
}

type IndexedColumns = Record<string, string | number>;

/**
 * Small helper for tables that persist one JSON document per row alongside a
 * few indexed columns (id, timestamps, and any extra columns the caller maps).
 */
export class DocumentTable<T extends StoredDocument> {
  constructor(
    private readonly table: string,
    private readonly indexedColumns: (document: T) => IndexedColumns = () => ({})
  ) {}

  private parse(row: { data: string }): T {
    return JSON.parse(row.data) as T;
  }

  list(): T[] {
    const rows = getDb()
      .prepare(`SELECT data FROM ${this.table} ORDER BY updated_at DESC, id ASC`)
      .all() as Array<{ data: string }>;
    return rows.map((row) => this.parse(row));
  }

  get(id: string): T | null {
    const row = getDb()
      .prepare(`SELECT data FROM ${this.table} WHERE id = ?`)
      .get(id) as { data: string } | undefined;
    return row ? this.parse(row) : null;
  }

  has(id: string): boolean {
    const row = getDb().prepare(`SELECT 1 FROM ${this.table} WHERE id = ?`).get(id);
    return Boolean(row);
  }

  save(document: T): T {
    const extra = this.indexedColumns(document);
    const columns = ['id', 'data', 'created_at', 'updated_at', ...Object.keys(extra)];
    const placeholders = columns.map((column) => `@${column}`).join(', ');
    const updates = columns
      .filter((column) => column !== 'id')
      .map((column) => `${column} = excluded.${column}`)
      .join(', ');

    getDb()
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

  delete(id: string): boolean {
    const result = getDb().prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id);
    return result.changes > 0;
  }
}
