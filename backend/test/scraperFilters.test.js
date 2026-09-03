const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildIndeedSearchUrl,
  isBroadSoftwareRoleSearch,
  mapFiltersForIndeed,
  mapFiltersForHiringCafe,
  mapFiltersForHiringCafeCrawlerbros,
  mapFiltersForHiringCafeMemo23,
  mapFiltersForLinkedIn,
} = require('../scrapers/filters');

test('mapFiltersForLinkedIn maps title and rows into the fixed Bebity actor input', () => {
  const result = mapFiltersForLinkedIn({
    title: 'software engineer',
    rows: 25,
  });

  assert.deepEqual(result, {
    title: 'software engineer',
    location: 'United States',
    publishedAt: 'r86400',
    rows: 25,
    workType: '2',
    proxy: {
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
      apifyProxyCountry: 'US',
    },
  });
});

test('mapFiltersForLinkedIn falls back to the legacy keyword field and caps rows at 1000', () => {
  const result = mapFiltersForLinkedIn({
    keywords: 'data engineer',
    rows: 5000,
  });

  assert.deepEqual(result, {
    title: 'data engineer',
    location: 'United States',
    publishedAt: 'r86400',
    rows: 1000,
    workType: '2',
    proxy: {
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
      apifyProxyCountry: 'US',
    },
  });
});

test('mapFiltersForIndeed maps a start URL into the fixed misceres actor input', () => {
  const result = mapFiltersForIndeed({
    startUrl: 'https://www.indeed.com/jobs/?q=data+analyst&l=San+Francisco&sort=date',
  });

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
    () => mapFiltersForIndeed({}),
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
  });

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
  });

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
  });

  assert.match(manoj.searchQuery, /software engineer, software developer, backend engineer/);
});

test('mapFiltersForHiringCafeMemo23 maps a start URL into the fixed memo23 actor input', () => {
  const result = mapFiltersForHiringCafeMemo23({
    startUrl: 'https://hiring.cafe/?searchState=%7B%22searchQuery%22%3A%22python%20developer%22%7D',
  });

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
    () => mapFiltersForHiringCafeMemo23({}),
    /startUrl is required for the memo23 Hiring Cafe scraper/
  );
});
