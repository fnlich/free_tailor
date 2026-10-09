import { createHash } from 'crypto';

import { tailorCacheDays } from '../config/operational';
import {
  findTailorCache,
  pruneTailorCache,
  storeTailorCache,
  type TailorCacheKind,
} from '../database/tailorCacheRepository';
import type { Profile } from '../types/profile';

/**
 * Tailored content, kept and reused (owner decision P6).
 *
 * Generating again for the same unchanged profile, posting and model asks the
 * model the same question, and its answer costs a seat's time and quota. So
 * the answer to a tailoring call - and, separately, to a cover-letter call - is
 * stored under a key made of EVERYTHING it was made from, and a later call
 * with the same key reads it back instead of asking (resumeService's
 * `tailorResume` and `generateCoverLetter`, before their model call).
 *
 * What is NOT different on a hit: the price. A resume built from a cached
 * tailoring is charged exactly as one built fresh - the charge is decided at
 * submission by the model, never by whether a model call happened.
 *
 * The key (`tailorCacheKey`) is the SHA-256 of:
 *
 *   - the profile as the call sees it - its whole content, its section
 *     switches and skills layout as its template allows them
 *     (`profileForTemplate`), minus the two timestamps a save moves without
 *     changing a word - so one character changed anywhere is another key;
 *   - the template it is drawn with;
 *   - the posting's stored analysis (`job_analyses.id`, which is never
 *     rewritten - services/jobAnalysis/gate.ts);
 *   - the model record's id AND the model name it runs (a record re-pointed at
 *     another model is another key), and the provider type;
 *   - the prompt's text, hashed - an administrator's edit is a miss;
 *   - the values the prompt is rendered with and the text appended to its
 *     user turn, hashed as the call would send them - which is what carries
 *     the shared skill library: the posting's skills are matched against it,
 *     so a skill an administrator adds, or anybody confirms, that changes
 *     this posting's checklist is a miss (one that changes nothing for it is
 *     still a hit);
 *   - for a cover letter, the company and the role it is addressed to;
 *   - and `TAILOR_CACHE_VERSION`, bumped when the code around the prompt
 *     changes what an answer means.
 *
 * What is stored is the model's ANSWER, as it came; every step after it - the
 * parse, the section switches, the skills - runs again on a hit, against the
 * profile as it is, exactly as on a fresh answer. A stored answer that no
 * longer parses is a miss, never a failure. Only an answer the asked-for
 * model wrote is stored: one the seat says a FALLBACK wrote (Claude's
 * `--fallback-model`, Gemini switching Pro to Flash - `CompletionResult.
 * fellBack`) is used for that build and asked again by the next, never kept
 * as the asked-for model's for TAILOR_CACHE_DAYS.
 *
 * Rows older than TAILOR_CACHE_DAYS (30 by default) are pruned at boot and
 * once a day. The cache never fails a resume: a read or a write that cannot
 * reach the table is a miss, said once in the log.
 */

/**
 * Bumped when what an answer means changes in code; every older row is then a
 * miss. A change to what the prompt is SENT needs no bump - the rendered
 * values are part of the key.
 */
export const TAILOR_CACHE_VERSION = 1;

/** What a caller knows about the generation beyond the profile and the model. */
export type TailorCacheContext = {
  /** The posting's stored analysis; no cache without one for a tailoring. */
  analysisId: string | null;
  /** The template the resume is drawn with. */
  templateId: string | null;
};

/** JSON with every object's keys sorted, so the same value always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(',')}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The profile's part of a key: everything in it but `createdAt` and
 * `updatedAt`, which a save moves without changing what a model is told.
 */
export function profileFingerprint(profile: Profile): string {
  const { createdAt: _created, updatedAt: _updated, ...content } = profile as Profile & {
    createdAt?: unknown;
    updatedAt?: unknown;
  };
  return sha256(canonicalJson(content));
}

export function tailorCacheKey(input: {
  kind: TailorCacheKind;
  profile: Profile;
  context: TailorCacheContext;
  choice: { provider: string; modelId: string; modelName: string };
  promptId: string;
  promptText: string;
  /**
   * The values the prompt is rendered with, as the call is about to send them,
   * and the text appended to its user turn. Most of what they say is in the
   * key already (the profile, the analysis); what is not is the shared skill
   * library they are matched against - a skill added or confirmed since makes
   * the checklist the model writes to another one - and whatever code builds
   * them, which may change without anybody remembering TAILOR_CACHE_VERSION.
   */
  promptValues: Record<string, string>;
  appendToUserBody?: string;
  /** What else the answer was made from: a cover letter's company and role. */
  extra?: Record<string, string>;
}): string {
  return sha256(
    canonicalJson({
      v: TAILOR_CACHE_VERSION,
      kind: input.kind,
      profile: profileFingerprint(input.profile),
      template: input.context.templateId ?? '',
      analysis: input.context.analysisId ?? '',
      provider: input.choice.provider,
      modelId: input.choice.modelId,
      modelName: input.choice.modelName,
      promptId: input.promptId,
      prompt: sha256(input.promptText),
      inputs: sha256(canonicalJson({ values: input.promptValues, appended: input.appendToUserBody ?? '' })),
      extra: input.extra ?? {},
    })
  );
}

let warnedUnavailable = false;
function warnUnavailable(error: unknown): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  console.warn(
    '[tailor-cache] The tailoring cache could not be read or written; every tailoring asks the model ' +
      'until it can. ' + (error instanceof Error ? error.message : String(error))
  );
}

/** The stored answer under `key`, or null - a cache that cannot be read is a miss. */
export function readTailorCache(key: string): string | null {
  try {
    return findTailorCache(key);
  } catch (error) {
    warnUnavailable(error);
    return null;
  }
}

/** Keeps an answer. Never throws: a resume is never failed by its cache. */
export function writeTailorCache(entry: {
  key: string;
  kind: TailorCacheKind;
  content: string;
  modelId: string;
  analysisId: string | null;
  profileId: string | null;
}): void {
  try {
    storeTailorCache({
      cacheKey: entry.key,
      kind: entry.kind,
      content: entry.content,
      modelId: entry.modelId,
      analysisId: entry.analysisId,
      profileId: entry.profileId,
    });
  } catch (error) {
    warnUnavailable(error);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Drops every row older than TAILOR_CACHE_DAYS; how many went. Never throws. */
export function pruneTailorCacheNow(now: number = Date.now(), env: NodeJS.ProcessEnv = process.env): number {
  try {
    const removed = pruneTailorCache(new Date(now - tailorCacheDays(env) * DAY_MS).toISOString());
    if (removed > 0) {
      console.log(`[tailor-cache] Pruned ${removed} tailored answer(s) older than ${tailorCacheDays(env)} day(s).`);
    }
    return removed;
  } catch (error) {
    warnUnavailable(error);
    return 0;
  }
}

let pruneTimer: NodeJS.Timeout | null = null;

/**
 * Prunes now and once a day after. Started from index.ts rather than when this
 * module loads, so no test that merely imports it prunes a temp database under
 * another test's feet; the interval is unref'd and never holds the process.
 */
export function startTailorCachePrune(): void {
  pruneTailorCacheNow();
  if (pruneTimer) return;
  pruneTimer = setInterval(() => pruneTailorCacheNow(), DAY_MS);
  pruneTimer.unref?.();
}

