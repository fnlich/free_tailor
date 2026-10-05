'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { importApi } from '@/lib/api';
import {
  parsePositiveWholeNumber,
  parseSpreadsheetColumnInput,
  toSpreadsheetColumnLabel,
} from '@/lib/sheet';
import {
  appendColumns,
  buildSheetJobs,
  countSkippingAnalysis,
  describeRowAnalysis,
  OWN_SHEET_LAYOUT,
  SAVED_SOURCE_LAYOUT,
  type SheetColumnOffsets,
  type SheetJob,
} from '@/lib/sheetRows';
import { Card, ErrorNotice, Notice, Pill } from '@/components/ui/kit';
import { IconChevronRight } from '@/components/icons';
import styles from '@/components/builder.module.css';

/**
 * A spreadsheet the builder may read jobs from.
 *
 * The account's own job sheet first - every account has one, and it is the
 * only one an ordinary account may address - then, for an administrator, the
 * saved sources they configured. Offering only the saved ones sent an ordinary
 * user at a spreadsheet the backend rightly answered was not found.
 */
export type ImportSheetSource = {
  id: string;
  name: string;
  sheetId: string;
  /** The account's own job sheet, whose layout this app decides. */
  isOwnSheet?: boolean;
  /** Today's tab of the account's own sheet, marked in the tab list. */
  todayTab?: string;
};

/** What a run is asked for: built now while this tab follows it, or placed as an order. */
export type SheetRunKind = 'immediate' | 'order';

/**
 * The sheet a run's rows came from, as the batch names it: the tab, and the
 * spreadsheet only when it is not the account's own (the server's default).
 * With it the server reads the rows' Analysis cells itself - never from this
 * page - and a row that holds its analysis skips analysis.
 */
export type SheetRunSource = { spreadsheetId?: string; tabName: string };

/** How many loaded rows the preview table draws; the rest are counted, not drawn. */
const PREVIEW_ROWS = 50;

type Props = {
  sources: ImportSheetSource[];
  selectedSourceId: string;
  onSelectSource: (sourceId: string) => void;
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
  /** Shown instead of the sheet select when there is nothing to read from. */
  unavailableNotice?: ReactNode;
};

/**
 * The sheet half of "Building Automatically from Google Sheet", inline on the
 * page: which sheet, which TAB (every tab, today's first on the account's own
 * sheet - it used to hide behind "Advanced columns" in a dialog), which rows,
 * a preview of the jobs they hold, and then the two ways to build them -
 * Generate Immediately or Order.
 */
export default function SheetsSourcePanel({
  sources,
  selectedSourceId,
  onSelectSource,
  busy,
  onRowsChange,
  onRun,
  costLine,
  unavailableNotice,
}: Props) {
  const source = sources.find((candidate) => candidate.id === selectedSourceId) ?? null;

  return (
    <Card title="Jobs from your sheet" description="Pick a tab and the rows to build, then load them to check what will be built.">
      <div className="space-y-6">
        <div>
          <label htmlFor="sheet-source" className="tl-label">
            Google Sheet
          </label>
          <select
            id="sheet-source"
            value={selectedSourceId}
            onChange={(event) => {
              onRowsChange(null);
              onSelectSource(event.target.value);
            }}
            disabled={busy || sources.length === 0}
            className="tl-input mt-2"
          >
            {sources.length === 0 && <option value="">No Google Sheet available</option>}
            {sources.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
          {sources.length === 0 && unavailableNotice}
        </div>

        {/*
          Keyed by the sheet: another sheet is another set of tabs and another
          layout, so everything below starts again from that sheet's defaults
          rather than carrying one sheet's range onto the other.
        */}
        {source && (
          <SheetRows
            key={`${source.id}:${source.sheetId}`}
            source={source}
            busy={busy}
            onRowsChange={onRowsChange}
            onRun={onRun}
            costLine={costLine}
          />
        )}
      </div>
    </Card>
  );
}

type TabsState = { tabs: string[]; defaultTab: string | null; error: unknown };

type Loaded = {
  /** The inputs the rows were loaded with; rows loaded for other inputs are not shown or built. */
  key: string;
  jobs: SheetJob[];
  skippedRows: number;
  total: number;
  /** The tab they were read from - what the run names, so it is the one the server reads. */
  tabName: string;
  /** Whether the rows' Analysis cells were read: false on another sheet, or a tab too narrow to have them. */
  analysisRead: boolean;
};

function SheetRows({
  source,
  busy,
  onRowsChange,
  onRun,
  costLine,
}: {
  source: ImportSheetSource;
  busy: boolean;
  onRowsChange: (jobCount: number | null) => void;
  onRun: Props['onRun'];
  costLine?: ReactNode;
}) {
  const layout = source.isOwnSheet ? OWN_SHEET_LAYOUT : SAVED_SOURCE_LAYOUT;
  const [tabsState, setTabsState] = useState<TabsState | null>(null);
  /** The tab picked by hand; empty means the sheet's default. */
  const [pickedTab, setPickedTab] = useState('');
  const [fromRow, setFromRow] = useState(layout.fromRow);
  const [toRow, setToRow] = useState(layout.toRow);
  const [fromCol, setFromCol] = useState(layout.fromCol);
  const [toCol, setToCol] = useState(layout.toCol);
  const [columns, setColumns] = useState({
    company: layout.company,
    jobTitle: layout.jobTitle,
    jobLink: layout.jobLink,
    jobDescription: layout.jobDescription,
  });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  /** A sentence of the panel's own, or a caught failure for <ErrorNotice> to word. */
  const [error, setError] = useState<unknown>('');
  /**
   * False once this sheet's panel is gone - another sheet was picked while its
   * rows were loading. That answer must not tell the page how many jobs there
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
  // sets state, so a slow answer for a sheet since deselected is dropped.
  useEffect(() => {
    let alive = true;
    importApi.listTabs(source.isOwnSheet ? undefined : source.sheetId).then(
      (answer) => {
        if (!alive) return;
        const tabs = (answer.tabs ?? []).map((tab) => tab.title).filter(Boolean);
        setTabsState({ tabs, defaultTab: answer.defaultTab ?? null, error: null });
      },
      (err) => {
        if (alive) setTabsState({ tabs: [], defaultTab: null, error: err ?? 'Could not list the tabs of that sheet.' });
      }
    );
    return () => {
      alive = false;
    };
  }, [source.isOwnSheet, source.sheetId]);

  const tabs = tabsState?.tabs ?? [];
  // Today's tab on the account's own sheet (the server's `defaultTab`), the
  // first otherwise - until somebody picks another.
  const tabName =
    pickedTab && tabs.includes(pickedTab) ? pickedTab : tabsState?.defaultTab && tabs.includes(tabsState.defaultTab) ? tabsState.defaultTab : tabs[0] ?? '';

  const inputsKey = JSON.stringify([source.sheetId, tabName, fromRow, toRow, fromCol, toCol, columns]);
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
      const firstCol = parseSpreadsheetColumnInput('From column', fromCol);
      const lastCol = parseSpreadsheetColumnInput('To column', toCol);
      if (lastCol < firstCol) throw new Error('To column must be From column or a column after it.');

      const response = await importApi.fetchGoogleSheetRange({
        sheetId: source.sheetId,
        tabName,
        fromRow: firstRow,
        toRow: lastRow,
        fromCol: firstCol,
        toCol: lastCol,
      });
      const values = response.values ?? [];
      const startRow = response.range?.fromRow ?? firstRow;
      const startCol = response.range?.fromCol ?? firstCol;
      const width = (response.range?.toCol ?? lastCol) - startCol + 1;
      const range = `${toSpreadsheetColumnLabel(startCol)}:${toSpreadsheetColumnLabel(startCol + width - 1)}`;

      /** A mapped column as an offset into what was loaded; a required one outside it is refused by name. */
      const offset = (label: string, letters: string, required: boolean): number | null => {
        if (!letters.trim()) {
          if (required) throw new Error(`Choose the ${label} column under Advanced.`);
          return null;
        }
        const index = parseSpreadsheetColumnInput(`${label} column`, letters) - startCol;
        if (index >= 0 && index < width) return index;
        if (required) {
          throw new Error(`The ${label} column (${letters.trim().toUpperCase()}) is outside the columns loaded (${range}).`);
        }
        return null;
      };
      const offsets: SheetColumnOffsets = {
        companyName: offset('Company', columns.company, true),
        jobTitle: offset('Job Title', columns.jobTitle, false),
        jobLink: offset('Job Link', columns.jobLink, false),
        jobDescription: offset('Job Description', columns.jobDescription, true),
        jobField: null,
        salary: null,
        analysis: null,
      };

      // The account sheet's analysis columns, K:P: from the rows already
      // loaded when the range takes them in, else in a read of their own.
      // That second read is best-effort - a tab made before these columns
      // existed has a grid that ends at L, and Google refuses a range past
      // it - and without it every row simply says "When built", which is
      // what the server will do with a row that has no Analysis cell.
      let rows: string[][] = values;
      if (layout.analysis) {
        const fieldCol = parseSpreadsheetColumnInput('Job Field column', layout.jobField);
        const analysisCol = parseSpreadsheetColumnInput('Analysis column', layout.analysis);
        const within = (column: number) => column >= startCol && column < startCol + width;
        if (within(fieldCol) && within(analysisCol)) {
          offsets.jobField = fieldCol - startCol;
          offsets.salary = parseSpreadsheetColumnInput('Salary column', layout.salary) - startCol;
          offsets.analysis = analysisCol - startCol;
        } else {
          try {
            const extra = await importApi.fetchGoogleSheetRange({
              sheetId: source.sheetId,
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

  /** The sheet the run names: the tab the rows came from, and the spreadsheet unless it is the account's own. */
  const runSource = (rowsLoaded: Loaded): SheetRunSource =>
    source.isOwnSheet ? { tabName: rowsLoaded.tabName } : { spreadsheetId: source.sheetId, tabName: rowsLoaded.tabName };

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
            disabled={locked || tabsLoading || tabs.length === 0}
            className="tl-input mt-2"
          >
            {tabs.length === 0 && (
              <option value="">{tabsLoading ? 'Loading tabs...' : 'No tabs found'}</option>
            )}
            {tabs.map((title) => (
              <option key={title} value={title}>
                {title}
                {title === source.todayTab ? ' (today)' : ''}
              </option>
            ))}
          </select>
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

      <div className="tl-card divide-y divide-[var(--line-subtle)] overflow-hidden">
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          disabled={locked}
          className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left text-sm font-medium text-ink hover:bg-surface-muted disabled:opacity-60"
          aria-expanded={advancedOpen}
        >
          <span className="flex items-center gap-2">
            <IconChevronRight className={`h-4 w-4 ${styles.chevron} ${advancedOpen ? styles.chevronOpen : ''}`} />
            Advanced columns
          </span>
          <span className="text-xs text-subtle">
            Range {fromCol.trim().toUpperCase() || layout.fromCol}:{toCol.trim().toUpperCase() || layout.toCol}
          </span>
        </button>
        {advancedOpen && (
          <div className="grid gap-4 bg-surface-muted p-4 sm:grid-cols-2 lg:grid-cols-4">
            <ColumnField id="sheet-from-col" label="From column" value={fromCol} disabled={locked} onChange={(value) => edited(() => setFromCol(value))} />
            <ColumnField id="sheet-to-col" label="To column" value={toCol} disabled={locked} onChange={(value) => edited(() => setToCol(value))} />
            <ColumnField
              id="sheet-col-company"
              label="Company"
              required
              value={columns.company}
              disabled={locked}
              onChange={(value) => edited(() => setColumns((current) => ({ ...current, company: value })))}
            />
            <ColumnField
              id="sheet-col-description"
              label="Job Description"
              required
              value={columns.jobDescription}
              disabled={locked}
              onChange={(value) => edited(() => setColumns((current) => ({ ...current, jobDescription: value })))}
            />
            <ColumnField
              id="sheet-col-title"
              label="Job Title"
              value={columns.jobTitle}
              disabled={locked}
              onChange={(value) => edited(() => setColumns((current) => ({ ...current, jobTitle: value })))}
            />
            <ColumnField
              id="sheet-col-link"
              label="Job Link"
              value={columns.jobLink}
              disabled={locked}
              onChange={(value) => edited(() => setColumns((current) => ({ ...current, jobLink: value })))}
            />
            {layout.analysis && (
              <p className="text-sm text-muted sm:col-span-2 lg:col-span-4">
                Job Field, Salary and Analysis are read from columns {layout.jobField}, {layout.salary} and{' '}
                {layout.analysis}, which only this program can write. A row whose Analysis cell is filled is
                built on it without being analysed again.
              </p>
            )}
          </div>
        )}
      </div>

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

function ColumnField({
  id,
  label,
  value,
  required = false,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  required?: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="tl-label">
        {label} {required && <span className={styles.required}>*</span>}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        placeholder={required ? 'Letter' : 'Not used'}
        className="tl-input mt-2 uppercase"
      />
    </div>
  );
}
