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
 *
 * Two kinds of row share the table. An ANNOUNCEMENT (recipient_id NULL) is what
 * an administrator posts, read by every account - every row from before the
 * column existed is one. A NOTICE FOR ONE ACCOUNT (recipient_id set) is what
 * the app writes: a refund request decided, or a new one for each
 * administrator. A reader's feed is `recipient_id IS NULL OR recipient_id =
 * the reader`, in every query here that answers a reader - the list AND the
 * unread count, which would otherwise light the dot for somebody else's notice.
 * The administrators' announcement editor sees and changes announcements only.
 */

type NotificationRow = {
  id: string;
  title: string;
  body: string;
  author_id: string;
  author_name: string;
  recipient_id: string | null;
  link: string | null;
  created_at: string;
  updated_at: string;
};

const NOTIFICATION_COLUMNS =
  'id, title, body, author_id, author_name, recipient_id, link, created_at, updated_at';

/** The SQL that says "for this reader": the announcements, and their own. */
const FOR_READER = '(recipient_id IS NULL OR recipient_id = @reader)';

function now(): string {
  return new Date().toISOString();
}

/**
 * An app path, or nothing.
 *
 * A notice's link is rendered as a link in every account's panel, so it is held
 * to one shape: a path on this app, starting with exactly one `/`. A full
 * address, a protocol-relative `//host` or a `javascript:` is dropped rather
 * than stored - nothing the app writes needs one, and the column is the last
 * place to stop one reaching a page.
 */
export function safeAppPath(value: unknown): string {
  if (typeof value !== 'string') return '';
  const path = value.trim();
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return '';
  if (path.length > 300 || /[\s\u0000-\u001f\u007f]/.test(path)) return '';
  return path;
}

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    authorId: row.author_id,
    authorName: row.author_name,
    recipientId: row.recipient_id ?? null,
    link: row.link ? safeAppPath(row.link) || null : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * One reader's feed - the announcements and their own notices - newest first,
 * tie-broken on rowid.
 *
 * created_at is an ISO string at millisecond resolution, so two notices posted
 * in the same tick would otherwise come back in an order SQLite is free to
 * change between calls - and a list that reorders itself on refresh reads as a
 * bug even when the contents are identical.
 */
export function listNotificationsFor(readerId: string, limit = 50): Notification[] {
  const rows = getDb()
    .prepare(
      `SELECT ${NOTIFICATION_COLUMNS} FROM notifications
       WHERE ${FOR_READER}
       ORDER BY created_at DESC, rowid DESC
       LIMIT @limit`
    )
    .all({ reader: readerId, limit }) as NotificationRow[];
  return rows.map(toNotification);
}

/** The announcements only, for the administrators' editor. Notices for one account are not theirs to edit. */
export function listAnnouncements(limit = 50): Notification[] {
  const rows = getDb()
    .prepare(
      `SELECT ${NOTIFICATION_COLUMNS} FROM notifications
       WHERE recipient_id IS NULL
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

/**
 * Writes one notice. Synchronous and on the shared connection, so a caller
 * inside a transaction - a refund request changing state - writes its notice
 * in the same transaction as the change it describes.
 */
export function createNotification(input: CreateNotificationDTO): Notification {
  const timestamp = now();
  const row: NotificationRow = {
    id: `not_${randomUUID()}`,
    title: input.title,
    body: input.body ?? '',
    author_id: input.authorId ?? '',
    author_name: input.authorName ?? '',
    recipient_id: input.recipientId?.trim() ? input.recipientId.trim() : null,
    link: safeAppPath(input.link),
    created_at: timestamp,
    updated_at: timestamp,
  };

  getDb()
    .prepare(
      `INSERT INTO notifications (${NOTIFICATION_COLUMNS})
       VALUES (@id, @title, @body, @author_id, @author_name, @recipient_id, @link, @created_at, @updated_at)`
    )
    .run(row);

  return toNotification(row);
}

/**
 * Edits an announcement's text, and nothing else.
 *
 * created_at is deliberately untouched, so correcting a typo does not shove a
 * week-old notice back to the top of everybody's panel and light the dot again.
 * A notice for one account is not an announcement and is not found here: what
 * the app told somebody about their refund is not an administrator's to reword.
 */
export function updateNotification(
  id: string,
  patch: { title?: string; body?: string }
): Notification | null {
  const existing = getNotification(id);
  if (!existing || existing.recipientId !== null) return null;

  const next = {
    id,
    title: patch.title ?? existing.title,
    body: patch.body ?? existing.body,
    updated_at: now(),
  };

  getDb()
    .prepare(
      `UPDATE notifications SET title = @title, body = @body, updated_at = @updated_at
       WHERE id = @id AND recipient_id IS NULL`
    )
    .run(next);

  return getNotification(id);
}

/** Deletes an announcement. A notice for one account is not found here, for the reason above. */
export function deleteNotification(id: string): boolean {
  const result = getDb().prepare('DELETE FROM notifications WHERE id = ? AND recipient_id IS NULL').run(id);
  return result.changes > 0;
}

/** Every notice written for one account - when that account is deleted, nobody else can read them. */
export function deleteNotificationsFor(recipientId: string): number {
  return getDb().prepare('DELETE FROM notifications WHERE recipient_id = ?').run(recipientId).changes;
}

/**
 * How many notices this reader has not seen: the announcements and their own.
 *
 * `seenAt` null means they have never opened the panel, which counts everything
 * - the honest reading, and the one that shows a new account what an
 * administrator posted before they arrived.
 */
export function countUnreadFor(readerId: string, seenAt: string | null): number {
  const db = getDb();
  if (!seenAt) {
    const all = db
      .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE ${FOR_READER}`)
      .get({ reader: readerId }) as { n: number };
    return all.n;
  }

  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE ${FOR_READER} AND created_at > @seenAt`)
    .get({ reader: readerId, seenAt }) as { n: number };
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
