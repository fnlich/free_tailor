'use client';

import { describeLedgerReason, formatDelta, type LedgerEntry } from '@/lib/credits';

/**
 * Where a balance came from.
 *
 * Newest first, and sorted on `seq` rather than the timestamp: two movements
 * written in the same millisecond tie on `createdAt`, and a history whose order
 * is ambiguous is not a history.
 */

function formatWhen(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

export default function CreditLedger({ entries }: { entries: LedgerEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="text-sm text-gray-600 dark:text-slate-300">
        Nothing has moved yet. Every credit added, spent or given back will be listed here.
      </p>
    );
  }

  // A copy: sorting the prop in place would mutate the caller's array.
  const ordered = [...entries].sort((left, right) => right.seq - left.seq);

  return (
    <ul className="divide-y divide-gray-200 dark:divide-slate-800">
      {ordered.map((entry) => (
        <li key={entry.id} className="flex items-start justify-between gap-4 py-3">
          <div className="min-w-0">
            <p className="text-sm text-gray-900 dark:text-white">{describeLedgerReason(entry)}</p>
            {entry.note && (
              <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-slate-400">{entry.note}</p>
            )}
            <p className="mt-0.5 text-xs text-gray-400 dark:text-slate-500">
              {formatWhen(entry.createdAt)}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p
              className={`text-sm font-semibold ${
                entry.delta > 0
                  ? 'text-green-700 dark:text-green-300'
                  : 'text-red-700 dark:text-red-300'
              }`}
            >
              {formatDelta(entry.delta)}
            </p>
            <p className="text-xs text-gray-500 dark:text-slate-400">{entry.balanceAfter} after</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
