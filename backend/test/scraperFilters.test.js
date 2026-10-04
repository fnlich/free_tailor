const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildIndeedSearchUrl,
  isBroadSoftwareRoleSearch,
  mapFiltersForIndeed,
  mapFiltersForJobBoard,
  mapFiltersForWellfound,
  mapFiltersForHiringCafe,
  mapFiltersForHiringCafeCrawlerbros,
  mapFiltersForHiringCafeMemo23,
} = require('../scrapers/filters');
const { resolveScraperRunSettings } = require('../dist/services/scraperProviders');

/**
 * The settings a run gets when no SCRAPER_* or APIFY_* variable is set - from
 * the real resolver, with an empty environment. The expected actor inputs below
 * are the literals the mappers sent before those variables existed, written out
 * by hand, so these tests pin that an untouched install sends what it always did.
 */
const SHIPPED = resolveScraperRunSettings('APIFY_ACTOR_INDEED', {});

/** The shipped settings with some fields changed, as a configured install would have them. */
const configured = (overrides) => ({ ...SHIPPED, ...overrides });

test('mapFiltersForIndeed maps a start URL into the fixed misceres actor input', () => {
  const result = mapFiltersForIndeed({
    startUrl: 'https://www.indeed.com/jobs/?q=data+analyst&l=San+Francisco&sort=date',
  }, SHIPPED);

  assert.deepEqual(result, {
    country: 'US',
    maxItemsPerSearch: 100,
    startUrls: [{ url: 'https://www.indeed.com/jobs/?q=data+analyst&l=San+Francisco&sort=date' }],
    followApplyRedirects: false,
    parseCompanyDetails: false,
    saveOnlyUniqueItems: true,
  });
});

test('buildIndeedSearchUrl sorts Indeed searches by newest first', () => {
  assert.equal(
    buildIndeedSearchUrl({
      keywords: 'data analyst',
      location: 'United States',
    }),
    'https://www.indeed.com/jobs/?q=data+analyst&l=United+States&sort=date'
  );
});

test('software engineer keyword triggers broad software-role search expansion', () => {
  assert.equal(isBroadSoftwareRoleSearch('software engineer'), true);
  assert.equal(isBroadSoftwareRoleSearch('software developer'), true);
  assert.equal(isBroadSoftwareRoleSearch('data engineer'), false);
});

test('mapFiltersForIndeed requires a start URL', () => {
  assert.throws(
    () => mapFiltersForIndeed({}, SHIPPED),
    /startUrl is required for the Misceres Indeed scraper/
  );
});

test('mapFiltersForHiringCafeCrawlerbros maps shared filters into the alternative actor input', () => {
  const result = mapFiltersForHiringCafeCrawlerbros({
    keywords: 'python developer',
    location: 'United States',
    timePosted: '7d',
    jobType: 'contract',
    remoteOnly: true,
    maxResults: 100,
  }, SHIPPED);

  assert.deepEqual(result, {
    searchQueries: ['python developer'],
    maxItems: 100,
    workplaceTypes: ['Remote'],
    commitmentTypes: ['Contract'],
    dateFetchedPastNDays: 7,
  });
});

test('hiring cafe software engineer search expands into multiple software-role queries', () => {
  const result = mapFiltersForHiringCafeCrawlerbros({
    keywords: 'software engineer',
    location: 'United States',
    timePosted: '24h',
    remoteOnly: true,
    maxResults: 100,
  }, SHIPPED);

  assert.deepEqual(result.searchQueries.slice(0, 6), [
    'software engineer',
    'software developer',
    'backend engineer',
    'frontend engineer',
    'full stack engineer',
    'platform engineer',
  ]);
  assert.equal(result.searchQueries.includes('security engineer'), true);
  assert.equal(result.searchQueries.includes('software architect'), true);
});

test('hiring cafe single-string actors broaden software engineer into software-role keywords', () => {
  const manoj = mapFiltersForHiringCafe({
    keywords: 'software engineer',
    location: 'United States',
    maxResults: 100,
  }, SHIPPED);

  assert.match(manoj.searchQuery, /software engineer, software developer, backend engineer/);
});

test('mapFiltersForHiringCafeMemo23 maps a start URL into the fixed memo23 actor input', () => {
  const result = mapFiltersForHiringCafeMemo23({
    startUrl: 'https://hiring.cafe/?searchState=%7B%22searchQuery%22%3A%22python%20developer%22%7D',
  }, SHIPPED);

  assert.deepEqual(result, {
    flattenOutput: false,
    location: 'United States',
    maxConcurrency: 2,
    maxItems: 50,
    maxRequestRetries: 0,
    minConcurrency: 1,
    proxy: {
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
      apifyProxyCountry: 'US',
    },
    startUrls: [{ url: 'https://hiring.cafe/?searchState=%7B%22searchQuery%22%3A%22python%20developer%22%7D' }],
  });
});

test('mapFiltersForHiringCafeMemo23 requires a start URL', () => {
  assert.throws(
    () => mapFiltersForHiringCafeMemo23({}, SHIPPED),
    /startUrl is required for the memo23 Hiring Cafe scraper/
  );
});

/* ============================================= deployment settings (SCRAPER_*, APIFY_*) */

test('the shipped settings are the literals the scrapers used to hard-code', () => {
  assert.deepEqual(SHIPPED, {
    actorId: 'misceres/indeed-scraper',
    runTimeoutS: 300,
    proxyGroups: ['RESIDENTIAL'],
    country: 'US',
    defaultLocation: 'United States',
    maxResults: null,
  });
});

test('SCRAPER_COUNTRY, SCRAPER_DEFAULT_LOCATION and APIFY_PROXY_GROUPS reach the start-URL actors', () => {
  const settings = configured({ country: 'GB', defaultLocation: 'United Kingdom', proxyGroups: ['GOOGLE_SERP'] });
  const startUrl = 'https://hiring.cafe/?searchState=%7B%7D';

  assert.equal(mapFiltersForIndeed({ startUrl }, settings).country, 'GB');
  const memo23 = mapFiltersForHiringCafeMemo23({ startUrl }, settings);
  assert.equal(memo23.location, 'United Kingdom');
  // Key order too: the body is what Apify receives, and an untouched install
  // must keep sending the same bytes.
  assert.equal(
    JSON.stringify(memo23.proxy),
    JSON.stringify({ useApifyProxy: true, apifyProxyGroups: ['GOOGLE_SERP'], apifyProxyCountry: 'GB' })
  );
});

test('APIFY_PROXY_GROUPS=auto leaves the groups out and keeps Apify proxy on', () => {
  const settings = configured({ proxyGroups: [] });

  assert.deepEqual(mapFiltersForJobBoard({ keywords: 'x' }, settings).proxyConfiguration, { useApifyProxy: true });
  assert.deepEqual(mapFiltersForHiringCafe({ keywords: 'x' }, settings).proxyConfiguration, { useApifyProxy: true });
  assert.deepEqual(
    mapFiltersForHiringCafeMemo23({ startUrl: 'https://hiring.cafe/' }, settings).proxy,
    { useApifyProxy: true, apifyProxyCountry: 'US' }
  );
});

test('with no SCRAPER_MAX_RESULTS the counts are exactly what they were', () => {
  // Requested, defaulted, and the Job Board's own limit of 100.
  assert.equal(mapFiltersForWellfound({ maxResults: 1000 }, SHIPPED).maxResults, 1000);
  assert.equal(mapFiltersForWellfound({}, SHIPPED).maxResults, 100);
  assert.equal(mapFiltersForJobBoard({ keywords: 'x', maxResults: 250 }, SHIPPED).maxResults, 100);
  assert.equal(mapFiltersForJobBoard({ keywords: 'x' }, SHIPPED).maxResults, 100);
  assert.equal(mapFiltersForHiringCafe({ keywords: 'x', maxResults: 500 }, SHIPPED).maxResults, 500);
  assert.equal(mapFiltersForHiringCafeCrawlerbros({ keywords: 'x', maxResults: 25 }, SHIPPED).maxItems, 25);
  assert.equal(mapFiltersForIndeed({ startUrl: 'https://www.indeed.com/jobs/' }, SHIPPED).maxItemsPerSearch, 100);
  assert.equal(mapFiltersForHiringCafeMemo23({ startUrl: 'https://hiring.cafe/' }, SHIPPED).maxItems, 50);
});

test('SCRAPER_MAX_RESULTS bounds every count an actor is sent, including the fixed ones', () => {
  const capped = configured({ maxResults: 30 });

  assert.equal(mapFiltersForWellfound({ maxResults: 1000 }, capped).maxResults, 30);
  assert.equal(mapFiltersForWellfound({}, capped).maxResults, 30, 'the default of 100 is capped too');
  assert.equal(mapFiltersForWellfound({ maxResults: 10 }, capped).maxResults, 10, 'a smaller request is kept');
  assert.equal(mapFiltersForJobBoard({ keywords: 'x', maxResults: 250 }, capped).maxResults, 30);
  assert.equal(mapFiltersForHiringCafe({ keywords: 'x', maxResults: 500 }, capped).maxResults, 30);
  assert.equal(mapFiltersForHiringCafeCrawlerbros({ keywords: 'x', maxResults: 500 }, capped).maxItems, 30);
  // The two start-URL actors used to ignore any limit: Indeed always asked for
  // 100 per search and memo23 for 50 items.
  assert.equal(mapFiltersForIndeed({ startUrl: 'https://www.indeed.com/jobs/' }, capped).maxItemsPerSearch, 30);
  assert.equal(mapFiltersForHiringCafeMemo23({ startUrl: 'https://hiring.cafe/' }, capped).maxItems, 30);

  // A cap above an actor's own limit leaves that limit in charge.
  const loose = configured({ maxResults: 75 });
  assert.equal(mapFiltersForJobBoard({ keywords: 'x', maxResults: 250 }, loose).maxResults, 75);
  assert.equal(mapFiltersForHiringCafeMemo23({ startUrl: 'https://hiring.cafe/' }, loose).maxItems, 50);
});

test('buildIndeedSearchUrl falls back to the deployment location only', () => {
  assert.equal(
    buildIndeedSearchUrl({ keywords: 'data analyst' }, configured({ defaultLocation: 'United Kingdom' })),
    'https://www.indeed.com/jobs/?q=data+analyst&l=United+Kingdom&sort=date'
  );
  assert.equal(
    buildIndeedSearchUrl({ keywords: 'data analyst' }),
    'https://www.indeed.com/jobs/?q=data+analyst&sort=date'
  );
});

test('a mapper called without its settings names the missing one instead of sending undefined', () => {
  assert.throws(
    () => mapFiltersForIndeed({ startUrl: 'https://www.indeed.com/jobs/' }),
    (error) => error instanceof TypeError && /Indeed scraper needs settings\.country/.test(error.message)
  );
  assert.throws(
    () => mapFiltersForJobBoard({ keywords: 'x' }, configured({ proxyGroups: undefined })),
    /settings\.proxyGroups/
  );
  assert.throws(
    () => mapFiltersForWellfound({}, configured({ maxResults: 0 })),
    /settings\.maxResults/
  );
});
