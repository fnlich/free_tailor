import {
  apiFetch,
  apiFetchFile,
  apiStream,
  getPreferredApiBase,
  getToken,
  type AiRequestOverrides,
  type TaskMatch,
} from './api';
import { BUILD_MODE_LABELS, isBuildMode, type BuildMode } from './buildModes';
import { formatMoney } from './format';
import type { OrderFileKind } from './orders';
import type { SpendEstimate } from './spendConfirm';
import {
  claimTabId,
  contentDispositionName,
  downloadName,
  releaseRequest,
  releaseTabClaim,
  type StorageLike,
} from './immediateRun';

/**
 * Submitting work to the server's generation queue.
 *
 * The shape that matters: `submit` hands back an id and returns, before any
 * resume has been built. Everything else here is about reading that work back -
 * which is what lets the page be closed, reloaded, or opened somewhere else
 * without stopping it.
 */

export type BatchTaskState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export type BatchTask = {
  id: string;
  seq: number;
  state: BatchTaskState;
  /** The resume chosen for this job (fixed at submit). */
  resumeId: string;
  /** The resume's own name: the person's. */
  resumeName: string;
  /** The chosen resume's headline label, which tells two resumes of one person apart. */
  resumeLabel?: string;
  /** The profile's name when the run was submitted. */
  profileLabel?: string;
  /** Why this resume was chosen for this job; absent on a task queued before v4.2. */
  match?: TaskMatch;
  companyName: string;
  role: string;
  sourceRowNumber?: number;
  /**
   * Which PROVIDER's lane is building it right now, and which it last ran on -
   * provider ids, sent to an administrator only (the server strips both for
   * everybody else, as it does every other detail of the seats).
   */
  runningOn?: string;
  ranOn?: string;
  /**
   * Which go this is, present only from the SECOND on.
   *
   * Read so a retry is visible. A retried build goes back to `queued` still
   * carrying the previous attempt's `error` - deliberately, so the reason is not
   * lost - and without this the row simply read as failed and then quietly
   * succeeded, or looked hung.
   */
  attempts?: number;
  error?: string;
  /**
   * On a finished task, the files it produced, by kind - what a Generate
   * Immediately page downloads, one `GET .../tasks/:taskId/:kind` each.
   */
  files?: OrderFileKind[];
};

/** How a run is followed: Generate Immediately (tied to its tab) or an order (on /orders). */
export type BatchKind = 'immediate' | 'order';

export type BatchResult = {
  resumeId: string;
  resumeName: string;
  companyName: string;
  role: string;
  pdf?: string;
  docx?: string;
  coverLetterPdf?: string;
  coverLetterDocx?: string;
};

export type BatchSnapshot = {
  batchId: string;
  label: string;
  state: 'running' | 'done' | 'cancelled';
  /** Null for a run queued before kinds existed. */
  kind?: BatchKind | null;
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  jobCount: number;
  /** How many goes each task gets, from the server's own configuration. */
  maxAttempts?: number;
  createdAt: string;
  finishedAt?: string;
  tasks: BatchTask[];
  results?: BatchResult[];
  failures?: Array<{ resumeId: string; resumeName: string; companyName: string; error: string }>;
  failedCompanies?: string[];
  tailored?: boolean;
};

export type SubmitBatchRequest = AiRequestOverrides & {
  label?: string;
  templateId?: string;
  format?: 'pdf' | 'docx' | 'both';
  includeCoverLetterDocx?: boolean;
  /**
   * The ONE profile (a person of the caller's) the run builds, on every
   * subscription: the server refuses no profile, a list, or `resumeIds`
   * (400 `one-profile-per-run`).
   */
  profileId: string;
  /** Left out, the administrator's default mode (`UserAppSettings.defaultBuildMode`). */
  buildMode?: BuildMode;
  /**
   * The resume a preview showed. When this or any previewed content is sent,
   * the resumes the run would build must be that one (or keys of the content);
   * otherwise 409 `preview-changed`. Not allowed with Choose Suitable Resume's
   * previewed content (400 `suitable-takes-no-content`).
   */
  previewedResumeId?: string;
  jobs: Array<{
    companyName: string;
    role?: string;
    jobDescription?: string;
    /** The posting's link: with the text, what identifies it to the store of analyses. */
    jobLink?: string;
    /**
     * The posting's stored analysis, when the page holds it (from
     * /resume/analyze or a preview). Never the analysis itself - the server
     * builds only on analyses it stored. Left out, the server finds the
     * posting's own, or its first task makes it - once, for every resume.
     */
    analysisId?: string;
    sourceRowNumber?: number;
  }>;
  /**
   * The sheet a sheet run's rows were read from - each job's `sourceRowNumber`
   * is its row. The server reads those rows' Analysis cells itself, in one
   * batched call, and a row that already holds its analysis skips analysis;
   * a row without is written back once its posting is analysed. Only the
   * account's own sheet has those cells, and the server reads no other
   * (a `spreadsheetId`, when sent, must name it).
   */
  sheet?: { spreadsheetId?: string; tabName: string };
  tailoredContentByResumeId?: Record<string, unknown>;
  /**
   * Each preview's token, by resume id: the build mode that wrote that
   * resume's content, which the server prices it at. Content without a valid
   * token costs the floor, the dearest mode's price. The quote takes these alone.
   */
  previewTokenByResumeId?: Record<string, string>;
  /**
   * `immediate` (Generate Immediately: built while this tab follows it, each
   * resume downloaded as it lands, stopped when the tab goes) or `order`
   * (built on the server whether or not anybody watches, collected on the
   * Orders page with an order number). The server's default is `immediate`.
   */
  mode?: BatchKind;
  /** This tab's id (`currentTabId`), for an immediate run: the tab whose stream holds it. */
  tabId?: string;
};

export type SubmitBatchResponse = {
  batchId: string;
  kind?: BatchKind;
  /** The resumes queued: one per job. */
  total: number;
  jobCount: number;
  /** The mode the run builds in: the request's, else the administrator's default. */
  buildMode: BuildMode;
  /** Present only for an order: an immediate run's row is never listed, so never named. */
  orderId?: string;
  orderNumber?: string;
  /** The lanes and how busy they are; an administrator's eyes only. */
  queues?: unknown;
};

/**
 * What a submission would cost, from `POST /generation/quote`.
 *
 * A count and money only. Money is thousandths of a dollar. A resume costs
 * the price of the run's build mode, whatever model runs it, so every resume
 * of a run costs the same and the cost is exactly `resumes x price`:
 * `pricePerResumeMilli` is that one price, null only when there is nothing to
 * price (no resumes). The cost line shows `7 resumes × $0.023 = $0.161`.
 * `exempt` is an administrator, who is quoted the full amount and never
 * charged. `buildMode` is the mode the quote was worked out in (a known mode,
 * or absent).
 */
export type GenerationQuote = {
  resumes: number;
  costMilli: number;
  pricePerResumeMilli: number | null;
  balanceMilli: number;
  exempt: boolean;
  buildMode?: BuildMode;
};

/**
 * A count or an amount the server sent, as a whole number from 0 up - and
 * never floored into one. Thousandths of a dollar are already whole; a value
 * that is not is not a figure to repair by rounding, it is not a figure.
 */
function readWhole(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * Session storage, or null where reading it throws (a private window, blocked
 * site data). Everything that uses it works without it - a run still runs; a
 * reload just cannot find it again.
 */
export function tabStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Local storage, the same way - for what is remembered per browser rather than per tab. */
export function browserStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function mintTabId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // An insecure origin (a LAN IP over http) has no randomUUID; fall through.
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * This tab's id, held for as long as this document lives.
 *
 * Module state, not component state: Build Resumes unmounts and mounts again
 * as somebody moves around the app, and minting a new id each time would
 * orphan the run the tab started. Claimed in sessionStorage so a reload of
 * the tab finds the same id and its run (`claimTabId`), and released on
 * `pagehide` so it can - while a duplicated tab, which copies sessionStorage
 * while this page still holds the id, gets an id of its own.
 */
let thisTabId: string | null = null;

export function currentTabId(): string {
  if (thisTabId) return thisTabId;
  thisTabId = claimTabId(tabStorage(), mintTabId);
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => releaseTabClaim(tabStorage()));
    // Back from the back/forward cache: the same page, holding its id again.
    window.addEventListener('pageshow', (event) => {
      if (event.persisted && thisTabId) thisTabId = claimTabId(tabStorage(), () => thisTabId as string);
    });
  }
  return thisTabId;
}

/**
 * Stops this tab's Generate Immediately run, in a way that survives the page
 * going away: a keepalive POST to the release route (`releaseRequest`), with
 * `sendBeacon` - which every browser keeps alive - when `fetch` itself throws.
 * Fire and forget; the server's grace timer is the backstop either way.
 */
export function releaseRun(batchId: string, tabId: string): void {
  if (typeof window === 'undefined') return;
  const { url, init } = releaseRequest(getPreferredApiBase(), batchId, tabId, window.location.origin, getToken());
  try {
    void fetch(url, init).catch(() => undefined);
  } catch {
    try {
      navigator.sendBeacon?.(url);
    } catch {
      // Nothing left to try: the lease's grace stops it.
    }
  }
}

/**
 * Downloads one file of a finished resume, once: fetched through the owner-only
 * route as a Blob and saved through a hidden anchor on a `blob:` URL - the
 * page's own origin, so the `download` name is honoured and nothing navigates.
 * Throws the server's refusal (404, 409 not-ready, 410 file-deleted) for the
 * page to say in its own notice.
 */
export async function saveTaskFile(
  batchId: string,
  task: { taskId: string; companyName: string; resumeName: string },
  kind: OrderFileKind,
  signal?: AbortSignal
): Promise<void> {
  const { blob, disposition } = await apiFetchFile(
    `/generation/batches/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(task.taskId)}/${kind}`,
    signal
  );
  const name = contentDispositionName(disposition) ?? downloadName(task.companyName, task.resumeName, kind);
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = name;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Kept a while: the browser reads the blob after the click returns, and a
    // URL revoked too soon saves an empty or failed download.
    window.setTimeout(() => URL.revokeObjectURL(href), 60_000);
  }
}

export const generationApi = {
  submit: (body: SubmitBatchRequest) =>
    apiFetch<SubmitBatchResponse>('/generation/batches', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * Prices a submission without placing it: the same body as `submit`, so the
   * answer is resolved the way the real run would be.
   */
  quote: async (body: SubmitBatchRequest): Promise<GenerationQuote> => {
    const raw = await apiFetch<Record<string, unknown>>('/generation/quote', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const price = raw?.pricePerResumeMilli;
    const mode = raw?.buildMode;
    return {
      resumes: readWhole(raw?.resumes),
      costMilli: readWhole(raw?.costMilli),
      pricePerResumeMilli: typeof price === 'number' && Number.isSafeInteger(price) && price >= 0 ? price : null,
      balanceMilli: readWhole(raw?.balanceMilli),
      exempt: raw?.exempt === true,
      ...(isBuildMode(mode) ? { buildMode: mode } : {}),
    };
  },

  snapshot: (batchId: string, signal?: AbortSignal) =>
    apiFetch<BatchSnapshot>(`/generation/batches/${encodeURIComponent(batchId)}`, { signal }),

  /**
   * The caller's own running Generate Immediately runs started from this tab -
   * what the builder may pick back up after a reload. Never an order, never
   * another tab's or another account's.
   */
  listActive: (tabId: string) =>
    apiFetch<{ batches: BatchSnapshot[] }>(`/generation/batches?active=1&tab=${encodeURIComponent(tabId)}`),

  cancel: (batchId: string) =>
    apiFetch<{ cancelled: number; aborted: number }>(
      `/generation/batches/${encodeURIComponent(batchId)}/cancel`,
      { method: 'POST' }
    ),

  /**
   * Follows a batch until it finishes.
   *
   * Every line is a complete snapshot, including the first - so there is nothing
   * to reconcile when a reader joins late, and a caller can simply replace its
   * state each time rather than applying deltas in order.
   */
  follow: (
    batchId: string,
    onSnapshot: (snapshot: BatchSnapshot) => void,
    signal?: AbortSignal,
    /**
     * The tab the run was started in. For a Generate Immediately run, this
     * tab's open stream is what keeps it going (the server's tab lease); any
     * other reader only reads.
     */
    tabId?: string
  ) =>
    apiStream(
      `/generation/batches/${encodeURIComponent(batchId)}/stream${tabId ? `?tab=${encodeURIComponent(tabId)}` : ''}`,
      (line) => onSnapshot(line as unknown as BatchSnapshot),
      signal
    ),
};

/**
 * What the spend confirm says a run is, with the mode it builds in:
 * `7 resumes at $0.023 each (Partial Tailor)`, or `1 resume (Partial Tailor)`
 * for one resume or when there is no single price. A quote that names no
 * mode says no mode.
 */
export function describeRunSpend(quote: GenerationQuote): string {
  const resumes = `${quote.resumes} resume${quote.resumes === 1 ? '' : 's'}`;
  const priced =
    quote.pricePerResumeMilli !== null && quote.resumes > 1
      ? `${resumes} at ${formatMoney(quote.pricePerResumeMilli)} each`
      : resumes;
  return quote.buildMode ? `${priced} (${BUILD_MODE_LABELS[quote.buildMode]})` : priced;
}

/**
 * What a run will take, for the spend confirm (components/SpendConfirm.tsx):
 * the server's quote for exactly the body about to be sent, priced the way the
 * real submission is. A quote that fails - offline, a model no longer on
 * offer - is a cost NOT KNOWN, never $0: the confirm then says it could not be
 * worked out, and the balance is the account's as the page last read it.
 * `what` names what is being paid for.
 */
export async function estimateRun(
  body: SubmitBatchRequest,
  fallback: { balanceMilli: number | null; exempt: boolean }
): Promise<{ estimate: SpendEstimate; what: string | null }> {
  try {
    const quote = await generationApi.quote(body);
    return {
      estimate: { costMilli: quote.costMilli, balanceMilli: quote.balanceMilli, exempt: quote.exempt, chargedOn: null },
      what: describeRunSpend(quote),
    };
  } catch {
    return {
      estimate: { costMilli: null, balanceMilli: fallback.balanceMilli, exempt: fallback.exempt, chargedOn: null },
      what: null,
    };
  }
}
