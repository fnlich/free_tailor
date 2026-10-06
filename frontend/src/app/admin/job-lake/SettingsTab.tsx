'use client';

import { useEffect, useState, type FormEvent } from 'react';

import Dialog from '@/components/ui/Dialog';
import { Card, ErrorNotice, Field, Notice, Spinner, StaticValue, Status } from '@/components/ui/kit';
import { ApiResponseError } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { adminJobLakeApi, type AdminLakeSyncStatus, type LakeSettingsAnswer } from '@/lib/jobLake';
import {
  describeDailyCap,
  describeDuplicateWindow,
  describeGlobalRate,
  describeSyncReport,
  describeSyncState,
  DUPLICATE_WINDOW_MAX_DAYS,
  DUPLICATE_WINDOW_MIN_DAYS,
  lakeSettingsChanges,
  lakeSettingsDraft,
  lakeSettingsProblems,
  safeWebLink,
  settingsFieldForCode,
  type LakeSettingsDraft,
  type LakeSettingsProblems,
  windowPlaceholder,
} from '@/lib/jobLakeDisplay';
import { messageWithDetail } from '@/lib/userMessage';

/**
 * The Settings tab: what the lake pays and how it decides a duplicate (owner
 * decisions J2b, J7), and the admin sheet every added job is copied to (J9,
 * J10).
 *
 *  - The GLOBAL rate per job, dollars in $0.001 steps: what a reporter
 *    without a rate of their own (Admin -> Accounts) is paid. Unset is
 *    $0, and the page says nobody is paid until it is set.
 *  - The duplicate window in days, and where the value in effect comes from:
 *    the one set here, `JOB_LAKE_DUPLICATE_WINDOW_DAYS` in .env, or the
 *    built-in 60 - the one set here wins.
 *  - An optional daily cap per reporter.
 *  - The admin sheet: its link, who it is shared with, how many jobs wait to
 *    be appended and why the last attempt failed, and "Retry now".
 *
 * Every amount is SENT as typed (`reportRateUsd`, `dailyCapUsd`) and only
 * what changed is sent; the server parses it again and refuses by name.
 */

/** How often a sync that is running is asked about. */
const SYNC_POLL_MS = 2000;

export default function SettingsTab({ onSync }: { onSync?: (sync: AdminLakeSyncStatus) => void }) {
  const [answer, setAnswer] = useState<LakeSettingsAnswer | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [draft, setDraft] = useState<LakeSettingsDraft>({ rate: '', window: '', cap: '' });
  /** A box's problem as the SERVER said it, until that box is edited. */
  const [refused, setRefused] = useState<LakeSettingsProblems>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<{ tone: 'success' | 'warn'; text: string } | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetError, setSheetError] = useState<unknown>(null);
  const [confirmRecreate, setConfirmRecreate] = useState(false);

  const adopt = (next: LakeSettingsAnswer) => {
    setAnswer(next);
    setDraft(lakeSettingsDraft(next.settings));
    setRefused({});
    onSync?.(next.sync);
  };

  useEffect(() => {
    let alive = true;
    adminJobLakeApi.settings().then(
      (next) => {
        if (!alive) return;
        setAnswer(next);
        setDraft(lakeSettingsDraft(next.settings));
        onSync?.(next.sync);
      },
      (caught: unknown) => {
        if (alive) setLoadError(caught ?? new Error('Could not load the job lake settings.'));
      }
    );
    return () => {
      alive = false;
    };
    // `onSync` is the parent's state setter, so this reads the settings once, on arrival.
  }, [onSync]);

  // A sync that is running (after a run, a merge, a Retry now elsewhere) is
  // followed until it is not, so the waiting count and the error move.
  const running = answer?.sync.running ?? false;
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const timer = setTimeout(() => {
      adminJobLakeApi.sync().then(
        (next) => {
          if (!alive) return;
          setAnswer((current) => (current ? { ...current, sheet: next.sheet, sync: next.sync } : current));
          onSync?.(next.sync);
        },
        () => undefined
      );
    }, SYNC_POLL_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [running, answer?.sync, onSync]);

  if (loadError) return <ErrorNotice error={loadError} fallback="The job lake settings could not be loaded" />;
  if (!answer) return <Spinner />;

  const { settings, sheet, sync } = answer;
  const problems: LakeSettingsProblems = { ...lakeSettingsProblems(draft), ...refused };
  const changes = lakeSettingsChanges(draft, settings);
  const nothingChanged = changes !== null && Object.keys(changes).length === 0;

  const edit = (key: keyof LakeSettingsDraft) => (value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setRefused((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setSaved(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!changes || Object.keys(changes).length === 0) return;
    setSaving(true);
    setSaved(null);
    try {
      adopt(await adminJobLakeApi.saveSettings(changes));
      setSaved({ tone: 'ok', text: 'Saved. The next job the lake accepts is paid and judged by these.' });
    } catch (caught) {
      const field = caught instanceof ApiResponseError ? settingsFieldForCode(caught.code) : null;
      if (field) setRefused({ [field]: caught instanceof Error ? caught.message : '' });
      else setSaved({ tone: 'error', text: messageWithDetail(caught, 'The settings could not be saved.') });
    } finally {
      setSaving(false);
    }
  };

  const retry = async () => {
    setSyncing(true);
    setSyncNote(null);
    try {
      const next = await adminJobLakeApi.retrySync();
      setAnswer((current) => (current ? { ...current, sheet: next.sheet, sync: next.sync } : current));
      onSync?.(next.sync);
      setSyncNote(describeSyncReport(next.report));
    } catch (caught) {
      setSyncNote({ tone: 'warn', text: messageWithDetail(caught, 'The admin sheet could not be updated.') });
    } finally {
      setSyncing(false);
    }
  };

  const createSheet = async (recreate: boolean) => {
    setSheetBusy(true);
    setSheetError(null);
    setSyncNote(null);
    try {
      const next = await adminJobLakeApi.createSheet(recreate);
      setAnswer((current) => (current ? { ...current, sheet: next.sheet, sync: next.sync } : current));
      onSync?.(next.sync);
      setConfirmRecreate(false);
    } catch (caught) {
      setSheetError(caught ?? new Error('Could not set up the admin sheet.'));
    } finally {
      setSheetBusy(false);
    }
  };

  const state = describeSyncState(sheet, sync);
  const sheetHref = sheet ? safeWebLink(sheet.spreadsheetUrl) : null;

  return (
    <div className="space-y-8">
      <Card
        title="Pay and duplicates"
        description="What a reporter earns for each job the lake accepts, and how recent a job must be to count as a duplicate."
      >
        <form onSubmit={save} className="space-y-6" noValidate>
          <div className="grid gap-6 lg:grid-cols-3">
            <Field label="Global rate per job ($)" htmlFor="lake-rate" hint={problems.rate ? undefined : describeGlobalRate(settings)}>
              {/* Text, never a number box: in an en-US browser a number box turns "0,023" into "0023". */}
              <input
                id="lake-rate"
                type="text"
                inputMode="decimal"
                value={draft.rate}
                onChange={(event) => edit('rate')(event.target.value)}
                placeholder="0.000"
                aria-describedby="lake-rate-steps"
                aria-invalid={Boolean(problems.rate)}
                className="tl-input tabular-nums"
              />
              <p id="lake-rate-steps" className="mt-2 text-xs text-subtle">
                In steps of $0.001, from $0 to $1,000. Empty: not set, nobody paid.
              </p>
              {problems.rate && (
                <p className="tl-status mt-2" data-tone="error" role="alert">
                  {problems.rate}
                </p>
              )}
            </Field>

            <Field
              label="Duplicate window (days)"
              htmlFor="lake-window"
              hint={problems.window ? undefined : describeDuplicateWindow(settings.duplicateWindow)}
            >
              <input
                id="lake-window"
                type="text"
                inputMode="numeric"
                value={draft.window}
                onChange={(event) => edit('window')(event.target.value)}
                placeholder={windowPlaceholder(settings.duplicateWindow)}
                aria-invalid={Boolean(problems.window)}
                className="tl-input tabular-nums"
              />
              <p className="mt-2 text-xs text-subtle">
                A whole number from {DUPLICATE_WINDOW_MIN_DAYS} to {DUPLICATE_WINDOW_MAX_DAYS}. A job the lake added or
                last replaced within it is a duplicate - red, not paid; an older one is replaced and counts as added.
                Empty: .env decides.
              </p>
              {problems.window && (
                <p className="tl-status mt-2" data-tone="error" role="alert">
                  {problems.window}
                </p>
              )}
            </Field>

            <Field label="Daily cap per reporter ($)" htmlFor="lake-cap" hint={problems.cap ? undefined : describeDailyCap(settings.dailyCapMilli)}>
              <input
                id="lake-cap"
                type="text"
                inputMode="decimal"
                value={draft.cap}
                onChange={(event) => edit('cap')(event.target.value)}
                placeholder="No cap"
                aria-invalid={Boolean(problems.cap)}
                className="tl-input tabular-nums"
              />
              {problems.cap && (
                <p className="tl-status mt-2" data-tone="error" role="alert">
                  {problems.cap}
                </p>
              )}
            </Field>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3">
            {settings.updatedAt && (
              <p className="mr-auto text-xs text-subtle">Last changed {formatDate(settings.updatedAt)}.</p>
            )}
            <button type="submit" className="tl-button" disabled={saving || changes === null || nothingChanged}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
          {saved && <Status tone={saved.tone}>{saved.text}</Status>}
        </form>
      </Card>

      <Card
        title="Admin sheet"
        description="A spreadsheet the server keeps for administrators: every job the lake adds is appended to it, a line per job."
      >
        <div className="space-y-5">
          <Notice tone={state.tone} role="status">
            {state.text}
          </Notice>

          {sheet && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Spreadsheet">
                <StaticValue>
                  {sheetHref ? (
                    <a href={sheetHref} target="_blank" rel="noreferrer" className="tl-link">
                      Open the admin sheet
                    </a>
                  ) : (
                    <span className="break-all font-mono text-xs">{sheet.spreadsheetId}</span>
                  )}
                  <span className="text-subtle"> · tab {sheet.tabName}, made {formatDate(sheet.createdAt)}</span>
                </StaticValue>
              </Field>
              <Field label="Shared with">
                <StaticValue>
                  {sheet.sharedWith.length > 0 ? sheet.sharedWith.join(', ') : 'Nobody yet'}
                </StaticValue>
              </Field>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Waiting to be added">
              <StaticValue>{sync.unsynced}</StaticValue>
            </Field>
            <Field label="Last attempt">
              <StaticValue>{sync.lastAttemptAt ? formatDate(sync.lastAttemptAt) : 'Never'}</StaticValue>
            </Field>
            <Field label="Last success">
              <StaticValue>
                {sync.lastSuccessAt
                  ? `${formatDate(sync.lastSuccessAt)} (${sync.lastAppended} added)`
                  : 'Never'}
              </StaticValue>
            </Field>
          </div>

          {sync.lastError && (
            <div className="tl-notice" data-tone="warn">
              <p className="font-medium">Why the last attempt failed</p>
              {/* For administrators: the server's own words, which this page is the only place to read. */}
              <p className="mt-1 whitespace-pre-wrap break-words text-sm">{sync.lastError}</p>
            </div>
          )}

          {syncNote && (
            <Notice tone={syncNote.tone} role="status">
              {syncNote.text}
            </Notice>
          )}
          <ErrorNotice error={sheetError} fallback="The admin sheet could not be set up" onDismiss={() => setSheetError(null)} />

          <div className="flex flex-wrap items-center justify-end gap-3">
            {sheet ? (
              <button
                type="button"
                className="tl-button-quiet"
                // Not while a sync is sending. The server copes - that sync
                // stops and goes round again on the new sheet - but this card
                // would show the old sheet's progress until it does.
                disabled={sheetBusy || syncing || sync.running}
                onClick={() => setConfirmRecreate(true)}
              >
                Create a new admin sheet
              </button>
            ) : (
              <button type="button" className="tl-button-quiet" disabled={sheetBusy} onClick={() => void createSheet(false)}>
                {sheetBusy ? 'Creating...' : 'Create the admin sheet now'}
              </button>
            )}
            <button
              type="button"
              className="tl-button"
              disabled={syncing || sync.running || sheetBusy}
              onClick={() => void retry()}
            >
              {syncing || sync.running ? 'Sending...' : 'Retry now'}
            </button>
          </div>
        </div>
      </Card>

      <Dialog
        open={confirmRecreate}
        title="Create a new admin sheet?"
        onClose={() => {
          if (!sheetBusy) setConfirmRecreate(false);
        }}
        footer={
          <>
            <button type="button" className="tl-button-quiet" disabled={sheetBusy} onClick={() => setConfirmRecreate(false)}>
              Cancel
            </button>
            <button type="button" className="tl-button" disabled={sheetBusy} onClick={() => void createSheet(true)}>
              {sheetBusy ? 'Creating...' : 'Create a new sheet'}
            </button>
          </>
        }
      >
        <p className="text-sm text-muted">
          For when the admin sheet was deleted or lost in Google. A new spreadsheet is made, shared with every enabled
          administrator, and sent every job in the lake. The old one is left as it is; nothing in the lake changes.
        </p>
        <ErrorNotice error={sheetError} fallback="The admin sheet could not be set up" className="mt-4" />
      </Dialog>
    </div>
  );
}
