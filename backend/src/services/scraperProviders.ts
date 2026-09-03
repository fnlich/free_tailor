const {
  runLinkedInScraper,
  runIndeedScraper,
  runJobBoardScraper,
  runWellfoundScraper,
  runLeverScraper,
  runHiringCafeScraper,
  runHiringCafeCrawlerbrosScraper,
  runHiringCafeMemo23Scraper,
} = require('../../scrapers');

export const SCRAPER_SOURCES = ['linkedin', 'indeed', 'jobboard', 'wellfound', 'lever', 'hiringcafe'] as const;
export type ScraperSource = (typeof SCRAPER_SOURCES)[number];

export type UnifiedScraperFilters = {
  title?: string;
  rows?: number;
  keywords?: string;
  startUrl?: string;
  location?: string;
  timePosted?: '24h' | '3d' | '7d' | '30d';
  jobType?: 'full-time' | 'part-time' | 'contract' | 'internship' | 'temporary';
  remoteOnly?: boolean;
  maxResults?: number;
};

export type UnifiedScraperJob = {
  id: string;
  title: string;
  company: string;
  location: string;
  job_type: string;
  salary_min: number | null;
  salary_max: number | null;
  equity: string | null;
  posted_at: string | null;
  description: string;
  apply_url: string;
  source: ScraperSource;
  raw: Record<string, unknown>;
};

export type ScraperProviderSummary = {
  id: string;
  label: string;
  description: string;
};

export type ScraperSourceProviderCatalog = {
  source: ScraperSource;
  defaultProviderId: string;
  providers: ScraperProviderSummary[];
};

type ScraperProviderDefinition = ScraperProviderSummary & {
  run: (filters: UnifiedScraperFilters) => Promise<UnifiedScraperJob[]>;
};

const SCRAPER_PROVIDER_REGISTRY: Record<ScraperSource, { defaultProviderId: string; providers: ScraperProviderDefinition[] }> = {
  linkedin: {
    defaultProviderId: 'apify-bebity',
    providers: [
      {
        id: 'apify-bebity',
        label: 'Apify: Bebity',
        description: 'Runs bebity/linkedin-jobs-scraper with fixed United States, remote, and past-24-hours filters.',
        run: (filters: UnifiedScraperFilters) => runLinkedInScraper(filters) as Promise<UnifiedScraperJob[]>,
      },
    ],
  },
  indeed: {
    defaultProviderId: 'apify-misceres',
    providers: [
      {
        id: 'apify-misceres',
        label: 'Apify: Misceres',
        description: 'Dedicated Indeed scraper that runs from a pasted Indeed start URL.',
        run: (filters: UnifiedScraperFilters) => runIndeedScraper(filters) as Promise<UnifiedScraperJob[]>,
      },
    ],
  },
  jobboard: {
    defaultProviderId: 'apify-jobboard',
    providers: [
      {
        id: 'apify-jobboard',
        label: 'Apify Job Board',
        description: 'Multi-board community scraper across major public job boards.',
        run: (filters: UnifiedScraperFilters) => runJobBoardScraper(filters) as Promise<UnifiedScraperJob[]>,
      },
    ],
  },
  wellfound: {
    defaultProviderId: 'apify-wellfound',
    providers: [
      {
        id: 'apify-wellfound',
        label: 'Apify Wellfound',
        description: 'Current Wellfound actor integration.',
        run: (filters: UnifiedScraperFilters) => runWellfoundScraper(filters) as Promise<UnifiedScraperJob[]>,
      },
    ],
  },
  lever: {
    defaultProviderId: 'apify-lever',
    providers: [
      {
        id: 'apify-lever',
        label: 'Apify Lever',
        description: 'Current Lever actor integration.',
        run: (filters: UnifiedScraperFilters) => runLeverScraper(filters) as Promise<UnifiedScraperJob[]>,
      },
    ],
  },
  hiringcafe: {
    defaultProviderId: 'apify-manojachari',
    providers: [
      {
        id: 'apify-manojachari',
        label: 'Apify: Manoj Achari',
        description: 'Current Hiring Cafe actor using the internal API and Cloudflare bypass.',
        run: (filters: UnifiedScraperFilters) => runHiringCafeScraper(filters) as Promise<UnifiedScraperJob[]>,
      },
      {
        id: 'apify-crawlerbros',
        label: 'Apify: CrawlerBros',
        description: 'Alternative Hiring Cafe actor with a broader structured output schema.',
        run: (filters: UnifiedScraperFilters) => runHiringCafeCrawlerbrosScraper(filters) as Promise<UnifiedScraperJob[]>,
      },
      {
        id: 'apify-memo23',
        label: 'Apify: memo23',
        description: 'Alternative Hiring Cafe actor that runs from a pasted Hiring Cafe start URL and returns richer nested job metadata.',
        run: (filters: UnifiedScraperFilters) => runHiringCafeMemo23Scraper(filters) as Promise<UnifiedScraperJob[]>,
      },
    ],
  },
};

export function isSupportedScraperSource(value: string): value is ScraperSource {
  return SCRAPER_SOURCES.includes(value as ScraperSource);
}

export function listScraperProviderCatalog(): ScraperSourceProviderCatalog[] {
  return SCRAPER_SOURCES.map((source) => ({
    source,
    defaultProviderId: SCRAPER_PROVIDER_REGISTRY[source].defaultProviderId,
    providers: SCRAPER_PROVIDER_REGISTRY[source].providers.map(({ id, label, description }) => ({
      id,
      label,
      description,
    })),
  }));
}

export function resolveScraperProvider(source: ScraperSource, providerId?: string): ScraperProviderDefinition {
  const sourceRegistry = SCRAPER_PROVIDER_REGISTRY[source];
  const effectiveProviderId = providerId?.trim() || sourceRegistry.defaultProviderId;
  const provider = sourceRegistry.providers.find((entry) => entry.id === effectiveProviderId);

  if (!provider) {
    throw new Error(`Unknown scraper provider "${effectiveProviderId}" for source "${source}".`);
  }

  return provider;
}
