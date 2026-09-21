'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { IconBell } from '@/components/icons';
import { useDismissable } from '@/lib/useDismissable';
import {
  describePostedAt,
  notificationsApi,
  type Notification,
} from '@/lib/notifications';

/**
 * What the administrators of this installation have posted.
 *
 * The dot is the point of it: somebody who has read everything should be able
 * to tell at a glance, without opening anything. Opening the panel is what
 * marks them caught up, so the dot clears on the action that actually means
 * "I have seen these" rather than on a page load that happened to include it.
 */

/** Slow enough not to matter, often enough that a post arrives the same session. */
const POLL_MS = 60_000;

export default function NotificationsMenu() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const feed = await notificationsApi.feed(20);
      setItems(feed.notifications);
      setUnread(feed.unreadCount);
      setFailed(false);
    } catch {
      // A bell that cannot reach the server is not worth an error banner over
      // whatever the person is actually doing. It goes quiet instead, and says
      // so only if they open it.
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      await load();
      if (!alive) return;
    };

    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [load]);

  useDismissable(open, () => setOpen(false), containerRef);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next) return;

    // Clear the dot straight away rather than waiting for the round trip: the
    // person is looking at the posts right now, and a dot that lingers over
    // them reads as a bug.
    if (unread > 0) {
      setUnread(0);
      try {
        await notificationsApi.markSeen();
      } catch {
        // Failed to record it, so they will simply be told again next time -
        // the harmless direction to fail in.
      }
    }

    // Refreshed AFTER marking seen, not alongside it. Both of these write the
    // unread count, and run concurrently the read can be computed before the
    // write commits - which puts the dot straight back on a panel the person
    // is already reading.
    await load();
  };

  const now = new Date();

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={unread > 0 ? `Notifications, ${unread} new` : 'Notifications'}
        title="Notifications"
        className="tl-icon-button relative"
      >
        <IconBell className="h-5 w-5" />
        {unread > 0 && (
          <span
            aria-hidden
            className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-[var(--topbar)]"
          />
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="tl-panel app-top-nav-menu absolute right-0 top-full mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden"
        >
          <div className="border-b-[1px] border-[color:var(--border-color)] px-4 py-3">
            <p className="text-sm font-semibold text-ink">Notifications</p>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {failed ? (
              <p className="px-4 py-6 text-sm text-subtle">Could not reach the server.</p>
            ) : items.length === 0 ? (
              <p className="px-4 py-6 text-sm text-subtle">
                Nothing yet. Announcements from the administrators of this installation appear here.
              </p>
            ) : (
              items.map((item) => (
                <article
                  key={item.id}
                  className="border-b-[1px] border-[color:var(--border-color)] px-4 py-3 last:border-b-0"
                >
                  <p className="text-sm font-semibold text-ink">{item.title}</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{item.body}</p>
                  <p className="mt-2 text-xs text-subtle">
                    {describePostedAt(item.createdAt, now)}
                    {item.authorName ? ` · ${item.authorName}` : ''}
                  </p>
                </article>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
