import { Router, Request, Response } from 'express';

import {
  countCreatedAfter,
  createNotification,
  deleteNotification,
  getSeenAt,
  listNotifications,
  markSeen,
  updateNotification,
} from '../database/notificationRepository';
import { requireAdmin, requireUser } from '../middleware/auth';

/**
 * The notice board: one router for reading it, one for writing it.
 *
 * Two routers rather than per-route guards, because the split is clean - every
 * read is open to anybody signed in, every write is administrator-only - and a
 * `router.use` means a route added later is protected by default rather than
 * protected only if somebody remembers.
 *
 * Note the admin router carries its own `requireAdmin` and does not rely on
 * being mounted under /api/admin. That path prefix grants nothing in this app:
 * /api/admin/ai is mounted there with only `requireUser`.
 */

const MAX_TITLE = 200;
const MAX_BODY = 4000;

type Payload = { title?: string; body?: string };

/**
 * Hand-rolled, like every other validator here.
 *
 * Returns either the cleaned values or the sentence to send back, so the caller
 * has one thing to check and cannot use a half-validated payload by accident.
 */
function normalizePayload(
  input: unknown,
  { partial }: { partial: boolean }
): { error: string } | { title?: string; body?: string } {
  const raw = (input ?? {}) as Payload;

  const hasTitle = raw.title !== undefined;
  const hasBody = raw.body !== undefined;

  if (partial && !hasTitle && !hasBody) {
    return { error: 'Send a title or a body to change.' };
  }

  const result: { title?: string; body?: string } = {};

  if (hasTitle || !partial) {
    const title = String(raw.title ?? '').trim();
    if (!title) return { error: 'A notification needs a title.' };
    if (title.length > MAX_TITLE) {
      return { error: `Keep the title under ${MAX_TITLE} characters.` };
    }
    result.title = title;
  }

  if (hasBody || !partial) {
    const body = String(raw.body ?? '').trim();
    if (body.length > MAX_BODY) {
      return { error: `Keep the body under ${MAX_BODY} characters.` };
    }
    result.body = body;
  }

  return result;
}

/* ------------------------------------------------------------- reading it */

const router = Router();

router.use(requireUser);

router.get('/', (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const seenAt = getSeenAt(req.user!.id);
    res.json({
      notifications: listNotifications(limit),
      unreadCount: countCreatedAfter(seenAt),
      seenAt,
    });
  } catch (error) {
    console.error('Error reading notifications:', error);
    res.status(500).json({ error: 'Could not read notifications.' });
  }
});

router.post('/seen', (req: Request, res: Response) => {
  try {
    res.json({ seenAt: markSeen(req.user!.id) });
  } catch (error) {
    console.error('Error marking notifications seen:', error);
    res.status(500).json({ error: 'Could not record that.' });
  }
});

/* ------------------------------------------------------------- writing it */

export const adminNotificationsRouter = Router();

adminNotificationsRouter.use(requireAdmin);

adminNotificationsRouter.get('/', (_req: Request, res: Response) => {
  res.json({ notifications: listNotifications(100) });
});

adminNotificationsRouter.post('/', (req: Request, res: Response) => {
  const normalized = normalizePayload(req.body, { partial: false });
  if ('error' in normalized) {
    res.status(400).json({ error: normalized.error });
    return;
  }

  try {
    const created = createNotification({
      title: normalized.title!,
      body: normalized.body,
      authorId: req.user!.id,
      authorName: req.user!.name || req.user!.email,
    });
    res.status(201).json(created);
  } catch (error) {
    console.error('Error posting a notification:', error);
    res.status(500).json({ error: 'Could not post that.' });
  }
});

adminNotificationsRouter.patch('/:id', (req: Request<{ id: string }>, res: Response) => {
  const normalized = normalizePayload(req.body, { partial: true });
  if ('error' in normalized) {
    res.status(400).json({ error: normalized.error });
    return;
  }

  try {
    const updated = updateNotification(req.params.id, normalized);
    if (!updated) {
      res.status(404).json({ error: 'No such notification.' });
      return;
    }
    res.json(updated);
  } catch (error) {
    console.error('Error editing a notification:', error);
    res.status(500).json({ error: 'Could not save that.' });
  }
});

adminNotificationsRouter.delete('/:id', (req: Request<{ id: string }>, res: Response) => {
  try {
    if (!deleteNotification(req.params.id)) {
      res.status(404).json({ error: 'No such notification.' });
      return;
    }
    res.json({ deleted: true });
  } catch (error) {
    console.error('Error deleting a notification:', error);
    res.status(500).json({ error: 'Could not delete that.' });
  }
});

export default router;
