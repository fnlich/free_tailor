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
 *   - the profile as the call sees it (`profileForTemplate`) - its whole
 *     content minus the two timestamps a save moves without changing a word,
 *     minus its settings and minus its section order (`profileFingerprint`) -
 *     so one character changed anywhere is another key. The settings and the
 *     order are not what a model is told: the layout, the Soft Skills switch
 *     and the order the sections print in decide how the answer is DRAWN,
 *     which the parse and the render work out again on a hit; the Strengths
 *     switch decides whether the profile's strengths are in `profileJson`,
 *     which the values below carry; the prompt and the model a profile chose
 *     are keyed on their own - and so is its tailoring mode, with no field of
 *     its own: Partial and Fully tailor run different prompts (`tailor-resume`
 *     or its variant, `tailor-resume-full`) with a different `profileJson`, so
 *     switching a profile's mode is a miss, and switching it back a hit;
 *   - the template it is drawn with;
 *   - the posting's stored analysis (`job_analyses.id`, which is never
 *     rewritten - services/jobAnalysis/gate.ts);
 *   - the model record's id AND the model name it runs (a record re-pointed at
 *     another model is another key), and the provider type;
 *   - the prompt's text, hashed - an administrator's edit is a miss;
 *   - the values the prompt is rendered with and any text appended to its
 *     user turn, hashed as the call would send them - so whatever code builds
 *     them changing what a posting is asked (its lists, the concept-tools
 *     table, the heading drawn for the soft-skill group) is a miss with no
 *     version bump. They are built from the analysis alone, never the skill
 *     library, so a skill an administrator adds or anybody confirms changes
 *     no resume's key;
 *   - `extra`: for a resume, what its revise pass was made of - the revise
 *     prompt's id and text (hashed), the wording of the figures note the code writes into
 *     it, and the TAILOR_REVISE_PASS / TAILOR_REVISE_MAX_TERMS settings - and
 *     for a cover letter, the company and the role it is addressed to;
 *   - and `TAILOR_CACHE_VERSION`, bumped when the code around the prompt
 *     changes what an answer means.
 *
 * What is stored for a resume is the resume as the model wrote it: the
 * tailoring call's answer, or - when the revise pass changed it - the draft
 * with the revised summary and bullets folded in. So a hit makes no tailoring
 * call AND no revise call. Every step after the answer - the parse, the
 * section switches, the skills - runs again on a hit, against the profile as
 * it is, exactly as on a fresh answer; it is idempotent on its own output. A
 * stored answer that no longer parses is a miss, never a failure. Only an
 * answer the asked-for model wrote is stored: one the seat says a FALLBACK
 * wrote (Claude's `--fallback-model`, Gemini switching Pro to Flash -
 * `CompletionResult.fellBack`), the tailoring's or its revision's, is used for
 * that build and asked again by the next, never kept as the asked-for model's
 * for TAILOR_CACHE_DAYS - and neither is a draft whose revise pass failed.
 *
 * Rows older than TAILOR_CACHE_DAYS (30 by default) are pruned at boot and
 * once a day. The cache never fails a resume: a read or a write that cannot
 * reach the table is a miss, said once in the log.
 */

/**
 * Bumped when what an answer means changes in code; every older row is then a
 * miss. A change to what the prompt is SENT needs no bump - the rendered
 * values are part of the key.
 *
 * 2: the model writes the skills block (`skillGroups`), the role facts come
 * from the profile, bullets are capped at eight, and a resume's stored answer
 * may be its revised one.
 */
export const TAILOR_CACHE_VERSION = 2;

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
 * `updatedAt`, which a save moves without changing what a model is told,
 * `profileSettings` - how the answer is drawn, which prompt and model run it,
 * and whether strengths are sent, each of which reaches the key another way
 * (see the module note) - and `sectionOrder`, which only says where each
 * section prints. A Grouped/Plain flip, a Soft Skills switch or a dragged
 * section is the same question: a hit, drawn the new way. The nine section
 * lists beyond the classic six are content, and a new entry is a new key,
 * though none of them is in `profileJson` yet.
 */
export function profileFingerprint(profile: Profile): string {
  // The section order goes with the settings: it only decides how the answer
  // is DRAWN (where each section prints), never what the model is asked, so
  // dragging a section is a hit, as flipping the layout is.
  const {
    createdAt: _created,
    updatedAt: _updated,
    profileSettings: _settings,
    sectionOrder: _order,
    ...content
  } = profile as Profile & {
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
   * and any text appended to its user turn. Most of what they say is in the
   * key already (the profile, the analysis); what is not is whatever code
   * builds them, which may change without anybody remembering
   * TAILOR_CACHE_VERSION.
   */
  promptValues: Record<string, string>;
  appendToUserBody?: string;
  /** What else the answer was made from: a resume's revise pass, a cover letter's company and role. */
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

