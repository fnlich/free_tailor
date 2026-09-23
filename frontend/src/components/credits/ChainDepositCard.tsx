'use client';

import { useCallback, useEffect, useState } from 'react';
import { CoinMark } from '@/components/icons/marks';
import { IconCheck, IconCopy } from '@/components/icons';
import { LABEL, PANEL } from './chrome';
import type { ChainInvoiceView } from '@/lib/payments';

/**
 * Where to send coin, how much, and how long the figure stands.
 *
 * Its own component because it has to appear in TWO places, and for a while it
 * only appeared in one. It lived inside the purchase dialog, so closing that
 * dialog lost the address and the exact amount - and the exact amount is the
 * whole matching scheme, since every buyer sends to the same address. A buyer
 * who closed the modal before paying had no way back to the figure, and
 * sending anything else is the path where money arrives and cannot be
 * attributed. It now renders on the payment's own page as well, which every
 * pending row already links to.
 *
 * One copy of the wording rather than two, deliberately: the sentence about
 * why the amount must be exact is the most important text in the crypto flow,
 * and two copies of it would drift.
 *
 * **Every figure here came from the server.** The amount is not a price
 * converted in the browser; it is the exact quantity the server quoted at the
 * rate it recorded, rounded onto that asset's own lattice. A number worked out
 * here would be a number no invoice matches.
 */

function useCountdown(expiresAt: string): { label: string; expired: boolean } {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const remaining = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return { label: '0:00', expired: true };
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  return { label: `${minutes}:${String(seconds).padStart(2, '0')}`, expired: false };
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
      } catch {
        /*
         * Clipboard access is refused more often than people expect - an
         * insecure origin, a permissions policy, an older browser. Saying
         * nothing is fine here ONLY because the value is on screen and
         * selectable: the copy button is a convenience, not the way to get it.
         */
      }
    })();
  }, [value]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy the ${label}`}
      className="tl-icon-button shrink-0 border border-line"
    >
      {copied ? <IconCheck className="h-4 w-4" /> : <IconCopy className="h-4 w-4" />}
    </button>
  );
}

function Field({
  caption,
  value,
  mono,
  hint,
}: {
  caption: string;
  value: string;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className={LABEL}>{caption}</div>
      <div className={`mt-1 break-all text-sm font-medium text-ink ${mono ? 'font-mono' : ''}`}>
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-subtle">{hint}</div>}
    </div>
  );
}

export default function ChainDepositCard({
  invoice,
  reference,
}: {
  invoice: ChainInvoiceView;
  /** The order this belongs to, so a buyer can quote it. */
  reference: string;
}) {
  const countdown = useCountdown(invoice.expiresAt);
  const done = invoice.state === 'credited' || invoice.state === 'held';

  return (
    <div className={PANEL}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <CoinMark assetId={invoice.asset} symbol={invoice.symbol} className="h-7 w-7" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">{invoice.assetLabel}</p>
            <p className="text-xs text-subtle">
              Order <span className="font-mono">{reference}</span>
            </p>
          </div>
        </div>
        {!done && (
          <div className="shrink-0 text-right">
            <div className={LABEL}>Expires in</div>
            <div
              className={`text-lg font-semibold tabular-nums ${
                countdown.expired ? 'text-red-700' : 'text-ink'
              }`}
            >
              {countdown.label}
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 flex items-start gap-2 border-t border-line pt-4">
        <Field
          caption="Send exactly"
          value={`${invoice.amount} ${invoice.symbol}`}
          mono
          hint={`On ${invoice.chainLabel}, and no other network.`}
        />
        <CopyButton value={invoice.amount} label="amount" />
      </div>

      <div className="mt-4 flex items-start gap-2 border-t border-line pt-4">
        <Field caption={`${invoice.chainLabel} address`} value={invoice.address} mono />
        <CopyButton value={invoice.address} label="address" />
      </div>
    </div>
  );
}

/** The one sentence that explains why the figure above cannot be rounded. */
export function ExactAmountNote() {
  return (
    <p className="text-xs text-subtle">
      Send the exact amount above. It is how this payment is recognised, because every buyer sends
      to the same address — so an amount that has been rounded by a wallet, or reduced by a
      withdrawal fee, has to be matched by hand.
    </p>
  );
}
