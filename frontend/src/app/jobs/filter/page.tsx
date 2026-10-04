'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import { Card, Field, Notice, Page, PageHeader } from '@/components/ui/kit';
import { useAuth } from '@/contexts/AuthContext';
import {
  parsePositiveWholeNumber,
  parseSpreadsheetColumnInput,
  toSpreadsheetColumnLabel,
  sheetApi,
  type AccountSheet,
} from '@/lib/sheet';
import {
  adminApi,
  GoogleSheetJobFilterResponse,
  GoogleSheetSource,
  GoogleSheetTab,
  importApi,
  jobsApi,
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

export default function JobFilterPage() {
  const [sheetSources, setSheetSources] = useState<GoogleSheetSource[]>([]);
  const [sheetTabs, setSheetTabs] = useState<GoogleSheetTab[]>([]);
  const [sheetTitle, setSheetTitle] = useState('');
  const { account } = useAuth();
  const isAdmin = account?.role === 'admin';
  const [accountSheet, setAccountSheet] = useState<AccountSheet | null>(null);
  // Ordinary accounts filter their own sheet and nothing else.
  const [target, setTarget] = useState<'mine' | 'shared'>('mine');
  const [form, setForm] = useState<FilterFormState>(DEFAULT_FORM);
  const [summary, setSummary] = useState<GoogleSheetJobFilterResponse | null>(null);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingTabs, setIsLoadingTabs] = useState(false);

  const setField = <K extends keyof FilterFormState>(field: K, value: FilterFormState[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  /*
   * The shared sheets are an administrator's, configured under Admin, and only
   * an administrator may filter one - so only an administrator's page asks for
   * them, from the admin settings that hold them. Everybody else filters their
   * own job sheet, which needs no list at all.
   */
  useEffect(() => {
    if (!isAdmin) return;
    let isMounted = true;

    const loadSettings = async () => {
      try {
        const nextSettings = await adminApi.getSettings();
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

        setError(err instanceof Error ? err.message : 'Failed to load the shared Google Sheets');
      }
    };

    void loadSettings();

    return () => {
      isMounted = false;
    };
  }, [isAdmin]);

  useEffect(() => {
    void (async () => {
      try {
        setAccountSheet(await sheetApi.get());
      } catch {
        setAccountSheet(null);
      }
    })();
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
      // Own sheet: send nothing. The server knows the spreadsheet, today's
      // tab, which column the job links are in, and that the verdict belongs
      // in `Filter Result` with its reason in `Filter Reason`. It also decides
      // the last row, so
      // "everything in today's tab" needs no arithmetic here.
      let payload: Parameters<typeof jobsApi.filterGoogleSheetJobs>[0] = {};

      if (target === 'shared') {
        const startRow = parsePositiveWholeNumber('Start row', form.startRow);
        const endRow = parsePositiveWholeNumber('End row', form.endRow);
        const jobLinkCol = parseSpreadsheetColumnInput('Job link column', form.jobLinkCol);
        const resultCol = parseSpreadsheetColumnInput('Result column', form.resultCol);
        const reasonCol = parseSpreadsheetColumnInput('Reason column', form.reasonCol);

        // Same reason as the export page: an empty id would resolve to the
        // caller's own sheet, which is not what "a shared sheet" asked for.
        if (!form.sheetId.trim()) {
          throw new Error('Choose a shared Google Sheet, or switch back to your own job sheet.');
        }

        if (!form.tabName.trim()) {
          throw new Error('Sheet tab is required.');
        }

        if (startRow > endRow) {
          throw new Error('Start row must be less than or equal to end row.');
        }

        const distinctColumns = [jobLinkCol, resultCol, reasonCol];

        if (new Set(distinctColumns).size !== distinctColumns.length) {
          throw new Error('Job link and output columns must all be different.');
        }

        payload = {
          sheetId: form.sheetId.trim(),
          tabName: form.tabName.trim(),
          startRow,
          endRow,
          jobLinkCol,
          resultCol,
          reasonCol,
        };
      }

      setIsLoading(true);
      setError('');
      setSummary(null);

      const response = await jobsApi.filterGoogleSheetJobs(payload);

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
    <Page>
      <PageHeader
        title="Job Filter"
        description="Select a sheet and tab, scrape each job link, classify it with the saved prompt, then write a final Pass or Fail result back to Google Sheets."
        actions={
          // What the run leaves behind, beside the title - the same place the
          // balance sits on /credits. `border-l-4` is not one of the dark-mode
          // shim's names; the bare `border-l` is.
          <div className="w-64 border-l-4 border-line pl-4 text-sm">
            <p className="font-semibold text-ink">Result</p>
            <p className="mt-1 text-muted">Writes `Pass` or `Fail`, plus a fail reason when one applies.</p>
          </div>
        }
      />

      <Card title="Filter Google Sheet Jobs">
        <form className="space-y-6" onSubmit={handleSubmit}>
          {isAdmin && (
            <div className="tl-card inline-flex flex-wrap gap-1 p-1">
              {(['mine', 'shared'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setTarget(option)}
                  disabled={isLoading}
                  className="tl-subtab"
                  data-active={target === option}
                  aria-pressed={target === option}
                >
                  {option === 'mine' ? 'My job sheet' : 'A shared sheet'}
                </button>
              ))}
            </div>
          )}

          {target === 'mine' ? (
            <Notice tone="neutral">
              {accountSheet?.configured && accountSheet.spreadsheetUrl ? (
                <>
                  Filters every job on the{' '}
                  <a
                    className="tl-link"
                    href={accountSheet.todayTabUrl ?? accountSheet.spreadsheetUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {accountSheet.todayTab}
                  </a>{' '}
                  tab of your job sheet, reading the Job Link column and writing the verdict into
                  <span className="font-semibold"> Filter Result</span> with its reason in
                  <span className="font-semibold"> Filter Reason</span>. Your own fields — Rate,
                  note and Job Finder — are never written to. Rows already judged are skipped.
                </>
              ) : (
                "Filters every job on today's tab of your own job sheet."
              )}
            </Notice>
          ) : (
          <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_220px_auto] lg:items-end">
            <Field label="Google Sheet" htmlFor="job-filter-sheet">
              <select
                id="job-filter-sheet"
                value={form.sheetId}
                onChange={(event) => {
                  setField('sheetId', event.target.value);
                  setField('tabName', '');
                  setSheetTabs([]);
                  setSheetTitle('');
                }}
                className="tl-input"
                disabled={isLoading || (target === 'shared' && !hasSavedSheets)}
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
            </Field>

            <Field label="Sheet tab" htmlFor="job-filter-tab">
              <select
                id="job-filter-tab"
                value={form.tabName}
                onChange={(event) => setField('tabName', event.target.value)}
                className="tl-input"
                disabled={isLoading || isLoadingTabs || sheetTabs.length === 0}
              >
                <option value="">{sheetTabs.length ? 'Choose a tab' : 'Load tabs first'}</option>
                {sheetTabs.map((tab) => (
                  <option key={tab.sheetId} value={tab.title}>
                    {tab.title}
                  </option>
                ))}
              </select>
            </Field>

            <button
              type="button"
              onClick={handleLoadTabs}
              disabled={isLoading || isLoadingTabs || !form.sheetId.trim()}
              className="tl-button-quiet w-full lg:w-auto"
            >
              {isLoadingTabs ? 'Loading tabs...' : 'Load tabs'}
            </button>
          </div>

          {sheetTitle && (
            <Notice tone="success">
              Connected to <span className="font-semibold">{sheetTitle}</span>.
            </Notice>
          )}

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <Field label="Start row" htmlFor="job-filter-start-row">
              <input
                id="job-filter-start-row"
                type="number"
                min={1}
                step={1}
                value={form.startRow}
                onChange={(event) => setField('startRow', event.target.value)}
                className="tl-input"
                disabled={isLoading}
              />
            </Field>

            <Field label="End row" htmlFor="job-filter-end-row">
              <input
                id="job-filter-end-row"
                type="number"
                min={1}
                step={1}
                value={form.endRow}
                onChange={(event) => setField('endRow', event.target.value)}
                className="tl-input"
                disabled={isLoading}
              />
            </Field>

            <Field label="Job link column" htmlFor="job-filter-link-col">
              <input
                id="job-filter-link-col"
                type="text"
                value={form.jobLinkCol}
                onChange={(event) => setField('jobLinkCol', event.target.value.toUpperCase())}
                className="tl-input"
                disabled={isLoading}
              />
            </Field>

            <Field label="Result column" htmlFor="job-filter-result-col">
              <input
                id="job-filter-result-col"
                type="text"
                value={form.resultCol}
                onChange={(event) => setField('resultCol', event.target.value.toUpperCase())}
                className="tl-input"
                disabled={isLoading}
              />
            </Field>

            <Field label="Reason column" htmlFor="job-filter-reason-col">
              <input
                id="job-filter-reason-col"
                type="text"
                value={form.reasonCol}
                onChange={(event) => setField('reasonCol', event.target.value.toUpperCase())}
                className="tl-input"
                disabled={isLoading}
              />
            </Field>
          </div>
          </>
          )}

          {/* Where the prompt lives is for the person who can edit it. */}
          {isAdmin && (
            <Notice tone="info">
              Uses the live <span className="font-semibold">Filter Google Sheet Job</span> prompt from{' '}
              prompt library. Edit it in{' '}
              <Link href="/admin/prompts" className="font-semibold underline underline-offset-2">
                Admin Prompts
              </Link>{' '}
              and changes will apply here automatically.
            </Notice>
          )}

          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              // Gated on the shared source ONLY when that is what was chosen.
              // Gating it always made the ordinary path - your own sheet, which
              // needs no configuration at all - impossible to run on an install
              // where no administrator had ever saved a shared sheet.
              disabled={isLoading || (target === 'shared' && !hasSavedSheets)}
              className="tl-button"
            >
              {isLoading ? 'Filtering jobs...' : 'Run job filter'}
            </button>
          </div>
        </form>

        {error && (
          <Notice tone="error" className="mt-4">
            {error}
          </Notice>
        )}

        {/* Only where a shared sheet was asked for: the own-sheet path needs none. */}
        {isAdmin && target === 'shared' && !hasSavedSheets && (
          <Notice tone="warn" className="mt-4">
            Save at least one Google Sheet in the Admin Google Sheets panel before using this filter.
          </Notice>
        )}
      </Card>

      {summary && !error && (
        <div className="mt-8">
          <Card
            title={
              <>
                Processed {summary.processedRows} row{summary.processedRows === 1 ? '' : 's'} in {summary.spreadsheetTitle} / {summary.selectedTab}
              </>
            }
          >
            <dl className="grid grid-cols-2 gap-x-6 gap-y-5 xl:grid-cols-4">
              {(
                [
                  ['Scanned', summary.scannedRows],
                  // The administrator's name for the model, never the provider
                  // or the CLI's own id for it.
                  ['Model', summary.modelLabel || 'App default'],
                  ['Scraped pages', summary.scrapedRows],
                  ['Skipped rows', summary.skippedRows],
                  ['Rows with errors', summary.errorRows],
                  ['Job link column', toSpreadsheetColumnLabel(summary.jobLinkCol)],
                  ['Result column', toSpreadsheetColumnLabel(summary.resultCol)],
                  ['Reason column', toSpreadsheetColumnLabel(summary.reasonCol)],
                  ['Rows', `${summary.startRow} to ${summary.endRow}`],
                  ['Updated ranges', summary.updatedRanges.join(', ')],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-sm text-muted">{label}</dt>
                  <dd className="mt-1 break-words text-base font-semibold text-ink tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>

            {summary.rowErrors.length > 0 && (
              // Colours on a .tl-table cell go on an inner span - the unlayered
              // `td` rule beats a utility on the cell itself.
              <div className="tl-table-box mt-6">
                <table className="tl-table">
                  <thead>
                    <tr>
                      <th scope="col" className="w-24">Row</th>
                      <th scope="col">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.rowErrors.map((item) => (
                      <tr key={`${item.row}-${item.message}`}>
                        <td>
                          <span className="tabular-nums text-ink">{item.row}</span>
                        </td>
                        <td>{item.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
    </Page>
  );
}
