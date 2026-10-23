'use client';

import Link from 'next/link';

import { describeRunCost, formatMoney } from '@/lib/format';
import type { GenerationQuote } from '@/lib/generationQueue';

/**
 * A 402 from a run, as the sentence the page shows for it ("This run needs
 * $0.161, and your balance is $0.05.").
 */
export type CreditShortfall = { message: string };

/**
 * What a run will cost, beside the button that starts it: "This run: 7
 * resumes × $0.023 = $0.161 · balance $3.977", from POST /generation/quote,
 * which reserves nothing - the price is the build mode's, per resume. A balance short of it turns it red with Buy
 * credits; an administrator is told they are not charged.
 *
 * A refused run's shortfall takes its place, with the way to fix it - inside
 * the preview dialogs too, which cover the page's own error area.
 */
export default function CostLine({
  quote,
  shortfall = null,
  label = 'This run',
  pricing = false,
}: {
  quote: GenerationQuote | null;
  /** Passed only where the page's own notice is hidden: inside a dialog. */
  shortfall?: CreditShortfall | null;
  /** What is being priced: "This run", or one sheet row when the row count is not known yet. */
  label?: string;
  /**
   * A run was pressed and its price is being asked for before the confirm
   * opens (components/SpendConfirm): said here, where the buttons beside it
   * cannot say it themselves.
   */
  pricing?: boolean;
}) {
  if (pricing) {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-muted" role="status">
        <span className="tl-spinner" aria-hidden />
        Checking the price...
      </span>
    );
  }
  if (shortfall) {
    return (
      <span className="tl-status" data-tone="error" role="alert">
        {shortfall.message}{' '}
        <Link href="/credits" className="tl-link">
          Buy credits
        </Link>
      </span>
    );
  }
  if (!quote) return null;
  if (quote.exempt) return <span className="text-sm text-muted">Administrators are not charged</span>;
  const short = quote.costMilli > quote.balanceMilli;
  return (
    <span
      className={short ? 'tl-status tabular-nums' : 'text-sm tabular-nums text-muted'}
      data-tone={short ? 'error' : undefined}
    >
      {/* "7 resumes × $0.023 = $0.161": the price, so the total can be checked by eye. */}
      {label}: {describeRunCost(quote)} · balance {formatMoney(quote.balanceMilli)}
      {short && (
        <>
          {' '}
          ·{' '}
          <Link href="/credits" className="tl-link">
            Buy credits
          </Link>
        </>
      )}
    </span>
  );
}
