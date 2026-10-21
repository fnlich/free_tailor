'use client';

import { useEffect, useState } from 'react';

import { WebLink } from '@/components/jobLake/LakeCells';
import Dialog from '@/components/ui/Dialog';
import { ErrorNotice, Field, Spinner, StaticValue } from '@/components/ui/kit';
import { formatDate } from '@/lib/format';
import { formatSalary } from '@/lib/jobAnalysis';
import { jobLakeApi, type FindJobsDetail, type FindJobsRow } from '@/lib/jobLake';
import { describeLakeFacts, describeRequester } from '@/lib/jobLakeDisplay';

/**
 * One job of Find Jobs: its facts, its link and the posting's text, and - an
 * administrator's view only - who reported it. "Select this job" picks it for
 * an export or an order, a box as its row's is (a box says picked or not by
 * itself, where a button's changing name would say it twice) - and when the
 * selection is full, the dialog says so, over the page that would.
 */
export default function FindJobDialog({
  id,
  selected,
  admin,
  onToggle,
  onClose,
}: {
  id: number;
  selected: boolean;
  /** Draws Requested by: the server sends who reported a job to an administrator alone. */
  admin: boolean;
  /** Picks the job, or lets it go, as its row's box would: the sentence when the cap refused it, else ''. */
  onToggle: (row: FindJobsRow) => string;
  onClose: () => void;
}) {
  const [entry, setEntry] = useState<FindJobsDetail | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [refusal, setRefusal] = useState('');

  useEffect(() => {
    let alive = true;
    jobLakeApi.get(id).then(
      (answer) => {
        if (alive) setEntry(answer.entry);
      },
      (caught: unknown) => {
        if (alive) setLoadError(caught ?? new Error('Could not read that job.'));
      }
    );
    return () => {
      alive = false;
    };
  }, [id]);

  const facts = entry ? describeLakeFacts(entry) : null;

  return (
    <Dialog
      open
      title={entry ? `${entry.company} - ${entry.title || entry.jobFieldLabel}` : `Job #${id}`}
      subtitle={entry ? `${entry.jobFieldLabel} · updated ${formatDate(entry.updatedAt)}` : undefined}
      width="wide"
      onClose={onClose}
      footer={
        <>
          {entry && (
            <div className="mr-auto min-w-0 space-y-1">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  className="tl-check"
                  checked={selected}
                  aria-describedby={refusal ? `find-job-${id}-refusal` : undefined}
                  onChange={() => setRefusal(onToggle(entry))}
                />
                Select this job
              </label>
              {refusal && (
                <p id={`find-job-${id}-refusal`} className="tl-status" data-tone="error" role="alert">
                  {refusal}
                </p>
              )}
            </div>
          )}
          <button type="button" className="tl-button" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <ErrorNotice error={loadError} fallback="That job could not be read" />
      {!entry && !loadError && <Spinner compact />}

      {entry && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Company">
              <StaticValue>{entry.company}</StaticValue>
            </Field>
            <Field label="Job field">
              <StaticValue>{entry.jobFieldLabel}</StaticValue>
            </Field>
            <Field label="Title">
              <StaticValue>{entry.title || '-'}</StaticValue>
            </Field>
            <Field label="Salary">
              <StaticValue>{formatSalary(entry.salary) || 'Not stated'}</StaticValue>
            </Field>
            <Field label="Job type">
              <StaticValue>{facts?.jobType}</StaticValue>
            </Field>
            <Field label="Clearance">
              <StaticValue>{facts?.clearance}</StaticValue>
            </Field>
            <Field label="Industry">
              <StaticValue>{facts?.industry}</StaticValue>
            </Field>
            {admin && (
              <Field label="Requested by">
                <StaticValue>{describeRequester({ requester: entry.requester ?? null, requestedBy: entry.requestedBy ?? null })}</StaticValue>
              </Field>
            )}
            <Field label="Link">
              <StaticValue>
                <WebLink value={entry.url} />
              </StaticValue>
            </Field>
          </div>

          <div>
            <p className="tl-label">Job description</p>
            <div className="tl-card mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words p-4 text-sm text-ink">
              {entry.jobDescription.trim() || 'No description on record.'}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
