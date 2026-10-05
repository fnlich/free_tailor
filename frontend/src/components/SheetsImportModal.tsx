'use client';

import { useEffect, useMemo, useState } from 'react';
import { importApi } from '@/lib/api';
import { parseSpreadsheetColumnInput, toSpreadsheetColumnLabel } from '@/lib/sheet';
import GenerationProgress, { type GenerationProgressState } from '@/components/GenerationProgress';
import { ErrorNotice, Notice, Pill } from '@/components/ui/kit';
import { IconChevronRight } from '@/components/icons';
import styles from '@/components/builder.module.css';

export type ImportedSheetJob = {
  companyName: string;
  jobTitle: string;
  jobDescription: string;
  sourceRowNumber: number;
};

type ColumnMapping = {
  companyName: string;
  jobTitle: string;
  jobDescription: string;
};

/**
 * A spreadsheet this dialog may read from.
 *
 * Wider than the admin-configured `GoogleSheetSource` it used to take, because
 * the list those made up was the wrong list: every account has its OWN job
 * sheet and almost nobody has a saved source. Offering only the saved ones sent
 * an ordinary user at a spreadsheet they are not allowed to address, and the
 * backend answered - correctly - that it was not found.
 */
export type ImportSheetSource = {
  id: string;
  name: string;
  sheetId: string;
  /** The account's own job sheet, whose layout this app decides. */
  isOwnSheet?: boolean;
  /** Today's tab, preferred over whichever tab Google happens to list first. */
  preferredTab?: string;
};

/**
 * Where the fields sit, per kind of sheet.
 *
 * The account's own sheet is written BY this app, so its columns are known
 * exactly - `NO(DATE)`, `Company`, `Job Title`, `Job Link`, `Job Description`,
 * and then columns an import has no use for. B:E is therefore the range that
 * covers what is needed and nothing else, and row 2 is the first that is not
 * the header. A saved source is somebody else's spreadsheet, so it keeps the
 * D:G it always had: a guess, and one that reads a job link as a company name
 * if it is applied to a sheet this app laid out.
 */
type SheetLayout = {
  fromRow: string;
  toRow: string;
  fromCol: string;
  toCol: string;
  companyColumn: string;
  jobTitleColumn: string;
  jobDescriptionColumn: string;
};

const OWN_SHEET_LAYOUT: SheetLayout = {
  fromRow: '2',
  toRow: '11',
  fromCol: 'B',
  toCol: 'E',
  companyColumn: 'B',
  jobTitleColumn: 'C',
  jobDescriptionColumn: 'E',
};

const SAVED_SOURCE_LAYOUT: SheetLayout = {
  fromRow: '1',
  toRow: '10',
  fromCol: 'D',
  toCol: 'G',
  companyColumn: 'D',
  jobTitleColumn: '',
  jobDescriptionColumn: 'G',
};

function layoutFor(source: ImportSheetSource | null | undefined): SheetLayout {
  return source?.isOwnSheet ? OWN_SHEET_LAYOUT : SAVED_SOURCE_LAYOUT;
}

type Props = {
  isOpen: boolean;
  isSubmitting: boolean;
  sources: ImportSheetSource[];
  selectedSourceId: string;
  selectedProfileName?: string;
  generationProgress?: GenerationProgressState | null;
  onSelectSource: (sourceId: string) => void;
  onClose: () => void;
  onConfirm: (jobs: ImportedSheetJob[], meta: { skippedRows: number }) => Promise<void>;
};

/** Nothing mapped yet. The real mapping is derived once a range has loaded. */
const EMPTY_MAPPING: ColumnMapping = {
  companyName: '',
  jobTitle: '',
  jobDescription: '',
};

function getColumnOffset(startColumn: number, columnLabel: string, totalColumns: number): string {
  const absoluteColumn = parseSpreadsheetColumnInput(columnLabel, columnLabel);
  const offset = absoluteColumn - startColumn;
  return offset >= 0 && offset < totalColumns ? String(offset) : '';
}

export default function SheetsImportModal({
  isOpen,
  isSubmitting,
  sources,
  selectedSourceId,
  selectedProfileName,
  generationProgress,
  onSelectSource,
  onClose,
  onConfirm,
}: Props) {
  const selectedSource = sources.find((source) => source.id === selectedSourceId) ?? null;
  const layout = layoutFor(selectedSource);
  const [tabName, setTabName] = useState('');
  // Seeded from the layout of whatever is selected on the first render, so the
  // dialog never shows one sheet's range for a beat before the effect corrects
  // it. The effects below keep them in step after that.
  const [fromRow, setFromRow] = useState(layout.fromRow);
  const [toRow, setToRow] = useState(layout.toRow);
  const [fromCol, setFromCol] = useState(layout.fromCol);
  const [toCol, setToCol] = useState(layout.toCol);
  const [mapping, setMapping] = useState<ColumnMapping>(EMPTY_MAPPING);
  const [values, setValues] = useState<string[][]>([]);
  const [rangeStartRow, setRangeStartRow] = useState(1);
  const [rangeStartCol, setRangeStartCol] = useState(1);
  const [sheetTabs, setSheetTabs] = useState<string[]>([]);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [isLoadingTabs, setIsLoadingTabs] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  /** A sentence of the dialog's own, or a caught failure for <ErrorNotice> to word. */
  const [error, setError] = useState<unknown>('');

  useEffect(() => {
    if (!isOpen) {
      setTabName('');
      setFromRow(layout.fromRow);
      setToRow(layout.toRow);
      setFromCol(layout.fromCol);
      setToCol(layout.toCol);
      setMapping(EMPTY_MAPPING);
      setValues([]);
      setRangeStartRow(1);
      setRangeStartCol(1);
      setSheetTabs([]);
      setIsAdvancedOpen(false);
      setIsLoadingTabs(false);
      setIsLoading(false);
      setError('');
    }
  }, [isOpen, layout]);

  useEffect(() => {
    if (!isOpen) return;
    setTabName('');
    setValues([]);
    setRangeStartRow(1);
    setRangeStartCol(1);
    setSheetTabs([]);
    setMapping(EMPTY_MAPPING);
    setIsAdvancedOpen(false);
    setError('');
    // The range belongs to the sheet, not to the dialog: switching between the
    // account's own sheet and a saved source changes which columns hold what.
    setFromRow(layout.fromRow);
    setToRow(layout.toRow);
    setFromCol(layout.fromCol);
    setToCol(layout.toCol);

    if (!selectedSource?.sheetId.trim()) return;

    let isCancelled = false;
    setIsLoadingTabs(true);
    importApi.fetchGoogleSheetRange({ sheetId: selectedSource.sheetId.trim() })
      .then((response) => {
        if (isCancelled) return;
        const tabTitles = response.tabs.map((tab) => tab.title).filter(Boolean);
        setSheetTabs(tabTitles);
        // Today's tab where the sheet has one. On the account's own sheet the
        // tabs are dates, and the one being filled in today is the one to
        // import from - it is rarely the one Google lists first.
        const preferred = selectedSource?.preferredTab?.trim() ?? '';
        setTabName(preferred && tabTitles.includes(preferred) ? preferred : tabTitles[0] ?? '');
        if (!tabTitles.length) {
          setError('No tabs were found in the selected Google Sheet.');
        }
      })
      .catch((err) => {
        if (isCancelled) return;
        setError(err ?? 'Failed to load the spreadsheet tabs.');
      })
      .finally(() => {
        if (!isCancelled) {
          setIsLoadingTabs(false);
        }
      });

    return () => {
      isCancelled = true;
    };
    // `layout` is one of two module constants, so it is stable: it changes only
    // when the selected source changes kind, which is exactly when the range
    // should be reset.
  }, [isOpen, layout, selectedSource?.id, selectedSource?.sheetId, selectedSource?.preferredTab]);

  const columnOptions = useMemo(() => {
    if (!values.length) return [];

    const totalColumns = values.reduce((max, row) => Math.max(max, row.length), 0);

    return Array.from({ length: totalColumns }, (_, index) => {
      const absoluteColumnNumber = rangeStartCol + index;
      const letter = toSpreadsheetColumnLabel(absoluteColumnNumber);

      return {
        value: String(index),
        label: letter,
      };
    });
  }, [rangeStartCol, values]);

  const previewRows = values.slice(0, 12);

  if (!isOpen) return null;

  const buildJobsFromValues = (
    importedValues: string[][],
    startRow: number,
    activeMapping: ColumnMapping
  ): { jobs: ImportedSheetJob[]; skippedRows: number } => {
    if (activeMapping.companyName === '') {
      throw new Error('Map a column to company_name.');
    }
    if (activeMapping.jobDescription === '') {
      throw new Error('Map a column to job_description.');
    }

    const companyIndex = Number(activeMapping.companyName);
    const jobTitleIndex = activeMapping.jobTitle !== '' ? Number(activeMapping.jobTitle) : null;
    const jobDescriptionIndex = Number(activeMapping.jobDescription);
    const jobs: ImportedSheetJob[] = [];
    let skippedRows = 0;

    for (let rowIndex = 0; rowIndex < importedValues.length; rowIndex += 1) {
      const row = importedValues[rowIndex] ?? [];
      const companyName = row[companyIndex]?.trim() ?? '';
      const jobDescription = row[jobDescriptionIndex]?.trim() ?? '';
      const jobTitle = jobTitleIndex === null ? '' : row[jobTitleIndex]?.trim() ?? '';

      if (!companyName || !jobDescription) {
        skippedRows += 1;
        continue;
      }

      jobs.push({
        companyName,
        jobTitle,
        jobDescription,
        sourceRowNumber: startRow + rowIndex,
      });
    }

    if (!jobs.length) {
      throw new Error('No importable jobs were found. Check the mapped columns and imported rows.');
    }

    return { jobs, skippedRows };
  };

  const loadSheetRange = async (): Promise<{
    importedValues: string[][];
    startRow: number;
    nextMapping: ColumnMapping;
  }> => {
    if (!selectedSource?.sheetId.trim()) {
      throw new Error('Select a Google Sheet before generating.');
    }
    if (!tabName.trim()) {
      throw new Error('Sheet tab is required.');
    }

    const parsedFromCol = parseSpreadsheetColumnInput('From column', fromCol);
    const parsedToCol = parseSpreadsheetColumnInput('To column', toCol);
    const response = await importApi.fetchGoogleSheetRange({
      sheetId: selectedSource.sheetId.trim(),
      tabName: tabName.trim(),
      fromRow: Number(fromRow),
      toRow: Number(toRow),
      fromCol: parsedFromCol,
      toCol: parsedToCol,
    });
    const importedValues = response.values ?? [];
    const responseStartRow = response.range?.fromRow ?? Number(fromRow);
    const responseStartCol = response.range?.fromCol ?? parsedFromCol;
    const totalColumns = importedValues.reduce((max, row) => Math.max(max, row.length), 0);
    const nextMapping = {
      companyName: getColumnOffset(responseStartCol, layout.companyColumn, totalColumns),
      // The own sheet HAS a job title column, so it is always mapped: each
      // row's role is the one the sheet gives it. A saved source has no
      // layout to promise that, and leaves it unset unless mapped by hand.
      jobTitle: layout.jobTitleColumn
        ? getColumnOffset(responseStartCol, layout.jobTitleColumn, totalColumns)
        : '',
      jobDescription: getColumnOffset(responseStartCol, layout.jobDescriptionColumn, totalColumns),
    };

    setValues(importedValues);
    setRangeStartRow(responseStartRow);
    setRangeStartCol(responseStartCol);
    setMapping(nextMapping);

    return {
      importedValues,
      startRow: responseStartRow,
      nextMapping,
    };
  };

  const handleGenerate = async () => {
    try {
      setIsLoading(true);
      setError('');
      const loadedRange = await loadSheetRange();
      const { jobs, skippedRows } = buildJobsFromValues(
        loadedRange.importedValues,
        loadedRange.startRow,
        loadedRange.nextMapping
      );
      await onConfirm(jobs, { skippedRows });
      onClose();
    } catch (err) {
      setValues([]);
      setError(err ?? 'Failed to generate from the sheet.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (!values.length) {
      setError('Load a sheet range before confirming.');
      return;
    }

    try {
      setError('');
      const { jobs, skippedRows } = buildJobsFromValues(values, rangeStartRow, mapping);
      await onConfirm(jobs, { skippedRows });
      onClose();
    } catch (err) {
      setError(err ?? 'Failed to import jobs from the sheet.');
    }
  };

  return (
    <div className="tl-backdrop">
      {/*
        A fixed header over a body that scrolls, so Close stays in reach
        however long the preview table grows. The hairlines between header,
        progress band and body come from `divide-y`, not a bare `border-b`,
        which the html.dark shim would recolour.
      */}
      <div className={`tl-dialog ${styles.stack} max-w-6xl divide-y divide-[var(--line-subtle)]`}>
          <div className="flex items-start justify-between gap-4 px-6 py-4">
            <div className="min-w-0">
              <h3 className="text-lg font-semibold text-ink">Import from Sheets</h3>
              <p className="mt-0.5 text-sm text-muted">
                Load jobs from Google Sheets, map the columns, then generate all profile × job combinations.
              </p>
              {selectedProfileName && (
                <div className="mt-2 text-sm font-medium text-ink">
                  Selected profile: {selectedProfileName}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={isLoading || isSubmitting}
              className="tl-button-quiet shrink-0"
              data-size="sm"
            >
              Close
            </button>
          </div>

          {isSubmitting && generationProgress && (
            <div className="px-6 py-4">
              <GenerationProgress progress={generationProgress} />
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="space-y-5">
              <ErrorNotice error={error} />

              <div className="grid gap-4">
                <div>
                  <label className="tl-label">Google Sheet</label>
                  <select
                    value={selectedSourceId}
                    onChange={(e) => onSelectSource(e.target.value)}
                    disabled={isLoading || isSubmitting || sources.length === 0}
                    className="tl-input mt-2"
                  >
                    <option value="">
                      {sources.length ? 'Choose a Google Sheet...' : 'No Google Sheet available'}
                    </option>
                    {sources.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.name}
                      </option>
                    ))}
                  </select>
                  {selectedSource && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-subtle">
                      <span className="break-all">{selectedSource.sheetId}</span>
                      <Pill>
                        {isLoadingTabs
                          ? 'Loading tabs...'
                          : tabName
                            ? `Tab: ${tabName}`
                            : 'No tab selected'}
                      </Pill>
                    </div>
                  )}
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="tl-label">From Row</label>
                  <input
                    type="number"
                    min="1"
                    value={fromRow}
                    onChange={(e) => setFromRow(e.target.value)}
                    disabled={isLoading || isSubmitting}
                    className="tl-input mt-2"
                  />
                </div>
                <div>
                  <label className="tl-label">To Row</label>
                  <input
                    type="number"
                    min="1"
                    value={toRow}
                    onChange={(e) => setToRow(e.target.value)}
                    disabled={isLoading || isSubmitting}
                    className="tl-input mt-2"
                  />
                </div>
              </div>

              <div className="tl-card divide-y divide-[var(--line-subtle)] overflow-hidden">
                <button
                  type="button"
                  onClick={() => setIsAdvancedOpen((current) => !current)}
                  disabled={isLoading || isSubmitting}
                  className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left text-sm font-medium text-ink hover:bg-surface-muted disabled:opacity-60"
                  aria-expanded={isAdvancedOpen}
                >
                  <span className="flex items-center gap-2">
                    <IconChevronRight
                      className={`h-4 w-4 ${styles.chevron} ${isAdvancedOpen ? styles.chevronOpen : ''}`}
                    />
                    Advanced columns
                  </span>
                  <span className="text-xs text-subtle">
                    Range {fromCol.trim().toUpperCase() || layout.fromCol}:{toCol.trim().toUpperCase() || layout.toCol}
                  </span>
                </button>
                {isAdvancedOpen && (
                  <div className="grid gap-4 bg-surface-muted p-4 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <label className="tl-label">Sheet Tab</label>
                      <select
                        value={tabName}
                        onChange={(e) => setTabName(e.target.value)}
                        disabled={isLoadingTabs || isLoading || isSubmitting || !selectedSource || sheetTabs.length === 0}
                        className="tl-input mt-2"
                      >
                        <option value="">
                          {isLoadingTabs
                            ? 'Loading tabs...'
                            : sheetTabs.length
                              ? 'Select a tab...'
                              : 'No tabs loaded'}
                        </option>
                        {sheetTabs.map((title) => (
                          <option key={title} value={title}>
                            {title}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="tl-label">From Column</label>
                      <input
                        type="text"
                        value={fromCol}
                        onChange={(e) => setFromCol(e.target.value)}
                        disabled={isLoading || isSubmitting}
                        placeholder={layout.fromCol}
                        className="tl-input mt-2"
                      />
                    </div>
                    <div>
                      <label className="tl-label">To Column</label>
                      <input
                        type="text"
                        value={toCol}
                        onChange={(e) => setToCol(e.target.value)}
                        disabled={isLoading || isSubmitting}
                        placeholder={layout.toCol}
                        className="tl-input mt-2"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="flex justify-end">
                {/*
                  The primary until a range is loaded; after that the confirm
                  button under the preview is, and this one steps back to quiet
                  so the dialog never offers two solid buttons at once.
                */}
                <button
                  type="button"
                  onClick={handleGenerate}
                  disabled={isLoadingTabs || isLoading || isSubmitting || !selectedSource}
                  className={values.length > 0 ? 'tl-button-quiet' : 'tl-button'}
                >
                  {isLoading || isSubmitting ? 'Generating...' : isLoadingTabs ? 'Loading tabs...' : 'Generate'}
                </button>
              </div>

              {values.length > 0 && (
                <>
                  <Notice tone="neutral" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                    <div className="text-muted">
                      Every imported row will be treated as one job record using company column {layout.companyColumn} and description column {layout.jobDescriptionColumn}.
                    </div>
                    <div className="text-xs text-subtle">Rows loaded: {values.length}</div>
                  </Notice>

                  <div className="tl-card divide-y divide-[var(--line-subtle)] overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setIsAdvancedOpen((current) => !current)}
                      disabled={isSubmitting}
                      className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left text-sm font-medium text-ink hover:bg-surface-muted disabled:opacity-60"
                      aria-expanded={isAdvancedOpen}
                    >
                      <span className="flex items-center gap-2">
                        <IconChevronRight
                          className={`h-4 w-4 ${styles.chevron} ${isAdvancedOpen ? styles.chevronOpen : ''}`}
                        />
                        Edit imported column mapping
                      </span>
                      <span className="text-xs text-subtle">
                        company {columnOptions.find((option) => option.value === mapping.companyName)?.label || '-'}, title {columnOptions.find((option) => option.value === mapping.jobTitle)?.label || '-'}, description {columnOptions.find((option) => option.value === mapping.jobDescription)?.label || '-'}
                      </span>
                    </button>
                    {isAdvancedOpen && (
                      <div className="grid gap-4 bg-surface-muted p-4 md:grid-cols-3">
                        <div>
                          <label className="tl-label">
                            company_name <span className={styles.required}>*</span>
                          </label>
                          <select
                            value={mapping.companyName}
                            onChange={(e) => setMapping((current) => ({ ...current, companyName: e.target.value }))}
                            disabled={isSubmitting}
                            className="tl-input mt-2"
                          >
                            <option value="">Choose a column...</option>
                            {columnOptions.map((option) => (
                              <option key={`company-${option.value}`} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="tl-label">job_title</label>
                          <select
                            value={mapping.jobTitle}
                            onChange={(e) => setMapping((current) => ({ ...current, jobTitle: e.target.value }))}
                            disabled={isSubmitting}
                            className="tl-input mt-2"
                          >
                            <option value="">Skip</option>
                            {columnOptions.map((option) => (
                              <option key={`title-${option.value}`} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="tl-label">
                            job_description <span className={styles.required}>*</span>
                          </label>
                          <select
                            value={mapping.jobDescription}
                            onChange={(e) => setMapping((current) => ({ ...current, jobDescription: e.target.value }))}
                            disabled={isSubmitting}
                            className="tl-input mt-2"
                          >
                            <option value="">Choose a column...</option>
                            {columnOptions.map((option) => (
                              <option key={`desc-${option.value}`} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="tl-table-box">
                    <table className="tl-table">
                      <thead>
                        <tr>
                          <th>Row</th>
                          {columnOptions.map((option, index) => (
                            <th key={option.value}>
                              {toSpreadsheetColumnLabel(rangeStartCol + index)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {previewRows.map((row, rowIndex) => (
                          <tr key={`preview-row-${rowIndex}`}>
                            <td className="whitespace-nowrap align-top">
                              {/* A colour on a .tl-table cell goes on an inner span - the unlayered td rule beats a utility on the td. */}
                              <span className="font-medium text-ink">{rangeStartRow + rowIndex}</span>
                            </td>
                            {columnOptions.map((option, columnIndex) => (
                              <td key={`preview-cell-${rowIndex}-${option.value}`} className="max-w-xs align-top">
                                <span className="line-clamp-3 whitespace-pre-wrap break-words">
                                  {row[columnIndex] ?? ''}
                                </span>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex justify-end gap-3">
                    <button
                      type="button"
                      onClick={onClose}
                      disabled={isSubmitting}
                      className="tl-button-quiet"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleConfirm}
                      disabled={isSubmitting}
                      className="tl-button"
                    >
                      {isSubmitting ? 'Generating...' : 'Generate from Imported Jobs'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
      </div>
    </div>
  );
}
