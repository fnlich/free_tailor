'use client';

export type GenerationProgressState = {
  total: number;
  completed: number;
  /**
   * How many resumes are in a browser RIGHT NOW.
   *
   * Absent before the server owned the queue, because the answer was always one:
   * the page generated them itself, one request at a time. Now three browsers
   * build three resumes at once, and a bar that still said "Resume 4 of 30"
   * would be describing a machine that no longer exists - and hiding the one
   * thing worth seeing, which is that the browsers are all busy.
   */
  running?: number;
  /** How many are still waiting for a browser. */
  queued?: number;
  phase: string;
  currentProfileName?: string;
  currentCompanyName?: string;
  currentJobTitle?: string;
  currentJobNumber?: number;
  importedJobCount?: number;
};

type GenerationProgressProps = {
  progress: GenerationProgressState;
  className?: string;
};

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function pluralizeJob(count: number): string {
  return count === 1 ? 'job' : 'jobs';
}

export default function GenerationProgress({ progress, className = '' }: GenerationProgressProps) {
  const activeIndex = progress.currentProfileName || progress.currentCompanyName
    ? Math.min(progress.completed + 1, progress.total)
    : Math.min(progress.completed, progress.total);
  const displayedPercent = progress.total > 0
    ? clampPercentage(((progress.completed + (activeIndex > progress.completed ? 0.45 : 0)) / progress.total) * 100)
    : 0;
  const completedLabel = `${Math.min(progress.completed, progress.total)} / ${progress.total}`;
  const isSheetsImport = typeof progress.importedJobCount === 'number';
  const running = progress.running ?? 0;
  // "5 running" only once there is more than one. On a single resume it is noise
  // that says the same thing as the phase above it.
  const runningLabel = running > 1 ? `${running} running` : '';
  const jobDetails = [progress.currentCompanyName, progress.currentJobTitle].filter(Boolean).join(' - ');
  const jobDetailsSuffix = jobDetails ? ` - ${jobDetails}` : '';
  const sheetsStatus = (() => {
    if (!isSheetsImport) return '';

    const importedJobCount = progress.importedJobCount ?? 0;
    if (progress.phase.toLowerCase().includes('analyz')) {
      const currentJobNumber = Math.min(progress.currentJobNumber ?? 1, importedJobCount || 1);
      return `Imported ${importedJobCount} ${pluralizeJob(importedJobCount)}, now analyzing job ${currentJobNumber} of ${importedJobCount}${jobDetailsSuffix}`;
    }

    if (running > 1) {
      return (
        `Imported ${importedJobCount} ${pluralizeJob(importedJobCount)}, ` +
        `building ${running} at once - ${progress.completed} of ${progress.total} done` +
        (progress.queued ? `, ${progress.queued} waiting` : '')
      );
    }

    if (activeIndex > 0) {
      return `Imported ${importedJobCount} ${pluralizeJob(importedJobCount)}, now building resume ${activeIndex} of ${progress.total}${jobDetailsSuffix}`;
    }

    return `Imported ${importedJobCount} ${pluralizeJob(importedJobCount)}, preparing resume generation`;
  })();

  return (
    <div className={`rounded-xl border border-blue-200 bg-blue-50/80 px-4 py-4 ${className}`.trim()}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-blue-900">{progress.phase}</div>
          <div className="mt-1 text-sm text-blue-800">
            {isSheetsImport
              ? sheetsStatus
              : runningLabel
                ? `${runningLabel}, ${progress.completed} of ${progress.total} done`
                : activeIndex > 0
                  ? `Resume ${activeIndex} of ${progress.total}`
                  : `Preparing ${progress.total} resume(s)`}
          </div>
          {!isSheetsImport && (
            <div className="mt-1 text-sm text-blue-700">
              {progress.currentProfileName
                ? `Building ${progress.currentProfileName}${progress.currentCompanyName ? ` for ${progress.currentCompanyName}` : ''}`
                : 'Preparing generation queue'}
            </div>
          )}
          {progress.queued ? (
            <div className="mt-1 text-xs text-blue-700">
              {progress.queued} waiting for a browser
            </div>
          ) : null}
        </div>
        <div className="shrink-0 text-sm font-medium text-blue-900">{completedLabel}</div>
      </div>

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-blue-100">
        <div
          className="h-full rounded-full bg-blue-600 transition-[width] duration-300 ease-out"
          style={{ width: `${displayedPercent}%` }}
        />
      </div>
    </div>
  );
}
