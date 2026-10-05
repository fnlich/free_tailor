import { Router, type Request, type Response } from 'express';

import { isJobFieldId } from '../config/jobFields';
import {
  deleteLakeEntry,
  getLakeEntry,
  listLakeHistory,
  queryLake,
  revokeLakeReward,
  type LakeEntry,
  type LakeQuery,
  type RevokeOutcome,
} from '../database/jobLakeRepository';
import { createNotification } from '../database/notificationRepository';
import { getUserById } from '../database/userRepository';
import { requireAdmin } from '../middleware/auth';
import { PublicError, sendPublicError } from '../middleware/publicError';
import {
  adminLakeSyncStatus,
  describeAdminLakeSheet,
  getOrCreateAdminLakeSheet,
  requestAdminLakeSync,
  syncAdminLakeSheet,
} from '../services/jobLake/adminSheet';
import { listMergeCandidates, mergeAnalyses } from '../services/jobLake/merge';
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
 *   GET    /                 ?q=&company=&field=&salaryMin=&salaryMax=&requestedBy=&updatedFrom=&updatedTo=&limit=&offset=
 *   GET    /settings         PUT /settings { reportRateUsd?, duplicateWindowDays?, dailyCapUsd? }
 *   GET    /sync             POST /sync - "Retry now"
 *   POST   /sheet            { recreate? } - create (or replace) and share the admin sheet now
 *   GET    /merge            ?limit=&offset=     POST /merge { analysisIds } | { all: true }
 *   GET    /:id              DELETE /:id ?revokeReward=1     POST /:id/revoke-reward
 *
 * Every amount served is thousandths of a dollar in a field ending `Milli`;
 * every amount sent is dollars in one ending `Usd`.
 */

const router = Router();
router.use(requireAdmin);

type Requester = { id: string; email: string; name: string } | null;

/** The accounts a list names, looked up once each, `null` for one deleted since. */
function requesterLookup(): (id: string | null) => Requester {
  const cache = new Map<string, Requester>();
  return (id) => {
    if (!id) return null;
    if (!cache.has(id)) {
      const account = getUserById(id);
      cache.set(id, account ? { id: account.id, email: account.email, name: account.name } : null);
    }
    return cache.get(id) ?? null;
  };
}

function withRequester(entry: LakeEntry, lookup: (id: string | null) => Requester) {
  return { ...entry, requester: lookup(entry.requestedBy) };
}

/** A query-string number, or undefined when absent; a 400 for anything else. */
function readNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const number = typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(number)) throw new PublicError(`${label} must be a number.`, { status: 400 });
  return number;
}

/** A date or a time; a bare date is the start of that day (UTC) for `from`, its end for `to`. */
function readTime(value: unknown, label: string, end: boolean): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const text = value.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const at = Date.parse(dateOnly ? `${text}T${end ? '23:59:59.999' : '00:00:00.000'}Z` : text);
  if (!Number.isFinite(at)) throw new PublicError(`${label} must be a date, like 2026-10-05.`, { status: 400 });
  return new Date(at).toISOString();
}

function readLakeQuery(req: Request): LakeQuery {
  const page = readPage(req, 50, 200);
  const text = (name: string) => (typeof req.query[name] === 'string' ? (req.query[name] as string).trim() : '');
  const field = text('field');
  if (field && field !== 'unclassified' && !isJobFieldId(field)) {
    throw new PublicError('That job field is not one of the list.', { status: 400 });
  }
  const query: LakeQuery = { limit: page.limit, offset: page.offset };
  if (text('q')) query.text = text('q');
  if (text('company')) query.company = text('company');
  if (field) query.jobFieldId = field;
  if (text('requestedBy')) query.requestedBy = text('requestedBy');
  const salaryMin = readNumber(req.query.salaryMin, 'The lowest salary');
  const salaryMax = readNumber(req.query.salaryMax, 'The highest salary');
  if (salaryMin !== undefined) query.salaryMin = salaryMin;
  if (salaryMax !== undefined) query.salaryMax = salaryMax;
  const from = readTime(req.query.updatedFrom, 'Updated from', false);
  const to = readTime(req.query.updatedTo, 'Updated to', true);
  if (from) query.updatedFrom = from;
  if (to) query.updatedTo = to;
  return query;
}

function readId(req: Request<{ id: string }>): number {
  const id = /^\d{1,15}$/.test(req.params.id) ? Number(req.params.id) : Number.NaN;
  if (!Number.isSafeInteger(id) || id < 1) throw new PublicError('That job was not found in the lake.', { status: 404 });
  return id;
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
    const query = readLakeQuery(req);
    const { rows, total } = queryLake(query);
    const lookup = requesterLookup();
    res.json({ rows: rows.map((row) => withRequester(row, lookup)), total, limit: query.limit, offset: query.offset });
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

router.get('/:id', (req: Request<{ id: string }>, res: Response) => {
  try {
    const entry = getLakeEntry(readId(req));
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
    const id = readId(req);
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
    const id = readId(req);
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
