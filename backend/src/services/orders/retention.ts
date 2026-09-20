import fs from 'fs/promises';
import path from 'path';
import {
  listExpiredOrders,
  listOrderItems,
  markOrderPurged,
  recordItemFiles,
  type OrderFile,
} from '../../database/orderRepository';
import { getOutputStorageSettings } from '../../config/aiModelConfig';
import { getGeneratedFilePath } from '../../utils/generatedPath';

/**
 * Deleting ordered resumes once their five days are up.
 *
 * Until this existed nothing in the backend ever removed a generated file -
 * there is no cron, no scheduler, and every `setTimeout` in the codebase is a
 * one-shot deadline inside the AI transport. So a busy install accumulated
 * every PDF it had ever rendered, for ever, with no record of which run
 * produced them once the batch had been evicted.
 *
 * The sweep deletes files, never rows. An order that has been purged says
 * `expired` and still lists what it built, because somebody who ordered three
 * hundred resumes and comes back on the sixth day should be told the files are
 * gone rather than shown an empty page that looks like the order never
 * happened.
 */

export const DEFAULT_ORDER_RETENTION_DAYS = 5;

let warnedAboutRetentionSetting = false;

/**
 * How long ordered files are kept.
 *
 * Zero is legal and means "purge on the next sweep", which is how the whole
 * path gets exercised without waiting five days. Anything unreadable falls back
 * to the default and says so once - a typo here would otherwise delete
 * everything immediately or never, and both look like a bug somewhere else.
 */
export function orderRetentionDays(): number {
  const raw = process.env.ORDER_RETENTION_DAYS?.trim();
  if (!raw) return DEFAULT_ORDER_RETENTION_DAYS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    if (!warnedAboutRetentionSetting) {
      warnedAboutRetentionSetting = true;
      console.warn(
        `[orders] ORDER_RETENTION_DAYS="${raw}" is not a number of days; ` +
          `keeping files for ${DEFAULT_ORDER_RETENTION_DAYS}.`
      );
    }
    return DEFAULT_ORDER_RETENTION_DAYS;
  }
  return parsed;
}

export function resetRetentionWarningForTests(): void {
  warnedAboutRetentionSetting = false;
}

/**
 * Removes directories the purge has just emptied, and only those.
 *
 * Emptiness is the test, not ownership, and that is what makes it safe: two
 * accounts whose folder names happened to collide cannot delete each other's
 * work, because the other account's files are still in the directory and
 * `rmdir` refuses. Walking upward stops at the base directory, which is never
 * removed even when the install has no files left at all.
 */
async function pruneEmptyDirectories(directories: Set<string>, baseDir: string): Promise<void> {
  const base = path.resolve(baseDir);

  for (const directory of directories) {
    let current = path.resolve(directory);
    while (current !== base && current.startsWith(`${base}${path.sep}`)) {
      try {
        const entries = await fs.readdir(current);
        if (entries.length > 0) break;
        await fs.rmdir(current);
      } catch {
        // Gone already, not empty after all, or not ours to remove. Either way
        // there is nothing above it worth trying.
        break;
      }
      current = path.dirname(current);
    }
  }
}

/** 200 orders a page, so this is 40,000 - a bound, not a working limit. */
const MAX_SWEEP_PAGES = 200;

export type PurgeReport = {
  orders: number;
  filesRemoved: number;
  filesMissing: number;
};

/**
 * Deletes one order's files and marks it expired.
 *
 * `getGeneratedFilePath` is what resolves each path, deliberately: it applies
 * the same traversal guard the download routes use, so a doctored row cannot
 * make the sweep unlink something outside the output directory. A path it
 * refuses and a file already gone are indistinguishable here, and both count as
 * missing rather than as a failure - the end state wanted is "not on disk",
 * which is already true.
 */
async function purgeOrder(
  orderId: string,
  report: PurgeReport,
  emptiedDirectories: Set<string>
): Promise<void> {
  for (const item of listOrderItems(orderId)) {
    if (item.files.length === 0) continue;

    const removedAt = new Date().toISOString();
    const next: OrderFile[] = [];
    for (const file of item.files) {
      if (file.removedAt) {
        next.push(file);
        continue;
      }

      const absolute = await getGeneratedFilePath(file.path);
      if (absolute) {
        try {
          await fs.unlink(absolute);
          emptiedDirectories.add(path.dirname(absolute));
          report.filesRemoved += 1;
        } catch {
          report.filesMissing += 1;
        }
      } else {
        report.filesMissing += 1;
      }

      next.push({ ...file, removedAt });
    }
    recordItemFiles(item.id, next);
  }

  markOrderPurged(orderId);
  report.orders += 1;
}

/** One pass over everything past its keep-until date. */
export async function purgeExpiredOrders(nowIso: string = new Date().toISOString()): Promise<PurgeReport> {
  const report: PurgeReport = { orders: 0, filesRemoved: 0, filesMissing: 0 };
  const { outputBaseDir } = await getOutputStorageSettings();
  const emptiedDirectories = new Set<string>();

  /*
   * Worked in pages until there is nothing left, rather than taking one page
   * and waiting six hours for the next sweep.
   *
   * An install that was switched off for a fortnight comes back with every
   * order of those two weeks expired at once; clearing two hundred at a time
   * would take days to catch up while the disk stayed full. Each page re-reads
   * the query rather than paging by offset, because the previous page is no
   * longer in the result - `markOrderPurged` removes it.
   *
   * The bound only exists so that a row which somehow refuses to purge cannot
   * spin this for ever.
   */
  for (let page = 0; page < MAX_SWEEP_PAGES; page += 1) {
    const expired = listExpiredOrders(nowIso);
    if (expired.length === 0) break;

    for (const order of expired) {
      await purgeOrder(order.id, report, emptiedDirectories);
    }
  }

  if (outputBaseDir) {
    await pruneEmptyDirectories(emptiedDirectories, outputBaseDir);
  }

  return report;
}

/** Six hours. Files live for days, so checking four times a day is plenty. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

let sweepTimer: NodeJS.Timeout | null = null;

/**
 * Starts the sweep, and is called from exactly one place: the server's listen
 * callback.
 *
 * Not from module scope, which is what keeps it out of the tests - every test
 * in this suite loads the modules it is testing, and a timer started on import
 * would delete files under a temp directory while an unrelated test was using
 * them. `unref` so the interval never holds the process open.
 */
export function startOrderRetention(intervalMs: number = SWEEP_INTERVAL_MS): () => void {
  stopOrderRetention();

  const sweep = () => {
    void purgeExpiredOrders()
      .then((report) => {
        if (report.orders > 0) {
          console.log(
            `[orders] Retention: ${report.orders} order(s) past ${orderRetentionDays()} day(s), ` +
              `${report.filesRemoved} file(s) deleted.`
          );
        }
      })
      .catch((error) => {
        console.warn('[orders] Retention sweep failed; it will run again.', error);
      });
  };

  sweep();
  sweepTimer = setInterval(sweep, intervalMs);
  sweepTimer.unref?.();

  return stopOrderRetention;
}

export function stopOrderRetention(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
