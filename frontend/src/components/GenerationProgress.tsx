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
    // A bordered card in the kit's colours: ink for what is happening, muted for
    // the detail, and the accent for the bar - the same blue as the button that
    // started it. Tokens and kit classes only, so it reads the same in both
    // themes without a `dark:` variant the html.dark shim would override.
    <div className={`tl-card px-4 py-4 ${className}`.trim()}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="tl-spinner mt-0.5 shrink-0" aria-hidden />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink">{progress.phase}</div>
            <div className="mt-1 text-sm text-muted">
              {isSheetsImport
                ? sheetsStatus
                : runningLabel
                  ? `${runningLabel}, ${progress.completed} of ${progress.total} done`
                  : activeIndex > 0
                    ? `Resume ${activeIndex} of ${progress.total}`
                    : `Preparing ${progress.total} resume(s)`}
            </div>
            {!isSheetsImport && (
              <div className="mt-1 text-sm text-muted">
                {progress.currentProfileName
                  ? `Building ${progress.currentProfileName}${progress.currentCompanyName ? ` for ${progress.currentCompanyName}` : ''}`
                  : 'Preparing generation queue'}
              </div>
            )}
            {progress.queued ? (
              <div className="mt-1 text-xs text-subtle">
                {progress.queued} waiting for a browser
              </div>
            ) : null}
          </div>
        </div>
        <div className="shrink-0 text-sm font-semibold tabular-nums text-ink">{completedLabel}</div>
      </div>

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-muted">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
          style={{ width: `${displayedPercent}%` }}
        />
      </div>
    </div>
  );
}
