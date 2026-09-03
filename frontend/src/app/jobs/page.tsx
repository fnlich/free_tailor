'use client';

import { FormEvent, useEffect, useState } from 'react';
import AppTopNav from '@/components/AppTopNav';
import {
  GoogleSheetSource,
  GoogleSheetTab,
  importApi,
  jobsApi,
  resumeApi,
  ScraperExportResponse,
  ScraperJob,
  ScraperJobType,
  ScraperRunResponse,
  ScraperSource,
  ScraperSourceProviderCatalog,
  ScraperTimePosted,
} from '@/lib/api';

const SCRAPER_OPTIONS: Array<{
  value: ScraperSource;
  label: string;
  badge: string;
  description: string;
}> = [
  {
    value: 'linkedin',
    label: 'LinkedIn',
    badge: 'LinkedIn',
    description: 'Uses only bebity/linkedin-jobs-scraper with fixed United States, remote, and past-24-hours filters.',
  },
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

const LIMIT_OPTIONS = [25, 100, 250, 500, 1000];
const JOB_BOARD_MAX_RESULTS = 100;

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

function parsePositiveWholeNumber(label: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive whole number.`);
  }
  return parsed;
}

function parseSpreadsheetColumnInput(label: string, value: string): number {
  const normalized = value.trim().toUpperCase();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  if (!/^[A-Z]+$/.test(normalized)) {
    throw new Error(`${label} must use spreadsheet letters like A, B, or AA.`);
  }

  let columnNumber = 0;
  for (const character of normalized) {
    columnNumber = (columnNumber * 26) + (character.charCodeAt(0) - 64);
  }

  return columnNumber;
}

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

function buildLinkedInActorInputPreview(title: string, rows: string): string {
  return JSON.stringify(
    {
      location: 'United States',
      proxy: {
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
        apifyProxyCountry: 'US',
      },
      publishedAt: 'r86400',
      rows: Number(rows) > 0 ? Number(rows) : 1000,
      title: title.trim() || 'software engineer',
      workType: '2',
    },
    null,
    2
  );
}

export default function JobsPage() {
  const [source, setSource] = useState<ScraperSource>('linkedin');
  const [providerCatalog, setProviderCatalog] = useState<ScraperSourceProviderCatalog[]>([]);
  const [selectedProviders, setSelectedProviders] = useState<Partial<Record<ScraperSource, string>>>({});
  const [linkedinTitle, setLinkedinTitle] = useState('');
  const [linkedinRows, setLinkedinRows] = useState('1000');
  const [keywords, setKeywords] = useState('');
  const [startUrl, setStartUrl] = useState('');
  const [location, setLocation] = useState('United States');
  const [timePosted, setTimePosted] = useState<ScraperTimePosted>('24h');
  const [jobType, setJobType] = useState<ScraperJobType | ''>('');
  const [remoteOnly, setRemoteOnly] = useState(true);
  const [limit, setLimit] = useState(250);
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
  const isLinkedInSource = source === 'linkedin';
  const availableLimitOptions = source === 'jobboard'
    ? LIMIT_OPTIONS.filter((value) => value <= JOB_BOARD_MAX_RESULTS)
    : LIMIT_OPTIONS;

  const setSheetField = <K extends keyof SheetExportFormState>(field: K, value: SheetExportFormState[K]) => {
    setSheetExportForm((current) => ({ ...current, [field]: value }));
  };

  useEffect(() => {
    let isMounted = true;

    const loadInitialData = async () => {
      try {
        const [settings, providers] = await Promise.all([
          resumeApi.getModels(),
          jobsApi.getScraperProviders(),
        ]);
        if (!isMounted) {
          return;
        }

        setSheetSources(settings.googleSheetsSources);
        setProviderCatalog(providers);
        setSelectedProviders((current) => {
          const next = { ...current };

          for (const entry of providers) {
            if (!next[entry.source]) {
              next[entry.source] = entry.defaultProviderId;
            }
          }

          return next;
        });
        setSheetExportForm((current) => {
          if (current.sheetId.trim()) {
            return current;
          }

          return {
            ...current,
            sheetId: settings.googleSheetsSources[0]?.sheetId ?? '',
          };
        });
      } catch {
        if (!isMounted) {
          return;
        }

        setSheetSources([]);
        setProviderCatalog([]);
      }
    };

    void loadInitialData();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (source === 'jobboard' && limit > JOB_BOARD_MAX_RESULTS) {
      setLimit(JOB_BOARD_MAX_RESULTS);
    }
  }, [source, limit]);

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

      if (isLinkedInSource) {
        const trimmedTitle = linkedinTitle.trim();
        if (!trimmedTitle) {
          setError('Enter a job title before running the LinkedIn scraper.');
          setIsLoading(false);
          return;
        }

        commonPayload = {
          source,
          provider: selectedProviderId || undefined,
          title: trimmedTitle,
          rows: parsePositiveWholeNumber('Rows', linkedinRows),
        };
      } else if (isStartUrlOnlyScraper) {
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
        const exportResponse = await jobsApi.exportScraperToGoogleSheet({
          ...commonPayload,
          source,
          provider: selectedProviderId || undefined,
          sheetId: sheetExportForm.sheetId.trim(),
          tabName: sheetExportForm.tabName.trim(),
          startRow: parsePositiveWholeNumber('Start row', sheetExportForm.startRow),
          companyNameCol: parseSpreadsheetColumnInput('Company column', sheetExportForm.companyNameCol),
          jobTitleCol: parseSpreadsheetColumnInput('Job title column', sheetExportForm.jobTitleCol),
          jobLinkCol: parseSpreadsheetColumnInput('Job link column', sheetExportForm.jobLinkCol),
          jobDescriptionCol: parseSpreadsheetColumnInput('Job description column', sheetExportForm.jobDescriptionCol),
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

  const searchSummaryValue = isLinkedInSource
    ? (searchMeta?.filters.title ?? '')
    : (searchMeta?.filters.keywords || searchMeta?.filters.startUrl || 'custom search');

  return (
    <div className="min-h-screen bg-gray-50">
      <AppTopNav />

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-sm backdrop-blur sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl space-y-4">
              <div className="inline-flex items-center rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold tracking-[0.18em] text-blue-700 uppercase">
                Job Scrapers
              </div>
              <div className="space-y-3">
                <h1 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
                  Run job scrapers one source at a time
                </h1>
                <p className="text-sm leading-7 text-gray-600 sm:text-base">
                  LinkedIn now uses only `bebity/linkedin-jobs-scraper` with fixed location, proxy, publishedAt, and remote settings.
                  The other categories remain available with their existing source-specific inputs.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {['Independent runs', 'Source-specific inputs', '5-minute scraper timeout', 'Google Sheets export'].map((label) => (
                  <span
                    key={label}
                    className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700"
                  >
                    {label}
                  </span>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
              <div className="font-semibold text-gray-900">{selectedSource.badge}</div>
              <div className="mt-1">{selectedSource.description}</div>
              {selectedProvider && (
                <div className="mt-2 text-xs text-gray-500">
                  Provider: <span className="font-semibold text-gray-700">{selectedProvider.label}</span>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="mt-6 rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
          <form className="space-y-6" onSubmit={handleSubmit}>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <label className="space-y-2">
                <span className="text-sm font-medium text-gray-700">Category</span>
                <select
                  value={source}
                  onChange={(event) => setSource(event.target.value as ScraperSource)}
                  className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none ring-0 focus:border-blue-500"
                  disabled={isLoading}
                >
                  {SCRAPER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="space-y-2">
                <span className="text-sm font-medium text-gray-700">Provider</span>
                <select
                  value={selectedProviderId}
                  onChange={(event) =>
                    setSelectedProviders((current) => ({
                      ...current,
                      [source]: event.target.value,
                    }))
                  }
                  className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none ring-0 focus:border-blue-500"
                  disabled={isLoading || !selectedSourceProviderCatalog || selectedSourceProviderCatalog.providers.length <= 1}
                >
                  {(selectedSourceProviderCatalog?.providers ?? []).map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                    </option>
                  ))}
                </select>
                {selectedProvider && (
                  <div className="text-xs text-gray-500">{selectedProvider.description}</div>
                )}
              </label>

              {isLinkedInSource ? (
                <>
                  <label className="space-y-2">
                    <span className="text-sm font-medium text-gray-700">Title</span>
                    <input
                      type="text"
                      value={linkedinTitle}
                      onChange={(event) => setLinkedinTitle(event.target.value)}
                      placeholder="software engineer"
                      className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none ring-0 placeholder:text-gray-400 focus:border-blue-500"
                      disabled={isLoading}
                    />
                  </label>

                  <label className="space-y-2">
                    <span className="text-sm font-medium text-gray-700">Rows</span>
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      step={1}
                      value={linkedinRows}
                      onChange={(event) => setLinkedinRows(event.target.value)}
                      className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none ring-0 focus:border-blue-500"
                      disabled={isLoading}
                    />
                    <div className="text-xs text-gray-500">Maximum 1000 rows.</div>
                  </label>
                </>
              ) : isStartUrlOnlyScraper ? (
                <label className="space-y-2">
                  <span className="text-sm font-medium text-gray-700">Start URL</span>
                  <input
                    type="url"
                    value={startUrl}
                    onChange={(event) => setStartUrl(event.target.value)}
                    placeholder={isIndeedStartUrlOnlySource ? 'https://www.indeed.com/jobs/?q=...' : 'https://hiring.cafe/?searchState=...'}
                    className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none ring-0 placeholder:text-gray-400 focus:border-blue-500"
                    disabled={isLoading}
                    required
                  />
                  <div className="text-xs text-gray-500">
                    {isIndeedStartUrlOnlySource
                      ? 'Indeed runs from a single Indeed URL. The backend sends the rest of the actor input as fixed values.'
                      : '`Apify: memo23` runs from a single Hiring Cafe URL. The backend sends the rest of the actor input as fixed values.'}
                  </div>
                </label>
              ) : (
                <>
                  <label className="space-y-2">
                    <span className="text-sm font-medium text-gray-700">Keyword</span>
                    <input
                      type="text"
                      value={keywords}
                      onChange={(event) => setKeywords(event.target.value)}
                      placeholder="software engineer, data analyst, product manager..."
                      className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none ring-0 placeholder:text-gray-400 focus:border-blue-500"
                      disabled={isLoading}
                    />
                  </label>

                  <label className="space-y-2">
                    <span className="text-sm font-medium text-gray-700">Location</span>
                    <input
                      type="text"
                      value={location}
                      onChange={(event) => setLocation(event.target.value)}
                      placeholder="United States, Berlin, London..."
                      className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none ring-0 placeholder:text-gray-400 focus:border-blue-500"
                      disabled={isLoading}
                    />
                  </label>

                  <label className="space-y-2">
                    <span className="text-sm font-medium text-gray-700">Posted within</span>
                    <select
                      value={timePosted}
                      onChange={(event) => setTimePosted(event.target.value as ScraperTimePosted)}
                      className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none ring-0 focus:border-blue-500"
                      disabled={isLoading}
                    >
                      {TIME_POSTED_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-2">
                    <span className="text-sm font-medium text-gray-700">Job type</span>
                    <select
                      value={jobType}
                      onChange={(event) => setJobType(event.target.value as ScraperJobType | '')}
                      className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none ring-0 focus:border-blue-500"
                      disabled={isLoading}
                    >
                      <option value="">Any supported type</option>
                      {JOB_TYPE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-2">
                    <span className="text-sm font-medium text-gray-700">Results</span>
                    <select
                      value={limit}
                      onChange={(event) => setLimit(Number(event.target.value))}
                      className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none ring-0 focus:border-blue-500"
                      disabled={isLoading}
                    >
                      {availableLimitOptions.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                    {source === 'jobboard' && (
                      <div className="text-xs text-amber-700">
                        Job Board scraper supports up to 100 results per run.
                      </div>
                    )}
                  </label>
                </>
              )}
            </div>

            {isLinkedInSource && (
              <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
                <div className="font-semibold text-gray-900">Fixed LinkedIn actor payload</div>
                <pre className="mt-3 overflow-x-auto rounded-xl bg-slate-900 p-4 text-xs leading-6 text-slate-100">{buildLinkedInActorInputPreview(linkedinTitle, linkedinRows)}</pre>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              {!isStartUrlOnlyScraper && !isLinkedInSource && (
                <label className="inline-flex items-center gap-3 rounded-full border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700">
                  <input
                    type="checkbox"
                    checked={remoteOnly}
                    onChange={(event) => setRemoteOnly(event.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-blue-600"
                    disabled={isLoading}
                  />
                  Remote only
                </label>
              )}

              <label
                className="inline-flex items-center gap-3 rounded-full border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700"
              >
                <input
                  type="checkbox"
                  checked={writeToGoogleSheet}
                  onChange={(event) => setWriteToGoogleSheet(event.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600"
                  disabled={isLoading}
                />
                Write to Google Sheet
              </label>
            </div>

            <div className="rounded-3xl border border-gray-200 bg-gray-50 p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <div className="text-base font-semibold text-gray-900">Google Sheets export</div>
                  <div className="mt-1 text-sm text-gray-600">
                    Choose the spreadsheet, tab, columns, and start row. Duplicate jobs already present in the sheet
                    are skipped before writing.
                  </div>
                </div>
              </div>

              <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_220px_auto]">
                <label className="space-y-2">
                  <span className="text-sm font-medium text-gray-700">Google Sheet</span>
                  <select
                    value={sheetExportForm.sheetId}
                    onChange={(event) => {
                      setSheetField('sheetId', event.target.value);
                      setSheetField('tabName', '');
                      setSheetTabs([]);
                      setSheetTitle('');
                    }}
                    className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none ring-0 focus:border-blue-500"
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
                </label>

                <label className="space-y-2">
                  <span className="text-sm font-medium text-gray-700">Sheet tab</span>
                  <select
                    value={sheetExportForm.tabName}
                    onChange={(event) => setSheetField('tabName', event.target.value)}
                    className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none ring-0 focus:border-blue-500"
                    disabled={isLoading || isLoadingTabs || sheetTabs.length === 0}
                  >
                    <option value="">{sheetTabs.length ? 'Choose a tab' : 'Load tabs first'}</option>
                    {sheetTabs.map((tab) => (
                      <option key={tab.sheetId} value={tab.title}>
                        {tab.title}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={handleLoadSheetTabs}
                    disabled={isLoading || isLoadingTabs || !sheetExportForm.sheetId.trim()}
                    className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:bg-gray-100 disabled:text-gray-400"
                  >
                    {isLoadingTabs ? 'Loading tabs...' : 'Load tabs'}
                  </button>
                </div>
              </div>

              {sheetTitle && (
                <div className="mt-3 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
                  Connected to <span className="font-semibold">{sheetTitle}</span>.
                </div>
              )}

              <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
                <label className="space-y-2">
                  <span className="text-sm font-medium text-gray-700">Company column</span>
                  <input
                    type="text"
                    value={sheetExportForm.companyNameCol}
                    onChange={(event) => setSheetField('companyNameCol', event.target.value.toUpperCase())}
                    placeholder="D"
                    className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none ring-0 focus:border-blue-500"
                    disabled={isLoading}
                  />
                </label>

                <label className="space-y-2">
                  <span className="text-sm font-medium text-gray-700">Job title column</span>
                  <input
                    type="text"
                    value={sheetExportForm.jobTitleCol}
                    onChange={(event) => setSheetField('jobTitleCol', event.target.value.toUpperCase())}
                    placeholder="E"
                    className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none ring-0 focus:border-blue-500"
                    disabled={isLoading}
                  />
                </label>

                <label className="space-y-2">
                  <span className="text-sm font-medium text-gray-700">Job link column</span>
                  <input
                    type="text"
                    value={sheetExportForm.jobLinkCol}
                    onChange={(event) => setSheetField('jobLinkCol', event.target.value.toUpperCase())}
                    placeholder="F"
                    className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none ring-0 focus:border-blue-500"
                    disabled={isLoading}
                  />
                </label>

                <label className="space-y-2">
                  <span className="text-sm font-medium text-gray-700">Description column</span>
                  <input
                    type="text"
                    value={sheetExportForm.jobDescriptionCol}
                    onChange={(event) => setSheetField('jobDescriptionCol', event.target.value.toUpperCase())}
                    placeholder="G"
                    className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none ring-0 focus:border-blue-500"
                    disabled={isLoading}
                  />
                </label>

                <label className="space-y-2">
                  <span className="text-sm font-medium text-gray-700">Start row</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={sheetExportForm.startRow}
                    onChange={(event) => setSheetField('startRow', event.target.value)}
                    className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none ring-0 focus:border-blue-500"
                    disabled={isLoading}
                  />
                </label>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="submit"
                disabled={isLoading}
                className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
              >
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

          {error && (
            <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {searchMeta && !error && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
              <span>
                Found <span className="font-semibold text-gray-900">{results.length}</span> {formatSourceLabel(searchMeta.source)} job
                {results.length === 1 ? '' : 's'} for <span className="font-semibold text-gray-900">{searchSummaryValue}</span> via{' '}
                <span className="font-semibold text-gray-900">{searchMeta.providerLabel}</span>.
              </span>
              <span>Fetched {formatFetchedAt(searchMeta.fetchedAt)}</span>
              {(searchMeta.filters.rawResultCount ?? 0) > 0 && (
                <span>
                  Raw {searchMeta.filters.rawResultCount}
                  {typeof searchMeta.filters.remoteFilteredCount === 'number' && searchMeta.filters.remoteFilteredCount > 0
                    ? `, filtered out ${searchMeta.filters.remoteFilteredCount} by remote rules`
                    : ''}
                </span>
              )}
            </div>
          )}

          {exportMeta && !error && (
            <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-sm text-emerald-800">
              <div className="font-semibold text-emerald-900">
                Wrote {exportMeta.rowsWritten} jobs to {exportMeta.spreadsheetTitle} / {exportMeta.selectedTab}
              </div>
              <div className="mt-1">
                Rows {exportMeta.startRow} to {exportMeta.endRow}.
              </div>
              <div className="mt-1">
                {exportMeta.unresolvedJobLinks === 0
                  ? 'Every exported row had a usable apply link.'
                  : `${exportMeta.unresolvedJobLinks} exported job-link cells were blank because no apply URL was available.`}
              </div>
              {typeof exportMeta.beforeExportResultCount === 'number' && (
                <div className="mt-1">
                  {exportMeta.beforeExportResultCount} job{exportMeta.beforeExportResultCount === 1 ? '' : 's'} remained after scraper filtering before sheet duplicate checks.
                </div>
              )}
              <div className="mt-1">
                {exportMeta.skippedCompanyDuplicates === 0
                  ? 'No jobs were skipped as duplicates.'
                  : `Skipped ${exportMeta.skippedCompanyDuplicates} job${exportMeta.skippedCompanyDuplicates === 1 ? '' : 's'} because the same job already existed in the destination sheet or had already been queued in this run.`}
              </div>
            </div>
          )}
        </section>

        <section className="mt-6 space-y-4">
          {isLoading && (
            <div className="rounded-3xl border border-gray-200 bg-white px-6 py-10 text-center shadow-sm">
              <div className="mx-auto h-12 w-12 animate-spin rounded-full border-b-2 border-blue-600" />
              <div className="mt-4 text-sm text-gray-600">
                {writeToGoogleSheet
                  ? `${selectedSource.label} is running on the backend and rows will be written to Google Sheets after filtering duplicate jobs.`
                  : `${selectedSource.label} is running on the backend.`}
              </div>
            </div>
          )}

          {!isLoading && searched && !error && results.length === 0 && (
            <div className="rounded-3xl border border-gray-200 bg-white px-6 py-10 text-center shadow-sm">
              <div className="text-lg font-semibold text-gray-900">No jobs matched this run</div>
              <div className="mt-2 text-sm text-gray-600">
                {isLinkedInSource
                  ? 'Try a broader title or a larger row limit.'
                  : 'Try a broader keyword, a wider time window, or a different scraper.'}
              </div>
            </div>
          )}

          {!isLoading &&
            results.map((job) => {
              const meta = getJobMeta(job);
              const postedDate = formatPostedDate(job.posted_at);
              const salaryRange = formatSalaryRange(job);
              const nativeLink = getNativeJobLink(job);

              return (
                <article
                  key={`${job.source}-${job.id}`}
                  className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm transition hover:border-blue-200 hover:shadow-md"
                >
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-3">
                      <div className="space-y-2">
                        <div className="flex flex-wrap gap-2">
                          <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700">
                            {formatSourceLabel(job.source)}
                          </span>
                          {job.job_type && (
                            <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
                              {job.job_type}
                            </span>
                          )}
                          {job.equity && (
                            <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
                              Equity {job.equity}
                            </span>
                          )}
                          {salaryRange && (
                            <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
                              {salaryRange}
                            </span>
                          )}
                        </div>

                        <div>
                          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">{job.title}</h2>
                          {meta.length > 0 && (
                            <p className="mt-2 text-sm text-gray-600">{meta.join(' • ')}</p>
                          )}
                          {postedDate && (
                            <p className="mt-1 text-xs uppercase tracking-[0.18em] text-gray-500">
                              Posted date {postedDate}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap gap-3">
                      {job.apply_url ? (
                        <a
                          href={job.apply_url}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
                        >
                          Open apply link
                        </a>
                      ) : (
                        <span className="rounded-xl bg-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-600">
                          Apply link unavailable
                        </span>
                      )}
                      {nativeLink && nativeLink !== job.apply_url && (
                        <a
                          href={nativeLink}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                        >
                          Open source listing
                        </a>
                      )}
                    </div>
                  </div>

                  {job.description && (
                    <p className="mt-5 text-sm leading-7 text-gray-700">
                      {truncateDescription(job.description)}
                    </p>
                  )}
                </article>
              );
            })}
        </section>
      </main>
    </div>
  );
}
