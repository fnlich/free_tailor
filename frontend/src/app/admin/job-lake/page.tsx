'use client';

import { Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { AdminOnly } from '@/components/auth/AuthGate';
import { Pill, Spinner } from '@/components/ui/kit';
import { adminJobLakeApi, type AdminLakeSyncStatus } from '@/lib/jobLake';
import LakeTab from './LakeTab';
import MergeTab from './MergeTab';
import SettingsTab from './SettingsTab';

/**
 * Admin -> Job Lake (owner decisions J2b, J6, J7, J9, J10): the Job Data
 * Lake reporters fill and builds are merged into.
 *
 *  - **Lake**: query the lake - full text, company (compared the way the
 *    lake compares companies), job field, salary, who reported it, when -
 *    page through it, open a row with its history, delete one (optionally
 *    revoking its reward) or revoke a reward on its own.
 *  - **Merge**: the postings builds analysed that nobody has merged yet;
 *    merge some or all, with the duplicates reported. Nobody is paid.
 *  - **Settings**: the global rate per job ($0.001 steps), the duplicate
 *    window and where the value in effect comes from, the optional daily
 *    cap, and the admin sheet with its sync status and "Retry now".
 *
 * The tab is in the URL (`?tab=merge`, `?tab=settings`) and only there, as
 * Payments does it, so a link can land on one.
 *
 * A Settings tab of the shell, so it opens with an h2 under the shell's
 * Settings title; under `/admin`, so the nav comes from that layout.
 */

type LakeTabId = 'lake' | 'merge' | 'settings';

const TABS: Array<{ id: LakeTabId; label: string }> = [
  { id: 'lake', label: 'Lake' },
  { id: 'merge', label: 'Merge' },
  { id: 'settings', label: 'Settings' },
];

/** Anything the page does not recognise is the lake, not an error. */
function readTab(value: string | null | undefined): LakeTabId {
  return value === 'merge' || value === 'settings' ? value : 'lake';
}

function JobLakePage() {
  const router = useRouter();
  const search = useSearchParams();
  const tab = readTab(search?.get('tab'));

  /*
   * The admin sheet's backlog for the Settings tab's badge, read on arrival:
   * jobs the lake holds that the admin sheet does not yet, which the
   * Settings tab is where to see why and press Retry now.
   */
  const [sync, setSync] = useState<AdminLakeSyncStatus | null>(null);
  useEffect(() => {
    let alive = true;
    adminJobLakeApi.sync().then(
      (answer) => {
        if (alive) setSync(answer.sync);
      },
      () => undefined
    );
    return () => {
      alive = false;
    };
  }, []);

  const go = useCallback(
    (next: LakeTabId) => {
      router.replace(next === 'lake' ? '/admin/job-lake' : `/admin/job-lake?tab=${next}`, { scroll: false });
    },
    [router]
  );

  // Arrow keys move along the row, as the ARIA tabs pattern expects.
  const tabRefs = useRef(new Map<LakeTabId, HTMLButtonElement>());
  const onTabKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    event.preventDefault();
    tabRefs.current.get(TABS[next].id)?.focus();
    go(TABS[next].id);
  };

  const waiting = sync?.unsynced ?? 0;

  return (
    <div>
      <header>
        <h2 className="text-2xl font-bold tracking-tight text-ink">Job Lake</h2>
        <p className="mt-1 text-sm text-muted">
          One row per job - a company hiring in a job field - added by reporters from their sheets and merged in
          from builds. Every job it adds is also copied to the admin sheet.
        </p>
      </header>

      <div role="tablist" aria-label="Job Lake" className="tl-tabs mt-6">
        {TABS.map((entry, index) => {
          const active = entry.id === tab;
          return (
            <button
              key={entry.id}
              ref={(node) => {
                if (node) tabRefs.current.set(entry.id, node);
                else tabRefs.current.delete(entry.id);
              }}
              type="button"
              role="tab"
              id={`job-lake-tab-${entry.id}`}
              aria-selected={active}
              aria-controls="job-lake-panel"
              tabIndex={active ? 0 : -1}
              data-active={active}
              className="tl-tab"
              onClick={() => go(entry.id)}
              onKeyDown={(event) => onTabKey(event, index)}
            >
              {entry.label}
              {entry.id === 'settings' && waiting > 0 && (
                <span className="ml-2" aria-label={`${waiting} not on the admin sheet yet`}>
                  <Pill tone={sync?.lastError ? 'amber' : 'grey'}>{waiting}</Pill>
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div id="job-lake-panel" role="tabpanel" aria-labelledby={`job-lake-tab-${tab}`} className="mt-8">
        {tab === 'merge' ? <MergeTab /> : tab === 'settings' ? <SettingsTab onSync={setSync} /> : <LakeTab />}
      </div>
    </div>
  );
}

export default function AdminJobLakePage() {
  return (
    <AdminOnly>
      {/* `useSearchParams` needs a Suspense boundary to prerender. */}
      <Suspense fallback={<Spinner />}>
        <JobLakePage />
      </Suspense>
    </AdminOnly>
  );
}
