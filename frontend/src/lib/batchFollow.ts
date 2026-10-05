/**
 * How the builder keeps following its run's progress stream, and which batch
 * it picks back up when it opens (`reattachTarget`, below). Kept apart from
 * the page so the backend suite can test it (backend/test/frontendHelpers.test.js,
 * frontendEditorHelpers.test.js); imports nothing at runtime.
 *
 * A stream ends without the run being over often enough to plan for: a proxy
 * closes an idle connection (Cloudflare after about 100 s, nginx and AWS load
 * balancers after 60 s by default), a laptop sleeps, a network drops - and the
 * server itself ends the stream of a tab's own Generate Immediately run every
 * 20 s, because attaching again is how that tab shows it is still there (a
 * connection that vanished without closing looks open to the server for many
 * minutes). The page then asks for a snapshot and attaches again, a second
 * later, until the SERVER says the run is over. (The server also sends a bare
 * newline every 25 s, which keeps most proxies from cutting it at all.)
 */

/**
 * How many attaches in a row may deliver nothing before the page slows down
 * from one attach a second to one every `SLOW_REATTACH_MS`.
 */
export const MAX_IDLE_REATTACHES = 20;
export const REATTACH_MS = 1000;
export const SLOW_REATTACH_MS = 10_000;

/** What one attach to the stream, and the snapshot read after it, came back with. */
export type AttachOutcome = {
  /** Snapshot lines the stream delivered before it ended. */
  delivered: number;
  /** The server answered 404 for the batch: restarted or expired, and asking again cannot help. */
  gone: boolean;
};

/**
 * After an attach that ended with the batch still running: the count of
 * empty attaches in a row so far, whether to stop following, and how long to
 * wait before the next attach.
 *
 * Only a 404 stops it. The one run the builder follows is this tab's own
 * Generate Immediately run, and that always ends on the server - finished,
 * stopped, or cancelled by its tab lease once no stream of this tab has held
 * it for IMMEDIATE_TAB_GRACE_MS - so following it until the server says so
 * ends as soon as the server can be reached. Giving up after twenty empty
 * attaches, as the page used to, stopped DOWNLOADING a run the server went on
 * building: the grace can be up to ten minutes, and a network that came back
 * at minute two found nobody to take the rest of the resumes. Attaches that
 * bring nothing only slow down, so a long outage costs one request every ten
 * seconds rather than one a second.
 */
export function nextAttach(
  idleInARow: number,
  outcome: AttachOutcome
): { idleInARow: number; stop: boolean; delayMs: number } {
  if (outcome.gone) return { idleInARow, stop: true, delayMs: 0 };
  const idle = outcome.delivered > 0 ? 0 : idleInARow + 1;
  return { idleInARow: idle, stop: false, delayMs: idle >= MAX_IDLE_REATTACHES ? SLOW_REATTACH_MS : REATTACH_MS };
}

/** What the builder needs of a listed batch to decide whether to pick it back up. */
export type ListedBatch = {
  batchId: string;
  state: string;
  /** 'immediate' for a Generate Immediately run, 'order' for a placed order, null for one from before kinds. */
  kind?: string | null;
};

/**
 * Which running batch the builder picks back up when it opens, if any, and
 * whether the run this tab remembered should be forgotten.
 *
 * Only a Generate Immediately run the server LISTS for this tab (`GET
 * /generation/batches?active=1&tab=<tabId>`, which answers the caller's own
 * running immediate runs started from that tab and nothing else) - the
 * remembered one first, then the first listed. An order is followed on the
 * Orders page, never here, and so is anything without the `immediate` kind,
 * even from a server that lists one: following another tab's run held its
 * lease from the wrong tab and downloaded its resumes twice, and following an
 * order locked the whole page until a three-hundred-resume order finished.
 *
 * `listed` is null when the list could not be read: nothing is attached, and
 * the remembered run is kept for the next visit rather than forgotten over a
 * network blip.
 */
export function reattachTarget(
  listed: readonly ListedBatch[] | null,
  remembered: string | null
): { batchId: string | null; forget: boolean } {
  if (listed === null) return { batchId: null, forget: false };
  const eligible = listed.filter((batch) => batch.state === 'running' && batch.kind === 'immediate');
  if (remembered && eligible.some((batch) => batch.batchId === remembered)) {
    return { batchId: remembered, forget: false };
  }
  return { batchId: eligible[0]?.batchId ?? null, forget: Boolean(remembered) };
}
