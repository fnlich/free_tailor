import { randomUUID } from 'crypto';

import { getDb } from './sqlite';
import type { CreateNotificationDTO, Notification } from '../types/notification';

/**
 * Reading and writing the notice board.
 *
 * Columnar rather than the JSON-document style used for profiles and prompts,
 * because the one question asked on every page load - "how many are newer than
 * this timestamp" - is a query, and a document table would have to parse every
 * row to answer it.
 */

type NotificationRow = {
  id: string;
  title: string;
  body: string;
  author_id: string;
  author_name: string;
  created_at: string;
  updated_at: string;
};

const NOTIFICATION_COLUMNS =
  'id, title, body, author_id, author_name, created_at, updated_at';

function now(): string {
  return new Date().toISOString();
}

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    authorId: row.author_id,
    authorName: row.author_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Newest first, and tie-broken on rowid.
 *
 * created_at is an ISO string at millisecond resolution, so two notices posted
 * in the same tick would otherwise come back in an order SQLite is free to
 * change between calls - and a list that reorders itself on refresh reads as a
 * bug even when the contents are identical.
 */
export function listNotifications(limit = 50): Notification[] {
  const rows = getDb()
    .prepare(
      `SELECT ${NOTIFICATION_COLUMNS} FROM notifications
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`
    )
    .all(limit) as NotificationRow[];
  return rows.map(toNotification);
}

export function getNotification(id: string): Notification | null {
  const row = getDb()
    .prepare(`SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE id = ?`)
    .get(id) as NotificationRow | undefined;
  return row ? toNotification(row) : null;
}

export function createNotification(input: CreateNotificationDTO): Notification {
  const timestamp = now();
  const row: NotificationRow = {
    id: `not_${randomUUID()}`,
    title: input.title,
    body: input.body ?? '',
    author_id: input.authorId ?? '',
    author_name: input.authorName ?? '',
    created_at: timestamp,
    updated_at: timestamp,
  };

  getDb()
    .prepare(
      `INSERT INTO notifications (${NOTIFICATION_COLUMNS})
       VALUES (@id, @title, @body, @author_id, @author_name, @created_at, @updated_at)`
    )
    .run(row);

  return toNotification(row);
}

/**
 * Edits the text, and nothing else.
 *
 * created_at is deliberately untouched, so correcting a typo does not shove a
 * week-old notice back to the top of everybody's panel and light the dot again.
 */
export function updateNotification(
  id: string,
  patch: { title?: string; body?: string }
): Notification | null {
  const existing = getNotification(id);
  if (!existing) return null;

  const next = {
    id,
    title: patch.title ?? existing.title,
    body: patch.body ?? existing.body,
    updated_at: now(),
  };

  getDb()
    .prepare(
      `UPDATE notifications SET title = @title, body = @body, updated_at = @updated_at
       WHERE id = @id`
    )
    .run(next);

  return getNotification(id);
}

export function deleteNotification(id: string): boolean {
  const result = getDb().prepare('DELETE FROM notifications WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * How many notices this account has not seen.
 *
 * `seenAt` null means they have never opened the panel, which counts everything
 * - the honest reading, and the one that shows a new account what an
 * administrator posted before they arrived.
 */
export function countCreatedAfter(seenAt: string | null): number {
  const db = getDb();
  if (!seenAt) {
    const all = db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number };
    return all.n;
  }

  const row = db
    .prepare('SELECT COUNT(*) AS n FROM notifications WHERE created_at > ?')
    .get(seenAt) as { n: number };
  return row.n;
}

export function getSeenAt(userId: string): string | null {
  const row = getDb()
    .prepare('SELECT notifications_seen_at FROM users WHERE id = ?')
    .get(userId) as { notifications_seen_at: string | null } | undefined;
  return row?.notifications_seen_at ?? null;
}

/**
 * Records that this account has now seen everything posted so far.
 *
 * Stamped with the server's clock rather than the newest notice's timestamp, so
 * a notice written between the read and this write is still counted as unread
 * rather than being marked seen by somebody who never had it on screen.
 */
export function markSeen(userId: string): string {
  const at = now();
  getDb()
    .prepare('UPDATE users SET notifications_seen_at = ? WHERE id = ?')
    .run(at, userId);
  return at;
}
