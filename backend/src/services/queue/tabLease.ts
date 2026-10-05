/**
 * Generate Immediately is tied to the tab that asked for it (owner decision B4).
 *
 * An immediate run is an ordinary queued batch - so download, stop and refund
 * share one path with orders - with one difference: it lives only as long as
 * somebody is watching it. "Watching" is a READER: the tab's progress stream
 * (`GET /generation/batches/:id/stream?tab=`), held open for as long as the
 * page is. This module counts the readers of each immediate batch, and when
 * the last one goes it starts a grace timer (IMMEDIATE_TAB_GRACE_MS, 30 s by
 * default). A reader that comes back inside the grace - a network blip, a
 * phone that slept, a proxy's idle cut - clears it, and the run carries on as
 * if nothing happened. One that does not come back gets the run cancelled:
 * queued resumes are dropped and refunded, running ones aborted (and refunded
 * if the abort lands first), exactly as the Cancel button does, because that
 * is what is called.
 *
 * Why a lease and not "cancel when the stream closes": a stream closes for many
 * reasons that are not the person leaving - a proxy's idle cut, a laptop lid, a
 * network that dropped for a moment - and stopping a twenty-resume run over
 * one of those would be the wrong answer to the wrong event. A page that DOES
 * know it is leaving - the tab closed or reloaded (`pagehide`), Build Resumes
 * left inside the app - says so (`release`), and that stops the run at once,
 * without waiting for any grace. The grace is only for the pages that went
 * without saying so: a dropped connection, a laptop asleep, a browser killed,
 * a release that never arrived.
 *
 * A reader counts by RENEWAL, not by its connection closing. A peer that
 * vanishes without a FIN or a reset - the lid closed, the battery died, the
 * phone left coverage - leaves its socket looking open to this process, and
 * the stream's heartbeats go on landing in the kernel's send buffer, until TCP
 * gives up some fifteen minutes later; counted by `close` alone, such a tab
 * held its run to the end and was charged for every resume nobody received.
 * So a hold lasts `LEASE_READER_LIFETIME_MS` at most: then the reader is
 * counted out exactly as if it had closed, and the route ends its stream. A
 * page that is still there reads that as an ordinary end and attaches again a
 * second later (lib/batchFollow.ts), holding afresh before the grace is out; a
 * page that is gone does not, and its run stops within the lifetime plus the
 * grace.
 *
 * The timer is also armed with no reader at all: at submit, so a tab that
 * never attaches (it crashed, it lost the network the moment it got its id)
 * does not leave a run going for nobody; and after a restart, for every
 * immediate batch the restore brought back, so a run whose tab is long gone
 * stops instead of building for an empty room.
 *
 * Nothing here is written to disk. The lease is a fact about connections to
 * THIS process, and a restart has none - which is why the restore arms the
 * timer rather than reading anything back.
 *
 * Who counts as a reader is the route's decision, not this module's: the
 * batch's owner, on the tab the run was started from (see routes/generation).
 */

/**
 * How long one reader's hold lasts before it has to be renewed, in ms.
 *
 * It bounds how long a reader that vanished without a word can keep a run
 * alive: this, plus the grace. A page that is still there loses nothing by it
 * - its stream ends, and it attaches again about a second later, well inside
 * even the shortest grace (5 s). Under the stream's own 25 s heartbeat, too,
 * so a lease-holding stream is renewed before a proxy could see it idle. A
 * constant, not a setting, like the heartbeat.
 */
export const LEASE_READER_LIFETIME_MS = 20_000;

export type TabLeaseDeps = {
  /** Stops the batch: the queue's own `cancel`, which refunds what it drops. */
  cancel(batchId: string): unknown;
  /** Whether the batch is still running - a finished one has nothing to stop. */
  isRunning(batchId: string): boolean;
  /** IMMEDIATE_TAB_GRACE_MS, read each time a timer starts. */
  graceMs(): number;
  /** Where a stop is reported. The console by default. */
  log?(message: string): void;
};

type Lease = {
  readers: number;
  timer: ReturnType<typeof setTimeout> | null;
};

export type TabLeaseState = { readers: number; armed: boolean };

export class TabLeases {
  private readonly leases = new Map<string, Lease>();

  constructor(private readonly deps: TabLeaseDeps) {}

  /**
   * A reader attached: the grace timer, if one was running, is stopped.
   *
   * Returns the reader's own release, to call when its connection closes. It
   * is idempotent - a `close` can fire after an `end` that already released,
   * or after the hold ran out - so one reader can never be counted out twice
   * and take another's place.
   *
   * The hold lasts `LEASE_READER_LIFETIME_MS` at most. When that runs out the
   * reader is counted out as its release would, and `onExpire` is called so
   * the route can end its stream: a page still there attaches again and holds
   * afresh; one that vanished without closing its connection does not.
   */
  hold(batchId: string, onExpire?: () => void): () => void {
    const lease = this.lease(batchId);
    lease.readers += 1;
    this.disarm(lease);

    let released = false;
    const letGo = () => {
      if (released) return;
      released = true;
      clearTimeout(expiry);
      const current = this.leases.get(batchId);
      // Forgotten meanwhile: the batch finished, or was released. Nothing to do.
      if (current !== lease) return;
      lease.readers = Math.max(0, lease.readers - 1);
      if (lease.readers === 0) this.arm(batchId);
    };
    const expiry = setTimeout(() => {
      // Checked here too, not left to clearTimeout alone: a timer started
      // before a test handed the clock over is not one a mocked clear reaches.
      if (released) return;
      letGo();
      onExpire?.();
    }, LEASE_READER_LIFETIME_MS);
    // Never what keeps the process alive.
    expiry.unref?.();
    return letGo;
  }

  /**
   * Starts the grace timer when nobody holds the batch and none is running.
   *
   * For the moments with no reader to release: submit, and the restore. A
   * finished batch is forgotten instead - there is nothing left to stop.
   */
  arm(batchId: string): void {
    if (!this.deps.isRunning(batchId)) {
      this.forget(batchId);
      return;
    }
    const lease = this.lease(batchId);
    if (lease.readers > 0 || lease.timer) return;

    const graceMs = this.deps.graceMs();
    const timer = setTimeout(() => {
      // Re-checked at expiry, not trusted from when it was set: the batch may
      // have finished, or a reader may have arrived and replaced this lease.
      if (this.leases.get(batchId) !== lease || lease.timer !== timer) return;
      this.leases.delete(batchId);
      if (lease.readers > 0 || !this.deps.isRunning(batchId)) return;
      (this.deps.log ?? console.log)(
        `[queue] Immediate run ${batchId} stopped: no page has followed it for ${graceMs} ms ` +
          '(IMMEDIATE_TAB_GRACE_MS). Resumes that had not started were refunded.'
      );
      this.deps.cancel(batchId);
    }, graceMs);
    // Never what keeps the process alive - a test's, or a server shutting down.
    timer.unref?.();
    lease.timer = timer;
  }

  /**
   * The tab said it is leaving: stop the run now rather than after the grace.
   * Returns whatever `cancel` answered, or null when there was nothing running.
   */
  release(batchId: string): unknown {
    this.forget(batchId);
    if (!this.deps.isRunning(batchId)) return null;
    return this.deps.cancel(batchId);
  }

  /** The batch is over: drop its lease and any timer. Safe to call for anything. */
  forget(batchId: string): void {
    const lease = this.leases.get(batchId);
    if (!lease) return;
    this.disarm(lease);
    this.leases.delete(batchId);
  }

  /** How a batch's lease stands, for the tests and nothing else. */
  state(batchId: string): TabLeaseState | null {
    const lease = this.leases.get(batchId);
    return lease ? { readers: lease.readers, armed: lease.timer !== null } : null;
  }

  /** Tests share one process; a timer left running would fire into the next. */
  reset(): void {
    for (const lease of this.leases.values()) this.disarm(lease);
    this.leases.clear();
  }

  private lease(batchId: string): Lease {
    let lease = this.leases.get(batchId);
    if (!lease) {
      lease = { readers: 0, timer: null };
      this.leases.set(batchId, lease);
    }
    return lease;
  }

  private disarm(lease: Lease): void {
    if (lease.timer) clearTimeout(lease.timer);
    lease.timer = null;
  }
}
