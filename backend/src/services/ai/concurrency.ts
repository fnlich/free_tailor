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

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`AsyncSemaphore limit must be a positive integer, got ${limit}`);
    }
    this.available = limit;
  }

  get size(): number {
    return this.limit;
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
export function getProviderSemaphore(provider: AIProvider, limit: number): AsyncSemaphore {
  const existing = semaphores.get(provider);
  if (existing && existing.size === limit) {
    return existing;
  }
  const created = new AsyncSemaphore(limit);
  semaphores.set(provider, created);
  return created;
}

export function getSemaphoreStats(): Record<string, { limit: number; inFlight: number; queued: number }> {
  const stats: Record<string, { limit: number; inFlight: number; queued: number }> = {};
  for (const [provider, semaphore] of semaphores) {
    stats[provider] = {
      limit: semaphore.size,
      inFlight: semaphore.inFlight,
      queued: semaphore.queued,
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
