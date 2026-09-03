import { ApifyClient } from 'apify-client';

const LINKEDIN_APIFY_ACTOR_ID = 'curious_coder/linkedin-jobs-scraper';
const LINKEDIN_US_LOCATION = 'United States';
const LINKEDIN_REMOTE_WORKPLACE_TYPE = '2';
const LINKEDIN_DEFAULT_LIMIT = 1000;
const LINKEDIN_MAX_LIMIT = 1000;

const POSTED_SINCE_SECONDS: Record<LinkedInPostedSince, number> = {
  'past-24-hours': 24 * 60 * 60,
  'past-week': 7 * 24 * 60 * 60,
  'past-month': 30 * 24 * 60 * 60,
};

const LINKEDIN_RELATED_KEYWORD_GROUPS: Array<{
  triggers: RegExp[];
  relatedTitles: string[];
}> = [
  {
    triggers: [
      /\bsoftware\b.*\b(engineer|developer)\b/i,
      /\b(engineer|developer)\b.*\bsoftware\b/i,
      /\bswe\b/i,
      /\bprogrammer\b/i,
    ],
    relatedTitles: [
      'software engineer',
      'software engineer i',
      'software engineer ii',
      'software engineer iii',
      'software engineer new grad',
      'software engineer intern',
      'junior software engineer',
      'mid-level software engineer',
      'senior software engineer',
      'staff software engineer',
      'principal software engineer',
      'distinguished software engineer',
      'lead software engineer',
      'software engineering manager',
      'director of software engineering',
      'vp of software engineering',
      'software developer',
      'frontend software engineer',
      'backend developer',
      'backend engineer',
      'backend software engineer',
      'full stack developer',
      'full stack engineer',
      'full stack software engineer',
      'mobile software engineer',
      'ios software engineer',
      'android software engineer',
      'embedded software engineer',
      'systems software engineer',
      'software engineer infrastructure',
      'platform engineer',
      'software engineer platform',
      'software engineer data',
      'software engineer ml',
      'software engineer ai',
      'software engineer security',
      'software engineer developer experience',
      'software engineer devex',
      'software engineer reliability',
      'software engineer growth',
      'software engineer payments',
      'software engineer core product',
      'site reliability engineer',
      'devops engineer',
      'cloud engineer',
      'infrastructure engineer',
      'solutions engineer',
      'application engineer',
      'integration engineer',
      'build and release engineer',
      'build release engineer',
      'qa software engineer',
      'automation engineer',
      'test engineer',
      'security engineer',
      'machine learning engineer',
      'ai engineer',
      'data engineer',
      'computer vision engineer',
      'nlp engineer',
      'robotics software engineer',
      'game engineer',
      'software engineer games',
      'firmware engineer',
      'graphics engineer',
      'java developer',
      'python developer',
      'c++ engineer',
      'support engineer',
      'software development engineer',
      'sde',
      'software development engineer in test',
      'sdet',
      'technical lead',
      'technical program manager',
      'software architect',
      'enterprise software engineer',
      'erp software engineer',
      'sap software engineer',
      'oracle software engineer',
    ],
  },
];

export type LinkedInPostedSince = 'past-24-hours' | 'past-week' | 'past-month';

export interface LinkedInJobCriteria {
  label: string;
  value: string;
}

export interface LinkedInJobResult {
  id: string;
  title: string;
  company: string;
  jobId: string | null;
  jobTitle: string | null;
  companyName: string | null;
  companyLogo: string | null;
  companyWebsite: string | null;
  location: string | null;
  postedAtText: string;
  postedAtIso: string | null;
  link: string | null;
  jobUrl: string;
  applyUrl: string | null;
  easyApply: boolean | null;
  descriptionText: string | null;
  postedAt: string | null;
  externalApplyUrl: string | null;
  applyText: string;
  workplaceType: string;
  employmentType: string | null;
  experienceLevel: string | null;
  seniorityLevel: string;
  workplaceTypes: string[] | null;
  jobFunction: string;
  industries: string;
  sector: string | null;
  description: string;
  insights: string[];
  criteria: LinkedInJobCriteria[];
}

export interface LinkedInJobSearchInput {
  keywords: string;
  postedSince?: LinkedInPostedSince;
  limit?: number;
  onJobCollected?: (job: LinkedInJobResult) => Promise<void> | void;
}

export interface LinkedInJobSearchResult {
  fetchedAt: string;
  filters: {
    keywords: string;
    postedSince: LinkedInPostedSince;
    location: string;
    workplaceType: 'remote';
    excludeEasyApply: true;
    limit: number;
  };
  results: LinkedInJobResult[];
}

export function hasLinkedInExternalApplyUrl(job: LinkedInJobResult): boolean {
  return typeof job.externalApplyUrl === 'string' && job.externalApplyUrl.trim().length > 0;
}

type ApifyLinkedInActorInput = {
  urls: string[];
  count: number;
  proxy: {
    useApifyProxy: boolean;
  };
};

type ApifyActorRunLike = {
  id?: string;
  status?: string;
  statusMessage?: string;
  defaultDatasetId?: string;
};

type ApifyLinkedInJobItem = {
  id?: string | number;
  jobId?: string | number;
  jobTitle?: string;
  title?: string;
  companyName?: string;
  company?: string;
  companyLogo?: string;
  companyWebsite?: string;
  location?: string;
  link?: string;
  jobUrl?: string;
  url?: string;
  externalApplyLink?: string;
  applyUrl?: string;
  easyApply?: boolean;
  description?: string;
  descriptionText?: string;
  descriptionHtml?: string;
  postedAt?: string;
  publishedAt?: string;
  postedTime?: string;
  contractType?: string;
  employmentType?: string;
  experienceLevel?: string;
  seniorityLevel?: string;
  workType?: string;
  jobFunction?: string;
  sector?: string;
  industries?: string;
  applyType?: string;
  workplaceTypes?: string[] | string;
};

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function normalizeStringLike(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = normalizeText(value);
    return normalized || null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }

  return null;
}

function normalizeOptionalUrl(value: unknown): string | null {
  const normalizedValue = normalizeStringLike(value);
  return normalizedValue ? toAbsoluteUrl(normalizedValue) : null;
}

function normalizeOptionalBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }

  if (value === 'true' || value === 1) {
    return true;
  }

  if (value === 'false' || value === 0) {
    return false;
  }

  return null;
}

function normalizeOptionalTextArray(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const normalizedItems = value
      .map((item) => normalizeStringLike(item))
      .filter((item): item is string => Boolean(item));
    return normalizedItems.length > 0 ? normalizedItems : null;
  }

  const normalizedValue = normalizeStringLike(value);
  return normalizedValue ? [normalizedValue] : null;
}

function normalizeLinkedInKeywords(value: unknown): string {
  return normalizeText(value).replace(/^['"]+|['"]+$/g, '');
}

function toAbsoluteUrl(value: string): string {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) {
    return '';
  }

  try {
    return new URL(normalizedValue).toString();
  } catch {
    return normalizedValue;
  }
}

function buildCriteria(items: Array<{ label: string; value: string | null }>): LinkedInJobCriteria[] {
  return items.filter((item): item is LinkedInJobCriteria => Boolean(item.label && item.value));
}

function buildInsights(criteria: LinkedInJobCriteria[]): string[] {
  return criteria.map((item) => `${item.label}: ${item.value}`);
}

function formatApifyPostedAtText(item: ApifyLinkedInJobItem): string {
  return normalizeText(item.postedTime) || normalizeText(item.postedAt) || normalizeText(item.publishedAt);
}

export function mapApifyLinkedInJobItem(item: ApifyLinkedInJobItem): LinkedInJobResult | null {
  const rawJobId = normalizeStringLike(item.id);
  const rawJobTitle = normalizeStringLike(item.title);
  const rawCompanyName = normalizeStringLike(item.companyName);
  const rawCompanyLogo = normalizeOptionalUrl(item.companyLogo);
  const rawCompanyWebsite = normalizeOptionalUrl(item.companyWebsite);
  const rawLocation = normalizeStringLike(item.location);
  const rawLink = normalizeOptionalUrl(item.link);
  const rawApplyUrl = normalizeOptionalUrl(item.applyUrl);
  const rawEasyApply = normalizeOptionalBoolean(item.easyApply);
  const rawDescriptionText = normalizeStringLike(item.descriptionText);
  const rawPostedAt = normalizeStringLike(item.postedAt);
  const rawEmploymentType = normalizeStringLike(item.employmentType);
  const rawExperienceLevel = normalizeStringLike(item.seniorityLevel);
  const rawWorkplaceTypes = normalizeOptionalTextArray(item.workplaceTypes);
  const rawSector = normalizeStringLike(item.industries);

  const title = normalizeText(item.jobTitle) || normalizeText(item.title);
  const company = normalizeText(item.companyName) || normalizeText(item.company);
  const jobUrl = toAbsoluteUrl(normalizeText(item.jobUrl) || normalizeText(item.link) || normalizeText(item.url));
  const id = normalizeText(String(item.id ?? item.jobId ?? '')) || jobUrl;

  if (!id || !title || !company || !jobUrl) {
    return null;
  }

  const location = rawLocation;
  const postedAtIso = normalizeStringLike(item.publishedAt) || rawPostedAt;
  const externalApplyLink = normalizeOptionalUrl(item.externalApplyLink) || rawApplyUrl;
  const employmentType = rawEmploymentType;
  const seniorityLevel = normalizeText(item.experienceLevel) || normalizeText(item.seniorityLevel);
  const jobFunction = normalizeText(item.jobFunction) || normalizeText(item.workType);
  const industries = normalizeText(item.industries) || normalizeText(item.sector);
  const criteria = buildCriteria([
    { label: 'Employment type', value: employmentType },
    { label: 'Seniority level', value: seniorityLevel },
    { label: 'Job function', value: jobFunction },
    { label: 'Industries', value: industries },
  ]);

  return {
    id,
    title,
    company,
    jobId: rawJobId,
    jobTitle: rawJobTitle,
    companyName: rawCompanyName,
    companyLogo: rawCompanyLogo,
    companyWebsite: rawCompanyWebsite,
    location,
    postedAtText: formatApifyPostedAtText(item),
    postedAtIso,
    link: rawLink,
    jobUrl,
    applyUrl: rawApplyUrl,
    easyApply: rawEasyApply,
    descriptionText: rawDescriptionText,
    postedAt: rawPostedAt,
    externalApplyUrl: externalApplyLink,
    applyText: 'Apply',
    workplaceType: 'Remote',
    employmentType,
    experienceLevel: rawExperienceLevel,
    seniorityLevel,
    workplaceTypes: rawWorkplaceTypes,
    jobFunction,
    industries,
    sector: rawSector,
    description: normalizeText(item.description) || normalizeText(item.descriptionText) || normalizeText(item.descriptionHtml),
    insights: buildInsights(criteria).slice(0, 10),
    criteria,
  };
}

export function normalizeLinkedInLimit(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number.parseInt(value, 10)
        : NaN;

  if (!Number.isFinite(parsed)) {
    return LINKEDIN_DEFAULT_LIMIT;
  }

  return Math.max(1, Math.min(LINKEDIN_MAX_LIMIT, parsed));
}

export function resolveLinkedInPostedSince(value: unknown): LinkedInPostedSince {
  const normalized = normalizeLinkedInKeywords(value).toLowerCase();

  if (normalized === 'past-week' || normalized === 'week' || normalized === '1-week') {
    return 'past-week';
  }

  if (normalized === 'past-month' || normalized === 'month' || normalized === '1-month') {
    return 'past-month';
  }

  return 'past-24-hours';
}

export function expandLinkedInSearchKeywords(keywords: string): string[] {
  const normalizedKeywords = normalizeLinkedInKeywords(keywords);

  if (!normalizedKeywords) {
    return [];
  }

  const expandedKeywords = [normalizedKeywords];

  for (const group of LINKEDIN_RELATED_KEYWORD_GROUPS) {
    if (group.triggers.some((trigger) => trigger.test(normalizedKeywords))) {
      expandedKeywords.push(...group.relatedTitles);
    }
  }

  return [...new Set(expandedKeywords.map((value) => normalizeLinkedInKeywords(value)).filter(Boolean))];
}

export function buildLinkedInJobSearchUrl(input: {
  keywords: string;
  postedSince: LinkedInPostedSince;
}): string {
  const url = new URL('https://www.linkedin.com/jobs/search/');
  url.searchParams.set('keywords', normalizeLinkedInKeywords(input.keywords));
  url.searchParams.set('location', LINKEDIN_US_LOCATION);
  url.searchParams.set('f_WT', LINKEDIN_REMOTE_WORKPLACE_TYPE);
  url.searchParams.set('f_TPR', `r${POSTED_SINCE_SECONDS[input.postedSince]}`);
  url.searchParams.set('sortBy', 'DD');
  return url.toString();
}

export function buildLinkedInApifyActorInput(input: {
  keywords: string;
  postedSince: LinkedInPostedSince;
  limit: number;
}): ApifyLinkedInActorInput {
  const expandedKeywords = expandLinkedInSearchKeywords(input.keywords);

  return {
    urls: expandedKeywords.map((keyword) => buildLinkedInJobSearchUrl({
      keywords: keyword,
      postedSince: input.postedSince,
    })),
    count: input.limit,
    proxy: {
      useApifyProxy: true,
    },
  };
}

function createApifyClient(): ApifyClient {
  const token = normalizeText(process.env.APIFY_API_KEY);
  if (!token) {
    throw new Error('APIFY_API_KEY is required to scrape LinkedIn jobs via Apify.');
  }

  return new ApifyClient({ token });
}

export async function searchLinkedInRemoteJobs(
  input: LinkedInJobSearchInput
): Promise<LinkedInJobSearchResult> {
  const keywords = normalizeLinkedInKeywords(input.keywords);
  const postedSince = resolveLinkedInPostedSince(input.postedSince);
  const limit = normalizeLinkedInLimit(input.limit);

  if (!keywords) {
    throw new Error('Keywords are required.');
  }

  const actorInput = buildLinkedInApifyActorInput({
    keywords,
    postedSince,
    limit,
  });

  if (actorInput.urls.length > 1) {
    console.info(
      `[LinkedIn Jobs] Expanded "${keywords}" into ${actorInput.urls.length} Apify search URLs.`
    );
  }

  const client = createApifyClient();
  let run: ApifyActorRunLike | null = null;

  try {
    run = await client.actor(LINKEDIN_APIFY_ACTOR_ID).call(actorInput) as ApifyActorRunLike;
  } catch (error) {
    console.error('[LinkedIn Jobs] Apify actor call failed.', error);
    throw error instanceof Error
      ? error
      : new Error('Apify LinkedIn actor call failed.');
  }

  if (!run || run.status !== 'SUCCEEDED') {
    console.error('[LinkedIn Jobs] Apify actor run failed.', run);
    throw new Error(
      `Apify LinkedIn actor failed with status ${normalizeText(run?.status) || 'UNKNOWN'}${run?.statusMessage ? `: ${run.statusMessage}` : ''}`
    );
  }

  if (!run.defaultDatasetId) {
    console.error('[LinkedIn Jobs] Apify actor finished without a default dataset.', run);
    throw new Error('Apify LinkedIn actor finished without a result dataset.');
  }

  const dataset = client.dataset(run.defaultDatasetId);
  const { items } = await dataset.listItems();
  const seenJobIds = new Set<string>();
  const results: LinkedInJobResult[] = [];

  for (const rawItem of items as ApifyLinkedInJobItem[]) {
    if (results.length >= limit) {
      break;
    }

    const job = mapApifyLinkedInJobItem(rawItem);
    if (!job || !hasLinkedInExternalApplyUrl(job) || seenJobIds.has(job.id)) {
      continue;
    }

    seenJobIds.add(job.id);
    results.push(job);
    await input.onJobCollected?.(job);
  }

  console.info(
    `[LinkedIn Jobs] Apify actor ${run.id || LINKEDIN_APIFY_ACTOR_ID} returned ${items.length} dataset items; mapped ${results.length} jobs.`
  );

  return {
    fetchedAt: new Date().toISOString(),
    filters: {
      keywords,
      postedSince,
      location: LINKEDIN_US_LOCATION,
      workplaceType: 'remote',
      excludeEasyApply: true,
      limit,
    },
    results,
  };
}
