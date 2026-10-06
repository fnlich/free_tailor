import type { Payment, RefundOutcome } from './payments';
import { formatLegacyUnitPrice, formatMoney } from './format';

/**
 * How a payment reads: on the order tables, the return page, the invoice and
 * the administrator's list.
 *
 * Its own module, apart from lib/payments.ts, because these are decisions with
 * no request in them and backend/test/frontendMoney.test.js loads them - which
 * it can only do for a module whose one runtime import is lib/format.ts.
 *
 * Two kinds of payment exist and each reads in its own unit:
 *
 *  - **Since credits became dollars**, a payment credits exactly what it
 *    charges: $25.000 paid is $25.000 of credit, with nothing taken out.
 *  - **Before**, it bought a COUNT of credits at a price per credit, possibly
 *    less a crypto fee - "200 Credits at $0.50 each" - and those credits were
 *    reset to $0.000 with every balance. Its receipt still says what was sold,
 *    in credits, and never converts them into dollars at some rate, which
 *    would put a figure on it that the account never held.
 */

/**
 * True for a payment that bought credits before they became dollars, and
 * credited them then.
 *
 * Not simply "carries `legacyCredits`": a checkout opened before the switch
 * and paid after it carries them too, but it was credited its charge in
 * dollars (the switch stamped `creditMilli` on it) - and its receipt has to
 * say what the account actually received.
 */
export function isLegacyPurchase(payment: Payment): boolean {
  return payment.legacyCredits !== null && payment.creditMilli === 0 && payment.creditedMilli === 0;
}

function credits(count: number): string {
  return `${count} ${count === 1 ? 'credit' : 'credits'}`;
}

/** What a legacy payment's ledger received: `creditsGranted`, or `credits` on a row from before that column. */
function legacyNet(payment: Payment): number {
  const legacy = payment.legacyCredits!;
  return legacy.creditsGranted || legacy.credits;
}

/** What the payment was FOR: `$25.000`, or `200 credits` for one from before dollars. */
export function describePurchaseCredit(payment: Payment): string {
  if (isLegacyPurchase(payment)) return credits(payment.legacyCredits!.credits);
  return formatMoney(payment.creditMilli || payment.amountMilli);
}

/**
 * What the balance actually received, for a payment that has settled:
 * `$25.000`, or `197 credits` (a crypto fee came out of those).
 */
export function describeCreditReceived(payment: Payment): string {
  if (isLegacyPurchase(payment)) return credits(legacyNet(payment));
  return formatMoney(payment.creditedMilli);
}

/** The return page's one-line description: `$25.000 of credit.` or `200 credits for $100.000.` */
export function describePurchase(payment: Payment): string {
  if (isLegacyPurchase(payment)) {
    return `${credits(payment.legacyCredits!.credits)} for ${formatMoney(payment.amountMilli)}.`;
  }
  return `${formatMoney(payment.creditMilli || payment.amountMilli)} of credit.`;
}

export type InvoiceView = {
  /** The rows under "Description / Amount Due". They add up to the total, less any fee. */
  lines: Array<{ description: string; amountMilli: number }>;
  /**
   * The fee taken, which with the lines makes the total. Only ever non-zero on
   * a crypto payment from before dollars: a payment since credits its whole
   * charge, so no part of it was a fee - even a checkout opened before the
   * switch whose row still records the fee it was quoted.
   */
  feeMilli: number;
  /** The last figure: what the balance received, in the payment's own unit. */
  net: string;
  /** For a refunded payment, the money it returned (`refundedMoneyMilli`); 0 for any other. */
  amountRefundedMilli: number;
  /** For a refunded payment, what came back off the balance - and why not all of it. */
  reversal: string;
};

/**
 * The money a refunded payment RETURNED: the whole charge from the payments
 * list's Refund, but only the unspent part, in whole cents, from a refund
 * request - and whatever an administrator sent by hand for crypto. The server
 * sends it as `refundAmountMilli` and already reads an older refunded row as
 * its whole charge; the fallback here only keeps a row without the field from
 * reading as $0.000 refunded.
 */
export function refundedMoneyMilli(payment: Payment): number {
  if (payment.state !== 'refunded') return 0;
  return payment.refundAmountMilli > 0 ? payment.refundAmountMilli : payment.amountMilli;
}

/**
 * True when a refund returned only part of the charge - which changes why it
 * reversed less credit than the payment put on the balance.
 *
 * A refund of the whole charge reverses all the balance can cover, so what it
 * could not was spent. A PARTIAL one returns only part of the charge and
 * reverses what it returned - and the rest is not all spent: a refund request
 * gives back the unspent part in whole cents, so a fraction of a cent stays on
 * the balance, and a by-hand crypto refund returns whatever was sent. The
 * payment alone cannot tell spent from kept, so it says both rather than call
 * a balance that is still there spent.
 */
function isPartialRefund(payment: Payment): boolean {
  return refundedMoneyMilli(payment) < payment.amountMilli;
}

/**
 * What an invoice says about a settled payment.
 *
 * A payment since dollars is one line, the credit it bought, at its charge. One
 * from before keeps its original line - "200 Credits at $0.50 each" - with
 * whatever the old pricing lost to rounding as a row of its own, so the rows
 * still add up to the total rather than leaving a few cents unexplained.
 */
export function describeInvoice(payment: Payment): InvoiceView {
  if (isLegacyPurchase(payment)) {
    const legacy = payment.legacyCredits!;
    const net = legacyNet(payment);
    const lineMilli = legacy.credits * legacy.unitPriceMilli;
    const roundingMilli = payment.amountMilli - payment.feeMilli - lineMilli;
    const lines = [
      {
        description: `${legacy.credits} Credits at ${formatLegacyUnitPrice(legacy.unitPriceMilli)} each`,
        amountMilli: lineMilli,
      },
    ];
    if (roundingMilli > 0) lines.push({ description: 'Rounding (less than one credit)', amountMilli: roundingMilli });
    const kept = net - legacy.refundedCredits;
    return {
      lines,
      feeMilli: payment.feeMilli,
      net: credits(net),
      amountRefundedMilli: refundedMoneyMilli(payment),
      /*
       * "spent, or reset": a payment from before dollars that is refunded now
       * reverses nothing, because its credits went with the reset - and one
       * refunded before then reversed what had not been spent. The receipt
       * cannot tell which, so it says both rather than guess.
       */
      reversal:
        `Credits reversed: ${legacy.refundedCredits} of ${net}` +
        (kept > 0 ? ` - the other ${kept} had already been spent, or were reset when credits became dollars.` : '.'),
    };
  }

  const credited = payment.creditedMilli || payment.creditMilli;
  const kept = credited - payment.refundedMilli;
  return {
    lines: [{ description: `${formatMoney(credited)} of Tailor credit`, amountMilli: payment.amountMilli }],
    feeMilli: 0,
    net: formatMoney(credited),
    amountRefundedMilli: refundedMoneyMilli(payment),
    reversal:
      `Credit reversed: ${formatMoney(payment.refundedMilli)} of ${formatMoney(credited)}` +
      (kept > 0
        ? ` - the other ${formatMoney(kept)} ` +
          (isPartialRefund(payment)
            ? 'was not reversed: it had been spent, or is still on the balance.'
            : 'had already been spent.')
        : '.'),
  };
}

/**
 * Under a refunded row on Admin -> Payments: how much came back off the
 * balance, and how much could not, in the payment's own unit.
 */
export function describeRefundedNote(payment: Payment): string {
  if (isLegacyPurchase(payment)) {
    const legacy = payment.legacyCredits!;
    const net = legacyNet(payment);
    return (
      `${legacy.refundedCredits} of ${credits(net)} reversed` +
      (legacy.refundedCredits < net
        ? ` - the other ${net - legacy.refundedCredits} had been spent, or were reset when credits became dollars.`
        : '.')
    );
  }
  const shortfall = payment.creditedMilli - payment.refundedMilli;
  const returned = refundedMoneyMilli(payment);
  return (
    `${formatMoney(payment.refundedMilli)} of ${formatMoney(payment.creditedMilli)} reversed` +
    // A partial refund names the money it returned: the row's Amount column
    // shows the whole charge.
    (isPartialRefund(payment) ? `, ${formatMoney(returned)} returned` : '') +
    (shortfall > 0
      ? ` - the other ${formatMoney(shortfall)} ` +
        (isPartialRefund(payment) ? 'was not reversed: spent, or still on the balance.' : 'had been spent.')
      : '.')
  );
}

/**
 * What an administrator is told after pressing Refund: all three figures,
 * always. A refund that reversed $12.400 of $50.000 is not a success worth
 * reporting as a bare "done" - whoever pressed the button deserves to know
 * before the customer writes in.
 */
export function describeRefundOutcome(reference: string, outcome: RefundOutcome): string {
  if (outcome.creditedMilli === 0) {
    // A payment from before dollars: its credits went with the reset, so the
    // money went back and nothing on the balance was its to take.
    return (
      `${reference} refunded. It was bought before credits became dollars and its credits were reset ` +
      'then, so there was nothing on the balance to reverse.'
    );
  }
  if (outcome.shortfallMilli > 0) {
    return (
      `${reference} refunded in full. Only ${formatMoney(outcome.reversedMilli)} of ` +
      `${formatMoney(outcome.creditedMilli)} could be reversed - the other ` +
      `${formatMoney(outcome.shortfallMilli)} had already been spent.`
    );
  }
  return `${reference} refunded, and all ${formatMoney(outcome.reversedMilli)} of credit reversed.`;
}
