'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { ReporterOnly } from '@/components/auth/AuthGate';
import { IconExternal } from '@/components/icons';
import { Card, ErrorNotice, Notice, Page, PageHeader, Spinner } from '@/components/ui/kit';
import { sheetApi, type AccountSheet } from '@/lib/sheet';

/**
 * Report Jobs: a reporter's home (owner decisions A3, J7).
 *
 * The page every reporter is sent to - from the logo, from AuthGate when they
 * open a page that is not theirs, and after signing in - so it exists before
 * what it is for does. For now it is their own job sheet, which is where every
 * job they report comes from, and a plain note that adding those jobs to the
 * job lake arrives in a later release; the run that does it (pick a tab and
 * rows, "Add to job lake", the "N of M added" line, duplicates in red) fills
 * this page then.
 *
 * Reads only `/api/sheet`, which a reporter may: the builder's sheet routes
 * (`/api/import`) answer them 403 `role-not-allowed`.
 */
function ReportJobsBody() {
  const [sheet, setSheet] = useState<AccountSheet | null>(null);
  // The failure itself, so <ErrorNotice> says it the reader's way (and adds
  // the operator's half for an administrator, which the server decides).
  const [sheetError, setSheetError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const next = await sheetApi.get();
        if (alive) setSheet(next);
      } catch (caught) {
        if (alive) setSheetError(caught ?? new Error('Could not load your sheet.'));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const sheetHref = sheet?.configured ? (sheet.todayTabUrl ?? sheet.spreadsheetUrl ?? '') : '';

  return (
    <Page width="narrow">
      <PageHeader
        title="Report Jobs"
        description="Add the job postings you find to this installation's job lake, and earn for every one it accepts."
      />

      <div className="space-y-6">
        <Card
          title="Your job sheet"
          description="The jobs you report come from your own Google spreadsheet: a tab for each day, a row for each job."
        >
          <ErrorNotice error={sheetError} fallback="Your job sheet could not be reached" />

          {!sheet && sheetError == null && (
            // "Preparing", not "loading": on a new account this read is what
            // creates the spreadsheet, which takes a few round trips to Google.
            <Spinner label="Preparing your sheet..." compact />
          )}

          {sheet && !sheet.configured && (
            <Notice tone="warn">{sheet.message ?? 'Google Sheets is not set up on this server.'}</Notice>
          )}

          {sheetHref && (
            <div className="space-y-4">
              {sheet?.todayTab && (
                <p className="text-sm text-muted">
                  Today&apos;s tab is <span className="font-medium text-ink">{sheet.todayTab}</span>.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                {/* A new tab, like Find Jobs: the sheet is Google's page, and
                    this one should still be here when they come back. */}
                <a href={sheetHref} target="_blank" rel="noreferrer" className="tl-button">
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

        <Notice tone="info">
          Adding jobs from your sheet to the job lake arrives in a later release. Until then, keep listing
          the jobs you find in your sheet - they can be added from it once it does. Your balance and every
          payout recorded to you are under Credits.
        </Notice>
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
