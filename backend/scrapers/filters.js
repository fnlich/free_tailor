'use strict';

const { requireSettings } = require('./settings');

/**
 * Results asked of an actor when the request names no number. Not a deployment
 * setting: SCRAPER_MAX_RESULTS caps this and every other count from above.
 */
const DEFAULT_MAX_RESULTS = 100;
/**
 * The most each actor below returns per run, whatever it is asked for - limits
 * of the actors, not of this deployment. services/scraperProviders.ts serves
 * them (with SCRAPER_MAX_RESULTS folded in) so the jobs page offers no count
 * the run cannot return.
 */
const JOB_BOARD_MAX_RESULTS = 100;
const INDEED_MAX_ITEMS_PER_SEARCH = 100;
const MEMO23_MAX_ITEMS = 50;
const DEFAULT_JOB_BOARD_SITES = ['linkedin', 'indeed', 'glassdoor', 'google', 'zip_recruiter'];
const LINKEDIN_TIME_POSTED_TO_SECONDS = {
  '24h': 24 * 60 * 60,
  '3d': 3 * 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
  '30d': 30 * 24 * 60 * 60,
};
const JOB_BOARD_TIME_POSTED_TO_HOURS = {
  '24h': 24,
  '3d': 72,
  '7d': 168,
  '30d': 720,
};
const LINKEDIN_JOB_TYPE_TO_CODE = {
  'full-time': 'F',
  'part-time': 'P',
  contract: 'C',
  internship: 'I',
  temporary: 'T',
};
const HIRING_CAFE_JOB_TYPE_TO_COMMITMENT = {
  'full-time': 'Full Time',
  'part-time': 'Part Time',
  contract: 'Contract',
  internship: 'Internship',
  temporary: 'Temporary',
};
const HIRING_CAFE_TIME_POSTED_TO_DAYS = {
  '24h': 1,
  '3d': 3,
  '7d': 7,
  '30d': 30,
};
const SOFTWARE_ROLE_SEARCH_TRIGGERS = new Set([
  'software engineer',
  'software developer',
]);
const SOFTWARE_ROLE_QUERY_TITLES = [
  'software engineer',
  'software developer',
  'backend engineer',
  'backend developer',
  'frontend engineer',
  'frontend developer',
  'full stack engineer',
  'full stack developer',
  'platform engineer',
  'site reliability engineer',
  'devops engineer',
  'cloud engineer',
  'data engineer',
  'ai engineer',
  'machine learning engineer',
  'security engineer',
  'mobile developer',
  'ios developer',
  'android developer',
  'software architect',
  'solutions architect',
  'software development engineer',
  'sdet',
  'qa engineer',
  'automation engineer',
  'test engineer',
  'build engineer',
  'tools engineer',
  'product engineer',
  'research engineer',
  'computer vision engineer',
  'robotics software engineer',
];
const SOFTWARE_ROLE_HIRING_CAFE_QUERIES = [
  'software engineer',
  'software developer',
  'backend engineer',
  'frontend engineer',
  'full stack engineer',
  'platform engineer',
  'site reliability engineer',
  'devops engineer',
  'data engineer',
  'machine learning engineer',
  'security engineer',
  'mobile developer',
  'software architect',
  'solutions architect',
];
const SOFTWARE_ROLE_EXCLUDED_TERMS = [
  'intern',
  'internship',
  'junior',
  'associate',
  'student',
  'graduate',
  'new grad',
  'apprentice',
  'trainee',
  'entry level',
];
const WELLFOUND_ROLE_MAPPINGS = [
  { pattern: /\bsoftware\b|\bengineer\b|\bdeveloper\b|\bfull[- ]?stack\b|\bbackend\b|\bfrontend\b|\bfront[- ]?end\b/i, role: 'software-engineer' },
  { pattern: /\bproduct\b.*\bmanager\b|\bpm\b/i, role: 'product-manager' },
  { pattern: /\bdesigner\b|\bux\b|\bui\b/i, role: 'product-designer' },
  { pattern: /\bdata\b|\banalyst\b|\banalytics\b/i, role: 'data-analyst' },
  { pattern: /\bmarketing\b|\bgrowth\b/i, role: 'growth-marketer' },
  { pattern: /\bsales\b|\baccount executive\b|\bbdr\b|\bsdr\b/i, role: 'sales-manager' },
  { pattern: /\boperations\b|\bops\b/i, role: 'operations-manager' },
  { pattern: /\bhr\b|\brecruit/i, role: 'hr-manager' },
  { pattern: /\bcustomer success\b|\bsupport\b/i, role: 'customer-success' },
  { pattern: /\bfinance\b|\baccounting\b/i, role: 'finance-accounting' },
  { pattern: /\bbusiness development\b|\bpartnership/i, role: 'business-development' },
  { pattern: /\bgraphic\b|\bbrand\b|\bvisual\b/i, role: 'graphic-designer' },
];

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeKeywordKey(value) {
  return normalizeText(value).toLowerCase().replace(/\s+/g, ' ');
}

function isBroadSoftwareRoleSearch(value) {
  return SOFTWARE_ROLE_SEARCH_TRIGGERS.has(normalizeKeywordKey(value));
}

function buildBroadSoftwareRoleBooleanQuery() {
  const includedTerms = SOFTWARE_ROLE_QUERY_TITLES.map((title) => `"${title}"`).join(' OR ');
  const excludedTerms = SOFTWARE_ROLE_EXCLUDED_TERMS
    .map((term) => (term.includes(' ') ? `-"${term}"` : `-${term}`))
    .join(' ');

  return `(${includedTerms}) ${excludedTerms}`;
}

function buildExpandedKeywordQuery(value) {
  return isBroadSoftwareRoleSearch(value)
    ? buildBroadSoftwareRoleBooleanQuery()
    : normalizeText(value);
}

function buildHiringCafeSearchQueries(value) {
  return isBroadSoftwareRoleSearch(value)
    ? SOFTWARE_ROLE_HIRING_CAFE_QUERIES.slice()
    : [normalizeText(value) || 'software engineer'];
}

function buildHiringCafeKeywordString(value) {
  return isBroadSoftwareRoleSearch(value)
    ? SOFTWARE_ROLE_HIRING_CAFE_QUERIES.join(', ')
    : normalizeText(value) || 'software engineer';
}

function normalizeLocationSlug(location) {
  return normalizeText(location)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function escapeRegex(value) {
  return normalizeText(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toRegexFilter(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return undefined;
  }

  return escapeRegex(normalized).replace(/\s+/g, '.*');
}

/** The smallest of the limits that are set; `null` and anything not a positive whole number are "no limit". */
function smallestLimit(...limits) {
  const set = limits.filter((limit) => Number.isInteger(limit) && limit > 0);
  return set.length > 0 ? Math.min(...set) : null;
}

/**
 * How many results to ask an actor for.
 *
 * The request's own number, or DEFAULT_MAX_RESULTS when it names none, held
 * under the actor's own limit (`actorLimit`) and the deployment's cap
 * (`deploymentCap`, SCRAPER_MAX_RESULTS) when either is set. With neither set
 * this is exactly what it was before the cap existed.
 */
function toMaxResults(filters, actorLimit, deploymentCap) {
  const requested = Number.isInteger(filters && filters.maxResults) && filters.maxResults > 0
    ? filters.maxResults
    : DEFAULT_MAX_RESULTS;
  const limit = smallestLimit(actorLimit, deploymentCap);

  return limit === null ? requested : Math.min(requested, limit);
}

/**
 * Apify proxy configuration for the deployment's proxy groups.
 *
 * An empty list is APIFY_PROXY_GROUPS=auto: the groups are left out and Apify
 * picks its own pool. RESIDENTIAL, the default, is a paid add-on on Apify's
 * plans, which is why the groups are configurable at all. `extra` follows the
 * groups so the keys keep the order the actors have always been sent.
 */
function buildProxyConfiguration(proxyGroups, extra) {
  const configuration = { useApifyProxy: true };
  if (proxyGroups.length > 0) {
    configuration.apifyProxyGroups = proxyGroups.slice();
  }

  return { ...configuration, ...(extra || {}) };
}

function inferWellfoundRoles(keywords) {
  const normalizedKeywords = normalizeText(keywords);
  if (!normalizedKeywords) {
    return [];
  }

  return WELLFOUND_ROLE_MAPPINGS
    .filter((entry) => entry.pattern.test(normalizedKeywords))
    .map((entry) => entry.role);
}

/**
 * An Indeed search URL for keywords and a location.
 *
 * Nothing in the server calls this today - the Indeed actor runs from a start
 * URL the user pastes - but it is the shape such a URL takes. A missing location
 * falls back to the deployment's (SCRAPER_DEFAULT_LOCATION, via `settings`), and
 * with neither the URL carries no location at all.
 */
function buildIndeedSearchUrl(filters, settings) {
  const url = new URL('https://www.indeed.com/jobs/');
  const keywords = buildExpandedKeywordQuery(filters && filters.keywords);
  const location = normalizeText(filters && filters.location) || normalizeText(settings && settings.defaultLocation);

  if (keywords) {
    url.searchParams.set('q', keywords);
  }

  if (location) {
    url.searchParams.set('l', location);
  }

  url.searchParams.set('sort', 'date');
  return url.toString();
}
/**
 * The Indeed actor's input. The pasted start URL decides the search, so the
 * request's `maxResults` is not sent: the actor's per-search cap is, held under
 * SCRAPER_MAX_RESULTS when that is set.
 */
function mapFiltersForIndeed(filters, settings) {
  const startUrl = normalizeText(filters && filters.startUrl);
  if (!startUrl) {
    throw new Error('startUrl is required for the Misceres Indeed scraper.');
  }
  requireSettings(settings, ['country', 'maxResults'], 'Indeed scraper');

  return {
    country: settings.country,
    followApplyRedirects: false,
    maxItemsPerSearch: smallestLimit(INDEED_MAX_ITEMS_PER_SEARCH, settings.maxResults),
    parseCompanyDetails: false,
    saveOnlyUniqueItems: true,
    startUrls: [{ url: startUrl }],
  };
}

function mapFiltersForJobBoard(filters, settings) {
  requireSettings(settings, ['proxyGroups', 'maxResults'], 'Job Board scraper');
  const actorInput = {
    searchTerm: normalizeText(filters && filters.keywords) || 'software engineer',
    maxResults: toMaxResults(filters || {}, JOB_BOARD_MAX_RESULTS, settings.maxResults),
    sites: DEFAULT_JOB_BOARD_SITES.slice(),
  };
  const location = normalizeText(filters && filters.location);
  const jobType = normalizeText(filters && filters.jobType);
  const timePosted = normalizeText(filters && filters.timePosted);

  if (location) {
    actorInput.location = location;
  }

  if (filters && filters.remoteOnly) {
    actorInput.isRemote = true;
  }

  if (jobType) {
    actorInput.jobType = jobType.replace(/-/g, '');
  }

  if (JOB_BOARD_TIME_POSTED_TO_HOURS[timePosted]) {
    actorInput.hoursOld = JOB_BOARD_TIME_POSTED_TO_HOURS[timePosted];
  }

  actorInput.proxyConfiguration = buildProxyConfiguration(settings.proxyGroups);

  return actorInput;
}

function mapFiltersForWellfound(filters, settings) {
  requireSettings(settings, ['maxResults'], 'Wellfound scraper');
  const actorInput = {
    maxResults: toMaxResults(filters || {}, null, settings.maxResults),
    remote: Boolean(filters && filters.remoteOnly),
    enrichDetail: true,
    descriptionMaxLength: 0,
    compact: false,
  };
  const locationSlug = normalizeLocationSlug(filters && filters.location);
  const roles = inferWellfoundRoles(filters && filters.keywords);

  if (locationSlug) {
    actorInput.location = locationSlug;
  }

  if (roles.length > 0) {
    actorInput.roles = roles;
  }

  return actorInput;
}

function mapFiltersForHiringCafe(filters, settings) {
  requireSettings(settings, ['proxyGroups', 'maxResults'], 'Hiring Cafe scraper');
  const actorInput = {
    searchQuery: buildHiringCafeKeywordString(filters && filters.keywords),
    maxResults: toMaxResults(filters || {}, null, settings.maxResults),
    proxyConfiguration: buildProxyConfiguration(settings.proxyGroups),
  };
  const location = normalizeText(filters && filters.location);
  const jobType = normalizeText(filters && filters.jobType);
  const timePosted = normalizeText(filters && filters.timePosted);

  if (location) {
    actorInput.location = location;
  }

  if (filters && filters.remoteOnly) {
    actorInput.workplaceTypes = ['Remote'];
  }

  if (HIRING_CAFE_JOB_TYPE_TO_COMMITMENT[jobType]) {
    actorInput.commitmentTypes = [HIRING_CAFE_JOB_TYPE_TO_COMMITMENT[jobType]];
  }

  if (HIRING_CAFE_TIME_POSTED_TO_DAYS[timePosted]) {
    actorInput.dateFetchedPastNDays = HIRING_CAFE_TIME_POSTED_TO_DAYS[timePosted];
  }

  return actorInput;
}

function mapFiltersForHiringCafeCrawlerbros(filters, settings) {
  requireSettings(settings, ['maxResults'], 'Hiring Cafe scraper (CrawlerBros)');
  const actorInput = {
    searchQueries: buildHiringCafeSearchQueries(filters && filters.keywords),
    maxItems: toMaxResults(filters || {}, null, settings.maxResults),
  };
  const jobType = normalizeText(filters && filters.jobType);
  const timePosted = normalizeText(filters && filters.timePosted);

  if (filters && filters.remoteOnly) {
    actorInput.workplaceTypes = ['Remote'];
  }

  if (HIRING_CAFE_JOB_TYPE_TO_COMMITMENT[jobType]) {
    actorInput.commitmentTypes = [HIRING_CAFE_JOB_TYPE_TO_COMMITMENT[jobType]];
  }

  if (HIRING_CAFE_TIME_POSTED_TO_DAYS[timePosted]) {
    actorInput.dateFetchedPastNDays = HIRING_CAFE_TIME_POSTED_TO_DAYS[timePosted];
  }

  return actorInput;
}

/**
 * The memo23 actor's input. Like Indeed it runs from a pasted start URL, with a
 * fixed location and proxy exit country - the deployment's market - and a fixed
 * item count held under SCRAPER_MAX_RESULTS when that is set.
 */
function mapFiltersForHiringCafeMemo23(filters, settings) {
  const startUrl = normalizeText(filters && filters.startUrl);
  if (!startUrl) {
    throw new Error('startUrl is required for the memo23 Hiring Cafe scraper.');
  }
  requireSettings(
    settings,
    ['defaultLocation', 'country', 'proxyGroups', 'maxResults'],
    'Hiring Cafe scraper (memo23)'
  );

  return {
    flattenOutput: false,
    location: settings.defaultLocation,
    maxConcurrency: 2,
    maxItems: smallestLimit(MEMO23_MAX_ITEMS, settings.maxResults),
    maxRequestRetries: 0,
    minConcurrency: 1,
    proxy: buildProxyConfiguration(settings.proxyGroups, { apifyProxyCountry: settings.country }),
    startUrls: [{ url: startUrl }],
  };
}

/**
 * The Lever actor's input. It has no result count to send - it returns every
 * matching posting - so SCRAPER_MAX_RESULTS cannot bound this run on Apify's
 * side. routes/jobs.ts trims what comes back to the cap instead.
 */
function mapFiltersForLever(filters) {
  const actorInput = {
    mode: 'all',
    remoteOnly: Boolean(filters && filters.remoteOnly),
    includeDescriptions: true,
    outputFormat: 'both',
  };
  const keywordFilter = toRegexFilter(filters && filters.keywords);
  const locationFilter = toRegexFilter(filters && filters.location);

  if (keywordFilter) {
    actorInput.keywordFilter = keywordFilter;
  }

  if (locationFilter) {
    actorInput.locationFilter = locationFilter;
  }

  return actorInput;
}

module.exports = {
  INDEED_MAX_ITEMS_PER_SEARCH,
  JOB_BOARD_MAX_RESULTS,
  MEMO23_MAX_ITEMS,
  buildIndeedSearchUrl,
  isBroadSoftwareRoleSearch,
  mapFiltersForIndeed,
  mapFiltersForJobBoard,
  mapFiltersForWellfound,
  mapFiltersForHiringCafe,
  mapFiltersForHiringCafeCrawlerbros,
  mapFiltersForHiringCafeMemo23,
  mapFiltersForLever,
};
