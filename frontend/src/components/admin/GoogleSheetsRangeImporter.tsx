'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { adminApi, GoogleSheetCell, GoogleSheetColor, GoogleSheetMergeRange, GoogleSheetSource, GoogleSheetTab, GoogleSheetsRangeResponse } from '@/lib/api';
import {
  parsePositiveWholeNumber,
  parseSpreadsheetColumnInput,
  toSpreadsheetColumnLabel,
} from '@/lib/sheet';
import { Card, Field, Notice, Section } from '@/components/ui/kit';
import styles from './GoogleSheetsRangeImporter.module.css';

type SheetsImportFormState = {
  sheetId: string;
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

type SavedSheetFormState = {
  name: string;
  sheetId: string;
};

const DEFAULT_SHEETS_IMPORT_FORM: SheetsImportFormState = {
  sheetId: '',
  tabName: '',
  fromRow: '1',
  toRow: '10',
  fromCol: 'A',
  toCol: 'E',
};

const DEFAULT_SAVED_SHEET_FORM: SavedSheetFormState = {
  name: '',
  sheetId: '',
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

export default function GoogleSheetsRangeImporter() {
  const [sheetsForm, setSheetsForm] = useState<SheetsImportFormState>(DEFAULT_SHEETS_IMPORT_FORM);
  const [sheetsLookup, setSheetsLookup] = useState<SheetsLookupState | null>(null);
  const [sheetsResult, setSheetsResult] = useState<GoogleSheetsRangeResponse | null>(null);
  const [editableValues, setEditableValues] = useState<string[][]>([]);
  const [originalValues, setOriginalValues] = useState<string[][]>([]);
  const [savedSources, setSavedSources] = useState<GoogleSheetSource[]>([]);
  const [selectedSavedSourceId, setSelectedSavedSourceId] = useState('');
  const [savedSheetForm, setSavedSheetForm] = useState<SavedSheetFormState>(DEFAULT_SAVED_SHEET_FORM);
  const [editingSavedSourceId, setEditingSavedSourceId] = useState('');
  const [sheetsError, setSheetsError] = useState('');
  const [sheetsSuccess, setSheetsSuccess] = useState('');
  const [isLoadingSavedSources, setIsLoadingSavedSources] = useState(true);
  const [isSavingSavedSource, setIsSavingSavedSource] = useState(false);
  const [isLoadingSheetTabs, setIsLoadingSheetTabs] = useState(false);
  const [isImportingSheetRange, setIsImportingSheetRange] = useState(false);
  const [isSavingSheetRange, setIsSavingSheetRange] = useState(false);

  const setSheetsField = <K extends keyof SheetsImportFormState>(field: K, value: SheetsImportFormState[K]) => {
    setSheetsForm((current) => ({ ...current, [field]: value }));
  };

  const resetSavedSheetForm = () => {
    setSavedSheetForm(DEFAULT_SAVED_SHEET_FORM);
    setEditingSavedSourceId('');
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

  const handleSheetIdChange = useCallback((value: string) => {
    setSheetsForm((current) => ({
      ...current,
      sheetId: value,
      tabName: value.trim() === current.sheetId.trim() ? current.tabName : '',
    }));
    setSheetsLookup(null);
    setSheetsResult(null);
    setEditableValues([]);
    setOriginalValues([]);
    setSheetsError('');
    setSheetsSuccess('');
  }, []);

  useEffect(() => {
    const loadSavedSources = async () => {
      try {
        setIsLoadingSavedSources(true);
        const settings = await adminApi.getSettings();
        const nextSources = settings.googleSheetsSources ?? [];
        setSavedSources(nextSources);
        const initialSourceId = nextSources[0]?.id ?? '';
        setSelectedSavedSourceId(initialSourceId);
        handleSheetIdChange(nextSources[0]?.sheetId ?? '');
      } catch (err) {
        setSheetsError(err instanceof Error ? err.message : 'Failed to load saved Google Sheets');
      } finally {
        setIsLoadingSavedSources(false);
      }
    };

    loadSavedSources();
  }, [handleSheetIdChange]);

  useEffect(() => {
    const selectedSource = savedSources.find((source) => source.id === selectedSavedSourceId);
    handleSheetIdChange(selectedSource?.sheetId ?? '');
  }, [handleSheetIdChange, selectedSavedSourceId, savedSources]);

  const persistSavedSources = async (nextSources: GoogleSheetSource[], successMessage: string, preferredSourceId?: string) => {
    const response = await adminApi.updateSettings({ googleSheetsSources: nextSources });
    const storedSources = response.googleSheetsSources ?? [];
    setSavedSources(storedSources);
    const resolvedSourceId =
      (preferredSourceId && storedSources.some((source) => source.id === preferredSourceId) ? preferredSourceId : '') ||
      storedSources[0]?.id ||
      '';
    setSelectedSavedSourceId(resolvedSourceId);
    resetSavedSheetForm();
    setSheetsSuccess(successMessage);
    setSheetsError('');
  };

  const handleSaveSavedSource = async () => {
    const name = savedSheetForm.name.trim();
    const sheetId = savedSheetForm.sheetId.trim();

    if (!name) {
      setSheetsError('Saved sheet name is required.');
      return;
    }
    if (!sheetId) {
      setSheetsError('Google Sheet ID is required.');
      return;
    }

    const duplicateName = savedSources.some(
      (source) => source.id !== editingSavedSourceId && source.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (duplicateName) {
      setSheetsError('A saved Google Sheet with that name already exists.');
      return;
    }

    const duplicateSheetId = savedSources.some(
      (source) => source.id !== editingSavedSourceId && source.sheetId.trim() === sheetId
    );
    if (duplicateSheetId) {
      setSheetsError('That Google Sheet ID is already saved.');
      return;
    }

    const now = new Date().toISOString();
    const existing = savedSources.find((source) => source.id === editingSavedSourceId);
    const nextSource: GoogleSheetSource = existing
      ? {
          ...existing,
          name,
          sheetId,
          updatedAt: now,
        }
      : {
          id: typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `sheet-${Date.now()}`,
          name,
          sheetId,
          createdAt: now,
          updatedAt: now,
        };

    const nextSources = existing
      ? savedSources.map((source) => (source.id === existing.id ? nextSource : source))
      : [...savedSources, nextSource];

    try {
      setIsSavingSavedSource(true);
      await persistSavedSources(
        nextSources,
        existing ? `Updated "${name}".` : `Saved "${name}".`,
        nextSource.id
      );
    } catch (err) {
      setSheetsError(err instanceof Error ? err.message : 'Failed to save Google Sheet');
    } finally {
      setIsSavingSavedSource(false);
    }
  };

  const handleEditSavedSource = (source: GoogleSheetSource) => {
    setEditingSavedSourceId(source.id);
    setSavedSheetForm({
      name: source.name,
      sheetId: source.sheetId,
    });
    setSheetsError('');
    setSheetsSuccess('');
  };

  const handleDeleteSavedSource = async (source: GoogleSheetSource) => {
    if (!window.confirm(`Delete saved Google Sheet "${source.name}"?`)) {
      return;
    }

    const nextSources = savedSources.filter((item) => item.id !== source.id);
    const preferredSourceId =
      selectedSavedSourceId === source.id
        ? nextSources[0]?.id
        : selectedSavedSourceId;

    try {
      setIsSavingSavedSource(true);
      await persistSavedSources(nextSources, `Deleted "${source.name}".`, preferredSourceId);
    } catch (err) {
      setSheetsError(err instanceof Error ? err.message : 'Failed to delete Google Sheet');
    } finally {
      setIsSavingSavedSource(false);
    }
  };

  const handleLoadSheetTabs = async () => {
    const sheetId = sheetsForm.sheetId.trim();
    if (!sheetId) {
      setSheetsError('Enter a Google Sheet ID.');
      return;
    }

    try {
      setIsLoadingSheetTabs(true);
      setSheetsError('');
      setSheetsSuccess('');
      const response = await adminApi.fetchGoogleSheetRange({ sheetId });
      applySheetsLookup(response);
      setSheetsResult(null);
      setEditableValues([]);
      setOriginalValues([]);
      setSheetsForm((current) => ({
        ...current,
        sheetId,
        tabName: response.tabs.some((tab) => tab.title === current.tabName)
          ? current.tabName
          : (response.tabs[0]?.title ?? ''),
      }));
    } catch (err) {
      setSheetsLookup(null);
      setSheetsResult(null);
      setSheetsError(err instanceof Error ? err.message : 'Failed to load spreadsheet tabs');
    } finally {
      setIsLoadingSheetTabs(false);
    }
  };

  const handleImportSheetRange = async () => {
    const sheetId = sheetsForm.sheetId.trim();
    if (!sheetId) {
      setSheetsError('Enter a Google Sheet ID.');
      return;
    }

    if (!sheetsForm.tabName.trim()) {
      setSheetsError('Select a sheet tab before importing a range.');
      return;
    }

    try {
      const parsedFromCol = parseSpreadsheetColumnInput('From column', sheetsForm.fromCol);
      const parsedToCol = parseSpreadsheetColumnInput('To column', sheetsForm.toCol);
      const payload = {
        sheetId,
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
        sheetId,
        tabName: response.selectedTab ?? payload.tabName,
      }));
    } catch (err) {
      setSheetsResult(null);
      setSheetsError(err instanceof Error ? err.message : 'Failed to import Google Sheets range');
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
      sheetId: sheetsForm.sheetId.trim(),
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
        sheetId: payload.sheetId,
        tabName: payload.tabName,
        fromRow: payload.fromRow,
        toRow: payload.toRow,
        fromCol: payload.fromCol,
        toCol: payload.toCol,
      });
      applyImportedSheetResult(refreshed);
      setSheetsSuccess('Google Sheet updated successfully.');
    } catch (err) {
      setSheetsError(err instanceof Error ? err.message : 'Failed to save Google Sheets changes');
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
        title="Saved Google Sheets"
        description="Manage reusable spreadsheet IDs for the admin importer and builder."
      >
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <div className="min-w-0">
            {isLoadingSavedSources ? (
              <div className="tl-card px-4 py-3 text-sm text-muted">Loading saved Google Sheets...</div>
            ) : savedSources.length === 0 ? (
              <div className="tl-card px-4 py-6 text-sm text-muted">No saved Google Sheets yet.</div>
            ) : (
              <ul className="tl-rows overflow-hidden">
                {savedSources.map((source) => {
                  const selected = source.id === selectedSavedSourceId;
                  return (
                    <li key={source.id} className={selected ? 'bg-accent-soft' : undefined}>
                      <div className="flex items-start justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => setSelectedSavedSourceId(source.id)}
                          aria-pressed={selected}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className={`block font-medium ${selected ? 'text-accent-ink' : 'text-ink'}`}>
                            {source.name}
                          </span>
                          <span className="mt-1 block break-all text-xs text-subtle">{source.sheetId}</span>
                        </button>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleEditSavedSource(source)}
                            disabled={isSavingSavedSource || isLoadingSheetTabs || isImportingSheetRange || isSavingSheetRange}
                            className="tl-button-quiet"
                            data-size="sm"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteSavedSource(source)}
                            disabled={isSavingSavedSource || isLoadingSheetTabs || isImportingSheetRange || isSavingSheetRange}
                            className="tl-button-quiet"
                            data-size="sm"
                            data-tone="danger"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <Card title={editingSavedSourceId ? 'Edit Saved Google Sheet' : 'Add Saved Google Sheet'}>
            <div className="space-y-5">
              <Field label="Name" htmlFor="saved-sheet-name">
                <input
                  id="saved-sheet-name"
                  type="text"
                  value={savedSheetForm.name}
                  onChange={(e) => setSavedSheetForm((current) => ({ ...current, name: e.target.value }))}
                  disabled={isSavingSavedSource}
                  placeholder="Hiring Tracker"
                  className="tl-input"
                />
              </Field>
              <Field label="Google Sheet ID" htmlFor="saved-sheet-id">
                <input
                  id="saved-sheet-id"
                  type="text"
                  value={savedSheetForm.sheetId}
                  onChange={(e) => setSavedSheetForm((current) => ({ ...current, sheetId: e.target.value }))}
                  disabled={isSavingSavedSource}
                  placeholder="1abcDEFghIjklMNopQRstuVWxyz1234567890"
                  className="tl-input"
                />
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handleSaveSavedSource}
                  disabled={isSavingSavedSource}
                  className="tl-button"
                >
                  {isSavingSavedSource ? 'Saving...' : editingSavedSourceId ? 'Update Saved Sheet' : 'Save Sheet'}
                </button>
                {editingSavedSourceId && (
                  <button
                    type="button"
                    onClick={resetSavedSheetForm}
                    disabled={isSavingSavedSource}
                    className="tl-button-quiet"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          </Card>
        </div>
      </Section>

      <Section
        title="Google Sheets Range Importer"
        description="Save named Google Sheet IDs here, then load tabs and import a numeric row range with spreadsheet-letter column bounds."
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
            <Field label="Saved Google Sheet" htmlFor="range-saved-sheet">
              <div className="flex flex-col gap-3 sm:flex-row">
                <select
                  id="range-saved-sheet"
                  value={selectedSavedSourceId}
                  onChange={(e) => setSelectedSavedSourceId(e.target.value)}
                  disabled={isLoadingSavedSources || isLoadingSheetTabs || isImportingSheetRange || savedSources.length === 0}
                  className="tl-input"
                >
                  <option value="">
                    {savedSources.length ? 'Select a saved Google Sheet' : 'Save a Google Sheet above first'}
                  </option>
                  {savedSources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleLoadSheetTabs}
                  disabled={isLoadingSheetTabs || isImportingSheetRange || !sheetsForm.sheetId.trim()}
                  className="tl-button-quiet sm:min-w-32"
                  // The select beside it is 2.5rem; matched inline, because
                  // .tl-button-quiet is unlayered and outranks a min-h utility.
                  style={{ minHeight: '2.5rem' }}
                >
                  {isLoadingSheetTabs ? 'Loading Tabs...' : 'Load Tabs'}
                </button>
              </div>
              {sheetsForm.sheetId && (
                <p className="mt-2 break-all text-xs text-subtle">{sheetsForm.sheetId}</p>
              )}
            </Field>

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
                disabled={isImportingSheetRange || isLoadingSheetTabs || !sheetsForm.sheetId.trim() || !sheetsForm.tabName.trim()}
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
