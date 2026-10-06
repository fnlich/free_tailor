import { AsyncLocalStorage } from 'async_hooks';

import type { ResolvedAIProvider } from '../../config/aiProviders';
import { isProviderLocked } from '../../config/providerCatalog';
import type { AIProvider } from '../../types/template';
import { getSemaphoreStats } from './concurrency';
import { providerReadiness, providersNow } from './registry';

/**
 * Which provider of a type a call runs on (owner decision P4).
 *
 * A model names a TYPE. Its calls are spread over every enabled provider of
 * that type that is signed in and not held, each through its own semaphore and
 * limit - so a second Claude account doubles what Claude models can do at once,
 * and one signed out or rate-limited stops taking work while the other goes on.
 *
 * Two ways a call gets its provider:
 *
 *   - A resume the queue runs is PINNED: the dispatcher already chose the
 *     provider whose lane slot the task holds (services/queue), and every call
 *     the task makes of that type - tailoring, the cover letter, an analysis on
 *     a model of the same type - goes there, so the lane's width and the
 *     provider's semaphore stay one number. Carried in AsyncLocalStorage rather
 *     than threaded through every service between the runner and the prompt
 *     executor.
 *   - Anything else (a preview, the analysis gate outside a task, the Bid
 *     Assistant, the extractors) is PICKED here, by the most free capacity:
 *     calls in flight plus calls waiting at the provider's semaphore, relative
 *     to its limit, ties to list order.
 *
 * With none of the type ready, the first enabled one is used anyway, and the
 * call meets its hold and fails with the hold's own error - which is what a
 * direct call did before there was more than one provider. The queue, which
 * can wait, waits instead.
 */

const pinned = new AsyncLocalStorage<string>();

/** Runs `work` with every call of the provider's type going to that provider. */
export function runPinnedToProvider<T>(providerId: string, work: () => Promise<T>): Promise<T> {
  return pinned.run(providerId, work);
}

/** The provider the current task is pinned to, if any. */
export function pinnedProviderId(): string | undefined {
  return pinned.getStore();
}

/**
 * Whether a provider can take work now: switched on, its type not locked, its
 * last health check not against it, and no hold on the whole seat - nor, for
 * a call on `modelName`, on that model ('' is the provider's default).
 */
export function isProviderReady(provider: ResolvedAIProvider, modelName?: string): boolean {
  if (!provider.enabled || isProviderLocked(provider.type)) return false;
  const readiness = providerReadiness(provider.id, modelName);
  return readiness.ready !== false && !readiness.held;
}

/** Calls in flight plus calls waiting, over the limit: what "most free capacity" compares. */
export function providerLoad(provider: ResolvedAIProvider): number {
  const stats = getSemaphoreStats()[provider.id];
  const limit = Math.max(1, provider.concurrency_max_requests);
  return stats ? (stats.inFlight + stats.queued) / limit : 0;
}

/**
 * The provider a call of `type` on `modelName` runs on ('' for the type's
 * default model; absent, only seat-wide holds are weighed), or null when the
 * type has none switched on (the caller's own "is this type enabled" check
 * refuses it first, by name).
 *
 * The pin is honoured whether or not its provider is still switched on. A
 * task keeps the lane slot it started in until it ends, and an administrator
 * switching a provider off lets what it is building "finish or fail as
 * today" - sending the task's next call to another provider instead put that
 * call on a semaphore whose lane never counted it, and left the order naming a
 * provider that did not build it. A provider REMOVED since is not in the list,
 * so its task's calls are picked afresh, the only place they can go.
 */
export function pickProvider(type: AIProvider, modelName?: string): ResolvedAIProvider | null {
  const ofType = providersNow().filter((entry) => entry.type === type);
  const pin = pinnedProviderId();
  const pinnedOne = pin ? ofType.find((entry) => entry.id === pin) : undefined;
  if (pinnedOne) return pinnedOne;

  const candidates = ofType.filter((entry) => entry.enabled);
  if (candidates.length === 0) return null;

  // Ready for THIS model: a provider under a weekly Opus cap fails every Opus
  // call at once, so it reads as the least loaded - and without the model
  // here every unpinned Opus call (a preview, an analysis) went to it.
  const ready = candidates.filter((entry) => isProviderReady(entry, modelName));
  if (ready.length === 0) return candidates[0];
  let best = ready[0];
  let bestLoad = providerLoad(best);
  for (const entry of ready.slice(1)) {
    const load = providerLoad(entry);
    if (load < bestLoad) {
      best = entry;
      bestLoad = load;
    }
  }
  return best;
}
