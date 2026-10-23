import { BUILD_MODES, isBuildMode, type BuildMode } from './buildModes';
import type { JobFilterFacts, JobSalary } from './jobAnalysis';
import type { SheetTabListing } from './sheetTabs';
import {
  hasEnabledProviderOfType,
  normalizeAdminProviders,
  normalizeProviderCards,
  type AdminAIProvider,
  type ProviderCard,
  type ProviderOutage,
} from './providerDisplay';
import {
  APP_SETTING_KEYS,
  readSettingSource,
  readSettingSources,
  type AppSettingKey,
  type SettingSource,
} from './settingSources';

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

/**
 * The API's origin, for a URL the BROWSER will load rather than `apiFetch`.
 *
 * Prefers the host the page was loaded from, like `getPreferredApiBase` - and
 * for the same reason, only more sharply. Its one caller is the template
 * preview `<iframe>`, and an iframe carries the session COOKIE rather than the
 * Authorization header. That cookie is scoped to the host somebody actually
 * signed in on, so pointing the frame at the hostname baked into
 * NEXT_PUBLIC_API_URL at build time sent it somewhere the cookie does not go:
 * open the app on a LAN IP, and every preview rendered the API's
 * "Sign in to do that" JSON instead of a resume. `getCurrentApiBase()` does
 * not follow the page and is the wrong one to reach for here.
 */
export function getApiOrigin(): string {
  return getPreferredApiBase().replace(/\/api$/, '');
}

/**
 * The session token.
 *
 * Kept ALONGSIDE the httpOnly cookie the server sets, not instead of it. The
 * cookie is what makes a reload stay signed in without JavaScript; the copy
 * here is what goes in the Authorization header, which is the only way the
 * streaming endpoints and any cross-origin call reach the same session without
 * every call site getting `credentials` right.
 *
 * The key still reads `adminToken` so a session opened by the previous build is
 * not silently dropped on upgrade; it stopped meaning "an admin" in v2.
 */
const SESSION_TOKEN_KEY = 'adminToken';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(SESSION_TOKEN_KEY, token);
  } catch {
    // Ignore storage errors (private mode / blocked storage). The cookie still
    // carries the session; only the header copy is lost.
  }
}

export function removeToken(): void {
  try {
    localStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    // Ignore storage errors
  }
}

/**
 * Called when the server says a request was not signed in.
 *
 * A hook rather than a redirect from here: this module knows nothing about
 * routing, and a hard `location.assign` would throw away an unsaved form on
 * what is often a recoverable blip. The auth provider installs the real
 * handler, which clears its state and shows the login page.
 */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

/**
 * Called when the server refuses a request for the account's ROLE: 403
 * `role-not-allowed`, which every builder route answers a reporter.
 *
 * Not a sign-out - the session is fine, and treating it as one would sign a
 * reporter out of the pages that are theirs. It is, though, usually news: an
 * administrator changed this account's role since the page loaded (a user
 * made a reporter), and the shell is still drawn for the old one. The auth
 * provider installs a handler that re-reads the account, so the shell redraws
 * for the role it has now and AuthGate takes a reporter to Report Jobs.
 */
let onRoleRefused: (() => void) | null = null;

export function setRoleRefusedHandler(handler: (() => void) | null): void {
  onRoleRefused = handler;
}

/** The refusal a builder route gives a reporter: 403 `role-not-allowed`. */
export function isRoleNotAllowed(error: unknown): error is ApiResponseError {
  return error instanceof ApiResponseError && error.status === 403 && error.code === 'role-not-allowed';
}

/**
 * What every request does with a refusal before throwing it: a 401 means the
 * session is gone - expired, revoked, or the account disabled - so the stale
 * token is cleared (the next call does not send it) and the provider shows
 * the sign-in; a 403 `role-not-allowed` asks the provider to re-read the
 * account's role.
 *
 * Exported for the one client that does not come through here: the Bid
 * Assistant's `bidAssistantFetch` (bid-assistant/lib/apiBase.js), whose
 * `responseError` calls it. Without that, a user made a reporter while on the
 * Bid Assistant stayed on a page of refusals under the builder's rail.
 */
export function noticeRefusal(status: number, body: Record<string, unknown>): void {
  if (status === 401) {
    removeToken();
    onUnauthorized?.();
  } else if (status === 403 && body.code === 'role-not-allowed') {
    onRoleRefused?.();
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
    readonly url: string,
    /**
     * The whole error body, not just its message.
     *
     * A refusal carries fields that say what KIND of refusal it is - `code`,
     * and numbers like `neededMilli`, `balanceMilli` or `limit`. Throwing them
     * away left a component with nothing but English to classify by, and a
     * component that matched on the wording would break the moment somebody
     * improved it.
     *
     * Last and defaulted, so the three-argument form still compiles.
     */
    readonly body: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'ApiResponseError';
  }

  /** The machine-readable reason, when the server gave one. */
  get code(): string | undefined {
    return typeof this.body.code === 'string' ? this.body.code : undefined;
  }

  /** A number from the body, when it really is one. */
  number(field: string): number | undefined {
    const value = this.body[field];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
}

/**
 * The parsed error body, always a plain object.
 *
 * `response.json()` can legitimately produce `null` or an array, and reading
 * `.error` off either throws a TypeError from inside the error path - which
 * would turn "the server said no" into a thrown exception the retry loop
 * misreads as a lost connection.
 */
async function readErrorBody(response: Response): Promise<Record<string, unknown>> {
  const parsed = await response.json().catch(() => null);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * The administrator-only half of a refusal, when the server sent one.
 *
 * Some failures have two audiences. "This server's Google sign-in is no longer
 * valid" is for whoever hit the page; "run npm run sheets:login in backend/" is
 * for whoever runs the server, and naming a command and a directory at somebody
 * who administers neither is noise at best. The backend decides - it attaches
 * `detail` for an administrator and omits it for everybody else - so a caller
 * can render this unconditionally and get nothing when there is nothing to
 * show. Do NOT reintroduce a client-side role check here; the server's omission
 * is the control.
 */
export function operatorDetail(error: unknown): string | null {
  if (!(error instanceof ApiResponseError)) return null;
  const detail = error.body.detail;
  return typeof detail === 'string' && detail.trim() ? detail : null;
}

/** The account is at its subscription's limit on profiles (people): 402 `profile-limit`. */
export function isProfileLimit(error: unknown): error is ApiResponseError {
  return error instanceof ApiResponseError && error.code === 'profile-limit';
}

/**
 * A run was refused for want of credit: 402 `insufficient-credits`, with what
 * the run needs and the balance it found as `neededMilli` and `balanceMilli`,
 * in thousandths of a dollar.
 */
export function isInsufficientCredits(error: unknown): error is ApiResponseError {
  return error instanceof ApiResponseError && error.code === 'insufficient-credits';
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

/**
 * The message of a refusal whose body carried no sentence - a proxy's HTML
 * error page, an empty 502. Pages show failures through lib/userMessage.ts,
 * which reads the body rather than this; it is a whole sentence anyway, so a
 * page that ever does print `err.message` says nothing a reader cannot use.
 * The status is on the error itself (`status`, `url`) for whoever debugs it.
 */
export const GENERIC_MESSAGE = 'Something went wrong. Please try again, or contact your administrator.';

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

/**
 * Reads a line-delimited JSON stream, calling back per line.
 *
 * Its own function rather than `apiFetch`, because `apiFetch` parses one JSON
 * body and returns - which is the opposite of what this is for. It shares the
 * candidate-base loop, so a stream reaches the same backend the rest of the app
 * found, and the same "cannot reach the backend" sentence explains it when
 * nothing answers.
 *
 * Resolves when the server closes the stream. Aborting the signal stops
 * READING; it does not stop the work, which belongs to the server's queue.
 */
export async function apiStream(
  endpoint: string,
  onLine: (value: Record<string, unknown>) => void,
  signal?: AbortSignal
): Promise<void> {
  let lastConnectionError: Error | null = null;
  const tried: string[] = [];

  for (const apiBase of buildApiBaseCandidates()) {
    tried.push(apiBase);
    let response: Response;
    try {
      response = await fetch(`${apiBase}${endpoint}`, {
        headers: getAuthHeaders(),
        credentials: 'include',
        signal,
      });
    } catch (error) {
      if (signal?.aborted) return;
      lastConnectionError = error instanceof Error ? error : new Error(String(error));
      continue;
    }

    resolvedApiBase = apiBase;
    if (!response.ok || !response.body) {
      const body = await readErrorBody(response);
      noticeRefusal(response.status, body);
      throw new ApiResponseError(
        typeof body.error === 'string' ? body.error : GENERIC_MESSAGE,
        response.status,
        `${apiBase}${endpoint}`,
        body
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        // Split on newlines and keep the remainder: a chunk boundary falls in
        // the middle of a line often enough that not doing this is a bug that
        // only shows up under load.
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            onLine(JSON.parse(line) as Record<string, unknown>);
          } catch {
            // A half-written line is not worth failing a whole batch's progress
            // over; the next complete snapshot carries the same information.
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return;
  }

  throw new ApiUnreachableError(tried, lastConnectionError ?? new Error('No API base configured'));
}

// Generic fetch wrapper
export async function apiFetch<T>(
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
      // `credentials: 'include'` so the session cookie travels even when the
      // API is on another origin, which it is whenever the page is opened by
      // IP or hostname rather than localhost.
      response = await fetch(url, { ...options, headers, credentials: 'include' });
    } catch (error) {
      // A caller that aborted asked for nothing more. Trying the next base
      // would start the request again under a signal that is already spent,
      // and the loop would end in "cannot reach the backend" - a sentence the
      // live preview, which aborts a stale render on every keystroke, would
      // then show for a server that is up. The AbortError goes back as is.
      if (options.signal?.aborted) throw error;
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
      const body = await readErrorBody(response);
      noticeRefusal(response.status, body);
      throw new ApiResponseError(
        typeof body.error === 'string' ? body.error : GENERIC_MESSAGE,
        response.status,
        url,
        body
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
 * A file from the API, as a Blob - what a Generate Immediately run downloads.
 *
 * Its own function because `apiFetch` parses JSON. Fetched rather than opened
 * with a plain `<a href>` to the API because a refusal then stays a refusal: an
 * anchor pointed at another origin is a NAVIGATION, so a 410 for a file the
 * retention sweep has deleted replaced the whole builder with the API's JSON -
 * and leaving the page that way stopped the run. Here a refusal throws the same
 * `ApiResponseError` every other call does, and the page says so in a notice.
 *
 * `fileName` is the server's own name from Content-Disposition, or null when
 * the header cannot be read (another origin, which the API does not expose it
 * to) - the caller then names the file itself.
 */
export async function apiFetchFile(
  endpoint: string,
  signal?: AbortSignal
): Promise<{ blob: Blob; disposition: string | null }> {
  let lastConnectionError: Error | null = null;
  const tried: string[] = [];

  for (const apiBase of buildApiBaseCandidates()) {
    const url = `${apiBase}${endpoint}`;
    tried.push(apiBase);
    let response: Response;
    try {
      response = await fetch(url, { headers: getAuthHeaders(), credentials: 'include', signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      lastConnectionError = error instanceof Error ? error : new Error(String(error));
      continue;
    }

    resolvedApiBase = apiBase;
    if (!response.ok) {
      const body = await readErrorBody(response);
      noticeRefusal(response.status, body);
      throw new ApiResponseError(
        typeof body.error === 'string' ? body.error : GENERIC_MESSAGE,
        response.status,
        url,
        body
      );
    }
    return { blob: await response.blob(), disposition: response.headers.get('content-disposition') };
  }

  throw new ApiUnreachableError(tried, lastConnectionError ?? new Error('no API base was configured'));
}

/**
 * Which kind of prompt this is. Sent by the server with every prompt, derived
 * from the feature it is attached to rather than stored on it.
 */
export type PromptCategoryId = 'extracting' | 'building' | 'other';

/**
 * The three subscription seats: the server's own `claude`, `codex` and
 * `gemini` command-line tools, each signed in to a subscription account. There
 * is no API-key provider any more - the metered ones were retired, like the
 * browser-chat ones before them, and a row still naming one reads as the
 * default on the server rather than arriving here.
 */
export type AIProvider = 'claude-cli' | 'codex-cli' | 'gemini-cli';

export type ProviderMeta = {
  label: string;
};

/**
 * Mirrors backend/src/config/providerCatalog.ts, labels and order included.
 * `satisfies` makes a missing entry a build error rather than a label that
 * silently reads as another provider.
 *
 * Administrator-facing only. Nothing an ordinary account sees names a provider:
 * the user model list is display names (`PublicModelOption`).
 */
export const PROVIDER_META = {
  'claude-cli': { label: 'Claude (Subscription)' },
  'codex-cli': { label: 'Codex (Subscription)' },
  'gemini-cli': { label: 'Gemini (Subscription)' },
} as const satisfies Record<AIProvider, ProviderMeta>;

export const AI_PROVIDERS: AIProvider[] = Object.keys(PROVIDER_META) as AIProvider[];

export function getAIProviderLabel(provider: AIProvider): string {
  return Object.prototype.hasOwnProperty.call(PROVIDER_META, provider)
    ? PROVIDER_META[provider].label
    : provider;
}

/**
 * Narrows an untrusted provider string to one of the three seats, or null.
 *
 * Own-property checks throughout: `in` and a plain index both walk the
 * prototype chain, so "constructor" or "toString" would otherwise be accepted
 * as a provider id and resolve to an Object.prototype member.
 */
export function coerceProvider(value: unknown): AIProvider | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return Object.prototype.hasOwnProperty.call(PROVIDER_META, trimmed) ? (trimmed as AIProvider) : null;
}
export type DefaultMode = 'preview' | 'generate';
export type ThemeMode = 'light' | 'dark';

/**
 * The most a resume may be priced at in any build mode: $1,000, in thousandths
 * of a dollar. Mirrors the backend's MAX_BUILD_MODE_PRICE_MILLI; the server is
 * the one that enforces it. A mode's price is an administrator's setting
 * (`suitablePriceMilli`, `partialPriceMilli`, `fullPriceMilli`), $0 until set.
 */
export const MAX_MODE_PRICE_MILLI = 1_000_000;

/**
 * One model an administrator added. Administrator-facing: the provider and the
 * CLI's model name never reach an ordinary account's payload. A model carries
 * no price: what a resume costs is the price of its build mode.
 */
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

/** A model as an ordinary account sees it: something to pick, by name. */
export interface PublicModelOption {
  id: string;
  name: string;
}

/** One entry of a seat's model-name list: the CLI's value, and how to show it. */
export interface ProviderModelNameOption {
  value: string;
  label: string;
}

/**
 * The model names one seat offers the Models form, from the server
 * (config/providerModels.ts), so the select can only produce a name the server
 * will accept.
 */
export interface ProviderModelOptions {
  provider: AIProvider;
  label: string;
  models: ProviderModelNameOption[];
}

/**
 * The option a record's model name matches, if any - compared without case,
 * the way the server matches it.
 */
export function findProviderModelOption(
  options: ProviderModelOptions[],
  provider: AIProvider,
  modelName: string | undefined
): ProviderModelNameOption | null {
  const wanted = (modelName ?? '').trim().toLowerCase();
  if (!wanted) return null;
  const entry = options.find((option) => option.provider === provider);
  return entry?.models.find((model) => model.value.toLowerCase() === wanted) ?? null;
}

/** "Sonnet" for `sonnet`, or the stored name itself when no option names it. */
export function describeProviderModel(
  options: ProviderModelOptions[],
  provider: AIProvider,
  modelName: string
): string {
  return findProviderModelOption(options, provider, modelName)?.label ?? modelName;
}

/**
 * One row of a Job Filter run, as the page lists it: its verdict and why -
 * nothing of it is written into the sheet. `result` is null for a row that
 * was not judged: one with no link (its `reason` says so) or one that failed
 * (`error`, a public sentence with its `(Ref: ...)`).
 */
export interface JobFilterRowResult {
  row: number;
  company: string;
  title: string;
  link: string;
  result: 'Pass' | 'Fail' | null;
  /** Why it failed ('' for a Pass), or why it was not judged. */
  reason: string;
  /** Judged on an analysis the posting already had: no page fetched, no model asked. */
  reused: boolean;
  error?: string;
}

export interface GoogleSheetJobFilterResponse {
  spreadsheetId: string;
  spreadsheetTitle: string;
  selectedTab: string;
  /**
   * The display name of the analysis model - the one that analyses a posting
   * the filter finds no analysis for (the filter asks no model of its own) -
   * an administrator's own name for it, never a provider or a CLI model id.
   */
  modelLabel: string;
  startRow: number;
  endRow: number;
  scannedRows: number;
  processedRows: number;
  skippedRows: number;
  scrapedRows: number;
  /**
   * Rows judged on an analysis their posting already had, found by the job
   * link - so neither the page was fetched nor a model asked.
   */
  reusedAnalyses: number;
  errorRows: number;
  rowErrors: Array<{
    row: number;
    message: string;
  }>;
  /** Every row that holds anything in C:E, in sheet order. */
  rows: JobFilterRowResult[];
  /** Said instead of results, e.g. for a tab with no job rows yet. */
  message?: string;
}

/**
 * A model choice.
 *
 * Optional, and absent means INHERIT: a resume inherits the app default, and
 * one generation inherits the resume. That is why the same type describes both
 * layers.
 */
export interface AiPreferences {
  modelId?: string;
}

/**
 * The per-run override fields every generate endpoint accepts.
 *
 * Named `model` rather than `modelId` because that is the field the API has
 * always taken.
 */
export interface AiRequestOverrides {
  model?: string;
}

/** Only fields that were actually chosen are sent, so the rest inherit. */
export function toAiRequestOverrides(preferences: AiPreferences): AiRequestOverrides {
  return {
    ...(preferences.modelId ? { model: preferences.modelId } : {}),
  };
}

export function normalizeAiPreferences(value: unknown): AiPreferences {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const preferences: AiPreferences = {};
  const modelId = typeof source.modelId === 'string' ? source.modelId.trim() : '';
  if (modelId) preferences.modelId = modelId;
  return preferences;
}

/**
 * One provider this installation cannot run, and the models it would offer.
 *
 * Administrator-only. The Models and Settings pages keep those models on screen
 * behind a padlock, with the reason, because the person reading them is the one
 * who can lift the lock. An ordinary account is never sent this: its model list
 * simply does not contain what cannot run, and the reasons name sign-in commands
 * and server variables that mean nothing to anyone but an administrator.
 */
export interface ProviderLock {
  id: AIProvider;
  label: string;
  reason: string;
  models: AIModelRecord[];
}

/**
 * The builder defaults an administrator sets, which every account's builder
 * starts from. Shared by both payloads, so the user one and the admin one
 * cannot drift into reading the same field two ways.
 */
export interface BuilderDefaults {
  defaultMode: DefaultMode;
  defaultTheme: ThemeMode;
  /**
   * The mode Build Resumes starts on and a run that names none runs in:
   * `.env`'s DEFAULT_TAILOR_MODE, else partial.
   */
  defaultBuildMode: BuildMode;
  /** The profile (a person) the builder starts on: one of the administrator's own. '' is "choose automatically". */
  defaultProfileId: string;
  defaultModelId: string;
  defaultResumeDocxEnabled: boolean;
  defaultCoverLetterDocxEnabled: boolean;
}

/**
 * What one resume costs in each build mode, in thousandths of a dollar: 23 is
 * $0.023, 0 is free (and is what a mode nobody priced costs). Served to every
 * signed-in account, for the builder's mode cards - the same figures a quote
 * reveals.
 */
export interface BuildModePrices {
  suitablePriceMilli: number;
  partialPriceMilli: number;
  fullPriceMilli: number;
}

/**
 * GET /resume/models: what any signed-in account may know about models.
 *
 * Display names and ids, and nothing else - no provider, no CLI model name, no
 * locks, no sheet sources. A person picks a model by the name an
 * administrator gave it; the cost of a run is the price of its build mode
 * (`suitablePriceMilli`... here, `generationApi.quote` for a run), never part
 * of the option label.
 */
export interface UserAppSettings extends BuilderDefaults, BuildModePrices {
  /** Runnable models, in the administrator's order. `defaultModelId` is one of them, or ''. */
  models: PublicModelOption[];
  outputPathUsesJobTitle: boolean;
}

/**
 * The administrator's settings payload. Its own type rather than an extension
 * of the user one: it carries the RAW model records (so a disabled or locked one
 * stays manageable), the locks with their reasons and the per-seat model-name
 * lists - everything the user payload leaves out.
 */
export interface AdminAppSettings extends BuilderDefaults, BuildModePrices {
  /** Canonical enable flags, keyed by provider id. */
  providersEnabled: Record<AIProvider, boolean>;
  aiModels: AIModelRecord[];
  /** Providers locked in this build. Empty on a build that locks nothing. */
  providerLocks: ProviderLock[];
  /**
   * Every PROVIDER - each place a type runs, signed in at a folder of its own
   * (lib/providerDisplay.ts) - built-ins first among their type. Folders and
   * binaries on the server: the administrator's payload alone carries it.
   */
  aiProviders: AdminAIProvider[];
  /** Every seat in catalog order, locked ones included, with the model names it offers. */
  providerModelOptions: ProviderModelOptions[];
  /** The output folder on the server: every resume is filed under it. */
  outputBaseDir: string;
  /**
   * The administrator's half of every resume's folder (owner decision O1),
   * canonical: `/{{user_email}}/{{order_number}}` by default. Each account
   * adds its own folder path after it (Settings -> Account -> Resume files).
   */
  outputPathPrefix: string;
  /**
   * The modes priced $0 only because their `.env` line (RESUME_<MODE>_PRICE_USD)
   * could not be read and nothing is stored over it: the price reads 0 like an
   * unset one, but nobody chose that. Admin -> Settings shows each in red and
   * names the variable.
   */
  unreadableModePrices: BuildMode[];
  /**
   * The model every job analysis runs on - one for the whole installation, so
   * that every posting is read, and classified into a job field, the same way.
   * The value IN EFFECT: the one chosen on Admin -> Models, else .env's
   * ANALYSIS_MODEL, else '' - the default model ('' chosen on the page is
   * "use the default model", and beats .env). Each posting is analysed once,
   * ever: changing this changes the postings analysed from then on, never the
   * stored ones. Administrators only; the builder's payload does not carry it.
   */
  analysisModelId: string;
  /**
   * The bounds and the buttons of one purchase, per method a buyer can choose,
   * in thousandths of a dollar. These are the only bounds: a credit is a
   * dollar, so there is no price per credit and no count of credits to bound.
   */
  paymentLimits: PaymentTargetLimits[];
  /**
   * Ask the cardholder's bank to authenticate every card payment.
   *
   * Off by default. On, it is Stripe's `request_three_d_secure` rather than
   * Stripe's own risk rules deciding, which is what moves chargeback liability
   * to the issuing bank - and what makes a kept card need a confirmation
   * instead of charging in one tap.
   */
  requireThreeDSecure: boolean;
  /**
   * What each paid subscription costs for 30 days, taken from the account's
   * credit balance when it is bought and at every renewal, in thousandths;
   * null is not offered (nobody can buy it). Saved in dollars, as
   * `premiumPriceUsd` and its siblings (lib/settingSources.ts
   * `SUBSCRIPTION_PRICE_REQUEST_FIELDS`).
   */
  premiumPriceMilli: number | null;
  premiumPlusPriceMilli: number | null;
  premiumMaxPriceMilli: number | null;
  /**
   * Where each setting with a `.env` default got the value in effect: 'admin'
   * (set here - Reset to default is offered), 'env' or 'default'
   * (lib/settingSources.ts). Every key is present; one the server left out
   * reads as 'default'.
   */
  settingSources: Record<AppSettingKey, SettingSource>;
  /** What each of those would be with nothing set here: what Reset to default gives. */
  settingDefaults: AppSettingDefaults;
  /**
   * Per method in `paymentLimits`: where ITS row came from (each method
   * resolves on its own) and, from `.env`, the variables that set it - only
   * those. A method the server left out reads as 'default'.
   */
  paymentLimitSources: Record<string, PaymentLimitSource>;
  /**
   * A default model set here that cannot run now - another is the default in
   * its place until it can - or null. Still stored, so Reset to default is
   * offered for it.
   */
  staleDefaultModelId: string | null;
}

/** Where one payment method's limits came from. */
export interface PaymentLimitSource {
  source: SettingSource;
  /** The PAYMENT_* variables that supplied it, when `source` is 'env'. */
  variables: string[];
}

/**
 * Each `.env`-defaulted setting's value with nothing set here - `.env`'s,
 * else the code's - as the admin payload serves it. `defaultModelId` is one of
 * the models listed beside it; `analysisModelId` '' is the default model.
 */
export interface AppSettingDefaults {
  defaultModelId: string;
  analysisModelId: string;
  defaultMode: DefaultMode;
  defaultTheme: ThemeMode;
  defaultBuildMode: BuildMode;
  /** What each build mode costs a resume with nothing set here, in thousandths: $0 unless `.env` prices it. */
  suitablePriceMilli: number;
  partialPriceMilli: number;
  fullPriceMilli: number;
  defaultResumeDocxEnabled: boolean;
  defaultCoverLetterDocxEnabled: boolean;
  outputBaseDir: string;
  outputPathPrefix: string;
  /** In thousandths, like `paymentLimits`. */
  paymentLimits: PaymentTargetLimits[];
  requireThreeDSecure: boolean;
  /** In thousandths; null is not offered. */
  premiumPriceMilli: number | null;
  premiumPlusPriceMilli: number | null;
  premiumMaxPriceMilli: number | null;
}

/**
 * A preview of a resume's folder, drawn by the server's own function:
 * the path, or - for one a save would refuse - `path: null` and every
 * sentence it would be refused with. `notes` is advice that refuses nothing.
 */
export interface OutputPathPreview {
  path: string | null;
  problems: string[];
  notes: string[];
}

export function normalizeOutputPathPreview(value: unknown): OutputPathPreview {
  const source = asRecord(value);
  const texts = (list: unknown): string[] =>
    Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : [];
  return {
    path: typeof source.path === 'string' ? source.path : null,
    problems: texts(source.problems),
    notes: texts(source.notes),
  };
}

/**
 * One method's purchase limits, as the admin API sends them.
 *
 * `target` is `card` or `crypto` (a stored row naming a coin still reads, and
 * applies to nothing). Every amount is thousandths of a dollar and a whole
 * number of cents, since that is all a card or an invoice can charge; the
 * presets are the buttons step 2 of the purchase offers, dropped by the server
 * when they fall outside the bounds on the same row. There is no fee: a
 * purchase credits exactly what it charges.
 */
export interface PaymentTargetLimits {
  target: string;
  minMilli: number;
  maxMilli: number;
  presetsMilli: number[];
}

/**
 * One method's limits as a save SENDS them: dollars, as the administrator
 * typed them ("2.50"), each a whole number of cents. Never the thousandths the
 * page was given - a request carries money as dollars, and the server parses
 * them exactly.
 */
export interface PaymentTargetLimitsInput {
  target: string;
  minUsd: string;
  maxUsd: string;
  presetsUsd: string[];
}

/** One method's Reset to default: its stored row goes, and `.env` (else the code) decides again. */
export interface PaymentTargetLimitsReset {
  target: string;
  reset: true;
}

/** A method's limits read leniently: every method in `paymentLimits`, 'default' for one not described. */
function normalizePaymentLimitSources(value: unknown, limits: PaymentTargetLimits[]): Record<string, PaymentLimitSource> {
  const record = asRecord(value);
  const sources: Record<string, PaymentLimitSource> = {};
  for (const row of limits) {
    const entry = asRecord(record[row.target]);
    sources[row.target] = {
      source: readSettingSource(entry.source),
      variables: Array.isArray(entry.variables)
        ? entry.variables.filter((name): name is string => typeof name === 'string')
        : [],
    };
  }
  return sources;
}

/** An amount the server sent: a whole number of thousandths, or 0 for anything that is not one. */
function readMilli(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizePaymentLimits(value: unknown): PaymentTargetLimits[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      target: typeof entry.target === 'string' ? entry.target : '',
      minMilli: readMilli(entry.minMilli),
      maxMilli: readMilli(entry.maxMilli),
      presetsMilli: Array.isArray(entry.presetsMilli)
        ? entry.presetsMilli.filter((milli): milli is number => typeof milli === 'number' && Number.isSafeInteger(milli))
        : [],
    }))
    .filter((entry) => entry.target !== '');
}

/**
 * The enable flags, keyed by provider id (`providersEnabled`). A seat the
 * record does not name is on, as the server reads it.
 */
function normalizeProvidersEnabled(source: Record<string, unknown>): Record<AIProvider, boolean> {
  const record = asRecord(source.providersEnabled);
  const result = {} as Record<AIProvider, boolean>;
  for (const provider of AI_PROVIDERS) {
    const flag = record[provider];
    result[provider] = typeof flag === 'boolean' ? flag : true;
  }
  return result;
}

const DEFAULT_BUILDER_DEFAULTS: BuilderDefaults = {
  defaultMode: 'preview',
  defaultTheme: 'light',
  defaultBuildMode: 'partial',
  defaultProfileId: '',
  defaultModelId: '',
  defaultResumeDocxEnabled: true,
  defaultCoverLetterDocxEnabled: true,
};

/** The shape used before any settings have loaded. Exported so pages that
 * need an optimistic default do not each hand-copy a literal that has to stay
 * structurally identical to this interface. */
export const DEFAULT_USER_APP_SETTINGS: UserAppSettings = {
  ...DEFAULT_BUILDER_DEFAULTS,
  models: [],
  outputPathUsesJobTitle: true,
  suitablePriceMilli: 0,
  partialPriceMilli: 0,
  fullPriceMilli: 0,
};

/**
 * A build mode's price as the server sent it: a whole number of thousandths
 * from 0 to the cap. Anything else reads as 0 - free - which is how the server
 * itself reads a price it cannot read. Never floored or rounded: a price is
 * money, and a figure nobody set is a figure everybody would be charged.
 */
function readModePriceMilli(value: unknown): number {
  const milli = readMilli(value);
  return milli > MAX_MODE_PRICE_MILLI ? MAX_MODE_PRICE_MILLI : milli;
}

/** The three mode prices of a payload (or a `settingDefaults` block), each read on its own. */
function readModePrices(source: Record<string, unknown>, fallback?: BuildModePrices): BuildModePrices {
  const price = (key: keyof BuildModePrices) =>
    fallback && !Object.prototype.hasOwnProperty.call(source, key)
      ? fallback[key]
      : readModePriceMilli(source[key]);
  return {
    suitablePriceMilli: price('suitablePriceMilli'),
    partialPriceMilli: price('partialPriceMilli'),
    fullPriceMilli: price('fullPriceMilli'),
  };
}

/** The modes a payload lists as unreadable in `.env`: known modes only, each once, in the server's order. */
function readUnreadableModePrices(value: unknown): BuildMode[] {
  if (!Array.isArray(value)) return [];
  const listed = new Set(value.filter(isBuildMode));
  return BUILD_MODES.filter((mode) => listed.has(mode));
}

function normalizeModelRecords(value: unknown): AIModelRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is AIModelRecord => typeof entry === 'object' && entry !== null)
    .flatMap((entry) => {
      // Dropped, not relabelled. Falling back to any one provider makes a row
      // this build cannot name display, filter and default-gate as that
      // provider, and an id it does not know - a newer provider's, or one a
      // release has since retired - means nothing to any provider it does.
      const provider = coerceProvider(entry.provider);
      if (!provider) return [];
      return [
        {
          id: typeof entry.id === 'string' ? entry.id : '',
          name: typeof entry.name === 'string' ? entry.name : '',
          provider,
          modelName: typeof entry.modelName === 'string' ? entry.modelName : '',
          description: typeof entry.description === 'string' ? entry.description : '',
          enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
          createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
          updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
        } satisfies AIModelRecord,
      ];
    })
    .filter((entry) => entry.id && entry.modelName);
}

/**
 * The user model list: an id and a name, or nothing.
 *
 * Deliberately keeps no provider, so an entry is never dropped for naming one
 * this build does not know - the server already decided it can run.
 */
function normalizePublicModelOptions(value: unknown): PublicModelOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!id || !name || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name }];
  });
}

/**
 * The per-seat model-name lists, every seat in catalog order (locked ones
 * included). A seat whose list is empty is offered with none - the form says
 * so rather than inventing names the server might refuse.
 */
function normalizeProviderModelOptions(value: unknown): ProviderModelOptions[] {
  if (!Array.isArray(value)) return [];
  const seenProviders = new Set<AIProvider>();
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const provider = coerceProvider(record.provider);
    if (!provider || seenProviders.has(provider)) return [];
    seenProviders.add(provider);
    const seenValues = new Set<string>();
    const models = (Array.isArray(record.models) ? record.models : []).flatMap((model) => {
      if (typeof model !== 'object' || model === null) return [];
      const option = model as Record<string, unknown>;
      const optionValue = typeof option.value === 'string' ? option.value.trim() : '';
      if (!optionValue || seenValues.has(optionValue.toLowerCase())) return [];
      seenValues.add(optionValue.toLowerCase());
      const label = typeof option.label === 'string' && option.label.trim() ? option.label.trim() : optionValue;
      return [{ value: optionValue, label }];
    });
    const label =
      typeof record.label === 'string' && record.label.trim() ? record.label.trim() : getAIProviderLabel(provider);
    return [{ provider, label, models }];
  });
}

/**
 * A lock with no provider id is dropped, and one with no reason is kept: the
 * padlock is the part that has to be right, and a build that locks something
 * without explaining itself should still say the model cannot be picked.
 */
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
 * provider list, the model table and the Models form, and three hand-typed
 * emoji is how that stops being true. Administrator pages only.
 */
export const LOCK_ICON = '\u{1F512}';

/** Whether this installation can run the provider at all. */
export function isProviderLocked(
  settings: Pick<AdminAppSettings, 'providerLocks'>,
  provider: AIProvider
): boolean {
  return settings.providerLocks.some((lock) => lock.id === provider);
}

/**
 * Whether this installation offers the provider at all, for a page that has to
 * decide for itself.
 *
 * The mirror of the backend's `isProviderEnabled`, clause for clause: a locked
 * provider is never offered however it is ticked; a type whose every provider
 * (each place it runs - Admin -> Models -> Providers) is switched off runs
 * nothing, so it is not offered either; and otherwise its enable flag decides. One helper rather than a copy per page, because a page's own copy
 * falls behind the server's rule and goes on offering providers the server
 * would refuse - so the next clause added to the backend has exactly one place
 * to be mirrored rather than three to be missed.
 *
 * The USER model list is already filtered server-side and needs none of this.
 * Admin screens are what need it: they are deliberately served the RAW list so
 * every record stays manageable, which is right, and means they must apply the
 * offer rule themselves.
 */
export function isProviderOffered(
  settings: Pick<AdminAppSettings, 'providerLocks'> & Partial<Pick<AdminAppSettings, 'aiProviders'>>,
  provider: AIProvider,
  providersEnabled?: Record<AIProvider, boolean>
): boolean {
  if (isProviderLocked(settings, provider)) return false;
  if (!hasEnabledProviderOfType(settings.aiProviders ?? [], provider)) return false;
  // Optional, because two of the three callers ask "is this offered at all"
  // while the settings form also has an unsaved copy of the enable flags.
  return providersEnabled ? providersEnabled[provider] === true : true;
}

function normalizeBuilderDefaults(source: Record<string, unknown>): BuilderDefaults {
  return {
    defaultMode: source.defaultMode === 'generate' ? 'generate' : 'preview',
    defaultTheme: source.defaultTheme === 'dark' ? 'dark' : 'light',
    defaultBuildMode: isBuildMode(source.defaultBuildMode) ? source.defaultBuildMode : 'partial',
    defaultProfileId: typeof source.defaultProfileId === 'string' ? source.defaultProfileId : '',
    defaultModelId: typeof source.defaultModelId === 'string' ? source.defaultModelId : '',
    defaultResumeDocxEnabled:
      typeof source.defaultResumeDocxEnabled === 'boolean' ? source.defaultResumeDocxEnabled : true,
    defaultCoverLetterDocxEnabled:
      typeof source.defaultCoverLetterDocxEnabled === 'boolean' ? source.defaultCoverLetterDocxEnabled : true,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeUserAppSettings(value: unknown): UserAppSettings {
  const source = asRecord(value);
  return {
    ...normalizeBuilderDefaults(source),
    ...readModePrices(source),
    models: normalizePublicModelOptions(source.models),
    outputPathUsesJobTitle:
      typeof source.outputPathUsesJobTitle === 'boolean' ? source.outputPathUsesJobTitle : true,
  };
}

/**
 * The admin payload's `settingDefaults`, read leniently: a field the server
 * left out, or sent in the wrong shape, reads as the value in effect - so a
 * Reset is never shown giving something nobody was told.
 */
function normalizeSettingDefaults(value: unknown, inEffect: Omit<AdminAppSettings, 'settingDefaults'>): AppSettingDefaults {
  const source = asRecord(value);
  const builder = normalizeBuilderDefaults({ ...pickBuilderDefaults(inEffect), ...source });
  const text = (key: string, fallback: string) => (typeof source[key] === 'string' ? (source[key] as string) : fallback);
  return {
    defaultModelId: builder.defaultModelId,
    analysisModelId: text('analysisModelId', inEffect.analysisModelId),
    defaultMode: builder.defaultMode,
    defaultTheme: builder.defaultTheme,
    defaultBuildMode: builder.defaultBuildMode,
    ...readModePrices(source, inEffect),
    defaultResumeDocxEnabled: builder.defaultResumeDocxEnabled,
    defaultCoverLetterDocxEnabled: builder.defaultCoverLetterDocxEnabled,
    outputBaseDir: text('outputBaseDir', inEffect.outputBaseDir),
    outputPathPrefix: text('outputPathPrefix', inEffect.outputPathPrefix),
    paymentLimits: Array.isArray(source.paymentLimits)
      ? normalizePaymentLimits(source.paymentLimits)
      : inEffect.paymentLimits,
    requireThreeDSecure:
      typeof source.requireThreeDSecure === 'boolean' ? source.requireThreeDSecure : inEffect.requireThreeDSecure,
    premiumPriceMilli: priceDefault(source, 'premiumPriceMilli', inEffect.premiumPriceMilli),
    premiumPlusPriceMilli: priceDefault(source, 'premiumPlusPriceMilli', inEffect.premiumPlusPriceMilli),
    premiumMaxPriceMilli: priceDefault(source, 'premiumMaxPriceMilli', inEffect.premiumMaxPriceMilli),
  };
}

/** A subscription price as the server sends it: a whole number of thousandths above 0, else null - not offered. */
function readPriceMilli(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** A price's Reset value: the server's - null is one, "not offered" - else, left out, the value in effect. */
function priceDefault(source: Record<string, unknown>, key: string, inEffect: number | null): number | null {
  return Object.prototype.hasOwnProperty.call(source, key) ? readPriceMilli(source[key]) : inEffect;
}

function pickBuilderDefaults(settings: BuilderDefaults): BuilderDefaults {
  return {
    defaultMode: settings.defaultMode,
    defaultTheme: settings.defaultTheme,
    defaultBuildMode: settings.defaultBuildMode,
    defaultProfileId: settings.defaultProfileId,
    defaultModelId: settings.defaultModelId,
    defaultResumeDocxEnabled: settings.defaultResumeDocxEnabled,
    defaultCoverLetterDocxEnabled: settings.defaultCoverLetterDocxEnabled,
  };
}

function normalizeAdminAppSettings(value: unknown): AdminAppSettings {
  const source = asRecord(value);
  const inEffect = normalizeAdminSettingsInEffect(source);
  return { ...inEffect, settingDefaults: normalizeSettingDefaults(source.settingDefaults, inEffect) };
}

function normalizeAdminSettingsInEffect(source: Record<string, unknown>): Omit<AdminAppSettings, 'settingDefaults'> {
  const paymentLimits = normalizePaymentLimits(source.paymentLimits);
  return {
    ...normalizeBuilderDefaults(source),
    ...readModePrices(source),
    unreadableModePrices: readUnreadableModePrices(source.unreadableModePrices),
    providersEnabled: normalizeProvidersEnabled(source),
    aiModels: normalizeModelRecords(source.aiModels),
    providerLocks: normalizeProviderLocks(source.providerLocks),
    aiProviders: normalizeAdminProviders(source.aiProviders),
    providerModelOptions: normalizeProviderModelOptions(source.providerModelOptions),
    outputBaseDir: typeof source.outputBaseDir === 'string' ? source.outputBaseDir : '',
    outputPathPrefix: typeof source.outputPathPrefix === 'string' ? source.outputPathPrefix : '',
    analysisModelId: typeof source.analysisModelId === 'string' ? source.analysisModelId : '',
    paymentLimits,
    paymentLimitSources: normalizePaymentLimitSources(source.paymentLimitSources, paymentLimits),
    staleDefaultModelId:
      typeof source.staleDefaultModelId === 'string' && source.staleDefaultModelId ? source.staleDefaultModelId : null,
    requireThreeDSecure: source.requireThreeDSecure === true,
    premiumPriceMilli: readPriceMilli(source.premiumPriceMilli),
    premiumPlusPriceMilli: readPriceMilli(source.premiumPlusPriceMilli),
    premiumMaxPriceMilli: readPriceMilli(source.premiumMaxPriceMilli),
    settingSources: readSettingSources(source.settingSources, APP_SETTING_KEYS),
  };
}

/** `null` beside each `.env`-defaulted field's own type: what Reset to default sends. */
type Resettable<T> = { [K in keyof T]?: K extends AppSettingKey ? T[K] | null : T[K] };

/**
 * A save from an admin page. Only what is named changes, and a page names
 * only what was changed (lib/settingSources.ts `changedSettings`): the server
 * stores what an administrator set, so a field sent unchanged would stop
 * following .env. A `.env`-defaulted field sent as `null` is Reset to default.
 */
export type AdminAppSettingsUpdate = Resettable<
  BuilderDefaults & {
    providersEnabled: Record<AIProvider, boolean>;
    /** '' is "use the default model" (it beats ANALYSIS_MODEL); a changed id must name a model that can run. */
    analysisModelId: string;
    outputBaseDir: string;
    /** Checked by the server: a refusal is 400 with `field: 'outputPathPrefix'`. */
    outputPathPrefix: string;
    /**
     * In dollars, PER METHOD: each row replaces its method's, a reset row
     * removes it, and a method left out keeps what it has. `null` (or `[]`)
     * puts back the defaults for every method.
     */
    paymentLimits: Array<PaymentTargetLimitsInput | PaymentTargetLimitsReset>;
    requireThreeDSecure: boolean;
  }
> & {
  /**
   * A subscription's price for 30 days, in DOLLARS as typed ("9.99") - never
   * in thousandths, which the server refuses. '' is "not offered" (it beats
   * .env); `null` is Reset to default. A refusal is 400 with `field` naming
   * the box.
   */
  premiumPriceUsd?: string | null;
  premiumPlusPriceUsd?: string | null;
  premiumMaxPriceUsd?: string | null;
  /**
   * What one resume costs in each build mode, in DOLLARS as typed ("0.023") -
   * never in thousandths, which the server refuses (400 `bad-price-field`).
   * A price is required: '' is refused (400 `bad-price`, with `field` naming
   * the box); `null` is Reset to default. Names in
   * lib/settingSources.ts `MODE_PRICE_REQUEST_FIELDS`.
   */
  suitablePriceUsd?: string | null;
  partialPriceUsd?: string | null;
  fullPriceUsd?: string | null;
};

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

/**
 * A range of the account's own job sheet. `sheetId` may name that sheet and
 * nothing else (any other id is 404); left out, the server uses the
 * caller's own, which is what every page does.
 */
export interface GoogleSheetsRangeRequest {
  sheetId?: string;
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

/**
 * Shape of GET /api/admin/ai/health: ONE CARD PER PROVIDER - two Claude
 * sign-ins are two cards, and one signed out says nothing about the other.
 */
export interface ProviderHealthReport {
  /** Built-ins first within each type, in catalog order (lib/providerDisplay.ts). */
  providers: ProviderCard[];
  subscription: {
    /** The built-in Claude provider's usage window - the only CLI that reports one. */
    seat: { utilization: number | null; resetsAt: string | null; observedAt: string | null } | null;
    outages: ProviderOutage[];
  };
  /**
   * Every provider's holds, keyed by PROVIDER id (a type id is its built-in
   * one). Codex's is only ever a usage limit.
   */
  outagesByProvider: Partial<Record<string, ProviderOutage[]>>;
  /** Each provider's calls, keyed by provider id. */
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
    /**
     * Totals per TYPE - the unit a model and its usage are counted in - so a
     * type with two providers has one total for both.
     */
    byProvider: Record<
      string,
      { calls: number; failures: number; inputTokens: number; outputTokens: number; costUsd: number }
    >;
  };
}

export const adminApi = {
  getAiHealth: async (): Promise<ProviderHealthReport> => {
    const report = await apiFetch<ProviderHealthReport>('/admin/ai/health');
    return { ...report, providers: normalizeProviderCards(report?.providers) };
  },

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

  /**
   * Where a resume would be filed with an output prefix not saved yet - the
   * whole path on the server, drawn by its own function. Left out, the prefix
   * in effect; `null`, what Reset to default gives. A prefix a save would
   * refuse answers `path: null` and the sentences. `outputBaseDir` is the
   * output folder as the box holds it, saved or not; left out or empty, the
   * one in effect.
   */
  previewOutputPrefix: async (outputPathPrefix?: string | null, signal?: AbortSignal, outputBaseDir?: string) =>
    normalizeOutputPathPreview(
      await apiFetch<OutputPathPreview>('/admin/output-path/preview', {
        method: 'POST',
        body: JSON.stringify({
          ...(outputPathPrefix === undefined ? {} : { outputPathPrefix }),
          ...(outputBaseDir?.trim() ? { outputBaseDir } : {}),
        }),
        signal,
      })
    ),

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

/**
 * The tabs of the account's own sheet, from `GET /import/tabs`: each with its
 * layout (lib/sheetTabs.ts says which a page may offer), and the one to start
 * on - All while it is a job tab; null for none.
 */
export interface ImportSheetTabs extends SheetTabListing {
  spreadsheetId: string;
}

export const importApi = {
  fetchGoogleSheetRange: (data: GoogleSheetsRangeRequest) =>
    apiFetch<GoogleSheetsRangeResponse>('/import', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  /**
   * Every tab of the account's own sheet, in the spreadsheet's order. It is
   * the only sheet anybody may address (owner decision S1): any other id is
   * 404, so none is sent.
   */
  listTabs: () => apiFetch<ImportSheetTabs>('/import/tabs'),
};

export const jobsApi = {
  /** The account's own sheet, All when no tab is named. Writes nothing into the sheet. */
  filterGoogleSheetJobs: (data: {
    tabName?: string;
    startRow?: number;
    /** Left out, the filter runs to the last row holding anything in Company to Job Link. */
    endRow?: number;
  }) =>
    apiFetch<GoogleSheetJobFilterResponse>('/jobs/filter-google-sheet', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// Resume types
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
  /** Not edited by the resume editor, but kept: it travels with the row. */
  gpa?: string;
  achievements?: string[];
}

export interface Certification {
  name: string;
  issuer: string;
  date: string;
  /** Not edited by the resume editor, but kept: it travels with the row. */
  expiryDate?: string;
  credentialId?: string;
}

/*
 * The other section kinds a resume commonly carries (lib/sectionCatalogue.ts
 * is the catalogue, a copy of the server's). Each is a list of entries on the
 * resume that prints only when it has one - there is no on/off switch for
 * them as there is for Soft Skills and Strengths. Links are stored as typed,
 * like `contact.github`; the renderer keeps only http(s) ones.
 */
export interface Project {
  name: string;
  role: string;
  startDate: string;
  endDate: string;
  link: string;
  description: string;
  achievements: string[];
}

export interface Language {
  language: string;
  proficiency: string;
}

export interface Award {
  title: string;
  issuer: string;
  date: string;
  description: string;
}

export interface Publication {
  title: string;
  publisher: string;
  date: string;
  link: string;
  description: string;
}

export interface Volunteering {
  role: string;
  organization: string;
  startDate: string;
  endDate: string;
  location: string;
  description: string;
  achievements: string[];
}

export interface Course {
  name: string;
  institution: string;
  date: string;
}

export interface Reference {
  name: string;
  title: string;
  company: string;
  email: string;
  phone: string;
}

export interface CustomSectionEntry {
  heading: string;
  subheading: string;
  startDate: string;
  endDate: string;
  location: string;
  description: string;
  achievements: string[];
}

/**
 * A section the person titles themselves. `key` is minted by the editor
 * (`cs-` and eight hex digits, lib/sectionCatalogue.ts `newCustomSectionKey`),
 * unique in the resume, and `sectionOrder` refers to the section as
 * `custom:<key>`.
 */
export interface CustomSection {
  key: string;
  title: string;
  entries: CustomSectionEntry[];
}

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
 * One group of a TAILORED resume's Technical Skills block, as the model wrote
 * it (backend types/template.ts `SkillGroup`). `soft` marks the posting's soft
 * skills - the last group, under the heading drawn for the resume - which the
 * Soft Skills section prints instead while that switch is on.
 */
export interface SkillGroup extends SkillCategoryGroup {
  soft?: true;
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

export interface ResumeSettings {
  resumePromptId?: string;
  resumeFileNameTemplate?: string;
  coverLetterFileNameTemplate?: string;
  /** Categorized ("Grouped") or flat ("Plain") Technical Skills. Absent means categorized. */
  technicalSkillsLayout?: TechnicalSkillsLayout;
  /**
   * Whether the resume carries a Soft Skills section. Absent means false, which
   * is what every resume rendered before the switch existed.
   */
  includeSoftSkills?: boolean;
  /** Whether the resume carries a Strengths section. Absent means false. */
  includeStrengths?: boolean;
  /*
   * No tailoring mode: Partial or Fully Tailor is the RUN's choice
   * (`buildMode`); a mode an older save stored is read past by the server.
   */
  /** This resume's default model. */
  ai?: AiPreferences;
}

/**
 * A resume's keywords, COMPUTED by the server and never stored
 * (`matchKeywords` on GET /resumes and GET /resumes/:id): the kind of role its
 * headline and held titles name, and the technologies, tools and concepts it
 * claims. What the suitable-resume matcher compares a posting with.
 */
export interface ResumeKeywords {
  version: number;
  vocabulary: string;
  basedOn: string;
  /** The kind of role the headline names; [] for none. */
  headline: string[];
  /** The kind of role each held title names, in resume order. */
  roleTitles: string[];
  terms: string[];
}

export interface Resume {
  id: string;
  name: string;
  title: string;
  /** The profile (person) the resume is filed under. Absent only on a resume the server has not filed yet. */
  profileId?: string;
  /** Derived on every read of the resume lists; never sent to the server and never stored. */
  matchKeywords?: ResumeKeywords;
  totalYearsExperience?: number;
  preferredTemplate?: string;
  disabled?: boolean;
  resumeSettings?: ResumeSettings;
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
  /**
   * The soft skills this person claims, in their own order. Printed only when
   * `resumeSettings.includeSoftSkills` is on, and kept either way.
   */
  softSkills?: string[];
  education: Education[];
  certifications?: Certification[];
  /*
   * The other section kinds (lib/sectionCatalogue.ts). Absent on every resume
   * saved before them; absent and empty read the same.
   */
  projects?: Project[];
  languages?: Language[];
  awards?: Award[];
  publications?: Publication[];
  volunteering?: Volunteering[];
  courses?: Course[];
  interests?: string[];
  references?: Reference[];
  customSections?: CustomSection[];
  /**
   * The order the resume's sections print in, by kind id or `custom:<key>`.
   * ABSENT means the template's own order - every resume saved before the
   * order existed, and every one whose person never arranged the cards. A
   * kind listed here with nothing in it is an added, empty section: shown as
   * an empty card, printed as nothing.
   */
  sectionOrder?: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * A profile is a PERSON, and holds that person's resumes: what /api/profiles
 * answers. Its resumes are counted, never listed - a resume says which profile
 * it is under (`Resume.profileId`).
 */
export interface ProfileSummary {
  id: string;
  name: string;
  /** Only on an administrator's `?allOwners=true` list. */
  ownerId?: string;
  createdAt: string;
  updatedAt: string;
  /** The later of the profile's own `updatedAt` and its newest resume's. */
  lastEditedAt: string;
  resumeCount: number;
  enabledResumeCount: number;
  /** The EFFECTIVE default: what Fully Tailor builds. Null only for a profile with no resume. */
  defaultResumeId: string | null;
  /** The stored choice; null while none is stored. */
  chosenDefaultResumeId: string | null;
}

export interface CreateResumeDTO {
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
   * Sent whether or not the resume renders grouped: the grouping is storage
   * and the layout is rendering, so switching to the plain list and back must
   * not lose the headings somebody assigned. Omitting the field entirely leaves
   * whatever is stored alone; sending an empty list clears it.
   */
  skillCategories?: SkillCategoryGroup[];
  /** Omitted keeps what is stored; an empty list clears it. */
  softSkills?: string[];
  education?: Partial<Education>[];
  certifications?: Certification[];
  /*
   * The other section kinds, each with the lists' rule: omitted keeps what is
   * stored, an empty list clears it, an entry with nothing typed into it is
   * dropped by the server.
   */
  projects?: Project[];
  languages?: Language[];
  awards?: Award[];
  publications?: Publication[];
  volunteering?: Volunteering[];
  courses?: Course[];
  interests?: string[];
  references?: Reference[];
  customSections?: CustomSection[];
  /**
   * The section order. Omitted keeps the stored order; `[]` clears it, back
   * to the template's own; a ref the server does not know is dropped, and
   * nothing is ever appended - completion happens where the order is read.
   */
  sectionOrder?: string[];
  preferredTemplate?: string;
  disabled?: boolean;
  resumeSettings?: ResumeSettings;
}

/**
 * What `POST /resumes/preview` answers: the draft drawn as a resume.
 *
 * `templateId` is the template it was really drawn with - not the draft's own
 * when that one is not offered any more (disabled or deleted), because the
 * server then falls back exactly as a generated resume would: `default`, else
 * the first enabled template. One asked for by name (`templateId` in the
 * request) is never swapped: missing, or disabled for anybody but an
 * administrator, it is a 404.
 * `page` is the printed page in CSS px, which the frame is sized to before it
 * is scaled; `contentHeightPx` is one page's content box, roughly where a page
 * break falls in the continuous document.
 */
export interface ResumeDraftPreviewResult {
  html: string;
  templateId: string;
  page: { widthPx: number; heightPx: number; contentHeightPx?: number };
  /**
   * The fields the server drew from the sample resume because the draft left
   * them empty - 'name', 'phone', 'experience'... In the preview only; a save,
   * a PDF and tailoring never see them. Empty when the draft filled every one.
   */
  sampled: string[];
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

/** The style a template is filed under in the new-resume chooser (the backend's config/templateCategories.ts). */
export type TemplateCategory = 'simple' | 'modern' | 'creative';

export interface Template {
  id: string;
  name: string;
  description: string;
  disabled?: boolean;
  /** Simple, Modern or Creative - the chooser's filters. Absent: listed under All only. */
  category?: TemplateCategory;
  htmlContent: string;
  cssContent: string;
  sections: string[];
  createdAt: string;
  updatedAt: string;
  manualConfig?: ManualTemplateConfigStored;
  isBuiltIn?: boolean;
  /*
   * No list of Technical Skills layouts: every template prints both, Grouped
   * and Plain, and `GET /templates/:id/preview?layout=` draws either.
   */
  /** Whether its markup has a Soft Skills section. Worked out by the server on every read. */
  supportsSoftSkills: boolean;
  /** Whether its markup has a Strengths section. Worked out by the server on every read. */
  supportsStrengths: boolean;
  /**
   * The sections its markup prints: every kind id (lib/sectionCatalogue.ts) it
   * names or prints through the extra-sections macro, and `custom` when it
   * prints custom sections. Worked out by the server on every read.
   */
  printsSections: string[];
  /**
   * The order its own markup prints the sections in, by kind id - what a
   * resume with no stored `sectionOrder` is drawn and shown in. Worked out
   * by the server on every read; custom sections are not in it.
   */
  nativeSectionOrder: string[];
}

export type PromptResponseFormat = 'json' | 'text';
export type PromptFeatureKey =
  | 'analyze-job-description'
  | 'filter-google-sheet-job'
  | 'tailor-resume'
  | 'tailor-resume-full'
  | 'revise-resume-coverage'
  | 'generate-cover-letter'
  | 'write-entry-bullets'
  | 'extract-template-from-pdf'
  | 'extract-profile-from-resume';

export interface PromptVariableDefinition {
  name: string;
  description?: string;
  sampleValue?: string;
  /**
   * True on a variable every prompt of its feature must use - the posting for
   * the analysis and its facts call, the resume for the cover letter, the
   * tailoring prompt's own set. The server refuses a save without them
   * (lib/promptRequirements.ts says so first, in its words).
   */
  required?: true;
}

export interface PromptValidation {
  usedVariables: string[];
  unknownVariables: string[];
  /** The feature's required variables the text does not use, in the feature's order; [] for none. */
  missingVariables: string[];
}

export interface PromptSummary {
  id: string;
  name: string;
  description: string;
  featureKey?: PromptFeatureKey;
  featureLabel?: string;
  /** Building, Extracting, or unattached. Derived by the server, never stored. */
  category: PromptCategoryId;
  categoryLabel: string;
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
  /**
   * Set on a SAVED feature record that does not use one of its feature's
   * required variables (`validation.missingVariables` names them), uses one
   * the server no longer supplies (`validation.unknownVariables`), or was
   * saved before its feature's prompt contract changed
   * (`savedForOlderVersion`). It is never run: the feature's built-in prompt
   * runs in its place until it is updated here.
   */
  needsUpdate?: true;
  /**
   * Set, beside `needsUpdate`, on a saved feature record older than its
   * feature's current prompt contract - the server's verdict, by the date it
   * was saved; its variables may all be fine. Saving it again clears it.
   */
  savedForOlderVersion?: true;
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
export type { JobFilterFacts, JobSalary };

export interface JobAnalysis {
  jobMeta: {
    title: string;
    seniority: string;
    industry: string;
    department: string;
  };
  skills: {
    technical: string[];
    tools: string[];
    soft: string[];
    /** Only on an analysis made before the current analysis prompt; kept as it was stored. */
    required?: string[];
    preferred?: string[];
    technologies?: string[];
  };
  technologies: string[];
  protocols: string[];
  methodologies: string[];
  architecturePatterns: string[];
  responsibilities: string[];
  domainKnowledge: string[];
  /** Only on an analysis made before the current analysis prompt. */
  softSkills?: string[];
  keywords: {
    actionVerbs: string[];
    buzzwords: string[];
    mustInclude: string[];
  };
  /**
   * The posting's one job field: an id from the server's list
   * (config/jobFields.ts), or `unclassified`. Shown by its label, which the
   * server sends beside it (`AnalyzedJob.jobFieldLabel`).
   */
  jobField?: string;
  /** What the posting states it pays; null when it states nothing. Never inferred. */
  salary?: JobSalary | null;
  /**
   * The facts the Job Filter judges a posting on: the analysis's second call,
   * the Job Facts (Filter) prompt, made with it once.
   */
  filter?: JobFilterFacts;
  sourceJobDescription?: string;
}

/**
 * A posting's analysis as `/resume/analyze` answers it: the analysis, the id
 * it is stored under - what the page sends back to preview, generate and
 * batches instead of the analysis itself, which the server would ignore - and
 * its job field's label.
 */
export type AnalyzedJob = JobAnalysis & {
  analysisId: string;
  jobFieldLabel: string;
};

/** What the administrators' Prompt Test answers: the analysis, and whether it was made now or read from the store. */
export type PromptTestAnalysis = AnalyzedJob & {
  /** `ai` when a model wrote it, `sheet` when it was registered from an app sheet's Analysis cell. */
  source?: 'ai' | 'sheet';
  createdAt?: string;
};

export interface TailoredExperience {
  title: string;
  company: string;
  startDate: string;
  endDate: string;
  location: string;
  /** Always '' on a tailored role: a role opens straight into its bullets. */
  description: string;
  /** At most eight - the server keeps the eight that carry the most checklist terms. */
  achievements: string[];
}

export interface TailoredStrength {
  title: string;
  description: string;
}

/**
 * A tailored resume as the server answers it (backend types/template.ts).
 * `skillGroups` is the Technical Skills block as the model wrote it; every
 * other skill list here is worked out from it and the source resume, again, each
 * time the content is sent back - which is why the builder's Manual Edits box
 * holds only the editable part (`TailoredContentEdit`).
 */
export interface TailoredContent {
  /** The candidate's headline with the kind of role the posting is for, as the server composed it. */
  title: string;
  summary: string;
  experience: TailoredExperience[];
  skillGroups?: SkillGroup[];
  /** The heading the soft-skill group was asked for under, drawn per resume. */
  softSkillGroupHeading?: string;
  skills: string[];
  hardSkills: string[];
  softSkills: string[];
  /** The source resume's own, while its Strengths switch is on. */
  strengths: TailoredStrength[];
  coverLetter?: string;
}

/**
 * The part of a tailored resume a person edits and sends back: what the
 * builder's Manual Edits box holds (lib/tailoredDraft.ts). The server works
 * everything else out from it and the source resume - the title from its
 * headline when it has one, the skill lists, Soft Skills and Strengths. A
 * role's company, title and dates are there only to say which role its
 * bullets are (the dates tell two stints under one company and title apart);
 * they, and its place, print as the source resume has them.
 */
export interface TailoredContentEdit {
  title: string;
  summary: string;
  experience: Array<Pick<TailoredExperience, 'title' | 'company' | 'startDate' | 'endDate' | 'achievements'>>;
  skillGroups: SkillGroup[];
  coverLetter?: string;
}

/** Tailored content a page holds and may send back: the server's whole answer, or a person's edit of it. */
export type HeldTailoredContent = TailoredContent | TailoredContentEdit;

/**
 * A create's `?profileId=`: the profile (a person of the caller's own) the new
 * resume is filed under. Left out, the server files it by the person's name.
 * Never in the body - a body places nothing.
 */
function filedUnder(path: string, options?: { profileId?: string | null }): string {
  const profileId = options?.profileId?.trim();
  return profileId ? `${path}?profileId=${encodeURIComponent(profileId)}` : path;
}

// Resumes API
export const resumesApi = {
  getAll: (options?: { includeDisabled?: boolean }) =>
    apiFetch<Resume[]>(
      options?.includeDisabled ? '/resumes?includeDisabled=true' : '/resumes'
    ),

  getById: (id: string) => apiFetch<Resume>(`/resumes/${encodeURIComponent(id)}`),

  create: (data: CreateResumeDTO, options?: { profileId?: string | null }) =>
    apiFetch<Resume>(filedUnder('/resumes', options), {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Partial<CreateResumeDTO>) =>
    apiFetch<Resume>(`/resumes/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    apiFetch<{ message: string }>(`/resumes/${id}`, {
      method: 'DELETE',
    }),

  uploadPdf: (file: File, options?: { profileId?: string | null }) => {
    const formData = new FormData();
    formData.append('resume', file);
    return apiFetch<Resume>(filedUnder('/resumes/upload', options), {
      method: 'POST',
      body: formData,
    });
  },

  /**
   * Creates resumes from an already-parsed JSON document.
   *
   * The file is read and parsed by `readResumeImportFile` before it gets
   * here, so a file that is not JSON is reported without a round trip - and
   * the server, which cannot trust any of this anyway, is the one that decides
   * whether the parsed document is actually a resume.
   */
  importJson: (document: unknown, options?: { profileId?: string | null }) =>
    apiFetch<ResumeImportResult>(filedUnder('/resumes/import', options), {
      method: 'POST',
      body: JSON.stringify(document),
    }),

  /**
   * Draws an unsaved draft as a resume, for the editor's live preview.
   *
   * Saves nothing, asks no model and costs no credit. `resumeId` lays the
   * draft over that stored resume, so fields the editor never sends still
   * show as they will after a save. Aborting `signal` rejects with the
   * AbortError itself (see `apiFetch`), which the caller ignores.
   */
  preview: (
    body: {
      resume: CreateResumeDTO;
      resumeId?: string;
      templateId?: string;
      /** false: draw the resume as it stands, nothing filled from the sample person (the Profiles page's thumbnails). */
      sample?: false;
    },
    signal?: AbortSignal
  ) =>
    apiFetch<ResumeDraftPreviewResult>('/resumes/preview', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    }),

  /**
   * Writes or improves one entry's bullets, for the editor's Write with AI /
   * Improve with AI (POST /resumes/entries/bullets).
   *
   * Free, and nothing is saved: the editor puts the answer in its draft, and
   * the person saves or does not. A 400 names what the entry lacks (its
   * `code`: `entry-incomplete`, `nothing-to-improve`), a 409 says a request is
   * already running for the account, a 503 that no model can run here - each
   * a sentence for the reader as it stands. Aborting `signal` rejects with the
   * AbortError itself, which the caller ignores.
   */
  writeBullets: (body: WriteBulletsRequest, signal?: AbortSignal) =>
    apiFetch<WriteBulletsAnswer>('/resumes/entries/bullets', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    }),
};

/** The kinds of entry Write with AI serves, as the server names them (services/entryBullets.ts). */
export type WriteBulletsKind = 'experience' | 'project' | 'volunteering';
export type WriteBulletsTask = 'write' | 'improve';

/**
 * What `POST /resumes/entries/bullets` is sent: one entry as typed, who it
 * belongs to, and what to do. Built by lib/resumeDraft.ts's
 * `bulletsRequestFor`, never by a page.
 */
export interface WriteBulletsRequest {
  kind: WriteBulletsKind;
  /**
   * The entry's fields for its kind - title and company for experience, name
   * and role for a project, role and organization for volunteering - with its
   * dates, location, description, achievements and skills.
   */
  entry: Record<string, string | string[]>;
  /** Five facts about the person, never contact details. */
  resume?: {
    name: string;
    title: string;
    totalYearsExperience?: number;
    summary: string;
    skills: string[];
  };
  task: WriteBulletsTask;
  /** The note typed beside the button, when there is one. */
  instructions?: string;
}

export interface WriteBulletsAnswer {
  /** One to eight bullets, each at most 300 characters. */
  bullets: string[];
}

/** What `POST /templates/upload-json` reports back. */
export interface TemplateImportResult {
  templates: Template[];
  imported: number;
  /** How many kept the id from the file; the rest were given a new one. */
  keptIds: number;
}

export interface ResumeImportResult {
  resumes: Resume[];
  imported: number;
  /** How many kept the id from the file; the rest were given a new one. */
  keptIds: number;
  /** The distinct profiles the resumes were filed under, in file order. */
  profileIds: string[];
  /** The profiles the import made, for the people the file named who had none. */
  createdProfiles: Array<{ id: string; name: string }>;
}

/**
 * Reads a picked file as JSON.
 *
 * Its own function so that "this file is not JSON" reads as a sentence about
 * the file rather than as whatever `JSON.parse` decided to say about position
 * 4213 - which is the error a person actually gets when they pick a PDF from
 * the wrong row of their downloads folder.
 */
export async function readResumeImportFile(file: File): Promise<unknown> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    throw new Error(`Could not read ${file.name}.`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${file.name} is not valid JSON. Export a resume from this app, or check the file.`);
  }
}

/**
 * One profile as the server answered it, read leniently: a count that is not a
 * whole number reads 0, a default that is not text reads null, and a time that
 * is missing falls back to the profile's own `updatedAt`, so sorting by
 * `lastEditedAt` always has something to sort on.
 */
export function normalizeProfileSummary(value: unknown): ProfileSummary {
  const source = asRecord(value);
  const text = (field: unknown) => (typeof field === 'string' ? field : '');
  const count = (field: unknown) =>
    typeof field === 'number' && Number.isSafeInteger(field) && field > 0 ? field : 0;
  const idOrNull = (field: unknown) => (typeof field === 'string' && field ? field : null);
  const updatedAt = text(source.updatedAt);
  return {
    id: text(source.id),
    name: text(source.name),
    ...(typeof source.ownerId === 'string' && source.ownerId ? { ownerId: source.ownerId } : {}),
    createdAt: text(source.createdAt),
    updatedAt,
    lastEditedAt: text(source.lastEditedAt) || updatedAt,
    resumeCount: count(source.resumeCount),
    enabledResumeCount: count(source.enabledResumeCount),
    defaultResumeId: idOrNull(source.defaultResumeId),
    chosenDefaultResumeId: idOrNull(source.chosenDefaultResumeId),
  };
}

function normalizeProfileSummaries(value: unknown): ProfileSummary[] {
  return Array.isArray(value) ? value.map(normalizeProfileSummary) : [];
}

// Profiles API: a profile is a PERSON, and holds that person's resumes
export const profilesApi = {
  /** The caller's profiles; `allOwners` (an administrator's) lists everybody's, each with its `ownerId`. */
  getAll: async (options?: { allOwners?: boolean }) =>
    normalizeProfileSummaries(
      await apiFetch<unknown>(options?.allOwners ? '/profiles?allOwners=true' : '/profiles')
    ),

  get: async (id: string) =>
    normalizeProfileSummary(await apiFetch<unknown>(`/profiles/${encodeURIComponent(id)}`)),

  /** Counts against the subscription's limit on profiles (402 `profile-limit`); the listed resumes move in, all or nothing. */
  create: async (data: { name?: string; resumeIds?: string[] }) =>
    normalizeProfileSummary(
      await apiFetch<unknown>('/profiles', {
        method: 'POST',
        body: JSON.stringify(data),
      })
    ),

  /** A name, and/or the default resume (an ENABLED resume of this profile). */
  update: async (id: string, data: { name?: string; defaultResumeId?: string }) =>
    normalizeProfileSummary(
      await apiFetch<unknown>(`/profiles/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      })
    ),

  /** Moves resumes into this profile; answers it and every profile a resume came from, counted after the move. */
  move: async (id: string, resumeIds: string[]) => {
    const answer = asRecord(
      await apiFetch<unknown>(`/profiles/${encodeURIComponent(id)}/move`, {
        method: 'POST',
        body: JSON.stringify({ resumeIds }),
      })
    );
    return {
      moved: typeof answer.moved === 'number' && Number.isSafeInteger(answer.moved) ? answer.moved : 0,
      profiles: normalizeProfileSummaries(answer.profiles),
    };
  },

  /** Deletes the profile AND every resume in it. */
  delete: (id: string) =>
    apiFetch<{ deleted: true; deletedResumes: number }>(`/profiles/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
};

// Templates API
export const templatesApi = {
  getAll: (options?: { includeDisabled?: boolean }) =>
    apiFetch<Template[]>(
      options?.includeDisabled ? '/templates?includeDisabled=true' : '/templates'
    ),

  /** Administrators only. At least one of the three, or the server answers 400. */
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

    return apiFetch<TemplateImportResult>('/templates/upload-json', { method: 'POST', body: formData });
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

  /**
   * `featureKey` names the feature a draft not saved yet is for (a new or
   * duplicated variant has no `id`), so it is checked against the variables
   * that feature's code supplies rather than against none.
   */
  validateDraft: (data: {
    id?: string;
    featureKey?: PromptFeatureKey;
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
    featureKey?: PromptFeatureKey;
    content?: string;
    allowedVariables?: PromptVariableDefinition[];
    sampleValues?: Record<string, string>;
  }) =>
    apiFetch<PromptPreviewResult>('/prompts/preview', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

/**
 * Why a run chose the resume it built for a job (the server's
 * services/resumeMatch.ts `TaskMatch`): on a preview's answer, a queue
 * snapshot's task, and an order's item. `reason` is `matched` (the resume won
 * on its score), `tie` (the best score was shared, or nothing matched, and the
 * tie-break decided), `only` (the profile has one enabled resume) or `default`
 * (Fully Tailor, which builds the profile's default by rule).
 */
export interface TaskMatch {
  v: 1;
  mode: BuildMode;
  reason: 'matched' | 'tie' | 'only' | 'default';
  /** Enabled resumes the profile had when the choice was made. */
  candidates: number;
  /** What the score was worked out from; `matched` and `tie` only. */
  basis?: 'analysis' | 'text' | 'title' | 'none';
  score?: number;
  titleMatched?: boolean;
  /** The posting's terms the chosen resume carries, best first, at most 8, in the posting's spelling. */
  matched?: string[];
  matchedCount?: number;
  postingTermCount?: number;
}

/**
 * A `TaskMatch` as the server sent it, read leniently: null for anything that
 * is not one (an order item from before v4.2 has none), and only the known
 * keys of a known shape survive.
 */
export function normalizeTaskMatch(value: unknown): TaskMatch | null {
  const source = asRecord(value);
  const reason = source.reason;
  if (source.v !== 1 || !isBuildMode(source.mode)) return null;
  if (reason !== 'matched' && reason !== 'tie' && reason !== 'only' && reason !== 'default') return null;
  const count = (field: unknown) =>
    typeof field === 'number' && Number.isSafeInteger(field) && field >= 0 ? field : undefined;
  const basis = source.basis;
  const match: TaskMatch = {
    v: 1,
    mode: source.mode,
    reason,
    candidates: count(source.candidates) ?? 0,
  };
  if (basis === 'analysis' || basis === 'text' || basis === 'title' || basis === 'none') match.basis = basis;
  if (typeof source.score === 'number' && Number.isFinite(source.score)) match.score = source.score;
  if (typeof source.titleMatched === 'boolean') match.titleMatched = source.titleMatched;
  if (Array.isArray(source.matched)) {
    match.matched = source.matched.filter((term): term is string => typeof term === 'string');
  }
  const matchedCount = count(source.matchedCount);
  if (matchedCount !== undefined) match.matchedCount = matchedCount;
  const postingTermCount = count(source.postingTermCount);
  if (postingTermCount !== undefined) match.postingTermCount = postingTermCount;
  return match;
}

/**
 * The posting a preview is for, and the request's overrides. `companyName` and
 * `role` are optional context: the role is what the matcher compares resume
 * titles with, the company is recorded on the posting's stored analysis.
 */
type PreviewPosting = {
  /** The stored analysis to build on (from /resume/analyze or an earlier preview). */
  analysisId?: string;
  jobDescription?: string;
  jobLink?: string;
  companyName?: string;
  role?: string;
  templateId?: string;
  /** This request's model (Partial and Fully only); otherwise each resume's own, then the app default. */
  model?: string;
};

/**
 * What POST /resume/preview is sent: CHOOSE a resume of a profile and draw it
 * (`profileId`, with the run's `buildMode`; left out, the administrator's
 * default), or DRAW held tailored content again (`resumeId` and
 * `tailoredContent`).
 */
export type PreviewRequest = (
  | { profileId: string; buildMode?: BuildMode }
  | { resumeId: string; tailoredContent: HeldTailoredContent }
) &
  PreviewPosting;

/**
 * The builder's preview. `profileId`, `resumeId` and `resumeLabel` name the
 * resume that was drawn (what the page sends back as `previewedResumeId`);
 * `match` says why it was chosen, and is null when held content was drawn
 * again. `previewToken` comes only with content THIS request wrote
 * (Partial and Fully) and prices it at that mode when the run is finalised.
 */
export interface ResumePreviewAnswer {
  html: string;
  tailored: boolean;
  tailoredContent?: TailoredContent;
  previewToken?: string;
  /** The analysis the preview was built on, when it was built on one. */
  analysisId?: string;
  profileId: string;
  profileName: string;
  resumeId: string;
  resumeLabel: string;
  buildMode: BuildMode;
  match: TaskMatch | null;
}

function normalizePreviewAnswer(value: unknown): ResumePreviewAnswer {
  const source = asRecord(value);
  const text = (field: unknown) => (typeof field === 'string' ? field : '');
  const content = asRecord(source.tailoredContent);
  return {
    html: text(source.html),
    tailored: source.tailored === true,
    ...(Object.keys(content).length > 0 ? { tailoredContent: content as unknown as TailoredContent } : {}),
    ...(typeof source.previewToken === 'string' && source.previewToken
      ? { previewToken: source.previewToken }
      : {}),
    ...(typeof source.analysisId === 'string' && source.analysisId ? { analysisId: source.analysisId } : {}),
    profileId: text(source.profileId),
    profileName: text(source.profileName),
    resumeId: text(source.resumeId),
    resumeLabel: text(source.resumeLabel),
    buildMode: isBuildMode(source.buildMode) ? source.buildMode : 'partial',
    match: normalizeTaskMatch(source.match),
  };
}

// Resume API
export const resumeApi = {
  getModels: async () => normalizeUserAppSettings(await apiFetch<unknown>('/resume/models')),

  /**
   * The posting's one analysis: stored, or made now - once, ever - on the
   * administrator's analysis model. No model or prompt is sent: there is one
   * of each for every analysis, so that every resume, model and order builds
   * on the same reading of the posting. Keep the `analysisId` it answers and
   * send that onwards (lib/jobAnalysis.ts), not the analysis.
   */
  analyze: (jobDescription: string, jobLink?: string) =>
    apiFetch<AnalyzedJob>('/resume/analyze', {
      method: 'POST',
      body: JSON.stringify({ jobDescription, ...(jobLink ? { jobLink } : {}) }),
    }),

  /** Administrators' Prompt Test: the same one analysis, with where it came from. */
  analyzePromptTest: (jobDescription: string) =>
    apiFetch<PromptTestAnalysis>('/resume/analyze-prompt-test', {
      method: 'POST',
      body: JSON.stringify({ jobDescription }),
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

  /**
   * The builder's ONE preview (POST /resume/preview). Exactly one of
   * `profileId` (CHOOSE the resume as a run would for this posting, then draw
   * it: Choose Suitable Resume as written, Partial and Fully tailored, with a
   * `previewToken`) and `resumeId` with `tailoredContent` (draw held content
   * again: no model, no token). Both, or neither, is a 400.
   */
  preview: async (data: PreviewRequest, signal?: AbortSignal): Promise<ResumePreviewAnswer> =>
    normalizePreviewAnswer(
      await apiFetch<unknown>('/resume/preview', {
        method: 'POST',
        body: JSON.stringify(data),
        signal,
      })
    ),
};
