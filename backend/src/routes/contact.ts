import { Router, type Request, type Response } from 'express';

import { requireAdmin } from '../middleware/auth';
import { sendPublicError } from '../middleware/publicError';
import {
  CONTACT_CHANNEL_TYPES,
  MAX_CONTACT_CHANNELS,
  MAX_CONTACT_LABEL,
  MAX_CONTACT_VALUE,
  readContactChannels,
  saveContactSettings,
} from '../services/contact';

/**
 * How to reach the administrator.
 *
 * `GET /api/contact` is PUBLIC - no session - because the people who most
 * need it are the ones who cannot sign in: the sign-in page, the
 * account-disabled page (owner decision A2: everybody sees it). It answers
 * `{ channels: [{ type, label, value, href }] }` and nothing else: no ids, no
 * timestamps, nothing about who saved it. Every `href` is built by the server
 * (services/contact.ts); a page renders it or the plain `value`, and never
 * makes a link of its own.
 *
 * The administrators' half reads and replaces the list, mounted apart at
 * /api/admin/contact with its own `requireAdmin`.
 */

const router = Router();

router.get('/', (req: Request, res: Response) => {
  try {
    // Fresh on every read: an administrator who just fixed an address should
    // not have it sit behind a cache on the sign-in page.
    res.setHeader('Cache-Control', 'no-store');
    res.json({ channels: readContactChannels() });
  } catch (error) {
    sendPublicError(req, res, error, 'Could not read the contact details');
  }
});

export default router;

export const adminContactRouter = Router();
adminContactRouter.use(requireAdmin);

/** What the editor needs to draw itself: the channels and the rules it is held to. */
function editorPayload() {
  const channels = readContactChannels();
  return {
    channels,
    types: CONTACT_CHANNEL_TYPES,
    limits: { channels: MAX_CONTACT_CHANNELS, label: MAX_CONTACT_LABEL, value: MAX_CONTACT_VALUE },
  };
}

adminContactRouter.get('/', (req: Request, res: Response) => {
  try {
    res.json(editorPayload());
  } catch (error) {
    sendPublicError(req, res, error, 'Could not read the contact details');
  }
});

/**
 * Replaces the whole list: `{ channels: [{ type, label, value }] }`. Refused as
 * a whole when any channel fails, with every failure pinned to its place:
 * 400 `{ error, code: 'contact-invalid', fieldErrors: [{ index, field, message }] }`.
 */
adminContactRouter.put('/', (req: Request, res: Response) => {
  try {
    const saved = saveContactSettings(req.body);
    if (!saved.ok) {
      res.status(400).json({
        error: 'Some contact details need fixing.',
        code: 'contact-invalid',
        fieldErrors: saved.errors,
      });
      return;
    }
    res.json(editorPayload());
  } catch (error) {
    sendPublicError(req, res, error, 'Could not save the contact details');
  }
});
