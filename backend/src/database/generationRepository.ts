import { getDb } from './sqlite';

/**
 * Generation batches on disk, so a run survives the server restarting.
 *
 * Not `DocumentTable`, which stores one JSON blob per row and rewrites it whole
 * on every save. That is right for a profile, which changes when a person edits
 * it, and wrong here: a task changes state four times and a batch holds every
 * job description in the run, so saving the batch per transition would rewrite
 * about a megabyte a hundred and twenty times for one sheet import.
 *
 * So the batch is written once with the jobs on it, and each task writes its own
 * small row as it moves.
 */

export type StoredBatch = {
  id: string;
  state: string;
  /** Label, counts, the jobs, timestamps - everything but the tasks. */
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type StoredTask = {
  id: string;
  batchId: string;
  seq: number;
  state: string;
  /** Queue, sites, label, the runner's kind and payload, the result. */
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

function now(): string {
  return new Date().toISOString();
}

export function saveBatchRow(batch: Omit<StoredBatch, 'createdAt' | 'updatedAt'>): void {
  const timestamp = now();
  getDb()
    .prepare(
      `INSERT INTO generation_batches (id, state, data, created_at, updated_at)
       VALUES (@id, @state, @data, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state,
         data = excluded.data,
         updated_at = excluded.updated_at`
    )
    .run({
      id: batch.id,
      state: batch.state,
      data: JSON.stringify(batch.data),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
}

export function saveTaskRow(task: Omit<StoredTask, 'createdAt' | 'updatedAt'>): void {
  const timestamp = now();
  getDb()
    .prepare(
      `INSERT INTO generation_tasks (id, batch_id, seq, state, data, created_at, updated_at)
       VALUES (@id, @batchId, @seq, @state, @data, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state,
         data = excluded.data,
         updated_at = excluded.updated_at`
    )
    .run({
      id: task.id,
      batchId: task.batchId,
      seq: task.seq,
      state: task.state,
      data: JSON.stringify(task.data),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
}

/** Writes a whole batch and its tasks as one unit, so a submit is all or nothing. */
export function saveBatchWithTasks(
  batch: Omit<StoredBatch, 'createdAt' | 'updatedAt'>,
  tasks: Array<Omit<StoredTask, 'createdAt' | 'updatedAt'>>
): void {
  const db = getDb();
  db.transaction(() => {
    saveBatchRow(batch);
    for (const task of tasks) saveTaskRow(task);
  })();
}

export function deleteBatchRow(id: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM generation_tasks WHERE batch_id = ?').run(id);
    db.prepare('DELETE FROM generation_batches WHERE id = ?').run(id);
  })();
}

export type LoadedBatch = StoredBatch & { tasks: StoredTask[] };

function parse(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A row this build cannot read is worth skipping rather than crashing the
    // boot it was written to survive.
    return {};
  }
}

/** Every stored batch, newest first, with its tasks in submitted order. */
export function loadBatchRows(): LoadedBatch[] {
  const db = getDb();
  const batches = db
    .prepare('SELECT id, state, data, created_at, updated_at FROM generation_batches ORDER BY created_at DESC')
    .all() as Array<{ id: string; state: string; data: string; created_at: string; updated_at: string }>;

  if (batches.length === 0) return [];

  const taskRows = db
    .prepare('SELECT id, batch_id, seq, state, data, created_at, updated_at FROM generation_tasks ORDER BY batch_id, seq')
    .all() as Array<{
    id: string;
    batch_id: string;
    seq: number;
    state: string;
    data: string;
    created_at: string;
    updated_at: string;
  }>;

  const byBatch = new Map<string, StoredTask[]>();
  for (const row of taskRows) {
    const list = byBatch.get(row.batch_id) ?? [];
    list.push({
      id: row.id,
      batchId: row.batch_id,
      seq: row.seq,
      state: row.state,
      data: parse(row.data),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
    byBatch.set(row.batch_id, list);
  }

  return batches.map((row) => ({
    id: row.id,
    state: row.state,
    data: parse(row.data),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tasks: byBatch.get(row.id) ?? [],
  }));
}

/** Drops finished batches older than the cutoff. Returns how many went. */
export function pruneBatchRows(finishedBefore: string): number {
  const db = getDb();
  return db.transaction(() => {
    const stale = db
      .prepare(
        `SELECT id FROM generation_batches
         WHERE state != 'running' AND updated_at < ?`
      )
      .all(finishedBefore) as Array<{ id: string }>;

    for (const row of stale) {
      db.prepare('DELETE FROM generation_tasks WHERE batch_id = ?').run(row.id);
      db.prepare('DELETE FROM generation_batches WHERE id = ?').run(row.id);
    }
    return stale.length;
  })();
}
