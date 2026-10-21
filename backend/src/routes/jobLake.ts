import { Router, type Request, type Response } from 'express';

import { listIndustriesForClient } from '../config/industries';
import { jobLakePushMaxRows } from '../config/operational';
import {
  deleteLakeEntry,
  getLakeEntry,
  listLakeHistory,
  queryLake,
  revokeLakeReward,
  type LakeEntry,
  type RevokeOutcome,
} from '../database/jobLakeRepository';
import { createNotification } from '../database/notificationRepository';
import { requireAdmin } from '../middleware/auth';
import { PublicError, sendPublicError } from '../middleware/publicError';
import {
  adminLakeSyncStatus,
  describeAdminLakeSheet,
  getOrCreateAdminLakeSheet,
  requestAdminLakeSync,
  syncAdminLakeSheet,
} from '../services/jobLake/adminSheet';
import { listJobTypesForClient } from '../services/jobAnalysis/facts';
import { readLakeFilters, readLakeId } from '../services/jobLake/filters';
import { listMergeCandidates, mergeAnalyses } from '../services/jobLake/merge';
import { pushLakeToSheet } from '../services/jobLake/push';
import { requesterLookup, type Requester } from '../services/jobLake/requesters';
import { readLakeSettings, updateLakeSettings } from '../services/jobLake/settings';
import { formatMoney } from '../utils/money';
import { readPage } from './paging';

/**
 * The Job Data Lake for administrators (`/admin/job-lake`): browse and query
 * the lake, a row and its history, delete one (optionally taking its reward
 * back), the merge of analysed build postings (J6), the settings - the global
 * rate per job, the duplicate window and where it comes from, the daily cap -
 * and the admin sheet with its sync.
 *
 *   GET    /                 ?q=&company=&field=&requestedBy=&jobType=&industry=   (each as many times as it
 *                             has values: `field=backend&field=devops`)
 *                             &salaryMin=&salaryMax=&updatedFrom=&updatedTo=&clearance=&limit=&offset=
 *                             -> { rows, total, limit, offset, options: { jobTypes, industries }, pushMaxRows }
 *   GET    /settings         PUT /settings { reportRateUsd?, duplicateWindowDays?, dailyCapUsd? }
 *   GET    /sync             POST /sync - "Retry now"
 *   POST   /sheet            { recreate? } - create (or replace) and share the admin sheet now
 *   GET    /merge            ?limit=&offset=     POST /merge { analysisIds } | { all: true }
 *   POST   /push             { q?, company?, field?, ... } - the list's filters, as a JSON body (a list
 *                             filter's values as a JSON array): the matching jobs, newest first, into the
 *                             caller's OWN Temp For AI tab
 *   GET    /:id              DELETE /:id ?revokeReward=1     POST /:id/revoke-reward
 *
 * The filters are read by services/jobLake/filters.ts - the one reader the
 * list, the push and Find Jobs share, so a push holds exactly what Search
 * showed and a value one refuses, every one refuses in the same words.
 *
 * Every amount served is thousandths of a dollar in a field ending `Milli`;
 * every amount sent is dollars in one ending `Usd`.
 */

const router = Router();
router.use(requireAdmin);

function withRequester(entry: LakeEntry, lookup: (id: string | null) => Requester) {
  return { ...entry, requester: lookup(entry.requestedBy) };
}

/** Tells the reporter that a reward of theirs was taken back - after the fact, never able to undo it. */
function noticeRevoke(entry: Pick<LakeEntry, 'id' | 'company' | 'jobFieldLabel'>, revoke: RevokeOutcome): void {
  if (!revoke.revoked || !revoke.userId || revoke.takenMilli <= 0) return;
  try {
    createNotification({
      recipientId: revoke.userId,
      title: `Job reward taken back: ${formatMoney(revoke.takenMilli)}`,
      body:
        `An administrator took back the reward for ${entry.company} - ${entry.jobFieldLabel} (job #${entry.id}). ` +
        `Your balance is now ${formatMoney(revoke.balanceMilli ?? 0)}.`,
      link: '/credits',
    });
  } catch (error) {
    console.warn(`[lake] Revoked the reward of job #${entry.id} but could not notify its reporter.`, error);
  }
}

function settingsBody() {
  return { settings: readLakeSettings(), sheet: describeAdminLakeSheet(), sync: adminLakeSyncStatus() };
}

router.get('/', (req: Request, res: Response) => {
  try {
    const page = readPage(req, 50, 200);
    const filters = readLakeFilters(req.query as Record<string, unknown>, { requestedBy: true });
    const { rows, total } = queryLake({ ...filters, limit: page.limit, offset: page.offset });
    const lookup = requesterLookup();
    res.json({
      rows: rows.map((row) => withRequester(row, lookup)),
      total,
      limit: page.limit,
      offset: page.offset,
      // What the job type and industry filters may be, in the server's words.
      options: { jobTypes: listJobTypesForClient(), industries: listIndustriesForClient() },
      // The most rows one Push to Google Sheet writes (JOB_LAKE_PUSH_MAX_ROWS),
      // so its confirm can say when only the newest of `total` would go.
      pushMaxRows: jobLakePushMaxRows(),
    });
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to read the job lake');
  }
});

router.get('/settings', (_req: Request, res: Response) => {
  res.json(settingsBody());
});

router.put('/settings', (req: Request, res: Response) => {
  const result = updateLakeSettings(req.body, req.user!.id);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error, code: result.code });
    return;
  }
  res.json(settingsBody());
});

router.get('/sync', (_req: Request, res: Response) => {
  res.json({ sheet: describeAdminLakeSheet(), sync: adminLakeSyncStatus() });
});

/** "Retry now": the sync, awaited, so the page shows what it did. */
router.post('/sync', async (_req: Request, res: Response) => {
  const report = await syncAdminLakeSheet();
  res.json({ report, sheet: describeAdminLakeSheet(), sync: adminLakeSyncStatus() });
});

router.post('/sheet', async (req: Request, res: Response) => {
  try {
    const sheet = await getOrCreateAdminLakeSheet({ recreate: req.body?.recreate === true });
    requestAdminLakeSync('the admin sheet being set up');
    res.json({ sheet, sync: adminLakeSyncStatus() });
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to set up the admin sheet');
  }
});

router.get('/merge', (req: Request, res: Response) => {
  const page = readPage(req, 50, 200);
  const { rows, total } = listMergeCandidates(page.limit, page.offset);
  const lookup = requesterLookup();
  res.json({
    rows: rows.map((row) => ({ ...row, requester: lookup(row.createdBy) })),
    total,
    limit: page.limit,
    offset: page.offset,
  });
});

router.post('/merge', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const all = body.all === true;
  const ids = Array.isArray(body.analysisIds)
    ? body.analysisIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map((id) => id.trim())
    : [];
  if (!all && ids.length === 0) {
    res.status(400).json({ error: 'Choose the jobs to merge, or merge all of them.' });
    return;
  }
  if (ids.length > 1000) {
    res.status(400).json({ error: 'Merge at most 1000 jobs at a time.' });
    return;
  }
  try {
    res.json(mergeAnalyses(all ? { all: true } : { analysisIds: ids }));
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to merge the jobs');
  }
});

/**
 * Push to Google Sheet: the jobs the filters match (the list's own, in the
 * body) into the CALLER's own Temp For AI tab, replacing what it held -
 * answered `{ pushed, matched, capped, maxRows, tabName, tabUrl }` once the
 * rows are written. Declared before the `/:id` routes, which would otherwise
 * take `push` for an id.
 */
router.post('/push', async (req: Request, res: Response) => {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
    res.json(await pushLakeToSheet(req.user!, readLakeFilters(body, { requestedBy: true })));
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to push the jobs to your sheet');
  }
});

router.get('/:id', (req: Request<{ id: string }>, res: Response) => {
  try {
    const entry = getLakeEntry(readLakeId(req.params.id));
    if (!entry) throw new PublicError('That job was not found in the lake.', { status: 404 });
    const lookup = requesterLookup();
    res.json({
      entry: withRequester(entry, lookup),
      history: listLakeHistory(entry.id).map((version) => ({ ...version, requester: lookup(version.requestedBy) })),
    });
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to read the job');
  }
});

router.delete('/:id', (req: Request<{ id: string }>, res: Response) => {
  try {
    const id = readLakeId(req.params.id);
    const revokeReward =
      req.query.revokeReward === '1' || req.query.revokeReward === 'true' || req.body?.revokeReward === true;
    const { deleted, revoke } = deleteLakeEntry(id, { revokeReward, actorId: req.user!.id });
    if (!deleted) throw new PublicError('That job was not found in the lake.', { status: 404 });
    if (revoke) noticeRevoke(deleted, revoke);
    res.json({ deleted: true, id, revoke });
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to delete the job');
  }
});

router.post('/:id/revoke-reward', (req: Request<{ id: string }>, res: Response) => {
  try {
    const id = readLakeId(req.params.id);
    const entry = getLakeEntry(id);
    if (!entry) throw new PublicError('That job was not found in the lake.', { status: 404 });
    const revoke = revokeLakeReward(id, req.user!.id);
    noticeRevoke(entry, revoke);
    const lookup = requesterLookup();
    const updated = getLakeEntry(id) ?? entry;
    res.json({ revoke, entry: withRequester(updated, lookup) });
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to revoke the reward');
  }
});

export default router;
