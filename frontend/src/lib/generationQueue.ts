import { apiFetch, apiStream, type AiRequestOverrides, type JobAnalysis } from './api';

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
  profileId: string;
  profileName: string;
  companyName: string;
  role: string;
  sourceRowNumber?: number;
  /** Which seat's lane is building it right now. */
  runningOn?: string;
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
};

export type BatchResult = {
  profileId: string;
  profileName: string;
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
  failures?: Array<{ profileId: string; profileName: string; companyName: string; error: string }>;
  failedCompanies?: string[];
  tailored?: boolean;
  unconfirmedHardSkills?: string[];
  unconfirmedSoftSkills?: string[];
};

export type SubmitBatchRequest = AiRequestOverrides & {
  label?: string;
  templateId?: string;
  format?: 'pdf' | 'docx' | 'both';
  includeCoverLetterDocx?: boolean;
  profileIds?: string[];
  jobs: Array<{
    companyName: string;
    role?: string;
    jobDescription?: string;
    jobAnalysis?: JobAnalysis;
    sourceRowNumber?: number;
  }>;
  tailoredContentByProfileId?: Record<string, unknown>;
  /**
   * Each preview's token, by profile id: the model that wrote that profile's
   * content, which the server prices it at. The quote takes these alone.
   */
  previewTokenByProfileId?: Record<string, string>;
  /**
   * Place this as an order instead of waiting for it.
   *
   * What the Google Sheet import sends. The caller gets an order number back
   * immediately and the files are collected on the Orders page, rather than the
   * page holding a connection open for however long three hundred resumes take.
   */
  asOrder?: boolean;
};

export type SubmitBatchResponse = {
  batchId: string;
  total: number;
  jobCount: number;
  profileCount: number;
  /** Present only for a submission that asked to be placed as an order. */
  orderId?: string;
  orderNumber?: string;
};

/**
 * What a submission would cost, from `POST /generation/quote`.
 *
 * A count and money only - the server resolves each profile's model exactly as
 * it would for the real submission, and keeps which models those are to
 * itself. Money is thousandths of a dollar. `pricePerResumeMilli` is the one
 * price every resume in the run costs, or null when they differ (profiles in a
 * group can resolve to different models) - so the cost line can show
 * `7 resumes × $0.023 = $0.161` when that is true and the total alone when it
 * is not. `exempt` is an administrator, who is never charged.
 */
export type GenerationQuote = {
  resumes: number;
  costMilli: number;
  pricePerResumeMilli: number | null;
  balanceMilli: number;
  exempt: boolean;
};

/**
 * A count or an amount the server sent, as a whole number from 0 up - and
 * never floored into one. Thousandths of a dollar are already whole; a value
 * that is not is not a figure to repair by rounding, it is not a figure.
 */
function readWhole(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** Where the running batch's id is kept, so a reload can find it again. */
export const ACTIVE_BATCH_KEY = 'freeTailor.activeBatchId';

export function rememberBatch(batchId: string): void {
  try {
    window.localStorage.setItem(ACTIVE_BATCH_KEY, batchId);
  } catch {
    // A browser with storage disabled still generates resumes; it just cannot
    // find its way back to one after a reload, and `listActive` covers that.
  }
}

export function forgetBatch(): void {
  try {
    window.localStorage.removeItem(ACTIVE_BATCH_KEY);
  } catch {
    // as above
  }
}

export function rememberedBatch(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_BATCH_KEY);
  } catch {
    return null;
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
    return {
      resumes: readWhole(raw?.resumes),
      costMilli: readWhole(raw?.costMilli),
      pricePerResumeMilli: typeof price === 'number' && Number.isSafeInteger(price) && price >= 0 ? price : null,
      balanceMilli: readWhole(raw?.balanceMilli),
      exempt: raw?.exempt === true,
    };
  },

  snapshot: (batchId: string) =>
    apiFetch<BatchSnapshot>(`/generation/batches/${encodeURIComponent(batchId)}`),

  listActive: () =>
    apiFetch<{ batches: BatchSnapshot[] }>('/generation/batches?active=1'),

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
    signal?: AbortSignal
  ) =>
    apiStream(
      `/generation/batches/${encodeURIComponent(batchId)}/stream`,
      (line) => onSnapshot(line as unknown as BatchSnapshot),
      signal
    ),
};
