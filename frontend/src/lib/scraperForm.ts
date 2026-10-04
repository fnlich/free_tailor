import type { ScraperSettings, ScraperSourceProviderCatalog } from './api';

/**
 * The jobs form's handling of the scraper settings the server serves.
 *
 * GET /jobs/scrapers/settings carries the deployment's SCRAPER_DEFAULT_LOCATION
 * and APIFY_RUN_TIMEOUT_S, and GET /jobs/scrapers/providers, per provider, the
 * most results one run returns (the actor's own limit, or SCRAPER_MAX_RESULTS
 * when lower). They are served rather than compiled in as NEXT_PUBLIC_ values
 * so the form shows what the server will actually apply. Plain functions with
 * no React in them, so the backend suite can test them
 * (backend/test/scraperForm.test.js).
 */

/**
 * GET /jobs/scrapers/providers, as an array whatever the server sent.
 *
 * That endpoint has always answered a bare array, but the frontend and the
 * backend are restarted separately - `npm run dev:poll` reloads the backend on
 * a pull and keeps serving the built frontend - so for a while either can be
 * on another version than the other. One commit on this branch served
 * `{ sources: [...] }` instead, and the page iterating it crashed the whole
 * app. Anything unrecognised is no providers, which the page already shows as
 * an empty catalog rather than an exception.
 */
export function readScraperCatalog(body: unknown): ScraperSourceProviderCatalog[] {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { sources?: unknown }).sources)
      ? (body as { sources: unknown[] }).sources
      : [];
  return list.filter(
    (entry): entry is ScraperSourceProviderCatalog =>
      Boolean(entry) &&
      typeof (entry as ScraperSourceProviderCatalog).source === 'string' &&
      Array.isArray((entry as ScraperSourceProviderCatalog).providers)
  );
}

/**
 * GET /jobs/scrapers/settings, with anything missing or malformed as null.
 *
 * A backend that predates the endpoint answers 404 (the page catches that and
 * passes nothing here). Null leaves the location field empty - which the server
 * reads as its own default - and hides the timeout pill, rather than showing a
 * number nobody served.
 */
export function readScraperSettings(body: unknown): ScraperSettings {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const location = typeof record.defaultLocation === 'string' ? record.defaultLocation.trim() : '';
  const timeout = record.runTimeoutS;
  return {
    defaultLocation: location || null,
    runTimeoutS: typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? timeout : null,
  };
}

/** The counts the Results menu offers when nothing caps them. */
export const LIMIT_OPTIONS: readonly number[] = [25, 100, 250, 500, 1000];

/**
 * The cap that applies to the Results menu, or null for none.
 *
 * Only a provider that shows the menu has one. A start-URL provider (Indeed,
 * memo23) sends no count from the form, and Indeed is the page's initial
 * source: letting its cap of 100 through would lower the default count of 250
 * before any other source had been picked.
 */
export function resultCapFor(
  provider: { maxResults: number | null } | null | undefined,
  startUrlOnly: boolean
): number | null {
  return startUrlOnly ? null : (provider?.maxResults ?? null);
}

/**
 * The counts the Results menu offers under a cap.
 *
 * LIMIT_OPTIONS up to the cap, plus the cap itself when it falls between two of
 * them, so the most the server allows can always be asked for. null means no
 * cap and every count.
 */
export function limitOptionsFor(cap: number | null): number[] {
  if (cap === null) return [...LIMIT_OPTIONS];
  const options = LIMIT_OPTIONS.filter((value) => value <= cap);
  const largest = LIMIT_OPTIONS[LIMIT_OPTIONS.length - 1];
  return cap < largest && !options.includes(cap) ? [...options, cap] : options;
}

/** 300 -> "5-minute", 90 -> "90-second": the run timeout as the page header shows it. */
export function formatRunTimeout(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60}-minute` : `${seconds}-second`;
}
