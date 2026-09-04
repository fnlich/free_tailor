import { useEffect, useMemo, useState } from 'react';
import TopBar from './components/TopBar.jsx';
import JobList from './components/JobList.jsx';
import JobDetail from './components/JobDetail.jsx';
import AskWindow from './components/AskWindow.jsx';
import { getBidAssistantApiUrl } from './lib/apiBase.js';
import { DEFAULT_PROMPT_TEMPLATE } from './lib/promptTemplate.js';

const selectedProfileStorageKey = 'selected-profile-id';

// Fetches JSON from the backend and throws on request failure.
async function fetchJson(url, options = {}) {
  const response = await fetch(getBidAssistantApiUrl(url), options);

  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(errorData?.error || 'Request failed.');
  }

  return response.json();
}

// Loads the job list for the selected date filter.
async function fetchJobs(date) {
  const query = new URLSearchParams();

  if (date) {
    query.set('date', date);
  }

  const queryText = query.toString();
  return fetchJson(`/api/jobs${queryText ? `?${queryText}` : ''}`);
}

// Loads all jobs without filters so the UI can list every date option.
async function fetchAllJobs() {
  return fetchJson('/api/jobs');
}

// Loads all profiles from the backend.
async function fetchProfiles() {
  return fetchJson('/api/profiles');
}

// Loads all saved Google Sheet sources from the backend.
async function fetchGoogleSheets() {
  return fetchJson('/api/google-sheets');
}

// Saves the Error marker and reason for one job.
async function updateJobError(jobId, isError, errorReason) {
  return fetchJson(`/api/jobs/${jobId}/error`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      isError,
      errorReason
    })
  });
}

// Deletes one job and its saved answers from the backend.
async function deleteJob(jobId) {
  return fetchJson(`/api/jobs/${jobId}`, {
    method: 'DELETE'
  });
}

// Loads the persisted Ask AI prompt template from the backend.
async function fetchPromptTemplate() {
  const data = await fetchJson('/api/settings/prompt-template');
  return typeof data?.promptTemplate === 'string' && data.promptTemplate.trim()
    ? data.promptTemplate
    : DEFAULT_PROMPT_TEMPLATE;
}

// Saves the Ask AI prompt template to the backend.
async function updatePromptTemplate(promptTemplate) {
  const data = await fetchJson('/api/settings/prompt-template', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ promptTemplate })
  });

  return typeof data?.promptTemplate === 'string' && data.promptTemplate.trim()
    ? data.promptTemplate
    : DEFAULT_PROMPT_TEMPLATE;
}

function getDateSortValue(dateText) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dateText || '');

  if (!match) {
    return Number.NEGATIVE_INFINITY;
  }

  const [, month, day, year] = match;
  return new Date(Number(year), Number(month) - 1, Number(day)).getTime();
}

function getSafeRowNumber(job) {
  return Number.isInteger(job?.row_number) ? job.row_number : Number.MAX_SAFE_INTEGER;
}

function buildDisplayRowNumberMap(jobList) {
  const jobsByDate = new Map();

  for (const job of jobList) {
    if (!job?.posted_date || !Number.isInteger(job?.row_number)) {
      continue;
    }

    const currentJobs = jobsByDate.get(job.posted_date) || [];
    currentJobs.push(job);
    jobsByDate.set(job.posted_date, currentJobs);
  }

  const displayRowNumberById = new Map();

  for (const jobsForDate of jobsByDate.values()) {
    jobsForDate
      .sort((leftJob, rightJob) => getSafeRowNumber(leftJob) - getSafeRowNumber(rightJob) || leftJob.id - rightJob.id)
      .forEach((job, index) => {
        displayRowNumberById.set(job.id, index + 1);
      });
  }

  return displayRowNumberById;
}

// Returns a stable label for one profile record.
function getProfileDisplayName(profile) {
  return profile?.name || profile?.id || 'Untitled Profile';
}

// Picks the first profile in alphabetical order as the default selection.
function getDefaultProfile(profiles) {
  const sortedProfiles = [...profiles].sort((left, right) =>
    getProfileDisplayName(left).localeCompare(getProfileDisplayName(right))
  );

  return sortedProfiles[0] || null;
}

function loadSelectedProfileId() {
  if (typeof window === 'undefined') {
    return '';
  }

  return window.localStorage.getItem(selectedProfileStorageKey) || '';
}

function saveSelectedProfileId(profileId) {
  if (typeof window === 'undefined') {
    return;
  }

  if (profileId) {
    window.localStorage.setItem(selectedProfileStorageKey, profileId);
    return;
  }

  window.localStorage.removeItem(selectedProfileStorageKey);
}

// Renders the main application layout and coordinates global state.
export default function App() {
  const [jobs, setJobs] = useState([]);
  const [allJobs, setAllJobs] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [googleSheets, setGoogleSheets] = useState([]);
  const [selectedJobId, setSelectedJobId] = useState(null);
  const [selectedProfileId, setSelectedProfileId] = useState(loadSelectedProfileId);
  const [filterDate, setFilterDate] = useState('');
  const [askWindowState, setAskWindowState] = useState(null);
  const [promptTemplate, setPromptTemplate] = useState(DEFAULT_PROMPT_TEMPLATE);
  const [hasLoadedAllJobs, setHasLoadedAllJobs] = useState(false);
  const [hasInitializedDateFilter, setHasInitializedDateFilter] = useState(false);
  const [answersRefreshToken, setAnswersRefreshToken] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');

  const displayRowNumberById = useMemo(() => buildDisplayRowNumberMap(allJobs), [allJobs]);
  const jobsWithDisplayRowNumber = useMemo(
    () => jobs.map((job) => ({
      ...job,
      display_row_number: displayRowNumberById.get(job.id) ?? null
    })),
    [jobs, displayRowNumberById]
  );
  const selectedJob = jobsWithDisplayRowNumber.find((job) => job.id === selectedJobId) || null;
  const selectedJobIndex = jobsWithDisplayRowNumber.findIndex((job) => job.id === selectedJobId);
  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) || null;
  const availableDates = [...new Set(allJobs.map((job) => job.posted_date).filter(Boolean))]
    .sort((leftDate, rightDate) => getDateSortValue(rightDate) - getDateSortValue(leftDate) || rightDate.localeCompare(leftDate));

  // Loads the full job list for date dropdown options.
  useEffect(() => {
    let cancelled = false;

    // Fetches unfiltered jobs for date options and initial selection.
    async function loadAllJobs() {
      try {
        const jobList = await fetchAllJobs();

        if (!cancelled) {
          setAllJobs(jobList);
          setHasLoadedAllJobs(true);
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error.message);
          setHasLoadedAllJobs(true);
        }
      }
    }

    loadAllJobs();

    return () => {
      cancelled = true;
    };
  }, []);

  // Loads the persisted Ask AI prompt template once during startup.
  useEffect(() => {
    let cancelled = false;

    async function loadPromptTemplate() {
      try {
        const nextPromptTemplate = await fetchPromptTemplate();

        if (!cancelled) {
          setPromptTemplate(nextPromptTemplate);
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error.message);
        }
      }
    }

    loadPromptTemplate();

    return () => {
      cancelled = true;
    };
  }, []);

  // Uses the newest available job date as the initial date filter.
  useEffect(() => {
    if (!hasLoadedAllJobs || hasInitializedDateFilter) {
      return;
    }

    setFilterDate(availableDates[0] || '');
    setHasInitializedDateFilter(true);
  }, [availableDates, hasInitializedDateFilter, hasLoadedAllJobs]);

  // Loads profile records and sets the default selected profile.
  useEffect(() => {
    let cancelled = false;

    // Fetches available profiles from the backend.
    async function loadProfiles() {
      try {
        const profileList = await fetchProfiles();

        if (!cancelled) {
          setProfiles(profileList);

        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error.message);
        }
      }
    }

    loadProfiles();

    return () => {
      cancelled = true;
    };
  }, []);

  // Keeps the selected profile aligned with the current profile list.
  useEffect(() => {
    if (profiles.length === 0) {
      setSelectedProfileId('');
      saveSelectedProfileId('');
      return;
    }

    const hasCurrentSelection = profiles.some((profile) => profile.id === selectedProfileId);

    if (!hasCurrentSelection) {
      const defaultProfile = getDefaultProfile(profiles);
      const nextProfileId = defaultProfile?.id || '';
      setSelectedProfileId(nextProfileId);
      saveSelectedProfileId(nextProfileId);
    }
  }, [profiles, selectedProfileId]);

  // Loads saved Google Sheet sources for the import workflow.
  useEffect(() => {
    let cancelled = false;

    // Fetches saved Google Sheet sources from the backend.
    async function loadGoogleSheets() {
      try {
        const sheetList = await fetchGoogleSheets();

        if (!cancelled) {
          setGoogleSheets(sheetList);
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error.message);
        }
      }
    }

    loadGoogleSheets();

    return () => {
      cancelled = true;
    };
  }, []);

  // Reloads jobs whenever the selected profile or date filter changes.
  useEffect(() => {
    if (!hasLoadedAllJobs || !hasInitializedDateFilter) {
      return;
    }

    let cancelled = false;

    // Fetches the filtered job list for the current toolbar filters.
    async function loadJobs() {
      try {
        const jobList = await fetchJobs(filterDate);

        if (cancelled) {
          return;
        }

        setJobs(jobList);
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error.message);
        }
      }
    }

    loadJobs();

    return () => {
      cancelled = true;
    };
  }, [selectedProfileId, filterDate, hasLoadedAllJobs, hasInitializedDateFilter]);

  // Keeps the selected job id aligned with the current filtered job list.
  useEffect(() => {
    if (jobs.length === 0) {
      setSelectedJobId(null);
      return;
    }

    const hasCurrentSelection = jobs.some((job) => job.id === selectedJobId);

    if (!hasCurrentSelection) {
      setSelectedJobId(jobs[0].id);
    }
  }, [jobs, selectedJobId]);

  // Refreshes both the filtered and unfiltered job lists after an import.
  async function handleJobsImported() {
    const [nextJobs, nextAllJobs] = await Promise.all([
      fetchJobs(filterDate),
      fetchAllJobs()
    ]);

    setJobs(nextJobs);
    setAllJobs(nextAllJobs);

    if (!selectedJobId && nextJobs.length > 0) {
      setSelectedJobId(nextJobs[0].id);
    }
  }

  // Refreshes profile data after profile CRUD changes.
  async function handleProfilesChanged() {
    const nextProfiles = await fetchProfiles();
    setProfiles(nextProfiles);
    return nextProfiles;
  }

  // Refreshes saved Google Sheet sources after CRUD changes.
  async function handleGoogleSheetsChanged() {
    const sheetList = await fetchGoogleSheets();
    setGoogleSheets(sheetList);
    return sheetList;
  }

  // Saves one job Error marker and updates both filtered and unfiltered job state.
  async function handleJobErrorUpdated(jobId, isError, errorReason) {
    const updatedJob = await updateJobError(jobId, isError, errorReason);

    setJobs((currentJobs) =>
      currentJobs.map((job) => (job.id === jobId ? { ...job, ...updatedJob } : job))
    );
    setAllJobs((currentJobs) =>
      currentJobs.map((job) => (job.id === jobId ? { ...job, ...updatedJob } : job))
    );

    return updatedJob;
  }

  // Deletes one job row from the frontend state after the backend removes it.
  async function handleJobDeleted(jobId) {
    await deleteJob(jobId);

    const nextJobs = jobs.filter((job) => job.id !== jobId);
    const nextAllJobs = allJobs.filter((job) => job.id !== jobId);

    setJobs(nextJobs);
    setAllJobs(nextAllJobs);

    if (selectedJobId === jobId) {
      const deletedIndex = jobs.findIndex((job) => job.id === jobId);
      const fallbackJob = nextJobs[deletedIndex] || nextJobs[deletedIndex - 1] || nextJobs[0] || null;
      setSelectedJobId(fallbackJob?.id || null);
    }
  }

  // Saves one updated Ask AI prompt template and keeps app state in sync.
  async function handlePromptTemplateSaved(nextPromptTemplate) {
    const savedPromptTemplate = await updatePromptTemplate(nextPromptTemplate);
    setPromptTemplate(savedPromptTemplate);
    return savedPromptTemplate;
  }

  // Triggers answer reloads after new AI output is generated.
  function handleAnswersReady() {
    setAnswersRefreshToken((value) => value + 1);
    setJobs((currentJobs) =>
      currentJobs.map((job) =>
        job.id === selectedJobId
          ? {
              ...job,
              has_answers: true
            }
          : job
      )
    );
    setAllJobs((currentJobs) =>
      currentJobs.map((job) =>
        job.id === selectedJobId
          ? {
              ...job,
              has_answers: true
            }
          : job
      )
    );
  }

  function handleDateChange(nextDate) {
    setHasInitializedDateFilter(true);
    setFilterDate(nextDate);
  }

  function handleProfileChange(nextProfileId) {
    setSelectedProfileId(nextProfileId);
    saveSelectedProfileId(nextProfileId);
  }

  function handleOpenAskModal(options = {}) {
    if (!selectedJob || !selectedProfile) {
      return;
    }

    setAskWindowState({
      mode: options.mode || 'create',
      focusProfileId: options.focusProfileId || selectedProfileId,
      initialQuestions: Array.isArray(options.initialQuestions) ? options.initialQuestions : [],
      initialTargetProfileIds: Array.isArray(options.initialTargetProfileIds)
        ? options.initialTargetProfileIds
        : []
    });
  }

  function handleSelectPreviousJob() {
    if (selectedJobIndex <= 0) {
      return;
    }

    setSelectedJobId(jobsWithDisplayRowNumber[selectedJobIndex - 1]?.id || null);
  }

  function handleSelectNextJob() {
    if (selectedJobIndex < 0 || selectedJobIndex >= jobsWithDisplayRowNumber.length - 1) {
      return;
    }

    setSelectedJobId(jobsWithDisplayRowNumber[selectedJobIndex + 1]?.id || null);
  }

  return (
    <div className="app-shell">
      <TopBar
        profiles={profiles}
        googleSheets={googleSheets}
        selectedProfileId={selectedProfileId}
        onProfileChange={handleProfileChange}
        filterDate={filterDate}
        onDateChange={handleDateChange}
        availableDates={availableDates}
        onJobsImported={handleJobsImported}
        onGoogleSheetsChanged={handleGoogleSheetsChanged}
        onProfilesChanged={handleProfilesChanged}
        promptTemplate={promptTemplate}
        onPromptTemplateSaved={handlePromptTemplateSaved}
      />

      <div className="content-shell">
        <JobList
          jobs={jobsWithDisplayRowNumber}
          selectedJobId={selectedJobId}
          onSelectJob={setSelectedJobId}
          filterDate={filterDate}
        />

        <JobDetail
          job={selectedJob}
          profile={selectedProfile}
          profiles={profiles}
          profileId={selectedProfileId}
          hasPreviousJob={selectedJobIndex > 0}
          hasNextJob={selectedJobIndex >= 0 && selectedJobIndex < jobsWithDisplayRowNumber.length - 1}
          onSelectPreviousJob={handleSelectPreviousJob}
          onSelectNextJob={handleSelectNextJob}
          onOpenAskModal={handleOpenAskModal}
          onJobErrorUpdated={handleJobErrorUpdated}
          onJobDeleted={handleJobDeleted}
          answersRefreshToken={answersRefreshToken}
        />
      </div>

      {askWindowState && selectedJob && (
        <AskWindow
          job={selectedJob}
          profiles={profiles}
          defaultFocusProfileId={askWindowState.focusProfileId || selectedProfileId}
          initialQuestions={askWindowState.initialQuestions}
          initialTargetProfileIds={askWindowState.initialTargetProfileIds}
          mode={askWindowState.mode}
          promptTemplate={promptTemplate}
          onClose={() => setAskWindowState(null)}
          onAnswersReady={handleAnswersReady}
        />
      )}

      {errorMessage && <div className="error-banner">{errorMessage}</div>}
    </div>
  );
}
