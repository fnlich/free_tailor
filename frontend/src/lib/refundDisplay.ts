import { describeDollarProblem, formatMoney, isWholeCents, parseDollars, toDollarInput } from './format';
import type {
  AdminRefundRequest,
  PayoutStatus,
  RefundKind,
  RefundMoved,
  RefundRequest,
  RefundRequestCounts,
  RefundRequestState,
  RefundStateFilter,
} from './refunds';

/**
 * How a refund or payout request reads, and which buttons it gets - on
 * /credits (a user's old requests, a reporter's payout requests) and in the
 * administrators' queue.
 *
 * Its own module, apart from lib/refunds.ts, because these are decisions with
 * no request in them, and backend/test/frontendRefunds.test.js loads them -
 * which it can only do for a module whose runtime imports are pure (lib/format.ts
 * here). The reason and note rules below are COPIES of the server's
 * (services/refunds), and that test runs both over the same text: a box that
 * accepts what the server refuses is a form that cannot be sent and does not
 * say why. A payout's amount and note are checked by lib/reporterPay.ts's
 * `payoutProblem`, the one Admin -> Accounts uses, because the server refuses
 * both in the same words.
 */

/** The longest reason either side may write - the server's `MAX_REFUND_REASON`. */
export const MAX_REFUND_REASON = 1000;

export const REFUND_STATE_LABELS: Record<RefundRequestState, string> = {
  requested: 'Requested',
  approved: 'Approved',
  declined: 'Declined',
  refunded: 'Refunded',
};

/**
 * A state as its pill says it. A payout that Refunded recorded was PAID OUT,
 * not refunded - the server's notices say so too.
 */
export function refundStateLabel(request: Pick<RefundRequest, 'kind' | 'state'>): string {
  if (request.kind === 'payout' && request.state === 'refunded') return 'Paid out';
  return REFUND_STATE_LABELS[request.state] ?? request.state;
}

export const REFUND_KIND_LABELS: Record<RefundKind, string> = {
  purchase: 'Purchase',
  resume: 'Resume',
  payout: 'Payout',
};

/** A kind as a word, and anything this build does not know as itself rather than a guess. */
export function refundKindLabel(kind: RefundKind | string): string {
  return REFUND_KIND_LABELS[kind as RefundKind] ?? kind;
}

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
 * Why an administrator's reason for declining would be refused, in the
 * server's words - or null when it would be taken. The person who asked reads
 * it. (Nobody writes a reason to ASK for a refund any more; a reporter's
 * payout note is `payoutNoteProblem`, and optional.)
 */
export function declineReasonProblem(value: string): string | null {
  const reason = cleanRefundReason(value);
  if (!reason) return 'Write the reason for declining - the person who asked will read it.';
  if (reason.length > MAX_REFUND_REASON) return `Keep the reason under ${MAX_REFUND_REASON} characters.`;
  return null;
}

/**
 * Why a reporter's payout note would be refused, in the server's words
 * (services/refunds `createPayoutRequest`) - or null. Optional: an empty note
 * is a request with nothing to add.
 */
export function payoutNoteProblem(value: string): string | null {
  if (cleanRefundReason(value).length > MAX_REFUND_REASON) return `Keep the note under ${MAX_REFUND_REASON} characters.`;
  return null;
}

/* ------------------------------------------------- the requester's side */

/** Where the money goes when a request is refunded - for a payout, outside the app. */
export type RefundRoute = 'credit' | 'card' | 'by-hand' | 'payout';

/**
 * A resume's charge comes back as credit; a card purchase through Stripe; a
 * crypto purchase by hand, from the merchant dashboard, because nothing can
 * pull crypto back; a payout is paid outside the app and only RECORDED here.
 * The provider decides when it is known (the queue has it), the method
 * otherwise.
 */
export function refundRoute(request: {
  kind: RefundRequest['kind'];
  paymentMethod: RefundRequest['paymentMethod'];
  paymentProvider?: AdminRefundRequest['paymentProvider'];
}): RefundRoute {
  if (request.kind === 'payout') return 'payout';
  if (request.kind === 'resume') return 'credit';
  if (request.paymentProvider) return request.paymentProvider === 'stripe' ? 'card' : 'by-hand';
  return request.paymentMethod === 'card' ? 'card' : 'by-hand';
}

const ROUTE_PHRASES: Record<RefundRoute, string> = {
  credit: 'back on your balance',
  card: 'on its way back to your card',
  'by-hand': 'sent back to you by your administrator',
  payout: 'paid out to you',
};

/**
 * The line under a request's pill on /credits: what happens next, why not, or
 * what came back. A declined request carries the administrator's own reason -
 * the one thing the person reading it needs from the decision. A payout says
 * what was RECORDED as paid, which may be more than was asked.
 */
export function describeRequestOutcome(request: RefundRequest): string {
  switch (request.state) {
    case 'requested':
      return 'Waiting for an administrator to decide.';
    case 'approved':
      return request.kind === 'payout'
        ? 'Approved. The payout itself follows, and you will be told when it is recorded.'
        : 'Approved. The refund itself follows, and you will be told when it is made.';
    case 'declined':
      return request.declineReason ? `Declined: ${request.declineReason}` : 'Declined.';
    case 'refunded':
      return `${formatMoney(request.refundedMilli)} ${ROUTE_PHRASES[refundRoute(request)]}.`;
    default:
      return '';
  }
}

/**
 * Why a reporter's Ask for Refund is off, as its tooltip and the line under it
 * say - the server's own sentence when it sent one - or '' when it is on.
 * While the standing is still loading, or could not be read, it is off too,
 * with that said: a button that asks blind would only be refused.
 */
export function payoutBlocker(status: PayoutStatus | null, loading: boolean): string {
  if (!status) return loading ? 'Checking whether you can ask for a payout.' : 'Your payout standing could not be read.';
  if (status.available) return '';
  if (status.unavailableReason) return status.unavailableReason;
  if (status.unavailableCode === 'request-open' || status.openRequest) {
    return 'You already have a payout request open. An administrator will record the payout, or tell you why not.';
  }
  if (status.balanceMilli <= 0) return 'There are no earnings on your balance to pay out yet.';
  return "Only a reporter's earned balance is paid out.";
}

/** What the payout dialog says before anything is sent: the whole balance, paid outside the app. */
export function describePayoutAsk(balanceMilli: number): string {
  return (
    `This asks an administrator to pay out your earned balance, ${formatMoney(balanceMilli)}. They pay you ` +
    'outside the app, then record what they sent; it comes off your balance and you are told in your ' +
    'notifications. Jobs you add meanwhile keep earning, and may be paid out with it.'
  );
}

/* ------------------------------------------------- the administrators' side */

export type AdminRefundAction = 'approve' | 'decline' | 'refund';

/**
 * The buttons a request gets in the queue, from the transitions the server
 * allows: Approve only from Requested; Decline and Refunded (Record payout,
 * for a payout) from either open state; nothing once Declined or Refunded,
 * which are final.
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

/** The words for Refunded on a request: "Record payout" for a payout, "Mark refunded" otherwise. */
export function refundActionLabel(request: Pick<AdminRefundRequest, 'kind'>): string {
  return request.kind === 'payout' ? 'Record payout' : 'Mark refunded';
}

/** "Balance now $4.1" under an open payout's amount: the most Record payout may record. */
export function describePayoutBalanceNow(request: AdminRefundRequest): string | null {
  if (request.kind !== 'payout' || request.refundableNowMilli === null) return null;
  if (request.refundableNowMilli <= 0 && request.refundableNowReason) return request.refundableNowReason;
  return `Balance now ${formatMoney(request.refundableNowMilli)}`;
}

export type PayoutConfirmation = {
  title: string;
  body: string;
  /** What was asked: the balance when the reporter asked. */
  askedMilli: number;
  /** The reporter's balance now - the most that may be recorded (owner decision R2). */
  balanceMilli: number;
  /** What the amount box starts at: the smaller of what was asked and the balance now. */
  prefillMilli: number;
  /** Set when nothing may be recorded now; the confirm button stays off and this says why. */
  blocked: string | null;
};

/**
 * What Record payout says before anything is recorded. The administrator pays
 * the reporter OUTSIDE the app first; this records what they actually sent -
 * prefilled with the smaller of what was asked and the balance now, and
 * anything up to the balance then, more than was asked included (earnings
 * since asking count). Above the balance, an account no longer a reporter or
 * one deleted since is refused by the server and moves nothing.
 */
export function describePayoutConfirmation(request: AdminRefundRequest): PayoutConfirmation {
  const who = whoAsked(request);
  const balanceMilli = Math.max(0, request.refundableNowMilli ?? request.amountMilli);
  const prefillMilli = Math.min(request.amountMilli, balanceMilli);
  const blocked =
    balanceMilli <= 0
      ? `${request.refundableNowReason || 'There is nothing on their balance to pay out.'} Decline the request instead.`
      : null;
  return {
    title: `Record a payout to ${who}?`,
    body:
      `They asked to be paid out ${formatMoney(request.amountMilli)} of earnings; their balance now is ` +
      `${formatMoney(balanceMilli)}. Pay them outside the app first, then record here what you actually sent ` +
      'and how - anything up to their balance. It comes off the balance as one payout in their history, the ' +
      'request turns Paid out in the same step, and they are told.',
    askedMilli: request.amountMilli,
    balanceMilli,
    prefillMilli,
    blocked,
  };
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

  if (route === 'payout') {
    // Never described as a refund: the queue draws Record payout's own form
    // from describePayoutConfirmation, and this answers alike if asked.
    const payout = describePayoutConfirmation(request);
    return { title: payout.title, body: payout.body, byHand: false, amountMilli: payout.prefillMilli, blocked: payout.blocked };
  }
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
      `The amount sent back must be whole cents, more than $0 and no more than the ` +
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
 * its account gone, a payout's account no longer a reporter
 * (`not-a-reporter`), a request a newer build wrote (`unrecognised`) - so the
 * queue reads its list again behind the error. Not `paid-by-hand-required`,
 * which is the dialog asking for the by-hand confirmation, nor `bad-amount`,
 * a reason or note refusal, or a payout above the balance
 * (`insufficient-balance`, which names the balance now and leaves the dialog
 * open to record less), which are about what was typed.
 */
export function isStaleRefundRefusal(code: string | undefined): boolean {
  return (
    code === 'request-final' ||
    code === 'not-found' ||
    code === 'not-refundable' ||
    code === 'nothing-unspent' ||
    code === 'account-missing' ||
    code === 'refunding' ||
    code === 'refund-unconfirmed' ||
    code === 'not-a-reporter' ||
    code === 'unrecognised'
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
 * back by hand can fall short. A payout says what was recorded as paid.
 * Nothing moved is said as plainly as something did.
 */
export function describeRefundMade(
  request: AdminRefundRequest,
  outcome: RefundMoved | null,
  changed: boolean
): string {
  const payout = request.kind === 'payout';
  if (!outcome) {
    return payout
      ? `${request.reference} was already paid out - nothing more was recorded.`
      : `${request.reference} was already refunded - nothing more was moved.`;
  }
  const money = formatMoney(outcome.refundedMilli);
  if (payout) {
    return changed
      ? `${request.reference} paid out: ${money} recorded as paid to ${whoAsked(request)} and taken off their ` +
          'balance. They have been told.'
      : `${money} was recorded for ${request.reference}, but the request had been decided elsewhere meanwhile.`;
  }
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
