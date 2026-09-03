'use strict';

function normalizeText(value) {
  if (typeof value === 'string') {
    return value.replace(/\s+/g, ' ').trim();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return '';
}

function firstNonEmpty() {
  for (const value of arguments) {
    const normalized = normalizeText(value);
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function toNumberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const cleaned = value.replace(/[^0-9.-]/g, '');
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function parseRelativeDateToDate(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return null;
  }

  const now = new Date();

  if (normalized === 'today' || normalized === 'just now') {
    return now;
  }

  if (normalized === 'yesterday') {
    return new Date(now.getTime() - (24 * 60 * 60 * 1000));
  }

  const compactMatch = normalized.match(/^(\d+)\s*([hdwmy])(?:\s+ago)?$/i);
  if (compactMatch) {
    return shiftDateByUnit(now, Number(compactMatch[1]), compactMatch[2]);
  }

  const relativeMatch = normalized.match(/^(\d+)\+?\s*(hour|hours|hr|hrs|day|days|week|weeks|month|months|year|years)\s+ago$/i);
  if (relativeMatch) {
    return shiftDateByUnit(now, Number(relativeMatch[1]), relativeMatch[2]);
  }

  const shortenedMatch = normalized.match(/^posted\s+(\d+)\+?\s*(hour|hours|day|days|week|weeks|month|months|year|years)\s+ago$/i);
  if (shortenedMatch) {
    return shiftDateByUnit(now, Number(shortenedMatch[1]), shortenedMatch[2]);
  }

  return null;
}

function shiftDateByUnit(baseDate, amount, unit) {
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }

  const normalizedUnit = String(unit).toLowerCase();
  const result = new Date(baseDate.getTime());

  if (normalizedUnit === 'h' || normalizedUnit === 'hour' || normalizedUnit === 'hours' || normalizedUnit === 'hr' || normalizedUnit === 'hrs') {
    result.setTime(result.getTime() - (amount * 60 * 60 * 1000));
    return result;
  }

  if (normalizedUnit === 'd' || normalizedUnit === 'day' || normalizedUnit === 'days') {
    result.setDate(result.getDate() - amount);
    return result;
  }

  if (normalizedUnit === 'w' || normalizedUnit === 'week' || normalizedUnit === 'weeks') {
    result.setDate(result.getDate() - (amount * 7));
    return result;
  }

  if (normalizedUnit === 'm' || normalizedUnit === 'month' || normalizedUnit === 'months') {
    result.setMonth(result.getMonth() - amount);
    return result;
  }

  if (normalizedUnit === 'y' || normalizedUnit === 'year' || normalizedUnit === 'years') {
    result.setFullYear(result.getFullYear() - amount);
    return result;
  }

  return null;
}

function toIsoOrNull(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const relativeDate = parseRelativeDateToDate(normalized);
  if (relativeDate) {
    return relativeDate.toISOString();
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function toPostedAtIso() {
  for (const value of arguments) {
    const normalized = toIsoOrNull(value);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function toLocationString(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeText(entry)).filter(Boolean).join(', ');
  }

  if (value && typeof value === 'object') {
    const objectValue = value;
    return [
      objectValue.city,
      objectValue.region,
      objectValue.state,
      objectValue.country,
      objectValue.name,
      objectValue.text,
      objectValue.location,
    ]
      .map((entry) => normalizeText(entry))
      .filter(Boolean)
      .join(', ');
  }

  return normalizeText(value);
}

function toStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeText(entry)).filter(Boolean);
  }

  const normalized = normalizeText(value);
  return normalized ? [normalized] : [];
}

function normalizeJobType(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return '';
  }

  const mapping = {
    fulltime: 'full-time',
    'full-time': 'full-time',
    'full time': 'full-time',
    full_time: 'full-time',
    parttime: 'part-time',
    'part-time': 'part-time',
    'part time': 'part-time',
    part_time: 'part-time',
    contract: 'contract',
    contractor: 'contract',
    internship: 'internship',
    intern: 'internship',
    temporary: 'temporary',
    temp: 'temporary',
  };

  return mapping[normalized] || normalized;
}

function formatEquity(minValue, maxValue) {
  const min = toNumberOrNull(minValue);
  const max = toNumberOrNull(maxValue);

  if (min === null && max === null) {
    return null;
  }

  if (min !== null && max !== null) {
    return `${min}-${max}`;
  }

  return String(min !== null ? min : max);
}

function formatJobBoardFallbackDescription(item) {
  const parts = [];
  const jobLevel = firstNonEmpty(item.job_level, item.experience_range);
  const jobFunction = firstNonEmpty(item.job_function);
  const skills = normalizeText(item.skills);
  const companyDescription = normalizeText(item.company_description);
  const listingType = normalizeText(item.listing_type);
  const site = normalizeText(item.site);

  if (jobLevel) {
    parts.push(`Level: ${jobLevel}`);
  }

  if (jobFunction) {
    parts.push(`Function: ${jobFunction}`);
  }

  if (skills) {
    parts.push(`Skills: ${skills}`);
  }

  if (companyDescription) {
    parts.push(`Company: ${companyDescription}`);
  }

  if (listingType) {
    parts.push(`Listing type: ${listingType}`);
  }

  if (parts.length === 0) {
    return site ? `Description unavailable from ${site}.` : '';
  }

  return parts.join('\n');
}

function buildUnifiedJob(job) {
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    job_type: job.job_type,
    salary_min: job.salary_min,
    salary_max: job.salary_max,
    equity: job.equity,
    posted_at: job.posted_at,
    description: job.description,
    apply_url: job.apply_url,
    source: job.source,
    raw: job.raw,
  };
}

function normalizeLinkedInItem(item) {
  return buildUnifiedJob({
    id: firstNonEmpty(item.id, item.jobId, item.jobUrl, item.link, item.url),
    title: firstNonEmpty(item.jobTitle, item.title),
    company: firstNonEmpty(item.companyName, item.company, item.companyTitle),
    location: toLocationString(item.location),
    job_type: normalizeJobType(item.employmentType || item.contractType || item.workType),
    salary_min: null,
    salary_max: null,
    equity: null,
    posted_at: toPostedAtIso(item.publishedAt, item.postedAt, item.postedTime, item.postedDate, item.scrapedAt),
    description: firstNonEmpty(item.descriptionText, item.description, item.descriptionHtml),
    apply_url: firstNonEmpty(item.externalApplyLink, item.applyUrl, item.jobUrl, item.link, item.url),
    source: 'linkedin',
    raw: item,
  });
}

function normalizeIndeedItem(item) {
  const jobType = Array.isArray(item.jobType) ? item.jobType[0] : item.jobType;
  const salary = item.salary && typeof item.salary === 'object' ? item.salary : {};
  const id = firstNonEmpty(item.id, item.jobKey, item.jobUrl, item.url);
  const title = firstNonEmpty(item.positionName, item.title);
  const company = firstNonEmpty(item.company, item.companyName);
  const applyUrl = firstNonEmpty(item.externalApplyLink, item.applyUrl, item.jobUrl, item.url);

  if (!id || !title || !company || !applyUrl || normalizeText(item.error)) {
    return null;
  }

  return buildUnifiedJob({
    id,
    title,
    company,
    location: toLocationString(item.location || item.formattedLocation),
    job_type: normalizeJobType(jobType),
    salary_min: toNumberOrNull(item.salaryMin || item.minSalary || salary.salaryMin || item.salary),
    salary_max: toNumberOrNull(item.salaryMax || item.maxSalary || salary.salaryMax),
    equity: null,
    posted_at: toPostedAtIso(item.postingDateParsed, item.datePublished, item.postedAt, item.datePosted, item.age, item.scrapedAt),
    description: firstNonEmpty(item.description, item.descriptionText, item.snippet, item.descriptionHTML, item.descriptionHtml),
    apply_url: applyUrl,
    source: 'indeed',
    raw: item,
  });
}

function normalizeJobBoardItem(item) {
  return buildUnifiedJob({
    id: firstNonEmpty(item.id, item.job_id, item.job_url, item.job_url_direct),
    title: firstNonEmpty(item.title, item.job_title),
    company: firstNonEmpty(item.company, item.company_name),
    location: toLocationString(item.location),
    job_type: normalizeJobType(item.job_type || item.jobType),
    salary_min: toNumberOrNull(item.salary_min || item.salaryMin),
    salary_max: toNumberOrNull(item.salary_max || item.salaryMax),
    equity: null,
    posted_at: toPostedAtIso(item.date_posted, item.posted_at, item.postedAt),
    description: firstNonEmpty(item.description, item.job_summary, formatJobBoardFallbackDescription(item)),
    apply_url: firstNonEmpty(item.job_url_direct, item.job_url, item.url),
    source: 'jobboard',
    raw: item,
  });
}

function normalizeWellfoundItem(item) {
  return buildUnifiedJob({
    id: firstNonEmpty(item.id, item.jobId, item.portalUrl, item.detailUrl),
    title: firstNonEmpty(item.title, item.primaryRoleTitle),
    company: firstNonEmpty(item.companyName),
    location: toLocationString(item.locationNames),
    job_type: normalizeJobType(item.jobType),
    salary_min: toNumberOrNull(item.salaryMin),
    salary_max: toNumberOrNull(item.salaryMax),
    equity: formatEquity(item.salaryEquityMin, item.salaryEquityMax),
    posted_at: toPostedAtIso(item.postedAt, item.datePosted),
    description: firstNonEmpty(item.description),
    apply_url: firstNonEmpty(item.directApply, item.detailUrl, item.portalUrl),
    source: 'wellfound',
    raw: item,
  });
}

function normalizeLeverItem(item) {
  const salary = item.salary && typeof item.salary === 'object' ? item.salary : {};
  const company = item.company && typeof item.company === 'object' ? item.company : {};

  return buildUnifiedJob({
    id: firstNonEmpty(item.id, item.sourceId, item.jobUrl, item.applyUrl),
    title: firstNonEmpty(item.title),
    company: firstNonEmpty(company.name, item.companyName, item.company),
    location: toLocationString(item.location),
    job_type: normalizeJobType(item.employmentType || item.employmentTypeRaw),
    salary_min: toNumberOrNull(salary.min || salary.minimum || salary.minAmount),
    salary_max: toNumberOrNull(salary.max || salary.maximum || salary.maxAmount),
    equity: null,
    posted_at: toPostedAtIso(item.publishedAt, item.createdAt, item.updatedAt),
    description: firstNonEmpty(item.description, item.descriptionSnippet, item.descriptionHtml),
    apply_url: firstNonEmpty(item.applyUrl, item.jobUrl),
    source: 'lever',
    raw: item.raw && typeof item.raw === 'object' ? item.raw : item,
  });
}

function normalizeHiringCafeItem(item) {
  const jobInformation = item && item.job_information && typeof item.job_information === 'object'
    ? item.job_information
    : {};
  const jobData = item && item.v5_processed_job_data && typeof item.v5_processed_job_data === 'object'
    ? item.v5_processed_job_data
    : {};
  const companyData = item && item.v5_processed_company_data && typeof item.v5_processed_company_data === 'object'
    ? item.v5_processed_company_data
    : {};
  const location = firstNonEmpty(
    jobData.formatted_workplace_location,
    item.formatted_workplace_location,
    item.location
  ) || [
    item.workplaceType,
    ...toStringArray(item.workplaceCities),
    ...toStringArray(item.workplaceStates),
    ...toStringArray(item.workplaceCountries),
  ].filter(Boolean).join(', ');
  const commitment = firstNonEmpty(
    item.commitment_type,
    item.commitment,
    Array.isArray(jobData.commitment) ? jobData.commitment[0] : jobData.commitment
  );

  return buildUnifiedJob({
    id: firstNonEmpty(item.id, item.job_url, item.apply_url, item.applyUrl),
    title: firstNonEmpty(item.title, jobInformation.title, jobData.core_job_title),
    company: firstNonEmpty(item.company_name, item.companyName, item.company, jobData.company_name, companyData.name, item.source),
    location: toLocationString(location),
    job_type: normalizeJobType(commitment),
    salary_min: toNumberOrNull(jobData.yearly_min_compensation || item.yearly_min_compensation || item.salaryMin),
    salary_max: toNumberOrNull(jobData.yearly_max_compensation || item.yearly_max_compensation || item.salaryMax),
    equity: null,
    posted_at: toPostedAtIso(
      item.posted_at,
      item.date_posted,
      item.created_at,
      jobData.estimated_publish_date,
      item.scrapedAt
    ),
    description: firstNonEmpty(item.description, jobInformation.description, jobData.requirements_summary),
    apply_url: firstNonEmpty(item.apply_url, item.applyUrl, item.job_url, item.url),
    source: 'hiringcafe',
    raw: item,
  });
}

function normalizeLinkedInItems(items) {
  return (items || []).map(normalizeLinkedInItem);
}

function normalizeIndeedItems(items) {
  return (items || [])
    .map(normalizeIndeedItem)
    .filter(Boolean);
}

function normalizeJobBoardItems(items) {
  return (items || []).map(normalizeJobBoardItem);
}

function normalizeWellfoundItems(items) {
  return (items || []).map(normalizeWellfoundItem);
}

function normalizeLeverItems(items) {
  return (items || []).map(normalizeLeverItem);
}

function normalizeHiringCafeItems(items) {
  return (items || []).map(normalizeHiringCafeItem);
}

module.exports = {
  normalizeLinkedInItems,
  normalizeIndeedItems,
  normalizeJobBoardItems,
  normalizeWellfoundItems,
  normalizeLeverItems,
  normalizeHiringCafeItems,
};
