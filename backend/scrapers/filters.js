'use strict';

const DEFAULT_MAX_RESULTS = 100;
const JOB_BOARD_MAX_RESULTS = 100;
const DEFAULT_JOB_BOARD_SITES = ['linkedin', 'indeed', 'glassdoor', 'google', 'zip_recruiter'];
const DEFAULT_LINKEDIN_LOCATION = 'United States';
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

function toMaxResults(filters, maxLimit) {
  if (Number.isInteger(filters && filters.maxResults) && filters.maxResults > 0) {
    if (Number.isInteger(maxLimit) && maxLimit > 0) {
      return Math.min(filters.maxResults, maxLimit);
    }

    return filters.maxResults;
  }

  return DEFAULT_MAX_RESULTS;
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

function buildLinkedInSearchUrl(filters) {
  const url = new URL('https://www.linkedin.com/jobs/search/');
  const keywords = normalizeText(filters && filters.keywords);
  const location = normalizeText(filters && filters.location) || DEFAULT_LINKEDIN_LOCATION;
  const jobType = normalizeText(filters && filters.jobType);
  const timePosted = normalizeText(filters && filters.timePosted);

  if (keywords) {
    url.searchParams.set('keywords', keywords);
  }

  if (location) {
    url.searchParams.set('location', location);
  }

  if (filters && filters.remoteOnly) {
    url.searchParams.set('f_WT', '2');
  }

  if (LINKEDIN_TIME_POSTED_TO_SECONDS[timePosted]) {
    url.searchParams.set('f_TPR', `r${LINKEDIN_TIME_POSTED_TO_SECONDS[timePosted]}`);
  }

  if (LINKEDIN_JOB_TYPE_TO_CODE[jobType]) {
    url.searchParams.set('f_JT', LINKEDIN_JOB_TYPE_TO_CODE[jobType]);
  }

  url.searchParams.set('sortBy', 'DD');
  return url.toString();
}

function buildIndeedSearchUrl(filters) {
  const url = new URL('https://www.indeed.com/jobs/');
  const keywords = buildExpandedKeywordQuery(filters && filters.keywords);
  const location = normalizeText(filters && filters.location) || DEFAULT_LINKEDIN_LOCATION;

  if (keywords) {
    url.searchParams.set('q', keywords);
  }

  if (location) {
    url.searchParams.set('l', location);
  }

  url.searchParams.set('sort', 'date');
  return url.toString();
}

function mapFiltersForLinkedIn(filters) {
  const title = normalizeText(filters && (filters.title || filters.keywords)) || 'software engineer';
  const requestedRows = Number.isInteger(filters && filters.rows) && filters.rows > 0
    ? filters.rows
    : toMaxResults(filters || {}, 1000);

  return {
    title,
    location: DEFAULT_LINKEDIN_LOCATION,
    publishedAt: 'r86400',
    rows: Math.min(requestedRows, 1000),
    workType: '2',
    proxy: {
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
      apifyProxyCountry: 'US',
    },
  };
}

function mapFiltersForIndeed(filters) {
  const startUrl = normalizeText(filters && filters.startUrl);
  if (!startUrl) {
    throw new Error('startUrl is required for the Misceres Indeed scraper.');
  }

  return {
    country: 'US',
    followApplyRedirects: false,
    maxItemsPerSearch: 100,
    parseCompanyDetails: false,
    saveOnlyUniqueItems: true,
    startUrls: [{ url: startUrl }],
  };
}

function mapFiltersForIndeedBorderline(filters) {
  const actorInput = {
    country: 'us',
    query: buildExpandedKeywordQuery(filters && filters.keywords) || 'software engineer',
    location: normalizeText(filters && filters.location) || DEFAULT_LINKEDIN_LOCATION,
    sort: 'date',
    maxRows: toMaxResults(filters || {}),
    enableUniqueJobs: true,
    includeSimilarJobs: false,
  };
  const jobType = normalizeText(filters && filters.jobType);
  const timePosted = normalizeText(filters && filters.timePosted);

  if (jobType) {
    actorInput.jobType = jobType.replace(/-/g, '');
  }

  if (timePosted === '24h') {
    actorInput.fromDays = '1';
  } else if (timePosted === '3d') {
    actorInput.fromDays = '3';
  } else if (timePosted === '7d') {
    actorInput.fromDays = '7';
  } else if (timePosted === '30d') {
    actorInput.fromDays = '14';
  }

  if (filters && filters.remoteOnly) {
    actorInput.remote = 'remote';
  }

  return actorInput;
}

function mapFiltersForJobBoard(filters) {
  const actorInput = {
    searchTerm: normalizeText(filters && filters.keywords) || 'software engineer',
    maxResults: toMaxResults(filters || {}, JOB_BOARD_MAX_RESULTS),
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

  actorInput.proxyConfiguration = {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
  };

  return actorInput;
}

function mapFiltersForWellfound(filters) {
  const actorInput = {
    maxResults: toMaxResults(filters || {}),
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

function mapFiltersForHiringCafe(filters) {
  const actorInput = {
    searchQuery: buildHiringCafeKeywordString(filters && filters.keywords),
    maxResults: toMaxResults(filters || {}),
    proxyConfiguration: {
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
    },
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

function mapFiltersForHiringCafeCrawlerbros(filters) {
  const actorInput = {
    searchQueries: buildHiringCafeSearchQueries(filters && filters.keywords),
    maxItems: toMaxResults(filters || {}),
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

function mapFiltersForHiringCafeMemo23(filters) {
  const startUrl = normalizeText(filters && filters.startUrl);
  if (!startUrl) {
    throw new Error('startUrl is required for the memo23 Hiring Cafe scraper.');
  }

  return {
    flattenOutput: false,
    location: DEFAULT_LINKEDIN_LOCATION,
    maxConcurrency: 2,
    maxItems: 50,
    maxRequestRetries: 0,
    minConcurrency: 1,
    proxy: {
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
      apifyProxyCountry: 'US',
    },
    startUrls: [{ url: startUrl }],
  };
}

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
  buildIndeedSearchUrl,
  isBroadSoftwareRoleSearch,
  mapFiltersForIndeed,
  mapFiltersForIndeedBorderline,
  mapFiltersForLinkedIn,
  mapFiltersForJobBoard,
  mapFiltersForWellfound,
  mapFiltersForHiringCafe,
  mapFiltersForHiringCafeCrawlerbros,
  mapFiltersForHiringCafeMemo23,
  mapFiltersForLever,
};
