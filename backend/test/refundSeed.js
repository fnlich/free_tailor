/**
 * Refund requests for a purchase or a resume, made the way the app made them
 * before asking was removed (owner decision R1).
 *
 * The app no longer creates such a request - only a reporter's payout is
 * asked for - but an install keeps every one made before, and an
 * administrator still decides them. So the tests that decide them seed them
 * here, through the same pieces the removed `createRefundRequest` used: the
 * server's own measure of the item (`resolveRefundItem`), the one-open-
 * request rule, and the repository's insert, in one IMMEDIATE transaction.
 * Refusals come back as the service's own `RefundRequestError`, with the
 * status and code it carried.
 *
 * `modules` is what the test loaded: `{ refunds, refundDb, sqlite }` -
 * services/refunds, database/refundRequestRepository and database/sqlite -
 * so the seed runs on the same instances (and database) as the test.
 */
function seedRefundRequest(modules, account, input) {
  const { refunds, refundDb, sqlite } = modules;
  const itemType = input.itemType;
  const itemId = typeof input.itemId === 'string' ? input.itemId.trim() : '';
  if (!refundDb.isRefundItemType(itemType) || !itemId || itemId.length > 200) {
    throw new refunds.RefundRequestError('Choose the purchase or resume to ask about.', 400, 'bad-item');
  }
  const reason = refunds.cleanReason(input.reason);
  if (!reason) throw new refunds.RefundRequestError('Say why you are asking for a refund.', 400, 'reason-required');
  if (reason.length > refunds.MAX_REFUND_REASON) {
    throw new refunds.RefundRequestError(`Keep the reason under ${refunds.MAX_REFUND_REASON} characters.`, 400, 'reason-too-long');
  }

  const db = sqlite.getDb();
  return db
    .transaction(() => {
      const item = refunds.resolveRefundItem(itemType, itemId, account.id);
      const open = refundDb.findOpenRequestForItem(item.itemKey);
      if (open) {
        throw new refunds.RefundRequestError('A refund request for this is already open.', 409, 'request-open', {
          requestId: open.id,
        });
      }
      if (item.unavailable) {
        throw new refunds.RefundRequestError(item.unavailable.message, 409, 'not-refundable', { why: item.unavailable.code });
      }
      const request = refundDb.insertRefundRequest({
        accountId: account.id,
        kind: item.kind,
        itemType: item.itemType,
        itemId: item.itemId,
        ...(item.paymentId ? { paymentId: item.paymentId } : {}),
        ...(item.orderItemId ? { orderItemId: item.orderItemId } : {}),
        ...(item.taskId ? { taskId: item.taskId } : {}),
        ...(item.reservationId ? { reservationId: item.reservationId } : {}),
        label: item.label,
        amountMilli: item.refundableMilli,
        reason,
      });
      return refunds.toRefundRequestView(request);
    })
    .immediate();
}

module.exports = { seedRefundRequest };
