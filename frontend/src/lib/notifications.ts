import { apiFetch } from './api';

/**
 * Notifications: what an administrator posted for everybody, what the app
 * wrote for this account alone (a refund request decided - or, for an
 * administrator, a new one to decide), and whether this account has caught up.
 *
 * A feed holds the announcements and the reader's OWN notices, never anybody
 * else's - the server decides that, list and unread count alike.
 *
 * "Unread" is one timestamp per account rather than a read receipt per post:
 * the only question worth answering is "is there anything since I last
 * looked", and the cheap answer survives a new device, which a browser-local
 * one would not.
 */

export type Notification = {
  id: string;
  title: string;
  body: string;
  /** The administrator who posted it, for the admin list. Empty on one the app wrote. */
  authorId: string;
  authorName: string;
  /** Null for an announcement to everybody; this account's id for a notice to it alone. */
  recipientId: string | null;
  /**
   * The app page it is about - `/credits?tab=refunds` - or null. An app path
   * only, and checked again before it becomes a link (lib/appLinks.ts).
   */
  link: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NotificationFeed = {
  notifications: Notification[];
  /** Announcements and this account's own notices created since it last opened the panel. */
  unreadCount: number;
  /** Null when they have never opened it. */
  seenAt: string | null;
};

export const notificationsApi = {
  feed: (limit?: number) =>
    apiFetch<NotificationFeed>(`/notifications${limit ? `?limit=${limit}` : ''}`),

  /** Records that this account has now seen everything posted so far. */
  markSeen: () => apiFetch<{ seenAt: string }>('/notifications/seen', { method: 'POST' }),
};

export const adminNotificationsApi = {
  list: () => apiFetch<{ notifications: Notification[] }>('/admin/notifications'),

  create: (input: { title: string; body: string }) =>
    apiFetch<Notification>('/admin/notifications', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  update: (id: string, patch: { title?: string; body?: string }) =>
    apiFetch<Notification>(`/admin/notifications/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  remove: (id: string) =>
    apiFetch<{ deleted: true }>(`/admin/notifications/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
};

/**
 * "3 minutes ago", "yesterday", or a date once it stops being news.
 *
 * Relative only while it is useful. A post from March is better read as March
 * than as "184 days ago", which nobody converts in their head.
 */
export function describePostedAt(iso: string, now: Date): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';

  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;

  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
