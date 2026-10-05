import { createHash } from 'crypto';

/**
 * Answers for job descriptions this server has already analysed.
 *
 * The cheapest token is the one never sent, and this app re-sends the same job
 * description constantly: a sheet import re-run after fixing one row, a batch
 * regenerated against a different template, a preview followed by the generate
 * that produces the file. Each of those was a fresh analysis of text that had
 * not changed, and on a subscription seat each one is also a whole turn of
 * that seat's usage allowance, spent to get back an answer already in hand.
 *
 * Safe to cache because the call is deterministic by construction: the analysis
 * runs at `temperature: 0` with a fixed prompt, so the same three inputs give
 * the same answer. Those three inputs are the key, and all three matter - a
 * different model or a prompt an admin has since edited must not be served an
 * answer produced by the old one.
 *
 * Nothing about the PROFILE is in the key, and that is deliberate too. The
 * analysis is a reading of the posting; the profile's choices - its Strengths
 * and Soft Skills switches, its grouped or plain skills - shape only the
 * tailoring call and the render that follow it. One analysis is shared by
 * every profile a posting is generated for (here, and in the queue's
 * in-flight map), and keying it on a switch would buy a second identical
 * answer for a seat turn. test/sectionSwitchesEndToEnd.test.js holds this.
 *
 * Deliberately in memory and not in the database. An analysis is derived data
 * that can always be recomputed, the cost of a miss is one call rather than a
 * wrong answer, and a cache on disk would need an invalidation story for every
 * prompt edit - which is exactly the bug this key avoids by including the
 * prompt's own text.
 */

/** How long an entry is served for. */
const TTL_MS = 6 * 60 * 60_000;

/**
 * How many answers are kept.
 *
 * A job analysis is a few kilobytes, so a hundred is a few hundred kilobytes -
 * small next to what it saves, and bounded so a long-running server that has
 * seen thousands of postings does not hold all of them.
 */
const MAX_ENTRIES = 100;

type Entry<T> = {
  value: T;
  expiresAt: number;
};

/**
 * Nothing stored here is ever handed out, and nothing handed in is ever kept.
 *
 * Both directions, and both are needed. Callers ANNOTATE an analysis -
 * `resumeBuildTiming` keys a WeakMap on the object - and a batch runs several
 * generations against one posting at a time, so two of them sharing an instance
 * would overwrite each other's state.
 *
 * Copying only on the way out is the subtle half and the one that was wrong
 * first: the caller that produced the value still held the instance that went
 * into the map, so editing its own result silently rewrote the cached answer
 * for everyone after it. Measured exactly that way - a title changed by the
 * first caller came back from the cache on the third.
 */
function detach<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const entries = new Map<string, Entry<unknown>>();

let hits = 0;
let misses = 0;

export type AnalysisCacheKey = {
  jobDescription: string;
  /** The prompt's rendered text, so an edited prompt is a different key. */
  promptText: string;
  /** Provider and model, so two models do not share one answer. */
  model: string;
};

export function analysisCacheKey(key: AnalysisCacheKey): string {
  // Hashed rather than concatenated: a job description is tens of thousands of
  // characters and this key is held for the life of the entry.
  return createHash('sha256')
    .update(key.model)
    .update('\0')
    .update(key.promptText)
    .update('\0')
    .update(key.jobDescription)
    .digest('hex');
}

export function readAnalysisCache<T>(key: string, now: () => number = Date.now): T | null {
  const entry = entries.get(key);
  if (!entry) {
    misses += 1;
    return null;
  }
  if (entry.expiresAt <= now()) {
    entries.delete(key);
    misses += 1;
    return null;
  }
  // Re-inserted so it counts as recently used: the eviction below takes the
  // oldest INSERTION, and a Map preserves that order.
  entries.delete(key);
  entries.set(key, entry);
  hits += 1;
  return detach(entry.value as T);
}

export function writeAnalysisCache<T>(key: string, value: T, now: () => number = Date.now): void {
  entries.delete(key);
  entries.set(key, { value: detach(value), expiresAt: now() + TTL_MS });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

export function analysisCacheStats(): { entries: number; hits: number; misses: number } {
  return { entries: entries.size, hits, misses };
}

export function resetAnalysisCacheForTests(): void {
  entries.clear();
  hits = 0;
  misses = 0;
}
