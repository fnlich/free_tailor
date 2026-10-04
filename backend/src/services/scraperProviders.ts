import type { EnvSource } from '../config/envValue';
import {
  apifyActorId,
  apifyProxyGroups,
  apifyRunTimeoutS,
  scraperCountry,
  scraperDefaultLocation,
  scraperMaxResults,
  type ApifyActorVariable,
} from '../config/operational';

const {
  runIndeedScraper,
  runJobBoardScraper,
  runWellfoundScraper,
  runLeverScraper,
  runHiringCafeScraper,
  runHiringCafeCrawlerbrosScraper,
  runHiringCafeMemo23Scraper,
} = require('../../scrapers');
const {
  INDEED_MAX_ITEMS_PER_SEARCH,
  JOB_BOARD_MAX_RESULTS,
  MEMO23_MAX_ITEMS,
}: {
  INDEED_MAX_ITEMS_PER_SEARCH: number;
  JOB_BOARD_MAX_RESULTS: number;
  MEMO23_MAX_ITEMS: number;
} = require('../../scrapers/filters');

export const SCRAPER_SOURCES = ['indeed', 'jobboard', 'wellfound', 'lever', 'hiringcafe'] as const;
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
  /**
   * The most results one run of this provider returns: the actor's own limit
   * or SCRAPER_MAX_RESULTS, whichever is lower, and null when there is neither.
   * The jobs page offers no larger count than this.
   */
  maxResults: number | null;
};

export type ScraperSourceProviderCatalog = {
  source: ScraperSource;
  defaultProviderId: string;
  providers: ScraperProviderSummary[];
};

/**
 * GET /api/jobs/scrapers/providers: the providers, and the deployment settings
 * the jobs page needs to describe a run.
 *
 * SERVED rather than mirrored as NEXT_PUBLIC_ values: the server is what applies
 * them, and a copy compiled into the bundle could only disagree with it after
 * the next edit to `.env`.
 */
export type ScraperCatalog = {
  /** SCRAPER_DEFAULT_LOCATION: what an empty location searches, and the form's initial value. */
  defaultLocation: string;
  /** APIFY_RUN_TIMEOUT_S: how long one run - and so the request - may take. */
  runTimeoutS: number;
  sources: ScraperSourceProviderCatalog[];
};

/**
 * What one run is told about the deployment. The scrapers are CommonJS and read
 * no environment; scrapers/settings.js documents each field and checks it.
 */
export type ScraperRunSettings = {
  actorId: string;
  runTimeoutS: number;
  proxyGroups: string[];
  country: string;
  defaultLocation: string;
  maxResults: number | null;
};

type ScraperRunner = (filters: UnifiedScraperFilters, settings: ScraperRunSettings) => Promise<UnifiedScraperJob[]>;

type ScraperProviderDefinition = Omit<ScraperProviderSummary, 'maxResults'> & {
  /** The APIFY_ACTOR_* variable that names the actor this provider runs. */
  actorVariable: ApifyActorVariable;
  /** The actor's own per-run result limit (scrapers/filters.js), or null when it has none. */
  actorMaxResults: number | null;
  runner: ScraperRunner;
};

export type ResolvedScraperProvider = ScraperProviderSummary & {
  run: (filters: UnifiedScraperFilters) => Promise<UnifiedScraperJob[]>;
};

const SCRAPER_PROVIDER_REGISTRY: Record<ScraperSource, { defaultProviderId: string; providers: ScraperProviderDefinition[] }> = {
  indeed: {
    defaultProviderId: 'apify-misceres',
    providers: [
      {
        id: 'apify-misceres',
        label: 'Apify: Misceres',
        description: 'Dedicated Indeed scraper that runs from a pasted Indeed start URL.',
        actorVariable: 'APIFY_ACTOR_INDEED',
        actorMaxResults: INDEED_MAX_ITEMS_PER_SEARCH,
        runner: runIndeedScraper,
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
        actorVariable: 'APIFY_ACTOR_JOBBOARD',
        actorMaxResults: JOB_BOARD_MAX_RESULTS,
        runner: runJobBoardScraper,
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
        actorVariable: 'APIFY_ACTOR_WELLFOUND',
        actorMaxResults: null,
        runner: runWellfoundScraper,
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
        actorVariable: 'APIFY_ACTOR_LEVER',
        actorMaxResults: null,
        runner: runLeverScraper,
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
        actorVariable: 'APIFY_ACTOR_HIRINGCAFE',
        actorMaxResults: null,
        runner: runHiringCafeScraper,
      },
      {
        id: 'apify-crawlerbros',
        label: 'Apify: CrawlerBros',
        description: 'Alternative Hiring Cafe actor with a broader structured output schema.',
        actorVariable: 'APIFY_ACTOR_HIRINGCAFE_CRAWLERBROS',
        actorMaxResults: null,
        runner: runHiringCafeCrawlerbrosScraper,
      },
      {
        id: 'apify-memo23',
        label: 'Apify: memo23',
        description: 'Alternative Hiring Cafe actor that runs from a pasted Hiring Cafe start URL and returns richer nested job metadata.',
        actorVariable: 'APIFY_ACTOR_HIRINGCAFE_MEMO23',
        actorMaxResults: MEMO23_MAX_ITEMS,
        runner: runHiringCafeMemo23Scraper,
      },
    ],
  },
};

export function isSupportedScraperSource(value: string): value is ScraperSource {
  return SCRAPER_SOURCES.includes(value as ScraperSource);
}

/** The smallest of the limits that are set, or null when none is. */
function smallestLimit(...limits: Array<number | null>): number | null {
  const set = limits.filter((limit): limit is number => limit !== null);
  return set.length > 0 ? Math.min(...set) : null;
}

/**
 * The deployment's settings for one run of the actor named by `actorVariable`.
 *
 * Read on every run, not once at boot: nothing is built from them, so a later
 * read cannot leave anything stale, and a test can hand in its own environment.
 * The getters warn once per variable about junk, so a run per request does not
 * repeat the warning.
 */
export function resolveScraperRunSettings(
  actorVariable: ApifyActorVariable,
  env: EnvSource = process.env
): ScraperRunSettings {
  return {
    actorId: apifyActorId(actorVariable, env),
    runTimeoutS: apifyRunTimeoutS(env),
    proxyGroups: apifyProxyGroups(env),
    country: scraperCountry(env),
    defaultLocation: scraperDefaultLocation(env),
    maxResults: scraperMaxResults(env),
  };
}

function summarizeProvider(provider: ScraperProviderDefinition, cap: number | null): ScraperProviderSummary {
  return {
    id: provider.id,
    label: provider.label,
    description: provider.description,
    maxResults: smallestLimit(provider.actorMaxResults, cap),
  };
}

export function listScraperProviderCatalog(env: EnvSource = process.env): ScraperSourceProviderCatalog[] {
  const cap = scraperMaxResults(env);
  return SCRAPER_SOURCES.map((source) => ({
    source,
    defaultProviderId: SCRAPER_PROVIDER_REGISTRY[source].defaultProviderId,
    providers: SCRAPER_PROVIDER_REGISTRY[source].providers.map((provider) => summarizeProvider(provider, cap)),
  }));
}

/** The body of GET /api/jobs/scrapers/providers. */
export function describeScraperCatalog(env: EnvSource = process.env): ScraperCatalog {
  return {
    defaultLocation: scraperDefaultLocation(env),
    runTimeoutS: apifyRunTimeoutS(env),
    sources: listScraperProviderCatalog(env),
  };
}

/**
 * The provider a run uses, ready to run with this deployment's settings.
 *
 * `env` is read when `run` is called, so the settings are the ones in force for
 * that run.
 */
export function resolveScraperProvider(
  source: ScraperSource,
  providerId?: string,
  env: EnvSource = process.env
): ResolvedScraperProvider {
  const sourceRegistry = SCRAPER_PROVIDER_REGISTRY[source];
  // A source the registry does not have used to crash here reading
  // `defaultProviderId` off undefined - a TypeError from inside a service,
  // where the caller had passed a name that simply is not one of ours. Removing
  // LinkedIn is exactly when that happens: a saved request, a bookmarked page
  // or an old client still names it.
  if (!sourceRegistry) {
    throw new Error(
      `Unknown scraper source "${source}". Supported sources are ${SCRAPER_SOURCES.join(', ')}.`
    );
  }

  const effectiveProviderId = providerId?.trim() || sourceRegistry.defaultProviderId;
  const provider = sourceRegistry.providers.find((entry) => entry.id === effectiveProviderId);

  if (!provider) {
    throw new Error(`Unknown scraper provider "${effectiveProviderId}" for source "${source}".`);
  }

  return {
    ...summarizeProvider(provider, scraperMaxResults(env)),
    run: (filters: UnifiedScraperFilters) =>
      provider.runner(filters, resolveScraperRunSettings(provider.actorVariable, env)),
  };
}
