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

/**
 * The backend answered, and said no.
 *
 * This exists so the retry loop below can tell "nothing is listening" from
 * "the server replied with an error", by TYPE rather than by reading the
 * message. The previous test was `message.includes('fetch')`, and almost every
 * error string the backend produces for a failed read is of the form
 * "Failed to fetch settings" / "Failed to fetch prompts" / "Failed to fetch
 * templates" (backend/src/routes/*.ts). Every one of those matched, so a plain
 * server-side 500 was classified as a lost connection and replayed against
 * every remaining candidate base - measured in a browser: 6 requests where 3
 * were made, for a page whose API was answering 500s. Retrying cannot help
 * there, because the server that answered is the right server.
 */
export class ApiResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string
  ) {
    super(message);
    this.name = 'ApiResponseError';
  }
}

/**
 * Set by frontend/scripts/next.mjs, and ONLY when it detected that
 * NEXT_PUBLIC_API_URL names a different port on this machine than the `PORT`
 * the backend listens on. That is the one failure a browser cannot describe:
 * a wrong port and a stopped server are the same `TypeError` to it. Carrying
 * the expected port into the bundle lets the message below name the real
 * problem instead of sending the reader off to check a port that was never
 * the one in question.
 */
const EXPECTED_API_PORT = process.env.NEXT_PUBLIC_EXPECTED_API_PORT || '';

/** Nothing answered at any candidate base. */
export class ApiUnreachableError extends Error {
  constructor(
    readonly triedUrls: string[],
    readonly cause: Error
  ) {
    super(
      `Cannot reach the backend at ${triedUrls.join(' or ')}. ` +
        (EXPECTED_API_PORT
          ? `The repository .env sets PORT=${EXPECTED_API_PORT}, so NEXT_PUBLIC_API_URL is pointing at ` +
            'the wrong port - set both to the same value, or remove NEXT_PUBLIC_API_URL to derive it. '
          : 'Check that it is running and listening on that port. ') +
        `(${cause.message})`
    );
    this.name = 'ApiUnreachableError';
  }
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
  const tried: string[] = [];

  for (const apiBase of buildApiBaseCandidates()) {
    const url = `${apiBase}${endpoint}`;
    tried.push(apiBase);

    let response: Response;
    try {
      response = await fetch(url, { ...options, headers });
    } catch (error) {
      // `fetch` rejects only when the request never completed: no server, DNS
      // failure, a refused CORS preflight, or a dropped connection. That, and
      // only that, is worth trying the next base for.
      lastConnectionError = error instanceof Error ? error : new Error(String(error));
      continue;
    }

    // From here the server answered, so the candidate is the right one even if
    // the answer is an error. Trying another base would only repeat it.
    resolvedApiBase = apiBase;

    if (!response.ok) {
      const body = await response.json().catch(() => ({}) as { error?: string });
      throw new ApiResponseError(
        body.error || `Request failed with HTTP ${response.status}`,
        response.status,
        url
      );
    }

    return response.json() as Promise<T>;
  }

  throw new ApiUnreachableError(
    tried,
    lastConnectionError ?? new Error('no API base was configured')
  );
}

/**
 * `claude-cli` runs the server's local `claude` binary on a Claude
 * subscription seat; `claude` is the metered Anthropic API. They are separate
 * ids on purpose - one costs nothing per request and the other bills.
 *
 * The former `openrouter` id was replaced by `claude-cli`.
 */
export type AIProvider =
  | 'claude-cli'
  | 'claude'
  | 'openai'
  | 'deepseek'
  | 'claude-web'
  | 'chatgpt-web';

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
  'claude-web': {
    label: 'Claude (browser)',
    requiresApiKey: false,
    modelNameHint: 'chat',
  },
  'chatgpt-web': {
    label: 'ChatGPT (browser)',
    requiresApiKey: false,
    modelNameHint: 'chat',
  },
} as const satisfies Record<AIProvider, ProviderMeta>;

export const AI_PROVIDERS: AIProvider[] = Object.keys(PROVIDER_META) as AIProvider[];

export function getAIProviderLabel(provider: AIProvider): string {
  return Object.prototype.hasOwnProperty.call(PROVIDER_META, provider)
    ? PROVIDER_META[provider].label
    : provider;
}

export function providerRequiresApiKey(provider: AIProvider): boolean {
  return PROVIDER_META[provider]?.requiresApiKey ?? true;
}

/** Provider ids an older release wrote, and what they mean now. */
const LEGACY_PROVIDER_ALIASES: Record<string, AIProvider> = { openrouter: 'claude-cli' };

/**
 * Narrows an untrusted provider string, following legacy aliases.
 *
 * Own-property checks throughout: `in` and a plain index both walk the
 * prototype chain, so "constructor" or "toString" would otherwise be accepted
 * as a provider id and resolve to an Object.prototype member.
 */
export function coerceProvider(value: unknown): AIProvider | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (Object.prototype.hasOwnProperty.call(PROVIDER_META, trimmed)) return trimmed as AIProvider;
  if (Object.prototype.hasOwnProperty.call(LEGACY_PROVIDER_ALIASES, trimmed)) {
    return LEGACY_PROVIDER_ALIASES[trimmed];
  }
  return null;
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

/** The `--effort` levels the Claude CLI accepts, lowest first. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * `default` leaves the models' own adaptive thinking alone - which is ON -
 * and `off` suppresses it. How deeply it thinks when it does is `effort`.
 */
export const THINKING_MODES = ['default', 'off'] as const;
export type ThinkingMode = (typeof THINKING_MODES)[number];

/**
 * A model, effort and thinking choice.
 *
 * Every field is optional and absent means INHERIT: a profile inherits the app
 * default, and one generation inherits the profile. That is why the same type
 * describes both layers.
 */
export interface AiPreferences {
  modelId?: string;
  effort?: EffortLevel;
  thinking?: ThinkingMode;
}

export interface AiPreferenceDefaults {
  effort: EffortLevel;
  thinking: ThinkingMode;
  effortLevels: EffortLevel[];
  thinkingModes: ThinkingMode[];
}

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low - fastest',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Very high',
  max: 'Max - slowest, most thorough',
};

export const THINKING_LABELS: Record<ThinkingMode, string> = {
  default: 'Let the model decide',
  off: 'Off - answer without thinking first',
};

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);
}

export function isThinkingMode(value: unknown): value is ThinkingMode {
  return typeof value === 'string' && (THINKING_MODES as readonly string[]).includes(value);
}

/**
 * The per-run override fields every generate endpoint accepts.
 *
 * Named `model` rather than `modelId` because that is the field the API has
 * always taken; the other two are new and keep their own names.
 */
export interface AiRequestOverrides {
  model?: string;
  effort?: EffortLevel;
  thinking?: ThinkingMode;
}

/** Only fields that were actually chosen are sent, so the rest inherit. */
export function toAiRequestOverrides(preferences: AiPreferences): AiRequestOverrides {
  return {
    ...(preferences.modelId ? { model: preferences.modelId } : {}),
    ...(preferences.effort ? { effort: preferences.effort } : {}),
    ...(preferences.thinking ? { thinking: preferences.thinking } : {}),
  };
}

export function normalizeAiPreferences(value: unknown): AiPreferences {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const preferences: AiPreferences = {};
  const modelId = typeof source.modelId === 'string' ? source.modelId.trim() : '';
  if (modelId) preferences.modelId = modelId;
  if (isEffortLevel(source.effort)) preferences.effort = source.effort;
  if (isThinkingMode(source.thinking)) preferences.thinking = source.thinking;
  return preferences;
}

/**
 * One provider this installation cannot run, and the models it would offer.
 *
 * Sent so a picker can keep those models on screen behind a padlock instead of
 * dropping them: a model that silently disappears reads as a bug, and "you
 * cannot pick this, and here is why" is the thing the user actually needs.
 * They are carried separately from `aiModels` because that list is the set of
 * models a request may name.
 */
/**
 * Which tuning knobs actually reach a given provider's model.
 *
 * A chat window has no effort flag and no thinking budget - there is nowhere to
 * put either - so the two selects have to go inactive rather than accept a
 * setting that changes nothing and says nothing.
 */
/**
 * The reserved model id that means "use both free chat accounts".
 *
 * Not a row in the model table: there is no provider to call and no model name
 * to send. The server synthesises it into the pickable list and resolves it per
 * call, so the pickers treat it like any other option and only this id has to
 * be recognised by name.
 */
export const HYBRID_MODEL_ID = 'free-hybrid';

export interface ProviderTuningSupport {
  provider: AIProvider;
  effort: boolean;
  thinking: boolean;
}

export interface ProviderLock {
  id: AIProvider;
  label: string;
  reason: string;
  models: AIModelRecord[];
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
  /** What a run uses when nothing overrides it, and the values on offer. */
  aiPreferenceDefaults: AiPreferenceDefaults;
  aiModels: AIModelRecord[];
  googleSheetsSources: GoogleSheetSource[];
  /** The debug browsers the free chat providers drive, one tab apiece. */
  browserChatEndpoints: BrowserChatEndpoint[];
  /** Providers locked in this build. Empty on a build that locks nothing. */
  providerLocks: ProviderLock[];
  /** Which providers honour effort and thinking at all. */
  providerTuning: ProviderTuningSupport[];
}

export type AIModelSettings = PublicAppSettings;

export interface AdminAppSettings extends PublicAppSettings {
  outputBaseDir: string;
  outputPathTemplate: string;
  outputPathPreview: string;
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

  // Partial on purpose, mirroring the backend catalog: a provider added after
  // these flat flags stopped being written has none, and inventing one would
  // only be a field with no writer.
  const legacyField: Partial<Record<AIProvider, string>> = {
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
    const field = legacyField[provider];
    const flat = field ? source[field] : undefined;
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
  aiPreferenceDefaults: {
    effort: 'low',
    thinking: 'default',
    effortLevels: [...EFFORT_LEVELS],
    thinkingModes: [...THINKING_MODES],
  },
  aiModels: [],
  googleSheetsSources: [],
  browserChatEndpoints: [],
  providerLocks: [],
  // Permissive until the server answers: a select greyed out on a guess would
  // stop somebody choosing an effort the provider does in fact honour.
  providerTuning: [],
};

/**
 * The lists come from the server so that a level added there shows up without
 * a frontend release; anything unrecognised is dropped rather than rendered as
 * an option that would be rejected on save.
 */
function normalizeAiPreferenceDefaults(value: unknown): AiPreferenceDefaults {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const effortLevels = Array.isArray(source.effortLevels)
    ? source.effortLevels.filter(isEffortLevel)
    : [];
  const thinkingModes = Array.isArray(source.thinkingModes)
    ? source.thinkingModes.filter(isThinkingMode)
    : [];
  return {
    effort: isEffortLevel(source.effort) ? source.effort : DEFAULT_PUBLIC_APP_SETTINGS.aiPreferenceDefaults.effort,
    thinking: isThinkingMode(source.thinking) ? source.thinking : 'default',
    effortLevels: effortLevels.length ? effortLevels : [...EFFORT_LEVELS],
    thinkingModes: thinkingModes.length ? thinkingModes : [...THINKING_MODES],
  };
}

function normalizeModelRecords(value: unknown): AIModelRecord[] {
  if (!Array.isArray(value)) return [];
  return value
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
    .filter((entry) => entry.id && entry.modelName);
}

/**
 * A lock with no provider id is dropped, and one with no reason is kept: the
 * padlock is the part that has to be right, and a build that locks something
 * without explaining itself should still say the model cannot be picked.
 */
function normalizeProviderTuning(value: unknown): ProviderTuningSupport[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => {
      const provider = coerceProvider(entry.provider);
      if (!provider) return null;
      return {
        provider,
        // Read strictly: a server that predates this field sends nothing, and
        // the empty list above is what makes that case permissive. A row that
        // IS sent is believed exactly as sent.
        effort: entry.effort === true,
        thinking: entry.thinking === true,
      } satisfies ProviderTuningSupport;
    })
    .filter((entry): entry is ProviderTuningSupport => entry !== null);
}

/**
 * Whether a model's provider honours a knob.
 *
 * Unknown is treated as yes. The alternative - greying a control because the
 * answer has not arrived - would stop somebody choosing an effort the provider
 * does honour, and on a page that loads settings asynchronously that is a race
 * they would hit as a flicker and then a locked select.
 */
export function providerHonours(
  tuning: ProviderTuningSupport[],
  provider: AIProvider | undefined,
  knob: 'effort' | 'thinking'
): boolean {
  if (!provider) return true;
  const row = tuning.find((entry) => entry.provider === provider);
  return row ? row[knob] : true;
}

function normalizeProviderLocks(value: unknown): ProviderLock[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => {
      const id = coerceProvider(entry.id);
      if (!id) return null;
      return {
        id,
        label: typeof entry.label === 'string' && entry.label ? entry.label : getAIProviderLabel(id),
        reason: typeof entry.reason === 'string' ? entry.reason : '',
        models: normalizeModelRecords(entry.models),
      } satisfies ProviderLock;
    })
    .filter((entry): entry is ProviderLock => entry !== null);
}

/**
 * The padlock, as one constant: the glyph has to mean the same thing on the
 * builder, the profile form, the provider list and the model table, and four
 * hand-typed emoji is how that stops being true.
 */
export const LOCK_ICON = '\u{1F512}';

/** Whether this installation can run the provider at all. */
export function isProviderLocked(
  settings: Pick<PublicAppSettings, 'providerLocks'>,
  provider: AIProvider
): boolean {
  return settings.providerLocks.some((lock) => lock.id === provider);
}

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
    aiPreferenceDefaults: normalizeAiPreferenceDefaults(source.aiPreferenceDefaults),
    browserChatEndpoints: Array.isArray(source.browserChatEndpoints)
      ? source.browserChatEndpoints
          .filter(
            (entry): entry is BrowserChatEndpoint =>
              typeof entry === 'object' &&
              entry !== null &&
              typeof (entry as BrowserChatEndpoint).port === 'number' &&
              (entry as BrowserChatEndpoint).siteId !== undefined
          )
          .map((entry) => ({ siteId: entry.siteId, port: entry.port }))
      : [],
    aiModels: normalizeModelRecords(source.aiModels),
    providerLocks: normalizeProviderLocks(source.providerLocks),
    providerTuning: normalizeProviderTuning(source.providerTuning),
    googleSheetsSources: normalizeGoogleSheetSources(source.googleSheetsSources),
  };
}

function normalizeAdminAppSettings(value: unknown): AdminAppSettings {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Partial<AdminAppSettings>;

  return {
    ...normalizePublicAppSettings(source),
    outputBaseDir: typeof source.outputBaseDir === 'string' ? source.outputBaseDir : '',
    outputPathTemplate: typeof source.outputPathTemplate === 'string' ? source.outputPathTemplate : '',
    outputPathPreview: typeof source.outputPathPreview === 'string' ? source.outputPathPreview : '',
  };
}

export interface AdminAppSettingsUpdate extends Partial<PublicAppSettings> {
  outputBaseDir?: string;
  outputPathTemplate?: string;
}

/** One debug browser: which chat site it shows, and the port it listens on. */
export interface BrowserChatEndpoint {
  siteId: AIProvider;
  port: number;
}

/** One chat site, and whether the debug browser has a tab on it. */
export interface DebugBrowserSite {
  id: AIProvider;
  label: string;
  url: string;
  open: boolean;
}

export interface DebugBrowserStatus {
  port: number;
  running: boolean;
  browser: string | null;
  sites: DebugBrowserSite[];
}

/**
 * What is registered for one chat platform, and how much of it is reachable.
 *
 * These are cheap port probes and stop short of the question that matters most:
 * a browser can be running with the site's tab open and still be SIGNED OUT,
 * and no port probe can tell. That answer comes from the provider health report
 * the same page already fetches - see `isPlatformActive`.
 */
export interface DebugPlatformStatus {
  id: AIProvider;
  label: string;
  /** Debug ports registered for this platform. */
  registeredPorts: number[];
  /** Of those, the ones with a browser answering. */
  runningPorts: number[];
  /** Of those, the ones showing this platform's site. */
  tabPorts: number[];
}

/**
 * Whether a registered platform is usable right now.
 *
 * The provider's own health answer, which drives the tab and looks for the
 * composer - so it separates "signed in and ready" from "a window is open on
 * the right site but signed out", which is the distinction an operator staring
 * at a running browser most needs made for them.
 */
export function isPlatformActive(
  health: ProviderHealthReport | null,
  platform: Pick<DebugPlatformStatus, 'id' | 'registeredPorts'>
): boolean {
  if (platform.registeredPorts.length === 0) return false;
  return Boolean(health?.providers.find((entry) => entry.id === platform.id)?.ok);
}

/** One configured browser, with what the server can see of it right now. */
export interface DebugBrowserEntry {
  siteId: AIProvider;
  port: number;
  status: DebugBrowserStatus;
}

/** What each provider's queue is doing: tabs, in use, and how many are waiting. */
export interface TabQueueStats {
  tabs: number;
  inUse: number;
  queued: number;
  endpoints: string[];
}

export interface DebugBrowserReport {
  browsers: DebugBrowserEntry[];
  platforms: DebugPlatformStatus[];
  queues: Record<string, TabQueueStats>;
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

  getDebugBrowsers: () => apiFetch<DebugBrowserReport>('/admin/browser/debug'),

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

/**
 * One heading in the Technical Skills block, and the skills under it.
 *
 * An empty `category` is the flat layout - not a missing heading, but the
 * statement that there is none.
 */
export interface SkillCategoryGroup {
  category: string;
  skills: string[];
}

/**
 * How the Technical Skills block is laid out: a heading per group, or one list
 * of names with no headings over it.
 */
export type TechnicalSkillsLayout = 'categorized' | 'flat';

/**
 * The headings the shared skill library sorts skills into.
 *
 * Here rather than on the one page that used to hold it, because a second page
 * now offers the same list and two copies would drift - and the drift would
 * show up as a heading that files correctly on one screen and not the other.
 */
export type HardSkillCategory =
  | 'Languages'
  | 'Frameworks and Libraries'
  | 'Software Architecture & Design'
  | 'Security'
  | 'Cloud and Infrastructure'
  | 'Databases and Storage'
  | 'DevOps and CI/CD'
  | 'Observability and Monitoring'
  | 'Testing and Quality'
  | 'APIs and Integration'
  | 'Engineering Practices & Methodology'
  | 'Data Engineering & Streaming'
  | 'AI/ML & Data Science'
  | 'Version Control & Collaboration'
  | 'Operating Systems & Platforms'
  | 'Frontend & UI/UX Development'
  | 'Mobile Development';

export const HARD_SKILL_CATEGORIES: HardSkillCategory[] = [
  'Languages',
  'Frameworks and Libraries',
  'Software Architecture & Design',
  'Security',
  'Cloud and Infrastructure',
  'Databases and Storage',
  'DevOps and CI/CD',
  'Observability and Monitoring',
  'Testing and Quality',
  'APIs and Integration',
  'Engineering Practices & Methodology',
  'Data Engineering & Streaming',
  'AI/ML & Data Science',
  'Version Control & Collaboration',
  'Operating Systems & Platforms',
  'Frontend & UI/UX Development',
  'Mobile Development',
];

export interface ProfileSettings {
  resumePromptId?: string;
  analyzeJobPromptId?: string;
  coverLetterPromptId?: string;
  resumeFileNameTemplate?: string;
  coverLetterFileNameTemplate?: string;
  companyFolderNameTemplate?: string;
  hardSkillOrdering?: HardSkillOrdering;
  /** Categorized or flat Technical Skills. Absent means categorized. */
  technicalSkillsLayout?: TechnicalSkillsLayout;
  /** This profile's default model, effort and thinking mode. */
  ai?: AiPreferences;
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
  /**
   * The author's own grouping of `skills`, when they have one.
   *
   * Absent means the renderer works the headings out from the shared skill
   * library. Every skill in here is also in `skills`.
   */
  skillCategories?: SkillCategoryGroup[];
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
  /**
   * The author's grouping of `skills`.
   *
   * Sent whether or not the profile renders grouped: the grouping is storage
   * and the layout is rendering, so switching to the plain list and back must
   * not lose the headings somebody assigned. Omitting the field entirely leaves
   * whatever is stored alone; sending an empty list clears it.
   */
  skillCategories?: SkillCategoryGroup[];
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

  /**
   * Creates profiles from an already-parsed JSON document.
   *
   * The file is read and parsed by `readProfileImportFile` before it gets
   * here, so a file that is not JSON is reported without a round trip - and
   * the server, which cannot trust any of this anyway, is the one that decides
   * whether the parsed document is actually a profile.
   */
  importJson: (document: unknown) =>
    apiFetch<ProfileImportResult>('/profiles/import', {
      method: 'POST',
      body: JSON.stringify(document),
    }),
};

/** What `POST /profiles/import` reports back. */
export interface TemplateImportResult {
  templates: Template[];
  imported: number;
  /** How many kept the id from the file; the rest were given a new one. */
  keptIds: number;
}

export interface ProfileImportResult {
  profiles: Profile[];
  imported: number;
  /** How many kept the id from the file; the rest were given a new one. */
  keptIds: number;
}

/**
 * Reads a picked file as JSON.
 *
 * Its own function so that "this file is not JSON" reads as a sentence about
 * the file rather than as whatever `JSON.parse` decided to say about position
 * 4213 - which is the error a person actually gets when they pick a PDF from
 * the wrong row of their downloads folder.
 */
export async function readProfileImportFile(file: File): Promise<unknown> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    throw new Error(`Could not read ${file.name}.`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${file.name} is not valid JSON. Export a profile from this app, or check the file.`);
  }
}

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

  /**
   * Imports one file's worth of templates.
   *
   * A file may hold one template, a list of them, or `{ "templates": [ ... ] }`
   * - the three shapes an export produces. The server saves all of them or
   * none, so a partial result is not something this has to represent.
   */
  uploadJson: async (file: File): Promise<TemplateImportResult> => {
    const formData = new FormData();
    formData.append('template', file);

    const result = await apiFetch<Template & Partial<TemplateImportResult>>(
      '/templates/upload-json',
      { method: 'POST', body: formData }
    );
    // A server that predates multi-template files answers with the template
    // itself and nothing else. Read as one import rather than as zero.
    const templates = result.templates ?? [result as Template];
    return {
      templates,
      imported: result.imported ?? templates.length,
      keptIds: result.keptIds ?? 0,
    };
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

  analyze: (jobDescription: string, overrides: AiRequestOverrides = {}, promptId?: string) =>
    apiFetch<JobAnalysis>('/resume/analyze', {
      method: 'POST',
      body: JSON.stringify({ jobDescription, ...overrides, promptId }),
    }),

  analyzePromptTest: (jobDescription: string, overrides: AiRequestOverrides = {}, promptId?: string) =>
    apiFetch<unknown>('/resume/analyze-prompt-test', {
      method: 'POST',
      body: JSON.stringify({ jobDescription, ...overrides, promptId }),
    }),

  analyzeMultiJob: (data: {
    jobs: Array<{
      companyName: string;
      jobDescription: string;
      sourceRowNumber?: number;
    }>;
    model?: string;
    effort?: EffortLevel;
    thinking?: ThinkingMode;
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
    effort?: EffortLevel;
    thinking?: ThinkingMode;
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
    effort?: EffortLevel;
    thinking?: ThinkingMode;
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
    effort?: EffortLevel;
    thinking?: ThinkingMode;
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
    effort?: EffortLevel;
    thinking?: ThinkingMode;
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
    effort?: EffortLevel;
    thinking?: ThinkingMode;
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
