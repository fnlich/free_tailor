'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';

import TablePager from '@/components/credits/TablePager';
import { usePagedList } from '@/components/credits/usePagedList';
import Dialog from '@/components/ui/Dialog';
import { EmptyState, ErrorNotice, Field, Notice, Pill, Spinner, StaticValue } from '@/components/ui/kit';
import { accountsApi, type ManagedAccount } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { formatSalary } from '@/lib/jobAnalysis';
import { adminJobLakeApi, type JobFieldCatalog, type LakeEntry, type LakeHistoryEntry } from '@/lib/jobLake';
import {
  canRevoke,
  describeDeleteConfirm,
  describeFactsLine,
  describeLakeFacts,
  describeLakeTotal,
  describeRequester,
  describeReward,
  describeRevoke,
  describeSeen,
  describeSource,
  EMPTY_LAKE_FILTERS,
  hasLakeFilters,
  lakeFactCells,
  lakeFilterProblem,
  lakeQueryString,
  linkHost,
  safeWebLink,
  type LakeFilters,
} from '@/lib/jobLakeDisplay';

/**
 * The Lake tab: the lake, newest first, through GET /api/admin/job-lake's
 * filters - full text over company, title and description (prefix words),
 * company (compared after the lake's own normalisation, so "OpenAI, Inc."
 * finds "Open AI LLC"), job field, salary range, who reported it and when it
 * was last updated - a page at a time, each job with its job type, clearance
 * and industry (taken from its posting's analysis, in the server's words); a
 * row's detail with its history, and Delete (optionally taking the reward
 * back) and Revoke reward.
 *
 * The filters are applied by Search, not per keystroke: each one is a query
 * the server runs, and half a company name is a different question.
 */

const PAGE_SIZE = 25;

function Cell({ children, muted = false }: { children: React.ReactNode; muted?: boolean }) {
  // A colour on a .tl-table cell goes on an inner span - the unlayered td rule beats a utility on the td.
  return <span className={muted ? 'text-subtle' : 'text-ink'}>{children}</span>;
}

function WebLink({ value }: { value: string }) {
  const href = safeWebLink(value);
  if (!href) return value.trim() ? <span className="break-all">{value}</span> : <span className="text-subtle">-</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="tl-link break-all" title={href}>
      {linkHost(href)}
    </a>
  );
}

function HistoryList({ history }: { history: LakeHistoryEntry[] }) {
  if (history.length === 0) {
    return <p className="text-sm text-muted">No earlier version: this job has not been replaced since it was added.</p>;
  }
  return (
    <ol className="space-y-3">
      {history.map((version) => (
        <li key={version.id} className="tl-card p-4 text-sm">
          <p className="font-medium text-ink">
            {formatDate(version.versionAt)} to {formatDate(version.replacedAt)}
          </p>
          <p className="mt-1 text-muted">
            {version.title || 'No title'} · {describeSource(version.source)} by {describeRequester(version)} ·{' '}
            {describeReward(version.reward)}
            {version.salary ? ` · ${formatSalary(version.salary)}` : ''}
            {describeFactsLine(version) ? ` · ${describeFactsLine(version)}` : ''}
          </p>
          {version.url && (
            <p className="mt-1">
              <WebLink value={version.url} />
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

/** One lake row: everything about it, its history, and the two things an administrator can do to it. */
function EntryDialog({
  id,
  onClose,
  onChanged,
}: {
  id: number;
  onClose: () => void;
  /** After a revoke or a delete: what to say on the page, and whether the row is gone. */
  onChanged: (message: string, deleted: boolean) => void;
}) {
  const [entry, setEntry] = useState<LakeEntry | null>(null);
  const [history, setHistory] = useState<LakeHistoryEntry[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [alsoRevoke, setAlsoRevoke] = useState(false);
  const [revokeNote, setRevokeNote] = useState('');

  const load = useCallback(async () => {
    try {
      const answer = await adminJobLakeApi.get(id);
      setEntry(answer.entry);
      setHistory(answer.history);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught ?? new Error('Could not read that job.'));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async () => {
    if (!entry) return;
    setBusy(true);
    setActionError(null);
    try {
      const answer = await adminJobLakeApi.revokeReward(entry.id);
      const text = describeRevoke(answer.revoke, describeRequester(entry));
      setEntry(answer.entry);
      setRevokeNote(text);
      onChanged(text, false);
    } catch (caught) {
      setActionError(caught ?? new Error('Could not revoke the reward.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!entry) return;
    setBusy(true);
    setActionError(null);
    const revokeToo = alsoRevoke && canRevoke(entry);
    try {
      const answer = await adminJobLakeApi.remove(entry.id, revokeToo);
      const gone = `Deleted ${entry.company} - ${entry.jobFieldLabel} from the lake.`;
      onChanged(answer.revoke ? `${gone} ${describeRevoke(answer.revoke, describeRequester(entry))}` : gone, true);
    } catch (caught) {
      setActionError(caught ?? new Error('Could not delete that job.'));
      setBusy(false);
    }
  };

  const title = entry ? `${entry.company} - ${entry.jobFieldLabel}` : `Job #${id}`;
  const revocable = entry ? canRevoke(entry) : false;
  const facts = entry ? describeLakeFacts(entry) : null;

  return (
    <Dialog
      open
      title={title}
      subtitle={entry ? `Job #${entry.id} · last updated ${formatDate(entry.updatedAt)}` : undefined}
      width="wide"
      onClose={onClose}
      footer={
        entry && !confirmingDelete ? (
          <>
            {revocable && (
              <button type="button" className="tl-button-quiet" disabled={busy} onClick={() => void revoke()}>
                Revoke reward
              </button>
            )}
            <button
              type="button"
              className="tl-button-quiet"
              data-tone="danger"
              disabled={busy}
              onClick={() => {
                setConfirmingDelete(true);
                setAlsoRevoke(false);
              }}
            >
              Delete
            </button>
            <button type="button" className="tl-button" onClick={onClose}>
              Close
            </button>
          </>
        ) : undefined
      }
    >
      <ErrorNotice error={loadError} fallback="That job could not be read" />
      {!entry && !loadError && <Spinner compact />}

      {entry && (
        <div className="space-y-6">
          {revokeNote && (
            <Notice tone="success" role="status">
              {revokeNote}
            </Notice>
          )}
          <ErrorNotice error={actionError} fallback="That did not work" onDismiss={() => setActionError(null)} />

          {confirmingDelete && (
            <div className="tl-notice space-y-4" data-tone="warn" role="alertdialog" aria-label="Delete this job?">
              <p>{describeDeleteConfirm(entry, alsoRevoke)}</p>
              {revocable && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={alsoRevoke}
                    onChange={(event) => setAlsoRevoke(event.target.checked)}
                    disabled={busy}
                  />
                  Also revoke the reward
                </label>
              )}
              <div className="flex flex-wrap justify-end gap-3">
                <button type="button" className="tl-button-quiet" disabled={busy} onClick={() => setConfirmingDelete(false)}>
                  Keep it
                </button>
                <button
                  type="button"
                  className="tl-button"
                  data-tone="danger"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  {busy ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          )}

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
            <Field label="Requested by">
              <StaticValue>
                {describeRequester(entry)} · {describeSource(entry.source)}
              </StaticValue>
            </Field>
            <Field label="Reward">
              <StaticValue>{describeReward(entry.reward)}</StaticValue>
            </Field>
            <Field label="Seen">
              <StaticValue>
                {describeSeen(entry)}
                {entry.lastSeenAt ? `, last ${formatDate(entry.lastSeenAt)}` : ''}
              </StaticValue>
            </Field>
            <Field label="On the admin sheet">
              <StaticValue>{entry.sheetSyncedAt ? formatDate(entry.sheetSyncedAt) : 'Not yet'}</StaticValue>
            </Field>
            <Field label="Link">
              <StaticValue>
                <WebLink value={entry.url} />
              </StaticValue>
            </Field>
            <Field label="Job hash">
              <StaticValue>
                <span className="break-all font-mono text-xs">{entry.jobHash}</span>
              </StaticValue>
            </Field>
          </div>

          <div>
            <p className="tl-label">Job description</p>
            <div className="tl-card mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words p-4 text-sm text-ink">
              {entry.jobDescription?.trim() || 'No description on record.'}
            </div>
          </div>

          <div>
            <p className="tl-label">Earlier versions</p>
            <div className="mt-2">
              <HistoryList history={history} />
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export default function LakeTab() {
  const [draft, setDraft] = useState<LakeFilters>(EMPTY_LAKE_FILTERS);
  const [applied, setApplied] = useState<LakeFilters>(EMPTY_LAKE_FILTERS);
  // Bumped by Search, Clear and a delete: back to the first page, and asked again.
  const [epoch, setEpoch] = useState(0);
  const [problem, setProblem] = useState('');
  const [listError, setListError] = useState<unknown>(null);
  const [fields, setFields] = useState<JobFieldCatalog | null>(null);
  const [accounts, setAccounts] = useState<ManagedAccount[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [notice, setNotice] = useState('');

  // The two lists the filter boxes choose from. Best-effort: without them the
  // boxes still work, with fewer choices.
  useEffect(() => {
    let alive = true;
    adminJobLakeApi.jobFields().then(
      (catalog) => {
        if (alive) setFields(catalog);
      },
      () => undefined
    );
    accountsApi.list().then(
      (answer) => {
        if (alive) setAccounts([...answer.accounts].sort((a, b) => a.email.localeCompare(b.email)));
      },
      () => undefined
    );
    return () => {
      alive = false;
    };
  }, []);

  const fetchPage = useCallback(
    (offset: number, limit: number) =>
      adminJobLakeApi.list(lakeQueryString(applied, offset, limit)).then(
        (answer) => {
          setListError(null);
          return answer;
        },
        (caught: unknown) => {
          setListError(caught ?? new Error('Could not read the lake.'));
          throw caught;
        }
      ),
    [applied]
  );
  const list = usePagedList<LakeEntry>(fetchPage, PAGE_SIZE, epoch);

  const set = (key: keyof LakeFilters) => (value: string) => setDraft((current) => ({ ...current, [key]: value }));

  const search = (event: FormEvent) => {
    event.preventDefault();
    const found = lakeFilterProblem(draft);
    setProblem(found);
    if (found) return;
    setApplied({ ...draft });
    setEpoch((value) => value + 1);
  };

  const clear = () => {
    setDraft(EMPTY_LAKE_FILTERS);
    setApplied(EMPTY_LAKE_FILTERS);
    setProblem('');
    setEpoch((value) => value + 1);
  };

  const filtered = hasLakeFilters(applied);

  return (
    <div className="space-y-6">
      <form onSubmit={search} className="tl-card space-y-4 p-5" aria-label="Filter the lake">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2">
            <label htmlFor="lake-q" className="tl-label">
              Full text
            </label>
            <input
              id="lake-q"
              type="search"
              value={draft.q}
              onChange={(event) => set('q')(event.target.value)}
              placeholder="Words in the company, title or description"
              className="tl-input mt-2"
            />
          </div>
          <div>
            <label htmlFor="lake-company" className="tl-label">
              Company
            </label>
            <input
              id="lake-company"
              type="text"
              value={draft.company}
              onChange={(event) => set('company')(event.target.value)}
              placeholder="OpenAI, Inc. = Open AI LLC"
              className="tl-input mt-2"
            />
          </div>
          <div>
            <label htmlFor="lake-field" className="tl-label">
              Job field
            </label>
            <select
              id="lake-field"
              value={draft.field}
              onChange={(event) => set('field')(event.target.value)}
              className="tl-input mt-2"
            >
              <option value="">Any job field</option>
              {fields?.areas.map((area) => (
                <optgroup key={area.number} label={area.label}>
                  {fields.fields
                    .filter((field) => field.area === area.number)
                    .map((field) => (
                      <option key={field.id} value={field.id}>
                        {field.label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="lake-salary-min" className="tl-label">
              Salary from
            </label>
            <input
              id="lake-salary-min"
              type="text"
              inputMode="numeric"
              value={draft.salaryMin}
              onChange={(event) => set('salaryMin')(event.target.value)}
              placeholder="Any"
              className="tl-input mt-2 tabular-nums"
            />
          </div>
          <div>
            <label htmlFor="lake-salary-max" className="tl-label">
              Salary to
            </label>
            <input
              id="lake-salary-max"
              type="text"
              inputMode="numeric"
              value={draft.salaryMax}
              onChange={(event) => set('salaryMax')(event.target.value)}
              placeholder="Any"
              className="tl-input mt-2 tabular-nums"
            />
          </div>
          <div>
            <label htmlFor="lake-updated-from" className="tl-label">
              Updated from
            </label>
            <input
              id="lake-updated-from"
              type="date"
              value={draft.updatedFrom}
              onChange={(event) => set('updatedFrom')(event.target.value)}
              className="tl-input mt-2"
            />
          </div>
          <div>
            <label htmlFor="lake-updated-to" className="tl-label">
              Updated to
            </label>
            <input
              id="lake-updated-to"
              type="date"
              value={draft.updatedTo}
              onChange={(event) => set('updatedTo')(event.target.value)}
              className="tl-input mt-2"
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="lake-requested-by" className="tl-label">
              Requested by
            </label>
            <select
              id="lake-requested-by"
              value={draft.requestedBy}
              onChange={(event) => set('requestedBy')(event.target.value)}
              className="tl-input mt-2"
            >
              <option value="">Anybody</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.email} ({account.roleLabel})
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="text-xs text-subtle">
          A salary filter keeps the jobs whose stated range reaches yours - the figures as stated, whatever their
          currency or period - and leaves out jobs that state none. Dates are UTC days.
        </p>
        {problem && (
          <p className="tl-status" data-tone="error" role="alert">
            {problem}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" className="tl-button-quiet" onClick={clear} disabled={!filtered && !hasLakeFilters(draft)}>
            Clear
          </button>
          <button type="submit" className="tl-button">
            Search
          </button>
        </div>
      </form>

      {notice && (
        <Notice tone="success" role="status">
          {notice}
        </Notice>
      )}

      {list.failed && (
        <ErrorNotice error={listError} fallback="The lake could not be read">
          <button type="button" className="tl-button-quiet mt-3" data-size="sm" onClick={list.retry}>
            Try again
          </button>
        </ErrorNotice>
      )}

      {!list.loaded && !list.failed && <Spinner />}

      {list.loaded && list.total === 0 && list.rows.length === 0 ? (
        <EmptyState title={filtered ? 'No job matches' : 'The lake is empty'}>
          {filtered
            ? 'Nothing in the lake matches these filters. Clear them to see every job.'
            : 'Jobs arrive when reporters add them from their sheets, or when you merge the postings builds analysed (the Merge tab).'}
        </EmptyState>
      ) : (
        list.loaded && (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <p className="text-sm text-muted">{describeLakeTotal(list.total, filtered)}</p>
              <TablePager
                total={list.total}
                offset={list.shown}
                count={list.rows.length}
                pageSize={PAGE_SIZE}
                onChange={list.goTo}
              />
            </div>
            <div className="tl-table-box relative">
              <table className="tl-table">
                <caption className="sr-only">Jobs in the lake, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Updated</th>
                    <th scope="col">Company</th>
                    <th scope="col">Job field</th>
                    <th scope="col">Title</th>
                    <th scope="col">Salary</th>
                    <th scope="col">Job type</th>
                    <th scope="col">Clearance</th>
                    <th scope="col">Industry</th>
                    <th scope="col">Requested by</th>
                    <th scope="col">Reward</th>
                    <th scope="col">Seen</th>
                    <th scope="col">
                      <span className="sr-only">Details</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((entry) => {
                    const cells = lakeFactCells(entry);
                    return (
                      <tr key={entry.id}>
                        <td className="whitespace-nowrap">{formatDate(entry.updatedAt)}</td>
                        <td className="min-w-32">
                          <span className="break-words font-medium text-ink">{entry.company}</span>
                        </td>
                        <td className="min-w-28">{entry.jobFieldLabel}</td>
                        <td className="min-w-32">
                          {entry.title ? <span className="break-words">{entry.title}</span> : <Cell muted>-</Cell>}
                        </td>
                        <td className="min-w-44">{formatSalary(entry.salary) || <Cell muted>-</Cell>}</td>
                        <td className="whitespace-nowrap">{cells.jobType || <Cell muted>-</Cell>}</td>
                        <td className="whitespace-nowrap">{cells.clearance || <Cell muted>-</Cell>}</td>
                        <td className="min-w-28">{cells.industry || <Cell muted>-</Cell>}</td>
                        <td className="break-words">
                          {describeRequester(entry)}
                          {entry.source === 'merge' && (
                            <span className="ml-2">
                              <Pill tone="violet">Merged</Pill>
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap tabular-nums">{describeReward(entry.reward)}</td>
                        <td className="whitespace-nowrap">{describeSeen(entry)}</td>
                        <td className="text-right">
                          <button
                            type="button"
                            className="tl-button-quiet"
                            data-size="sm"
                            onClick={() => {
                              setNotice('');
                              setOpenId(entry.id);
                            }}
                          >
                            Details
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )
      )}

      {openId !== null && (
        <EntryDialog
          key={openId}
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={(message, deleted) => {
            setNotice(message);
            if (deleted) {
              setOpenId(null);
              // Back to the first page: the row deleted may have been the last
              // one of the page on screen, which would leave it empty.
              setEpoch((value) => value + 1);
            } else {
              // The reward changed: the same page, asked again.
              list.retry();
            }
          }}
        />
      )}
    </div>
  );
}
