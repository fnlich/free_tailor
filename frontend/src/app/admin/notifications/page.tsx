'use client';

import { useCallback, useEffect, useState } from 'react';

import { AdminOnly } from '@/components/auth/AuthGate';
import {
  adminNotificationsApi,
  describePostedAt,
  type Notification,
} from '@/lib/notifications';
import { Field, Notice, Section } from '@/components/ui/kit';

/**
 * Posting to the notice board.
 *
 * Everything here is shared by the whole installation - a notice posted goes to
 * every account on it - which is why this page is administrator-only while
 * reading the same notices is open to everybody.
 */

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
    <div>
      <header>
        <h2 className="text-2xl font-bold tracking-tight text-ink">Notifications</h2>
        <p className="mt-1 text-sm text-muted">
          Everything posted here appears in the bell in every account&apos;s top bar, with an unread
          dot until they open it. Editing a notice corrects the text without marking it unread
          again.
        </p>
      </header>

      {error && (
        <Notice tone="error" role="alert" className="mt-6">
          {error}
        </Notice>
      )}

      <Section title="Post a notification">
        <form onSubmit={post} className="space-y-6">
          <Field label="Title" htmlFor="notice-title">
            <input
              id="notice-title"
              className="tl-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              placeholder="Scheduled maintenance on Sunday"
              required
            />
          </Field>

          <Field label="Body" htmlFor="notice-body">
            <textarea
              id="notice-body"
              className="tl-input"
              rows={4}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={4000}
              placeholder="Generation will be unavailable between 9am and 11am UTC."
            />
          </Field>

          <button type="submit" className="tl-button" disabled={saving || !title.trim()}>
            {saving ? 'Posting...' : 'Post notification'}
          </button>
        </form>
      </Section>

      <Section title="Posted">
        {loading ? (
          <p className="text-sm text-subtle">Loading...</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing posted yet. Notices appear here newest first.
          </p>
        ) : (
          <ul className="tl-rows">
            {items.map((item) => (
              <li key={item.id}>
                {editingId === item.id ? (
                  <div className="space-y-3">
                    <input
                      className="tl-input"
                      aria-label="Title"
                      value={editTitle}
                      onChange={(event) => setEditTitle(event.target.value)}
                      maxLength={200}
                    />
                    <textarea
                      className="tl-input"
                      aria-label="Body"
                      rows={3}
                      value={editBody}
                      onChange={(event) => setEditBody(event.target.value)}
                      maxLength={4000}
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="tl-button"
                        disabled={saving || !editTitle.trim()}
                        onClick={() => void saveEdit(item.id)}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="tl-button-quiet"
                        // Level with Save beside it; inline, because
                        // .tl-button-quiet is unlayered and outranks a utility.
                        style={{ minHeight: '2.5rem' }}
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm font-semibold text-ink">{item.title}</p>
                      {item.body && (
                        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted">{item.body}</p>
                      )}
                      <p className="mt-2 text-xs text-subtle">
                        {describePostedAt(item.createdAt, now)}
                        {item.authorName ? ` · ${item.authorName}` : ''}
                      </p>
                    </div>

                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        className="tl-button-quiet"
                        data-size="sm"
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
                        className="tl-button-quiet"
                        data-size="sm"
                        data-tone="danger"
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
      </Section>
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
