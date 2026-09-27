import type { Request } from 'express';

/**
 * Turning a query string into a page, safely.
 *
 * One function rather than the same four lines in every list route, because
 * the failure it prevents is silent in three different ways and every one of
 * them is a list that lies:
 *
 *  - a NEGATIVE offset reaches SQLite as `LIMIT ? OFFSET -1`, which is an
 *    error rather than a refusal - a 500 on a page somebody was reading;
 *  - a NaN offset (`?offset=abc`, or a page that built its URL from an
 *    undefined) silently becomes the first page again, so a "next" button
 *    would fetch the rows already on screen for ever;
 *  - an UNBOUNDED limit turns a paginated endpoint back into the unpaginated
 *    one it replaced, and the only sign is a slow page on the one account with
 *    the longest history.
 *
 * The ceiling is a ceiling, not a rejection: asking for more than the maximum
 * gets the maximum rather than a 400. A caller who asks for too much wanted a
 * list, and the list is what they get.
 */

export type Page = { limit: number; offset: number };

export function readPage(req: Request, fallbackLimit: number, maxLimit: number): Page {
  const askedLimit = Number.parseInt(String(req.query.limit ?? ''), 10);
  const askedOffset = Number.parseInt(String(req.query.offset ?? ''), 10);
  return {
    limit:
      Number.isFinite(askedLimit) && askedLimit > 0
        ? Math.min(askedLimit, maxLimit)
        : fallbackLimit,
    offset: Number.isFinite(askedOffset) && askedOffset > 0 ? askedOffset : 0,
  };
}
