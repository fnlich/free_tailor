/**
 * The tabs one free chat provider may drive, and the line waiting for them.
 *
 * A chat tab holds ONE conversation, so a second prompt typed into a composer
 * that is mid-answer does not queue - it interleaves, and both answers are
 * lost. The only way to run two free calls at once is therefore two tabs, and
 * two tabs means two browsers, because a second tab in the same window is a
 * background tab and Chrome freezes those.
 *
 * So a pool is a list of browsers, one tab apiece, and a queue. How many
 * browsers a site has IS its concurrency. The queue behind them is UNBOUNDED
 * and strictly first-come-first-served: the moment any tab frees, the call at
 * the head of the line takes that tab. Nothing is refused for being late in the
 * line - a caller only ever gives up on its own deadline.
 *
 * Kept apart from `AsyncSemaphore` because the two answer different questions.
 * A semaphore hands out permission to proceed; this hands out WHICH TAB to
 * proceed on, and a caller cannot drive a browser without knowing that.
 */

export type TabLease = {
  /** The DevTools endpoint of the tab this call may use. */
  endpoint: string;
  release: () => void;
};

export class NoTabsConfiguredError extends Error {
  constructor(label: string) {
    super(`No browser is configured for ${label}`);
    this.name = 'NoTabsConfiguredError';
  }
}

export class TabWaitTimeoutError extends Error {
  constructor(label: string, waitedMs: number, tabs: number) {
    super(
      `No ${label} tab became free within ${Math.round(waitedMs)}ms (${tabs} tab(s) in the pool)`
    );
    this.name = 'TabWaitTimeoutError';
  }
}

export class TabWaitAbortedError extends Error {
  constructor() {
    super('The request was cancelled while waiting for a chat tab');
    this.name = 'TabWaitAbortedError';
  }
}

type Waiter = {
  resolve: (endpoint: string) => void;
  reject: (error: Error) => void;
  settled: boolean;
};

/**
 * Every browser currently leased, across ALL pools.
 *
 * A pool on its own guarantees one call per tab within one site. That is not
 * quite the guarantee that matters, because the thing being protected is the
 * BROWSER, and two sites can be pointed at the same one: `AI_WEB_CDP_URL` gives
 * both of them that single endpoint, and then Claude free and ChatGPT free hold
 * it at the same time. Two turns then drive two tabs in one window, each
 * bringing its own tab to the front, and whichever loses is a background tab -
 * frozen, answering no DOM read at all, which is the failure this whole
 * arrangement exists to avoid.
 *
 * So exclusivity is process-wide and keyed on the endpoint rather than on the
 * pool. The saved endpoint list already forbids one port serving two sites;
 * this covers the configuration that can still express it, and any future one.
 */
const leasedEndpoints = new Set<string>();

export class TabPool {
  private endpoints: string[] = [];
  private readonly busy = new Set<string>();
  /** Strictly FIFO. Index 0 is the next call to be served. */
  private readonly waiters: Waiter[] = [];
  /**
   * Browsers that could not be reached, and when to try them again.
   *
   * A configured browser is not necessarily a running one: the defaults name
   * ports nobody has started yet, and an operator can close a window in the
   * middle of a run. Handing a dead one to every second call would fail half
   * the requests for a reason that has nothing to do with them.
   *
   * Set aside rather than dropped, and only for a while, because "unreachable"
   * is a statement about a moment - the operator is quite likely starting that
   * browser right now.
   */
  private readonly downUntil = new Map<string, number>();

  constructor(
    private readonly label: string,
    private readonly now: () => number = Date.now
  ) {}

  get size(): number {
    return this.endpoints.length;
  }

  get inUse(): number {
    return this.busy.size;
  }

  get queued(): number {
    return this.waiters.length;
  }

  get configured(): string[] {
    return [...this.endpoints];
  }

  /**
   * Points the pool at a new set of browsers.
   *
   * A tab that is REMOVED while a call is using it stays busy until that call
   * lets go; it simply stops being handed out afterwards. Dropping it now would
   * mean a second call could be given the same tab a moment later, which is the
   * one thing this pool exists to prevent.
   *
   * A tab that is ADDED wakes the line immediately - the point of adding a
   * browser is that the calls already waiting get served sooner.
   */
  setEndpoints(next: string[]): void {
    const seen = new Set<string>();
    this.endpoints = next.filter((endpoint) => {
      if (!endpoint || seen.has(endpoint)) return false;
      seen.add(endpoint);
      return true;
    });
    this.pump();
  }

  /**
   * Marks a browser unreachable for a while.
   *
   * Called by the adapter when a turn could not connect at all - not when the
   * page misbehaved, which is a different thing and says nothing about whether
   * the browser is there.
   */
  markUnreachable(endpoint: string, forMs: number): void {
    this.downUntil.set(endpoint, this.now() + forMs);
  }

  markReachable(endpoint: string): void {
    this.downUntil.delete(endpoint);
  }

  private isDown(endpoint: string): boolean {
    const until = this.downUntil.get(endpoint);
    if (typeof until !== 'number') return false;
    if (this.now() >= until) {
      this.downUntil.delete(endpoint);
      return false;
    }
    return true;
  }

  private available(endpoint: string): boolean {
    return !this.busy.has(endpoint) && !leasedEndpoints.has(endpoint);
  }

  private freeEndpoint(): string | null {
    for (const endpoint of this.endpoints) {
      if (this.available(endpoint) && !this.isDown(endpoint)) return endpoint;
    }

    // Nothing reachable is free. Whether to hand out a browser known to be down
    // turns on WHY nothing reachable is free, and getting that backwards is a
    // bug I put here and had to be shown: falling back whenever no reachable
    // browser is FREE means a caller retrying past a dead browser is handed the
    // same dead browser again the moment the healthy ones are merely busy - it
    // never waits for one, and the retry cannot work.
    //
    // So: if any endpoint is reachable at all, busy or not, return null and let
    // the caller queue for it. Only when EVERY browser is down is one handed
    // out anyway, because at that point trying and reporting what went wrong
    // beats waiting on the strength of a stale observation.
    const anyReachable = this.endpoints.some((endpoint) => !this.isDown(endpoint));
    if (anyReachable) return null;

    for (const endpoint of this.endpoints) {
      if (this.available(endpoint)) return endpoint;
    }
    return null;
  }

  /** Wakes this pool's line for a browser another pool has just let go of. */
  pumpShared(endpoint: string): void {
    if (!this.endpoints.includes(endpoint)) return;
    this.pump();
  }

  /** Hands free tabs to the head of the line, in order, until one runs out. */
  private pump(): void {
    while (this.waiters.length > 0) {
      const endpoint = this.freeEndpoint();
      if (!endpoint) return;
      const waiter = this.waiters.shift();
      if (!waiter || waiter.settled) continue;
      waiter.settled = true;
      this.busy.add(endpoint);
      leasedEndpoints.add(endpoint);
      waiter.resolve(endpoint);
    }
  }

  async acquire(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<TabLease> {
    if (options.signal?.aborted) throw new TabWaitAbortedError();
    if (this.endpoints.length === 0) throw new NoTabsConfiguredError(this.label);

    const ready = this.waiters.length === 0 ? this.freeEndpoint() : null;
    if (ready) {
      this.busy.add(ready);
      leasedEndpoints.add(ready);
      return this.lease(ready);
    }

    const endpoint = await new Promise<string>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, settled: false };
      this.waiters.push(waiter);

      const settle = (run: () => void): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        cleanup();
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        run();
      };

      let timer: NodeJS.Timeout | undefined;
      const onAbort = (): void => settle(() => reject(new TabWaitAbortedError()));
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };

      if (typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)) {
        // Deliberately not unref'd: a caller waiting for a tab is real work,
        // and an unref'd timer lets the event loop drain first so the wait
        // never settles at all.
        timer = setTimeout(
          () =>
            settle(() =>
              reject(new TabWaitTimeoutError(this.label, options.timeoutMs ?? 0, this.endpoints.length))
            ),
          Math.max(0, options.timeoutMs)
        );
      }

      options.signal?.addEventListener('abort', onAbort, { once: true });

      // `pump` resolves through this, so the cleanup above runs on the happy
      // path too - otherwise a served call leaves its abort listener attached
      // to a signal that outlives it.
      waiter.resolve = (granted: string) => {
        cleanup();
        resolve(granted);
      };
    });

    return this.lease(endpoint);
  }

  private lease(endpoint: string): TabLease {
    let released = false;
    return {
      endpoint,
      release: () => {
        if (released) return;
        released = true;
        this.busy.delete(endpoint);
        leasedEndpoints.delete(endpoint);
        this.pump();
        // The browser may belong to another site's pool too - see
        // `leasedEndpoints` - and that pool has its own line waiting on it.
        for (const other of pools.values()) {
          if (other !== this) other.pumpShared(endpoint);
        }
      },
    };
  }
}

const pools = new Map<string, TabPool>();

export function getTabPool(siteId: string, label: string): TabPool {
  const existing = pools.get(siteId);
  if (existing) return existing;
  const created = new TabPool(label);
  pools.set(siteId, created);
  return created;
}

export function getTabPoolStats(): Record<
  string,
  { tabs: number; inUse: number; queued: number; endpoints: string[] }
> {
  const stats: Record<string, { tabs: number; inUse: number; queued: number; endpoints: string[] }> =
    {};
  for (const [siteId, pool] of pools) {
    stats[siteId] = {
      tabs: pool.size,
      inUse: pool.inUse,
      queued: pool.queued,
      endpoints: pool.configured,
    };
  }
  return stats;
}

export function resetTabPoolsForTests(): void {
  pools.clear();
  leasedEndpoints.clear();
}
