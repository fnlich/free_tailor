'use client';

import { useCallback, useRef, useState } from 'react';

import TablePager from '@/components/credits/TablePager';
import { usePagedList } from '@/components/credits/usePagedList';
import Dialog from '@/components/ui/Dialog';
import { EmptyState, ErrorNotice, Notice, Spinner } from '@/components/ui/kit';
import { formatDate } from '@/lib/format';
import { formatSalary } from '@/lib/jobAnalysis';
import { adminJobLakeApi, type MergeCandidate, type MergeReport } from '@/lib/jobLake';
import { describeMergeReport, describeRequester, MERGE_STATUS_LABELS, mergeResultsNotAdded } from '@/lib/jobLakeDisplay';

/**
 * The Merge tab (owner decision J6): the postings BUILDS analysed that nobody
 * has merged into the lake yet - a job field from the list and a company on
 * record, oldest first - merged selected or all. A merge goes through the
 * same rules as a report (added, replaced, duplicate) with the build's
 * account as the one who asked for it, and pays nobody. No model is asked and
 * no sheet is read: it reads the store.
 *
 * What did not go in - duplicates first, then anything skipped - is listed
 * under the merge's line, so "17 merged" is never the only thing said about
 * 20 chosen.
 */

const PAGE_SIZE = 50;

export default function MergeTab() {
  const [epoch, setEpoch] = useState(0);
  const [listError, setListError] = useState<unknown>(null);
  /**
   * Every candidate a page has listed, so the report can name a merged job by
   * its company - also one chosen on a page since left. Kept as each page
   * arrives, not while drawing.
   */
  const seen = useRef(new Map<string, MergeCandidate>());
  const fetchPage = useCallback(
    (offset: number, limit: number) =>
      adminJobLakeApi.mergeCandidates(offset, limit).then(
        (answer) => {
          for (const row of answer.rows) seen.current.set(row.analysisId, row);
          setListError(null);
          return answer;
        },
        (caught: unknown) => {
          setListError(caught ?? new Error('Could not list the jobs to merge.'));
          throw caught;
        }
      ),
    []
  );
  const list = usePagedList<MergeCandidate>(fetchPage, PAGE_SIZE, epoch);

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [merging, setMerging] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [report, setReport] = useState<MergeReport | null>(null);
  /** The candidates known when the report arrived, by analysis id: what its table names them by. */
  const [names, setNames] = useState<ReadonlyMap<string, MergeCandidate>>(() => new Map());
  const [mergeError, setMergeError] = useState<unknown>(null);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const pageIds = list.rows.map((row) => row.analysisId);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const toggleAllOnPage = () =>
    setSelected((current) => {
      const next = new Set(current);
      if (allOnPage) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });

  const merge = async (body: { analysisIds: string[] } | { all: true }) => {
    setMerging(true);
    setMergeError(null);
    try {
      const answer = await adminJobLakeApi.merge(body);
      setNames(new Map(seen.current));
      setReport(answer);
      setSelected(new Set());
      setConfirmAll(false);
      // What was merged leaves the list: back to its first page.
      setEpoch((value) => value + 1);
    } catch (caught) {
      setMergeError(caught ?? new Error('Could not merge those jobs.'));
    } finally {
      setMerging(false);
    }
  };

  const notAdded = report ? mergeResultsNotAdded(report) : [];

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        Postings the builder analysed - with a job field from the list and a company on record - that are not in the
        lake yet. Merging adds them under the same rules as a report: a job the lake already has within the duplicate
        window is a duplicate. The account whose build analysed a posting is recorded as having asked for it, and
        nobody is paid for a merge.
      </p>

      {report && (
        <Notice tone="success" role="status">
          {describeMergeReport(report)}
        </Notice>
      )}
      <ErrorNotice error={mergeError} fallback="The jobs could not be merged" onDismiss={() => setMergeError(null)} />

      {report && notAdded.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-base font-semibold text-ink">Not added</h3>
          <div className="tl-table-box">
            <table className="tl-table">
              <caption className="sr-only">The merged postings the lake did not add, and why</caption>
              <thead>
                <tr>
                  <th scope="col">Company</th>
                  <th scope="col">Job field</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Lake job</th>
                </tr>
              </thead>
              <tbody>
                {notAdded.map((result) => {
                  const known = names.get(result.analysisId);
                  return (
                    <tr key={result.analysisId}>
                      <td className="min-w-32">
                        {known ? (
                          <span className="break-words">{known.company}</span>
                        ) : (
                          <span className="break-all font-mono text-xs text-subtle">{result.analysisId}</span>
                        )}
                      </td>
                      <td>{known?.jobFieldLabel ?? '-'}</td>
                      <td>{MERGE_STATUS_LABELS[result.status] ?? result.status}</td>
                      <td className="whitespace-nowrap">{result.lakeId !== null ? `#${result.lakeId}` : '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {list.failed && (
        <ErrorNotice error={listError} fallback="The jobs to merge could not be listed">
          <button type="button" className="tl-button-quiet mt-3" data-size="sm" onClick={list.retry}>
            Try again
          </button>
        </ErrorNotice>
      )}

      {!list.loaded && !list.failed && <Spinner />}

      {list.loaded && list.total === 0 && list.rows.length === 0 && (
        <EmptyState title="Nothing to merge">
          Every posting a build analysed with a job field and a company is in the lake already. New ones appear here
          as resumes are built.
        </EmptyState>
      )}

      {list.loaded && list.rows.length > 0 && (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="tl-button"
                disabled={merging || selected.size === 0}
                onClick={() => void merge({ analysisIds: [...selected] })}
              >
                {merging && !confirmAll ? 'Merging...' : `Merge selected (${selected.size})`}
              </button>
              <button
                type="button"
                className="tl-button-quiet"
                disabled={merging}
                onClick={() => setConfirmAll(true)}
              >
                Merge all ({list.total})
              </button>
            </div>
            <TablePager
              total={list.total}
              offset={list.shown}
              count={list.rows.length}
              pageSize={PAGE_SIZE}
              onChange={list.goTo}
            />
          </div>
          <div className="tl-table-box">
            <table className="tl-table">
              <caption className="sr-only">Analysed postings not merged into the lake yet, oldest first</caption>
              <thead>
                <tr>
                  <th scope="col">
                    <input
                      type="checkbox"
                      aria-label="Select every job on this page"
                      checked={allOnPage}
                      onChange={toggleAllOnPage}
                      disabled={merging}
                    />
                  </th>
                  <th scope="col">Analysed</th>
                  <th scope="col">Company</th>
                  <th scope="col">Job field</th>
                  <th scope="col">Title</th>
                  <th scope="col">Salary</th>
                  <th scope="col">Built by</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((row) => (
                  <tr key={row.analysisId}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.company} - ${row.jobFieldLabel}`}
                        checked={selected.has(row.analysisId)}
                        onChange={() => toggle(row.analysisId)}
                        disabled={merging}
                      />
                    </td>
                    <td className="whitespace-nowrap">{formatDate(row.createdAt)}</td>
                    <td className="min-w-32">
                      <span className="break-words font-medium text-ink">{row.company}</span>
                    </td>
                    <td className="min-w-28">{row.jobFieldLabel}</td>
                    <td className="min-w-32">
                      {row.title ? <span className="break-words">{row.title}</span> : <span className="text-subtle">-</span>}
                    </td>
                    <td className="min-w-28">{formatSalary(row.salary) || <span className="text-subtle">-</span>}</td>
                    <td className="break-words">
                      {describeRequester({ requester: row.requester, requestedBy: row.createdBy })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Dialog
        open={confirmAll}
        title="Merge every job?"
        onClose={() => {
          if (!merging) setConfirmAll(false);
        }}
        footer={
          <>
            <button type="button" className="tl-button-quiet" disabled={merging} onClick={() => setConfirmAll(false)}>
              Cancel
            </button>
            <button type="button" className="tl-button" disabled={merging} onClick={() => void merge({ all: true })}>
              {merging ? 'Merging...' : 'Merge all'}
            </button>
          </>
        }
      >
        <p className="text-sm text-muted">
          All {list.total} waiting postings are taken to the lake, up to 1,000 at a time. Each is added, or found to be
          a duplicate, under the same rules as a report; nobody is paid, and every job added is copied to the admin
          sheet.
        </p>
      </Dialog>
    </div>
  );
}
