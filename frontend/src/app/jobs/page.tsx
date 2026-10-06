'use client';

import { FormEvent, useEffect, useState } from 'react';
import { EmptyState, Field, Notice, Page, PageHeader, Pill, Section, Spinner } from '@/components/ui/kit';
import { useAuth } from '@/contexts/AuthContext';
import { sheetApi, type AccountSheet } from '@/lib/sheet';
import { safeJobLink } from '@/lib/sheetRows';
import { chosenTab, DEFAULT_TAB, hasUnreadTabs, sheetTabOptions, unreadTabsNoteFor, type SheetTabListing } from '@/lib/sheetTabs';
import {
  importApi,
  jobsApi,
  ScraperExportResponse,
  ScraperJob,
  ScraperJobType,
  ScraperRunResponse,
  ScraperSource,
  ScraperSourceProviderCatalog,
  ScraperTimePosted,
} from '@/lib/api';
import { formatRunTimeout, limitOptionsFor, readScraperSettings, resultCapFor } from '@/lib/scraperForm';
import { messageWithDetail } from '@/lib/userMessage';

const SCRAPER_OPTIONS: Array<{
  value: ScraperSource;
  label: string;
  badge: string;
  description: string;
}> = [
  {
    value: 'indeed',
    label: 'Indeed',
    badge: 'Indeed',
    description: 'Dedicated Indeed job scraping from a pasted Indeed start URL.',
  },
  {
    value: 'jobboard',
    label: 'Job Board',
    badge: 'Job Board',
    description: 'Multi-board run across LinkedIn, Indeed, Glassdoor, Google Jobs, and ZipRecruiter.',
  },
  {
    value: 'wellfound',
    label: 'Wellfound',
    badge: 'Wellfound',
    description: 'Startup jobs from Wellfound with salary and equity when available.',
  },
  {
    value: 'lever',
    label: 'Lever',
    badge: 'Lever',
    description: 'Lever-hosted job boards across hundreds of companies.',
  },
  {
    value: 'hiringcafe',
    label: 'Hiring Cafe',
    badge: 'Hiring Cafe',
    description: 'Hiring.Cafe aggregated jobs with location, commitment type, and posted-date filtering.',
  },
];

const TIME_POSTED_OPTIONS: Array<{ value: ScraperTimePosted; label: string }> = [
  { value: '24h', label: 'Past 24 hours' },
  { value: '3d', label: 'Past 3 days' },
  { value: '7d', label: 'Past 7 days' },
  { value: '30d', label: 'Past 30 days' },
];

const JOB_TYPE_OPTIONS: Array<{ value: ScraperJobType; label: string }> = [
  { value: 'full-time', label: 'Full-time' },
  { value: 'part-time', label: 'Part-time' },
  { value: 'contract', label: 'Contract' },
  { value: 'internship', label: 'Internship' },
  { value: 'temporary', label: 'Temporary' },
];

function formatFetchedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatPostedDate(value: string | null): string {
  if (!value) return '';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
  }).format(date);
}

function truncateDescription(value: string, maxLength = 420): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength).trimEnd()}...`;
}

function formatSourceLabel(source: ScraperSource): string {
  return SCRAPER_OPTIONS.find((option) => option.value === source)?.badge ?? source;
}

function formatSalaryRange(job: ScraperJob): string | null {
  if (job.salary_min === null && job.salary_max === null) {
    return null;
  }

  if (job.salary_min !== null && job.salary_max !== null) {
    return `$${job.salary_min.toLocaleString()} - $${job.salary_max.toLocaleString()}`;
  }

  const value = job.salary_min ?? job.salary_max;
  return value === null ? null : `$${value.toLocaleString()}`;
}

function getJobMeta(job: ScraperJob): string[] {
  return [job.company, job.location, job.job_type].filter(Boolean);
}

function getNativeJobLink(job: ScraperJob): string | null {
  const raw = job.raw ?? {};
  const candidates = [
    raw.jobUrl,
    raw.job_url,
    raw.link,
    raw.url,
    raw.portalUrl,
    raw.detailUrl,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }

  return null;
}

export default function JobsPage() {
  const [source, setSource] = useState<ScraperSource>('indeed');
  const [providerCatalog, setProviderCatalog] = useState<ScraperSourceProviderCatalog[]>([]);
  const [selectedProviders, setSelectedProviders] = useState<Partial<Record<ScraperSource, string>>>({});
  const [keywords, setKeywords] = useState('');
  const [startUrl, setStartUrl] = useState('');
  /**
   * Starts empty and is filled with the server's SCRAPER_DEFAULT_LOCATION once
   * the provider catalog arrives. An empty location is also what tells the
   * server to use that default, so a run made before the catalog loads (or when
   * it fails to) searches the same market.
   */
  const [location, setLocation] = useState('');
  const [defaultLocation, setDefaultLocation] = useState<string | null>(null);
  const [runTimeoutS, setRunTimeoutS] = useState<number | null>(null);
  const [timePosted, setTimePosted] = useState<ScraperTimePosted>('24h');
  const [jobType, setJobType] = useState<ScraperJobType | ''>('');
  const [remoteOnly, setRemoteOnly] = useState(true);
  const [limit, setLimit] = useState(250);
  const { account } = useAuth();
  const isAdmin = account?.role === 'admin';
  const [accountSheet, setAccountSheet] = useState<AccountSheet | null>(null);
  /**
   * The tabs of the account's own sheet - the only sheet an export writes to
   * (owner decision S1). The rows go after the last one used, A to F, so the
   * tab is all there is to choose; null until listed, or when it could not be.
   */
  const [sheetTabs, setSheetTabs] = useState<SheetTabListing | null>(null);
  /** The tab picked by hand; empty means the sheet's default, All. */
  const [pickedTab, setPickedTab] = useState('');
  const [writeToGoogleSheet, setWriteToGoogleSheet] = useState(false);
  const [results, setResults] = useState<ScraperJob[]>([]);
  const [searchMeta, setSearchMeta] = useState<ScraperRunResponse | null>(null);
  const [exportMeta, setExportMeta] = useState<ScraperExportResponse['export'] | null>(null);
  const [searched, setSearched] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const selectedSource = SCRAPER_OPTIONS.find((option) => option.value === source) ?? SCRAPER_OPTIONS[0];
  const selectedSourceProviderCatalog = providerCatalog.find((entry) => entry.source === source) ?? null;
  const selectedProviderId = selectedProviders[source] ?? selectedSourceProviderCatalog?.defaultProviderId ?? '';
  const selectedProvider =
    selectedSourceProviderCatalog?.providers.find((provider) => provider.id === selectedProviderId) ?? null;
  const isMemo23StartUrlOnlyProvider = source === 'hiringcafe' && selectedProviderId === 'apify-memo23';
  const isIndeedStartUrlOnlySource = source === 'indeed';
  const isStartUrlOnlyScraper = isIndeedStartUrlOnlySource || isMemo23StartUrlOnlyProvider;
  const resultCap = resultCapFor(selectedProvider, isStartUrlOnlyScraper);
  const availableLimitOptions = limitOptionsFor(resultCap);

  useEffect(() => {
    let isMounted = true;

    const loadInitialData = async () => {
      try {
        const [providers, scraperSettings] = await Promise.all([
          jobsApi.getScraperProviders(),
          // A backend older than this endpoint answers 404: the form then runs
          // on the server's defaults without naming them, rather than failing.
          jobsApi.getScraperSettings().catch(() => readScraperSettings(null)),
        ]);
        if (!isMounted) {
          return;
        }

        setProviderCatalog(providers);
        setDefaultLocation(scraperSettings.defaultLocation);
        setRunTimeoutS(scraperSettings.runTimeoutS);
        // Only into an untouched field: whatever the user typed meanwhile wins.
        setLocation((current) => current || scraperSettings.defaultLocation || '');
        setSelectedProviders((current) => {
          const next = { ...current };

          for (const entry of providers) {
            if (!next[entry.source]) {
              next[entry.source] = entry.defaultProviderId;
            }
          }

          return next;
        });
      } catch {
        if (!isMounted) {
          return;
        }

        setProviderCatalog([]);
      }
    };

    void loadInitialData();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (resultCap !== null && limit > resultCap) {
      setLimit(resultCap);
    }
  }, [resultCap, limit]);

  useEffect(() => {
    void (async () => {
      try {
        setAccountSheet(await sheetApi.get());
      } catch {
        // Not fatal: the panel falls back to naming no tab, and the server
        // still resolves the destination on its own.
        setAccountSheet(null);
      }
    })();
    void (async () => {
      try {
        const answer = await importApi.listTabs();
        setSheetTabs({ tabs: answer.tabs ?? [], defaultTab: answer.defaultTab ?? null });
      } catch {
        // Not fatal either: with no tab named, the export writes to All, and
        // a sheet that cannot be reached is refused in the server's words.
        setSheetTabs(null);
      }
    })();
  }, []);

  const tabOptions = sheetTabOptions(sheetTabs?.tabs ?? []);
  const exportTab = chosenTab(sheetTabs, pickedTab);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    setIsLoading(true);
    setError('');

    try {
      let commonPayload: Record<string, string | number | boolean | undefined>;

      if (isStartUrlOnlyScraper) {
        const trimmedStartUrl = startUrl.trim();
        if (!trimmedStartUrl) {
          setError(
            isIndeedStartUrlOnlySource
              ? 'Paste an Indeed start URL before running the search.'
              : 'Paste a Hiring Cafe start URL before running the search.'
          );
          setIsLoading(false);
          return;
        }

        commonPayload = {
          source,
          provider: selectedProviderId || undefined,
          startUrl: trimmedStartUrl,
        };
      } else {
        const trimmedKeywords = keywords.trim();
        if (!trimmedKeywords) {
          setError('Enter a keyword before running a scraper.');
          setIsLoading(false);
          return;
        }

        commonPayload = {
          source,
          provider: selectedProviderId || undefined,
          keywords: trimmedKeywords,
          location: location.trim(),
          timePosted,
          remoteOnly,
          maxResults: limit,
          ...(jobType ? { jobType } : {}),
        };
      }

      let response: ScraperRunResponse;

      if (writeToGoogleSheet) {
        // The account's own sheet, always: the server knows the spreadsheet,
        // the columns (A to F) and the first free row, and the only choice is
        // the tab - All when none is named.
        const exportResponse = await jobsApi.exportScraperToGoogleSheet({
          ...commonPayload,
          source,
          provider: selectedProviderId || undefined,
          ...(exportTab ? { tabName: exportTab } : {}),
        });
        response = exportResponse;
        setExportMeta(exportResponse.export);
      } else {
        response = await jobsApi.runScraper({
          ...commonPayload,
          source,
          provider: selectedProviderId || undefined,
        });
        setExportMeta(null);
      }

      setResults(response.results);
      setSearchMeta(response);
      setSearched(true);
    } catch (err) {
      setResults([]);
      setSearchMeta(null);
      setExportMeta(null);
      setSearched(true);
      setError(messageWithDetail(err, 'Failed to run scraper'));
    } finally {
      setIsLoading(false);
    }
  };

  const searchSummaryValue =
    searchMeta?.filters.keywords || searchMeta?.filters.startUrl || 'custom search';

  return (
    <Page>
      <PageHeader title="Job Search" description="Run job scrapers one source at a time.">
        <div className="flex flex-wrap gap-2">
          {[
            'Independent runs',
            'Source-specific inputs',
            ...(runTimeoutS !== null ? [`${formatRunTimeout(runTimeoutS)} scraper timeout`] : []),
            'Google Sheets export',
          ].map((label) => (
            <Pill key={label} tone="sky">
              {label}
            </Pill>
          ))}
        </div>
      </PageHeader>

      <form onSubmit={handleSubmit}>
        <Section
          title="Job Scrapers"
          description="Pick a source, then fill in what that source takes. Each runs on its own."
        >
          <fieldset disabled={isLoading} className="min-w-0">
            <legend className="tl-label">Category</legend>
            <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {SCRAPER_OPTIONS.map((option) => {
                const isSelected = source === option.value;
                return (
                  <label key={option.value} className="tl-choice" data-on={isSelected}>
                    <input
                      type="radio"
                      name="scraper-source"
                      value={option.value}
                      checked={isSelected}
                      onChange={() => setSource(option.value)}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-ink">{option.label}</span>
                      <span className="mt-0.5 block text-sm text-muted">{option.description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="grid gap-x-4 gap-y-6 md:grid-cols-2 xl:grid-cols-3">
            {/*
              Which scraping service runs a category, and its actor's name, is
              how this installation is run - an administrator's choice. Anybody
              else picks a category and gets its default provider, which is the
              id `selectedProviderId` falls back to without this select.
            */}
            {isAdmin && (
              <Field
                label="Provider"
                htmlFor="jobs-provider"
                hint={selectedProvider ? selectedProvider.description : undefined}
              >
                <select
                  id="jobs-provider"
                  value={selectedProviderId}
                  onChange={(event) =>
                    setSelectedProviders((current) => ({
                      ...current,
                      [source]: event.target.value,
                    }))
                  }
                  className="tl-input"
                  disabled={isLoading || !selectedSourceProviderCatalog || selectedSourceProviderCatalog.providers.length <= 1}
                >
                  {(selectedSourceProviderCatalog?.providers ?? []).map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {isStartUrlOnlyScraper ? (
              <div className="md:col-span-1 xl:col-span-2">
                <Field
                  label="Start URL"
                  htmlFor="jobs-start-url"
                  hint={
                    isIndeedStartUrlOnlySource
                      ? 'Paste an Indeed search URL. The other search options are fixed.'
                      : 'Paste a Hiring Cafe search URL. The other search options are fixed.'
                  }
                >
                  <input
                    id="jobs-start-url"
                    type="url"
                    value={startUrl}
                    onChange={(event) => setStartUrl(event.target.value)}
                    placeholder={isIndeedStartUrlOnlySource ? 'https://www.indeed.com/jobs/?q=...' : 'https://hiring.cafe/?searchState=...'}
                    className="tl-input"
                    disabled={isLoading}
                    required
                  />
                </Field>
              </div>
            ) : (
              <>
                <Field label="Keyword" htmlFor="jobs-keywords">
                  <input
                    id="jobs-keywords"
                    type="text"
                    value={keywords}
                    onChange={(event) => setKeywords(event.target.value)}
                    placeholder="software engineer, data analyst, product manager..."
                    className="tl-input"
                    disabled={isLoading}
                  />
                </Field>

                <Field label="Location" htmlFor="jobs-location">
                  <input
                    id="jobs-location"
                    type="text"
                    value={location}
                    onChange={(event) => setLocation(event.target.value)}
                    placeholder={defaultLocation ? `Leave empty for ${defaultLocation}` : 'City, region or country'}
                    className="tl-input"
                    disabled={isLoading}
                  />
                </Field>

                <Field label="Posted within" htmlFor="jobs-posted-within">
                  <select
                    id="jobs-posted-within"
                    value={timePosted}
                    onChange={(event) => setTimePosted(event.target.value as ScraperTimePosted)}
                    className="tl-input"
                    disabled={isLoading}
                  >
                    {TIME_POSTED_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Job type" htmlFor="jobs-job-type">
                  <select
                    id="jobs-job-type"
                    value={jobType}
                    onChange={(event) => setJobType(event.target.value as ScraperJobType | '')}
                    className="tl-input"
                    disabled={isLoading}
                  >
                    <option value="">Any supported type</option>
                    {JOB_TYPE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field
                  label="Results"
                  htmlFor="jobs-results-limit"
                  hint={resultCap !== null ? `At most ${resultCap} results per run.` : undefined}
                >
                  <select
                    id="jobs-results-limit"
                    value={limit}
                    onChange={(event) => setLimit(Number(event.target.value))}
                    className="tl-input"
                    disabled={isLoading}
                  >
                    {availableLimitOptions.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            {!isStartUrlOnlyScraper && (
              <label className="inline-flex items-center gap-3 text-sm font-medium text-ink">
                <input
                  type="checkbox"
                  checked={remoteOnly}
                  onChange={(event) => setRemoteOnly(event.target.checked)}
                  className="tl-check"
                  disabled={isLoading}
                />
                Remote only
              </label>
            )}

            <label className="inline-flex items-center gap-3 text-sm font-medium text-ink">
              <input
                type="checkbox"
                checked={writeToGoogleSheet}
                onChange={(event) => setWriteToGoogleSheet(event.target.checked)}
                className="tl-check"
                disabled={isLoading}
              />
              Write to Google Sheet
            </label>
          </div>
        </Section>

        <Section
          title="Google Sheets export"
          description="With Write to Google Sheet ticked, the jobs found go into your own job sheet, after the rows already there. Jobs whose company is already in the tab are skipped."
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <Field label="Tab" htmlFor="jobs-export-tab">
                <select
                  id="jobs-export-tab"
                  value={exportTab}
                  onChange={(event) => setPickedTab(event.target.value)}
                  className="tl-input"
                  disabled={isLoading || !exportTab}
                >
                  {!exportTab && (
                    <option value="">{sheetTabs ? 'No job tab to write to' : `${DEFAULT_TAB} (the default)`}</option>
                  )}
                  {/* A tab that is not a job tab - an older build's daily tab, a tab of your own - is listed, not chosen. */}
                  {tabOptions.map((option) => (
                    <option key={option.title} value={option.title} disabled={!option.usable}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
              {sheetTabs && hasUnreadTabs(sheetTabs.tabs) && <p className="mt-2 text-sm text-subtle">{unreadTabsNoteFor(sheetTabs.tabs)}</p>}
            </div>
            <Notice tone="neutral">
              {accountSheet?.configured && accountSheet.spreadsheetUrl ? (
                <>
                  Each job is a row of{' '}
                  <a
                    className="tl-link"
                    href={accountSheet.defaultTabUrl ?? accountSheet.spreadsheetUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    your job sheet
                  </a>
                  : today&apos;s Date and the day&apos;s next NO(DATE), then Company, Job Title, Job Link and Job
                  Description - columns A to F. Columns G to L are the app&apos;s, filled once a posting is
                  analysed.
                </>
              ) : (
                'Each job is a row of your own job sheet: Date, NO(DATE), Company, Job Title, Job Link and Job Description. Settings > Job Sheet has the link.'
              )}
            </Notice>
          </div>
        </Section>

        <div className="flex flex-wrap gap-3 pt-6">
          <button type="submit" disabled={isLoading} className="tl-button">
            {isLoading
              ? writeToGoogleSheet
                ? `Running ${selectedSource.label} and writing to sheet...`
                : `Running ${selectedSource.label}...`
              : writeToGoogleSheet
                ? `Run ${selectedSource.label} + Fill Sheet`
                : `Run ${selectedSource.label}`}
          </button>
        </div>
      </form>

      <div className="mt-8 space-y-4 empty:hidden">
        {error && <Notice tone="error">{error}</Notice>}

        {searchMeta && !error && (
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 text-sm text-muted">
            <span>
              Found <span className="font-semibold text-ink">{results.length}</span> {formatSourceLabel(searchMeta.source)} job
              {results.length === 1 ? '' : 's'} for <span className="font-semibold text-ink">{searchSummaryValue}</span>
              {/* The provider is the actor's name - see the Provider select. */}
              {isAdmin && (
                <>
                  {' '}
                  via <span className="font-semibold text-ink">{searchMeta.providerLabel}</span>
                </>
              )}
              .
            </span>
            <span className="flex flex-wrap gap-x-6 gap-y-1">
              <span>Fetched {formatFetchedAt(searchMeta.fetchedAt)}</span>
              {(searchMeta.filters.rawResultCount ?? 0) > 0 && (
                <span>
                  Raw {searchMeta.filters.rawResultCount}
                  {typeof searchMeta.filters.remoteFilteredCount === 'number' && searchMeta.filters.remoteFilteredCount > 0
                    ? `, filtered out ${searchMeta.filters.remoteFilteredCount} by remote rules`
                    : ''}
                </span>
              )}
            </span>
          </div>
        )}

        {exportMeta && !error && (
          <Notice tone="success">
            <p className="font-semibold">
              Wrote {exportMeta.rowsWritten} job{exportMeta.rowsWritten === 1 ? '' : 's'} to {exportMeta.spreadsheetTitle} /{' '}
              {safeJobLink(exportMeta.tabUrl ?? '') ? (
                <a className="tl-link" href={safeJobLink(exportMeta.tabUrl ?? '')} target="_blank" rel="noreferrer">
                  {exportMeta.selectedTab}
                </a>
              ) : (
                exportMeta.selectedTab
              )}
            </p>
            {exportMeta.rowsWritten > 0 && (
              <p className="mt-1">
                Rows {exportMeta.startRow} to {exportMeta.endRow}
                {exportMeta.date ? `, dated ${exportMeta.date}` : ''}
                {typeof exportMeta.firstNo === 'number' && typeof exportMeta.lastNo === 'number'
                  ? exportMeta.firstNo === exportMeta.lastNo
                    ? `, NO(DATE) ${exportMeta.firstNo}`
                    : `, NO(DATE) ${exportMeta.firstNo} to ${exportMeta.lastNo}`
                  : ''}
                .
              </p>
            )}
            <p className="mt-1">
              {exportMeta.unresolvedJobLinks === 0
                ? 'Every exported row had a usable apply link.'
                : `${exportMeta.unresolvedJobLinks} exported job-link cells were blank because no apply URL was available.`}
            </p>
            {typeof exportMeta.beforeExportResultCount === 'number' && (
              <p className="mt-1">
                {exportMeta.beforeExportResultCount} job{exportMeta.beforeExportResultCount === 1 ? '' : 's'} remained after scraper filtering before sheet duplicate checks.
              </p>
            )}
            <p className="mt-1">
              {exportMeta.skippedCompanyDuplicates === 0
                ? 'No jobs were skipped as duplicates.'
                : `Skipped ${exportMeta.skippedCompanyDuplicates} job${exportMeta.skippedCompanyDuplicates === 1 ? '' : 's'} because the same job already existed in the destination sheet or had already been queued in this run.`}
            </p>
          </Notice>
        )}

        {isLoading && (
          <div className="tl-card">
            <Spinner
              label={
                writeToGoogleSheet
                  ? `Searching ${selectedSource.label}. The jobs are written to Google Sheets once duplicates are filtered out.`
                  : `Searching ${selectedSource.label}...`
              }
            />
          </div>
        )}

        {!isLoading && searched && !error && results.length === 0 && (
          <EmptyState title="No jobs matched this run">
            Try a broader keyword, a wider time window, or a different scraper.
          </EmptyState>
        )}

        {!isLoading && results.length > 0 && (
          // Colours on a .tl-table cell go on an inner element - the unlayered
          // `td` rule beats a utility on the cell itself.
          <div className="tl-table-box">
            <table className="tl-table">
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Details</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {results.map((job) => {
                  const meta = getJobMeta(job);
                  const postedDate = formatPostedDate(job.posted_at);
                  const salaryRange = formatSalaryRange(job);
                  const nativeLink = getNativeJobLink(job);

                  return (
                    <tr key={`${job.source}-${job.id}`} className="align-top">
                      <td className="min-w-[18rem]">
                        <h2 className="text-base font-semibold text-ink">{job.title}</h2>
                        {meta.length > 0 && <p className="mt-1 text-sm text-muted">{meta.join(' • ')}</p>}
                        {job.description && (
                          <p className="mt-2 max-w-3xl text-sm leading-6 text-subtle">
                            {truncateDescription(job.description)}
                          </p>
                        )}
                      </td>
                      <td className="min-w-[11rem]">
                        <div className="flex flex-wrap gap-1.5">
                          <Pill>{formatSourceLabel(job.source)}</Pill>
                          {job.job_type && <Pill tone="sky">{job.job_type}</Pill>}
                          {job.equity && <Pill tone="green">Equity {job.equity}</Pill>}
                          {salaryRange && <Pill tone="amber">{salaryRange}</Pill>}
                        </div>
                        {postedDate && <p className="mt-2 text-xs text-subtle">Posted date {postedDate}</p>}
                      </td>
                      <td>
                        <div className="flex flex-col items-start gap-2">
                          {job.apply_url ? (
                            <a
                              href={job.apply_url}
                              target="_blank"
                              rel="noreferrer"
                              className="tl-button-quiet"
                              data-size="sm"
                            >
                              Open apply link
                            </a>
                          ) : (
                            <span className="whitespace-nowrap text-sm text-subtle">Apply link unavailable</span>
                          )}
                          {nativeLink && nativeLink !== job.apply_url && (
                            <a
                              href={nativeLink}
                              target="_blank"
                              rel="noreferrer"
                              className="tl-button-quiet"
                              data-size="sm"
                            >
                              Open source listing
                            </a>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Page>
  );
}
