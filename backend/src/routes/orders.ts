import path from 'path';
import { Router, type Request, type Response } from 'express';
import archiver, { type ArchiverError } from 'archiver';

import { requireUser } from '../middleware/auth';
import {
  countsForOrder,
  countsForOrders,
  getOrder,
  getOrderItem,
  isOrderFileKind,
  listOrderItems,
  listOrdersForUser,
  ordersWithFiles,
  settleOrderIfFinished,
  type Order,
  type OrderCounts,
  type OrderFile,
  type OrderItem,
} from '../database/orderRepository';
import { getGenerationQueue } from '../services/queue';
import { getGeneratedFilePath } from '../utils/generatedPath';
import { sanitizePathSegment } from '../utils/outputStorage';

/**
 * Orders: what was built, how far along it is, and how to get the files.
 *
 * Every route takes an order id, and that is the whole reason `mine()` exists.
 * The lesson is the one the job routes learned the hard way: an id in a path is
 * an id somebody can change, and "signed in" is not the same question as "yours".
 * A stranger's order answers **404**, never 403, because the difference between
 * those two replies confirms that the order exists.
 *
 * Nothing here asks the queue anything except to cancel. Counts, items and file
 * paths all come from the database, because the batch behind an order is
 * evicted an hour after it finishes and a page that depended on it would go
 * blank exactly when somebody came back for their files.
 */

const router = Router();
router.use(requireUser);

/** The one gate. Returns null for "not yours" and "not there" alike. */
function mine(req: Request): Order | null {
  const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
  if (!id) return null;
  const order = getOrder(id);
  if (!order || order.userId !== req.user!.id) return null;
  return order;
}

function notFound(res: Response): void {
  res.status(404).json({ error: 'That order was not found.' });
}

type OrderView = Order & { counts: OrderCounts; hasFiles: boolean };

function view(order: Order, counts: OrderCounts, hasFiles: boolean): OrderView {
  return { ...order, counts, hasFiles };
}

/**
 * Closes an order that finished without anyone noticing.
 *
 * `settleOrderIfFinished` normally runs from the finished hook, so an order
 * settles the moment its last task reports. A process killed between that
 * report and the settle leaves the order at `running` with nothing left to move
 * it, and nothing else in the system would ever look at it again - the page
 * would read "In progress" for ever. Reading it is the natural moment to check,
 * and the call is a no-op for every order that is genuinely still working.
 */
function reconciled(order: Order): Order {
  if (order.state !== 'running') return order;
  return settleOrderIfFinished(order.id) ?? order;
}

/** A file the caller can still fetch. A purged one is listed but not offered. */
function availableFiles(item: OrderItem): OrderFile[] {
  return item.files.filter((file) => !file.removedAt);
}

router.get('/', (req: Request, res: Response) => {
  const orders = listOrdersForUser(req.user!.id).map(reconciled);
  // One grouped count for the whole page rather than one query per order, and
  // certainly not the item rows themselves: twenty orders of three hundred is
  // six thousand rows to render twenty progress bars.
  const ids = orders.map((order) => order.id);
  const counts = countsForOrders(ids);
  const withFiles = ordersWithFiles(ids);
  res.json({
    orders: orders.map((order) => view(order, counts.get(order.id)!, withFiles.has(order.id))),
    retentionNote: 'Ordered files are deleted automatically once their order expires.',
  });
});

router.get('/:id', (req: Request, res: Response) => {
  const found = mine(req);
  if (!found) {
    notFound(res);
    return;
  }

  const order = reconciled(found);
  const items = listOrderItems(order.id);
  res.json({
    ...view(order, countsForOrder(order.id), items.some((item) => item.files.length > 0)),
    items: items.map((item) => ({
      ...item,
      // What the page may offer a link for. The full list stays on `files` so
      // an expired order can still show what it built.
      available: availableFiles(item).map((file) => file.kind),
    })),
  });
});

/**
 * Cancels the remaining work.
 *
 * Delegated to the queue rather than written here, because cancelling is the
 * dispatcher's job and it already refunds the credits for what it drops. The
 * item rows follow on their own: every cancelled task comes back through the
 * finished hook.
 */
router.post('/:id/cancel', (req: Request, res: Response) => {
  const order = mine(req);
  if (!order) {
    notFound(res);
    return;
  }
  if (!order.batchId) {
    res.status(409).json({ error: 'This order has no work left to cancel.' });
    return;
  }

  const outcome = getGenerationQueue().cancel(order.batchId);
  if (!outcome) {
    res.status(409).json({ error: 'This order has already finished.' });
    return;
  }
  res.json(outcome);
});

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

router.get('/:id/items/:itemId/:kind', async (req: Request, res: Response) => {
  try {
    const order = mine(req);
    if (!order) {
      notFound(res);
      return;
    }

    const kind = req.params.kind;
    if (!isOrderFileKind(kind)) {
      notFound(res);
      return;
    }

    const item = getOrderItem(order.id, String(req.params.itemId ?? ''));
    const file = item?.files.find((candidate) => candidate.kind === kind);
    if (!item || !file) {
      notFound(res);
      return;
    }
    if (file.removedAt) {
      res.status(410).json({ error: 'That file has been deleted. Orders are kept for a few days.' });
      return;
    }

    // Resolved rather than joined: this applies the same traversal guard every
    // other download uses, so a doctored row cannot reach outside the output
    // directory even though the path came from our own database.
    const absolute = await getGeneratedFilePath(file.path);
    if (!absolute) {
      res.status(410).json({ error: 'That file is no longer on the server.' });
      return;
    }

    const extension = path.extname(absolute).toLowerCase();
    if (CONTENT_TYPES[extension]) res.setHeader('Content-Type', CONTENT_TYPES[extension]);
    // The callback matters: `res.download` reports a send failure through it,
    // not by rejecting, so the surrounding catch would never see a file that
    // vanished between `fs.access` and the read - and Express's default handler
    // would then try to write a response over headers already sent.
    res.download(absolute, path.basename(absolute), (sendError) => {
      if (!sendError) return;
      console.warn(`[orders] Could not finish sending ${file.path}.`, sendError);
      if (!res.headersSent) res.status(410).json({ error: 'That file is no longer on the server.' });
      else res.destroy();
    });
  } catch (error) {
    // Express 4 does not catch a rejected async handler, and an uncaught one
    // takes the process down rather than just the request.
    console.error('[orders] Could not serve an ordered file.', error);
    if (!res.headersSent) res.status(500).json({ error: 'Could not read that file.' });
  }
});

/**
 * What an entry is called inside the zip.
 *
 * Company, then profile, then the file's own name - so an archive of three
 * hundred resumes opens as something a person can navigate rather than three
 * hundred files in one flat list. The segments are sanitized with the same
 * helper the output tree uses, because a company called `A/B` would otherwise
 * invent a directory level, and `..` would invent a worse one.
 */
function entryName(item: OrderItem, file: OrderFile): string {
  const company = sanitizePathSegment(item.companyName) || 'unknown';
  const profile = sanitizePathSegment(item.profileName) || 'unknown';
  return `${company}/${profile}/${path.basename(file.path)}`;
}

/**
 * The whole order as one archive, or `?items=a,b` for a selection.
 *
 * Streamed, never buffered: three hundred resumes is hundreds of megabytes, and
 * building that in memory to send it would be the one request that takes the
 * server down.
 */
router.get('/:id/zip', async (req: Request, res: Response) => {
  try {
    const order = mine(req);
    if (!order) {
      notFound(res);
      return;
    }

    /*
     * Flattened, never ignored.
     *
     * `?items=a&items=b` parses to an ARRAY, and reading only the string case
     * left `wanted` empty - which this route reads as "no selection", i.e. the
     * whole order. A selection that silently widens to everything is the one
     * failure mode a selection must not have.
     */
    const rawItems = req.query.items;
    const requested = Array.isArray(rawItems)
      ? rawItems.map(String).join(',')
      : typeof rawItems === 'string'
        ? rawItems
        : '';
    const wanted = new Set(
      requested
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    );

    const items = listOrderItems(order.id).filter((item) => wanted.size === 0 || wanted.has(item.id));

    const entries: Array<{ name: string; absolute: string }> = [];
    const taken = new Set<string>();
    for (const item of items) {
      for (const file of availableFiles(item)) {
        const absolute = await getGeneratedFilePath(file.path);
        if (!absolute) continue;

        // Two profiles of the same name for one company would otherwise write
        // the same entry twice, and most unzip tools silently keep whichever
        // came last. A suffix is uglier than a lost file is dangerous.
        let name = entryName(item, file);
        if (taken.has(name)) {
          const extension = path.extname(name);
          name = `${name.slice(0, name.length - extension.length)}_${item.seq}${extension}`;
        }
        taken.add(name);
        entries.push({ name, absolute });
      }
    }

    if (entries.length === 0) {
      res.status(404).json({ error: 'This order has no files to download.' });
      return;
    }

    /*
     * `store`, not deflate: PDFs and DOCX files are already compressed, so
     * recompressing them burns CPU per byte to save almost nothing.
     *
     * archiver is pinned to 7.x deliberately. 8.x is ESM-only, and this backend
     * compiles to CommonJS - it loads here only because Node 22 allows
     * `require` of an ES module. On an older runtime the `require` emitted for
     * this file throws at import time, and because this router is imported by
     * index.ts that takes down the entire server rather than just the orders
     * routes.
     */
    const archive = archiver('zip', { store: true });
    let failed = false;
    archive.on('warning', (error: ArchiverError) => {
      console.warn(`[orders] Zip warning for ${order.number}.`, error);
      /*
       * A file that vanished between the listing loop above and the streaming
       * loop below - which the retention sweep can do, and for a big order the
       * gap is the whole duration of the stream.
       *
       * archiver reports that as a WARNING, not an error: it decrements its
       * entry count and carries on. Left alone, the caller would get HTTP 200
       * and a valid archive quietly missing files, which is precisely the
       * outcome the error handler below exists to prevent. So it is treated the
       * same way - a broken download beats a complete-looking one.
       */
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        failed = true;
        res.destroy(error);
      }
    });
    archive.on('error', (error: ArchiverError) => {
      failed = true;
      console.error(`[orders] Zip failed for ${order.number}.`, error);
      // The headers are long gone by the time most errors happen, so the only
      // honest signal left is to break the stream: a truncated download beats a
      // complete-looking archive with files missing from it.
      res.destroy(error);
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${order.number}.zip"`);
    archive.pipe(res);

    for (const entry of entries) {
      if (failed) break;
      archive.file(entry.absolute, { name: entry.name });
    }

    try {
      await archive.finalize();
    } catch (error) {
      // Already reported by the listener above, which destroyed the response.
      // Swallowed so it does not also become an unhandled rejection.
      if (!failed) console.error(`[orders] Zip could not be finished for ${order.number}.`, error);
    }
  } catch (error) {
    console.error('[orders] Could not build an order archive.', error);
    if (!res.headersSent) res.status(500).json({ error: 'Could not build that archive.' });
  }
});

export default router;
