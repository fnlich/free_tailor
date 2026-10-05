'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { ReporterOnly } from '@/components/auth/AuthGate';
import { IconExternal } from '@/components/icons';
import { Card, ErrorNotice, Notice, Page, PageHeader, Pill, Spinner } from '@/components/ui/kit';
import { useAuth } from '@/contexts/AuthContext';
import { ApiResponseError } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { reportApi, type ReportOverview, type ReportPreview, type ReportRun, type ReportTabs } from '@/lib/jobLake';
import {
  DEFAULT_MAX_RUN_ROWS,
  describeEarnedToday,
  describePreviewRow,
  describeReportPreview,
  describeReporterRate,
  describeRowReward,
  describeRunBreakdown,
  describeRunProgress,
  describeRunSummary,
  isRedOutcome,
  isRunLive,
  linkHost,
  notJobTabMessage,
  readReportRange,
  REPORT_FIRST_ROW,
  REPORT_POLL_MS,
  reportStatusLabel,
  reportStatusTone,
  runFraction,
  safeWebLink,
  sameRange,
  startBlocker,
} from '@/lib/jobLakeDisplay';
import styles from './page.module.css';

/**
 * Report Jobs: a reporter's home (owner decisions A3, J7).
 *
 * The reporter picks a tab of their OWN job sheet and a range of rows,
 * previews them - which rows hold a job, and which a run will skip because
 * their Lake Status says they were reported before - and presses "Add to job
 * lake". The run goes on in the server, in the background (POST
 * /api/report/runs answers 202 at once); this page follows it until the server
 * says it ended, then shows the owner's line - "N out of M was added, your
 * current credit is $X" - and every row's outcome, duplicates in red as the
 * run paints them in the sheet.
 *
 * Nothing here names a spreadsheet: every /api/report route acts on the
 * caller's own sheet, so the only choices are a tab and rows. An
 * administrator may open the page and report too, and is told they are never
 * paid for it (`overview.paid`).
 *
 * What the page decides with no React in it - the range a run is asked for,
 * the preview's notes, when Add to job lake may be pressed, how outcomes read
 * - is lib/jobLakeDisplay.ts, which backend/test/frontendJobLake.test.js runs
 * against the server's own rules.
 */

/** One figure at the top of the page: what a job pays, earned today, the balance, jobs in the lake. */
function Figure({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="tl-card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-subtle">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-ink">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** A link cell: a web address as its host, opening in a new tab; anything else as plain text. */
function JobLink({ value }: { value: string }) {
  const href = safeWebLink(value);
  if (!href) return value.trim() ? <span className="break-all text-subtle">{value}</span> : <span className="text-subtle">-</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="tl-link block truncate" title={href}>
      {linkHost(href)}
    </a>
  );
}

function RunBar({ run }: { run: ReportRun }) {
  const percent = Math.round(runFraction(run) * 100);
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium text-ink">{describeRunProgress(run)}</span>
        {run.progress.total > 0 && <span className="tabular-nums text-subtle">{percent}%</span>}
      </div>
      <div
        className={`mt-2 ${styles.track}`}
        role="progressbar"
        aria-label="Report run"
        aria-valuemin={0}
        aria-valuemax={run.progress.total}
        aria-valuenow={run.progress.done}
      >
        <div className={styles.fill} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

/** Every row of a run and what it came to; a duplicate is red, as it is in the sheet. */
function RunOutcomes({ run, paid }: { run: ReportRun; paid: boolean }) {
  if (run.rows.length === 0) return null;
  return (
    <div className="tl-table-box">
      <table className={`tl-table ${styles.outcomes}`}>
        <caption className="sr-only">What each row of the run came to</caption>
        <thead>
          <tr>
            <th scope="col">Row</th>
            <th scope="col">Company</th>
            <th scope="col">Job title</th>
            <th scope="col">Outcome</th>
            <th scope="col" data-align="right">
              Earned
            </th>
            <th scope="col">Note</th>
          </tr>
        </thead>
        <tbody>
          {run.rows.map((row) => (
            <tr key={row.row} data-duplicate={isRedOutcome(row) ? 'true' : undefined}>
              <td className="whitespace-nowrap">
                {/* A colour on a .tl-table cell goes on an inner span - the unlayered td rule beats a utility on the td. */}
                <span className="font-medium text-ink">{row.row}</span>
              </td>
              <td className="min-w-32">
                {row.company ? <span className="break-words">{row.company}</span> : <span className="text-subtle">-</span>}
              </td>
              <td className="min-w-32">
                {row.title ? <span className="break-words">{row.title}</span> : <span className="text-subtle">-</span>}
              </td>
              <td className="whitespace-nowrap">
                <Pill tone={reportStatusTone(row.status)}>{reportStatusLabel(row.status)}</Pill>
              </td>
              <td className="whitespace-nowrap tabular-nums" data-align="right">
                {describeRowReward(row, paid)}
              </td>
              <td className="min-w-48">
                {row.reason ? <span className="break-words text-sm text-muted">{row.reason}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PreviewTable({ preview }: { preview: ReportPreview }) {
  return (
    <div className="tl-table-box">
      <table className="tl-table">
        <caption className="sr-only">The rows in that range that hold a job</caption>
        <thead>
          <tr>
            <th scope="col">Row</th>
            <th scope="col">Company</th>
            <th scope="col">Job title</th>
            <th scope="col">Link</th>
            <th scope="col">Before the run</th>
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((row) => {
            const note = describePreviewRow(row);
            return (
              <tr key={row.row}>
                <td className="whitespace-nowrap">
                  <span className="font-medium text-ink">{row.row}</span>
                </td>
                <td className="min-w-32">
                  {row.company ? <span className="break-words">{row.company}</span> : <span className="text-subtle">-</span>}
                </td>
                <td className="min-w-32">
                  {row.title ? <span className="break-words">{row.title}</span> : <span className="text-subtle">-</span>}
                </td>
                <td className="max-w-56">
                  <JobLink value={row.link} />
                </td>
                <td className="min-w-40">
                  <Pill tone={note.tone}>{note.label}</Pill>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ReportJobsBody() {
  const { refresh: refreshAccount } = useAuth();

  const [overview, setOverview] = useState<ReportOverview | null>(null);
  // The failure itself, so <ErrorNotice> says it the reader's way (and adds
  // the operator's half for an administrator, which the server decides).
  const [overviewError, setOverviewError] = useState<unknown>(null);
  const [tabs, setTabs] = useState<ReportTabs | null>(null);
  const [tabsError, setTabsError] = useState<unknown>(null);

  const [tabName, setTabName] = useState('');
  const [fromRow, setFromRow] = useState(String(REPORT_FIRST_ROW));
  // The whole of what one run may take: a day's tab is rarely longer, and
  // rows that hold nothing are left out of the preview and the run alike.
  const [toRow, setToRow] = useState(String(REPORT_FIRST_ROW + DEFAULT_MAX_RUN_ROWS - 1));

  const [preview, setPreview] = useState<ReportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<unknown>(null);

  const [run, setRun] = useState<ReportRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<unknown>(null);
  /** The run's poll failed: said under the bar, and tried again. */
  const [pollTrouble, setPollTrouble] = useState(false);
  /** The server forgot the run (a restart): what it added is in the lake. */
  const [runLost, setRunLost] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadOverview = useCallback(async () => {
    try {
      const next = await reportApi.overview();
      if (!mounted.current) return null;
      setOverview(next);
      setOverviewError(null);
      return next;
    } catch (caught) {
      if (mounted.current) setOverviewError(caught ?? new Error('Could not load Report Jobs.'));
      return null;
    }
  }, []);

  // Arrival: the sheet, the rate, today's earnings and the latest run - a
  // run still going is followed from here, one that ended within the hour
  // shows its summary - then the sheet's tabs, today's chosen first.
  useEffect(() => {
    void (async () => {
      const first = await loadOverview();
      if (!first || !mounted.current) return;
      if (first.run) setRun(first.run);
      if (!first.sheet.configured || first.sheet.error) return;
      try {
        const listed = await reportApi.tabs();
        if (!mounted.current) return;
        setTabs(listed);
        setTabName(listed.defaultTab ?? listed.tabs[0]?.title ?? '');
      } catch (caught) {
        if (mounted.current) setTabsError(caught ?? new Error('Could not list the tabs of your job sheet.'));
      }
    })();
  }, [loadOverview]);

  const maxRows = overview?.maxRunRows ?? DEFAULT_MAX_RUN_ROWS;
  const range = readReportRange({ tabName, fromRow, toRow }, maxRows);

  const loadPreview = useCallback(
    async (wanted: { tabName: string; fromRow: number; toRow: number }) => {
      setPreviewing(true);
      setPreviewError(null);
      try {
        const rows = await reportApi.rows(wanted.tabName, wanted.fromRow, wanted.toRow);
        if (mounted.current) setPreview(rows);
      } catch (caught) {
        if (mounted.current) {
          setPreview(null);
          setPreviewError(caught ?? new Error('Could not read those rows.'));
        }
      } finally {
        if (mounted.current) setPreviewing(false);
      }
    },
    []
  );

  /** Any change to what is asked for retires the preview of what was asked before. */
  const edited = (apply: () => void) => {
    apply();
    setPreview(null);
    setPreviewError(null);
    setStartError(null);
  };

  /*
   * Following a run: ask how it is getting on every REPORT_POLL_MS until the
   * SERVER says it ended. A failed poll is tried again (said under the bar);
   * a 404 means the server no longer knows the run - a restart - and what it
   * merged is in the lake already.
   */
  const runId = run?.id ?? null;
  const live = isRunLive(run);
  useEffect(() => {
    if (!runId || !live) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const answer = await reportApi.run(runId);
        if (!alive) return;
        setPollTrouble(false);
        setRun(answer.run);
        if (isRunLive(answer.run)) timer = setTimeout(() => void tick(), REPORT_POLL_MS);
      } catch (caught) {
        if (!alive) return;
        if (caught instanceof ApiResponseError && caught.status === 404) {
          setRunLost(true);
          setRun((current) => (current && current.id === runId ? { ...current, state: 'failed' } : current));
          return;
        }
        setPollTrouble(true);
        timer = setTimeout(() => void tick(), REPORT_POLL_MS * 2);
      }
    };
    timer = setTimeout(() => void tick(), REPORT_POLL_MS);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [runId, live]);

  /*
   * When a run this page watched ends: the figures at the top (balance,
   * earned today, jobs in the lake), the top bar's balance, and - when the
   * preview on screen is of the run's rows - the preview, so those rows now
   * say they were reported.
   */
  const watched = useRef<string | null>(null);
  useEffect(() => {
    if (!run) return;
    if (isRunLive(run)) {
      watched.current = run.id;
      return;
    }
    if (watched.current !== run.id) return;
    watched.current = null;
    void loadOverview();
    void refreshAccount();
    if (preview && sameRange(preview, run)) void loadPreview(run);
  }, [run, preview, loadOverview, loadPreview, refreshAccount]);

  const start = async () => {
    if (!range.ok) return;
    setStarting(true);
    setStartError(null);
    setRunLost(false);
    setPollTrouble(false);
    try {
      const answer = await reportApi.start(range.range);
      if (mounted.current) setRun(answer.run);
    } catch (caught) {
      if (!mounted.current) return;
      // A run is already going (another tab of theirs started it): follow
      // that one rather than saying no.
      const going =
        caught instanceof ApiResponseError && caught.code === 'run-in-progress' && typeof caught.body.runId === 'string'
          ? caught.body.runId
          : null;
      if (going) {
        try {
          const answer = await reportApi.run(going);
          if (mounted.current) setRun(answer.run);
          return;
        } catch {
          // Fall through to the refusal itself.
        }
      }
      setStartError(caught ?? new Error('Could not start the run.'));
    } finally {
      if (mounted.current) setStarting(false);
    }
  };

  const sheet = overview?.sheet ?? null;
  const sheetReady = Boolean(sheet?.configured && !sheet.error);
  const sheetHref = sheet?.configured ? safeWebLink(sheet.todayTabUrl ?? sheet.spreadsheetUrl ?? '') : null;
  const spreadsheetHref = sheet?.configured ? safeWebLink(sheet.spreadsheetUrl ?? '') : null;
  const blocker = startBlocker({ sheetReady, run, range, preview });
  const paid = overview?.paid ?? true;
  const tabList = tabs?.tabs ?? [];

  return (
    <Page width="default">
      <PageHeader
        title="Report Jobs"
        description="Add the job postings in your job sheet to this installation's job lake, and earn for every one it accepts."
      />

      <div className="space-y-6">
        <ErrorNotice error={overviewError} fallback="Report Jobs could not be loaded" />

        {!overview && overviewError == null && (
          // "Preparing", not "loading": on a new account this read is what
          // creates the spreadsheet, which takes a few round trips to Google.
          <Spinner label="Preparing your sheet..." />
        )}

        {overview && (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <Figure
              label="Per job added"
              value={overview.paid ? formatMoney(overview.rate.rateMilli) : 'Not paid'}
              hint={describeReporterRate(overview)}
            />
            <Figure
              label="Earned today (UTC)"
              value={describeEarnedToday(overview)}
              hint={overview.dailyCapMilli === null ? 'No daily cap.' : 'Today’s earnings against the daily cap.'}
            />
            <Figure label="Your balance" value={formatMoney(overview.balanceMilli)} hint={<Link href="/credits" className="tl-link">See your earnings and payouts</Link>} />
            <Figure label="Your jobs in the lake" value={overview.lakeJobs} />
          </div>
        )}

        {overview && (
          <Card
            title="Your job sheet"
            description="The jobs you report come from your own Google spreadsheet: a tab for each day, a row for each job."
          >
            {sheet && !sheet.configured && (
              <Notice tone="warn">{sheet.message ?? 'Google Sheets is not set up on this server.'}</Notice>
            )}
            {sheet?.error && <ErrorNotice error={sheet.error} />}
            {sheetHref && (
              <div className="space-y-4">
                {sheet?.todayTab && (
                  <p className="text-sm text-muted">
                    Today&apos;s tab is <span className="font-medium text-ink">{sheet.todayTab}</span>. After a run,
                    each row&apos;s Lake Status column says what became of it, and duplicates are painted red there.
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                  {/* A new tab: the sheet is Google's page, and this one should still be here when they come back. */}
                  <a href={sheetHref} target="_blank" rel="noreferrer" className="tl-button-quiet">
                    Open your job sheet
                    <IconExternal className="h-4 w-4" />
                  </a>
                  <Link href="/settings/job-sheet" className="text-sm font-medium text-accent-ink underline">
                    Who can open it
                  </Link>
                </div>
              </div>
            )}
          </Card>
        )}

        {sheetReady && (
          <Card
            title="Choose the rows"
            description={`A tab of your sheet and the rows to report, at most ${maxRows} at a time. Row 1 is the header.`}
          >
            <div className="space-y-5">
              <ErrorNotice error={tabsError} fallback="The tabs of your job sheet could not be listed" />
              <div className="grid gap-4 sm:grid-cols-4">
                <div className="sm:col-span-2">
                  <label htmlFor="report-tab" className="tl-label">
                    Tab
                  </label>
                  <select
                    id="report-tab"
                    value={tabName}
                    onChange={(event) => edited(() => setTabName(event.target.value))}
                    disabled={!tabs || tabList.length === 0 || previewing || live}
                    className="tl-input mt-2"
                  >
                    {tabList.length === 0 && <option value="">{tabs ? 'No tabs found' : 'Loading tabs...'}</option>}
                    {tabList.map((tab) => (
                      <option key={tab.title} value={tab.title}>
                        {tab.title}
                        {tab.title === sheet?.todayTab ? ' (today)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="report-from-row" className="tl-label">
                    From row
                  </label>
                  {/* Text, not a number box: a number box hands over what the browser made of the keys. */}
                  <input
                    id="report-from-row"
                    type="text"
                    inputMode="numeric"
                    value={fromRow}
                    onChange={(event) => edited(() => setFromRow(event.target.value))}
                    disabled={previewing || live}
                    className="tl-input mt-2 tabular-nums"
                  />
                </div>
                <div>
                  <label htmlFor="report-to-row" className="tl-label">
                    To row
                  </label>
                  <input
                    id="report-to-row"
                    type="text"
                    inputMode="numeric"
                    value={toRow}
                    onChange={(event) => edited(() => setToRow(event.target.value))}
                    disabled={previewing || live}
                    className="tl-input mt-2 tabular-nums"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className="tl-button-quiet"
                  disabled={!range.ok || previewing || live}
                  onClick={() => range.ok && void loadPreview(range.range)}
                >
                  {previewing ? 'Reading rows...' : preview && range.ok && sameRange(preview, range.range) ? 'Preview again' : 'Preview rows'}
                </button>
                {!range.ok && tabName && (
                  <p className="text-sm text-muted" aria-live="polite">
                    {range.error}
                  </p>
                )}
              </div>

              <ErrorNotice error={previewError} fallback="Those rows could not be read" onDismiss={() => setPreviewError(null)} />

              {preview && !preview.jobTab && <Notice tone="warn">{notJobTabMessage(preview.tabName)}</Notice>}

              {preview && preview.jobTab && (
                <div className="space-y-4">
                  <Notice tone="neutral">
                    Rows {preview.fromRow}-{preview.toRow} of <span className="font-medium">{preview.tabName}</span>:{' '}
                    {describeReportPreview(preview.rows)}
                  </Notice>
                  {preview.rows.length > 0 && <PreviewTable preview={preview} />}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-end gap-3 border-t-[1px] border-[color:var(--line-subtle)] pt-5">
                {blocker && (
                  <p className="mr-auto text-sm text-muted" aria-live="polite">
                    {blocker}
                  </p>
                )}
                <button type="button" className="tl-button" disabled={Boolean(blocker) || starting} onClick={() => void start()}>
                  {starting ? 'Starting...' : 'Add to job lake'}
                </button>
              </div>
              <ErrorNotice error={startError} fallback="The run could not be started" onDismiss={() => setStartError(null)} />
            </div>
          </Card>
        )}

        {run && (
          <Card
            title={live ? 'Adding to the job lake' : 'Your last run'}
            description={
              <>
                Rows {run.fromRow}-{run.toRow} of <span className="font-medium text-ink">{run.tabName}</span>, started{' '}
                {formatDate(run.startedAt)}
                {run.finishedAt ? `, ended ${formatDate(run.finishedAt)}` : ''}.
              </>
            }
          >
            <div className="space-y-5">
              {(live || run.progress.total > 0) && <RunBar run={run} />}
              {live && (
                <p className="text-sm text-muted">
                  It goes on in the server: you may leave this page and come back. Each job is analysed once, ever -
                  a posting analysed before costs nothing - then added, or found to be a duplicate.
                </p>
              )}
              {pollTrouble && live && (
                <Notice tone="warn" role="status">
                  This page lost touch with the server for a moment. It keeps asking; the run itself is not affected.
                </Notice>
              )}

              {runLost && (
                <Notice tone="warn" role="status">
                  The server restarted while this run was going, so its progress is gone. Every job it added is in the
                  lake and was paid; run the same rows again to finish the rest - nothing is analysed or paid twice.
                </Notice>
              )}

              {run.state === 'failed' && run.error && <ErrorNotice error={run.error} />}

              {run.summary && (
                <div className="space-y-2" role="status">
                  <p className="text-lg font-semibold text-ink" data-testid="report-summary">
                    {describeRunSummary(run.summary)}
                  </p>
                  <p className="text-sm text-muted">{describeRunBreakdown(run.summary, paid)}</p>
                </div>
              )}

              {run.summary && !run.summary.sheetUpdated && (
                <Notice tone="warn">
                  The jobs are in the lake, but your sheet&apos;s Lake Status cells could not be written this time. Run
                  the same rows again to mark them: nothing is analysed or paid twice.
                </Notice>
              )}

              <RunOutcomes run={run} paid={paid} />

              {!live && run.rows.some(isRedOutcome) && spreadsheetHref && (
                <p className="text-sm text-muted">
                  The duplicates are painted red in your sheet too.{' '}
                  <a href={spreadsheetHref} target="_blank" rel="noreferrer" className="tl-link">
                    Open your job sheet
                  </a>
                </p>
              )}
            </div>
          </Card>
        )}
      </div>
    </Page>
  );
}

export default function ReportJobsPage() {
  return (
    <ReporterOnly>
      <ReportJobsBody />
    </ReporterOnly>
  );
}
