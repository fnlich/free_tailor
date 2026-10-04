'use client';

import { FormEvent, useEffect, useState } from 'react';
import { EmptyState, Field, Notice, Page, PageHeader, Pill, Section, Spinner } from '@/components/ui/kit';
import { useAuth } from '@/contexts/AuthContext';
import {
  parsePositiveWholeNumber,
  parseSpreadsheetColumnInput,
  sheetApi,
  type AccountSheet,
} from '@/lib/sheet';
import {
  adminApi,
  GoogleSheetSource,
  GoogleSheetTab,
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

type SheetExportFormState = {
  sheetId: string;
  tabName: string;
  startRow: string;
  companyNameCol: string;
  jobTitleCol: string;
  jobLinkCol: string;
  jobDescriptionCol: string;
};

const DEFAULT_SHEET_EXPORT_FORM: SheetExportFormState = {
  sheetId: '',
  tabName: '',
  startRow: '2',
  companyNameCol: 'D',
  jobTitleCol: 'E',
  jobLinkCol: 'F',
  jobDescriptionCol: 'G',
};

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
   * Where the scraped rows go.
   *
   * `mine` sends no spreadsheet id, no tab and no columns at all - the backend
   * fills in the account's own sheet, today's tab and the fixed layout. It is
   * the only option an ordinary user has, because the shared sources belong to
   * the administrator who configured them and are not theirs to write into.
   */
  const [exportTarget, setExportTarget] = useState<'mine' | 'shared'>('mine');
  const [sheetExportForm, setSheetExportForm] = useState<SheetExportFormState>(DEFAULT_SHEET_EXPORT_FORM);
  const [sheetSources, setSheetSources] = useState<GoogleSheetSource[]>([]);
  const [sheetTabs, setSheetTabs] = useState<GoogleSheetTab[]>([]);
  const [sheetTitle, setSheetTitle] = useState('');
  const [writeToGoogleSheet, setWriteToGoogleSheet] = useState(false);
  const [results, setResults] = useState<ScraperJob[]>([]);
  const [searchMeta, setSearchMeta] = useState<ScraperRunResponse | null>(null);
  const [exportMeta, setExportMeta] = useState<ScraperExportResponse['export'] | null>(null);
  const [searched, setSearched] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingTabs, setIsLoadingTabs] = useState(false);
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

  const setSheetField = <K extends keyof SheetExportFormState>(field: K, value: SheetExportFormState[K]) => {
    setSheetExportForm((current) => ({ ...current, [field]: value }));
  };

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

  /*
   * The shared sheets belong to the administrator who saved them, and only the
   * administrator's export panel offers them - so only an administrator's page
   * asks for them, from the admin settings that hold them.
   */
  useEffect(() => {
    if (!isAdmin) return;
    let isMounted = true;

    void (async () => {
      try {
        const settings = await adminApi.getSettings();
        if (!isMounted) return;
        setSheetSources(settings.googleSheetsSources);
        setSheetExportForm((current) =>
          current.sheetId.trim()
            ? current
            : { ...current, sheetId: settings.googleSheetsSources[0]?.sheetId ?? '' }
        );
      } catch {
        if (isMounted) setSheetSources([]);
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [isAdmin]);

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
  }, []);

  const handleLoadSheetTabs = async () => {
    const sheetId = sheetExportForm.sheetId.trim();
    if (!sheetId) {
      setError('Enter a Google Sheet ID before loading tabs.');
      return;
    }

    setIsLoadingTabs(true);
    setError('');

    try {
      const response = await importApi.fetchGoogleSheetRange({ sheetId });
      setSheetTitle(response.spreadsheetTitle);
      setSheetTabs(response.tabs);
      setSheetField(
        'tabName',
        response.tabs.some((tab) => tab.title === sheetExportForm.tabName)
          ? sheetExportForm.tabName
          : (response.tabs[0]?.title ?? '')
      );
    } catch (err) {
      setSheetTabs([]);
      setSheetTitle('');
      setError(err instanceof Error ? err.message : 'Failed to load Google Sheet tabs');
    } finally {
      setIsLoadingTabs(false);
    }
  };

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
              ? 'Paste an Indeed start URL before running the Indeed scraper.'
              : 'Paste a Hiring Cafe start URL before running the memo23 scraper.'
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
        // Sending nothing is what selects the account's own sheet: the server
        // knows the spreadsheet, the day's tab and the column layout, and a
        // number typed here could only disagree with them.
        const exportResponse = await jobsApi.exportScraperToGoogleSheet({
          ...commonPayload,
          source,
          provider: selectedProviderId || undefined,
          ...(exportTarget === 'shared'
            ? (() => {
                // An empty picker must not fall through to the account's own
                // sheet: "a shared sheet" and "my sheet" are different
                // destinations, and sending '' silently means the second.
                if (!sheetExportForm.sheetId.trim()) {
                  throw new Error('Choose a shared Google Sheet, or switch back to your own job sheet.');
                }
                if (!sheetExportForm.tabName.trim()) {
                  throw new Error('Choose a tab in the shared Google Sheet.');
                }
                return {
                sheetId: sheetExportForm.sheetId.trim(),
                tabName: sheetExportForm.tabName.trim(),
                startRow: parsePositiveWholeNumber('Start row', sheetExportForm.startRow),
                companyNameCol: parseSpreadsheetColumnInput('Company column', sheetExportForm.companyNameCol),
                jobTitleCol: parseSpreadsheetColumnInput('Job title column', sheetExportForm.jobTitleCol),
                jobLinkCol: parseSpreadsheetColumnInput('Job link column', sheetExportForm.jobLinkCol),
                jobDescriptionCol: parseSpreadsheetColumnInput(
                  'Job description column',
                  sheetExportForm.jobDescriptionCol
                ),
                };
              })()
            : {}),
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
      setError(err instanceof Error ? err.message : 'Failed to run scraper');
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

            {isStartUrlOnlyScraper ? (
              <div className="md:col-span-1 xl:col-span-2">
                <Field
                  label="Start URL"
                  htmlFor="jobs-start-url"
                  hint={
                    isIndeedStartUrlOnlySource
                      ? 'Indeed runs from a single Indeed URL. The backend sends the rest of the actor input as fixed values.'
                      : '`Apify: memo23` runs from a single Hiring Cafe URL. The backend sends the rest of the actor input as fixed values.'
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
          description="Choose the spreadsheet, tab, columns, and start row. Duplicate jobs already present in the sheet are skipped before writing."
        >
          {/* Ordinary accounts have exactly one destination, so there is
              nothing to choose. An administrator can still write into a
              shared source they configured. */}
          {isAdmin && (
            <div className="tl-card inline-flex flex-wrap gap-1 p-1">
              {(['mine', 'shared'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setExportTarget(option)}
                  disabled={isLoading}
                  className="tl-subtab"
                  data-active={exportTarget === option}
                  aria-pressed={exportTarget === option}
                >
                  {option === 'mine' ? 'My job sheet' : 'A shared sheet'}
                </button>
              ))}
            </div>
          )}

          {exportTarget === 'mine' ? (
            <Notice tone="neutral">
              {accountSheet?.configured && accountSheet.spreadsheetUrl ? (
                <>
                  Rows go to{' '}
                  <a
                    className="tl-link"
                    href={accountSheet.todayTabUrl ?? accountSheet.spreadsheetUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    your job sheet
                  </a>
                  , on the <span className="font-semibold">{accountSheet.todayTab}</span> tab, under
                  Company, Job Title, Job Link and Job Description. New rows are added after the ones
                  already there, and jobs already in the tab are skipped.
                </>
              ) : (
                'Rows go to your own job sheet, on today\'s tab. Settings > Job Sheet has the link if you want to see it.'
              )}
            </Notice>
          ) : (
          <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_220px_auto] lg:items-end">
            <Field label="Google Sheet" htmlFor="jobs-export-sheet">
              <select
                id="jobs-export-sheet"
                value={sheetExportForm.sheetId}
                onChange={(event) => {
                  setSheetField('sheetId', event.target.value);
                  setSheetField('tabName', '');
                  setSheetTabs([]);
                  setSheetTitle('');
                }}
                className="tl-input"
                disabled={isLoading}
              >
                <option value="">
                  {sheetSources.length ? 'Choose a saved Google Sheet' : 'No saved Google Sheets available'}
                </option>
                {sheetSources.map((sheetSource) => (
                  <option key={sheetSource.id} value={sheetSource.sheetId}>
                    {sheetSource.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Sheet tab" htmlFor="jobs-export-tab">
              <select
                id="jobs-export-tab"
                value={sheetExportForm.tabName}
                onChange={(event) => setSheetField('tabName', event.target.value)}
                className="tl-input"
                disabled={isLoading || isLoadingTabs || sheetTabs.length === 0}
              >
                <option value="">{sheetTabs.length ? 'Choose a tab' : 'Load tabs first'}</option>
                {sheetTabs.map((tab) => (
                  <option key={tab.sheetId} value={tab.title}>
                    {tab.title}
                  </option>
                ))}
              </select>
            </Field>

            <button
              type="button"
              onClick={handleLoadSheetTabs}
              disabled={isLoading || isLoadingTabs || !sheetExportForm.sheetId.trim()}
              className="tl-button-quiet w-full lg:w-auto"
            >
              {isLoadingTabs ? 'Loading tabs...' : 'Load tabs'}
            </button>
          </div>

          {sheetTitle && (
            <Notice tone="success">
              Connected to <span className="font-semibold">{sheetTitle}</span>.
            </Notice>
          )}

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <Field label="Company column" htmlFor="jobs-export-company-col">
              <input
                id="jobs-export-company-col"
                type="text"
                value={sheetExportForm.companyNameCol}
                onChange={(event) => setSheetField('companyNameCol', event.target.value.toUpperCase())}
                placeholder="D"
                className="tl-input"
                disabled={isLoading}
              />
            </Field>

            <Field label="Job title column" htmlFor="jobs-export-title-col">
              <input
                id="jobs-export-title-col"
                type="text"
                value={sheetExportForm.jobTitleCol}
                onChange={(event) => setSheetField('jobTitleCol', event.target.value.toUpperCase())}
                placeholder="E"
                className="tl-input"
                disabled={isLoading}
              />
            </Field>

            <Field label="Job link column" htmlFor="jobs-export-link-col">
              <input
                id="jobs-export-link-col"
                type="text"
                value={sheetExportForm.jobLinkCol}
                onChange={(event) => setSheetField('jobLinkCol', event.target.value.toUpperCase())}
                placeholder="F"
                className="tl-input"
                disabled={isLoading}
              />
            </Field>

            <Field label="Description column" htmlFor="jobs-export-description-col">
              <input
                id="jobs-export-description-col"
                type="text"
                value={sheetExportForm.jobDescriptionCol}
                onChange={(event) => setSheetField('jobDescriptionCol', event.target.value.toUpperCase())}
                placeholder="G"
                className="tl-input"
                disabled={isLoading}
              />
            </Field>

            <Field label="Start row" htmlFor="jobs-export-start-row">
              <input
                id="jobs-export-start-row"
                type="number"
                min={1}
                step={1}
                value={sheetExportForm.startRow}
                onChange={(event) => setSheetField('startRow', event.target.value)}
                className="tl-input"
                disabled={isLoading}
              />
            </Field>
          </div>
          </>
          )}
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
              {results.length === 1 ? '' : 's'} for <span className="font-semibold text-ink">{searchSummaryValue}</span> via{' '}
              <span className="font-semibold text-ink">{searchMeta.providerLabel}</span>.
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
              Wrote {exportMeta.rowsWritten} jobs to {exportMeta.spreadsheetTitle} / {exportMeta.selectedTab}
            </p>
            <p className="mt-1">
              Rows {exportMeta.startRow} to {exportMeta.endRow}.
            </p>
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
                  ? `${selectedSource.label} is running on the backend and rows will be written to Google Sheets after filtering duplicate jobs.`
                  : `${selectedSource.label} is running on the backend.`
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
