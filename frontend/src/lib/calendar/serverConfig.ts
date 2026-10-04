import { envInt } from '@/lib/env';

/**
 * Settings for the calendar route handlers, read on the server only.
 *
 * Not NEXT_PUBLIC_: nothing in the browser needs them, so they are read from
 * the `next start` process at request time - which `scripts/next.mjs` fills
 * from the repository .env - and a change takes a restart, not a rebuild.
 * Read per call rather than once, so a test can hand in its own environment.
 *
 * Both bound how this server treats calendar.online, a third party whose
 * latency and rate limit an operator can see and this code cannot.
 */

type Env = Record<string, string | undefined>;

export const DEFAULT_CALENDAR_API_TIMEOUT_MS = 12_000;
export const DEFAULT_CALENDAR_DETAIL_CONCURRENCY = 12;

/**
 * How long one upstream calendar.online request may take.
 *
 * At least a second, because anything shorter fails every request on an
 * ordinary connection and reads as "the calendar is down". At most two
 * minutes, because the browser is waiting on the route handler the whole time
 * and the deep link scan makes one such request per event.
 */
export function calendarApiTimeoutMs(env: Env = process.env): number {
  return envInt(
    env.CALENDAR_API_TIMEOUT_MS,
    DEFAULT_CALENDAR_API_TIMEOUT_MS,
    1_000,
    120_000,
    'CALENDAR_API_TIMEOUT_MS'
  );
}

/**
 * How many event-detail requests the link scan keeps in flight at once.
 *
 * Lower it when calendar.online starts refusing requests from this server; one
 * is a strictly sequential scan. Capped at 32 so a typo cannot turn a month of
 * events into a burst of hundreds of simultaneous requests at someone else's API.
 */
export function calendarDetailConcurrency(env: Env = process.env): number {
  return envInt(
    env.CALENDAR_DETAIL_CONCURRENCY,
    DEFAULT_CALENDAR_DETAIL_CONCURRENCY,
    1,
    32,
    'CALENDAR_DETAIL_CONCURRENCY'
  );
}
