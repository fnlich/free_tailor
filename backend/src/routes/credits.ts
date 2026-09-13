import { Router, type Request, type Response } from 'express';

import { requireUser } from '../middleware/auth';
import { getLedger, getStatus, CREDITS_PER_RESUME } from '../services/credits';

/**
 * An account's own balance and the rows behind it.
 *
 * Its own router rather than more fields on /auth/me, because the ledger is a
 * list that grows without bound and /auth/me is fetched on every page load by
 * every page. The balance itself does ride along on the account; this is for
 * the panel that explains it.
 */

const router = Router();
router.use(requireUser);

router.get('/', (req: Request, res: Response) => {
  res.json({
    ...getStatus(req.user!),
    perResume: CREDITS_PER_RESUME,
  });
});

/**
 * The movements, newest first.
 *
 * Only ever the requester's own. There is no id in the path on purpose - an
 * admin reading somebody else's goes through /api/admin/accounts/:id/credits,
 * which is behind the admin check.
 */
router.get('/ledger', (req: Request, res: Response) => {
  const limit = Number.parseInt(String(req.query.limit ?? '100'), 10);
  res.json({
    balance: req.user!.credits,
    entries: getLedger(req.user!.id, Number.isFinite(limit) ? limit : 100),
  });
});

export default router;
