import { Router, type Request, type Response } from 'express';

import { requireUser } from '../middleware/auth';
import { countLedger, getLedger, getStatus, CREDITS_PER_RESUME } from '../services/credits';
import { readPage } from './paging';

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
  /*
   * Paged, because this list grows by a row per generation run.
   *
   * `total` is the point of it: without one the credits page could not tell a
   * short last page from a full one, and described whatever it had been given
   * as the account's credit history.
   */
  const { limit, offset } = readPage(req, 100, 100);
  res.json({
    balance: req.user!.credits,
    entries: getLedger(req.user!.id, limit, offset),
    total: countLedger(req.user!.id),
    offset,
  });
});

export default router;
