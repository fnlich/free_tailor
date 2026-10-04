/**
 * The jobs form's handling of the scraper settings the server serves.
 *
 * GET /jobs/scrapers/providers carries the deployment's SCRAPER_DEFAULT_LOCATION,
 * APIFY_RUN_TIMEOUT_S and, per provider, the most results one run returns (the
 * actor's own limit, or SCRAPER_MAX_RESULTS when lower). They are served rather
 * than compiled in as NEXT_PUBLIC_ values so the form shows what the server
 * will actually apply. Plain functions with no React in them, so the backend
 * suite can test them (backend/test/scraperForm.test.js).
 */

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
