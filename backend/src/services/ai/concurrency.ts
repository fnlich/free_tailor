import { getProviderLabel } from '../../config/providerCatalog';
import { AIProviderError } from './errors';
import type { AIProvider } from '../../types/template';
import type { Deadline } from './types';

/**
 * A counting semaphore whose waiters can be bounded and cancelled.
 *
 * The bound matters more than the count. The Claude CLI provider spawns one
 * process per call, and every batch endpoint in this app can ask for many
 * completions at once; without a shared limit, a 25-profile batch is 25
 * concurrent node processes. And the wait itself has to be bounded, because a
 * request queued behind others with no clock waits invisibly - the HTTP
 * request times out with nothing in the log to say why.
 */
export class AsyncSemaphore {
  private available: number;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    settled: boolean;
  }> = [];

  private peakInFlight = 0;

  /**
   * How long the line may get, as distinct from how many may run.
   *
   * The two are different questions and only one of them was being asked. A
   * provider that runs one call at a time still has to decide what happens to
   * the second, and "wait, for as long as your own deadline allows" is only the
   * right answer for a short line. Behind forty, it means forty HTTP requests
   * held open for minutes each, every one of them eventually failing on a clock
   * rather than on anything the caller can act on. `Infinity` keeps the old
   * behaviour for the lanes that want it - the CLI provider spawns processes
   * and its own limit already bounds the work.
   */
  private maxQueued: number;

  constructor(
    private readonly limit: number,
    maxQueued: number = Number.POSITIVE_INFINITY
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`AsyncSemaphore limit must be a positive integer, got ${limit}`);
    }
    this.maxQueued = normalizeMaxQueued(maxQueued);
    this.available = limit;
  }

  get size(): number {
    return this.limit;
  }

  get queueLimit(): number {
    return this.maxQueued;
  }

  /**
   * Changes the bound on a semaphore that is already in use.
   *
   * Needed because this is an admin setting: the lane is created at first call
   * and lives for the process, so a saved change has to reach the object rather
   * than a replacement for it - replacing it would strand every caller already
   * holding or waiting on the old one. Lowering it never evicts a waiter that
   * is already in line; it only refuses the next arrival.
   */
  setMaxQueued(maxQueued: number): void {
    this.maxQueued = normalizeMaxQueued(maxQueued);
  }

  get inFlight(): number {
    return this.limit - this.available;
  }

  get queued(): number {
    return this.waiters.length;
  }

  get peak(): number {
    return this.peakInFlight;
  }

  async acquire(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<() => void> {
    if (options.signal?.aborted) {
      throw new SemaphoreAbortedError();
    }

    if (this.available > 0) {
      this.take();
      return this.makeRelease();
    }

    // Refused before joining, not after waiting. A caller told immediately that
    // the line is full can do something else; the same caller told after ten
    // minutes of holding an HTTP request open has learned the same fact at a
    // much higher price.
    if (this.waiters.length >= this.maxQueued) {
      throw new SemaphoreQueueFullError(this.maxQueued, this.limit);
    }

    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject, settled: false };
      this.waiters.push(waiter);

      const settle = (fn: () => void): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        cleanup();
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        fn();
      };

      let timer: NodeJS.Timeout | undefined;
      const onAbort = (): void => settle(() => reject(new SemaphoreAbortedError()));

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };

      if (typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)) {
        // Deliberately NOT unref'd. A caller awaiting a bounded slot wait is
        // real work; an unref'd timer lets the event loop drain first and the
        // wait then never settles at all.
        timer = setTimeout(
          () => settle(() => reject(new SemaphoreTimeoutError(this.limit, options.timeoutMs ?? 0))),
          Math.max(0, options.timeoutMs)
        );
      }

      options.signal?.addEventListener('abort', onAbort, { once: true });

      waiter.resolve = () => settle(resolve);
    });

    return this.makeRelease();
  }

  private take(): void {
    this.available -= 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        // Hand the slot straight to the next waiter; `available` never rises,
        // so a burst of releases cannot let more than `limit` run at once.
        this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
        next.resolve();
        return;
      }
      this.available += 1;
    };
  }

  resetPeak(): void {
    this.peakInFlight = this.inFlight;
  }
}

function normalizeMaxQueued(value: number): number {
  if (value === Number.POSITIVE_INFINITY) return value;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`AsyncSemaphore maxQueued must be a non-negative integer, got ${value}`);
  }
  return value;
}

export class SemaphoreQueueFullError extends Error {
  readonly maxQueued: number;

  constructor(maxQueued: number, limit: number) {
    super(
      `The queue for this provider is full: ${maxQueued} request(s) already waiting behind ` +
        `${limit} running`
    );
    this.name = 'SemaphoreQueueFullError';
    this.maxQueued = maxQueued;
  }
}

export class SemaphoreTimeoutError extends Error {
  constructor(limit: number, timeoutMs: number) {
    super(`No AI slot became free within ${Math.round(timeoutMs)}ms (${limit} allowed at once)`);
    this.name = 'SemaphoreTimeoutError';
  }
}

export class SemaphoreAbortedError extends Error {
  constructor() {
    super('The request was cancelled while waiting for an AI slot');
    this.name = 'SemaphoreAbortedError';
  }
}

const semaphores = new Map<string, AsyncSemaphore>();

/**
 * One semaphore per provider, shared process-wide.
 *
 * Process-wide is the point: two simultaneous batch requests each politely
 * limiting themselves to four would still spawn eight processes against one
 * subscription seat.
 */
/**
 * The semaphore for a lane, created once and then reused.
 *
 * The key is a plain string rather than a provider id because a lane is not
 * always one provider: the two browser-chat providers drive the same Chrome
 * window and take the foreground from each other, so they share a single lane
 * keyed on the debug endpoint. What the key has to identify is the RESOURCE
 * that only one call may hold.
 */
export function getProviderSemaphore(
  provider: string,
  limit: number,
  maxQueued: number = Number.POSITIVE_INFINITY
): AsyncSemaphore {
  const existing = semaphores.get(provider);
  if (existing && existing.size === limit) {
    // Updated in place rather than replaced. The bound is an admin setting and
    // can change between calls; a replacement would leave every caller already
    // holding or waiting on the old object outside the new limit entirely.
    existing.setMaxQueued(maxQueued);
    return existing;
  }
  const created = new AsyncSemaphore(limit, maxQueued);
  semaphores.set(provider, created);
  return created;
}

export function getSemaphoreStats(): Record<
  string,
  { limit: number; inFlight: number; queued: number; queueLimit: number }
> {
  const stats: Record<
    string,
    { limit: number; inFlight: number; queued: number; queueLimit: number }
  > = {};
  for (const [provider, semaphore] of semaphores) {
    stats[provider] = {
      limit: semaphore.size,
      inFlight: semaphore.inFlight,
      queued: semaphore.queued,
      queueLimit: semaphore.queueLimit,
    };
  }
  return stats;
}

export function resetSemaphoresForTests(): void {
  semaphores.clear();
}

/**
 * Acquires a slot inside a deadline, translating both failure modes into the
 * shared error type so a route does not have to know a semaphore exists.
 */
export async function acquireSlot(
  semaphore: AsyncSemaphore,
  provider: AIProvider,
  deadline: Deadline,
  maxWaitMs: number,
  signal?: AbortSignal
): Promise<() => void> {
  const timeoutMs = Math.min(deadline.remainingMs(), maxWaitMs);
  try {
    return await semaphore.acquire({ timeoutMs, signal });
  } catch (error) {
    if (error instanceof SemaphoreQueueFullError) {
      throw new AIProviderError({
        provider,
        kind: 'rateLimited',
        detail: error.message,
        userMessage:
          `Too many requests are already waiting for ${getProviderLabel(provider)}. ` +
          'Try again once the queue clears, or raise the queue limit under Admin -> Settings.',
      });
    }
    if (error instanceof SemaphoreTimeoutError) {
      throw new AIProviderError({
        provider,
        kind: 'unavailable',
        detail: error.message,
        userMessage:
          'The server is busy running other AI requests. Please try again in a moment.',
      });
    }
    throw new AIProviderError({
      provider,
      kind: 'timeout',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

export type ConcurrentMapResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

/**
 * Runs `worker` over `items` with at most `limit` in flight, preserving input
 * order in the result and collecting per-item failures instead of aborting the
 * whole batch - which is what the sequential `for ... await` loops it replaces
 * already did, minus the waiting.
 */
export async function mapWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  worker: (item: TItem, index: number) => Promise<TResult>
): Promise<Array<ConcurrentMapResult<TResult>>> {
  const results = new Array<ConcurrentMapResult<TResult>>(items.length);
  if (items.length === 0) {
    return results;
  }

  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let cursor = 0;

  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });

  await Promise.all(runners);
  return results;
}
