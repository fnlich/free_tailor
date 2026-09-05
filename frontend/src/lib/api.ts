const DEFAULT_LOCAL_API_BASE = 'http://localhost:3001/api';
const CONFIGURED_API_BASE = process.env.NEXT_PUBLIC_API_URL || DEFAULT_LOCAL_API_BASE;
const CONFIGURED_FALLBACK_API_BASE = (process.env.NEXT_PUBLIC_FALLBACK_API_URL || '').replace(/\/$/, '');
let resolvedApiBase = CONFIGURED_API_BASE;

function getBrowserMatchedApiBase(): string | null {
  if (typeof window === 'undefined') return null;

  try {
    const configuredUrl = new URL(CONFIGURED_API_BASE);
    configuredUrl.hostname = window.location.hostname;
    return configuredUrl.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function buildApiBaseCandidates(): string[] {
  const browserMatchedApiBase = getBrowserMatchedApiBase();
  const candidates = [resolvedApiBase];

  if (browserMatchedApiBase) {
    candidates.push(browserMatchedApiBase);
  }

  candidates.push(CONFIGURED_API_BASE);

  if (CONFIGURED_FALLBACK_API_BASE) {
    candidates.push(CONFIGURED_FALLBACK_API_BASE);
  }
  return [...new Set(candidates)];
}

function getCurrentApiBase(): string {
  return resolvedApiBase;
}

/** API base for callers that issue their own fetches: prefers the host the page was loaded from. */
export function getPreferredApiBase(): string {
  return getBrowserMatchedApiBase() ?? getCurrentApiBase();
}

export function getApiOrigin(): string {
  return getCurrentApiBase().replace(/\/api$/, '');
}

// Auth helpers
export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem('adminToken');
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem('adminToken', token);
  } catch {
    // Ignore storage errors (private mode / blocked storage)
  }
}

export function removeToken(): void {
  try {
    localStorage.removeItem('adminToken');
  } catch {
    // Ignore storage errors
  }
}

function getAuthHeaders(): HeadersInit {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Generic fetch wrapper
async function apiFetch<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const headers: HeadersInit = {
    ...getAuthHeaders(),
    ...options.headers,
  };

  // Don't set Content-Type for FormData
  if (!(options.body instanceof FormData)) {
    (headers as Record<string, string>)['Content-Type'] = 'application/json';
  }

  let lastConnectionError: Error | null = null;

  for (const apiBase of buildApiBaseCandidates()) {
    const url = `${apiBase}${endpoint}`;
    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(error.error || 'Request failed');
      }

      resolvedApiBase = apiBase;
      return response.json();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isConnectionIssue =
        message.includes('fetch') ||
        message.includes('Failed to fetch') ||
        message.includes('NetworkError');

      if (!isConnectionIssue) {
        throw error;
      }

      lastConnectionError = error instanceof Error ? error : new Error(message);
    }
  }

  throw lastConnectionError ?? new Error('Unable to connect to backend');
}

/**
 * `claude-cli` runs the server's local `claude` binary on a Claude
 * subscription seat; `claude` is the metered Anthropic API. They are separate
 * ids on purpose - one costs nothing per request and the other bills.
 *
 * The former `openrouter` id was replaced by `claude-cli`.
 */
export type AIProvider = 'claude-cli' | 'claude' | 'openai' | 'deepseek';

export type ProviderMeta = {
  label: string;
  requiresApiKey: boolean;
  /** Placeholder for the model-name field on the Models admin page. */
  modelNameHint: string;
};

/**
 * Mirrors backend/src/config/providerCatalog.ts. `satisfies` makes a missing
 * entry a build error rather than a label that silently reads as another
 * provider - which is what the old label function did, falling through to
 * "DeepSeek" for anything it did not recognise.
 */
export const PROVIDER_META = {
  'claude-cli': {
    label: 'Claude (subscription)',
    requiresApiKey: false,
    modelNameHint: 'sonnet, opus, haiku',
  },
  claude: { label: 'Anthropic API', requiresApiKey: true, modelNameHint: 'claude-sonnet-4-20250514' },
  openai: { label: 'OpenAI', requiresApiKey: true, modelNameHint: 'gpt-5.1' },
  deepseek: { label: 'DeepSeek', requiresApiKey: true, modelNameHint: 'deepseek-v4-flash' },
} as const satisfies Record<AIProvider, ProviderMeta>;

export const AI_PROVIDERS: AIProvider[] = Object.keys(PROVIDER_META) as AIProvider[];

export function getAIProviderLabel(provider: AIProvider): string {
  return PROVIDER_META[provider]?.label ?? provider;
}

export function providerRequiresApiKey(provider: AIProvider): boolean {
  return PROVIDER_META[provider]?.requiresApiKey ?? true;
}

/** Provider ids an older release wrote, and what they mean now. */
const LEGACY_PROVIDER_ALIASES: Record<string, AIProvider> = { openrouter: 'claude-cli' };

/** Narrows an untrusted provider string, following legacy aliases. */
export function coerceProvider(value: unknown): AIProvider | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed in PROVIDER_META) return trimmed as AIProvider;
  return LEGACY_PROVIDER_ALIASES[trimmed] ?? null;
}
export type DefaultMode = 'preview' | 'generate';
export type ThemeMode = 'light' | 'dark';
export type DefaultResumeSelection = 'single' | 'all' | 'group';

export interface GoogleSheetSource {
  id: string;
  name: string;
  sheetId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AIModelRecord {
  id: string;
  name: string;
  provider: AIProvider;
  modelName: string;
  description: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type LinkedInPostedSince = 'past-24-hours' | 'past-week' | 'past-month';
export type ScraperSource = 'linkedin' | 'indeed' | 'jobboard' | 'wellfound' | 'lever' | 'hiringcafe';
export type ScraperTimePosted = '24h' | '3d' | '7d' | '30d';
export type ScraperJobType = 'full-time' | 'part-time' | 'contract' | 'internship' | 'temporary';

export interface ScraperProviderSummary {
  id: string;
  label: string;
  description: string;
}

export interface ScraperSourceProviderCatalog {
  source: ScraperSource;
  defaultProviderId: string;
  providers: ScraperProviderSummary[];
}

export interface LinkedInJobCriteria {
  label: string;
  value: string;
}

export interface LinkedInJob {
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

export interface LinkedInJobSearchResponse {
  fetchedAt: string;
  filters: {
    keywords: string;
    postedSince: LinkedInPostedSince;
    location: string;
    workplaceType: 'remote';
    excludeEasyApply: true;
    limit: number;
  };
  results: LinkedInJob[];
}

export interface LinkedInJobSheetExportSummary {
  spreadsheetId: string;
  spreadsheetTitle: string;
  selectedTab: string;
  updatedRanges: string[];
  rowsWritten: number;
  startRow: number;
  endRow: number;
  unresolvedJobLinks: number;
  skippedCompanyDuplicates: number;
  beforeExportResultCount?: number;
}

export interface LinkedInJobSearchAndExportResponse extends LinkedInJobSearchResponse {
  export: LinkedInJobSheetExportSummary;
}

export interface ScraperJob {
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
}

export interface ScraperRunFilters {
  title?: string;
  rows?: number;
  keywords?: string;
  startUrl?: string;
  location?: string;
  timePosted?: ScraperTimePosted;
  jobType?: ScraperJobType;
  remoteOnly?: boolean;
  maxResults?: number;
  rawResultCount?: number;
  resultsWithinPostedWindowCount?: number;
  remoteFilteredCount?: number;
}

export interface ScraperRunResponse {
  fetchedAt: string;
  source: ScraperSource;
  providerId: string;
  providerLabel: string;
  filters: ScraperRunFilters;
  results: ScraperJob[];
}

export interface ScraperExportResponse extends ScraperRunResponse {
  export: LinkedInJobSheetExportSummary;
}

export interface GoogleSheetJobFilterResponse {
  spreadsheetId: string;
  spreadsheetTitle: string;
  selectedTab: string;
  provider: AIProvider;
  modelName: string;
  startRow: number;
  endRow: number;
  jobLinkCol: number;
  resultCol: number;
  reasonCol: number;
  scannedRows: number;
  processedRows: number;
  skippedRows: number;
  scrapedRows: number;
  errorRows: number;
  updatedRanges: string[];
  rowErrors: Array<{
    row: number;
    message: string;
  }>;
}

// Admin API
export interface PublicAppSettings {
  /** Canonical enable flags, keyed by provider id. */
  providersEnabled: Record<AIProvider, boolean>;
  defaultMode: DefaultMode;
  defaultTheme: ThemeMode;
  defaultResumeSelection: DefaultResumeSelection;
  defaultGroupId: string;
  defaultProfileId: string;
  defaultModelId: string;
  defaultResumeDocxEnabled: boolean;
  defaultCoverLetterDocxEnabled: boolean;
  outputPathUsesJobTitle: boolean;
  aiModels: AIModelRecord[];
  googleSheetsSources: GoogleSheetSource[];
}

export type AIModelSettings = PublicAppSettings;

export interface AdminApiKeyEntry {
  id: string;
  name: string;
  preview: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface AdminApiKeyProviderSettings {
  /** false for a provider that authenticates without a key at all. */
  requiresApiKey: boolean;
  configured: boolean;
  activeSource: 'stored' | 'environment' | 'subscription' | 'none';
  activeKeyId: string | null;
  activePreview: string | null;
  environmentPreview: string | null;
  entries: AdminApiKeyEntry[];
}

export interface AdminAppSettings extends PublicAppSettings {
  outputBaseDir: string;
  outputPathTemplate: string;
  outputPathPreview: string;
  apiKeys: Record<AIProvider, AdminApiKeyProviderSettings>;
}

function normalizeGoogleSheetSources(value: unknown): GoogleSheetSource[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((entry): entry is GoogleSheetSource => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : '',
      name: typeof entry.name === 'string' ? entry.name : '',
      sheetId: typeof entry.sheetId === 'string' ? entry.sheetId : '',
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
    }))
    .filter((entry) => entry.id && entry.name && entry.sheetId);
}

/**
 * Reads the enable flags, accepting the canonical record and the flat
 * per-provider booleans an older backend sends (including `openrouterEnabled`,
 * which was the flag for the provider `claude-cli` replaced).
 */
function normalizeProvidersEnabled(source: Record<string, unknown>): Record<AIProvider, boolean> {
  const record =
    typeof source.providersEnabled === 'object' && source.providersEnabled !== null
      ? (source.providersEnabled as Record<string, unknown>)
      : null;

  const legacyField: Record<AIProvider, string> = {
    'claude-cli': 'claudeCliEnabled',
    claude: 'claudeEnabled',
    openai: 'openaiEnabled',
    deepseek: 'deepseekEnabled',
  };

  const result = {} as Record<AIProvider, boolean>;
  for (const provider of AI_PROVIDERS) {
    const fromRecord = record?.[provider];
    if (typeof fromRecord === 'boolean') {
      result[provider] = fromRecord;
      continue;
    }
    const flat = source[legacyField[provider]];
    if (typeof flat === 'boolean') {
      result[provider] = flat;
      continue;
    }
    if (provider === 'claude-cli' && typeof source.openrouterEnabled === 'boolean') {
      result[provider] = source.openrouterEnabled as boolean;
      continue;
    }
    result[provider] = true;
  }
  return result;
}

/** The shape used before any settings have loaded. Exported so pages that
 * need an optimistic default do not each hand-copy a literal that has to stay
 * structurally identical to this interface. */
export const DEFAULT_PUBLIC_APP_SETTINGS: PublicAppSettings = {
  providersEnabled: AI_PROVIDERS.reduce(
    (acc, provider) => ({ ...acc, [provider]: true }),
    {} as Record<AIProvider, boolean>
  ),
  defaultMode: 'preview',
  defaultTheme: 'light',
  defaultResumeSelection: 'single',
  defaultGroupId: '',
  defaultProfileId: '',
  defaultModelId: '',
  defaultResumeDocxEnabled: true,
  defaultCoverLetterDocxEnabled: true,
  outputPathUsesJobTitle: true,
  aiModels: [],
  googleSheetsSources: [],
};

function normalizePublicAppSettings(value: unknown): PublicAppSettings {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Partial<PublicAppSettings> &
    Record<string, unknown>;

  return {
    providersEnabled: normalizeProvidersEnabled(source),
    defaultMode: source.defaultMode === 'generate' ? 'generate' : 'preview',
    defaultTheme: source.defaultTheme === 'dark' ? 'dark' : 'light',
    defaultResumeSelection:
      source.defaultResumeSelection === 'all' || source.defaultResumeSelection === 'group'
        ? source.defaultResumeSelection
        : 'single',
    defaultGroupId: typeof source.defaultGroupId === 'string' ? source.defaultGroupId : '',
    defaultProfileId: typeof source.defaultProfileId === 'string' ? source.defaultProfileId : '',
    defaultModelId: typeof source.defaultModelId === 'string' ? source.defaultModelId : '',
    defaultResumeDocxEnabled:
      typeof source.defaultResumeDocxEnabled === 'boolean' ? source.defaultResumeDocxEnabled : true,
    defaultCoverLetterDocxEnabled:
      typeof source.defaultCoverLetterDocxEnabled === 'boolean' ? source.defaultCoverLetterDocxEnabled : true,
    outputPathUsesJobTitle:
      typeof source.outputPathUsesJobTitle === 'boolean' ? source.outputPathUsesJobTitle : true,
    aiModels: Array.isArray(source.aiModels)
      ? source.aiModels
          .filter((entry): entry is AIModelRecord => typeof entry === 'object' && entry !== null)
          .map((entry) => ({
            id: typeof entry.id === 'string' ? entry.id : '',
            name: typeof entry.name === 'string' ? entry.name : '',
            // Coerced, not whitelisted: this used to rewrite anything it did
            // not recognise to 'openai', so a model row for a newer provider
            // displayed, filtered and default-gated as OpenAI.
            provider: coerceProvider(entry.provider) ?? 'claude-cli',
            modelName: typeof entry.modelName === 'string' ? entry.modelName : '',
            description: typeof entry.description === 'string' ? entry.description : '',
            enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
            createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
            updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
          }) satisfies AIModelRecord)
          .filter((entry) => entry.id && entry.modelName)
      : [],
    googleSheetsSources: normalizeGoogleSheetSources(source.googleSheetsSources),
  };
}

function emptyApiKeyState(provider: AIProvider): AdminApiKeyProviderSettings {
  const keyless = !providerRequiresApiKey(provider);
  return {
    requiresApiKey: !keyless,
    configured: keyless,
    activeSource: keyless ? 'subscription' : 'none',
    activeKeyId: null,
    activePreview: null,
    environmentPreview: null,
    entries: [],
  };
}

function normalizeAdminAppSettings(value: unknown): AdminAppSettings {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Partial<AdminAppSettings>;
  const rawKeys =
    typeof source.apiKeys === 'object' && source.apiKeys !== null
      ? (source.apiKeys as Partial<Record<AIProvider, Partial<AdminApiKeyProviderSettings>>>)
      : {};

  // Every provider gets an entry, present in the payload or not. The settings
  // page indexes this map unguarded in several places, so a provider the
  // backend does not send back - which is exactly what a deploy-order skew
  // produces - used to blank the whole admin page with a TypeError.
  const apiKeys = AI_PROVIDERS.reduce((acc, provider) => {
    const fallback = emptyApiKeyState(provider);
    const incoming = rawKeys[provider];
    acc[provider] = incoming ? { ...fallback, ...incoming } : fallback;
    return acc;
  }, {} as Record<AIProvider, AdminApiKeyProviderSettings>);

  return {
    ...normalizePublicAppSettings(source),
    outputBaseDir: typeof source.outputBaseDir === 'string' ? source.outputBaseDir : '',
    outputPathTemplate: typeof source.outputPathTemplate === 'string' ? source.outputPathTemplate : '',
    outputPathPreview: typeof source.outputPathPreview === 'string' ? source.outputPathPreview : '',
    apiKeys,
  };
}

export interface ApiKeyProviderUpdate {
  activeKeyId?: string;
  add?: Array<{
    clientId?: string;
    name?: string;
    value: string;
  }>;
  removeIds?: string[];
  useEnvironmentFallback?: boolean;
}

export interface AdminAppSettingsUpdate extends Partial<PublicAppSettings> {
  outputBaseDir?: string;
  outputPathTemplate?: string;
  apiKeys?: Partial<Record<AIProvider, ApiKeyProviderUpdate | string>>;
}

export interface BrowseOutputDirectoryResponse {
  selectedPath: string | null;
}

export interface GoogleSheetTab {
  title: string;
  index: number;
  sheetId: number;
}

export interface GoogleSheetColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

export interface GoogleSheetBorder {
  style: string;
  color: GoogleSheetColor;
}

export interface GoogleSheetTextFormat {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  fontSize: number | null;
  fontFamily: string | null;
  foregroundColor: GoogleSheetColor | null;
}

export interface GoogleSheetCellFormat {
  backgroundColor: GoogleSheetColor | null;
  textFormat: GoogleSheetTextFormat | null;
  horizontalAlignment: string | null;
  verticalAlignment: string | null;
  wrapStrategy: string | null;
  borders: {
    top: GoogleSheetBorder | null;
    right: GoogleSheetBorder | null;
    bottom: GoogleSheetBorder | null;
    left: GoogleSheetBorder | null;
  };
}

export interface GoogleSheetCell {
  value: string;
  format: GoogleSheetCellFormat | null;
}

export interface GoogleSheetMergeRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

export interface GoogleSheetsRangeRequest {
  sheetId: string;
  tabName?: string;
  fromRow?: number;
  toRow?: number;
  fromCol?: number;
  toCol?: number;
}

export interface GoogleSheetsUpdateRangeRequest extends GoogleSheetsRangeRequest {
  values: string[][];
}

export interface GoogleSheetsRangeResponse {
  spreadsheetId: string;
  spreadsheetTitle: string;
  tabs: GoogleSheetTab[];
  selectedTab?: string;
  range?: {
    fromRow: number;
    toRow: number;
    fromCol: number;
    toCol: number;
    a1Notation: string;
  };
  cells?: GoogleSheetCell[][];
  rowHeights?: number[];
  columnWidths?: number[];
  merges?: GoogleSheetMergeRange[];
  values?: string[][];
  totalRows?: number;
  totalColumns?: number;
}

export interface GoogleSheetsUpdateRangeResponse {
  spreadsheetId: string;
  spreadsheetTitle: string;
  selectedTab: string;
  updatedRange: string;
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
}

/** Shape of GET /api/admin/ai/health. */
export interface ProviderHealthReport {
  providers: Array<{
    id: AIProvider;
    label: string;
    summary: string;
    credentialKind: 'api-key' | 'subscription-seat';
    requiresApiKey: boolean;
    ok: boolean;
    detail: string;
    warning: string | null;
    authMethod: string | null;
    checkedAt: string;
  }>;
  subscription: {
    seat: { utilization: number | null; resetsAt: string | null; observedAt: string | null };
    outages: Array<{ scope: string; reason: string; expiresAt: string }>;
  };
  concurrency: Record<string, { limit: number; inFlight: number; queued: number }>;
  usage: {
    totals: {
      calls: number;
      failures: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      costUsd: number;
    };
    /** Per-provider totals, so a card can report only its own provider. */
    byProvider: Record<
      string,
      { calls: number; failures: number; inputTokens: number; outputTokens: number; costUsd: number }
    >;
  };
}

export const adminApi = {
  getAiHealth: () => apiFetch<ProviderHealthReport>('/admin/ai/health'),

  login: (password: string) =>
    apiFetch<{ token: string; message: string }>('/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  logout: () =>
    apiFetch<{ message: string }>('/admin/logout', {
      method: 'POST',
    }),

  verify: () =>
    apiFetch<{ valid: boolean }>('/admin/verify'),

  getSettings: async () =>
    normalizeAdminAppSettings(await apiFetch<AdminAppSettings>('/admin/settings')),

  browseOutputDirectory: (currentPath?: string) =>
    apiFetch<BrowseOutputDirectoryResponse>('/admin/browse-output-directory', {
      method: 'POST',
      body: JSON.stringify({ currentPath }),
    }),

  fetchGoogleSheetRange: (data: GoogleSheetsRangeRequest) =>
    apiFetch<GoogleSheetsRangeResponse>('/admin/google-sheets/range', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateGoogleSheetRange: (data: GoogleSheetsUpdateRangeRequest) =>
    apiFetch<GoogleSheetsUpdateRangeResponse>('/admin/google-sheets/range', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  updateSettings: async (data: AdminAppSettingsUpdate) =>
    normalizeAdminAppSettings(await apiFetch<AdminAppSettings>('/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(data),
    })),

  getAIModels: async () =>
    normalizeAdminAppSettings(await apiFetch<AdminAppSettings>('/admin/ai-models')),

  updateAIModels: async (data: AdminAppSettingsUpdate) =>
    normalizeAdminAppSettings(await apiFetch<AdminAppSettings>('/admin/ai-models', {
      method: 'PUT',
      body: JSON.stringify(data),
    })),

  listModels: async () =>
    (await apiFetch<{ models: AIModelRecord[] }>('/admin/models')).models,

  createModel: async (data: {
    name: string;
    provider: AIProvider;
    modelName: string;
    description?: string;
    enabled?: boolean;
  }) =>
    normalizeAdminAppSettings(await apiFetch<AdminAppSettings>('/admin/models', {
      method: 'POST',
      body: JSON.stringify(data),
    })),

  updateModel: async (
    id: string,
    data: {
      name?: string;
      provider?: AIProvider;
      modelName?: string;
      description?: string;
      enabled?: boolean;
    }
  ) =>
    normalizeAdminAppSettings(await apiFetch<AdminAppSettings>(`/admin/models/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })),

  deleteModel: async (id: string) =>
    normalizeAdminAppSettings(await apiFetch<AdminAppSettings>(`/admin/models/${id}`, {
      method: 'DELETE',
    })),
};

export const importApi = {
  fetchGoogleSheetRange: (data: GoogleSheetsRangeRequest) =>
    apiFetch<GoogleSheetsRangeResponse>('/import', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

export const jobsApi = {
  getScraperProviders: () => apiFetch<ScraperSourceProviderCatalog[]>('/jobs/scrapers/providers'),

  searchLinkedIn: (data: { keywords: string; postedSince: LinkedInPostedSince; limit?: number }) => {
    const params = new URLSearchParams({
      keywords: data.keywords,
      postedSince: data.postedSince,
    });

    if (typeof data.limit === 'number') {
      params.set('limit', String(data.limit));
    }

    return apiFetch<LinkedInJobSearchResponse>(`/jobs/linkedin?${params.toString()}`);
  },

  searchLinkedInAndExport: (data: {
    keywords: string;
    postedSince: LinkedInPostedSince;
    limit?: number;
    sheetId: string;
    tabName: string;
    startRow: number;
    companyNameCol: number;
    jobTitleCol: number;
    jobLinkCol: number;
    jobDescriptionCol: number;
  }) =>
    apiFetch<LinkedInJobSearchAndExportResponse>('/jobs/linkedin/search-and-export', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  runScraper: (data: ScraperRunFilters & { source: ScraperSource; provider?: string }) =>
    apiFetch<ScraperRunResponse>('/jobs/scrapers/run', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  exportScraperToGoogleSheet: (data: ScraperRunFilters & {
    source: ScraperSource;
    provider?: string;
    sheetId: string;
    tabName: string;
    startRow: number;
    companyNameCol: number;
    jobTitleCol: number;
    jobLinkCol: number;
    jobDescriptionCol: number;
  }) =>
    apiFetch<ScraperExportResponse>('/jobs/scrapers/export', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  filterGoogleSheetJobs: (data: {
    sheetId: string;
    tabName: string;
    startRow: number;
    endRow: number;
    jobLinkCol: number;
    resultCol: number;
    reasonCol: number;
  }) =>
    apiFetch<GoogleSheetJobFilterResponse>('/jobs/filter-google-sheet', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// Profile types
export interface Contact {
  phone: string;
  email: string;
  linkedin?: string;
  github?: string;
  portfolio?: string;
  location: string;
}

export interface Experience {
  title: string;
  company: string;
  startDate: string;
  endDate: string;
  location: string;
  description: string;
  achievements: string[];
  skills: string[];
}

export interface Strength {
  title: string;
  description: string;
}

export interface Education {
  degree: string;
  institution: string;
  startDate: string;
  endDate: string;
  location: string;
}

export type HardSkillOrdering = 'library' | 'job-priority';

export interface ProfileSettings {
  resumePromptId?: string;
  analyzeJobPromptId?: string;
  coverLetterPromptId?: string;
  resumeFileNameTemplate?: string;
  coverLetterFileNameTemplate?: string;
  companyFolderNameTemplate?: string;
  hardSkillOrdering?: HardSkillOrdering;
}

export interface Profile {
  id: string;
  name: string;
  title: string;
  totalYearsExperience?: number;
  preferredTemplate?: string;
  disabled?: boolean;
  profileSettings?: ProfileSettings;
  contact: Contact;
  summary: string;
  experience: Experience[];
  strengths: Strength[];
  skills?: string[];
  hardSkills?: string[];
  softSkills?: string[];
  education: Education[];
  certifications?: Array<{
    name: string;
    issuer: string;
    date: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface Group {
  id: string;
  name: string;
  profileIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateProfileDTO {
  name?: string;
  title?: string;
  totalYearsExperience?: number;
  contact?: Partial<Contact>;
  summary?: string;
  experience?: Partial<Experience>[];
  strengths?: Partial<Strength>[];
  skills?: string[];
  hardSkills?: string[];
  softSkills?: string[];
  education?: Partial<Education>[];
  preferredTemplate?: string;
  disabled?: boolean;
  profileSettings?: ProfileSettings;
}

// Template types
export interface ManualTemplateConfigStored {
  name: string;
  description?: string;
  columns: 1 | 2;
  accentColor?: string;
  bodyColor?: string;
  bodyFontSizePt?: number;
  titleFontSizePt?: number;
  sectionOrder?: string[];
  leftSectionOrder?: string[];
  rightSectionOrder?: string[];
  nameStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: string };
  headerTitleStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: string };
  contactStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: string };
  sectionStyles?: Record<string, Record<string, { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: string }>>;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  disabled?: boolean;
  htmlContent: string;
  cssContent: string;
  sections: string[];
  createdAt: string;
  updatedAt: string;
  manualConfig?: ManualTemplateConfigStored;
  isBuiltIn?: boolean;
}

export type PromptResponseFormat = 'json' | 'text';
export type PromptFeatureKey =
  | 'analyze-job-description'
  | 'tailor-resume'
  | 'generate-cover-letter'
  | 'extract-template-from-pdf'
  | 'extract-profile-from-resume'
  | 'filter-google-sheet-job';

export interface AIModelOption {
  id: string;
  label: string;
  provider: AIProvider;
  modelName: string;
  description: string;
}

export interface PromptVariableDefinition {
  name: string;
  description?: string;
  sampleValue?: string;
}

export interface PromptValidation {
  usedVariables: string[];
  unknownVariables: string[];
}

export interface PromptSummary {
  id: string;
  name: string;
  description: string;
  featureKey?: PromptFeatureKey;
  featureLabel?: string;
  responseFormat: PromptResponseFormat;
  modelProvider?: AIProvider;
  modelName?: string;
  allowedVariables: PromptVariableDefinition[];
  validation: PromptValidation;
  isBuiltIn: boolean;
  isActiveForFeature?: boolean;
  usage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PromptRecord extends PromptSummary {
  content: string;
}

export interface PromptPreviewResult {
  renderedContent: string;
  sampleValues: Record<string, string>;
  validation: PromptValidation;
}

// Job Analysis types
export interface JobAnalysis {
  jobMeta: {
    title: string;
    seniority: string;
    industry: string;
    department: string;
  };
  skills: {
    technical: string[];
    required: string[];
    preferred: string[];
    tools: string[];
    soft: string[];
    technologies: string[];
  };
  technologies: string[];
  protocols: string[];
  methodologies: string[];
  architecturePatterns: string[];
  responsibilities: string[];
  domainKnowledge: string[];
  softSkills: string[];
  keywords: {
    actionVerbs: string[];
    buzzwords: string[];
    mustInclude: string[];
  };
  sourceJobDescription?: string;
}

export interface TailoredExperience {
  title: string;
  company: string;
  startDate: string;
  endDate: string;
  location: string;
  description: string;
  achievements: string[];
}

export interface TailoredStrength {
  title: string;
  description: string;
}

export interface TailoredContent {
  title: string;
  summary: string;
  experience: TailoredExperience[];
  skills: string[];
  hardSkills: string[];
  softSkills: string[];
  requiredSkills?: string[];
  preferredSkills?: string[];
  strengths: TailoredStrength[];
  unconfirmedHardSkills?: string[];
  unconfirmedSoftSkills?: string[];
  coverLetter?: string;
}

// Profiles API
export const profilesApi = {
  getAll: (options?: { includeDisabled?: boolean }) =>
    apiFetch<Profile[]>(
      options?.includeDisabled ? '/profiles?includeDisabled=true' : '/profiles'
    ),

  getById: (id: string) => apiFetch<Profile>(`/profiles/${id}`),

  create: (data: CreateProfileDTO) =>
    apiFetch<Profile>('/profiles', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Partial<CreateProfileDTO>) =>
    apiFetch<Profile>(`/profiles/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    apiFetch<{ message: string }>(`/profiles/${id}`, {
      method: 'DELETE',
    }),

  uploadResume: (file: File) => {
    const formData = new FormData();
    formData.append('resume', file);
    return apiFetch<Profile>('/profiles/upload', {
      method: 'POST',
      body: formData,
    });
  },
};

// Groups API
export const groupsApi = {
  getAll: () => apiFetch<Group[]>('/groups'),

  create: (data: { name: string; profileIds: string[] }) =>
    apiFetch<Group>('/groups', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: { name?: string; profileIds?: string[] }) =>
    apiFetch<Group>(`/groups/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    apiFetch<{ message: string }>(`/groups/${id}`, {
      method: 'DELETE',
    }),
};

// Templates API
export const templatesApi = {
  getAll: (options?: { includeDisabled?: boolean }) =>
    apiFetch<Template[]>(
      options?.includeDisabled ? '/templates?includeDisabled=true' : '/templates'
    ),

  getById: (id: string) => apiFetch<Template>(`/templates/${id}`),

  update: (id: string, data: { disabled?: boolean; name?: string; description?: string }) =>
    apiFetch<Template>(`/templates/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  upload: async (file: File, name: string): Promise<Template> => {
    const formData = new FormData();
    formData.append('pdf', file);
    formData.append('name', name);

    return apiFetch<Template>('/templates/upload', {
      method: 'POST',
      body: formData,
    });
  },

  uploadJson: async (file: File): Promise<Template> => {
    const formData = new FormData();
    formData.append('template', file);

    return apiFetch<Template>('/templates/upload-json', {
      method: 'POST',
      body: formData,
    });
  },

  delete: (id: string) =>
    apiFetch<{ message: string }>(`/templates/${id}`, {
      method: 'DELETE',
    }),

  updateManual: (id: string, config: {
    name: string;
    description?: string;
    columns?: 1 | 2;
    accentColor?: string;
    bodyColor?: string;
    bodyFontSizePt?: number;
    titleFontSizePt?: number;
    sectionOrder?: string[];
    leftSectionOrder?: string[];
    rightSectionOrder?: string[];
    nameStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    headerTitleStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    contactStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    titleStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    subTitleStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    paragraphStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    sectionStyles?: Record<string, Record<string, { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: string }>>;
  }) =>
    apiFetch<Template>(`/templates/${id}/update-manual`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),

  createManual: (config: {
    name: string;
    description?: string;
    columns?: 1 | 2;
    accentColor?: string;
    bodyColor?: string;
    bodyFontSizePt?: number;
    titleFontSizePt?: number;
    sectionOrder?: string[];
    leftSectionOrder?: string[];
    rightSectionOrder?: string[];
    nameStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    headerTitleStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    contactStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    titleStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    subTitleStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    paragraphStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    sectionStyles?: Record<string, Record<string, { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: string }>>;
  }) =>
    apiFetch<Template>('/templates/create-manual', {
      method: 'POST',
      body: JSON.stringify(config),
    }),
};

export const promptsApi = {
  getAll: () => apiFetch<PromptSummary[]>('/prompts'),

  getById: (id: string) => apiFetch<PromptRecord>(`/prompts/${id}`),

  create: (data: {
    name: string;
    description?: string;
    featureKey?: PromptFeatureKey;
    content: string;
    responseFormat?: PromptResponseFormat;
    modelProvider?: AIProvider;
    modelName?: string;
    allowedVariables?: PromptVariableDefinition[];
  }) =>
    apiFetch<PromptRecord>('/prompts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (
    id: string,
    data: {
      name?: string;
      description?: string;
      featureKey?: PromptFeatureKey;
      content: string;
      responseFormat?: PromptResponseFormat;
      modelProvider?: AIProvider;
      modelName?: string;
      allowedVariables?: PromptVariableDefinition[];
    }
  ) =>
    apiFetch<PromptRecord>(`/prompts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    apiFetch<{ message: string }>(`/prompts/${id}`, {
      method: 'DELETE',
    }),

  activate: (id: string) =>
    apiFetch<{ featureKey: PromptFeatureKey; promptId: string }>(`/prompts/${id}/activate`, {
      method: 'POST',
    }),

  getModelOptions: () => apiFetch<AIModelOption[]>('/prompts/models'),

  validateDraft: (data: {
    id?: string;
    content?: string;
    allowedVariables?: PromptVariableDefinition[];
    sampleValues?: Record<string, string>;
  }) =>
    apiFetch<PromptValidation>('/prompts/validate', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  previewDraft: (data: {
    id?: string;
    content?: string;
    allowedVariables?: PromptVariableDefinition[];
    sampleValues?: Record<string, string>;
  }) =>
    apiFetch<PromptPreviewResult>('/prompts/preview', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// Resume API
export const resumeApi = {
  getModels: async () => normalizePublicAppSettings(await apiFetch<PublicAppSettings>('/resume/models')),

  analyze: (jobDescription: string, model?: string, promptId?: string) =>
    apiFetch<JobAnalysis>('/resume/analyze', {
      method: 'POST',
      body: JSON.stringify({ jobDescription, model, promptId }),
    }),

  analyzePromptTest: (jobDescription: string, model?: string, promptId?: string) =>
    apiFetch<unknown>('/resume/analyze-prompt-test', {
      method: 'POST',
      body: JSON.stringify({ jobDescription, model, promptId }),
    }),

  analyzeMultiJob: (data: {
    jobs: Array<{
      companyName: string;
      jobDescription: string;
      sourceRowNumber?: number;
    }>;
    model?: string;
  }) =>
    apiFetch<{
      provider: AIProvider;
      analyzed: number;
      analyses: Array<{
        companyName: string;
        sourceRowNumber?: number;
        jobDescription: string;
        analysis: JobAnalysis;
      }>;
      failed: number;
      failures: Array<{
        companyName: string;
        sourceRowNumber?: number;
        error: string;
      }>;
    }>('/resume/analyze-multi-job', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  generate: (data: {
    profileId: string;
    templateId: string;
    jobDescription?: string;
    jobAnalysis?: JobAnalysis;
    tailoredContent?: TailoredContent;
    companyName: string;
    role: string;
    sourceRowNumber?: number;
    model?: string;
    format?: 'pdf' | 'docx' | 'both';
    includeCoverLetterDocx?: boolean;
  }) =>
    apiFetch<
      | {
          filename: string;
          downloadUrl: string;
          tailored: boolean;
          format?: 'pdf' | 'docx';
          unconfirmedHardSkills?: string[];
          unconfirmedSoftSkills?: string[];
        }
      | {
          pdf: { filename: string; downloadUrl: string };
          docx: { filename: string; downloadUrl: string };
          coverLetter?: {
            pdf: { filename: string; downloadUrl: string };
            docx?: { filename: string; downloadUrl: string };
          };
          tailored: boolean;
          unconfirmedHardSkills?: string[];
          unconfirmedSoftSkills?: string[];
        }
    >(
      '/resume/generate',
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    ),

  generateAll: (data: {
    templateId?: string;
    jobDescription?: string;
    jobAnalysis?: JobAnalysis;
    companyName: string;
    role: string;
    model?: string;
    profileIds?: string[];
    format?: 'pdf' | 'docx' | 'both';
    includeCoverLetterDocx?: boolean;
  }) =>
    apiFetch<{
      generated: number;
      failed: number;
      results: Array<{
        profileId: string;
        profileName: string;
        pdf?: string;
        docx?: string;
        coverLetterPdf?: string;
        coverLetterDocx?: string;
      }>;
      failures: Array<{
        profileId: string;
        profileName: string;
        companyName: string;
        error: string;
      }>;
      failedCompanies: string[];
      tailored: boolean;
      unconfirmedHardSkills?: string[];
      unconfirmedSoftSkills?: string[];
    }>('/resume/generate-all', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  generateMultiJob: (data: {
    templateId?: string;
    jobs: Array<{
      companyName: string;
      role: string;
      jobDescription?: string;
      jobAnalysis?: JobAnalysis;
      sourceRowNumber?: number;
    }>;
    model?: string;
    profileIds?: string[];
    format?: 'pdf' | 'docx' | 'both';
    includeCoverLetterDocx?: boolean;
  }) =>
    apiFetch<{
      generated: number;
      failed: number;
      results: Array<{
        profileId: string;
        profileName: string;
        companyName: string;
        role: string;
        pdf?: string;
        docx?: string;
        coverLetterPdf?: string;
        coverLetterDocx?: string;
      }>;
      failures: Array<{
        profileId: string;
        profileName: string;
        companyName: string;
        error: string;
      }>;
      failedCompanies: string[];
      tailored: boolean;
      unconfirmedHardSkills?: string[];
      unconfirmedSoftSkills?: string[];
    }>('/resume/generate-multi-job', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  confirmSkill: (data: { type: 'hard' | 'soft'; skill: string }) =>
    apiFetch<{ added: boolean; skill: string; type: 'hard' | 'soft' }>('/resume/skills/confirm', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  listSkills: (type: 'hard' | 'soft') =>
    apiFetch<{ skills: string[] }>(`/resume/skills?type=${type}`),

  addSkill: (data: {
    type: 'hard' | 'soft';
    skill: string;
    category?: string;
    priority?: number;
  }) =>
    apiFetch<{ added: boolean; skill: string; type: 'hard' | 'soft' }>('/resume/skills', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateSkill: (data: { type: 'hard' | 'soft'; original: string; skill: string }) =>
    apiFetch<{ updated: boolean; skill: string; type: 'hard' | 'soft' }>('/resume/skills', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  deleteSkill: (data: { type: 'hard' | 'soft'; skill: string }) =>
    apiFetch<{ deleted: boolean; skill: string; type: 'hard' | 'soft' }>('/resume/skills', {
      method: 'DELETE',
      body: JSON.stringify(data),
    }),

  preview: (data: {
    profileId: string;
    templateId: string;
    jobDescription?: string;
    jobAnalysis?: JobAnalysis;
    tailoredContent?: TailoredContent;
    model?: string;
  }) =>
    apiFetch<{ html: string; tailored: boolean; tailoredContent?: TailoredContent }>('/resume/preview', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  previewAll: (data: {
    templateId?: string;
    jobDescription?: string;
    jobAnalysis?: JobAnalysis;
    model?: string;
    profileIds?: string[];
  }) =>
    apiFetch<{
      previews: Array<{
        profileId: string;
        profileName: string;
        html: string;
        tailoredContent?: TailoredContent;
      }>;
      tailored: boolean;
      unconfirmedHardSkills?: string[];
      unconfirmedSoftSkills?: string[];
    }>('/resume/preview-all', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getDownloadUrl: (filename: string) =>
    `${getCurrentApiBase()}/resume/download/${filename}`,
};
