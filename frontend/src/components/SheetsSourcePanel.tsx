'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { importApi } from '@/lib/api';
import { parsePositiveWholeNumber, parseSpreadsheetColumnInput } from '@/lib/sheet';
import {
  appendColumns,
  buildSheetJobs,
  countSkippingAnalysis,
  describeRowAnalysis,
  OWN_SHEET_LAYOUT,
  type SheetColumnOffsets,
  type SheetJob,
} from '@/lib/sheetRows';
import { chosenTab, hasUnreadTabs, sheetTabOptions, unreadTabsNoteFor, type SheetTabListing } from '@/lib/sheetTabs';
import { Card, ErrorNotice, Notice, Pill } from '@/components/ui/kit';
import styles from '@/components/builder.module.css';

/** What a run is asked for: built now while this tab follows it, or placed as an order. */
export type SheetRunKind = 'immediate' | 'order';

/**
 * The sheet a run's rows came from, as the batch names it: the tab. The
 * spreadsheet is always the account's own (owner decision S1), which is the
 * server's default, so it is not named. With it the server reads the rows'
 * Analysis cells itself - never from this page - and a row that holds its
 * analysis skips analysis.
 */
export type SheetRunSource = { tabName: string };

/** How many loaded rows the preview table draws; the rest are counted, not drawn. */
const PREVIEW_ROWS = 50;

type Props = {
  /**
   * The account's own spreadsheet - the only one a build may read from - or
   * null while it is not there (no Google on the server, or not allocated
   * yet), when `unavailableNotice` says why.
   */
  spreadsheetId: string | null;
  /** A run is being placed or followed: nothing here may change under it. */
  busy: boolean;
  /**
   * The number of jobs the loaded rows hold, or null when nothing (current)
   * is loaded - what the page prices the run by.
   */
  onRowsChange: (jobCount: number | null) => void;
  onRun: (kind: SheetRunKind, jobs: SheetJob[], meta: { skippedRows: number; sheet: SheetRunSource }) => void;
  /** The cost line, beside the two actions. */
  costLine?: ReactNode;
  /** Shown instead of the tabs when there is no sheet to read from. */
  unavailableNotice?: ReactNode;
};

/**
 * The sheet half of "Building Automatically from Google Sheet", inline on the
 * page: which TAB of the account's own sheet (All first; a tab that is not
 * laid out as a job tab is listed but not offered), which rows, a preview of
 * the jobs they hold, and then the two ways to build them - Generate
 * Immediately or Order.
 */
export default function SheetsSourcePanel({
  spreadsheetId,
  busy,
  onRowsChange,
  onRun,
  costLine,
  unavailableNotice,
}: Props) {
  return (
    <Card title="Jobs from your sheet" description="Pick a tab of your job sheet and the rows to build, then load them to check what will be built.">
      {/*
        Keyed by the spreadsheet: allocated while the page was open, it is
        another set of tabs, so everything below starts again from its
        defaults.
      */}
      {spreadsheetId ? (
        <SheetRows
          key={spreadsheetId}
          spreadsheetId={spreadsheetId}
          busy={busy}
          onRowsChange={onRowsChange}
          onRun={onRun}
          costLine={costLine}
        />
      ) : (
        unavailableNotice ?? null
      )}
    </Card>
  );
}

type TabsState = { listing: SheetTabListing | null; error: unknown };

type Loaded = {
  /** The inputs the rows were loaded with; rows loaded for other inputs are not shown or built. */
  key: string;
  jobs: SheetJob[];
  skippedRows: number;
  total: number;
  /** The tab they were read from - what the run names, so it is the one the server reads. */
  tabName: string;
  /** Whether the rows' Analysis cells were read: false when the second read failed (a grid too narrow for G:L). */
  analysisRead: boolean;
};

function SheetRows({
  spreadsheetId,
  busy,
  onRowsChange,
  onRun,
  costLine,
}: {
  spreadsheetId: string;
  busy: boolean;
  onRowsChange: (jobCount: number | null) => void;
  onRun: Props['onRun'];
  costLine?: ReactNode;
}) {
  const layout = OWN_SHEET_LAYOUT;
  const [tabsState, setTabsState] = useState<TabsState | null>(null);
  /** The tab picked by hand; empty means the sheet's default. */
  const [pickedTab, setPickedTab] = useState('');
  const [fromRow, setFromRow] = useState(layout.fromRow);
  const [toRow, setToRow] = useState(layout.toRow);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  /** A sentence of the panel's own, or a caught failure for <ErrorNotice> to word. */
  const [error, setError] = useState<unknown>('');
  /**
   * False once this sheet's panel is gone - the page moved on while its rows
   * were loading. That answer must not tell the page how many jobs there
   * are: they are not the rows on screen any more.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The tabs, once per sheet (this component is keyed by it). Only the answer
  // sets state, so a slow answer for a sheet since replaced is dropped.
  useEffect(() => {
    let alive = true;
    importApi.listTabs().then(
      (answer) => {
        if (!alive) return;
        setTabsState({ listing: { tabs: answer.tabs ?? [], defaultTab: answer.defaultTab ?? null }, error: null });
      },
      (err) => {
        if (alive) setTabsState({ listing: null, error: err ?? 'Could not list the tabs of your job sheet.' });
      }
    );
    return () => {
      alive = false;
    };
  }, [spreadsheetId]);

  const listing = tabsState?.listing ?? null;
  const options = sheetTabOptions(listing?.tabs ?? []);
  // All (the server's `defaultTab`), else the first job tab - until somebody
  // picks another. Never a tab that is not a job tab: its columns are not these.
  const tabName = chosenTab(listing, pickedTab);

  const inputsKey = JSON.stringify([spreadsheetId, tabName, fromRow, toRow]);
  const current = loaded && loaded.key === inputsKey ? loaded : null;

  /**
   * Any edit makes loaded rows stale: they are dropped, the page stops pricing
   * them, and they must be loaded again. Dropped rather than hidden - kept,
   * editing the range back would show them again, with their two buttons,
   * while the page priced the run as "each sheet row".
   */
  const edited = (apply: () => void) => {
    apply();
    if (loaded) {
      setLoaded(null);
      onRowsChange(null);
    }
  };

  const load = async () => {
    const key = inputsKey;
    setLoading(true);
    setError('');
    try {
      if (!tabName) throw new Error('Choose a tab to read the jobs from.');
      const firstRow = parsePositiveWholeNumber('From row', fromRow);
      const lastRow = parsePositiveWholeNumber('To row', toRow);
      if (lastRow < firstRow) throw new Error('To row must be From row or a row after it.');
      // Company to Job Description, C:F - the columns are the app's, not the page's.
      const firstCol = parseSpreadsheetColumnInput('From column', layout.fromCol);
      const lastCol = parseSpreadsheetColumnInput('To column', layout.toCol);

      const response = await importApi.fetchGoogleSheetRange({
        sheetId: spreadsheetId,
        tabName,
        fromRow: firstRow,
        toRow: lastRow,
        fromCol: firstCol,
        toCol: lastCol,
      });
      const values = response.values ?? [];
      const startRow = response.range?.fromRow ?? firstRow;
      const width = lastCol - firstCol + 1;
      const offset = (letters: string) => parseSpreadsheetColumnInput('Column', letters) - firstCol;
      const offsets: SheetColumnOffsets = {
        companyName: offset(layout.company),
        jobTitle: offset(layout.jobTitle),
        jobLink: offset(layout.jobLink),
        jobDescription: offset(layout.jobDescription),
        jobField: null,
        salary: null,
        analysis: null,
      };

      // The analysis columns, G:L, in a read of their own. Best-effort: a
      // grid narrower than L (the server widens a job tab it verifies, but a
      // tab laid out by hand may not be yet) makes Google refuse the range,
      // and without it every row simply says "When built" - which is what
      // the server will do with a row whose Analysis cell it cannot read.
      let rows: string[][] = values;
      const fieldCol = parseSpreadsheetColumnInput('Job Field column', layout.jobField);
      const analysisCol = parseSpreadsheetColumnInput('Analysis column', layout.analysis);
      if (values.length > 0) {
        try {
          const extra = await importApi.fetchGoogleSheetRange({
            sheetId: spreadsheetId,
            tabName,
            fromRow: startRow,
            toRow: startRow + values.length - 1,
            fromCol: fieldCol,
            toCol: analysisCol,
          });
          rows = appendColumns(values, width, extra.values ?? []);
          offsets.jobField = width;
          offsets.salary = width + parseSpreadsheetColumnInput('Salary column', layout.salary) - fieldCol;
          offsets.analysis = width + analysisCol - fieldCol;
        } catch {
          // Read as "not analysed in the sheet" - see above.
        }
      }

      const { jobs, skippedRows } = buildSheetJobs(rows, startRow, offsets);
      if (!mounted.current) return;
      setLoaded({ key, jobs, skippedRows, total: values.length, tabName, analysisRead: offsets.analysis !== null });
      onRowsChange(jobs.length);
    } catch (err) {
      if (!mounted.current) return;
      setLoaded(null);
      onRowsChange(null);
      setError(err ?? 'Could not read those rows.');
    } finally {
      if (mounted.current) setLoading(false);
    }
  };

  const locked = busy || loading;
  const tabsLoading = tabsState === null;

  /** The sheet the run names: the tab the rows came from (the spreadsheet is the account's own). */
  const runSource = (rowsLoaded: Loaded): SheetRunSource => ({ tabName: rowsLoaded.tabName });

  return (
    <div className="space-y-6">
      <ErrorNotice error={tabsState?.error ?? ''} />

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="sm:col-span-3">
          <label htmlFor="sheet-tab" className="tl-label">
            Tab
          </label>
          <select
            id="sheet-tab"
            value={tabName}
            onChange={(event) => edited(() => setPickedTab(event.target.value))}
            disabled={locked || tabsLoading || !tabName}
            className="tl-input mt-2"
          >
            {/* Nothing chosen: a placeholder, so a sheet with no job tab says so rather than showing one it will not read. */}
            {!tabName && (
              <option value="">{tabsLoading ? 'Loading tabs...' : options.length === 0 ? 'No tabs found' : 'No job tab to read'}</option>
            )}
            {options.map((option) => (
              <option key={option.title} value={option.title} disabled={!option.usable}>
                {option.label}
              </option>
            ))}
          </select>
          {hasUnreadTabs(listing?.tabs ?? []) && <p className="mt-2 text-sm text-subtle">{unreadTabsNoteFor(listing?.tabs ?? [])}</p>}
        </div>
        <div>
          <label htmlFor="sheet-from-row" className="tl-label">
            From row
          </label>
          <input
            id="sheet-from-row"
            type="number"
            min="1"
            inputMode="numeric"
            value={fromRow}
            onChange={(event) => edited(() => setFromRow(event.target.value))}
            disabled={locked}
            className="tl-input mt-2"
          />
        </div>
        <div>
          <label htmlFor="sheet-to-row" className="tl-label">
            To row
          </label>
          <input
            id="sheet-to-row"
            type="number"
            min="1"
            inputMode="numeric"
            value={toRow}
            onChange={(event) => edited(() => setToRow(event.target.value))}
            disabled={locked}
            className="tl-input mt-2"
          />
        </div>
        <div className="flex items-end">
          <button
            type="button"
            onClick={() => void load()}
            disabled={locked || tabsLoading || !tabName}
            className={current ? 'tl-button-quiet w-full' : 'tl-button w-full'}
          >
            {loading ? 'Loading rows...' : current ? 'Reload rows' : 'Load rows'}
          </button>
        </div>
      </div>

      <p className="text-sm text-muted">
        Each row&apos;s Company, Job Title, Job Link and Job Description are read from columns {layout.company} to{' '}
        {layout.jobDescription}. Job Field, Salary and Analysis ({layout.jobField}, {layout.salary} and {layout.analysis})
        are written only by this program; a row whose Analysis cell is filled is built on it without being analysed
        again.
      </p>

      <ErrorNotice error={error} onDismiss={() => setError('')} />

      {current && (
        <>
          <Notice tone="neutral" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <span>
              {current.jobs.length} job{current.jobs.length === 1 ? '' : 's'} in rows {fromRow}-{toRow} of{' '}
              <span className="font-medium">{tabName}</span>
            </span>
            {current.skippedRows > 0 && (
              <span className="text-xs text-subtle">
                {current.skippedRows} row{current.skippedRows === 1 ? '' : 's'} skipped: no company or no job description
              </span>
            )}
          </Notice>
          <p className="text-sm text-muted">
            {current.analysisRead && countSkippingAnalysis(current.jobs) > 0
              ? `${countSkippingAnalysis(current.jobs)} of ${current.jobs.length} already analysed in the sheet, so they skip analysis. `
              : ''}
            Every other posting is analysed once, the first time any build needs it, and never again.
          </p>

          <div className="tl-table-box">
            <table className="tl-table">
              <caption className="sr-only">The jobs the loaded rows hold</caption>
              <thead>
                <tr>
                  <th scope="col">Row</th>
                  <th scope="col">Company</th>
                  <th scope="col">Job title</th>
                  <th scope="col">Link</th>
                  <th scope="col">Analysis</th>
                </tr>
              </thead>
              <tbody>
                {current.jobs.slice(0, PREVIEW_ROWS).map((job) => (
                  <tr key={job.sourceRowNumber}>
                    <td className="whitespace-nowrap">
                      {/* A colour on a .tl-table cell goes on an inner span - the unlayered td rule beats a utility on the td. */}
                      <span className="font-medium text-ink">{job.sourceRowNumber}</span>
                    </td>
                    <td className="min-w-32">
                      <span className="break-words">{job.companyName}</span>
                    </td>
                    <td className="min-w-32">
                      {job.jobTitle ? (
                        <span className="break-words">{job.jobTitle}</span>
                      ) : (
                        <span className="text-subtle">From the posting</span>
                      )}
                    </td>
                    <td className="max-w-56">
                      {job.jobLink ? (
                        <a
                          href={job.jobLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="tl-link block truncate"
                          title={job.jobLink}
                        >
                          {new URL(job.jobLink).hostname}
                        </a>
                      ) : (
                        <span className="text-subtle">-</span>
                      )}
                    </td>
                    <td className="min-w-40">
                      <RowAnalysis job={job} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {current.jobs.length > PREVIEW_ROWS && (
            <p className="text-sm text-subtle">
              Showing the first {PREVIEW_ROWS}; all {current.jobs.length} are built.
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-3">
            {costLine}
            <button
              type="button"
              onClick={() => onRun('order', current.jobs, { skippedRows: current.skippedRows, sheet: runSource(current) })}
              disabled={busy}
              className={`tl-button-quiet ${styles.pill}`}
            >
              Order
            </button>
            <button
              type="button"
              onClick={() => onRun('immediate', current.jobs, { skippedRows: current.skippedRows, sheet: runSource(current) })}
              disabled={busy}
              className="tl-button"
              data-shape="pill"
            >
              Generate Immediately
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * What a row's build will do about its analysis, by its Analysis cell: skip
 * it (with the Job Field and Salary the row already shows), or analyse the
 * posting when built - once, unless it already was.
 */
function RowAnalysis({ job }: { job: SheetJob }) {
  const note = describeRowAnalysis(job.analysis);
  const facts = note.skipsAnalysis ? [job.jobField, job.salary].filter(Boolean) : [];
  return (
    <span className="flex flex-col items-start gap-1" title={note.detail}>
      {note.tone === 'grey' ? <span className="text-muted">{note.label}</span> : <Pill tone={note.tone}>{note.label}</Pill>}
      {facts.length > 0 && <span className="break-words text-xs text-subtle">{facts.join(' · ')}</span>}
      <span className="sr-only">{note.detail}</span>
    </span>
  );
}
