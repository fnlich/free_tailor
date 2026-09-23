import crypto from 'crypto';
import { getDb } from './sqlite';
import { formatSequenceDate, nextDailyReference } from './dailySequence';

/**
 * Orders and the resumes they delivered.
 *
 * The record a person comes back to. Its whole reason for existing is that the
 * generation batch cannot be that record: the dispatcher evicts a finished
 * batch after an hour and deletes its rows, so by the time somebody opens the
 * page the next morning there is nothing left to ask. Everything shown about an
 * order is therefore answered from here and never from the queue - which is
 * also what makes "122 of 300" keep working days later.
 *
 * Narrow writers rather than a save-the-whole-object update, in the style of
 * userRepository: a task finishing must touch one item row, not rewrite an
 * order with three hundred of them.
 */

export type OrderState = 'running' | 'done' | 'failed' | 'cancelled' | 'expired';
export type OrderItemState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/**
 * The four files one resume can produce.
 *
 * A closed union rather than free text, because it is also the address in a
 * download URL - `/api/orders/:id/items/:itemId/resume-pdf` - and an open set
 * there would be an open set of paths to validate.
 */
export const ORDER_FILE_KINDS = [
  'resume-pdf',
  'resume-docx',
  'cover-letter-pdf',
  'cover-letter-docx',
] as const;

export type OrderFileKind = (typeof ORDER_FILE_KINDS)[number];

export function isOrderFileKind(value: unknown): value is OrderFileKind {
  return typeof value === 'string' && (ORDER_FILE_KINDS as readonly string[]).includes(value);
}

export type OrderFile = {
  kind: OrderFileKind;
  /** Relative to the configured output base dir, forward slashes, as written. */
  path: string;
  bytes?: number;
  /** Set by the retention sweep. The row stays; the bytes are gone. */
  removedAt?: string;
};

export type Order = {
  id: string;
  number: string;
  userId: string;
  batchId?: string;
  label: string;
  total: number;
  state: OrderState;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  expiresAt: string;
  purgedAt?: string;
};

export type OrderItem = {
  id: string;
  orderId: string;
  seq: number;
  taskId?: string;
  profileId: string;
  profileName: string;
  companyName: string;
  role: string;
  sourceRowNumber?: number;
  state: OrderItemState;
  error?: string;
  files: OrderFile[];
  createdAt: string;
  updatedAt: string;
};

export type OrderCounts = {
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  /** Everything that will never move again. What a progress bar counts. */
  settled: number;
};

type OrderRow = {
  id: string;
  number: string;
  user_id: string;
  batch_id: string | null;
  label: string;
  total: number;
  state: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  expires_at: string | null;
  purged_at: string | null;
};

type OrderItemRow = {
  id: string;
  order_id: string;
  seq: number;
  task_id: string | null;
  profile_id: string;
  profile_name: string;
  company_name: string;
  role: string;
  source_row_number: number | null;
  state: string;
  error: string | null;
  files: string;
  created_at: string;
  updated_at: string;
};

const ORDER_COLUMNS = `id, number, user_id, batch_id, label, total, state,
  created_at, updated_at, finished_at, expires_at, purged_at`;

const ITEM_COLUMNS = `id, order_id, seq, task_id, profile_id, profile_name, company_name,
  role, source_row_number, state, error, files, created_at, updated_at`;

function now(): string {
  return new Date().toISOString();
}

function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    number: row.number,
    userId: row.user_id,
    ...(row.batch_id ? { batchId: row.batch_id } : {}),
    label: row.label ?? '',
    total: row.total,
    state: row.state as OrderState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    expiresAt: row.expires_at ?? row.created_at,
    ...(row.purged_at ? { purgedAt: row.purged_at } : {}),
  };
}

/**
 * Files come back out of a TEXT column, so nothing about them is guaranteed.
 *
 * A row written by an older build, or hand-edited, must not take a page down -
 * so anything unrecognisable is dropped rather than trusted, and a file with no
 * usable path is no file at all.
 */
function parseFiles(value: string): OrderFile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const files: OrderFile[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    const path = typeof candidate.path === 'string' ? candidate.path.trim() : '';
    if (!path || !isOrderFileKind(candidate.kind)) continue;
    files.push({
      kind: candidate.kind,
      path,
      ...(typeof candidate.bytes === 'number' ? { bytes: candidate.bytes } : {}),
      ...(typeof candidate.removedAt === 'string' ? { removedAt: candidate.removedAt } : {}),
    });
  }
  return files;
}

function toItem(row: OrderItemRow): OrderItem {
  return {
    id: row.id,
    orderId: row.order_id,
    seq: row.seq,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    profileId: row.profile_id ?? '',
    profileName: row.profile_name ?? '',
    companyName: row.company_name ?? '',
    role: row.role ?? '',
    ...(typeof row.source_row_number === 'number' ? { sourceRowNumber: row.source_row_number } : {}),
    state: row.state as OrderItemState,
    ...(row.error ? { error: row.error } : {}),
    files: parseFiles(row.files ?? '[]'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * `FT-YYYYMMDD-NNNN`, short enough to read out and unique across the install.
 *
 * The arithmetic lives in `dailySequence`, shared with payment references,
 * because both are numbers somebody quotes back at you and the numeric-MAX
 * trap in there is not worth falling into twice.
 */
function nextOrderNumber(datePart: string): string {
  return nextDailyReference('orders', 'number', 'FT-', datePart);
}

export type NewOrderItem = {
  seq: number;
  taskId?: string;
  profileId: string;
  profileName: string;
  companyName: string;
  role: string;
  sourceRowNumber?: number;
};

export type NewOrder = {
  userId: string;
  batchId?: string;
  label?: string;
  /** How long the files are kept. The expiry is stamped, not recomputed later. */
  retentionDays: number;
};

/**
 * One order and every resume it asked for, in one transaction.
 *
 * All-or-nothing deliberately: an order whose items were half written would
 * report a total it can never reach, and the progress bar would sit at 98% for
 * ever. The retry covers the one race the UNIQUE index can catch - two
 * submissions in the same millisecond reaching for the same number.
 */
export function createOrder(order: NewOrder, items: NewOrderItem[], at: Date = new Date()): Order {
  const db = getDb();
  const timestamp = at.toISOString();
  const expiresAt = new Date(at.getTime() + order.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const datePart = formatSequenceDate(at);

  const insert = db.transaction((number: string): OrderRow => {
    const id = `ord_${crypto.randomUUID()}`;
    db.prepare(
      `INSERT INTO orders (id, number, user_id, batch_id, label, total, state,
                           created_at, updated_at, expires_at)
       VALUES (@id, @number, @userId, @batchId, @label, @total, 'running',
               @createdAt, @createdAt, @expiresAt)`
    ).run({
      id,
      number,
      userId: order.userId,
      batchId: order.batchId ?? null,
      label: order.label ?? '',
      total: items.length,
      createdAt: timestamp,
      expiresAt,
    });

    const insertItem = db.prepare(
      `INSERT INTO order_items (id, order_id, seq, task_id, profile_id, profile_name,
                                company_name, role, source_row_number, state, files,
                                created_at, updated_at)
       VALUES (@id, @orderId, @seq, @taskId, @profileId, @profileName,
               @companyName, @role, @sourceRowNumber, 'queued', '[]',
               @createdAt, @createdAt)`
    );
    for (const item of items) {
      insertItem.run({
        id: `oit_${crypto.randomUUID()}`,
        orderId: id,
        seq: item.seq,
        taskId: item.taskId ?? null,
        profileId: item.profileId ?? '',
        profileName: item.profileName ?? '',
        companyName: item.companyName ?? '',
        role: item.role ?? '',
        sourceRowNumber: typeof item.sourceRowNumber === 'number' ? item.sourceRowNumber : null,
        createdAt: timestamp,
      });
    }

    return db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`).get(id) as OrderRow;
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return toOrder(insert(nextOrderNumber(datePart)));
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!/UNIQUE constraint failed: orders.number/i.test(message)) throw error;
    }
  }
  throw new Error('Could not allocate an order number.');
}

export function getOrder(id: string): Order | null {
  const row = getDb()
    .prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`)
    .get(id) as OrderRow | undefined;
  return row ? toOrder(row) : null;
}

export function listOrdersForUser(userId: string, limit = 50): Order[] {
  const rows = getDb()
    .prepare(
      `SELECT ${ORDER_COLUMNS} FROM orders
       WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`
    )
    .all(userId, limit) as OrderRow[];
  return rows.map(toOrder);
}

export function listOrderItems(orderId: string): OrderItem[] {
  const rows = getDb()
    .prepare(`SELECT ${ITEM_COLUMNS} FROM order_items WHERE order_id = ? ORDER BY seq ASC`)
    .all(orderId) as OrderItemRow[];
  return rows.map(toItem);
}

export function getOrderItem(orderId: string, itemId: string): OrderItem | null {
  const row = getDb()
    .prepare(`SELECT ${ITEM_COLUMNS} FROM order_items WHERE order_id = ? AND id = ?`)
    .get(orderId, itemId) as OrderItemRow | undefined;
  return row ? toItem(row) : null;
}

const EMPTY_COUNTS: OrderCounts = {
  total: 0,
  queued: 0,
  running: 0,
  done: 0,
  failed: 0,
  cancelled: 0,
  settled: 0,
};

function accumulate(counts: OrderCounts, state: string, amount: number): void {
  if (state === 'queued') counts.queued += amount;
  else if (state === 'running') counts.running += amount;
  else if (state === 'done') counts.done += amount;
  else if (state === 'failed') counts.failed += amount;
  else if (state === 'cancelled') counts.cancelled += amount;
  counts.total += amount;
  if (state !== 'queued' && state !== 'running') counts.settled += amount;
}

/**
 * Progress for several orders in ONE query.
 *
 * The list page shows a bar per order, and the obvious implementation - load
 * the items, count them in JavaScript - is three hundred rows per order times
 * however many orders are on screen, to render a number. A grouped count is one
 * round trip whatever the size of the run.
 */
export function countsForOrders(orderIds: string[]): Map<string, OrderCounts> {
  const counts = new Map<string, OrderCounts>();
  if (orderIds.length === 0) return counts;
  for (const id of orderIds) counts.set(id, { ...EMPTY_COUNTS });

  const placeholders = orderIds.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(
      `SELECT order_id, state, COUNT(*) AS n FROM order_items
       WHERE order_id IN (${placeholders}) GROUP BY order_id, state`
    )
    .all(...orderIds) as Array<{ order_id: string; state: string; n: number }>;

  for (const row of rows) {
    const bucket = counts.get(row.order_id);
    if (bucket) accumulate(bucket, row.state, row.n);
  }
  return counts;
}

/**
 * Which of these orders have at least one file recorded.
 *
 * `done` is not the same question: an item can finish having produced nothing,
 * and a list offering "Download all" for such an order sends somebody to a page
 * of raw JSON. One grouped count answers it for the whole page.
 */
export function ordersWithFiles(orderIds: string[]): Set<string> {
  const withFiles = new Set<string>();
  if (orderIds.length === 0) return withFiles;

  const placeholders = orderIds.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT order_id FROM order_items
       WHERE order_id IN (${placeholders}) AND files != '[]'`
    )
    .all(...orderIds) as Array<{ order_id: string }>;

  for (const row of rows) withFiles.add(row.order_id);
  return withFiles;
}

export function countsForOrder(orderId: string): OrderCounts {
  return countsForOrders([orderId]).get(orderId) ?? { ...EMPTY_COUNTS };
}

export type ItemOutcome = {
  state: OrderItemState;
  taskId?: string;
  error?: string;
  files?: OrderFile[];
};

/**
 * Records what became of one resume, found by the batch and position.
 *
 * `(batchId, seq)` rather than a task id, because the task id is the one thing
 * that does NOT survive a restart: `restore` requeues the work as new tasks
 * with new ids, and an order keyed on them would stop collecting results
 * exactly when a run needed picking back up.
 *
 * Returns the order id so the caller can settle it without a second lookup, or
 * null when nothing matched - which is the normal answer for every batch that
 * was not placed as an order.
 */
export function recordItemOutcome(batchId: string, seq: number, outcome: ItemOutcome): string | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT i.id AS id, i.order_id AS orderId
       FROM order_items i JOIN orders o ON o.id = i.order_id
       WHERE o.batch_id = ? AND i.seq = ?`
    )
    .get(batchId, seq) as { id: string; orderId: string } | undefined;
  if (!row) return null;

  db.prepare(
    `UPDATE order_items
     SET state = @state, error = @error, files = @files,
         task_id = COALESCE(@taskId, task_id), updated_at = @updatedAt
     WHERE id = @id`
  ).run({
    id: row.id,
    state: outcome.state,
    error: outcome.error ?? null,
    files: JSON.stringify(outcome.files ?? []),
    taskId: outcome.taskId ?? null,
    updatedAt: now(),
  });

  return row.orderId;
}

export function markItemRunning(batchId: string, seq: number): void {
  getDb()
    .prepare(
      `UPDATE order_items SET state = 'running', updated_at = @updatedAt
       WHERE state = 'queued' AND id IN (
         SELECT i.id FROM order_items i JOIN orders o ON o.id = i.order_id
         WHERE o.batch_id = @batchId AND i.seq = @seq
       )`
    )
    .run({ batchId, seq, updatedAt: now() });
}

/**
 * Closes an order once nothing on it can move again.
 *
 * A partially successful order is `done`, not `failed`: three hundred resumes
 * where two failed still delivered two hundred and ninety-eight files, and
 * calling that a failure would hide them behind an error state. `failed` is
 * reserved for an order that produced nothing at all.
 */
export function settleOrderIfFinished(orderId: string): Order | null {
  const order = getOrder(orderId);
  if (!order || order.state !== 'running') return order;

  const counts = countsForOrder(orderId);
  if (counts.total === 0 || counts.queued > 0 || counts.running > 0) return order;

  const state: OrderState = counts.done > 0 ? 'done' : counts.cancelled > 0 ? 'cancelled' : 'failed';
  const timestamp = now();
  getDb()
    .prepare(`UPDATE orders SET state = @state, finished_at = @at, updated_at = @at WHERE id = @id`)
    .run({ id: orderId, state, at: timestamp });

  return getOrder(orderId);
}

/**
 * Closes an order that never reached the queue.
 *
 * Only for a submission that threw between creating the order and dispatching
 * it. Without this the row sits at `running` with three hundred queued items
 * and no batch to move them, and the progress bar never leaves zero.
 */
export function failOrder(orderId: string, message: string): void {
  const db = getDb();
  const timestamp = now();
  db.transaction(() => {
    db.prepare(
      `UPDATE order_items SET state = 'failed', error = @error, updated_at = @at
       WHERE order_id = @id AND state IN ('queued', 'running')`
    ).run({ id: orderId, error: message, at: timestamp });
    db.prepare(
      `UPDATE orders SET state = 'failed', finished_at = @at, updated_at = @at WHERE id = @id`
    ).run({ id: orderId, at: timestamp });
  })();
}

/**
 * Everything whose keep-until has passed, whose files are still on disk, and
 * whose work has FINISHED.
 *
 * The state filter is not tidiness. `ORDER_RETENTION_DAYS=0` is legal and makes
 * an order expire the moment it is placed; the sweep also runs at boot, beside
 * the queue restore. Without this, a three-hundred-resume run would have its
 * files unlinked while its tasks were still writing them - and worse, every
 * task that finished afterwards would write a fresh `files` array with no
 * `removedAt`, so the order would show working download links under a "Files
 * deleted" banner while `purged_at` kept the sweep from ever looking at it
 * again. Those files would then be leaked on disk for ever, which is the exact
 * accumulation this feature exists to stop.
 *
 * A still-running order simply waits: it is collected by the next sweep after
 * it settles.
 */
export function listExpiredOrders(nowIso: string = now(), limit = 200): Order[] {
  const rows = getDb()
    .prepare(
      `SELECT ${ORDER_COLUMNS} FROM orders
       WHERE purged_at IS NULL AND expires_at <= ? AND state != 'running'
       ORDER BY expires_at ASC LIMIT ?`
    )
    .all(nowIso, limit) as OrderRow[];
  return rows.map(toOrder);
}

/**
 * Who, if anyone, owns a generated file by path.
 *
 * The question the older download routes have to ask now. `/api/generated` and
 * `/api/resume/download` take a path and check only that the caller is signed
 * in - defensible while a path was an opaque thing you had to be told, and not
 * once ordered files are filed under a FIXED, published template whose segments
 * are an email, a date, an order number and a company. That makes them
 * derivable rather than guessable, and a derivable path behind a
 * signed-in-only check is a directory of everybody's resumes.
 *
 * Matched with LIKE against the stored JSON rather than by parsing it: the
 * column holds an array, the path appears in it verbatim as `"path":"<value>"`,
 * and SQLite has no JSON index here worth building for a lookup that happens
 * once per download. The candidate rows are then confirmed properly, so a
 * substring that merely looks similar cannot pass.
 *
 * Returns null when no order claims the path, which is the right answer for
 * every manually built resume - those are left exactly as they were.
 */
export function ownerOfGeneratedFile(relativePath: string): string | null {
  const wanted = relativePath.replace(/\\/g, '/').trim();
  if (!wanted) return null;

  const rows = getDb()
    .prepare(
      `SELECT o.user_id AS userId, i.files AS files
       FROM order_items i JOIN orders o ON o.id = i.order_id
       WHERE i.files LIKE @needle`
    )
    .all({ needle: `%${JSON.stringify(wanted).slice(1, -1)}%` }) as Array<{
    userId: string;
    files: string;
  }>;

  for (const row of rows) {
    if (parseFiles(row.files).some((file) => file.path === wanted)) return row.userId;
  }
  return null;
}

export function recordItemFiles(itemId: string, files: OrderFile[]): void {
  getDb()
    .prepare(`UPDATE order_items SET files = @files, updated_at = @updatedAt WHERE id = @id`)
    .run({ id: itemId, files: JSON.stringify(files), updatedAt: now() });
}

/**
 * The order kept its history and lost its files.
 *
 * `expired` rather than deleting the row: somebody who ordered three hundred
 * resumes and comes back on the sixth day should be told the files are gone,
 * not shown an empty list that looks like the order never happened.
 */
export function markOrderPurged(orderId: string): void {
  const timestamp = now();
  getDb()
    .prepare(
      `UPDATE orders SET state = 'expired', purged_at = @at, updated_at = @at WHERE id = @id`
    )
    .run({ id: orderId, at: timestamp });
}

/** Used by the retention tests, and by nothing else. */
export function setOrderExpiryForTests(orderId: string, expiresAt: string): void {
  getDb().prepare(`UPDATE orders SET expires_at = ? WHERE id = ?`).run(expiresAt, orderId);
}
