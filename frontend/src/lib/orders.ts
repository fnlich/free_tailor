import { apiFetch, getPreferredApiBase } from './api';

/**
 * Orders: resumes built from a Google Sheet import, and how to get them back.
 *
 * Everything here reads from the ORDER rather than from the generation batch
 * that produced it. That is the point of the feature: a batch is evicted an
 * hour after it finishes, so a page built on one goes blank exactly when
 * somebody comes back for their files the next morning.
 */

export type OrderState = 'running' | 'done' | 'failed' | 'cancelled' | 'expired';
export type OrderItemState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export type OrderFileKind =
  | 'resume-pdf'
  | 'resume-docx'
  | 'cover-letter-pdf'
  | 'cover-letter-docx';

export const FILE_KIND_LABELS: Record<OrderFileKind, string> = {
  'resume-pdf': 'Resume PDF',
  'resume-docx': 'Resume DOCX',
  'cover-letter-pdf': 'Cover letter PDF',
  'cover-letter-docx': 'Cover letter DOCX',
};

export type OrderFile = {
  kind: OrderFileKind;
  path: string;
  bytes?: number;
  /** Set once the retention sweep has deleted it. The row stays; the file went. */
  removedAt?: string;
};

export type OrderCounts = {
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  /** Everything that will never move again - what the progress bar counts. */
  settled: number;
};

export type Order = {
  id: string;
  number: string;
  userId: string;
  batchId?: string;
  label: string;
  total: number;
  state: OrderState;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  expiresAt: string;
  purgedAt?: string;
  counts: OrderCounts;
  /** Whether anything was actually produced. `done` alone does not imply it. */
  hasFiles: boolean;
};

export type OrderItem = {
  id: string;
  orderId: string;
  seq: number;
  profileId: string;
  profileName: string;
  companyName: string;
  role: string;
  sourceRowNumber?: number;
  state: OrderItemState;
  error?: string;
  files: OrderFile[];
  /** The kinds still on disk, so the page never offers a link to a deleted file. */
  available: OrderFileKind[];
};

export type OrderDetail = Order & { items: OrderItem[] };

/**
 * Download URLs, built rather than fetched.
 *
 * `apiFetch` always calls `.json()` on the response, so it cannot carry a PDF
 * or a zip. A plain `<a href>` can, and it still arrives authenticated: the
 * backend accepts the `ft_session` cookie as well as the bearer header, and a
 * cookie is the one credential an anchor sends by itself.
 */
export function orderFileUrl(orderId: string, itemId: string, kind: OrderFileKind): string {
  return `${getPreferredApiBase()}/orders/${orderId}/items/${itemId}/${kind}`;
}

/**
 * The archive URL, with a selection only when the selection is a subset.
 *
 * `total` matters: three hundred ids in a query string is a twelve-kilobyte
 * URL, and the common proxy default refuses a request line over eight. "Select
 * all" then "download selected" would 414 on exactly the orders big enough to
 * want it. Asking for everything has a shorter spelling, so use it.
 */
export function orderZipUrl(orderId: string, itemIds?: string[], total?: number): string {
  const base = `${getPreferredApiBase()}/orders/${orderId}/zip`;
  if (!itemIds || itemIds.length === 0) return base;
  if (typeof total === 'number' && itemIds.length >= total) return base;
  return `${base}?items=${itemIds.map((id) => encodeURIComponent(id)).join(',')}`;
}

/** True while the order still has work that could move. */
export function isOrderLive(order: { counts: OrderCounts; state: OrderState }): boolean {
  return order.state === 'running' && order.counts.queued + order.counts.running > 0;
}

export const ordersApi = {
  list: () => apiFetch<{ orders: Order[] }>('/orders'),
  get: (id: string) => apiFetch<OrderDetail>(`/orders/${id}`),
  cancel: (id: string) =>
    apiFetch<{ cancelled: number; aborted: number }>(`/orders/${id}/cancel`, { method: 'POST' }),
};
