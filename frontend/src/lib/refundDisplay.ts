import type { LedgerEntry } from './credits';
import type { Payment } from './payments';
import { describeDollarProblem, formatMoney, isWholeCents, parseDollars, toDollarInput } from './format';
import type {
  AdminRefundRequest,
  RefundMoved,
  RefundOption,
  RefundRequest,
  RefundRequestCounts,
  RefundRequestState,
  RefundStateFilter,
} from './refunds';

/**
 * How a refund request reads, and which buttons it gets - on /credits, on an
 * order's page, and in the administrators' queue.
 *
 * Its own module, apart from lib/refunds.ts, because these are decisions with
 * no request in them, and backend/test/frontendRefunds.test.js loads them -
 * which it can only do for a module whose one runtime import is lib/format.ts.
 * The reason rules below are COPIES of the server's (services/refunds), and
 * that test runs both over the same text: a box that accepts what the server
 * refuses is a form that cannot be sent and does not say why.
 */

/** The longest reason either side may write - the server's `MAX_REFUND_REASON`. */
export const MAX_REFUND_REASON = 1000;

export const REFUND_STATE_LABELS: Record<RefundRequestState, string> = {
  requested: 'Requested',
  approved: 'Approved',
  declined: 'Declined',
  refunded: 'Refunded',
};

/** A kit Pill tone per state, named as plain strings so this module imports no component. */
export const REFUND_STATE_TONES: Record<RefundRequestState, 'amber' | 'sky' | 'red' | 'green'> = {
  requested: 'amber',
  approved: 'sky',
  declined: 'red',
  refunded: 'green',
};

/** The administrators' filter, in the order a queue is worked: what needs deciding first. */
export const REFUND_FILTERS: ReadonlyArray<{ id: RefundStateFilter; label: string }> = [
  { id: 'open', label: 'Open' },
  { id: 'requested', label: 'Requested' },
  { id: 'approved', label: 'Approved' },
  { id: 'declined', label: 'Declined' },
  { id: 'refunded', label: 'Refunded' },
  { id: 'all', label: 'All' },
];

/** A filter out of a URL or a select. Anything unknown is the fallback rather than an error. */
export function readRefundFilter(value: unknown, fallback: RefundStateFilter): RefundStateFilter {
  return REFUND_FILTERS.some((filter) => filter.id === value) ? (value as RefundStateFilter) : fallback;
}

/** Requested and Approved together: what still needs an administrator. */
export function openRequestCount(counts: RefundRequestCounts | null | undefined): number {
  if (!counts) return 0;
  return (counts.requested || 0) + (counts.approved || 0);
}

/* ------------------------------------------------------------- reasons */

/**
 * A reason as the server stores it: control characters other than line breaks
 * and tabs removed, trimmed. The server's `cleanReason`, copied.
 */
export function cleanRefundReason(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
}

/**
 * Why a reason would be refused, in the server's words - or null when it
 * would be taken. `requester` is somebody asking; `admin` an administrator
 * declining, whose reason the person who asked will read.
 */
export function refundReasonProblem(value: string, whose: 'requester' | 'admin'): string | null {
  const reason = cleanRefundReason(value);
  if (!reason) {
    return whose === 'requester'
      ? 'Say why you are asking for a refund.'
      : 'Write the reason for declining - the person who asked will read it.';
  }
  if (reason.length > MAX_REFUND_REASON) return `Keep the reason under ${MAX_REFUND_REASON} characters.`;
  return null;
}

/* ------------------------------------------------- the requester's side */

/** Where the money goes when a request is refunded. */
export type RefundRoute = 'credit' | 'card' | 'by-hand';

/**
 * A resume's charge comes back as credit; a card purchase through Stripe; a
 * crypto purchase by hand, from the merchant dashboard, because nothing can
 * pull crypto back. The provider decides when it is known (the queue has it),
 * the method otherwise.
 */
export function refundRoute(request: {
  kind: RefundRequest['kind'];
  paymentMethod: RefundRequest['paymentMethod'];
  paymentProvider?: AdminRefundRequest['paymentProvider'];
}): RefundRoute {
  if (request.kind === 'resume') return 'credit';
  if (request.paymentProvider) return request.paymentProvider === 'stripe' ? 'card' : 'by-hand';
  return request.paymentMethod === 'card' ? 'card' : 'by-hand';
}

const ROUTE_PHRASES: Record<RefundRoute, string> = {
  credit: 'back on your balance',
  card: 'on its way back to your card',
  'by-hand': 'sent back to you by your administrator',
};

/**
 * The line under a request's pill on /credits: what happens next, why not, or
 * what came back. A declined request carries the administrator's own reason -
 * the one thing the person reading it needs from the decision.
 */
export function describeRequestOutcome(request: RefundRequest): string {
  switch (request.state) {
    case 'requested':
      return 'Waiting for an administrator to decide.';
    case 'approved':
      return 'Approved. The refund itself follows, and you will be told when it is made.';
    case 'declined':
      return request.declineReason ? `Declined: ${request.declineReason}` : 'Declined.';
    case 'refunded':
      return `${formatMoney(request.refundedMilli)} ${ROUTE_PHRASES[refundRoute(request)]}.`;
    default:
      return '';
  }
}

/**
 * What asking would give back, said before anybody writes a reason: the
 * amount, where it goes, and - for a purchase - that it is the UNSPENT part,
 * measured again when it is refunded.
 */
export function describeRefundOffer(option: RefundOption): string {
  const money = formatMoney(option.refundableMilli);
  if (option.kind === 'resume') {
    return `${money} back on your balance as credit - what this resume was charged.`;
  }
  const lead =
    option.paymentMethod === 'card'
      ? `${money} back to your card`
      : `${money} sent back to you by your administrator (crypto cannot be refunded automatically)`;
  return (
    `${lead}: what is left unspent of this purchase, in whole cents. Credit you spend before it is ` +
    'refunded is not given back twice - you get back what is left then.'
  );
}

/** One line for an item that already has a request open: which, and where it stands. */
export function describeOpenRequest(request: RefundRequest): string {
  return `Refund request ${request.reference} is open for this - ${REFUND_STATE_LABELS[request.state] ?? request.state}.`;
}

/**
 * What a place that shows a charge offers for it:
 *
 *  - `ask`: a request can be made now;
 *  - `open`: one already is, Requested or Approved - one per item, so the
 *    place says so rather than offering a second;
 *  - `refunded`: it was given back already;
 *  - `none`: it cannot be asked about, with the server's reason (still being
 *    built, refunded automatically, never charged...).
 */
export type RefundAction =
  | { kind: 'ask' }
  | { kind: 'open'; request: RefundRequest }
  | { kind: 'refunded' }
  | { kind: 'none'; reason: string };

export function refundActionFor(option: RefundOption): RefundAction {
  if (option.openRequest) return { kind: 'open', request: option.openRequest };
  if (option.available) return { kind: 'ask' };
  if (option.unavailableCode === 'refunded') return { kind: 'refunded' };
  return { kind: 'none', reason: option.unavailableReason || 'This cannot be refunded here.' };
}

/**
 * A few words for a resume's Refund cell on an order's page when it cannot be
 * asked about, where a dash would hide something worth knowing: that the
 * charge already came back on its own, or that there never was one. Every
 * other reason (still building, not on record...) is a dash, and the server's
 * full sentence is the cell's title either way.
 */
export function refundCellNote(option: Pick<RefundOption, 'unavailableCode'>): string | null {
  if (option.unavailableCode === 'auto-refunded') return 'Refunded automatically';
  if (option.unavailableCode === 'not-charged') return 'Not charged';
  return null;
}

/**
 * Whether a purchase on the order history gets "Ask for refund": paid - not
 * pending, failed, refunded or being refunded - and credited in dollars. One
 * that bought credits before they became dollars put nothing on any balance
 * today (the switch reset it), and the server refuses it for exactly that
 * (`creditedMilli` 0 - its `legacy` rule), so offering a button that can only
 * be refused would be noise. Whether anything is left UNSPENT is the server's
 * to measure, when the dialog opens: it says what would come back, or why
 * nothing would.
 */
export function purchaseOffersRefund(payment: Pick<Payment, 'state' | 'creditedMilli'>): boolean {
  return payment.state === 'paid' && payment.creditedMilli > 0;
}

/**
 * The charge a credit history row names, when that row is one a refund can be
 * asked about from: a run's charge in dollars (`generation-reserve`, negative,
 * written since credits became dollars), whose `refId` is the reservation the
 * server's options read. Null for every other row - a grant, a purchase, a
 * refund, and a charge from before dollars, which was reset with every balance.
 */
export function refundChargeIdFor(entry: LedgerEntry): string | null {
  if (entry.reason !== 'generation-reserve') return null;
  if (entry.legacyCredits) return null;
  if (!(entry.deltaMilli < 0)) return null;
  const id = typeof entry.refId === 'string' ? entry.refId.trim() : '';
  return id || null;
}

/* ------------------------------------------------- the administrators' side */

export type AdminRefundAction = 'approve' | 'decline' | 'refund';

/**
 * The buttons a request gets in the queue, from the transitions the server
 * allows: Approve only from Requested; Decline and Refunded from either open
 * state; nothing once Declined or Refunded, which are final.
 */
export function adminRefundActions(state: RefundRequestState): AdminRefundAction[] {
  if (state === 'requested') return ['approve', 'decline', 'refund'];
  if (state === 'approved') return ['decline', 'refund'];
  return [];
}

function whoAsked(request: AdminRefundRequest): string {
  return request.accountEmail || 'a deleted account';
}

/** What Refunded would move now: the server's re-measure, or what was asked when it sent none. */
export function refundableNow(request: AdminRefundRequest): number {
  return request.refundableNowMilli ?? request.amountMilli;
}

export type RefundConfirmation = {
  title: string;
  body: string;
  /** A crypto purchase: the administrator must confirm the money went back by hand first. */
  byHand: boolean;
  amountMilli: number;
  /** Set when nothing would move now; the confirm button stays off and this says why. */
  blocked: string | null;
};

/**
 * What the Refunded confirmation says before anything moves - so a crypto
 * refund says "send it back by hand FIRST" before the button, not after a
 * refusal, and a card refund says it is partial.
 */
export function describeRefundConfirmation(request: AdminRefundRequest): RefundConfirmation {
  const amountMilli = refundableNow(request);
  const money = formatMoney(amountMilli);
  const who = whoAsked(request);
  const blocked =
    amountMilli <= 0
      ? `${request.refundableNowReason || 'Nothing is left to refund.'} Decline the request instead.`
      : null;
  const route = refundRoute(request);

  if (route === 'credit') {
    return {
      title: `Credit ${money} back to ${who}?`,
      body:
        `${request.label}: its charge goes back on the balance as credit, against the run that charged it. ` +
        'The request turns Refunded in the same step, and they are told.',
      byHand: false,
      amountMilli,
      blocked,
    };
  }
  if (route === 'card') {
    return {
      title: `Refund ${money} to ${who}'s card?`,
      body:
        'A partial Stripe refund of what is left unspent of this purchase. The same amount comes off the balance ' +
        'first, so it cannot be spent while Stripe answers. The request turns Refunded only once Stripe accepts ' +
        'it; if Stripe refuses, the credit goes back and you can press this again.',
      byHand: false,
      amountMilli,
      blocked,
    };
  }
  const where =
    request.paymentProvider === 'cryptomus' || !request.paymentProvider
      ? 'your Cryptomus merchant dashboard'
      : 'wherever it was paid';
  return {
    title: `Mark ${request.reference} refunded?`,
    body:
      `Crypto cannot be refunded automatically. Send ${money} back from ${where} first, then confirm here ` +
      'that you have. The same amount of credit is then taken off their balance.',
    byHand: true,
    amountMilli,
    blocked,
  };
}

/**
 * Why the "amount sent back" of a crypto refund would be refused - the
 * server's rule: whole cents, more than nothing, no more than was asked - or
 * null when it would be taken, or left empty. Empty means "what the dialog
 * named": the queue then sends that figure, as typed text, because the server
 * records what the administrator says they sent and never measures it again
 * (the money has already gone; a balance spent since is a shortfall).
 */
export function amountSentProblem(value: string, askedMilli: number): string | null {
  if (!value.trim()) return null;
  const parsed = parseDollars(value);
  if (!parsed.ok) return describeDollarProblem(parsed.problem, 'The amount sent back');
  if (parsed.milli <= 0 || !isWholeCents(parsed.milli) || parsed.milli > askedMilli) {
    return (
      `The amount sent back must be whole cents, more than $0.000 and no more than the ` +
      `${formatMoney(askedMilli)} asked for.`
    );
  }
  return null;
}

/**
 * What the queue sends for a crypto refund recorded by hand: ALWAYS an amount,
 * as text - what was typed, or else the figure the dialog asked the
 * administrator to confirm they sent. Never left for the server to measure
 * again: by the time this is pressed the money has gone, at that figure, and
 * the buyer may have spent since the list was read - which the server then
 * reports as a shortfall instead of recording less than went back.
 */
export function byHandRefundBody(amountSent: string, confirmedMilli: number): { paidByHand: true; amountUsd: string } {
  return { paidByHand: true, amountUsd: amountSent.trim() || toDollarInput(confirmedMilli) };
}

/**
 * Refusals of a decision that mean the queue's row is out of date, rather than
 * that the press was wrong - decided by another administrator meanwhile, the
 * purchase refunded from the payments list or spent, being refunded right now
 * (`refunding`) or holding a card refund Stripe never confirmed
 * (`refund-unconfirmed`, which the row says once read again), the request or
 * its account gone - so the queue reads its list again behind the error. Not
 * `paid-by-hand-required`, which is the dialog asking for the by-hand
 * confirmation, nor `bad-amount` or a reason refusal, which are about what was
 * typed.
 */
export function isStaleRefundRefusal(code: string | undefined): boolean {
  return (
    code === 'request-final' ||
    code === 'not-found' ||
    code === 'not-refundable' ||
    code === 'nothing-unspent' ||
    code === 'account-missing' ||
    code === 'refunding' ||
    code === 'refund-unconfirmed'
  );
}

/** What the queue says after Approve or Decline. A repeat press is not an error, and says so. */
export function describeDecision(
  action: 'approve' | 'decline',
  request: AdminRefundRequest,
  changed: boolean
): string {
  if (action === 'approve') {
    return changed
      ? `${request.reference} approved. ${whoAsked(request)} has been told; no money has moved yet.`
      : `${request.reference} was already approved.`;
  }
  return changed
    ? `${request.reference} declined. ${whoAsked(request)} has been told why.`
    : `${request.reference} was already declined - the first reason stands.`;
}

/**
 * What the queue says after Refunded: what went back and, for a purchase, how
 * much credit came off the balance - all of it, or short by what was no longer
 * there. A card's credit is held before Stripe is asked, so only money sent
 * back by hand can fall short. Nothing moved is said as plainly as something
 * did.
 */
export function describeRefundMade(
  request: AdminRefundRequest,
  outcome: RefundMoved | null,
  changed: boolean
): string {
  if (!outcome) return `${request.reference} was already refunded - nothing more was moved.`;
  const money = formatMoney(outcome.refundedMilli);
  if (!changed) {
    return (
      `${money} went back for ${request.reference}, but the request had been decided elsewhere meanwhile ` +
      'and keeps its state.'
    );
  }
  const route = refundRoute(request);
  if (route === 'credit') return `${request.reference} refunded: ${money} credited back to ${whoAsked(request)}.`;
  const lead =
    route === 'card'
      ? `${request.reference} refunded: ${money} back to the card`
      : `${request.reference} marked refunded: ${money} recorded as sent back by hand`;
  if (outcome.shortfallMilli > 0) {
    return (
      `${lead}. Only ${formatMoney(outcome.reversedMilli)} of credit could be taken off the balance - the ` +
      `other ${formatMoney(outcome.shortfallMilli)} was no longer on it.`
    );
  }
  return `${lead}, and ${formatMoney(outcome.reversedMilli)} of credit taken off the balance.`;
}

/**
 * Added to the payments list's own Refund message: a purchase refunded from
 * there closes whatever refund request was open for it, and the administrator
 * should not find that out from the queue.
 */
export function describeClosedRequests(closed: number | undefined): string {
  if (!closed || closed <= 0) return '';
  return closed === 1
    ? ' Its open refund request was closed as Refunded.'
    : ` Its ${closed} open refund requests were closed as Refunded.`;
}
