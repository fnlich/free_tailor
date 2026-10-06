import { currentProviders, providerTypeOf } from '../../config/aiProviders';
import { getProviderLabel } from '../../config/providerCatalog';
import { getDatabasePath } from '../../database/sqlite';
import type { AIProvider } from '../../types/template';

/**
 * How many items of a batch may be in flight at once.
 *
 * The number is a property of the CHOSEN TYPE'S PROVIDERS, not of the batch,
 * and that is the whole of this module. Each provider spawns a process per
 * call behind a semaphore of its own, sized by its `concurrency_max_requests`
 * (config/aiProviders.ts - for a built-in one, `AI_CLI_CONCURRENCY`,
 * `AI_CODEX_CONCURRENCY` or `AI_GEMINI_CONCURRENCY` unless an administrator
 * set one), and a model's calls are spread over every enabled provider of its
 * type (owner decision P4) - so the type can take the SUM of their limits.
 * Above that the extra items only wait in a queue nobody can see, and below
 * it a provider sits partly idle. Both look like the app being slow and
 * neither is visible from the page.
 *
 * The queues themselves already exist and are not this module's business: each
 * provider's semaphore hands a free process slot to the head of its line as one
 * is released. This only decides how much work to offer them.
 *
 * Read from the providers as the settings were last read (held in memory by
 * config/aiProviders.ts), never from the database itself: a settings read that
 * fails must not slow a batch, let alone fail one.
 */

/** An operator override. Set, it wins over everything worked out below. */
function configuredOverride(env: NodeJS.ProcessEnv): number | null {
  const raw = Number.parseInt(env.AI_BATCH_CONCURRENCY || '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

/**
 * Where the fan-out lands when nothing else can be worked out: a provider id
 * this build has no seat for - a retired one on a choice stored before the
 * upgrade, which the queue resolves again before it runs - gets the number
 * this app has always offered.
 */
const DEFAULT_BATCH_CONCURRENCY = 4;

/**
 * The built-in providers' `.env` readers, where they have always been
 * imported from. They live in config/aiProviders.ts now, beside the rest of
 * what decides a provider's limit.
 */
export { cliConcurrency, codexConcurrency } from '../../config/aiProviders';

const SLOT_NOUN: Record<AIProvider, string> = {
  'claude-cli': 'Claude CLI slot',
  'codex-cli': 'Codex CLI slot',
  'gemini-cli': 'Gemini CLI slot',
};

export type BatchCapacity = {
  /** How many batch items to run at once. */
  limit: number;
  /** Why, in one clause, for the line the route logs. */
  reason: string;
};

/**
 * The capacity for one resolved choice.
 *
 * Async although nothing in it waits any more: the five routes that call it
 * already await it, and a capacity that one day needs a settings read should
 * not have to change all of them to get one.
 */
export async function resolveBatchCapacity(
  choice: { provider: AIProvider | string },
  env: NodeJS.ProcessEnv = process.env
): Promise<BatchCapacity> {
  const override = configuredOverride(env);
  if (override !== null) {
    return { limit: override, reason: `AI_BATCH_CONCURRENCY=${override}` };
  }

  // A type id only: a retired id has no providers, and a provider id is not
  // what a choice names.
  const type = providerTypeOf(choice.provider);
  if (!type || type !== choice.provider) {
    return {
      limit: DEFAULT_BATCH_CONCURRENCY,
      reason: `${DEFAULT_BATCH_CONCURRENCY} by default for ${choice.provider}`,
    };
  }

  const providers = currentProviders(getDatabasePath(), env).filter((entry) => entry.type === type);
  const enabled = providers.filter((entry) => entry.enabled);
  // Every provider of the type switched off: nothing will run, and the
  // run is refused where it resolves a model. The built-in's width is a
  // number to offer meanwhile, not a promise.
  const counted = enabled.length > 0 ? enabled : providers.slice(0, 1);
  const limit = counted.reduce((total, entry) => total + entry.concurrency_max_requests, 0) || DEFAULT_BATCH_CONCURRENCY;
  const noun = SLOT_NOUN[type] ?? `${getProviderLabel(type)} slot`;
  return {
    limit,
    reason:
      `${limit} ${noun}${limit === 1 ? '' : 's'}` +
      (counted.length > 1 ? ` across ${counted.length} providers` : ''),
  };
}
