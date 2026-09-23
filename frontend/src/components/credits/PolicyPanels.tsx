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
 *   - credits are per account: `credit_ledger` rows carry a user id and there
 *     is no transfer path anywhere in the app;
 *   - a preview costs nothing: `CREDITS_PER_RESUME` is charged on a build;
 *   - only a signed webhook credits: `routes/paymentWebhooks.ts`;
 *   - a refund reverses what is left and reports the shortfall:
 *     `refundPayment` measures the balance either side and clamps at zero;
 *   - crypto is not refundable automatically: the same function says so and
 *     answers 409.
 *
 * The same rule is why crypto has TWO sets of lines rather than one. Sending an
 * exact amount to an address, and having a payment that missed it held for a
 * person to look at, are things the RETIRED on-chain path does; a hosted
 * provider quotes and matches on its own page and this server never sees an
 * address. Showing the on-chain sentences to a buyer about to leave for a
 * hosted page would be telling them to check a number they have not been given
 * yet, on a network they have not chosen yet - a rule nothing here enforces,
 * which is the exact failure this file's whole premise is against.
 */

const TONES = {
  info: {
    box: 'rounded-xl border border-blue-200 bg-blue-50 p-4',
    head: 'text-sm font-semibold text-blue-700',
    body: 'mt-2 space-y-1.5 text-xs leading-relaxed text-blue-700',
  },
  warn: {
    box: 'rounded-xl border border-red-200 bg-red-50 p-4',
    head: 'text-sm font-semibold text-red-700',
    body: 'mt-2 space-y-1.5 text-xs leading-relaxed text-red-700',
  },
} as const;

function Panel({
  tone,
  title,
  points,
}: {
  tone: keyof typeof TONES;
  title: string;
  points: string[];
}) {
  const style = TONES[tone];
  return (
    <div className={style.box}>
      <p className={style.head}>{title}</p>
      <ul className={style.body}>
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

export default function PolicyPanels({
  method,
  /**
   * The coin, when the buyer chose one HERE.
   *
   * Present only on the retired on-chain path: that is the one where this
   * server quotes an exact figure against an address it owns. A hosted
   * provider - Cryptomus, and Coinbase before it - asks on its own page, so
   * the target carries no asset and the exact-amount lines do not apply.
   */
  asset,
}: {
  method: 'card' | 'crypto';
  asset?: string;
}) {
  const ownWallet = method === 'crypto' && Boolean(asset);
  return (
    <div className="space-y-3">
      <Panel
        tone="info"
        title="Before you pay"
        points={[
          'Credits are added to this account. There is no way to move them to another account, so check you are signed in as the person who should have them.',
          'One credit builds one resume. Previews are free and unlimited, so you can see the result before you spend anything.',
          'Credits arrive when the payment is confirmed by the provider, not when this page says so. That is usually within a minute.',
        ]}
      />
      <Panel
        tone="warn"
        title={
          method === 'card'
            ? 'Refunds'
            : ownWallet
              ? 'Refunds, and getting the amount right'
              : 'Refunds, and paying on the next page'
        }
        points={
          method === 'card'
            ? [
                'An administrator can refund a card payment. Refunding reverses the credits that are still unspent; credits already spent cannot be taken back, and the difference is reported rather than quietly ignored.',
                'This server never sees your card number. The card form is served by the payment provider and your details go straight to them.',
              ]
            : ownWallet
              ? [
                  'A crypto payment cannot be refunded automatically - coin can only be sent back by hand, by an administrator. Check the amount and the network before you send anything.',
                  'Send the exact amount shown, on the network named. A payment on a different network cannot be recovered by anyone, including us.',
                  'If the amount differs from the one shown, we credit what arrived wherever we can safely tell which order it belongs to. Where we cannot, the payment is held and somebody contacts you - it is never silently credited and never written off.',
                ]
              : [
                  'A crypto payment cannot be refunded automatically - coin can only be sent back by hand, by an administrator.',
                  'You pay on the payment provider\u2019s own page, not this one. The coin, the network and the amount to send are all chosen and shown there, at their rates.',
                  'Credits are added when the provider confirms the payment, which for crypto can take several minutes. This order stays open until they do, and you can close this window without losing it.',
                ]
        }
      />
    </div>
  );
}
