'use client';

import { useEffect, useState } from 'react';

import { IconExternal } from '@/components/icons';
import {
  ErrorNotice,
  Field,
  Notice,
  Section,
  SettingsPage,
} from '@/components/settings/SettingsParts';
import { useAuth } from '@/contexts/AuthContext';
import { sheetApi, type AccountSheet, type SheetVisibility } from '@/lib/sheet';

const VISIBILITY_OPTIONS: Array<{ value: SheetVisibility; label: string; summary: string }> = [
  {
    value: 'public',
    label: 'Anyone with the link',
    summary: 'Whoever has the link can open the sheet and edit it.',
  },
  {
    value: 'private',
    label: 'Only me',
    summary: 'The link opens it only for the address you sign in with.',
  },
];

/**
 * Settings > Job Sheet: the account's own Google spreadsheet, and who else the
 * link lets in.
 */
export default function JobSheetSettingsPage() {
  // A reporter's sheet is where the jobs they report come from, not resumes.
  const { isReporter } = useAuth();
  const [sheet, setSheet] = useState<AccountSheet | null>(null);
  /*
   * The failure itself rather than its text: <ErrorNotice> turns it into the
   * reader's sentence, and for an administrator adds the operator half the
   * server attaches to a Sheets failure (and withholds from everybody else).
   */
  const [sheetError, setSheetError] = useState<unknown>(null);
  const [sharing, setSharing] = useState(false);

  /**
   * Loaded on its own, and slowly the first time.
   *
   * On a brand new account this call is what creates the spreadsheet, which is
   * several round trips to Google, so the page says "preparing" rather than
   * "loading" while it waits.
   */
  useEffect(() => {
    void (async () => {
      try {
        // The one reader that asks for the tabs to be looked at again: the
        // conflict note below tells the person to rename and reload here, and
        // an All or Temp For AI deleted in Google Sheets is put back by it.
        setSheet(await sheetApi.get({ recheck: true }));
      } catch (caught) {
        setSheetError(caught ?? new Error('Could not load your sheet.'));
      }
    })();
  }, []);

  const changeVisibility = async (visibility: SheetVisibility) => {
    setSharing(true);
    setSheetError(null);
    try {
      const result = await sheetApi.setVisibility(visibility);
      // Stored from the response rather than from the option that was picked:
      // the server reads the answer back from Drive, and that is the state that
      // is actually true.
      setSheet((current) => (current ? { ...current, visibility: result.visibility } : current));
    } catch (caught) {
      setSheetError(caught ?? new Error('Could not change the sharing.'));
    } finally {
      setSharing(false);
    }
  };

  /*
   * One error state serves both calls, so it is shown where the call that
   * failed lives: a failed load has no sheet to share, and a failed change has
   * a sheet whose sharing section is the place the reader is looking.
   */
  const errorNotice = <ErrorNotice error={sheetError} fallback="Your job sheet could not be reached" />;

  return (
    <SettingsPage>
      <Section
        title="Your job sheet"
        description={
          <>
            One Google spreadsheet belongs to this account, with two tabs of the app&apos;s:{' '}
            <span className="font-medium text-ink">All</span>, which every job page reads and writes unless you
            pick another tab, and <span className="font-medium text-ink">Temp For AI</span>. Each starts with the
            columns that are yours - Date, NO(DATE), Company, Job Title, Job Link and Job Description - then six
            only the app can edit, filled from each posting&apos;s analysis: Job Field, Salary, Job Type,
            Clearance, Industry and Analysis.
          </>
        }
      >
        {!sheet && errorNotice}

        {!sheet && sheetError == null && (
          <p className="text-sm text-muted" role="status">
            {/* The honest wording. On a new account this call is creating the
                spreadsheet, and "loading" would undersell how long that takes. */}
            Preparing your sheet...
          </p>
        )}

        {sheet && !sheet.configured && (
          <Notice tone="warn">{sheet.message ?? 'Google Sheets is not set up on this server.'}</Notice>
        )}

        {/*
          A tab of the person's own already holds the name All or Temp For
          AI, so the app left it alone and has no tab of its own there - in
          the server's words, which say how to fix it. Reloading this page is
          what makes the server look again.
        */}
        {sheet?.configured && sheet.conflict && <Notice tone="warn">{sheet.conflict.message}</Notice>}

        {sheet?.configured && sheet.spreadsheetUrl && (
          <>
            <Field label="Tabs">
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                <TabLink name={sheet.defaultTab} url={sheet.defaultTabUrl} />
                <TabLink name={sheet.tempTab} url={sheet.tempTabUrl} />
              </div>
            </Field>
            <a
              // All when we know its id, so the link opens the tab the job
              // pages write to rather than whichever tab Google shows first -
              // after an upgrade, an older build's daily tabs are still there.
              href={sheet.defaultTabUrl ?? sheet.spreadsheetUrl}
              target="_blank"
              rel="noreferrer"
              className="tl-button"
            >
              Open in Google Sheets
              <IconExternal className="h-4 w-4" />
            </a>
          </>
        )}
      </Section>

      {sheet?.configured && sheet.spreadsheetUrl && (
        <Section
          title="Who can open it"
          description="Whether the link on its own is enough to open the sheet."
        >
          {errorNotice}

          <fieldset disabled={sharing} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <legend className="sr-only">Who can open your job sheet</legend>
            {VISIBILITY_OPTIONS.map((option) => {
              const current = sheet.visibility === option.value;
              return (
                <label key={option.value} className="tl-choice" data-on={current}>
                  <input
                    type="radio"
                    name="sheet-visibility"
                    value={option.value}
                    checked={current}
                    onChange={() => void changeVisibility(option.value)}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink">{option.label}</span>
                    <span className="mt-0.5 block text-sm text-muted">{option.summary}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          <div className="space-y-1">
            {/* Named plainly, because the link is the only thing between a
                stranger and rewriting these rows. */}
            <p className="text-sm text-ink" aria-live="polite">
              {sharing
                ? 'Changing who can open it...'
                : sheet.visibility === 'public'
                  ? 'Anyone who has the link can open this sheet and edit it. Share the link carefully.'
                  : 'Only you can open this sheet. Your account keeps edit access through the address you sign in with.'}
            </p>
            <p className="text-sm text-subtle">
              {isReporter
                ? 'Either way this server keeps its own access, so the jobs you report can still be read from it.'
                : 'Either way this server keeps its own access, so job links, company names and descriptions still load when you generate resumes.'}
            </p>
          </div>
        </Section>
      )}
    </SettingsPage>
  );
}

/**
 * One of the app's two tabs: a link that opens it, or - while its name is a
 * tab of the person's own (the conflict above) - the name alone, since the
 * app has no tab of its own there to open.
 */
function TabLink({ name, url }: { name: string; url?: string }) {
  if (!url) {
    return (
      <span className="text-sm text-muted">
        {name} <span className="text-subtle">(not added yet)</span>
      </span>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="tl-link inline-flex items-center gap-1 text-sm">
      {name}
      <IconExternal className="h-3.5 w-3.5" />
    </a>
  );
}
