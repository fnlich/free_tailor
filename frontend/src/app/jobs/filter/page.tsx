'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import { Card, ContactAdminFor, ErrorNotice, Field, Notice, Page, PageHeader, Pill } from '@/components/ui/kit';
import { useAuth } from '@/contexts/AuthContext';
import { sheetApi, type AccountSheet } from '@/lib/sheet';
import { importApi, jobsApi, type GoogleSheetJobFilterResponse } from '@/lib/api';
import { chosenTab, hasUnreadTabs, sheetTabOptions, unreadTabsNoteFor, type SheetTabListing } from '@/lib/sheetTabs';
import { describeFilterCounts, describeFilterRow, readFilterRange } from '@/lib/jobFilterDisplay';
import { safeJobLink } from '@/lib/sheetRows';

/**
 * The Job Filter: a tab of the account's own job sheet (All unless another
 * job tab is picked - owner decision S1, there is no other sheet), each row
 * judged on its posting's one analysis, and every verdict shown HERE. Nothing
 * is written into the sheet: its G to L are the analysis's, and the columns a
 * verdict used to go in are gone with the old layout.
 */
export default function JobFilterPage() {
  const { account } = useAuth();
  const isAdmin = account?.role === 'admin';
  const [accountSheet, setAccountSheet] = useState<AccountSheet | null>(null);
  const [listing, setListing] = useState<SheetTabListing | null>(null);
  /** The listing's failure, for <ErrorNotice> to word - often "job sheets are not set up". */
  const [tabsError, setTabsError] = useState<unknown>(null);
  /** The tab picked by hand; empty means the sheet's default, All. */
  const [pickedTab, setPickedTab] = useState('');
  const [startRow, setStartRow] = useState('2');
  /** Empty: to the last row holding a job, which the server finds. */
  const [endRow, setEndRow] = useState('');
  const [summary, setSummary] = useState<GoogleSheetJobFilterResponse | null>(null);
  /** A sentence of the page's own, or a caught failure for <ErrorNotice> to word. */
  const [error, setError] = useState<unknown>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const sheet = await sheetApi.get();
        if (alive) setAccountSheet(sheet);
      } catch {
        // Only the link to the sheet depends on it; the tab list says what is wrong.
      }
    })();
    void (async () => {
      try {
        const answer = await importApi.listTabs();
        if (alive) setListing({ tabs: answer.tabs ?? [], defaultTab: answer.defaultTab ?? null });
      } catch (caught) {
        if (alive) setTabsError(caught ?? new Error('Could not list the tabs of your job sheet.'));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const options = sheetTabOptions(listing?.tabs ?? []);
  const tabName = chosenTab(listing, pickedTab);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const range = readFilterRange({ startRow, endRow });
    if (!range.ok) {
      setError(range.error);
      return;
    }
    if (!tabName) {
      setError('Choose a tab of your job sheet to filter.');
      return;
    }

    setIsLoading(true);
    setError(null);
    setSummary(null);
    try {
      setSummary(
        await jobsApi.filterGoogleSheetJobs({
          tabName,
          startRow: range.startRow,
          ...(range.endRow !== undefined ? { endRow: range.endRow } : {}),
        })
      );
    } catch (caught) {
      setError(caught ?? new Error('Failed to filter the job sheet.'));
    } finally {
      setIsLoading(false);
    }
  };

  const sheetLink = accountSheet?.configured ? accountSheet.defaultTabUrl ?? accountSheet.spreadsheetUrl ?? '' : '';
  const rows = summary?.rows ?? [];

  return (
    <Page>
      <PageHeader
        title="Job Filter"
        description="Pick a tab of your job sheet, and each job is judged on its posting's one job analysis - fetched from its link and analysed once, or reused when the posting was analysed before. Every row's Pass or Fail, and why, is shown here."
        actions={
          // What the run leaves behind, beside the title - the same place the
          // balance sits on /credits. `border-l-4` is not one of the dark-mode
          // shim's names; the bare `border-l` is.
          <div className="w-64 border-l-4 border-line pl-4 text-sm">
            <p className="font-semibold text-ink">Result</p>
            <p className="mt-1 text-muted">Pass or Fail for each row, with the reason. Nothing is written into your sheet.</p>
          </div>
        }
      />

      <Card title="Filter your job sheet">
        <form className="space-y-6" onSubmit={handleSubmit}>
          <Notice tone="neutral">
            Reads Company, Job Title and Job Link (columns C to E) of the tab you pick in{' '}
            {sheetLink ? (
              <a className="tl-link" href={sheetLink} target="_blank" rel="noreferrer">
                your job sheet
              </a>
            ) : (
              'your job sheet'
            )}
            . A row whose posting was analysed before - by a build, a report or an earlier filter - is judged
            without opening its page.
          </Notice>

          <ErrorNotice error={tabsError} fallback="The tabs of your job sheet could not be listed" />

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="sm:col-span-2">
              <Field label="Tab" htmlFor="job-filter-tab">
                <select
                  id="job-filter-tab"
                  value={tabName}
                  onChange={(event) => setPickedTab(event.target.value)}
                  className="tl-input"
                  disabled={isLoading || !tabName}
                >
                  {!tabName && (
                    <option value="">
                      {!listing && !tabsError ? 'Loading tabs...' : options.length === 0 ? 'No tabs found' : 'No job tab to filter'}
                    </option>
                  )}
                  {/* A tab that is not a job tab - an older build's daily tab, a tab of your own - is listed, not chosen. */}
                  {options.map((option) => (
                    <option key={option.title} value={option.title} disabled={!option.usable}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
              {listing && hasUnreadTabs(listing.tabs) && <p className="mt-2 text-sm text-subtle">{unreadTabsNoteFor(listing.tabs)}</p>}
            </div>

            <Field label="From row" htmlFor="job-filter-start-row">
              {/* Text, not a number box: a number box hands over what the browser made of the keys. */}
              <input
                id="job-filter-start-row"
                type="text"
                inputMode="numeric"
                value={startRow}
                onChange={(event) => setStartRow(event.target.value)}
                className="tl-input tabular-nums"
                disabled={isLoading}
              />
            </Field>

            <Field label="To row" htmlFor="job-filter-end-row" hint="Empty for every row.">
              <input
                id="job-filter-end-row"
                type="text"
                inputMode="numeric"
                value={endRow}
                placeholder="Last row"
                onChange={(event) => setEndRow(event.target.value)}
                className="tl-input tabular-nums"
                disabled={isLoading}
              />
            </Field>
          </div>

          {/*
            Where the analysis is decided is for the person who can change it.
            The filter has no prompt or model of its own any more: a row is
            judged by rules in code on the facts its posting's one analysis
            read, and a posting analysed by a build, or by an earlier run of
            this filter, is not analysed again.
          */}
          {isAdmin && (
            <Notice tone="info">
              Each posting is judged on its one job analysis: made by the{' '}
              <span className="font-semibold">Analyze Job Description</span> prompt on the analysis model, once, the
              first time anything needs it. Choose the model under{' '}
              <Link href="/admin/settings" className="font-semibold underline underline-offset-2">
                Settings &gt; General
              </Link>{' '}
              and edit the prompt in{' '}
              <Link href="/admin/prompts" className="font-semibold underline underline-offset-2">
                Admin Prompts
              </Link>
              ; either change applies to postings not analysed yet.
            </Notice>
          )}

          <div className="flex flex-wrap gap-3">
            <button type="submit" disabled={isLoading || !tabName} className="tl-button">
              {isLoading ? 'Filtering jobs...' : 'Run job filter'}
            </button>
          </div>
        </form>

        <ErrorNotice error={error} fallback="Failed to filter the job sheet" className="mt-4" onDismiss={() => setError(null)} />
      </Card>

      {summary && (
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
                  ['Analysis model', summary.modelLabel || 'App default'],
                  ['Scraped pages', summary.scrapedRows],
                  // Judged on an analysis the posting already had, found by
                  // its link: no page fetched and no model asked.
                  ['Already analysed', summary.reusedAnalyses ?? 0],
                  ['Rows without a link', summary.skippedRows],
                  ['Rows with errors', summary.errorRows],
                  ['Rows', summary.endRow >= summary.startRow ? `${summary.startRow} to ${summary.endRow}` : 'None'],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-sm text-muted">{label}</dt>
                  <dd className="mt-1 break-words text-base font-semibold text-ink tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>

            {summary.message && (
              <Notice tone="neutral" className="mt-6">
                {summary.message}
              </Notice>
            )}

            {rows.length > 0 && (
              <div className="mt-6 space-y-3">
                <p className="text-sm text-muted" data-testid="filter-counts">
                  {describeFilterCounts(rows)}.
                </p>
                {/*
                  Colours on a .tl-table cell go on an inner span - the
                  unlayered `td` rule beats a utility on the cell itself.
                */}
                <div className="tl-table-box">
                  <table className="tl-table">
                    <caption className="sr-only">Each row&apos;s verdict</caption>
                    <thead>
                      <tr>
                        <th scope="col" className="w-16">Row</th>
                        <th scope="col">Company</th>
                        <th scope="col">Job title</th>
                        <th scope="col">Link</th>
                        <th scope="col">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => {
                        const note = describeFilterRow(row);
                        const link = safeJobLink(row.link);
                        return (
                          <tr key={row.row}>
                            <td>
                              <span className="tabular-nums text-ink">{row.row}</span>
                            </td>
                            <td className="min-w-32">
                              <span className="break-words">{row.company || '-'}</span>
                            </td>
                            <td className="min-w-32">
                              <span className="break-words">{row.title || '-'}</span>
                            </td>
                            <td className="max-w-56">
                              {link ? (
                                <a href={link} target="_blank" rel="noopener noreferrer" className="tl-link block truncate" title={link}>
                                  {new URL(link).hostname}
                                </a>
                              ) : (
                                <span className="text-subtle">-</span>
                              )}
                            </td>
                            <td className="min-w-48">
                              <span className="flex flex-col items-start gap-1" title={row.result === 'Fail' ? row.reason : undefined}>
                                <Pill tone={note.tone}>{note.label}</Pill>
                                {note.detail && (
                                  <span className="break-words text-xs text-muted">
                                    {note.detail}
                                    {/* A row that failed says the server's sentence, which may ask for an administrator. */}
                                    {row.error && <ContactAdminFor text={row.error} />}
                                  </span>
                                )}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </Card>
        </div>
      )}
    </Page>
  );
}
