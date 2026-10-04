'use client';

import { useEffect, useState } from 'react';

import { IconExternal } from '@/components/icons';
import {
  Field,
  Notice,
  Section,
  SettingsPage,
  StaticValue,
} from '@/components/settings/SettingsParts';
import { operatorDetail } from '@/lib/api';
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
  const [sheet, setSheet] = useState<AccountSheet | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  /*
   * The operator half of a Sheets failure, which the server sends to
   * administrators only. Absent for everybody else, so rendering it
   * unconditionally is safe - there is nothing to render.
   */
  const [sheetDetail, setSheetDetail] = useState<string | null>(null);
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
        setSheet(await sheetApi.get());
      } catch (caught) {
        setSheetError(caught instanceof Error ? caught.message : 'Could not load your sheet.');
        setSheetDetail(operatorDetail(caught));
      }
    })();
  }, []);

  const changeVisibility = async (visibility: SheetVisibility) => {
    setSharing(true);
    setSheetError(null);
    setSheetDetail(null);
    try {
      const result = await sheetApi.setVisibility(visibility);
      // Stored from the response rather than from the option that was picked:
      // the server reads the answer back from Drive, and that is the state that
      // is actually true.
      setSheet((current) => (current ? { ...current, visibility: result.visibility } : current));
    } catch (caught) {
      setSheetError(caught instanceof Error ? caught.message : 'Could not change the sharing.');
      setSheetDetail(operatorDetail(caught));
    } finally {
      setSharing(false);
    }
  };

  /*
   * One error state serves both calls, so it is shown where the call that
   * failed lives: a failed load has no sheet to share, and a failed change has
   * a sheet whose sharing section is the place the reader is looking.
   */
  const errorNotice = sheetError && (
    <Notice tone="error" role="alert">
      <p>{sheetError}</p>
      {/* Administrators only: the server withholds this from everyone else. */}
      {sheetDetail && <p className="mt-2 text-xs opacity-90">{sheetDetail}</p>}
    </Notice>
  );

  return (
    <SettingsPage>
      <Section
        title="Your job sheet"
        description={
          <>
            One Google spreadsheet belongs to this account, with a tab for each day you sign in,
            named like <code className="rounded bg-surface-muted px-1 text-ink">09/17/2026</code>.
            Each tab starts with the job columns - company, job title, link, description, rate and
            your notes.
          </>
        }
      >
        {!sheet && errorNotice}

        {!sheet && !sheetError && (
          <p className="text-sm text-muted" role="status">
            {/* The honest wording. On a new account this call is creating the
                spreadsheet, and "loading" would undersell how long that takes. */}
            Preparing your sheet...
          </p>
        )}

        {sheet && !sheet.configured && (
          <Notice tone="warn">{sheet.message ?? 'Google Sheets is not set up on this server.'}</Notice>
        )}

        {sheet?.configured && sheet.spreadsheetUrl && (
          <>
            <Field label="Today's tab">
              <StaticValue>{sheet.todayTab}</StaticValue>
            </Field>
            <a
              // Today's tab when we know its id, so the link opens the day being
              // worked on rather than whichever tab Google decides to show first
              // - which, once there are thirty of them, is not the one anybody
              // wants.
              href={sheet.todayTabUrl ?? sheet.spreadsheetUrl}
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
              Either way this server keeps its own access, so job links, company names and
              descriptions still load when you generate resumes.
            </p>
          </div>
        </Section>
      )}
    </SettingsPage>
  );
}
