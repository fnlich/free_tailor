'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { adminApi, GoogleSheetCell, GoogleSheetColor, GoogleSheetMergeRange, GoogleSheetTab, GoogleSheetsRangeResponse } from '@/lib/api';
import {
  parsePositiveWholeNumber,
  parseSpreadsheetColumnInput,
  toSpreadsheetColumnLabel,
} from '@/lib/sheet';
import { Card, Field, Notice, Section } from '@/components/ui/kit';
import { messageWithDetail } from '@/lib/userMessage';
import styles from './GoogleSheetsRangeImporter.module.css';

type SheetsImportFormState = {
  tabName: string;
  fromRow: string;
  toRow: string;
  fromCol: string;
  toCol: string;
};

type SheetsLookupState = {
  spreadsheetId: string;
  spreadsheetTitle: string;
  tabs: GoogleSheetTab[];
};

const DEFAULT_SHEETS_IMPORT_FORM: SheetsImportFormState = {
  tabName: '',
  fromRow: '1',
  toRow: '10',
  fromCol: 'A',
  toCol: 'E',
};

function toRgba(color: GoogleSheetColor | null | undefined, fallback: string): string {
  if (!color) return fallback;
  const red = Math.round(color.red * 255);
  const green = Math.round(color.green * 255);
  const blue = Math.round(color.blue * 255);
  const alpha = Math.max(0, Math.min(1, color.alpha));
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function toCssBorder(borderStyle: string | undefined, borderColor: GoogleSheetColor | null | undefined): string | undefined {
  if (!borderStyle || borderStyle === 'NONE') return undefined;

  const width =
    borderStyle === 'SOLID_THICK' ? 3 :
    borderStyle === 'SOLID_MEDIUM' ? 2 :
    borderStyle === 'DOUBLE' ? 3 :
    1;

  const style =
    borderStyle === 'DOTTED' ? 'dotted' :
    borderStyle === 'DASHED' ? 'dashed' :
    borderStyle === 'DOUBLE' ? 'double' :
    'solid';

  return `${width}px ${style} ${toRgba(borderColor, 'rgba(208, 215, 222, 1)')}`;
}

function getCellStyle(cell: GoogleSheetCell, rowHeight: number | undefined): CSSProperties {
  const format = cell.format;
  const textFormat = format?.textFormat;
  const wrapStrategy = format?.wrapStrategy;

  return {
    backgroundColor: toRgba(format?.backgroundColor, '#ffffff'),
    color: toRgba(textFormat?.foregroundColor, '#202124'),
    fontWeight: textFormat?.bold ? 700 : 400,
    fontStyle: textFormat?.italic ? 'italic' : 'normal',
    fontSize: textFormat?.fontSize ? `${textFormat.fontSize}px` : '13px',
    fontFamily: textFormat?.fontFamily ?? 'Arial, Helvetica, sans-serif',
    textDecoration: [
      textFormat?.underline ? 'underline' : '',
      textFormat?.strikethrough ? 'line-through' : '',
    ].filter(Boolean).join(' ') || undefined,
    textAlign:
      format?.horizontalAlignment === 'CENTER' ? 'center' :
      format?.horizontalAlignment === 'RIGHT' ? 'right' :
      'left',
    verticalAlign:
      format?.verticalAlignment === 'MIDDLE' ? 'middle' :
      format?.verticalAlignment === 'BOTTOM' ? 'bottom' :
      'top',
    whiteSpace: wrapStrategy === 'WRAP' ? 'pre-wrap' : 'nowrap',
    overflow: 'hidden',
    textOverflow: wrapStrategy === 'WRAP' ? 'clip' : 'ellipsis',
    lineHeight: wrapStrategy === 'WRAP' ? 1.4 : `${Math.max((rowHeight ?? 32) - 10, 18)}px`,
    borderTop: toCssBorder(format?.borders.top?.style, format?.borders.top?.color) ?? '1px solid #e0e3e7',
    borderRight: toCssBorder(format?.borders.right?.style, format?.borders.right?.color) ?? '1px solid #e0e3e7',
    borderBottom: toCssBorder(format?.borders.bottom?.style, format?.borders.bottom?.color) ?? '1px solid #e0e3e7',
    borderLeft: toCssBorder(format?.borders.left?.style, format?.borders.left?.color) ?? '1px solid #e0e3e7',
  };
}

function buildMergeMaps(merges: GoogleSheetMergeRange[]) {
  const mergeStarts = new Map<string, GoogleSheetMergeRange>();
  const coveredCells = new Set<string>();

  for (const merge of merges) {
    mergeStarts.set(`${merge.startRow}:${merge.startCol}`, merge);
    for (let rowIndex = merge.startRow; rowIndex < merge.endRow; rowIndex += 1) {
      for (let columnIndex = merge.startCol; columnIndex < merge.endCol; columnIndex += 1) {
        if (rowIndex === merge.startRow && columnIndex === merge.startCol) continue;
        coveredCells.add(`${rowIndex}:${columnIndex}`);
      }
    }
  }

  return { mergeStarts, coveredCells };
}

/**
 * Admin -> Google Sheets: a range of the administrator's OWN job sheet, read
 * with its formatting and written back as edited. Nobody's else: the saved
 * "shared" sheets this page used to manage are gone (owner decision S1), and
 * the server answers any other spreadsheet as not found. No id is sent - the
 * server knows whose sheet it is.
 *
 * A write into G to L of a job tab - or into any column under the app's own
 * protection, whatever the tab's row 1 says - is refused by the server (409
 * `protected-columns`) and said in its words: those cells are the program's,
 * and the server's identity is the only editor their protection lets through.
 */
export default function GoogleSheetsRangeImporter() {
  const [sheetsForm, setSheetsForm] = useState<SheetsImportFormState>(DEFAULT_SHEETS_IMPORT_FORM);
  const [sheetsLookup, setSheetsLookup] = useState<SheetsLookupState | null>(null);
  const [sheetsResult, setSheetsResult] = useState<GoogleSheetsRangeResponse | null>(null);
  const [editableValues, setEditableValues] = useState<string[][]>([]);
  const [originalValues, setOriginalValues] = useState<string[][]>([]);
  const [sheetsError, setSheetsError] = useState('');
  const [sheetsSuccess, setSheetsSuccess] = useState('');
  const [isLoadingSheetTabs, setIsLoadingSheetTabs] = useState(false);
  const [isImportingSheetRange, setIsImportingSheetRange] = useState(false);
  const [isSavingSheetRange, setIsSavingSheetRange] = useState(false);

  const setSheetsField = <K extends keyof SheetsImportFormState>(field: K, value: SheetsImportFormState[K]) => {
    setSheetsForm((current) => ({ ...current, [field]: value }));
  };

  const applySheetsLookup = (response: GoogleSheetsRangeResponse) => {
    setSheetsLookup({
      spreadsheetId: response.spreadsheetId,
      spreadsheetTitle: response.spreadsheetTitle,
      tabs: response.tabs,
    });
  };

  const applyImportedSheetResult = (response: GoogleSheetsRangeResponse) => {
    applySheetsLookup(response);
    setSheetsResult(response);
    const nextValues = (response.cells ?? []).map((row) => row.map((cell) => cell.value));
    setEditableValues(nextValues);
    setOriginalValues(nextValues);
  };

  /** The tabs of the administrator's own sheet: asked with no tab, the range route answers with the list. */
  const loadSheetTabs = useCallback(async () => {
    try {
      setIsLoadingSheetTabs(true);
      setSheetsError('');
      setSheetsSuccess('');
      const response = await adminApi.fetchGoogleSheetRange({});
      setSheetsLookup({
        spreadsheetId: response.spreadsheetId,
        spreadsheetTitle: response.spreadsheetTitle,
        tabs: response.tabs,
      });
      setSheetsResult(null);
      setEditableValues([]);
      setOriginalValues([]);
      setSheetsForm((current) => ({
        ...current,
        tabName: response.tabs.some((tab) => tab.title === current.tabName)
          ? current.tabName
          : (response.tabs[0]?.title ?? ''),
      }));
    } catch (err) {
      setSheetsLookup(null);
      setSheetsResult(null);
      setSheetsError(messageWithDetail(err, 'Failed to load the tabs of your job sheet'));
    } finally {
      setIsLoadingSheetTabs(false);
    }
  }, []);

  useEffect(() => {
    void loadSheetTabs();
  }, [loadSheetTabs]);

  const handleImportSheetRange = async () => {
    if (!sheetsForm.tabName.trim()) {
      setSheetsError('Select a sheet tab before importing a range.');
      return;
    }

    try {
      const parsedFromCol = parseSpreadsheetColumnInput('From column', sheetsForm.fromCol);
      const parsedToCol = parseSpreadsheetColumnInput('To column', sheetsForm.toCol);
      const payload = {
        tabName: sheetsForm.tabName.trim(),
        fromRow: parsePositiveWholeNumber('From row', sheetsForm.fromRow),
        toRow: parsePositiveWholeNumber('To row', sheetsForm.toRow),
        fromCol: parsedFromCol,
        toCol: parsedToCol,
      };

      setIsImportingSheetRange(true);
      setSheetsError('');
      setSheetsSuccess('');
      const response = await adminApi.fetchGoogleSheetRange(payload);
      applyImportedSheetResult(response);
      setSheetsForm((current) => ({
        ...current,
        tabName: response.selectedTab ?? payload.tabName,
      }));
    } catch (err) {
      setSheetsResult(null);
      setSheetsError(messageWithDetail(err, 'Failed to import Google Sheets range'));
    } finally {
      setIsImportingSheetRange(false);
    }
  };

  const handleCellValueChange = (rowIndex: number, columnIndex: number, value: string) => {
    setEditableValues((current) =>
      current.map((row, currentRowIndex) =>
        currentRowIndex === rowIndex
          ? row.map((cellValue, currentColumnIndex) => (currentColumnIndex === columnIndex ? value : cellValue))
          : row
      )
    );
    setSheetsSuccess('');
  };

  const handleSaveSheetChanges = async () => {
    if (!sheetsResult?.range) {
      setSheetsError('Import a range before saving changes.');
      return;
    }

    const payload = {
      tabName: sheetsForm.tabName.trim(),
      fromRow: sheetsResult.range.fromRow,
      toRow: sheetsResult.range.toRow,
      fromCol: sheetsResult.range.fromCol,
      toCol: sheetsResult.range.toCol,
      values: editableValues,
    };

    try {
      setIsSavingSheetRange(true);
      setSheetsError('');
      setSheetsSuccess('');
      await adminApi.updateGoogleSheetRange(payload);
      const refreshed = await adminApi.fetchGoogleSheetRange({
        tabName: payload.tabName,
        fromRow: payload.fromRow,
        toRow: payload.toRow,
        fromCol: payload.fromCol,
        toCol: payload.toCol,
      });
      applyImportedSheetResult(refreshed);
      setSheetsSuccess('Google Sheet updated successfully.');
    } catch (err) {
      setSheetsError(messageWithDetail(err, 'Failed to save Google Sheets changes'));
    } finally {
      setIsSavingSheetRange(false);
    }
  };

  const importedCells = sheetsResult?.cells ?? [];
  const importedRange = sheetsResult?.range;
  const importedMerges = sheetsResult?.merges ?? [];
  const importedRowHeights = sheetsResult?.rowHeights ?? [];
  const importedColumnWidths = sheetsResult?.columnWidths ?? [];
  const importedColumnNumbers = importedRange
    ? Array.from({ length: sheetsResult?.totalColumns ?? 0 }, (_, index) => importedRange.fromCol + index)
    : [];
  const hasImportedCells = editableValues.some((row) => row.some((cell) => cell.trim().length > 0));
  const { mergeStarts, coveredCells } = buildMergeMaps(importedMerges);
  const hasPendingChanges = JSON.stringify(editableValues) !== JSON.stringify(originalValues);

  return (
    <div>
      <Section
        title="Google Sheets Range Importer"
        description="Load a tab of your own job sheet, then import a numeric row range with spreadsheet-letter column bounds, edit it here and save it back."
      >
        {sheetsError && (
          <Notice tone="error" role="alert">
            {sheetsError}
          </Notice>
        )}

        {sheetsSuccess && (
          <Notice tone="success" role="status">
            {sheetsSuccess}
          </Notice>
        )}

        <Card>
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted">
                Your own job sheet, the only one this page reads and writes. Columns G to L of a job tab - Job Field
                to Analysis - are the app&apos;s and cannot be written from here.
              </p>
              <button
                type="button"
                onClick={() => void loadSheetTabs()}
                disabled={isLoadingSheetTabs || isImportingSheetRange}
                className="tl-button-quiet"
              >
                {isLoadingSheetTabs ? 'Loading Tabs...' : 'Reload Tabs'}
              </button>
            </div>

            {sheetsLookup && (
              <Notice tone="neutral">
                <p className="font-medium">{sheetsLookup.spreadsheetTitle}</p>
                <p className="mt-0.5 break-all text-xs text-muted">Spreadsheet ID: {sheetsLookup.spreadsheetId}</p>
              </Notice>
            )}

            <div className="grid gap-4 md:grid-cols-2 md:items-end">
              <Field label="Tab name" htmlFor="range-tab-name">
                <select
                  id="range-tab-name"
                  value={sheetsForm.tabName}
                  onChange={(e) => {
                    setSheetsField('tabName', e.target.value);
                    setSheetsResult(null);
                    setSheetsError('');
                  }}
                  disabled={isLoadingSheetTabs || isImportingSheetRange || !sheetsLookup?.tabs.length}
                  className="tl-input"
                >
                  <option value="">
                    {sheetsLookup?.tabs.length ? 'Select a tab' : 'Load tabs first'}
                  </option>
                  {(sheetsLookup?.tabs ?? []).map((tab) => (
                    <option key={tab.sheetId} value={tab.title}>
                      {tab.title}
                    </option>
                  ))}
                </select>
              </Field>
              <Notice tone="info">
                Enter columns using spreadsheet letters like `A`, `B`, or `AA`. Uppercase and lowercase both work.
              </Notice>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="From row" htmlFor="range-from-row">
                <input
                  id="range-from-row"
                  type="number"
                  min="1"
                  step="1"
                  value={sheetsForm.fromRow}
                  onChange={(e) => setSheetsField('fromRow', e.target.value)}
                  disabled={isImportingSheetRange}
                  className="tl-input"
                />
              </Field>
              <Field label="To row" htmlFor="range-to-row">
                <input
                  id="range-to-row"
                  type="number"
                  min="1"
                  step="1"
                  value={sheetsForm.toRow}
                  onChange={(e) => setSheetsField('toRow', e.target.value)}
                  disabled={isImportingSheetRange}
                  className="tl-input"
                />
              </Field>
              <Field label="From column" htmlFor="range-from-col">
                <input
                  id="range-from-col"
                  type="text"
                  value={sheetsForm.fromCol}
                  onChange={(e) => setSheetsField('fromCol', e.target.value)}
                  disabled={isImportingSheetRange}
                  placeholder="A"
                  className="tl-input"
                />
              </Field>
              <Field label="To column" htmlFor="range-to-col">
                <input
                  id="range-to-col"
                  type="text"
                  value={sheetsForm.toCol}
                  onChange={(e) => setSheetsField('toCol', e.target.value)}
                  disabled={isImportingSheetRange}
                  placeholder="E"
                  className="tl-input"
                />
              </Field>
            </div>

            <div>
              <button
                type="button"
                onClick={handleImportSheetRange}
                disabled={isImportingSheetRange || isLoadingSheetTabs || !sheetsForm.tabName.trim()}
                className="tl-button"
              >
                {isImportingSheetRange ? 'Importing...' : 'Import Range'}
              </button>
            </div>
          </div>
        </Card>

        {sheetsResult && importedRange && (
          <div className="space-y-3">
            <Notice tone="success" className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                Imported <span className="font-medium">{importedRange.a1Notation}</span> from{' '}
                <span className="font-medium">{sheetsResult.spreadsheetTitle}</span>.
              </div>
              <button
                type="button"
                onClick={handleSaveSheetChanges}
                disabled={!hasPendingChanges || isSavingSheetRange || isImportingSheetRange}
                className="tl-button self-start md:self-auto"
              >
                {isSavingSheetRange ? 'Saving...' : hasPendingChanges ? 'Save Changes' : 'No Changes'}
              </button>
            </Notice>

            <Notice tone="neutral">
              Preview mirrors the imported Google Sheets range layout. Edit any visible cell here, then save to push the updated values back to Google Sheets.
            </Notice>

            {!hasImportedCells && (
              <Notice tone="warn">
                The requested range was fetched successfully, but every returned cell is blank.
              </Notice>
            )}

            {/*
              The kit's table box around the sheet's own grid. The cells keep the
              colours, borders and fonts the spreadsheet gave them - that is the
              content being previewed - and only the row and column headings are
              the app's, from importer.module.css, in both themes.
            */}
            <div className="tl-table-box w-fit max-w-full">
              <table className={styles.grid}>
                <colgroup>
                  <col style={{ width: 56 }} />
                  {importedColumnWidths.map((width, index) => (
                    <col key={importedColumnNumbers[index]} style={{ width }} />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    <th className={styles.corner} style={{ height: 36, minWidth: 56 }} />
                    {importedColumnNumbers.map((columnNumber) => (
                      <th
                        key={columnNumber}
                        className={styles.colHead}
                        style={{ height: 36 }}
                      >
                        {toSpreadsheetColumnLabel(columnNumber)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {importedCells.map((row, rowIndex) => (
                    <tr key={`${importedRange.fromRow + rowIndex}`} style={{ height: importedRowHeights[rowIndex] ?? 28 }}>
                      <th
                        className={styles.rowHead}
                        style={{ width: 56, minWidth: 56 }}
                      >
                        {importedRange.fromRow + rowIndex}
                      </th>
                      {row.map((cell, columnIndex) => {
                        const mergeKey = `${rowIndex}:${columnIndex}`;
                        if (coveredCells.has(mergeKey)) {
                          return null;
                        }

                        const merge = mergeStarts.get(mergeKey);
                        const rowSpan = merge ? merge.endRow - merge.startRow : 1;
                        const colSpan = merge ? merge.endCol - merge.startCol : 1;
                        const cellHeight = Array.from({ length: rowSpan }, (_, offset) => importedRowHeights[rowIndex + offset] ?? 28)
                          .reduce((sum, value) => sum + value, 0);
                        const cellValue = editableValues[rowIndex]?.[columnIndex] ?? cell.value;
                        const format = cell.format;
                        const wrapStrategy = format?.wrapStrategy;

                        return (
                          <td
                            key={`${importedRange.fromRow + rowIndex}-${importedColumnNumbers[columnIndex]}`}
                            rowSpan={rowSpan}
                            colSpan={colSpan}
                            className="px-2 align-top"
                            style={{
                              ...getCellStyle(cell, importedRowHeights[rowIndex]),
                              minWidth: importedColumnWidths[columnIndex] ?? 120,
                              height: cellHeight,
                              paddingTop: 6,
                              paddingRight: 8,
                              paddingBottom: 6,
                              paddingLeft: 8,
                            }}
                          >
                            <textarea
                              value={cellValue}
                              onChange={(event) => handleCellValueChange(rowIndex, columnIndex, event.target.value)}
                              spellCheck={false}
                              disabled={isSavingSheetRange}
                              rows={1}
                              className={styles.cellInput}
                              style={{
                                minHeight: Math.max(cellHeight - 12, 24),
                                whiteSpace: wrapStrategy === 'WRAP' ? 'pre-wrap' : 'pre',
                                overflow: 'hidden',
                              }}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}
