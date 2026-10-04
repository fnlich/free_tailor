'use client';

import { Pill, type PillTone } from '@/components/ui/kit';
import type { OrderCounts, OrderState } from '@/lib/orders';
import styles from './OrderProgress.module.css';

/**
 * "122 of 300", with a bar.
 *
 * Counts settled work rather than successful work, so a run with failures still
 * reaches the end of the bar instead of stalling at 98% for ever - the question
 * it answers is "is it finished", not "did it all work". The failures get their
 * own colour in the same bar, and their own line underneath, because hiding
 * them would make the bar a lie in the other direction.
 */

/** The kit's pill colours, so an order's state reads like a payment's on /credits. */
const STATE_TONES: Record<OrderState, PillTone> = {
  running: 'sky',
  done: 'green',
  failed: 'red',
  cancelled: 'amber',
  expired: 'grey',
};

const STATE_LABELS: Record<OrderState, string> = {
  running: 'In progress',
  done: 'Ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
  expired: 'Files deleted',
};

export function OrderStatePill({ state }: { state: OrderState }) {
  return <Pill tone={STATE_TONES[state]}>{STATE_LABELS[state]}</Pill>;
}

function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(100, Math.max(0, (part / whole) * 100));
}

export default function OrderProgress({
  counts,
  className = '',
}: {
  counts: OrderCounts;
  className?: string;
}) {
  const donePercent = percent(counts.done, counts.total);
  // Stacked after the successes rather than drawn over them, so the two
  // together are exactly the settled share and the gap is exactly what is left.
  const stoppedPercent = percent(counts.failed + counts.cancelled, counts.total);

  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-4 text-sm">
        <span className="font-semibold tabular-nums text-ink">
          {counts.settled} of {counts.total}
        </span>
        {counts.running > 0 && (
          <span className="text-xs text-subtle">
            {counts.running} building now
          </span>
        )}
      </div>
      <div
        className={`mt-2 ${styles.track}`}
        role="progressbar"
        aria-valuenow={counts.settled}
        aria-valuemin={0}
        aria-valuemax={counts.total}
      >
        <div className={styles.done} style={{ width: `${donePercent}%` }} />
        <div className={styles.stopped} style={{ width: `${stoppedPercent}%` }} />
      </div>
      {(counts.failed > 0 || counts.cancelled > 0) && (
        <p className="mt-1.5 text-xs text-subtle">
          {counts.failed > 0 && `${counts.failed} failed`}
          {counts.failed > 0 && counts.cancelled > 0 && ', '}
          {counts.cancelled > 0 && `${counts.cancelled} cancelled`}
        </p>
      )}
    </div>
  );
}
