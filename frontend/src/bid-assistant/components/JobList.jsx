import { useMemo, useState } from 'react';
import { getBidAssistantApiUrl } from '../lib/apiBase.js';

// Returns the search text used to filter visible jobs.
function matchesSearch(job, searchText) {
  const haystack = `${job.company_name} ${job.job_title} ${job.job_url}`.toLowerCase();
  return haystack.includes(searchText.toLowerCase());
}

function getSafeRowNumber(job) {
  return Number.isInteger(job?.row_number) ? job.row_number : Number.MAX_SAFE_INTEGER;
}

function sortJobsByRowNumber(leftJob, rightJob) {
  const rowNumberDifference = getSafeRowNumber(leftJob) - getSafeRowNumber(rightJob);

  if (rowNumberDifference !== 0) {
    return rowNumberDifference;
  }

  return 0;
}

function getDisplayCompanyLabel(job) {
  const companyName = job.company_name || 'Unknown company';
  const displayRowNumber = Number.isInteger(job.display_row_number)
    ? job.display_row_number
    : (Number.isInteger(job.row_number) ? job.row_number : null);

  return displayRowNumber ? `${displayRowNumber}. ${companyName}` : companyName;
}

function getErrorBadgeLabel(job) {
  const errorReason = typeof job?.error_reason === 'string' ? job.error_reason.trim() : '';
  return errorReason ? `Error - ${errorReason}` : 'Error';
}

// Renders the searchable list of job cards.
export default function JobList({ jobs, selectedJobId, onSelectJob, filterDate }) {
  const [searchText, setSearchText] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const [copyError, setCopyError] = useState('');
  const [isCopyModalOpen, setIsCopyModalOpen] = useState(false);
  const [fromRowInput, setFromRowInput] = useState('');
  const [toRowInput, setToRowInput] = useState('');

  const visibleJobs = useMemo(
    () =>
      jobs
        .filter((job) => matchesSearch(job, searchText))
        .map((job, index) => ({ job, index }))
        .sort((leftItem, rightItem) => {
          const rowSort = sortJobsByRowNumber(leftItem.job, rightItem.job);

          if (rowSort !== 0) {
            return rowSort;
          }

          return leftItem.index - rightItem.index;
        })
        .map((item) => item.job),
    [jobs, searchText]
  );

  const copyRangeJobs = useMemo(
    () =>
      jobs
        .filter(
          (job) => Number.isInteger(job.row_number) && Number.isInteger(job.display_row_number)
        )
        .map((job, index) => ({ job, index }))
        .sort((leftItem, rightItem) => {
          const rowSort = sortJobsByRowNumber(leftItem.job, rightItem.job);

          if (rowSort !== 0) {
            return rowSort;
          }

          return leftItem.index - rightItem.index;
        })
        .map((item) => item.job),
    [jobs]
  );

  const relativeRowNumbers = copyRangeJobs
    .map((job) => job.display_row_number)
    .filter((displayRowNumber) => Number.isInteger(displayRowNumber));
  const rowRangeLabel = relativeRowNumbers.length > 0
    ? `${Math.min(...relativeRowNumbers)} - ${Math.max(...relativeRowNumbers)}`
    : '';

  function openCopyModal() {
    setCopyError('');

    if (!filterDate) {
      setCopyMessage('');
      setCopyError('Select one date before copying links by relative row number.');
      return;
    }

    if (relativeRowNumbers.length === 0) {
      setCopyMessage('');
      setCopyError('No relative row numbers are available to copy links from.');
      return;
    }

    setFromRowInput(String(Math.min(...relativeRowNumbers)));
    setToRowInput(String(Math.max(...relativeRowNumbers)));
    setIsCopyModalOpen(true);
  }

  function closeCopyModal() {
    setIsCopyModalOpen(false);
  }

  async function handleCopyLinks(event) {
    event.preventDefault();

    try {
      setCopyError('');

      const fromRow = Number(fromRowInput);
      const toRow = Number(toRowInput);

      if (!Number.isInteger(fromRow) || !Number.isInteger(toRow) || fromRow > toRow) {
        throw new Error('Enter a valid row range where From is less than or equal to To.');
      }

      if (!filterDate) {
        throw new Error('Select one date before copying links by relative row number.');
      }

      const jobsInRelativeRange = copyRangeJobs.filter(
        (job) => job.display_row_number >= fromRow && job.display_row_number <= toRow
      );

      if (jobsInRelativeRange.length === 0) {
        throw new Error('No jobs were found in that relative row range.');
      }

      const absoluteRowNumbers = jobsInRelativeRange
        .map((job) => job.row_number)
        .filter((rowNumber) => Number.isInteger(rowNumber));

      const query = new URLSearchParams({
        fromRow: String(Math.min(...absoluteRowNumbers)),
        toRow: String(Math.max(...absoluteRowNumbers)),
        date: filterDate
      });

      const response = await fetch(getBidAssistantApiUrl(`/api/jobs/copy-links?${query.toString()}`));
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || 'Could not load links for that row range.');
      }

      const jobLinks = Array.isArray(data?.links) ? data.links : [];
      const skippedErrorCount = Number.isInteger(data?.skippedErrorCount) ? data.skippedErrorCount : 0;

      if (jobLinks.length === 0) {
        throw new Error('No eligible job links were found in that row range.');
      }

      await navigator.clipboard.writeText(jobLinks.join('\n'));
      setCopyMessage(
        skippedErrorCount > 0
          ? `${fromRow} to ${toRow} copied, ${skippedErrorCount} error skipped`
          : `${fromRow} to ${toRow} copied`
      );
      closeCopyModal();
    } catch (error) {
      setCopyError(error.message || 'Could not copy links.');
    }
  }

  return (
    <aside className="job-list-panel">
      <div className="job-list-header">
        <input
          className="search-input"
          type="text"
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          placeholder="Search jobs"
        />
        <div className="job-list-stats">
          <strong>{visibleJobs.length}</strong>
          <span>{visibleJobs.length === 1 ? 'item' : 'items'}</span>
          {rowRangeLabel && <span>rows {rowRangeLabel}</span>}
          <button className="text-button" onClick={openCopyModal}>
            Copy Links
          </button>
          {copyMessage && <span className="job-list-inline-status">{copyMessage}</span>}
          {copyError && <span className="job-list-inline-status error-text">{copyError}</span>}
        </div>
      </div>

      <div className="job-list-scroll">
        {visibleJobs.map((job) => (
          <button
            key={job.id}
            className={`job-card ${job.id === selectedJobId ? 'selected' : ''}`}
            onClick={() => onSelectJob(job.id)}
          >
            <div className="job-card-top">
              <strong>{getDisplayCompanyLabel(job)}</strong>
              <div className="job-card-badges">
                {job.is_error ? (
                  <span className="error-badge">{getErrorBadgeLabel(job)}</span>
                ) : (
                  job.has_answers && <span className="answered-badge">Answered</span>
                )}
              </div>
            </div>
            <div className="job-card-title">{job.job_title || 'Untitled role'}</div>
            <div className="job-card-meta">
              <span>{job.salary_range || 'No salary listed'}</span>
              <span>{job.posted_date || 'No date'}</span>
            </div>
          </button>
        ))}

        {visibleJobs.length === 0 && <p className="empty-state">No jobs match the current filters.</p>}
      </div>

      {isCopyModalOpen && (
        <div className="modal-backdrop" onClick={closeCopyModal}>
          <div className="modal-card copy-range-modal" onClick={(event) => event.stopPropagation()}>
            <button className="icon-button" onClick={closeCopyModal}>
              x
            </button>
            <form onSubmit={handleCopyLinks}>
              <div className="modal-header">
                <div className="modal-header-copy">
                  <h2>Copy Links</h2>
                  <p className="muted-text">Choose the relative row range to copy.</p>
                </div>
              </div>

              <div className="form-grid compact-grid">
                <label className="stacked-field">
                  <span>From row</span>
                  <input
                    type="number"
                    min="1"
                    value={fromRowInput}
                    onChange={(event) => setFromRowInput(event.target.value)}
                  />
                </label>
                <label className="stacked-field">
                  <span>To row</span>
                  <input
                    type="number"
                    min="1"
                    value={toRowInput}
                    onChange={(event) => setToRowInput(event.target.value)}
                  />
                </label>
              </div>

              {copyError && <p className="error-text">{copyError}</p>}

              <div className="form-actions">
                <button type="submit" className="primary-button">
                  Copy
                </button>
                <button type="button" className="secondary-button" onClick={closeCopyModal}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </aside>
  );
}
