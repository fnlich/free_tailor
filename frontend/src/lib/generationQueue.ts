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
  /** Which browser is building it right now. */
  runningOn?: string;
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
};

export type SubmitBatchResponse = {
  batchId: string;
  total: number;
  jobCount: number;
  profileCount: number;
};

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
