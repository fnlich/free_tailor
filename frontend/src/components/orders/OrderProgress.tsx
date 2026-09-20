'use client';

import type { OrderCounts, OrderState } from '@/lib/orders';

/**
 * "122 of 300", with a bar.
 *
 * Counts settled work rather than successful work, so a run with failures still
 * reaches the end of the bar instead of stalling at 98% for ever - the question
 * it answers is "is it finished", not "did it all work". The failures get their
 * own colour in the same bar, and their own line underneath, because hiding
 * them would make the bar a lie in the other direction.
 */

const STATE_STYLES: Record<OrderState, string> = {
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200',
  done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200',
  failed: 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200',
  cancelled: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200',
  expired: 'bg-gray-200 text-gray-700 dark:bg-slate-700 dark:text-slate-200',
};

const STATE_LABELS: Record<OrderState, string> = {
  running: 'In progress',
  done: 'Ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
  expired: 'Files deleted',
};

export function OrderStatePill({ state }: { state: OrderState }) {
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATE_STYLES[state]}`}>
      {STATE_LABELS[state]}
    </span>
  );
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
        <span className="font-semibold text-gray-900 dark:text-white">
          {counts.settled} of {counts.total}
        </span>
        {counts.running > 0 && (
          <span className="text-xs text-gray-500 dark:text-slate-400">
            {counts.running} building now
          </span>
        )}
      </div>
      <div
        className="mt-2 flex h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-slate-700"
        role="progressbar"
        aria-valuenow={counts.settled}
        aria-valuemin={0}
        aria-valuemax={counts.total}
      >
        <div
          className="h-full bg-emerald-500 transition-[width] duration-300 ease-out"
          style={{ width: `${donePercent}%` }}
        />
        <div
          className="h-full bg-red-400 transition-[width] duration-300 ease-out"
          style={{ width: `${stoppedPercent}%` }}
        />
      </div>
      {(counts.failed > 0 || counts.cancelled > 0) && (
        <p className="mt-1.5 text-xs text-gray-500 dark:text-slate-400">
          {counts.failed > 0 && `${counts.failed} failed`}
          {counts.failed > 0 && counts.cancelled > 0 && ', '}
          {counts.cancelled > 0 && `${counts.cancelled} cancelled`}
        </p>
      )}
    </div>
  );
}
