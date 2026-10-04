import { Router, Request, Response } from 'express';
import { requireUser } from '../middleware/auth';
import { sheetsOperatorDetail } from './sheetsDetail';
import {
  batchUpdateGoogleSheetsColumns,
  fetchGoogleSheetsColumnValues,
  fetchGoogleSheetsRange,
  GoogleSheetsRequestError,
  updateGoogleSheetsRow,
} from '../integrations/googleSheets';
import {
  JOB_SHEET_COLUMNS,
  JOB_SHEET_FIRST_DATA_ROW,
  toColumnLetters,
} from '../integrations/googleSheets';
import { SheetAccessError } from '../services/sheets/accountSheet';
import {
  resolveAppendRow,
  resolveColumn,
  resolveJobSheetTarget,
} from '../services/sheets/jobSheetTarget';
import { resolvePromptExecutionConfig } from '../services/ai';
import {
  evaluateJobFilterAnalysis,
  evaluateJobContentAgainstFilter,
  JOB_FILTER_PROVIDER,
} from '../services/jobFilter';
import { extractJobPageContent } from '../services/jobPageContent';
import { scraperDefaultLocation, scraperMaxResults } from '../config/operational';
import {
  describeScraperCatalog,
  isSupportedScraperSource,
  listScraperProviderCatalog,
  resolveScraperProvider,
  ScraperSource,
  UnifiedScraperFilters,
  UnifiedScraperJob,
} from '../services/scraperProviders';
const { isBroadSoftwareRoleSearch } = require('../../scrapers/filters');

const router = Router();
/**
 * Everything below needs a signed-in account.
 *
 * At the router rather than per route, so a route added later is protected by
 * default. Before v2 these were open, which was defensible with one user on one
 * machine and is not once profiles belong to people.
 */
router.use(requireUser);

const SCRAPER_EXPORT_BATCH_SIZE = 50;
const BROAD_SOFTWARE_TITLE_PATTERNS = [
  /\bsoftware (engineer|developer)\b/i,
  /\b(frontend|front-end|backend|back-end|full[- ]stack|web|mobile|ios|android|embedded|firmware|systems|cloud|platform|infrastructure|devops|site reliability|sre|security|application security|data|machine learning|mlops|ai|computer vision|robotics|distributed systems|database|storage)\s+(engineer|developer)\b/i,
  /\bsoftware development engineer\b/i,
  /\bsde\b/i,
  /\bsdet\b/i,
  /\bqa engineer\b/i,
  /\bautomation engineer\b/i,
  /\btest engineer\b/i,
  /\bbuild(?:\s*&\s*|\s+and\s+)?release engineer\b/i,
  /\bbuild engineer\b/i,
  /\btools engineer\b/i,
  /\bgame (developer|engineer)\b/i,
  /\bsimulation engineer\b/i,
  /\bflight software engineer\b/i,
  /\btech lead\b/i,
  /\btechnical lead\b/i,
  /\bengineering lead\b/i,
  /\blead software engineer\b/i,
  /\blead developer\b/i,
  /\bsoftware architect\b/i,
  /\bsolutions architect\b/i,
  /\benterprise architect\b/i,
  /\bproduct engineer\b/i,
  /\bresearch engineer\b/i,
  /\bapplied scientist\b/i,
];
const BROAD_SOFTWARE_EXCLUDED_PATTERNS = [
  /\bjunior\b/i,
  /\bjr\.?\b/i,
  /\bintern\b/i,
  /\binternship\b/i,
  /\bassociate\b/i,
  /\bapprentice\b/i,
  /\btrainee\b/i,
  /\bnew grad\b/i,
  /\bgraduate\b/i,
  /\bstudent\b/i,
  /\bentry[- ]level\b/i,
  /\bno prior experience required\b/i,
];

function normalizeCompanyName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

type ExportRowIdentity = {
  companyName: string;
  jobTitle: string;
  jobLink: string;
};

function buildCompanyDuplicateKey(companyName: string): string | null {
  const normalizedCompanyName = normalizeCompanyName(companyName);

  if (!normalizedCompanyName) {
    return null;
  }

  return `company:${normalizedCompanyName}`;
}

function buildExportRowDuplicateKeys(identity: ExportRowIdentity): string[] {
  const companyKey = buildCompanyDuplicateKey(identity.companyName);
  return companyKey ? [companyKey] : [];
}

function buildSeenExportRowKeys(
  companyNames: string[],
  jobTitles: string[],
  jobLinks: string[]
): Set<string> {
  const seenKeys = new Set<string>();
  const totalRows = Math.max(companyNames.length, jobTitles.length, jobLinks.length);

  for (let index = 0; index < totalRows; index += 1) {
    const duplicateKeys = buildExportRowDuplicateKeys({
      companyName: companyNames[index] || '',
      jobTitle: jobTitles[index] || '',
      jobLink: jobLinks[index] || '',
    });

    for (const key of duplicateKeys) {
      seenKeys.add(key);
    }
  }

  return seenKeys;
}

function requireSupportedScraperSource(value: unknown): ScraperSource {
  const normalizedValue = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (isSupportedScraperSource(normalizedValue)) {
    return normalizedValue;
  }

  throw new GoogleSheetsRequestError(
    400,
    `source must be one of: ${listScraperProviderCatalog().map((entry) => entry.source).join(', ')}.`
  );
}

function normalizeScraperFilters(
  payload: Record<string, unknown>,
  source: ScraperSource,
  providerId?: string
): UnifiedScraperFilters {
  const keywords = typeof payload.keywords === 'string' ? payload.keywords.trim() : '';
  const startUrl = normalizeOptionalHttpUrl('startUrl', payload.startUrl);
  const requiresStartUrlOnly = isStartUrlOnlyProvider(source, providerId);

  if (requiresStartUrlOnly && !startUrl) {
    throw new GoogleSheetsRequestError(400, 'startUrl is required.');
  }

  if (!requiresStartUrlOnly && !keywords) {
    throw new GoogleSheetsRequestError(400, 'keywords is required.');
  }

  return {
    keywords,
    startUrl,
    location: typeof payload.location === 'string' ? payload.location.trim() : '',
    timePosted: normalizeTimePosted(payload.timePosted),
    jobType: normalizeJobTypeFilter(payload.jobType),
    remoteOnly: normalizeBoolean(payload.remoteOnly),
    maxResults: capRequestedResults(
      payload.maxResults === undefined ? undefined : toPositiveInteger('maxResults', payload.maxResults)
    ),
  };
}

/**
 * The result count a run is asked for, held under SCRAPER_MAX_RESULTS when the
 * deployment sets one; unchanged when it does not.
 *
 * Clamped rather than refused, like every other configured bound: a client
 * that still offers 1000 gets a run of the size this deployment allows, and the
 * response's `filters.maxResults` shows the number actually used. The scrapers
 * apply the same cap to the counts they fill in themselves (a request that names
 * none, Indeed's per-search cap, memo23's fixed count).
 */
function capRequestedResults(requested: number | undefined): number | undefined {
  const cap = scraperMaxResults();
  return requested === undefined || cap === null ? requested : Math.min(requested, cap);
}

function normalizeTimePosted(value: unknown): UnifiedScraperFilters['timePosted'] {
  const normalizedValue = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalizedValue === '24h' || normalizedValue === '3d' || normalizedValue === '7d' || normalizedValue === '30d') {
    return normalizedValue;
  }

  return '24h';
}

function normalizeJobTypeFilter(value: unknown): UnifiedScraperFilters['jobType'] | undefined {
  const normalizedValue = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (
    normalizedValue === 'full-time' ||
    normalizedValue === 'part-time' ||
    normalizedValue === 'contract' ||
    normalizedValue === 'internship' ||
    normalizedValue === 'temporary'
  ) {
    return normalizedValue;
  }

  return undefined;
}

function normalizeBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function isStartUrlOnlyProvider(source: ScraperSource, providerId?: string): boolean {
  return source === 'indeed' || (source === 'hiringcafe' && providerId?.trim() === 'apify-memo23');
}

function normalizeOptionalHttpUrl(fieldName: string, value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new GoogleSheetsRequestError(400, `${fieldName} must be a valid URL.`);
  }

  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return undefined;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmedValue);
  } catch {
    throw new GoogleSheetsRequestError(400, `${fieldName} must be a valid URL.`);
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new GoogleSheetsRequestError(400, `${fieldName} must use http or https.`);
  }

  return parsedUrl.toString();
}

function normalizeHintStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    const normalizedValue = value.trim();
    return normalizedValue ? [normalizedValue] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeHintStrings(entry));
  }

  return [];
}

function hasRemoteMarker(value: string): boolean {
  return /\b(remote|work\s*from\s*home|wfh|anywhere|distributed)\b/i.test(value);
}

function hasHybridMarker(value: string): boolean {
  return /\bhybrid\b/i.test(value);
}

function hasOnsiteMarker(value: string): boolean {
  return /\b(on[\s-]?site|in[\s-]?office|office[\s-]?based)\b/i.test(value);
}

function getTimePostedWindowMs(value: UnifiedScraperFilters['timePosted']): number {
  switch (value) {
    case '24h':
      return 24 * 60 * 60 * 1000;
    case '3d':
      return 3 * 24 * 60 * 60 * 1000;
    case '7d':
      return 7 * 24 * 60 * 60 * 1000;
    case '30d':
      return 30 * 24 * 60 * 60 * 1000;
    default:
      return 24 * 60 * 60 * 1000;
  }
}

function isWithinPostedWindow(job: UnifiedScraperJob, timePosted: UnifiedScraperFilters['timePosted']): boolean {
  if (!job.posted_at) {
    return false;
  }

  const postedAt = new Date(job.posted_at);
  if (Number.isNaN(postedAt.getTime())) {
    return false;
  }

  const oldestAllowedTime = Date.now() - getTimePostedWindowMs(timePosted);
  return postedAt.getTime() >= oldestAllowedTime;
}

function isStrictRemoteJob(job: UnifiedScraperJob): boolean {
  const raw = job.raw ?? {};
  const booleanRemoteSignals = [
    raw['is_remote'],
    raw['remote'],
    raw['isRemote'],
  ];

  if (booleanRemoteSignals.some((value) => value === false)) {
    return false;
  }

  const workplaceHints = [
    raw['workplaceType'],
    raw['workplace_type'],
    raw['workplaceTypes'],
    raw['allLocations'],
    raw['location'],
    raw['locationNames'],
    raw['formatted_workplace_location'],
    job.location,
  ].flatMap((value) => normalizeHintStrings(value));

  if (workplaceHints.some((value) => hasHybridMarker(value) || hasOnsiteMarker(value))) {
    return false;
  }

  if (booleanRemoteSignals.some((value) => value === true)) {
    return true;
  }

  return workplaceHints.some((value) => hasRemoteMarker(value));
}

function shouldApplyBroadSoftwareRoleFilter(keywords: string): boolean {
  return Boolean(isBroadSoftwareRoleSearch(keywords));
}

function matchesBroadSoftwareRoleJob(job: UnifiedScraperJob): boolean {
  const raw = job.raw ?? {};
  const titleHints = [
    job.title,
    typeof raw['title'] === 'string' ? raw['title'] : '',
    typeof raw['coreJobTitle'] === 'string' ? raw['coreJobTitle'] : '',
    typeof raw['positionName'] === 'string' ? raw['positionName'] : '',
    typeof raw['jobTitle'] === 'string' ? raw['jobTitle'] : '',
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  const exclusionHints = [
    ...titleHints,
    job.job_type,
    typeof raw['seniorityLevel'] === 'string' ? raw['seniorityLevel'] : '',
    typeof raw['seniority_level'] === 'string' ? raw['seniority_level'] : '',
  ]
    .map((value) => value.trim())
    .filter(Boolean);

  if (exclusionHints.some((value) => BROAD_SOFTWARE_EXCLUDED_PATTERNS.some((pattern) => pattern.test(value)))) {
    return false;
  }

  return titleHints.some((value) => BROAD_SOFTWARE_TITLE_PATTERNS.some((pattern) => pattern.test(value)));
}

function applySourceSpecificScraperDefaults(
  source: ScraperSource,
  filters: UnifiedScraperFilters
): UnifiedScraperFilters {
  // SCRAPER_DEFAULT_LOCATION, read per request. The jobs page pre-fills its
  // location field with the same value (GET /scrapers/providers), so this
  // applies when the user clears the field or a client sends none.
  if (!filters.location) {
    return {
      ...filters,
      location: scraperDefaultLocation(),
    };
  }

  return filters;
}

async function runScraper(
  source: ScraperSource,
  providerId: string | undefined,
  filters: UnifiedScraperFilters
): Promise<{
  provider: ReturnType<typeof resolveScraperProvider>;
  rawResultCount: number;
  resultsWithinPostedWindowCount: number;
  remoteFilteredCount: number;
  finalResults: UnifiedScraperJob[];
}> {
  const provider = resolveScraperProvider(source, providerId);
  const rawResults = await provider.run(filters);

  const keywordScopedResults = shouldApplyBroadSoftwareRoleFilter(filters.keywords ?? '')
    ? rawResults.filter((job) => matchesBroadSoftwareRoleJob(job))
    : rawResults;
  const resultsWithinPostedWindow = source === 'indeed' || isStartUrlOnlyProvider(source, providerId)
    ? keywordScopedResults
    : keywordScopedResults.filter((job) => isWithinPostedWindow(job, filters.timePosted));
  const filteredResults = filters.remoteOnly
    ? resultsWithinPostedWindow.filter((job) => isStrictRemoteJob(job))
    : resultsWithinPostedWindow;
  // The request's count (already held under SCRAPER_MAX_RESULTS) or, when it
  // named none, the cap itself. Lever's actor takes no count at all, so for it
  // this trim is the only place the cap applies.
  const resultLimit = filters.maxResults ?? scraperMaxResults();
  const finalResults =
    typeof resultLimit === 'number' && resultLimit > 0
      ? filteredResults.slice(0, resultLimit)
      : filteredResults;

  return {
    provider,
    rawResultCount: rawResults.length,
    resultsWithinPostedWindowCount: resultsWithinPostedWindow.length,
    remoteFilteredCount: resultsWithinPostedWindow.length - filteredResults.length,
    finalResults,
  };
}

function getUnifiedJobSheetLink(job: UnifiedScraperJob): string {
  return typeof job.apply_url === 'string' ? job.apply_url.trim() : '';
}

function buildColumnRange(tabName: string, startRow: number, endRow: number, columnNumber: number): string {
  const columnLetters = toColumnLetters(columnNumber);
  const escapedTabName = `'${tabName.replace(/'/g, "''")}'`;
  return `${escapedTabName}!${columnLetters}${startRow}:${columnLetters}${endRow}`;
}

function shouldSkipExistingFilterRow(input: {
  jobLink: string;
  existingAnalysisValues: string[];
}): boolean {
  const { jobLink, existingAnalysisValues } = input;
  if (!jobLink.trim()) {
    return true;
  }

  const [result = '', reason = ''] = existingAnalysisValues.map((value) => value.trim());
  const normalizedResult = result.toLowerCase();

  if (normalizedResult === 'pass') {
    return true;
  }

  if (normalizedResult === 'fail' && reason.length > 0) {
    return true;
  }

  return false;
}

function toPositiveInteger(fieldName: string, value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new GoogleSheetsRequestError(400, `${fieldName} must be a positive whole number.`);
  }

  return parsed;
}

router.post('/scrapers/run', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const source = requireSupportedScraperSource(body.source);
    const providerId = typeof body.provider === 'string' ? body.provider : undefined;
    const filters = applySourceSpecificScraperDefaults(source, normalizeScraperFilters(body, source, providerId));
    const {
      provider,
      rawResultCount,
      resultsWithinPostedWindowCount,
      remoteFilteredCount,
      finalResults,
    } = await runScraper(source, providerId, filters);

    res.json({
      fetchedAt: new Date().toISOString(),
      source,
      providerId: provider.id,
      providerLabel: provider.label,
      filters: {
        ...filters,
        rawResultCount,
        resultsWithinPostedWindowCount,
        remoteFilteredCount,
      },
      results: finalResults,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to run scraper';
    const statusCode =
      // A 404 from the addressability guard, so a caller cannot learn whether
      // somebody else's spreadsheet exists by watching the status change.
      error instanceof SheetAccessError
        ? error.status
        : error instanceof GoogleSheetsRequestError
        ? error.statusCode
        : /unknown scraper provider/i.test(message)
          ? 400
        : /rate limited|timed out/i.test(message)
          ? 429
          : 500;
    res.status(statusCode).json({ error: message, ...sheetsOperatorDetail(req, error) });
  }
});

/**
 * The providers, and the deployment settings the jobs page shows: the default
 * location (SCRAPER_DEFAULT_LOCATION), the run timeout (APIFY_RUN_TIMEOUT_S) and,
 * per provider, the most results a run returns (SCRAPER_MAX_RESULTS folded in).
 */
router.get('/scrapers/providers', (_req: Request, res: Response) => {
  res.json(describeScraperCatalog());
});

router.post('/scrapers/export', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // FIRST, before any other validation. Defaults to the caller's own sheet
    // and today's tab, and checks the id when one is supplied - the service
    // account can open every account's spreadsheet, so an id taken on trust
    // here would read and overwrite anybody's. Running it ahead of everything
    // else means a request for somebody else's sheet is refused on its own
    // terms rather than incidentally failing some other check first.
    const { spreadsheetId: sheetId, tabName } = await resolveJobSheetTarget(req.user!, body);
    const source = requireSupportedScraperSource(body.source);
    const providerId = typeof body.provider === 'string' ? body.provider : undefined;
    const filters = applySourceSpecificScraperDefaults(source, normalizeScraperFilters(body, source, providerId));
    const companyNameCol = resolveColumn('Company column', body.companyNameCol, JOB_SHEET_COLUMNS.company);
    const jobTitleCol = resolveColumn('Job title column', body.jobTitleCol, JOB_SHEET_COLUMNS.jobTitle);
    const jobLinkCol = resolveColumn('Job link column', body.jobLinkCol, JOB_SHEET_COLUMNS.jobLink);
    const jobDescriptionCol = resolveColumn('Job description column', body.jobDescriptionCol, JOB_SHEET_COLUMNS.jobDescription);
    const sheetMetadata = await fetchGoogleSheetsRange({ sheetId });
    const [existingCompanyColumn, existingJobTitleColumn, existingJobLinkColumn] = await Promise.all([
      fetchGoogleSheetsColumnValues({
        sheetId,
        tabName,
        col: companyNameCol,
      }),
      fetchGoogleSheetsColumnValues({
        sheetId,
        tabName,
        col: jobTitleCol,
      }),
      fetchGoogleSheetsColumnValues({
        sheetId,
        tabName,
        col: jobLinkCol,
      }),
    ]);

    if (!sheetMetadata.tabs.some((tab) => tab.title === String(tabName ?? '').trim())) {
      throw new GoogleSheetsRequestError(400, `Tab "${String(tabName ?? '')}" was not found in the spreadsheet.`);
    }

    // Appends. Starting at row 2 by default would overwrite the morning's rows
    // on the afternoon's run; the columns are already in hand for the
    // duplicate check, so their length is the honest first free row.
    const startRow = resolveAppendRow(body.startRow, [
      existingCompanyColumn,
      existingJobTitleColumn,
      existingJobLinkColumn,
    ]);

    const seenJobs = buildSeenExportRowKeys(
      existingCompanyColumn.values,
      existingJobTitleColumn.values,
      existingJobLinkColumn.values
    );
    let rowsWritten = 0;
    let unresolvedJobLinks = 0;
    let skippedCompanyDuplicates = 0;
    let pendingRows: Array<{
      companyName: string;
      jobTitle: string;
      jobLink: string;
      jobDescription: string;
    }> = [];

    const flushPendingRows = async () => {
      if (pendingRows.length === 0) {
        return;
      }

      const batchStartRow = startRow + rowsWritten;
      const batchRows = pendingRows;

      await batchUpdateGoogleSheetsColumns({
        sheetId,
        tabName,
        startRow: batchStartRow,
        updates: [
          { col: companyNameCol, values: batchRows.map((row) => row.companyName) },
          { col: jobTitleCol, values: batchRows.map((row) => row.jobTitle) },
          { col: jobLinkCol, values: batchRows.map((row) => row.jobLink) },
          { col: jobDescriptionCol, values: batchRows.map((row) => row.jobDescription) },
        ],
      });

      rowsWritten += batchRows.length;
      unresolvedJobLinks += batchRows.filter((row) => !row.jobLink).length;
      pendingRows = [];
    };

    const {
      provider,
      rawResultCount,
      resultsWithinPostedWindowCount,
      remoteFilteredCount,
      finalResults: results,
    } = await runScraper(source, providerId, filters);
    const beforeExportResultCount = results.length;

    for (const job of results) {
      const jobLink = getUnifiedJobSheetLink(job);
      const duplicateKeys = buildExportRowDuplicateKeys({
        companyName: job.company,
        jobTitle: job.title,
        jobLink,
      });

      if (duplicateKeys.some((key) => seenJobs.has(key))) {
        skippedCompanyDuplicates += 1;
        continue;
      }

      for (const key of duplicateKeys) {
        seenJobs.add(key);
      }

      pendingRows.push({
        companyName: job.company,
        jobTitle: job.title,
        jobLink,
        jobDescription: job.description,
      });

      if (pendingRows.length >= SCRAPER_EXPORT_BATCH_SIZE) {
        await flushPendingRows();
      }
    }

    await flushPendingRows();

    const endRow = rowsWritten > 0 ? startRow + rowsWritten - 1 : startRow;
    const updatedRanges =
      rowsWritten > 0
        ? [
            buildColumnRange(String(tabName), startRow, endRow, Number(companyNameCol)),
            buildColumnRange(String(tabName), startRow, endRow, Number(jobTitleCol)),
            buildColumnRange(String(tabName), startRow, endRow, Number(jobLinkCol)),
            buildColumnRange(String(tabName), startRow, endRow, Number(jobDescriptionCol)),
          ]
        : [];

    res.json({
      fetchedAt: new Date().toISOString(),
      source,
      providerId: provider.id,
      providerLabel: provider.label,
      filters: {
        ...filters,
        rawResultCount,
        resultsWithinPostedWindowCount,
        remoteFilteredCount,
      },
      results,
      export: {
        spreadsheetId: sheetMetadata.spreadsheetId,
        spreadsheetTitle: sheetMetadata.spreadsheetTitle,
        selectedTab: String(tabName),
        updatedRanges,
        rowsWritten,
        startRow,
        endRow,
        unresolvedJobLinks,
        skippedCompanyDuplicates,
        beforeExportResultCount,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to export scraper jobs';
    const statusCode =
      // A 404 from the addressability guard, so a caller cannot learn whether
      // somebody else's spreadsheet exists by watching the status change.
      error instanceof SheetAccessError
        ? error.status
        : error instanceof GoogleSheetsRequestError
        ? error.statusCode
        : /unknown scraper provider/i.test(message)
          ? 400
        : /rate limited|timed out/i.test(message)
          ? 429
          : 500;
    res.status(statusCode).json({ error: message, ...sheetsOperatorDetail(req, error) });
  }
});

router.post('/filter-google-sheet', async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const { spreadsheetId: sheetId, tabName } = await resolveJobSheetTarget(req.user!, body);
    const jobLinkCol = resolveColumn('Job link column', body.jobLinkCol, JOB_SHEET_COLUMNS.jobLink);
    // Two columns of the filter's own. Rate, note and Job Finder are fields
    // somebody types into, so a verdict written into one of them would destroy
    // what was there.
    const resultCol = resolveColumn('Result column', body.resultCol, JOB_SHEET_COLUMNS.filterResult);
    const reasonCol = resolveColumn('Reason column', body.reasonCol, JOB_SHEET_COLUMNS.filterReason);
    const startRow =
      body.startRow === undefined ? JOB_SHEET_FIRST_DATA_ROW : toPositiveInteger('startRow', body.startRow);

    // Without an explicit end, run to the last row that actually has a job
    // link. Asking the caller for it made sense when they had picked the sheet;
    // now that it is their own, "all of today's jobs" is the only sane default.
    const endRow =
      body.endRow === undefined
        ? (await fetchGoogleSheetsColumnValues({ sheetId, tabName, col: jobLinkCol })).values.length
        : toPositiveInteger('endRow', body.endRow);

    // Only meaningful against an explicit range - an empty tab reports zero
    // rows below rather than an error.
    if (body.endRow !== undefined && body.startRow !== undefined && endRow < startRow) {
      throw new GoogleSheetsRequestError(400, 'startRow must be less than or equal to endRow.');
    }

    const distinctColumns = [
      jobLinkCol,
      resultCol,
      reasonCol,
    ];

    if (new Set(distinctColumns).size !== distinctColumns.length) {
      throw new GoogleSheetsRequestError(
        400,
        'Job link and output columns must all be different.'
      );
    }

    const executionConfig = await resolvePromptExecutionConfig('filter-google-sheet-job', JOB_FILTER_PROVIDER);

    if (endRow < startRow) {
      // An empty tab is not an error - a sheet created this morning that nobody
      // has exported into yet is the ordinary first run. It must answer in the
      // SAME shape as a real run, though: the page renders every field, and one
      // missing array is a crash rather than an empty state.
      res.json({
        spreadsheetId: sheetId,
        spreadsheetTitle: '',
        selectedTab: tabName,
        provider: executionConfig.provider,
        modelName: executionConfig.modelName ?? '',
        startRow,
        endRow,
        jobLinkCol,
        resultCol,
        reasonCol,
        scannedRows: 0,
        processedRows: 0,
        skippedRows: 0,
        scrapedRows: 0,
        errorRows: 0,
        updatedRanges: [],
        rowErrors: [],
        message: 'There are no job rows in that tab yet.',
      });
      return;
    }

    // A sheet filter is the longest-running AI loop in the app - one call per
    // row. Without this, closing the tab left it running to the end of the
    // sheet against the subscription window.
    const filterController = new AbortController();
    const filterSignal = filterController.signal;
    res.on('close', () => {
      if (!res.writableFinished) {
        filterController.abort();
      }
    });

    const fromCol = Math.min(...distinctColumns);
    const toCol = Math.max(...distinctColumns);
    const sheetRange = await fetchGoogleSheetsRange({
      sheetId,
      tabName,
      fromRow: startRow,
      toRow: endRow,
      fromCol,
      toCol,
    });
    const values = sheetRange.values ?? [];
    const jobLinkIndex = jobLinkCol - fromCol;
    const resultIndex = resultCol - fromCol;
    const reasonIndex = reasonCol - fromCol;

    let processedRows = 0;
    let skippedRows = 0;
    let scrapedRows = 0;
    let errorRows = 0;
    const rowErrors: Array<{ row: number; message: string }> = [];

    for (let rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
      const rowNumber = startRow + rowIndex;
      const row = values[rowIndex] ?? [];
      const jobLink = typeof row[jobLinkIndex] === 'string' ? row[jobLinkIndex].trim() : '';
      const existingAnalysisValues = [
        typeof row[resultIndex] === 'string' ? row[resultIndex].trim() : '',
        typeof row[reasonIndex] === 'string' ? row[reasonIndex].trim() : '',
      ];

      if (
        shouldSkipExistingFilterRow({
          jobLink,
          existingAnalysisValues,
        })
      ) {
        skippedRows += 1;
        continue;
      }

      try {
        const jobContent = await extractJobPageContent(jobLink);
        scrapedRows += 1;

        const analysis = await evaluateJobContentAgainstFilter({
          jobContent,
          jobLink,
          signal: filterSignal,
        });
        const decision = evaluateJobFilterAnalysis(analysis);

        await updateGoogleSheetsRow({
          sheetId,
          tabName,
          row: rowNumber,
          updates: [
            { col: resultCol, value: decision.result },
            { col: reasonCol, value: decision.reason ?? '' },
          ],
        });

        processedRows += 1;
      } catch (error) {
        errorRows += 1;
        const message = error instanceof Error ? error.message : 'Unknown row processing error';
        console.error(`[Filter Google Sheet] Row ${rowNumber} failed: ${message}`);
        if (rowErrors.length < 20) {
          rowErrors.push({ row: rowNumber, message });
        }
      }
    }

    res.json({
      spreadsheetId: sheetRange.spreadsheetId,
      spreadsheetTitle: sheetRange.spreadsheetTitle,
      selectedTab: tabName,
      provider: executionConfig.provider,
      modelName: executionConfig.modelName ?? '',
      startRow,
      endRow,
      jobLinkCol,
      resultCol,
      reasonCol,
      scannedRows: endRow - startRow + 1,
      processedRows,
      skippedRows,
      scrapedRows,
      errorRows,
      updatedRanges: [
        buildColumnRange(tabName, startRow, endRow, resultCol),
        buildColumnRange(tabName, startRow, endRow, reasonCol),
      ],
      rowErrors,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to filter Google Sheet jobs';
    const statusCode =
      // A 404 from the addressability guard, so a caller cannot learn whether
      // somebody else's spreadsheet exists by watching the status change.
      error instanceof SheetAccessError
        ? error.status
        : error instanceof GoogleSheetsRequestError
        ? error.statusCode
        : /rate limited/i.test(message)
          ? 429
          : 500;
    res.status(statusCode).json({ error: message, ...sheetsOperatorDetail(req, error) });
  }
});

export { buildExportRowDuplicateKeys, shouldSkipExistingFilterRow };
export default router;
