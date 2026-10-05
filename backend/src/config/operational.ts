import {
  envInt,
  envList,
  envRaw,
  envString,
  type EnvIntOptions,
  type EnvSource,
} from './envValue';
import { PROVIDER_MODEL_OPTION_SETTINGS } from './providerModels';
import {
  GEMINI_CLI_INT_SETTINGS,
  GEMINI_CLI_SETTINGS,
  GEMINI_CLI_TIMEOUT_VARIABLES,
  geminiCliTimeoutMs,
  type GeminiCliTimeoutVariable,
} from '../services/ai/providers/geminiCli/options';

/**
 * The operational settings that used to be literals in the code.
 *
 * Timeouts, size caps, pool widths and third-party actor ids that depend on the machine, the network or the plan an installation runs on
 * rather than on anything in this repository. Each one is here ONCE - name,
 * default, bounds and getter - so the value a module uses, the value
 * `.env.example` documents and the value the startup line reports cannot drift
 * apart. This file is the one to diff against `.env.example`.
 *
 * Three rules hold for every entry:
 *
 *   - The default is exactly the literal it replaced. An installation that sets
 *     none of these behaves as it did before they existed.
 *   - Nothing here can stop the server from starting. Junk warns once and uses
 *     the default; out of range is clamped and warns once (`envValue.ts`).
 *   - The unit is in the name, and only the suffixes the codebase already used:
 *     _MS, _S, _DAYS, _MB, _BYTES.
 *
 * WHEN each is read follows one rule. A value that sizes or builds a resource
 * (the body parser, the multer instances, the server timeouts, the render
 * semaphore, the SMTP pool, the retention timer) is read once, when the resource
 * is built: re-reading it later could not resize what already exists. Every
 * other value is read on each use, which costs nothing and lets a test hand in
 * its own environment. Either way `.env` itself is loaded once at boot, so a
 * change to the file needs a restart.
 *
 * None of these is a secret, which is what lets `describeNonDefaultOperationalSettings`
 * print their values at startup. Keys, tokens and passwords are deliberately
 * not in this file.
 */

/* ======================================================== numeric bounds */

/**
 * Every whole-number setting's default and bounds, in one place.
 *
 * Keyed by the variable name so a getter cannot read one name with another's
 * bounds. The frontend's two server-only calendar values are listed too: the
 * backend never reads them, but their default and bounds are decided here, once,
 * and the frontend's own reader uses the same numbers.
 */
export const OPERATIONAL_INT_BOUNDS = {
  SESSION_TTL_DAYS: { fallback: 30, min: 1, max: 365, unit: 'day(s)' },
  JSON_BODY_MAX_MB: { fallback: 10, min: 1, max: 100, unit: 'MB' },
  UPLOAD_MAX_MB: { fallback: 10, min: 1, max: 100, unit: 'MB' },
  HTTP_REQUEST_TIMEOUT_MS: { fallback: 900_000, min: 60_000, max: 3_600_000, unit: 'ms' },
  AI_REQUEST_TIMEOUT_MS: { fallback: 300_000, min: 5_000, max: 3_600_000, unit: 'ms' },
  AI_CLI_HEALTH_TIMEOUT_MS: { fallback: 20_000, min: 1_000, max: 120_000, unit: 'ms' },
  AI_CODEX_HEALTH_TIMEOUT_MS: { fallback: 15_000, min: 1_000, max: 120_000, unit: 'ms' },
  GENERATION_RENDER_CONCURRENCY: { fallback: 4, min: 1, max: 32, unit: 'render(s)' },
  PDF_RENDER_TIMEOUT_MS: { fallback: 30_000, min: 5_000, max: 300_000, unit: 'ms' },
  ORDER_RETENTION_SWEEP_MS: { fallback: 21_600_000, min: 60_000, max: 86_400_000, unit: 'ms' },
  IMMEDIATE_TAB_GRACE_MS: { fallback: 30_000, min: 5_000, max: 600_000, unit: 'ms' },
  IMMEDIATE_FILE_RETENTION_MS: { fallback: 600_000, min: 60_000, max: 86_400_000, unit: 'ms' },
  SMTP_CONNECTION_TIMEOUT_MS: { fallback: 10_000, min: 1_000, max: 300_000, unit: 'ms' },
  SMTP_SOCKET_TIMEOUT_MS: { fallback: 20_000, min: 1_000, max: 300_000, unit: 'ms' },
  SMTP_MAX_CONNECTIONS: { fallback: 2, min: 1, max: 20, unit: 'connection(s)' },
  SHEET_BACKFILL_PAUSE_MS: { fallback: 250, min: 0, max: 60_000, unit: 'ms' },
  JOB_PAGE_FETCH_TIMEOUT_MS: { fallback: 20_000, min: 1_000, max: 120_000, unit: 'ms' },
  JOB_PAGE_BROWSER_TIMEOUT_MS: { fallback: 25_000, min: 1_000, max: 180_000, unit: 'ms' },
  APIFY_RUN_TIMEOUT_S: { fallback: 300, min: 30, max: 3_600, unit: 's' },
  CRYPTOMUS_INVOICE_LIFETIME_S: { fallback: 3_600, min: 300, max: 43_200, unit: 's' },
  JOB_LAKE_DUPLICATE_WINDOW_DAYS: { fallback: 60, min: 1, max: 3_650, unit: 'day(s)' },
  // Frontend, server-only (read by the Next route handlers; listed for the record).
  CALENDAR_API_TIMEOUT_MS: { fallback: 12_000, min: 1_000, max: 120_000, unit: 'ms' },
  CALENDAR_DETAIL_CONCURRENCY: { fallback: 12, min: 1, max: 32, unit: 'request(s)' },
} as const satisfies Record<string, EnvIntOptions & { fallback: number }>;

type IntName = keyof typeof OPERATIONAL_INT_BOUNDS;

function readInt(name: IntName, env: EnvSource): number {
  const spec = OPERATIONAL_INT_BOUNDS[name];
  return envInt(name, spec.fallback, spec, env);
}

/* ======================================================== server limits */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a sign-in lasts, in days.
 *
 * ONE reader for the session row's `expires_at` and the cookie's `maxAge`,
 * which used to be two literals that merely happened to agree: a cookie that
 * outlives its row is a silent 401 on every request, and a row that outlives
 * its cookie is a sign-in the browser has already thrown away. Expiry is
 * stamped when the session is created and never extended, so a change affects
 * new sign-ins only.
 */
export function sessionTtlDays(env: EnvSource = process.env): number {
  return readInt('SESSION_TTL_DAYS', env);
}

export function sessionTtlMs(env: EnvSource = process.env): number {
  return sessionTtlDays(env) * DAY_MS;
}

/**
 * The largest JSON body any /api route accepts, in MB.
 *
 * Batch requests and profile imports are the large ones, and how large depends
 * on the operator's batches, not on the code. Read once, where the parser is
 * built. Not the template JSON import, which is a multipart file upload with a
 * fixed 2 MB of its own (routes/templates.ts), nor the payment webhooks' 1 MB.
 */
export function jsonBodyMaxMb(env: EnvSource = process.env): number {
  return readInt('JSON_BODY_MAX_MB', env);
}

/**
 * The PDF upload cap, in MB: a resume or template PDF must be UNDER it - busboy
 * refuses a file the moment it reaches the limit, so exactly this size is
 * refused, as it always was.
 *
 * Scanned PDFs are routinely bigger than a typed one. Read once, where the
 * multer instance is built (middleware/pdfUpload.ts, which works out the bytes
 * from that one read), and served to the browser by GET /api/auth/me
 * (`uploadMaxMb`) rather than duplicated as a NEXT_PUBLIC_ value that could
 * disagree with what the server enforces.
 */
export function uploadMaxMb(env: EnvSource = process.env): number {
  return readInt('UPLOAD_MAX_MB', env);
}

/**
 * How long Node allows for RECEIVING one request, in ms.
 *
 * Not the time to produce a response - the AI layer's own deadlines bound
 * that. This is what a slow upload over a poor link runs into, so it has to
 * grow with UPLOAD_MAX_MB and JSON_BODY_MAX_MB. The floor is a minute because
 * Node reads 0 as "no limit at all", which is not a value to reach by typo.
 */
export function httpRequestTimeoutMs(env: EnvSource = process.env): number {
  return readInt('HTTP_REQUEST_TIMEOUT_MS', env);
}

/**
 * The port the API listens on.
 *
 * Not in the table below: PORT predates this file and is documented already.
 * It is read through the same validator so a junk or out-of-range value warns
 * and uses 3001 instead of reaching `listen`, which throws on it. Out of range
 * FALLS BACK rather than clamping - PORT=0 used to mean 3001 (`Number(x) || 3001`)
 * and clamping it to port 1 would be a privileged port nobody asked for.
 */
export function serverPort(env: EnvSource = process.env): number {
  return envInt('PORT', 3001, { min: 1, max: 65_535, outOfRange: 'fallback' }, env);
}

/* =========================================================== AI transport */

/**
 * The wall-clock deadline of every AI call, in ms.
 *
 * The OUTER bound: the time spent queued for a seat's slot and the CLI child
 * both fit inside it, and a CLI call-site's own budget is capped by it (the
 * smaller of the two wins). See `describeAiTimeoutsAboveRequestDeadline` for
 * the case where a CLI budget is set above it and so can never take effect.
 */
export function aiRequestTimeoutMs(env: EnvSource = process.env): number {
  return readInt('AI_REQUEST_TIMEOUT_MS', env);
}

/** Timeout of `claude --version` and `claude auth status` in the health checks, in ms. */
export function aiCliHealthTimeoutMs(env: EnvSource = process.env): number {
  return readInt('AI_CLI_HEALTH_TIMEOUT_MS', env);
}

/** Timeout of `codex login status` in the health check, in ms. */
export function aiCodexHealthTimeoutMs(env: EnvSource = process.env): number {
  return readInt('AI_CODEX_HEALTH_TIMEOUT_MS', env);
}

/**
 * The CLI per-call budgets, in ms: the four variables claudeCli/options.ts and
 * codexCli/options.ts read for a call's own time limit, with the defaults they
 * use. Not in OPERATIONAL_VARIABLES - they predate it and keep their own,
 * looser reading (below) - but kept here so the providers and the startup
 * warning about them read one list and one set of numbers.
 *
 * There were six: each seat had a `_FILTER` budget for the Job Filter's own
 * short reading of a posting. That reading is gone - the filter judges the
 * posting's one job analysis (owner decision J8), which runs on the seat's
 * ordinary budget - so nothing read them any more, and they went with it.
 *
 * The Gemini seat's two (`AI_GEMINI_TIMEOUT_MS*`) are not in this object:
 * they are newer than envValue.ts and read through it, with the rest of that
 * seat's settings, in OPERATIONAL_VARIABLES. `cliTimeoutMs` still answers for
 * them, through the seat's own reader, so the warning below covers all six.
 */
export const CLI_TIMEOUT_DEFAULTS_MS = {
  AI_CLI_TIMEOUT_MS: 180_000,
  AI_CLI_TIMEOUT_MS_TAILOR: 300_000,
  AI_CODEX_TIMEOUT_MS: 180_000,
  AI_CODEX_TIMEOUT_MS_TAILOR: 300_000,
} as const;

export type CliTimeoutVariable = keyof typeof CLI_TIMEOUT_DEFAULTS_MS;

/** Every seat's per-call budget variable: the four above and the Gemini seat's two. */
export type AnyCliTimeoutVariable = CliTimeoutVariable | GeminiCliTimeoutVariable;

function isGeminiTimeout(name: AnyCliTimeoutVariable): name is GeminiCliTimeoutVariable {
  return (GEMINI_CLI_TIMEOUT_VARIABLES as readonly string[]).includes(name);
}

/** The default of any seat's per-call budget, in ms. */
export function cliTimeoutDefaultMs(name: AnyCliTimeoutVariable): number {
  return isGeminiTimeout(name) ? GEMINI_CLI_INT_SETTINGS[name].fallback : CLI_TIMEOUT_DEFAULTS_MS[name];
}

/**
 * One CLI budget, read the way its provider reads it.
 *
 * For the four older ones: `parseInt`, so `600000ms` is 600000 and `600000.5` is
 * 600000; clamped to 5000..3600000; the default for anything with no leading
 * number - all without a word, which is older than envValue.ts and left as it
 * was so no install's budgets move. The Gemini seat's two go through that
 * seat's own reader (envValue.ts, the same bounds, junk warned about once).
 * The ONE reader of all six: the providers call it or the reader it defers
 * to, and so does the warning below, which therefore cannot disagree with them
 * about a value.
 */
export function cliTimeoutMs(name: AnyCliTimeoutVariable, env: EnvSource = process.env): number {
  if (isGeminiTimeout(name)) return geminiCliTimeoutMs(name, env);
  const parsed = Number.parseInt((env[name] ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return CLI_TIMEOUT_DEFAULTS_MS[name];
  return Math.min(3_600_000, Math.max(5_000, parsed));
}

/** Every seat's per-call budget variable, in the order the warning below walks them. */
export const ALL_CLI_TIMEOUT_VARIABLES: readonly AnyCliTimeoutVariable[] = [
  ...(Object.keys(CLI_TIMEOUT_DEFAULTS_MS) as CliTimeoutVariable[]),
  ...GEMINI_CLI_TIMEOUT_VARIABLES,
];

/**
 * The CLI budgets that are set above the request deadline, and so do nothing.
 *
 * A CLI call runs for the SMALLER of its own budget and AI_REQUEST_TIMEOUT_MS.
 * So `AI_CLI_TIMEOUT_MS_TAILOR=600000` with the request deadline at its default
 * 300000 is accepted, read, and then capped at five minutes without a word -
 * the operator raised a limit and nothing changed. Said once at startup instead.
 *
 * Only a budget that is SET, and set to something other than its own default,
 * is reported. Lowering the request deadline below a CLI default is a
 * legitimate way to cap everything, and a budget AT its default is one nobody
 * chose: older copies of .env.example wrote the first six out uncommented, so a
 * `.env` made from one has them, and warning about those would tell the
 * operator to undo the cap they had just set. The value is read with
 * `cliTimeoutMs`, exactly as the providers read it; one with no leading number
 * is their default to them, silently, and so is not reported here either.
 */
export function describeAiTimeoutsAboveRequestDeadline(env: EnvSource = process.env): string[] {
  const deadline = aiRequestTimeoutMs(env);
  const warnings: string[] = [];

  for (const name of ALL_CLI_TIMEOUT_VARIABLES) {
    if (envRaw(name, env) === null) continue;
    const value = cliTimeoutMs(name, env);
    if (value === cliTimeoutDefaultMs(name)) continue;
    if (value > deadline) {
      warnings.push(
        `[ai] ${name}=${value} is longer than AI_REQUEST_TIMEOUT_MS=${deadline}, which bounds every AI call, ` +
          `so it never takes effect. Raise AI_REQUEST_TIMEOUT_MS to at least ${value} to allow it.`
      );
    }
  }
  return warnings;
}

/* ======================================================= generation & PDF */

/**
 * How many resumes may be rendered through Chrome at once, across every queue.
 *
 * Sized by the machine's memory and CPU (each render is a Chrome tab). Read
 * ONCE, when the queue module loads: the semaphore it sizes is replaced
 * whenever the limit it is asked for changes, so a per-call read that moved
 * would drop the count of renders already in flight.
 */
export function generationRenderConcurrency(env: EnvSource = process.env): number {
  return readInt('GENERATION_RENDER_CONCURRENCY', env);
}

/**
 * How long one render step - or the Chrome launch behind it - may take, in ms.
 *
 * 30 seconds is puppeteer's own default for both, which is why that is the
 * default here: the value was never written down, only inherited. A slow or
 * shared box with heavy templates is where it runs out.
 */
export function pdfRenderTimeoutMs(env: EnvSource = process.env): number {
  return readInt('PDF_RENDER_TIMEOUT_MS', env);
}

/**
 * How often the retention sweep deletes expired order files, in ms.
 *
 * Six hours by default; files live for days. Shorter is how
 * ORDER_RETENTION_DAYS=0 ("delete on the next sweep") can be watched working
 * without waiting a quarter of a day. Read once, when the timer starts.
 */
export function orderRetentionSweepMs(env: EnvSource = process.env): number {
  return readInt('ORDER_RETENTION_SWEEP_MS', env);
}

/**
 * How long a Generate Immediately run outlives its page, in ms.
 *
 * The grace between the last reader of an immediate run going away and the
 * run being cancelled (services/queue/tabLease.ts). It is for a page that went
 * WITHOUT saying so - a page that is closed, reloaded or left sends a release
 * and stops its run at once. 30 seconds by default: long enough for a dropped
 * connection or a laptop that slept to come back, short enough that a tab gone
 * for good stops spending a seat on resumes nobody will download. A reader
 * that vanished without closing its connection is counted out after at most
 * LEASE_READER_LIFETIME_MS (20 s) first, so such a run stops within this plus
 * 20 s. Bounded below at 5 s - a stream's reconnect has to fit - and above at
 * 10 minutes, past which a lost tab no longer "stops" anything. Read each time
 * a timer starts.
 */
export function immediateTabGraceMs(env: EnvSource = process.env): number {
  return readInt('IMMEDIATE_TAB_GRACE_MS', env);
}

/**
 * How long a Generate Immediately run's files are kept after the run ends, in
 * ms - downloaded or not (owner decision M4).
 *
 * The page downloads each resume as it finishes, so the copy on the server is
 * only there for that download to finish. Ten minutes by default; then the
 * retention sweep deletes them, about a minute late at most. Bounded below at a
 * minute so the last auto-download always has time. Read on every sweep.
 */
export function immediateFileRetentionMs(env: EnvSource = process.env): number {
  return readInt('IMMEDIATE_FILE_RETENTION_MS', env);
}

/* ================================================================ mail */

/**
 * SMTP connect and greeting timeouts, in ms.
 *
 * Bounded below at a second, never 0: nodemailer reads 0 as "wait for ever",
 * and a network that silently drops outbound SMTP is exactly where that turns
 * a sign-in into a request that never returns.
 */
export function smtpConnectionTimeoutMs(env: EnvSource = process.env): number {
  return readInt('SMTP_CONNECTION_TIMEOUT_MS', env);
}

/** SMTP idle socket timeout, in ms. */
export function smtpSocketTimeoutMs(env: EnvSource = process.env): number {
  return readInt('SMTP_SOCKET_TIMEOUT_MS', env);
}

/** Width of the pooled SMTP connection pool. Some relays cap concurrent connections. */
export function smtpMaxConnections(env: EnvSource = process.env): number {
  return readInt('SMTP_MAX_CONNECTIONS', env);
}

/* ============================================================ Google Sheets */

/**
 * Pause between per-account spreadsheet allocations in the startup backfill, in ms.
 *
 * A throttle against the Drive/Sheets quota of the operator's own Cloud
 * project, which depends on that project's plan. 0 is allowed: no pause.
 */
export function sheetBackfillPauseMs(env: EnvSource = process.env): number {
  return readInt('SHEET_BACKFILL_PAUSE_MS', env);
}

/* ============================================================== job pages */

/** Timeout of the plain fetch of a job-posting URL, in ms. */
export function jobPageFetchTimeoutMs(env: EnvSource = process.env): number {
  return readInt('JOB_PAGE_FETCH_TIMEOUT_MS', env);
}

/** `page.goto` timeout of the headless-Chrome fallback for JS-rendered job pages, in ms. */
export function jobPageBrowserTimeoutMs(env: EnvSource = process.env): number {
  return readInt('JOB_PAGE_BROWSER_TIMEOUT_MS', env);
}

const DEFAULT_JOB_PAGE_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * The User-Agent of the job-page fetch and of the Chrome page behind it.
 *
 * Configurable because it is pinned to one Chrome release, and sites block a
 * user agent once it is old enough. At most 512 characters of printable ASCII -
 * it is sent as a header. Not only no line break: Node's fetch throws on a
 * header character above U+00FF, and an ellipsis or a U+2028 pasted from a web
 * page is exactly that. The job-page reader takes any fetch failure as "this
 * page needs JavaScript", so such a value would have sent every job link to
 * headless Chrome without a word; refused here, it warns once and the default
 * is used.
 */
export function jobPageUserAgent(env: EnvSource = process.env): string {
  return envString(
    'JOB_PAGE_USER_AGENT',
    DEFAULT_JOB_PAGE_USER_AGENT,
    {
      maxLength: 512,
      pattern: /^[\x20-\x7e]+$/,
      expected: 'a single-line, printable-ASCII User-Agent of at most 512 characters',
    },
    env
  );
}

/* ================================================================ scrapers */

/**
 * The location a scraper is given when the user leaves it empty, the fixed
 * memo23 location, and the jobs form's initial value. The deployment's job
 * market. Served to the jobs page by GET /api/jobs/scrapers/settings.
 */
export function scraperDefaultLocation(env: EnvSource = process.env): string {
  return envString(
    'SCRAPER_DEFAULT_LOCATION',
    'United States',
    { maxLength: 100, expected: 'a location of at most 100 characters' },
    env
  );
}

/**
 * The Indeed actor's country and the memo23 proxy exit country, as an ISO
 * 3166-1 alpha-2 code. Should agree with SCRAPER_DEFAULT_LOCATION.
 */
export function scraperCountry(env: EnvSource = process.env): string {
  return envString(
    'SCRAPER_COUNTRY',
    'US',
    { upperCase: true, pattern: /^[A-Z]{2}$/, expected: 'a two-letter ISO country code such as US or GB' },
    env
  );
}

/**
 * The Apify proxy groups for the jobboard, hiringcafe and memo23 runs.
 *
 * EMPTY MEANS THE DEFAULT, not "no group": a bare `APIFY_PROXY_GROUPS=` is what
 * a copied example produces, and reading it as "omit" would quietly move every
 * such install onto datacenter proxies. The word `auto` is how to omit the
 * groups and let Apify choose; the result is then an empty list.
 */
export function apifyProxyGroups(env: EnvSource = process.env): string[] {
  if (envRaw('APIFY_PROXY_GROUPS', env)?.toLowerCase() === 'auto') return [];
  return envList(
    'APIFY_PROXY_GROUPS',
    ['RESIDENTIAL'],
    { upperCase: true, pattern: /^[A-Z0-9_]+$/, expected: 'an Apify proxy group name (letters, digits, _)' },
    env
  );
}

/**
 * The Apify run timeout in seconds, which is also how long POST
 * /api/jobs/scrapers/run blocks - a reverse proxy's read timeout must be at
 * least this. Billed until it expires.
 */
export function apifyRunTimeoutS(env: EnvSource = process.env): number {
  return readInt('APIFY_RUN_TIMEOUT_S', env);
}

/**
 * The most results one scraper run may request, or null for no cap (the
 * default, and today's server behaviour). The only spend limit on a
 * plan-billed third party that the browser cannot simply bypass.
 */
export function scraperMaxResults(env: EnvSource = process.env): number | null {
  return envInt('SCRAPER_MAX_RESULTS', null, { min: 1, max: 10_000, unit: 'result(s)' }, env);
}

/**
 * Third-party Apify actor ids, one variable per scraper.
 *
 * Configurable because actors get renamed, go paid, or are forked - but only a
 * drop-in fork with the SAME input and output schema works, because the
 * filters and the normalizer are written per actor. The pattern accepts
 * `owner/name`, `owner~name` and Apify's 17-character actor ids.
 */
export const APIFY_ACTOR_DEFAULTS = {
  APIFY_ACTOR_INDEED: 'misceres/indeed-scraper',
  APIFY_ACTOR_JOBBOARD: 'openclawai/job-board-scraper',
  APIFY_ACTOR_WELLFOUND: 'blackfalcondata/wellfound-scraper',
  APIFY_ACTOR_LEVER: 'deadlyaccurate/lever-jobs-scraper',
  APIFY_ACTOR_HIRINGCAFE: 'manojachari/hiring-cafe-scraper',
  APIFY_ACTOR_HIRINGCAFE_CRAWLERBROS: 'crawlerbros/hiring-cafe-scraper',
  APIFY_ACTOR_HIRINGCAFE_MEMO23: 'memo23/apify-hiring-cafe-scraper',
} as const;

export type ApifyActorVariable = keyof typeof APIFY_ACTOR_DEFAULTS;

const APIFY_ACTOR_ID = /^(?:[A-Za-z0-9._-]+[/~][A-Za-z0-9._-]+|[A-Za-z0-9]{17})$/;

/** The actor id configured under `name`, or its default. */
export function apifyActorId(name: ApifyActorVariable, env: EnvSource = process.env): string {
  return envString(
    name,
    APIFY_ACTOR_DEFAULTS[name],
    { pattern: APIFY_ACTOR_ID, expected: 'an Apify actor id (owner/name, owner~name or a 17-character id)' },
    env
  );
}

/* ================================================================ payments */

/**
 * How long a buyer has to pay a hosted Cryptomus invoice, in seconds.
 *
 * The bounds are Cryptomus's documented range (5 minutes to 12 hours), which -
 * like everything about that integration - has never been checked against the
 * live API from this repository. A slow chain is the reason to raise it.
 */
export function cryptomusInvoiceLifetimeS(env: EnvSource = process.env): number {
  return readInt('CRYPTOMUS_INVOICE_LIFETIME_S', env);
}

/* ======================================================== job data lake */

/**
 * The Job Data Lake's duplicate window, in days (owner decision J2b): a job
 * reported again while its lake row was last added or replaced within this
 * many days is a DUPLICATE - painted red, not paid; reported after it, the new
 * report REPLACES the row and counts as added. 60 by default, two months.
 *
 * The .env half only: an administrator's value on /admin/job-lake wins over
 * it (services/jobLake/settings.ts `resolveDuplicateWindow`, which also says
 * where the value in effect came from). Read on every merge.
 */
export function jobLakeDuplicateWindowDays(env: EnvSource = process.env): number {
  return readInt('JOB_LAKE_DUPLICATE_WINDOW_DAYS', env);
}

/* ================================================================== table */

export type OperationalVariable = {
  name: string;
  /** Today's value as `.env.example` shows it; '' means "unset", which is itself the default. */
  defaultValue: string;
  /** Inclusive bounds of a whole-number setting. */
  bounds?: { min: number; max: number };
  /**
   * Which process reads it.
   *
   * 'frontend' entries are here so their names and defaults are decided in one
   * place, not because the backend uses them: the Next server or bundle reads
   * them, and the backend has no getter for them.
   */
  side: 'backend' | 'frontend';
  /**
   * 'startup': sizes or builds a resource, read once when it is built.
   * 'per-call': read on each use.
   * 'frontend-build': NEXT_PUBLIC_, compiled into the bundle - rebuild to change.
   * 'frontend-runtime': read by a Next route handler at request time - restart to change.
   */
  readAt: 'startup' | 'per-call' | 'frontend-build' | 'frontend-runtime';
  /** Where it takes effect. */
  readIn: string;
  /** The effective value, formatted like `defaultValue`. Backend entries only. */
  current?: (env: EnvSource) => string;
};

function intEntry(
  name: IntName,
  readAt: OperationalVariable['readAt'],
  readIn: string,
  current?: (env: EnvSource) => number
): OperationalVariable {
  const spec = OPERATIONAL_INT_BOUNDS[name];
  return {
    name,
    defaultValue: String(spec.fallback),
    bounds: { min: spec.min, max: spec.max },
    side: current ? 'backend' : 'frontend',
    readAt,
    readIn,
    ...(current ? { current: (env: EnvSource) => String(current(env)) } : {}),
  };
}

function actorEntry(name: ApifyActorVariable, readIn: string): OperationalVariable {
  return {
    name,
    defaultValue: APIFY_ACTOR_DEFAULTS[name],
    side: 'backend',
    readAt: 'per-call',
    readIn,
    current: (env) => apifyActorId(name, env),
  };
}

/**
 * Every setting this file owns, grouped by the feature each one tunes - the
 * way `.env.example` groups them.
 *
 * The record a test diffs against `.env.example`, and what the startup line
 * walks. A new operational variable is added here AND documented there.
 */
export const OPERATIONAL_VARIABLES: readonly OperationalVariable[] = [
  // Server limits
  intEntry('SESSION_TTL_DAYS', 'per-call', 'database/userRepository.ts, routes/auth.ts', sessionTtlDays),
  intEntry('JSON_BODY_MAX_MB', 'startup', 'index.ts (express.json)', jsonBodyMaxMb),
  intEntry('UPLOAD_MAX_MB', 'startup', 'middleware/pdfUpload.ts', uploadMaxMb),
  intEntry('HTTP_REQUEST_TIMEOUT_MS', 'startup', 'index.ts (server.requestTimeout)', httpRequestTimeoutMs),

  // Frontend: calendar
  {
    name: 'NEXT_PUBLIC_CALENDAR_DEFAULT_TIMEZONE',
    defaultValue: 'America/Los_Angeles',
    side: 'frontend',
    readAt: 'frontend-build',
    readIn: 'frontend/src/components/CalendarWorkspace.tsx, frontend/src/lib/calendar/service.ts',
  },
  intEntry('CALENDAR_API_TIMEOUT_MS', 'frontend-runtime', 'frontend/src/lib/calendar/service.ts'),
  intEntry(
    'CALENDAR_DETAIL_CONCURRENCY',
    'frontend-runtime',
    'frontend/src/app/api/calendars/[shareId]/links/route.ts'
  ),

  // AI providers
  intEntry('AI_REQUEST_TIMEOUT_MS', 'per-call', 'services/ai/promptExecution.ts', aiRequestTimeoutMs),
  intEntry('AI_CLI_HEALTH_TIMEOUT_MS', 'per-call', 'services/ai/providers/claudeCli/health.ts', aiCliHealthTimeoutMs),
  intEntry(
    'AI_CODEX_HEALTH_TIMEOUT_MS',
    'per-call',
    'services/ai/providers/codexCli/health.ts',
    aiCodexHealthTimeoutMs
  ),
  // The model names Admin -> Models offers each seat.
  ...PROVIDER_MODEL_OPTION_SETTINGS,
  // The Gemini seat, every setting of it: it was written after this table, so
  // nothing of it predates the table the way the other two seats' settings do.
  ...GEMINI_CLI_SETTINGS,

  // Accounts: SMTP
  intEntry(
    'SMTP_CONNECTION_TIMEOUT_MS',
    'startup',
    'services/auth/mailer.ts (pooled transport)',
    smtpConnectionTimeoutMs
  ),
  intEntry('SMTP_SOCKET_TIMEOUT_MS', 'startup', 'services/auth/mailer.ts (pooled transport)', smtpSocketTimeoutMs),
  intEntry('SMTP_MAX_CONNECTIONS', 'startup', 'services/auth/mailer.ts (pooled transport)', smtpMaxConnections),

  // Google Sheets
  intEntry('SHEET_BACKFILL_PAUSE_MS', 'per-call', 'services/sheets/accountSheet.ts', sheetBackfillPauseMs),

  // Job scrapers (Apify) and job pages
  {
    name: 'SCRAPER_DEFAULT_LOCATION',
    defaultValue: 'United States',
    side: 'backend',
    readAt: 'per-call',
    readIn: 'routes/jobs.ts, services/scraperProviders.ts (served on GET /api/jobs/scrapers/settings)',
    current: scraperDefaultLocation,
  },
  {
    name: 'SCRAPER_COUNTRY',
    defaultValue: 'US',
    side: 'backend',
    readAt: 'per-call',
    readIn: 'services/scraperProviders.ts -> scrapers/filters.js',
    current: scraperCountry,
  },
  {
    name: 'SCRAPER_MAX_RESULTS',
    defaultValue: '',
    bounds: { min: 1, max: 10_000 },
    side: 'backend',
    readAt: 'per-call',
    readIn:
      'routes/jobs.ts, services/scraperProviders.ts -> scrapers/filters.js ' +
      '(served on GET /api/jobs/scrapers/providers)',
    current: (env) => String(scraperMaxResults(env) ?? ''),
  },
  {
    name: 'APIFY_PROXY_GROUPS',
    defaultValue: 'RESIDENTIAL',
    side: 'backend',
    readAt: 'per-call',
    readIn: 'services/scraperProviders.ts -> scrapers/filters.js',
    current: (env) => {
      const groups = apifyProxyGroups(env);
      return groups.length === 0 ? 'auto' : groups.join(',');
    },
  },
  intEntry(
    'APIFY_RUN_TIMEOUT_S',
    'per-call',
    'services/scraperProviders.ts -> scrapers/*.js (served on GET /api/jobs/scrapers/settings)',
    apifyRunTimeoutS
  ),
  actorEntry('APIFY_ACTOR_INDEED', 'scrapers/indeed.js'),
  actorEntry('APIFY_ACTOR_JOBBOARD', 'scrapers/jobboard.js'),
  actorEntry('APIFY_ACTOR_WELLFOUND', 'scrapers/wellfound.js'),
  actorEntry('APIFY_ACTOR_LEVER', 'scrapers/lever.js'),
  actorEntry('APIFY_ACTOR_HIRINGCAFE', 'scrapers/hiringcafe.js'),
  actorEntry('APIFY_ACTOR_HIRINGCAFE_CRAWLERBROS', 'scrapers/hiringcafeCrawlerbros.js'),
  actorEntry('APIFY_ACTOR_HIRINGCAFE_MEMO23', 'scrapers/hiringcafeMemo23.js'),
  intEntry('JOB_PAGE_FETCH_TIMEOUT_MS', 'per-call', 'services/jobPageContent.ts', jobPageFetchTimeoutMs),
  intEntry('JOB_PAGE_BROWSER_TIMEOUT_MS', 'per-call', 'services/jobPageContent.ts', jobPageBrowserTimeoutMs),
  {
    name: 'JOB_PAGE_USER_AGENT',
    defaultValue: DEFAULT_JOB_PAGE_USER_AGENT,
    side: 'backend',
    readAt: 'per-call',
    readIn: 'services/jobPageContent.ts',
    current: jobPageUserAgent,
  },

  // Payments
  intEntry(
    'CRYPTOMUS_INVOICE_LIFETIME_S',
    'per-call',
    'integrations/cryptomus.ts',
    cryptomusInvoiceLifetimeS
  ),

  // Generation
  intEntry(
    'GENERATION_RENDER_CONCURRENCY',
    'startup',
    'services/queue/resumeTask.ts (resume-render semaphore)',
    generationRenderConcurrency
  ),
  intEntry(
    'PDF_RENDER_TIMEOUT_MS',
    'per-call',
    'generators/pdfGenerator.ts, generators/coverLetterGenerator.ts, config/browser.ts',
    pdfRenderTimeoutMs
  ),

  // Orders
  intEntry('ORDER_RETENTION_SWEEP_MS', 'startup', 'services/orders/retention.ts', orderRetentionSweepMs),
  intEntry(
    'IMMEDIATE_TAB_GRACE_MS',
    'per-call',
    'services/queue/tabLease.ts (through services/queue/index.ts getTabLeases)',
    immediateTabGraceMs
  ),
  intEntry('IMMEDIATE_FILE_RETENTION_MS', 'per-call', 'services/orders/retention.ts', immediateFileRetentionMs),

  // Job Data Lake
  intEntry(
    'JOB_LAKE_DUPLICATE_WINDOW_DAYS',
    'per-call',
    'services/jobLake/settings.ts (an administrator\'s value on /admin/job-lake wins)',
    jobLakeDuplicateWindowDays
  ),
];

/** `NAME=value`, quoted when the value has a space or a comma in it so the line still splits. */
function formatSetting(name: string, value: string): string {
  return /[\s,"]/.test(value) ? `${name}=${JSON.stringify(value)}` : `${name}=${value}`;
}

/**
 * ONE startup line naming every setting above that is not at its default, or
 * null when all of them are.
 *
 * Effective values, not raw ones: a value that was clamped is shown as the
 * number actually in use, and one that was junk (and warned about) is at its
 * default and so is not listed. That makes this line the answer to "what is
 * this install actually running with", which is the question an operator has
 * when something is slower or larger than they expected. Frontend entries are
 * skipped - this process does not apply them.
 */
export function describeNonDefaultOperationalSettings(env: EnvSource = process.env): string | null {
  const changed: string[] = [];
  for (const variable of OPERATIONAL_VARIABLES) {
    if (!variable.current) continue;
    const value = variable.current(env);
    if (value !== variable.defaultValue) changed.push(formatSetting(variable.name, value));
  }
  return changed.length > 0 ? `[env] Non-default settings: ${changed.join(', ')}` : null;
}
