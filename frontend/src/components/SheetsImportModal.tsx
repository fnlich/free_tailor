'use client';

import { useEffect, useMemo, useState } from 'react';
import { importApi } from '@/lib/api';
import GenerationProgress, { type GenerationProgressState } from '@/components/GenerationProgress';

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
  showJobTitleMapping: boolean;
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

function toSpreadsheetColumnLabel(columnNumber: number): string {
  let current = columnNumber;
  let label = '';

  while (current > 0) {
    const remainder = (current - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    current = Math.floor((current - 1) / 26);
  }

  return label;
}

function parseSpreadsheetColumnInput(label: string, value: string): number {
  const normalized = value.trim().toUpperCase();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  if (!/^[A-Z]+$/.test(normalized)) {
    throw new Error(`${label} must use spreadsheet letters like A, B, or AA.`);
  }

  let columnNumber = 0;
  for (const character of normalized) {
    columnNumber = (columnNumber * 26) + (character.charCodeAt(0) - 64);
  }

  return columnNumber;
}

function getColumnOffset(startColumn: number, columnLabel: string, totalColumns: number): string {
  const absoluteColumn = parseSpreadsheetColumnInput(columnLabel, columnLabel);
  const offset = absoluteColumn - startColumn;
  return offset >= 0 && offset < totalColumns ? String(offset) : '';
}

export default function SheetsImportModal({
  isOpen,
  isSubmitting,
  showJobTitleMapping,
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
  const [error, setError] = useState('');

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
        setError(err instanceof Error ? err.message : 'Failed to load spreadsheet tabs');
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

  useEffect(() => {
    if (showJobTitleMapping) return;
    setMapping((current) => (current.jobTitle === '' ? current : { ...current, jobTitle: '' }));
  }, [showJobTitleMapping]);

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
    const jobTitleIndex =
      showJobTitleMapping && activeMapping.jobTitle !== '' ? Number(activeMapping.jobTitle) : null;
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
      // The own sheet HAS a job title column, so map it when the form wants
      // one. A saved source has no layout to promise that, and leaves it unset.
      jobTitle:
        showJobTitleMapping && layout.jobTitleColumn
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
      setError(err instanceof Error ? err.message : 'Failed to generate from sheet');
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
      setError(err instanceof Error ? err.message : 'Failed to import jobs from sheet');
    }
  };

  return (
    <div className="fixed inset-0 z-[var(--layer-app-modal)] bg-black/40 backdrop-blur-sm">
      <div className="absolute inset-4 flex items-center justify-center">
        <div className="max-h-[90vh] w-full max-w-6xl overflow-hidden rounded-xl bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Import from Sheets</h3>
              <p className="text-sm text-gray-600">
                Load jobs from Google Sheets, map the columns, then generate all profile × job combinations.
              </p>
              {selectedProfileName && (
                <div className="mt-2 text-sm font-medium text-gray-900">
                  Selected profile: {selectedProfileName}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={isLoading || isSubmitting}
              className="rounded-md px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-900"
            >
              Close
            </button>
          </div>

          {isSubmitting && generationProgress && (
            <div className="border-b border-blue-100 bg-blue-50/40 px-6 py-4">
              <GenerationProgress progress={generationProgress} />
            </div>
          )}

          <div className="max-h-[calc(90vh-72px)] overflow-y-auto px-6 py-5">
            <div className="space-y-5">
              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {error}
                </div>
              )}


              <div className="grid gap-4">
                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">Google Sheet</label>
                  <select
                    value={selectedSourceId}
                    onChange={(e) => onSelectSource(e.target.value)}
                    disabled={isLoading || isSubmitting || sources.length === 0}
                    className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
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
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                      <span className="break-all">{selectedSource.sheetId}</span>
                      <span>
                        {isLoadingTabs
                          ? 'Loading tabs...'
                          : tabName
                            ? `Tab: ${tabName}`
                            : 'No tab selected'}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">From Row</label>
                  <input
                    type="number"
                    min="1"
                    value={fromRow}
                    onChange={(e) => setFromRow(e.target.value)}
                    disabled={isLoading || isSubmitting}
                    className="w-full rounded-lg border border-gray-300 px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">To Row</label>
                  <input
                    type="number"
                    min="1"
                    value={toRow}
                    onChange={(e) => setToRow(e.target.value)}
                    disabled={isLoading || isSubmitting}
                    className="w-full rounded-lg border border-gray-300 px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div className="rounded-lg border border-gray-200 bg-gray-50">
                <button
                  type="button"
                  onClick={() => setIsAdvancedOpen((current) => !current)}
                  disabled={isLoading || isSubmitting}
                  className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-60"
                  aria-expanded={isAdvancedOpen}
                >
                  <span>Advanced columns</span>
                  <span className="text-xs text-gray-500">
                    Range {fromCol.trim().toUpperCase() || layout.fromCol}:{toCol.trim().toUpperCase() || layout.toCol}
                  </span>
                </button>
                {isAdvancedOpen && (
                  <div className="grid gap-4 border-t border-gray-200 bg-white p-4 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <label className="mb-2 block text-sm font-medium text-gray-700">Sheet Tab</label>
                      <select
                        value={tabName}
                        onChange={(e) => setTabName(e.target.value)}
                        disabled={isLoadingTabs || isLoading || isSubmitting || !selectedSource || sheetTabs.length === 0}
                        className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
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
                      <label className="mb-2 block text-sm font-medium text-gray-700">From Column</label>
                      <input
                        type="text"
                        value={fromCol}
                        onChange={(e) => setFromCol(e.target.value)}
                        disabled={isLoading || isSubmitting}
                        placeholder={layout.fromCol}
                        className="w-full rounded-lg border border-gray-300 px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="mb-2 block text-sm font-medium text-gray-700">To Column</label>
                      <input
                        type="text"
                        value={toCol}
                        onChange={(e) => setToCol(e.target.value)}
                        disabled={isLoading || isSubmitting}
                        placeholder={layout.toCol}
                        className="w-full rounded-lg border border-gray-300 px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleGenerate}
                  disabled={isLoadingTabs || isLoading || isSubmitting || !selectedSource}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-400"
                >
                  {isLoading || isSubmitting ? 'Generating...' : isLoadingTabs ? 'Loading tabs...' : 'Generate'}
                </button>
              </div>

              {values.length > 0 && (
                <>
                  <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                    <div className="text-sm text-gray-700">
                      Every imported row will be treated as one job record using company column {layout.companyColumn} and description column {layout.jobDescriptionColumn}.
                    </div>
                    <div className="text-xs text-gray-500">Rows loaded: {values.length}</div>
                  </div>

                  <div className="rounded-lg border border-gray-200 bg-gray-50">
                    <button
                      type="button"
                      onClick={() => setIsAdvancedOpen((current) => !current)}
                      disabled={isSubmitting}
                      className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-60"
                      aria-expanded={isAdvancedOpen}
                    >
                      <span>Edit imported column mapping</span>
                      <span className="text-xs text-gray-500">
                        company {columnOptions.find((option) => option.value === mapping.companyName)?.label || '-'}, description {columnOptions.find((option) => option.value === mapping.jobDescription)?.label || '-'}
                      </span>
                    </button>
                    {isAdvancedOpen && (
                      <div className={`grid gap-4 border-t border-gray-200 bg-white p-4 ${showJobTitleMapping ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
                        <div>
                          <label className="mb-2 block text-sm font-medium text-gray-700">
                            company_name <span className="text-red-500">*</span>
                          </label>
                          <select
                            value={mapping.companyName}
                            onChange={(e) => setMapping((current) => ({ ...current, companyName: e.target.value }))}
                            disabled={isSubmitting}
                            className="w-full rounded-lg border border-gray-300 px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            <option value="">Choose a column...</option>
                            {columnOptions.map((option) => (
                              <option key={`company-${option.value}`} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        {showJobTitleMapping && (
                          <div>
                            <label className="mb-2 block text-sm font-medium text-gray-700">job_title</label>
                            <select
                              value={mapping.jobTitle}
                              onChange={(e) => setMapping((current) => ({ ...current, jobTitle: e.target.value }))}
                              disabled={isSubmitting}
                              className="w-full rounded-lg border border-gray-300 px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            >
                              <option value="">Skip</option>
                              {columnOptions.map((option) => (
                                <option key={`title-${option.value}`} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        <div>
                          <label className="mb-2 block text-sm font-medium text-gray-700">
                            job_description <span className="text-red-500">*</span>
                          </label>
                          <select
                            value={mapping.jobDescription}
                            onChange={(e) => setMapping((current) => ({ ...current, jobDescription: e.target.value }))}
                            disabled={isSubmitting}
                            className="w-full rounded-lg border border-gray-300 px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
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

                  <div className="overflow-x-auto rounded-lg border border-gray-200">
                    <table className="min-w-full divide-y divide-gray-200 text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium text-gray-700">Row</th>
                          {columnOptions.map((option, index) => (
                            <th key={option.value} className="px-3 py-2 text-left font-medium text-gray-700">
                              {toSpreadsheetColumnLabel(rangeStartCol + index)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200 bg-white">
                        {previewRows.map((row, rowIndex) => (
                          <tr key={`preview-row-${rowIndex}`}>
                            <td className="whitespace-nowrap px-3 py-2 font-medium text-gray-900">
                              {rangeStartRow + rowIndex}
                            </td>
                            {columnOptions.map((option, columnIndex) => (
                              <td key={`preview-cell-${rowIndex}-${option.value}`} className="max-w-xs px-3 py-2 align-top text-gray-700">
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
                      className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleConfirm}
                      disabled={isSubmitting}
                      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-400"
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
    </div>
  );
}
