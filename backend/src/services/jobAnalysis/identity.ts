import { createHash } from 'crypto';

/**
 * What makes two postings the same posting, for the one-analysis rule.
 *
 * Two keys, and a posting matches a stored analysis on EITHER (PLAN check 1):
 *
 *  - its job LINK, normalised (`linkKey`) - so the same job pasted from two
 *    sheets, or re-pasted after somebody tidied its text, is still one
 *    posting when its link says so;
 *  - its job description TEXT with whitespace normalised (`contentHash`) - so
 *    a posting with no link at all, the manual builder's commonest case, is
 *    still recognised by its words.
 *
 * Neither key mentions a model, a prompt, a profile or an account: the
 * analysis is a reading of the posting, and the posting is all that decides
 * whether it has been read.
 */

/** Whitespace runs become one space, and the ends are trimmed. Nothing else changes. */
export function normalizeJobDescriptionText(jobDescription: string): string {
  return jobDescription.replace(/\s+/g, ' ').trim();
}

/** SHA-256, hex, of the whitespace-normalised text: 64 characters. */
export function contentHash(jobDescription: string): string {
  return createHash('sha256').update(normalizeJobDescriptionText(jobDescription), 'utf8').digest('hex');
}

/**
 * Query parameters that say how somebody ARRIVED at a posting, not which
 * posting it is - compared lower-case. A board's own job key (`gh_jid`,
 * Indeed's `vjk`, `jobId`...) is not among them and is kept.
 */
const TRACKING_PARAMETERS = new Set([
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
  'yclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
  '_hsenc',
  '_hsmi',
  'ref',
  'ref_src',
  'refid',
  'referrer',
  'trk',
  'trackingid',
  'gh_src',
  'lever-source',
  'lever-origin',
]);

function isTrackingParameter(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_PARAMETERS.has(lower);
}

/**
 * A job link as an identity: the same posting reached two ways gives the same
 * key, or null for anything that is not an http(s) URL.
 *
 *  - the host lower-case (URL does that) and a default port dropped;
 *  - http and https folded together - the scheme says how the page was
 *    fetched, not which job it is;
 *  - the #fragment gone;
 *  - tracking parameters gone (`utm_*`, `gclid`, `fbclid`, `ref`...), and what
 *    is left sorted, so the order a share button wrote them in does not matter;
 *  - one trailing slash folded (`/jobs/42/` is `/jobs/42`).
 *
 * The PATH keeps its case: plenty of boards put a case-sensitive id in it.
 */
export function linkKey(link: unknown): string | null {
  if (typeof link !== 'string') return null;
  const trimmed = link.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;

  const kept = [...url.searchParams.entries()]
    .filter(([name]) => !isTrackingParameter(name))
    .sort(([a, aValue], [b, bValue]) => (a === b ? aValue.localeCompare(bValue) : a.localeCompare(b)));
  const search = kept.length > 0 ? `?${new URLSearchParams(kept).toString()}` : '';

  let pathname = url.pathname || '/';
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  const port = url.port && !(url.port === '80' || url.port === '443') ? `:${url.port}` : '';

  return `https://${url.hostname}${port}${pathname}${search}`;
}

/** The two keys a posting is known by: either may be missing (no text, or no usable link). */
export type PostingKeys = { hash: string | null; link: string | null };

/** A posting's keys from its text and its link, as the gate computes them. */
export function postingKeysOf(input: { jd?: unknown; link?: unknown }): PostingKeys {
  const text = typeof input.jd === 'string' ? normalizeJobDescriptionText(input.jd) : '';
  return { hash: text ? contentHash(text) : null, link: linkKey(input.link) };
}

/** Two postings are one when they share a link key or a text hash - either, as the store's lookups match. */
export function samePosting(a: Partial<PostingKeys>, b: Partial<PostingKeys>): boolean {
  return Boolean((a.link && a.link === b.link) || (a.hash && a.hash === b.hash));
}
