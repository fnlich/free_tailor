'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import AppTopNav from '@/components/AppTopNav';
import {
  GoogleSheetJobFilterResponse,
  GoogleSheetSource,
  GoogleSheetTab,
  importApi,
  jobsApi,
  resumeApi,
} from '@/lib/api';

type FilterFormState = {
  sheetId: string;
  tabName: string;
  startRow: string;
  endRow: string;
  jobLinkCol: string;
  resultCol: string;
  reasonCol: string;
};

const DEFAULT_FORM: FilterFormState = {
  sheetId: '',
  tabName: '',
  startRow: '2',
  endRow: '200',
  jobLinkCol: 'F',
  resultCol: 'H',
  reasonCol: 'I',
};

function parsePositiveWholeNumber(label: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive whole number.`);
  }
  return parsed;
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

function getColumnLabel(columnNumber: number): string {
  let current = columnNumber;
  let label = '';

  while (current > 0) {
    const remainder = (current - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    current = Math.floor((current - 1) / 26);
  }

  return label;
}

export default function JobFilterPage() {
  const [sheetSources, setSheetSources] = useState<GoogleSheetSource[]>([]);
  const [sheetTabs, setSheetTabs] = useState<GoogleSheetTab[]>([]);
  const [sheetTitle, setSheetTitle] = useState('');
  const [form, setForm] = useState<FilterFormState>(DEFAULT_FORM);
  const [summary, setSummary] = useState<GoogleSheetJobFilterResponse | null>(null);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingTabs, setIsLoadingTabs] = useState(false);

  const setField = <K extends keyof FilterFormState>(field: K, value: FilterFormState[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  useEffect(() => {
    let isMounted = true;

    const loadSettings = async () => {
      try {
        const nextSettings = await resumeApi.getModels();
        if (!isMounted) {
          return;
        }

        setSheetSources(nextSettings.googleSheetsSources);
        setForm((current) => ({
          ...current,
          sheetId: current.sheetId.trim() ? current.sheetId : (nextSettings.googleSheetsSources[0]?.sheetId ?? ''),
        }));
      } catch (err) {
        if (!isMounted) {
          return;
        }

        setError(err instanceof Error ? err.message : 'Failed to load app settings');
      }
    };

    void loadSettings();

    return () => {
      isMounted = false;
    };
  }, []);

  const handleLoadTabs = async () => {
    const sheetId = form.sheetId.trim();
    if (!sheetId) {
      setError('Select a saved Google Sheet before loading tabs.');
      return;
    }

    setIsLoadingTabs(true);
    setError('');

    try {
      const response = await importApi.fetchGoogleSheetRange({ sheetId });
      setSheetTitle(response.spreadsheetTitle);
      setSheetTabs(response.tabs);
      setForm((current) => ({
        ...current,
        tabName: response.tabs.some((tab) => tab.title === current.tabName) ? current.tabName : (response.tabs[0]?.title ?? ''),
      }));
    } catch (err) {
      setSheetTitle('');
      setSheetTabs([]);
      setError(err instanceof Error ? err.message : 'Failed to load Google Sheet tabs');
    } finally {
      setIsLoadingTabs(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    try {
      const startRow = parsePositiveWholeNumber('Start row', form.startRow);
      const endRow = parsePositiveWholeNumber('End row', form.endRow);
      const jobLinkCol = parseSpreadsheetColumnInput('Job link column', form.jobLinkCol);
      const resultCol = parseSpreadsheetColumnInput('Result column', form.resultCol);
      const reasonCol = parseSpreadsheetColumnInput('Reason column', form.reasonCol);

      if (!form.tabName.trim()) {
        throw new Error('Sheet tab is required.');
      }

      if (startRow > endRow) {
        throw new Error('Start row must be less than or equal to end row.');
      }

      const distinctColumns = [
        jobLinkCol,
        resultCol,
        reasonCol,
      ];

      if (new Set(distinctColumns).size !== distinctColumns.length) {
        throw new Error('Job link and output columns must all be different.');
      }

      setIsLoading(true);
      setError('');
      setSummary(null);

      const response = await jobsApi.filterGoogleSheetJobs({
        sheetId: form.sheetId.trim(),
        tabName: form.tabName.trim(),
        startRow,
        endRow,
        jobLinkCol,
        resultCol,
        reasonCol,
      });

      setSummary(response);
    } catch (err) {
      setSummary(null);
      setError(err instanceof Error ? err.message : 'Failed to filter jobs from Google Sheets');
    } finally {
      setIsLoading(false);
    }
  };

  const hasSavedSheets = sheetSources.length > 0;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-transparent">
      <AppTopNav />

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8 dark:border-slate-800 dark:bg-slate-950/85">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl space-y-3">
              <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white sm:text-4xl">
                Filter Google Sheet Jobs
              </h1>
              <p className="text-sm text-gray-600 dark:text-slate-300 sm:text-base">
                Select a sheet and tab, scrape each job link, classify it with the saved prompt, then write a final Pass or Fail result back to Google Sheets.
              </p>
            </div>

            <div className="rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
              <div className="font-semibold text-gray-900 dark:text-white">Result</div>
              <div className="mt-1">Writes `Pass` or `Fail`, plus a fail reason when one applies.</div>
            </div>
          </div>
        </section>

        <section className="mt-6 rounded-3xl border border-gray-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-950/85">
          <form className="space-y-6" onSubmit={handleSubmit}>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_220px_auto]">
              <label className="space-y-2">
                <span className="text-sm font-medium text-gray-700 dark:text-slate-200">Google Sheet</span>
                <select
                  value={form.sheetId}
                  onChange={(event) => {
                    setField('sheetId', event.target.value);
                    setField('tabName', '');
                    setSheetTabs([]);
                    setSheetTitle('');
                  }}
                  className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                  disabled={isLoading || !hasSavedSheets}
                >
                  <option value="">
                    {hasSavedSheets ? 'Choose a saved Google Sheet' : 'No saved Google Sheets available'}
                  </option>
                  {sheetSources.map((source) => (
                    <option key={source.id} value={source.sheetId}>
                      {source.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="space-y-2">
                <span className="text-sm font-medium text-gray-700 dark:text-slate-200">Sheet tab</span>
                <select
                  value={form.tabName}
                  onChange={(event) => setField('tabName', event.target.value)}
                  className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                  disabled={isLoading || isLoadingTabs || sheetTabs.length === 0}
                >
                  <option value="">{sheetTabs.length ? 'Choose a tab' : 'Load tabs first'}</option>
                  {sheetTabs.map((tab) => (
                    <option key={tab.sheetId} value={tab.title}>
                      {tab.title}
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex items-end">
                <button
                  type="button"
                  onClick={handleLoadTabs}
                  disabled={isLoading || isLoadingTabs || !form.sheetId.trim()}
                  className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:bg-gray-100 disabled:text-gray-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 dark:disabled:bg-slate-900/60 dark:disabled:text-slate-500"
                >
                  {isLoadingTabs ? 'Loading tabs...' : 'Load tabs'}
                </button>
              </div>
            </div>

            {sheetTitle && (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200">
                Connected to <span className="font-semibold">{sheetTitle}</span>.
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <label className="space-y-2">
                <span className="text-sm font-medium text-gray-700 dark:text-slate-200">Start row</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={form.startRow}
                  onChange={(event) => setField('startRow', event.target.value)}
                  className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                  disabled={isLoading}
                />
              </label>

              <label className="space-y-2">
                <span className="text-sm font-medium text-gray-700 dark:text-slate-200">End row</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={form.endRow}
                  onChange={(event) => setField('endRow', event.target.value)}
                  className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                  disabled={isLoading}
                />
              </label>

              <label className="space-y-2">
                <span className="text-sm font-medium text-gray-700 dark:text-slate-200">Job link column</span>
                <input
                  type="text"
                  value={form.jobLinkCol}
                  onChange={(event) => setField('jobLinkCol', event.target.value.toUpperCase())}
                  className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                  disabled={isLoading}
                />
              </label>

              <label className="space-y-2">
                <span className="text-sm font-medium text-gray-700 dark:text-slate-200">Result column</span>
                <input
                  type="text"
                  value={form.resultCol}
                  onChange={(event) => setField('resultCol', event.target.value.toUpperCase())}
                  className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                  disabled={isLoading}
                />
              </label>

              <label className="space-y-2">
                <span className="text-sm font-medium text-gray-700 dark:text-slate-200">Reason column</span>
                <input
                  type="text"
                  value={form.reasonCol}
                  onChange={(event) => setField('reasonCol', event.target.value.toUpperCase())}
                  className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                  disabled={isLoading}
                />
              </label>
            </div>

            <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-4 text-sm text-blue-900 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-100">
              Uses the live <span className="font-semibold">Filter Google Sheet Job</span> prompt from{' '}
              prompt library. Edit it in{' '}
              <Link href="/admin/prompts" className="font-semibold underline underline-offset-2">
                Admin Prompts
              </Link>{' '}
              and changes will apply here automatically.
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="submit"
                disabled={isLoading || !hasSavedSheets}
                className="rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white hover:bg-emerald-700 disabled:bg-emerald-300"
              >
                {isLoading ? 'Filtering jobs...' : 'Run job filter'}
              </button>
            </div>
          </form>

          {error && (
            <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200">
              {error}
            </div>
          )}

          {!hasSavedSheets && (
            <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
              Save at least one Google Sheet in the Admin Google Sheets panel before using this filter.
            </div>
          )}

          {summary && !error && (
            <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-sm text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100">
              <div className="font-semibold">
                Processed {summary.processedRows} row{summary.processedRows === 1 ? '' : 's'} in {summary.spreadsheetTitle} / {summary.selectedTab}
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                <div>Scanned: {summary.scannedRows}</div>
                <div>Runtime provider: {summary.provider}</div>
                <div>Runtime model: {summary.modelName || 'default'}</div>
                <div>Scraped pages: {summary.scrapedRows}</div>
                <div>Skipped rows: {summary.skippedRows}</div>
                <div>Rows with errors: {summary.errorRows}</div>
                <div>Job link column: {getColumnLabel(summary.jobLinkCol)}</div>
                <div>Result column: {getColumnLabel(summary.resultCol)}</div>
                <div>Reason column: {getColumnLabel(summary.reasonCol)}</div>
                <div>Rows: {summary.startRow} to {summary.endRow}</div>
                <div>Updated ranges: {summary.updatedRanges.join(', ')}</div>
              </div>
              {summary.rowErrors.length > 0 && (
                <div className="mt-3 space-y-1">
                  {summary.rowErrors.map((item) => (
                    <div key={`${item.row}-${item.message}`}>
                      Row {item.row}: {item.message}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
