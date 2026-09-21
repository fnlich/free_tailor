'use client';

import { useCallback, useEffect, useState } from 'react';

import { AdminOnly } from '@/components/auth/AuthGate';
import {
  adminNotificationsApi,
  describePostedAt,
  type Notification,
} from '@/lib/notifications';

/**
 * Posting to the notice board.
 *
 * Everything here is shared by the whole installation - a notice posted goes to
 * every account on it - which is why this page is administrator-only while
 * reading the same notices is open to everybody.
 */

const CARD =
  'rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900';
const LABEL = 'text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-slate-400';
const INPUT =
  'mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 ' +
  'focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';
const BUTTON =
  'rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 ' +
  'disabled:cursor-not-allowed disabled:bg-gray-400';

function NotificationsAdminBody() {
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');

  const load = useCallback(async () => {
    try {
      const { notifications } = await adminNotificationsApi.list();
      setItems(notifications);
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load notifications.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const post = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await adminNotificationsApi.create({ title, body });
      setTitle('');
      setBody('');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not post that.');
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async (id: string) => {
    setSaving(true);
    try {
      await adminNotificationsApi.update(id, { title: editTitle, body: editBody });
      setEditingId(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save that.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item: Notification) => {
    // Posted to everybody, so it has been seen by everybody - worth one
    // question before it disappears from their panels.
    if (!window.confirm(`Delete "${item.title}"? Everybody loses it from their notifications.`)) {
      return;
    }
    try {
      await adminNotificationsApi.remove(item.id);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete that.');
    }
  };

  const now = new Date();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Notifications</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
          Everything posted here appears in the bell in every account&apos;s top bar, with an unread
          dot until they open it. Editing a notice corrects the text without marking it unread
          again.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <form className={CARD} onSubmit={post}>
        <h2 className="text-lg font-semibold text-gray-900">Post a notification</h2>

        <label className="mt-4 block">
          <span className={LABEL}>Title</span>
          <input
            className={INPUT}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            placeholder="Scheduled maintenance on Sunday"
            required
          />
        </label>

        <label className="mt-4 block">
          <span className={LABEL}>Body</span>
          <textarea
            className={INPUT}
            rows={4}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={4000}
            placeholder="Generation will be unavailable between 9am and 11am UTC."
          />
        </label>

        <div className="mt-4 flex justify-end">
          <button type="submit" className={BUTTON} disabled={saving || !title.trim()}>
            {saving ? 'Posting...' : 'Post notification'}
          </button>
        </div>
      </form>

      <section className={CARD}>
        <h2 className="text-lg font-semibold text-gray-900">Posted</h2>

        {loading ? (
          <p className="mt-4 text-sm text-gray-500">Loading...</p>
        ) : items.length === 0 ? (
          <p className="mt-4 text-sm text-gray-500">
            Nothing posted yet. Notices appear here newest first.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-gray-200">
            {items.map((item) => (
              <li key={item.id} className="py-4 first:pt-0 last:pb-0">
                {editingId === item.id ? (
                  <div className="space-y-3">
                    <input
                      className={INPUT}
                      value={editTitle}
                      onChange={(event) => setEditTitle(event.target.value)}
                      maxLength={200}
                    />
                    <textarea
                      className={INPUT}
                      rows={3}
                      value={editBody}
                      onChange={(event) => setEditBody(event.target.value)}
                      maxLength={4000}
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className={BUTTON}
                        disabled={saving || !editTitle.trim()}
                        onClick={() => void saveEdit(item.id)}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900">{item.title}</p>
                      {item.body && (
                        <p className="mt-1 whitespace-pre-wrap text-sm text-gray-600">{item.body}</p>
                      )}
                      <p className="mt-2 text-xs text-gray-500">
                        {describePostedAt(item.createdAt, now)}
                        {item.authorName ? ` · ${item.authorName}` : ''}
                      </p>
                    </div>

                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                        onClick={() => {
                          setEditingId(item.id);
                          setEditTitle(item.title);
                          setEditBody(item.body);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
                        onClick={() => void remove(item)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default function NotificationsAdminPage() {
  return (
    <AdminOnly>
      <NotificationsAdminBody />
    </AdminOnly>
  );
}
