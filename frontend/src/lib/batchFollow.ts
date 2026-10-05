/**
 * When the builder stops reattaching to a running batch's progress stream, and
 * which batch it picks back up when it opens (`reattachTarget`, below).
 * Kept apart from the page so the backend suite can test it
 * (backend/test/frontendHelpers.test.js, frontendEditorHelpers.test.js);
 * imports nothing at runtime.
 *
 * The budget used to count EVERY attach. A proxy that closes an idle
 * connection (Cloudflare after about 100 s, nginx and AWS load balancers after
 * 60 s by default) cut a healthy stream each time a resume took that long, so a
 * long batch spent all twenty reattaches on its own quiet spells - and the page
 * reported "Finished 4 of 30" while the server went on building the rest. Now
 * only attaches that delivered nothing count, and only in a row: one that
 * brought a snapshot proves the server is still there and starts the count
 * again. (The server also sends a bare newline every 25 s, which keeps most
 * proxies from cutting it at all.)
 */

/** How many attaches in a row may deliver nothing before the page stops following. */
export const MAX_IDLE_REATTACHES = 20;

/** What one attach to the stream, and the snapshot read after it, came back with. */
export type AttachOutcome = {
  /** Snapshot lines the stream delivered before it ended. */
  delivered: number;
  /** The server answered 404 for the batch: restarted or expired, and asking again cannot help. */
  gone: boolean;
};

/**
 * After an attach that ended with the batch still running: the count of
 * empty attaches in a row so far, and whether to stop following.
 */
export function nextAttach(
  idleInARow: number,
  outcome: AttachOutcome
): { idleInARow: number; stop: boolean } {
  if (outcome.gone) return { idleInARow, stop: true };
  const idle = outcome.delivered > 0 ? 0 : idleInARow + 1;
  return { idleInARow: idle, stop: idle >= MAX_IDLE_REATTACHES };
}

/** What the builder needs of a listed batch to decide whether to pick it back up. */
export type ListedBatch = {
  batchId: string;
  state: string;
  /** 'order' for a placed order; absent from a server that does not say. */
  kind?: string;
};

/**
 * Which running batch the builder picks back up when it opens, if any, and
 * whether the id this browser remembered should be forgotten.
 *
 * Only a batch the server LISTS as active for the caller (`GET
 * /generation/batches?active=1`, which answers the caller's own unfinished
 * builds and never an order) - even the remembered one. Reading the
 * remembered id straight from the batch endpoint let an administrator's page
 * follow whichever run that browser last remembered, another account's
 * included, since an administrator may read any batch; and the first entry of
 * an unfiltered list could be somebody else's run or an order, which locked
 * the whole page until a three-hundred-resume order finished. An order is
 * followed on the Orders page, never here, so one is skipped even from a
 * server that still lists them.
 *
 * `listed` is null when the list could not be read: nothing is attached, and
 * the remembered id is kept for the next visit rather than forgotten over a
 * network blip.
 */
export function reattachTarget(
  listed: readonly ListedBatch[] | null,
  remembered: string | null
): { batchId: string | null; forget: boolean } {
  if (listed === null) return { batchId: null, forget: false };
  const eligible = listed.filter((batch) => batch.state === 'running' && batch.kind !== 'order');
  if (remembered && eligible.some((batch) => batch.batchId === remembered)) {
    return { batchId: remembered, forget: false };
  }
  return { batchId: eligible[0]?.batchId ?? null, forget: Boolean(remembered) };
}
