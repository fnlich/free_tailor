import { apiFetch, getPreferredApiBase, type TaskMatch } from './api';
import type { CancelOutcome } from './orderCancel';

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
  resumeId: string;
  resumeName: string;
  companyName: string;
  role: string;
  sourceRowNumber?: number;
  state: OrderItemState;
  error?: string;
  files: OrderFile[];
  /** The kinds still on disk, so the page never offers a link to a deleted file. */
  available: OrderFileKind[];
  /**
   * What this resume was charged, in thousandths of a dollar - kept on the
   * item because the run that charged it is gone within the hour. Null on an
   * item placed before items carried it, and 0 for one never charged.
   */
  costMilli: number | null;
  /**
   * What the run chose for this item (v4.2): the chosen resume's headline
   * label, the profile's name when it was submitted, and the matcher's
   * explanation. All null on an item an older build wrote - the page then
   * prints it as it always did (`resumeName` alone).
   */
  resumeLabel: string | null;
  profileLabel: string | null;
  match: TaskMatch | null;
  /**
   * Which provider built it - its id, the name it has now and its type - or
   * null before it started. Sent to an ADMINISTRATOR only: which sign-in, at
   * which folder, built a resume is nobody else's business, and the server
   * leaves the field out for everybody else (the page draws what it is sent).
   */
  ranOn?: { id: string; label: string; type: string | null } | null;
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

/**
 * What Cancel asks before it stops an order, and what it says it did - on
 * /orders, on an order's page and on the builder's receipt alike
 * (lib/orderCancel.ts, which the backend suite runs).
 */
export { cancelOrderQuestion, describeCancelOutcome, type CancelOutcome } from './orderCancel';

/** What a build mode is called in the sentence that says how a resume was chosen. */
const CHOICE_MODE_WORDS = {
  suitable: 'Suitable resume',
  partial: 'Partial Tailor',
  full: 'Fully Tailor',
} as const;

/** How many matched terms the sentence names before it counts the rest. */
const CHOICE_TERMS_SHOWN = 8;

/**
 * How a run came to build the resume it built, in one sentence - the order
 * page's second line, the receipt's rows and the builder's preview note all
 * say it this way. Null when there is nothing to say (an item placed before
 * v4.2 carries no match).
 */
export function describeChoice(match: TaskMatch | null | undefined): string | null {
  if (!match || typeof match !== 'object') return null;
  const word = CHOICE_MODE_WORDS[match.mode];
  if (!word) return null;
  switch (match.reason) {
    case 'matched': {
      const terms = Array.isArray(match.matched)
        ? match.matched.filter((term): term is string => typeof term === 'string' && term.length > 0)
        : [];
      if (terms.length > 0) {
        const shown = terms.slice(0, CHOICE_TERMS_SHOWN);
        const total = typeof match.matchedCount === 'number' ? match.matchedCount : terms.length;
        const more = total - shown.length;
        return `${word}: matched ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
      }
      return match.titleMatched ? `${word}: its title matches the posting's` : null;
    }
    case 'tie':
      return `${word}: no other resume matched better, so the profile's default`;
    case 'only':
      return `${word}: the profile's only enabled resume`;
    case 'default':
      return "Fully Tailor: the profile's default resume";
    default:
      return null;
  }
}

export const ordersApi = {
  list: () => apiFetch<{ orders: Order[] }>('/orders'),
  get: (id: string) => apiFetch<OrderDetail>(`/orders/${id}`),
  cancel: (id: string) => apiFetch<CancelOutcome>(`/orders/${id}/cancel`, { method: 'POST' }),
};
