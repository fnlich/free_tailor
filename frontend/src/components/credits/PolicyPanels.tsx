/**
 * What a buyer is told before they pay.
 *
 * The design this flow follows puts two coloured panels under the order
 * summary, and they are kept - a purchase is the one place in the app where
 * somebody parts with money, and the terms belong on the screen where they do
 * it rather than on a page nobody opens.
 *
 * The wording is this app's own, and the rule it follows is worth stating,
 * because it is easy to break: **every line here is something the server
 * actually does.** The product this design comes from lists three card
 * prefixes it will not accept, which is its own fraud history and not ours -
 * hardcoding them would turn away real customers for a reason nobody here
 * could explain. A panel that announces a rule nothing enforces is worse than
 * no panel, so the rules that CAN be enforced (requiring 3-D Secure, and a BIN
 * blocklist) are becoming administrator settings that start empty, and this
 * copy will grow a line each only when a setting is actually set.
 *
 * Every claim below is checkable in the code:
 *   - credit is per account: `credit_ledger` rows carry a user id and there
 *     is no transfer path anywhere in the app;
 *   - a credit is a dollar and a purchase credits exactly what it charges:
 *     `quotePurchase` sets `creditMilli` to the amount, and there is no fee
 *     and no price per credit left to apply;
 *   - a resume costs its model's price, and a preview nothing: the price is
 *     the model's `pricePerResumeMilli`, reserved when a build is submitted,
 *     and the builder's cost line is the server's own quote of that same sum;
 *   - only a signed webhook credits: `routes/paymentWebhooks.ts`;
 *   - a refund reverses what credit is left and reports the shortfall:
 *     `refundPayment` measures the balance either side and clamps at zero;
 *   - crypto is not refundable automatically: the same function says so and
 *     answers 409.
 *
 * Crypto briefly had two sets of lines, because the on-chain path asked the
 * buyer to send an exact amount to an address and this one does not. That path
 * is gone; what is left is the hosted set, which is the only one that was ever
 * true of a provider whose page quotes and matches on its own.
 */

/**
 * One panel, as the kit's notice, which states both themes itself. The
 * refunds panel is a warning in amber: it used to be red only because amber
 * had no rule in the dark-mode shim, and `.tl-notice` has one.
 */
function Panel({
  tone,
  title,
  points,
}: {
  tone: 'info' | 'warn';
  title: string;
  points: string[];
}) {
  return (
    <div className="tl-notice" data-tone={tone}>
      <p className="font-semibold">{title}</p>
      <ul className="mt-2 space-y-1.5 text-xs leading-relaxed">
        {points.map((point) => (
          <li key={point} className="flex gap-2">
            <span aria-hidden>&bull;</span>
            <span>{point}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function PolicyPanels({ method }: { method: 'card' | 'crypto' }) {
  return (
    <div className="space-y-3">
      <Panel
        tone="info"
        title="Before you pay"
        points={[
          'Credit is added to this account. There is no way to move it to another account, so check you are signed in as the person who should have it.',
          'A credit is a dollar. You are charged exactly the amount you choose, and all of it is added to your balance.',
          'Each resume costs the price set for the model it is built with, to a tenth of a cent, and the builder shows what a run will cost before you start it. Previews are free and unlimited, so you can see the result before you spend anything.',
          'Credit arrives when the payment is confirmed by the provider, not when this page says so. That is usually within a minute.',
        ]}
      />
      <Panel
        tone="warn"
        title={method === 'card' ? 'Refunds' : 'Refunds, and paying on the next page'}
        points={
          method === 'card'
            ? [
                'An administrator can refund a card payment. Refunding reverses the credit that is still unspent; credit already spent cannot be taken back, and the difference is reported rather than quietly ignored.',
                'This server never sees your card number. The card form is served by the payment provider and your details go straight to them.',
              ]
            : [
                'A crypto payment cannot be refunded automatically - coin can only be sent back by hand, by an administrator.',
                'You pay on the payment provider\u2019s own page, not this one. The coin, the network and the amount of it to send are all chosen and shown there, at their rates; the dollar amount you chose here is what is added to your balance.',
                'Credit is added when the provider confirms the payment, which for crypto can take several minutes. This order stays open until they do, and you can close this window without losing it.',
              ]
        }
      />
    </div>
  );
}
