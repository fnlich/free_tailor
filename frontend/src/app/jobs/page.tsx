'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import TablePager from '@/components/credits/TablePager';
import { usePagedList } from '@/components/credits/usePagedList';
import { IconExternal } from '@/components/icons';
import { Cell, WebLink } from '@/components/jobLake/LakeCells';
import LakeFilterForm from '@/components/jobLake/LakeFilterForm';
import OrderReceipt, { type PlacedOrder } from '@/components/orders/OrderReceipt';
import { EmptyState, ErrorNotice, Notice, Page, PageHeader, Pill, Spinner } from '@/components/ui/kit';
import { useAuth } from '@/contexts/AuthContext';
import { accountsApi, type ManagedAccount } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { formatSalary } from '@/lib/jobAnalysis';
import { jobLakeApi, type FindJobsRow, type JobFieldCatalog, type LakeExportResult } from '@/lib/jobLake';
import {
  describeExportResult,
  describeFindJobsEmpty,
  describeLakeTotal,
  describeRequester,
  describeSelection,
  draftFilters,
  EMPTY_LAKE_DRAFT,
  EMPTY_LAKE_FILTERS,
  exportBlocker,
  hasLakeFilters,
  lakeFactCells,
  lakeFilterProblem,
  lakeOrderJobs,
  lakeQueryString,
  orderBlocker,
  pageSelectionState,
  safeWebLink,
  selectionLimitSentence,
  toggleSelected,
  togglePageSelected,
  type LakeFilterDraft,
  type LakeFilterOptions,
  type LakeFilters,
} from '@/lib/jobLakeDisplay';
import { sheetLinkFor } from '@/lib/roles';
import { sheetApi, type AccountSheet } from '@/lib/sheet';
import { keepFocusClearOfStickyEnd } from '@/lib/stickyColumn';
import FindJobDialog from './FindJobDialog';
import OrderJobsDialog from './OrderJobsDialog';

/**
 * Find Jobs: the Job Data Lake, for everybody who builds resumes - the jobs
 * reporters found and the postings builds analysed, newest first, searched by
 * the lake's own filter form (components/jobLake/LakeFilterForm.tsx, the one
 * Admin -> Job Lake draws; Requested by an administrator's alone, and only
 * an administrator's rows say who reported a job).
 *
 * Rows are picked with their boxes - a page at a time, or all of a page - and
 * stay picked across pages until Search, Clear or an order clears them, up to
 * the server's cap (JOB_LAKE_EXPORT_MAX_ROWS, the list's `exportMaxRows`).
 * Then:
 *
 *  - **Export into Sheet** appends them to the All tab of the account's OWN
 *    job sheet, each with its analysis cells, so building from those rows
 *    analyses nothing again; jobs already there are left out and said;
 *  - **Order Immediately** places an ORDER of a resume per job for ONE
 *    profile in one build mode (./OrderJobsDialog.tsx), priced and asked about first,
 *    whose receipt appears here - and takes the focus, so a keyboard or a
 *    screen reader is told, and goes on from it, rather than from the top.
 *
 * Go to my sheet, top right, opens that sheet's All tab in a new tab.
 *
 * Focus is never dropped: Order Immediately stays pressable while its dialog
 * is open, so Cancel gives the focus back to it; Clear selection, which goes
 * with the selection, hands it to the page's select-all box.
 */

const PAGE_SIZE = 25;
/** The server's JOB_LAKE_EXPORT_MAX_ROWS default, until the first page says what it is. */
const DEFAULT_EXPORT_MAX_ROWS = 200;

export default function FindJobsPage() {
  const { account, refresh } = useAuth();
  const admin = account?.role === 'admin';

  const [draft, setDraft] = useState<LakeFilterDraft>(EMPTY_LAKE_DRAFT);
  const [applied, setApplied] = useState<LakeFilters>(EMPTY_LAKE_FILTERS);
  // Bumped by Search and Clear: back to the first page, and asked again.
  const [epoch, setEpoch] = useState(0);
  const [problem, setProblem] = useState('');
  const [listError, setListError] = useState<unknown>(null);
  const [fields, setFields] = useState<JobFieldCatalog | null>(null);
  const [accounts, setAccounts] = useState<ManagedAccount[]>([]);
  const [options, setOptions] = useState<LakeFilterOptions | null>(null);
  const [exportMaxRows, setExportMaxRows] = useState(DEFAULT_EXPORT_MAX_ROWS);
  const [selection, setSelection] = useState<ReadonlyMap<number, FindJobsRow>>(new Map());
  const [selectionNote, setSelectionNote] = useState('');
  const [sheet, setSheet] = useState<AccountSheet | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<LakeExportResult | null>(null);
  const [exportError, setExportError] = useState<unknown>(null);
  const [ordering, setOrdering] = useState(false);
  const [placedOrder, setPlacedOrder] = useState<PlacedOrder | null>(null);
  const [orderNotice, setOrderNotice] = useState('');
  const [receiptError, setReceiptError] = useState<unknown>(null);
  // Bumped by every order placed: the receipt (or the notice standing for it) then takes the focus.
  const [ordersPlaced, setOrdersPlaced] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);
  const orderResult = useRef<HTMLDivElement | null>(null);
  const selectAll = useRef<HTMLInputElement | null>(null);

  // What the boxes choose from, and the account's own sheet. Best-effort:
  // without them the boxes still work, with fewer choices, and the export
  // says for itself what is wrong with the sheet.
  useEffect(() => {
    let alive = true;
    jobLakeApi.jobFields().then(
      (catalog) => {
        if (alive) setFields(catalog);
      },
      () => undefined
    );
    sheetApi.get().then(
      (answer) => {
        if (alive) setSheet(answer);
      },
      () => undefined
    );
    // Who reported a job is an administrator's filter: the accounts are theirs to list.
    if (admin) {
      accountsApi.list().then(
        (answer) => {
          if (alive) setAccounts([...answer.accounts].sort((a, b) => a.email.localeCompare(b.email)));
        },
        () => undefined
      );
    }
    return () => {
      alive = false;
    };
  }, [admin]);

  const fetchPage = useCallback(
    (offset: number, limit: number) =>
      jobLakeApi.list(lakeQueryString(applied, offset, limit)).then(
        (answer) => {
          setListError(null);
          setOptions(answer.options);
          setExportMaxRows(answer.exportMaxRows);
          return answer;
        },
        (caught: unknown) => {
          setListError(caught ?? new Error('Could not read the job lake.'));
          throw caught;
        }
      ),
    [applied]
  );
  const list = usePagedList<FindJobsRow>(fetchPage, PAGE_SIZE, epoch);

  // An order placed: its receipt, scrolled to and focused. The dialog that
  // placed it has closed, and the button that opened it is off now that the
  // selection is gone - without this the focus would be nowhere.
  useEffect(() => {
    if (ordersPlaced === 0) return;
    const block = orderResult.current;
    if (!block) return;
    block.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    block.focus({ preventScroll: true });
  }, [ordersPlaced]);

  /** Search: the filters applied, the first page asked for, and the selection - of another search's jobs - let go. */
  const search = (filters: LakeFilters) => {
    const found = lakeFilterProblem(filters, options);
    setProblem(found);
    if (found) return;
    setApplied(filters);
    setSelection(new Map());
    setSelectionNote('');
    setExportResult(null);
    setEpoch((value) => value + 1);
  };

  const clear = () => {
    setDraft(EMPTY_LAKE_DRAFT);
    setApplied(EMPTY_LAKE_FILTERS);
    setProblem('');
    setSelection(new Map());
    setSelectionNote('');
    setExportResult(null);
    setEpoch((value) => value + 1);
  };

  /** A row picked or let go; the sentence when the cap refused it ('' when it went through), for Details to say too. */
  const pick = (row: FindJobsRow): string => {
    const result = toggleSelected(selection, row, exportMaxRows);
    const note = result.refused ? selectionLimitSentence(exportMaxRows) : '';
    setSelection(result.selection);
    setSelectionNote(note);
    return note;
  };

  const pickPage = () => {
    const result = togglePageSelected(selection, list.rows, exportMaxRows);
    setSelection(result.selection);
    setSelectionNote(result.refused ? selectionLimitSentence(exportMaxRows) : '');
  };

  const unpickAll = () => {
    setSelection(new Map());
    setSelectionNote('');
    // Clear selection goes with the selection: the focus to the select-all box, never to <body>.
    selectAll.current?.focus();
  };

  /** Export into Sheet: the jobs picked, into the All tab of the account's own sheet. The selection stays, to order. */
  const exportPicked = async () => {
    setExporting(true);
    setExportError(null);
    setExportResult(null);
    try {
      setExportResult(await jobLakeApi.exportToSheet([...selection.keys()]));
    } catch (caught) {
      setExportError(caught ?? new Error('Could not export the jobs.'));
    } finally {
      setExporting(false);
    }
  };

  const filtered = hasLakeFilters(applied);
  const count = selection.size;
  // The picked jobs in the order they were picked - one array per selection, so the order dialog prices it once.
  const picked = useMemo(() => [...selection.values()], [selection]);
  // Only a sheet known to be missing blocks the export; one still loading, or that could not be read, the server judges.
  const sheetReady = !sheet || (sheet.configured && Boolean(sheet.spreadsheetId));
  const exportBlocked = exportBlocker({ count, max: exportMaxRows, busy: exporting || ordering, sheetReady });
  // Not off while its own dialog is open (the dialog is modal): the dialog gives the focus back to it when it closes.
  const orderBlocked = orderBlocker({ count, max: exportMaxRows, busy: exporting, orderable: lakeOrderJobs(picked).jobs.length });
  const pageState = pageSelectionState(selection, list.rows);
  const sheetHref =
    (sheet?.configured ? safeWebLink(sheet.defaultTabUrl ?? sheet.spreadsheetUrl ?? '') : null) ??
    (sheetLinkFor('', account?.sheetUrl) || null);
  const sheetMissing = sheet !== null && !sheet.configured;
  const exportHref = exportResult ? safeWebLink(exportResult.tabUrl) : null;
  const empty = describeFindJobsEmpty(filtered);

  return (
    <Page width="wide">
      <PageHeader
        title="Find Jobs"
        description="The job lake: the jobs reporters found and the postings builds analysed. Pick jobs to export into your sheet, or to order resumes for."
        actions={
          sheetHref ? (
            <a href={sheetHref} target="_blank" rel="noopener noreferrer" className="tl-button-quiet" data-sheet-link>
              <IconExternal className="h-4 w-4" />
              Go to my sheet
            </a>
          ) : (
            <button
              type="button"
              className="tl-button-quiet"
              disabled
              title={sheetMissing ? sheet?.message ?? 'Job sheets are not set up on this server.' : 'Your job sheet is not ready yet.'}
              data-sheet-link
            >
              <IconExternal className="h-4 w-4" />
              Go to my sheet
            </button>
          )
        }
      />

      <div className="space-y-6">
        {sheetMissing && (
          <Notice tone="warn" role="status">
            {sheet?.message ?? 'Job sheets are not set up on this server, so jobs cannot be exported into one.'}
          </Notice>
        )}

        <LakeFilterForm
          ariaLabel="Search the job lake"
          draft={draft}
          onDraftChange={setDraft}
          options={options}
          fields={fields}
          requesters={admin ? accounts : null}
          problem={problem}
          onSearch={search}
          onClear={clear}
          clearable={filtered || hasLakeFilters(draftFilters(draft))}
        />

        {exportResult && (
          <Notice tone={exportResult.exported > 0 ? 'success' : 'info'} role="status">
            <p>{describeExportResult(exportResult)}</p>
            {exportHref && (
              <p className="mt-2">
                <a href={exportHref} target="_blank" rel="noopener noreferrer" className="tl-link">
                  Open {exportResult.tabName || 'All'}
                </a>
              </p>
            )}
          </Notice>
        )}
        <ErrorNotice error={exportError} fallback="The jobs could not be exported" onDismiss={() => setExportError(null)} />

        {(placedOrder || orderNotice) && (
          <div ref={orderResult} tabIndex={-1} className="space-y-6 outline-none" data-order-result>
            {placedOrder && (
              <OrderReceipt
                order={placedOrder}
                onChange={setPlacedOrder}
                onCancelled={() => void refresh()}
                onError={setReceiptError}
              />
            )}
            {orderNotice && (
              <Notice tone="success" role="status">
                {orderNotice}
              </Notice>
            )}
          </div>
        )}
        <ErrorNotice error={receiptError} fallback="That order could not be cancelled" onDismiss={() => setReceiptError(null)} />

        {list.failed && (
          <ErrorNotice error={listError} fallback="The job lake could not be read">
            <button type="button" className="tl-button-quiet mt-3" data-size="sm" onClick={list.retry}>
              Try again
            </button>
          </ErrorNotice>
        )}

        {!list.loaded && !list.failed && <Spinner />}

        {list.loaded && list.total === 0 && list.rows.length === 0 ? (
          <EmptyState title={empty.title}>{empty.body}</EmptyState>
        ) : (
          list.loaded && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3" data-find-jobs-toolbar>
                <p className="text-sm text-muted">
                  {describeLakeTotal(list.total, filtered)}
                  {count > 0 && (
                    <>
                      {' '}
                      · <span className="font-medium text-ink">{describeSelection(count)}</span> ·{' '}
                      <button type="button" className="tl-link" onClick={unpickAll}>
                        Clear selection
                      </button>
                    </>
                  )}
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    className="tl-button-quiet"
                    // Busy, it stays focusable (aria-disabled), so a keyboard press leaves the focus on it.
                    disabled={Boolean(exportBlocked) && !exporting}
                    aria-disabled={exporting || undefined}
                    title={exportBlocked || undefined}
                    onClick={() => {
                      if (!exportBlocked) void exportPicked();
                    }}
                  >
                    {exporting ? 'Exporting...' : 'Export into Sheet'}
                  </button>
                  <button
                    type="button"
                    className="tl-button"
                    disabled={Boolean(orderBlocked)}
                    title={orderBlocked || undefined}
                    onClick={() => {
                      setOrderNotice('');
                      setOrdering(true);
                    }}
                  >
                    Order Immediately
                  </button>
                </div>
              </div>
              {selectionNote && (
                <p className="tl-status" data-tone="error" role="alert">
                  {selectionNote}
                </p>
              )}
              <div className="flex justify-end">
                <TablePager
                  total={list.total}
                  offset={list.shown}
                  count={list.rows.length}
                  pageSize={PAGE_SIZE}
                  onChange={list.goTo}
                />
              </div>
              {/*
               * Every column has a narrowest width the rows cannot change - a
               * minimum where text may break inside a word (a long title, or
               * a label such as "Telecommunications"), a fixed width where it
               * may not - so the table fits its box at 1440px for an
               * administrator whatever the jobs are. Narrower, it scrolls
               * under a Details column held in view, and a control the Tab key
               * reaches under that column is scrolled clear of it - never one
               * a press or a tap focused, which would move out from under it.
               */}
              <div className="tl-table-box" onFocus={keepFocusClearOfStickyEnd}>
                <table className="tl-table" data-density="compact">
                  <caption className="sr-only">Jobs in the lake, newest first</caption>
                  <thead>
                    <tr>
                      <th scope="col">
                        <input
                          type="checkbox"
                          className="tl-check"
                          aria-label="Select every job on this page"
                          checked={pageState === 'all'}
                          ref={(node) => {
                            selectAll.current = node;
                            if (node) node.indeterminate = pageState === 'some';
                          }}
                          onChange={pickPage}
                          disabled={list.rows.length === 0}
                        />
                      </th>
                      <th scope="col">Updated</th>
                      <th scope="col">Company</th>
                      <th scope="col">Job field</th>
                      <th scope="col">Title</th>
                      <th scope="col">Salary</th>
                      <th scope="col">Job type</th>
                      <th scope="col">Clearance</th>
                      <th scope="col">Industry</th>
                      {admin && <th scope="col">Requested by</th>}
                      <th scope="col" data-sticky-end>
                        <span className="sr-only">Details</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.rows.map((row) => {
                      const cells = lakeFactCells(row);
                      const isPicked = selection.has(row.id);
                      return (
                        <tr key={row.id} data-selected={isPicked}>
                          <td>
                            <input
                              type="checkbox"
                              className="tl-check"
                              aria-label={`Select ${row.company}${row.title ? ` - ${row.title}` : ''}`}
                              checked={isPicked}
                              onChange={() => pick(row)}
                            />
                          </td>
                          <td className="whitespace-nowrap">
                            <span title={formatDate(row.updatedAt)}>{formatDate(row.updatedAt, { style: 'date' })}</span>
                          </td>
                          <td className="min-w-28">
                            <span className="font-medium text-ink wrap-anywhere">{row.company}</span>
                          </td>
                          <td className="min-w-28 wrap-anywhere hyphens-auto">{row.jobFieldLabel}</td>
                          <td className="min-w-32">
                            {row.title ? <WebLink value={row.url}>{row.title}</WebLink> : <Cell muted>-</Cell>}
                          </td>
                          <td className="min-w-24 wrap-anywhere">{formatSalary(row.salary) || <Cell muted>-</Cell>}</td>
                          <td className="whitespace-nowrap">{cells.jobType || <Cell muted>-</Cell>}</td>
                          <td className="whitespace-nowrap">{cells.clearance}</td>
                          <td className="min-w-28 wrap-anywhere hyphens-auto">{cells.industry || <Cell muted>-</Cell>}</td>
                          {admin && (
                            <td>
                              {/* An address is long: cut to the column, the whole of it in the title (and Details). */}
                              <span
                                className="block max-w-28 truncate"
                                title={describeRequester({ requester: row.requester ?? null, requestedBy: row.requestedBy ?? null })}
                              >
                                {describeRequester({ requester: row.requester ?? null, requestedBy: row.requestedBy ?? null })}
                              </span>
                              {row.source === 'merge' && (
                                <span className="mt-1 block">
                                  <Pill tone="violet">Merged</Pill>
                                </span>
                              )}
                            </td>
                          )}
                          <td data-align="right" data-sticky-end>
                            <button type="button" className="tl-button-quiet" data-size="sm" onClick={() => setOpenId(row.id)}>
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
      </div>

      {ordering && (
        <OrderJobsDialog
          rows={picked}
          onClose={() => setOrdering(false)}
          onPlaced={(order, total) => {
            setOrdering(false);
            setSelection(new Map());
            setSelectionNote('');
            if (order) setPlacedOrder(order);
            else setOrderNotice(`Queued ${total} resume${total === 1 ? '' : 's'}.`);
            setOrdersPlaced((count) => count + 1);
            // The top bar's balance moves with the order.
            void refresh();
          }}
        />
      )}

      {openId !== null && (
        <FindJobDialog
          key={openId}
          id={openId}
          admin={admin}
          selected={selection.has(openId)}
          onToggle={pick}
          onClose={() => setOpenId(null)}
        />
      )}
    </Page>
  );
}
