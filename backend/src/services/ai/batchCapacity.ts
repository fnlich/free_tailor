import type { AIProvider } from '../../types/template';
import { geminiCliConcurrency } from './providers/geminiCli/options';

/**
 * How many items of a batch may be in flight at once.
 *
 * The number is a property of the CHOSEN PROVIDER, not of the batch, and that
 * is the whole of this module. Each subscription seat spawns a process per call
 * behind a semaphore of its own - `AI_CLI_CONCURRENCY` for Claude,
 * `AI_CODEX_CONCURRENCY` for Codex, `AI_GEMINI_CONCURRENCY` for Gemini - so a
 * fixed fan-out is wrong for some of them whenever they are sized differently,
 * as they are by default: above a seat's ceiling the extra items
 * only wait in a queue nobody can see, and below it the seat sits partly idle.
 * Both look like the app being slow and neither is visible from the page.
 *
 * The queues themselves already exist and are not this module's business: each
 * seat's semaphore hands a free process slot to the head of its line as one is
 * released. This only decides how much work to offer them, and offering exactly
 * their capacity is what keeps every slot busy without piling up that queue.
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

/** Mirrors `AI_CLI_CONCURRENCY` in claudeCli/options, bounds included. */
export function cliConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.AI_CLI_CONCURRENCY || '', 10);
  if (!Number.isInteger(raw)) return 4;
  return Math.min(32, Math.max(1, raw));
}

/**
 * Mirrors `AI_CODEX_CONCURRENCY` in codexCli/options, bounds included.
 *
 * A SECOND reader, not a shared one, because the two seats are sized separately
 * and conflating them is the bug this exists to prevent: Codex used to fall
 * through to the catch-all default below, which was right only by the
 * coincidence that both defaults are 4.
 */
export function codexConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.AI_CODEX_CONCURRENCY || '', 10);
  if (!Number.isInteger(raw)) return 4;
  return Math.min(32, Math.max(1, raw));
}

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
  choice: { provider: AIProvider },
  env: NodeJS.ProcessEnv = process.env
): Promise<BatchCapacity> {
  const override = configuredOverride(env);
  if (override !== null) {
    return { limit: override, reason: `AI_BATCH_CONCURRENCY=${override}` };
  }

  if (choice.provider === 'claude-cli') {
    // The same variable and the same default the CLI provider's own semaphore
    // is built from, read here rather than imported because that reader takes
    // no environment and these have to be testable. `batchCapacity.test.js`
    // pins the two to the same answer.
    const limit = cliConcurrency(env);
    return { limit, reason: `${limit} Claude CLI slot${limit === 1 ? '' : 's'}` };
  }

  if (choice.provider === 'codex-cli') {
    // Its own variable, for the same reason. Falling through to the default
    // below offered 4 into a semaphore that might hold 1 or 12 - an invisible
    // queue in one direction and an idle seat in the other.
    const limit = codexConcurrency(env);
    return { limit, reason: `${limit} Codex CLI slot${limit === 1 ? '' : 's'}` };
  }

  if (choice.provider === 'gemini-cli') {
    // Imported rather than mirrored: the Gemini seat's reader is a leaf that
    // takes an environment, so the lane, this and the semaphore all ask the
    // one function and cannot disagree about a value.
    const limit = geminiCliConcurrency(env);
    return { limit, reason: `${limit} Gemini CLI slot${limit === 1 ? '' : 's'}` };
  }

  return {
    limit: DEFAULT_BATCH_CONCURRENCY,
    reason: `${DEFAULT_BATCH_CONCURRENCY} by default for ${choice.provider}`,
  };
}
