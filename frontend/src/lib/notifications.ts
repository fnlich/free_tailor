import { apiFetch } from './api';

/**
 * Notifications: what an administrator posted, and whether this account has
 * caught up.
 *
 * "Unread" is one timestamp per account rather than a read receipt per post.
 * A post here is an announcement to everybody, so the only question worth
 * answering is "is there anything since I last looked" - and the cheap answer
 * survives a new device, which a browser-local one would not.
 */

export type Notification = {
  id: string;
  title: string;
  body: string;
  /** The administrator who posted it, for the admin list. May be empty. */
  authorId: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
};

export type NotificationFeed = {
  notifications: Notification[];
  /** Posts created since this account last opened the panel. */
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
