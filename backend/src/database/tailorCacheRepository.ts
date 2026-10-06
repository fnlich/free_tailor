import { getDb } from './sqlite';

/**
 * The tailoring cache's table (database/sqlite.ts `tailor_cache`), read and
 * written only through services/tailorCache.ts.
 *
 * The statements are exported so test/tailorCache.test.js can pin the lookup
 * to one seek on `idx_tailor_cache_key` with EXPLAIN QUERY PLAN: the table
 * grows with every distinct generation, and a lookup that turned into a scan
 * would make every tailoring call slower than the model call it saves.
 */

export const FIND_TAILOR_CACHE_SQL = 'SELECT content FROM tailor_cache WHERE cache_key = ?';

export const PRUNE_TAILOR_CACHE_SQL = 'DELETE FROM tailor_cache WHERE created_at < ?';

export type TailorCacheKind = 'resume' | 'cover-letter';

/** The stored answer under `cacheKey`, or null. */
export function findTailorCache(cacheKey: string): string | null {
  const row = getDb().prepare(FIND_TAILOR_CACHE_SQL).get(cacheKey) as { content: string } | undefined;
  return row ? row.content : null;
}

/**
 * Keeps an answer under its key. The FIRST answer stays: two generations of
 * the same thing that missed together both asked, and both answers are
 * equally good - rewriting the row would only churn it.
 */
export function storeTailorCache(entry: {
  cacheKey: string;
  kind: TailorCacheKind;
  content: string;
  modelId: string;
  analysisId: string | null;
  profileId: string | null;
  createdAt?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO tailor_cache (cache_key, kind, content, model_id, analysis_id, profile_id, created_at)
       VALUES (@cacheKey, @kind, @content, @modelId, @analysisId, @profileId, @createdAt)
       ON CONFLICT(cache_key) DO NOTHING`
    )
    .run({
      ...entry,
      createdAt: entry.createdAt ?? new Date().toISOString(),
    });
}

/** Drops every row made before `beforeIso`; how many went. */
export function pruneTailorCache(beforeIso: string): number {
  return getDb().prepare(PRUNE_TAILOR_CACHE_SQL).run(beforeIso).changes;
}

export function countTailorCacheRows(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM tailor_cache').get() as { n: number }).n;
}
