import { useEffect, useState } from 'react';
import { getBidAssistantApiUrl } from '../lib/apiBase.js';

async function readResponseData(response) {
  const responseText = await response.text();

  if (!responseText) {
    return null;
  }

  try {
    return JSON.parse(responseText);
  } catch {
    return {
      error: responseText.startsWith('<!DOCTYPE')
        ? 'The backend returned HTML instead of JSON. Restart the backend server and try again.'
        : responseText
    };
  }
}

// Fetches saved answers for one job id.
async function fetchAnswers(jobId) {
  const response = await fetch(getBidAssistantApiUrl(`/api/answers/${jobId}`));
  const data = await readResponseData(response);

  if (!response.ok) {
    throw new Error(data?.error || 'Failed to load answers.');
  }

  return data || {};
}

async function deleteSavedAnswer(jobId, profileId, question) {
  const query = new URLSearchParams({
    profileId,
    question
  });
  const response = await fetch(getBidAssistantApiUrl(`/api/answers/${jobId}?${query.toString()}`), {
    method: 'DELETE'
  });
  const data = await readResponseData(response);

  if (!response.ok) {
    throw new Error(data?.error || 'Failed to delete answer.');
  }
}

// Returns a display name for the selected profile.
function getProfileDisplayName(profile) {
  return profile?.name || profile?.fullName || profile?.id || 'Untitled Profile';
}

// Returns the contact object for a profile record.
function getProfileContact(profile) {
  return profile?.contact && typeof profile.contact === 'object' ? profile.contact : {};
}

function getDisplayCompanyLabel(job) {
  const companyName = job?.company_name || 'Unknown company';
  const displayRowNumber = Number.isInteger(job?.display_row_number)
    ? job.display_row_number
    : (Number.isInteger(job?.row_number) ? job.row_number : null);

  return displayRowNumber ? `${displayRowNumber}. ${companyName}` : companyName;
}

function getErrorBadgeLabel(job) {
  const errorReason = typeof job?.error_reason === 'string' ? job.error_reason.trim() : '';
  return errorReason ? `Error - ${errorReason}` : 'Error';
}

// Renders the job detail modal content.
function JobInfoModal({ job, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card detail-modal" onClick={(event) => event.stopPropagation()}>
        <button className="icon-button" onClick={onClose}>
          x
        </button>

        <section className="detail-section hero-section">
          <div className="hero-copy">
            <p className="eyebrow">{job.company_name}</p>
            <h1>{job.job_title}</h1>
            <div className="hero-meta">
              <span>{job.salary_range || 'No salary listed'}</span>
              <span>{job.posted_date || 'No date'}</span>
            </div>
            <a href={job.job_url} target="_blank" rel="noreferrer" className="job-link">
              Open job posting
            </a>
          </div>
          <p className="job-description">{job.description || 'No job description saved yet.'}</p>
        </section>

        {job.comment && (
          <section className="detail-section">
            <div className="section-header">
              <h2>Comment</h2>
            </div>
            <p className="job-description">{job.comment}</p>
          </section>
        )}
      </div>
    </div>
  );
}

// Renders the modal for setting one job Error status and reason.
function JobErrorModal({
  errorReasonDraft,
  isSavingJobError,
  onClose,
  onChangeErrorReason,
  onSave
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card job-error-modal" onClick={(event) => event.stopPropagation()}>
        <div className="section-header modal-header">
          <div className="modal-header-copy">
            <h2>Set Error</h2>
            <p className="muted-text">
              Mark this job as Error and add a reason. Error jobs will be skipped by Copy Links.
            </p>
          </div>
        </div>

        <div className="job-error-form">
          <label className="stacked-field">
            <span>Error reason</span>
            <input
              type="text"
              value={errorReasonDraft}
              onChange={(event) => onChangeErrorReason(event.target.value)}
              placeholder="Clearance Required, Expired, etc."
            />
          </label>

          <div className="form-actions">
            <button className="primary-button" onClick={onSave} disabled={isSavingJobError}>
              {isSavingJobError ? 'Saving...' : 'Save'}
            </button>
            <button className="secondary-button" onClick={onClose} disabled={isSavingJobError}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Renders the profile multi-select panel for deleting one saved answer.
function DeleteAnswerModal({
  question,
  profiles,
  initialTargetProfileIds,
  isDeleting,
  onClose,
  onDelete
}) {
  const [targetProfileIds, setTargetProfileIds] = useState(initialTargetProfileIds);
  const [errorMessage, setErrorMessage] = useState('');

  function toggleTargetProfile(targetProfileId) {
    setTargetProfileIds((currentIds) =>
      currentIds.includes(targetProfileId)
        ? currentIds.filter((id) => id !== targetProfileId)
        : [...currentIds, targetProfileId]
    );
  }

  async function handleDelete() {
    try {
      if (targetProfileIds.length === 0) {
        throw new Error('Select at least one profile.');
      }

      setErrorMessage('');
      await onDelete(targetProfileIds);
    } catch (error) {
      setErrorMessage(error.message);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!isDeleting) {
          onClose();
        }
      }}
    >
      <div className="modal-card ask-modal" onClick={(event) => event.stopPropagation()}>
        <div className="section-header modal-header">
          <div className="modal-header-copy">
            <h2>Delete Answer</h2>
            <p className="muted-text">
              Select the profiles that should remove this saved answer.
            </p>
          </div>
        </div>

        <label className="stacked-field">
          <span>Question</span>
          <input value={question} readOnly />
        </label>

        <div className="stacked-field">
          <span>Delete from:</span>
          <div className="checkbox-list profile-checkbox-list">
            {profiles.map((profile) => (
              <label key={profile.id} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={targetProfileIds.includes(profile.id)}
                  onChange={() => toggleTargetProfile(profile.id)}
                  disabled={isDeleting}
                />
                <span>{getProfileDisplayName(profile)}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="form-actions">
          <button
            type="button"
            className="secondary-button danger-button"
            onClick={handleDelete}
            disabled={isDeleting}
          >
            {isDeleting ? 'Deleting...' : 'Delete Answer'}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={isDeleting}
          >
            Cancel
          </button>
        </div>

        {errorMessage && <p className="error-text">{errorMessage}</p>}
      </div>
    </div>
  );
}
// Renders the profile detail modal content.
function ProfileInfoModal({ profile, onClose }) {
  const contact = getProfileContact(profile);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card detail-modal" onClick={(event) => event.stopPropagation()}>
        <button className="icon-button" onClick={onClose}>
          x
        </button>

        <section className="detail-section">
          <div className="section-header">
            <h2>{getProfileDisplayName(profile)}</h2>
          </div>

          <div className="profile-overview-grid">
            <div className="profile-overview-item">
              <span>Title</span>
              <strong>{profile?.title || 'Not set'}</strong>
            </div>
            <div className="profile-overview-item">
              <span>Email</span>
              <strong>{contact.email || 'Not set'}</strong>
            </div>
            <div className="profile-overview-item">
              <span>Phone</span>
              <strong>{contact.phone || 'Not set'}</strong>
            </div>
            <div className="profile-overview-item">
              <span>Location</span>
              <strong>{contact.location || 'Not set'}</strong>
            </div>
            <div className="profile-overview-item">
              <span>Total Experience</span>
              <strong>
                {typeof profile?.totalYearsExperience === 'number'
                  ? `${profile.totalYearsExperience} years`
                  : 'Not set'}
              </strong>
            </div>
            <div className="profile-overview-item">
              <span>Template</span>
              <strong>{profile?.preferredTemplate || 'Not set'}</strong>
            </div>
            <div className="profile-overview-item">
              <span>Status</span>
              <strong>{profile?.disabled ? 'Disabled' : 'Active'}</strong>
            </div>
          </div>

          <p className="muted-text">
            Use the profile manager in the top bar to create, edit, or delete full profile JSON records.
          </p>
        </section>
      </div>
    </div>
  );
}

// Renders the answers-first workspace for the selected job and profile.
export default function JobDetail({
  job,
  profile,
  profiles,
  profileId,
  hasPreviousJob,
  hasNextJob,
  onSelectPreviousJob,
  onSelectNextJob,
  onOpenAskModal,
  onJobErrorUpdated,
  onJobDeleted,
  onAnswersReady,
  answersRefreshToken
}) {
  const [activeModal, setActiveModal] = useState(null);
  const [answersByProfile, setAnswersByProfile] = useState({});
  const [errorMessage, setErrorMessage] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [deletingQuestion, setDeletingQuestion] = useState('');
  const [deleteAnswerQuestion, setDeleteAnswerQuestion] = useState('');
  const [copiedQuestion, setCopiedQuestion] = useState('');
  const [errorReasonDraft, setErrorReasonDraft] = useState(job?.error_reason || '');
  const [isSavingJobError, setIsSavingJobError] = useState(false);
  const [isDeletingJob, setIsDeletingJob] = useState(false);

  const answers = answersByProfile[profileId] || [];

  useEffect(() => {
    setErrorReasonDraft(job?.error_reason || '');
  }, [job?.id, job?.error_reason]);

  useEffect(() => {
    let cancelled = false;

    async function loadAnswers() {
      if (!job) {
        setAnswersByProfile({});
        return;
      }

      try {
        const answerData = await fetchAnswers(job.id);

        if (!cancelled) {
          setAnswersByProfile(answerData);
          setErrorMessage('');
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error.message);
        }
      }
    }

    loadAnswers();

    return () => {
      cancelled = true;
    };
  }, [job, answersRefreshToken]);

  async function handleDeleteAnswer(question, targetProfileIds) {
    try {
      const profileIds = [...new Set(
        (Array.isArray(targetProfileIds) ? targetProfileIds : [profileId]).filter(Boolean)
      )];

      if (profileIds.length === 0) {
        throw new Error('Select at least one profile.');
      }

      setDeletingQuestion(question);
      setErrorMessage('');
      setActionMessage('');
      await Promise.all(profileIds.map((targetProfileId) => deleteSavedAnswer(job.id, targetProfileId, question)));
      const answerData = await fetchAnswers(job.id);
      setAnswersByProfile(answerData);
      setActionMessage(`Saved answer deleted for ${profileIds.length} profile${profileIds.length === 1 ? '' : 's'}.`);
      closeDeleteAnswerModal();
    } catch (error) {
      setErrorMessage(error.message);
      throw error;
    } finally {
      setDeletingQuestion('');
    }
  }

  async function handleCopyAnswer(question, answer) {
    try {
      await navigator.clipboard.writeText(answer);
      setCopiedQuestion(question);
      setActionMessage('Answer copied to clipboard.');
      window.setTimeout(() => {
        setCopiedQuestion((currentQuestion) => (currentQuestion === question ? '' : currentQuestion));
      }, 1500);
    } catch (error) {
      setErrorMessage('Could not copy answer.');
    }
  }

  async function handleCopyJobUrl(jobUrl) {
    try {
      await navigator.clipboard.writeText(jobUrl);
      setErrorMessage('');
      setActionMessage('Job link copied to clipboard.');
    } catch (error) {
      setErrorMessage('Could not copy job link.');
    }
  }

  async function handleSaveJobError() {
    try {
      setIsSavingJobError(true);
      setErrorMessage('');
      setActionMessage('');

      const normalizedReason = errorReasonDraft.trim();
      await onJobErrorUpdated(job.id, true, normalizedReason);

      setActionMessage('Job marked as Error.');
      setActiveModal(null);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsSavingJobError(false);
    }
  }

  async function handleDeleteJob() {
    try {
      const isConfirmed = window.confirm('Delete this job, its link, and all saved answers?');

      if (!isConfirmed) {
        return;
      }

      setIsDeletingJob(true);
      setErrorMessage('');
      setActionMessage('');
      await onJobDeleted(job.id);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsDeletingJob(false);
    }
  }

  function openJobErrorModal() {
    setErrorReasonDraft(job?.error_reason || '');
    setActiveModal('job-error');
  }

  function openDeleteAnswerModal(question) {
    setDeleteAnswerQuestion(question);
    setActiveModal('delete-answer');
    setErrorMessage('');
    setActionMessage('');
  }

  function closeDeleteAnswerModal() {
    setActiveModal(null);
    setDeleteAnswerQuestion('');
  }

  if (!job) {
    return (
      <main className="job-detail-panel empty-detail">
        <p>Select a job from the list</p>
      </main>
    );
  }

  return (
    <main className="job-detail-panel">
      <section className="detail-section workspace-hero">
        <div className="workspace-copy">
          <p className="eyebrow">AI Workspace</p>
          <div className="workspace-title-row">
            <h1 title={getDisplayCompanyLabel(job)}>{getDisplayCompanyLabel(job)}</h1>
            <div className="workspace-nav-buttons">
              <button
                className="secondary-button nav-arrow-button"
                onClick={onSelectPreviousJob}
                disabled={!hasPreviousJob}
                title="Previous job"
              >
                {'<'}
              </button>
              <button
                className="secondary-button nav-arrow-button"
                onClick={onSelectNextJob}
                disabled={!hasNextJob}
                title="Next job"
              >
                {'>'}
              </button>
            </div>
          </div>
          <p className="workspace-summary">
            {job.job_title || 'Untitled role'}
          </p>
          <div className="hero-meta">
            <span>{job.salary_range || 'No salary listed'}</span>
            <span>{job.posted_date || 'No date'}</span>
            <span>{answers.length} saved answer(s)</span>
            {job.is_error && <span className="error-badge">{getErrorBadgeLabel(job)}</span>}
          </div>
          {job.job_url && (
            <div className="job-link-row">
              <button
                type="button"
                className="icon-button job-link-copy-button"
                onClick={() => handleCopyJobUrl(job.job_url)}
                aria-label="Copy job link"
                title="Copy job link"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              </button>
              <a href={job.job_url} target="_blank" rel="noreferrer" className="job-link">
                {job.job_url}
              </a>
            </div>
          )}
        </div>

        <div className="workspace-actions">
          <button className="primary-button" onClick={onOpenAskModal} disabled={!profile}>
            Ask AI
          </button>
          <button className="secondary-button danger-button" onClick={openJobErrorModal}>
            Set Error
          </button>
          <button className="secondary-button danger-button" onClick={handleDeleteJob} disabled={isDeletingJob}>
            {isDeletingJob ? 'Deleting...' : 'Delete Job'}
          </button>
          <button className="secondary-button" onClick={() => setActiveModal('job')}>
            See Job Detail
          </button>
          <button
            className="secondary-button"
            onClick={() => setActiveModal('profile')}
            disabled={!profile}
          >
            See Profile Detail
          </button>
        </div>
      </section>

      <section className="detail-section answers-section">
        <div className="section-header answers-header">
          <h2>Saved Answers</h2>
          <p className="muted-text answers-summary">
            {answers.length > 0
              ? `${answers.length} answer${answers.length === 1 ? '' : 's'} saved for ${getProfileDisplayName(profile)}.`
              : `No answers saved yet for ${getProfileDisplayName(profile)}.`}
          </p>
        </div>

        {answers.map((item) => (
          <article key={item.id || `${item.question}-${item.charLimit}`} className="answer-card">
            <div className="answer-card-top">
              <strong>{item.question}</strong>
              <div className="answer-card-actions">
                <span className="char-badge">
                  {item.answer.length} / {item.charLimit}
                </span>
                <div className="answer-action-buttons">
                  <button
                    className="text-button"
                    onClick={() => onOpenAskModal({
                      mode: 'resubmit',
                      focusProfileId: profileId,
                      initialTargetProfileIds: profiles.map((targetProfile) => targetProfile.id),
                      initialQuestions: [
                        {
                          question: item.question,
                          charLimit: item.charLimit,
                          replaceAnswerId: item.id
                        }
                      ]
                    })}
                  >
                    Resubmit
                  </button>
                  <button
                    className="text-button danger-text"
                    onClick={() => openDeleteAnswerModal(item.question)}
                    disabled={deletingQuestion === item.question}
                  >
                    {deletingQuestion === item.question ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              </div>
            </div>
            <p
              className={`answer-copy-target ${copiedQuestion === item.question ? 'copied' : ''}`}
              onClick={() => handleCopyAnswer(item.question, item.answer)}
              title="Click to copy"
            >
              {item.answer}
            </p>
          </article>
        ))}

        {answers.length === 0 && (
          <div className="answer-empty-state">
            <p className="empty-state">No saved answers for this profile yet.</p>
            <button className="secondary-button" onClick={onOpenAskModal} disabled={!profile}>
              Open Ask AI
            </button>
          </div>
        )}
      </section>

      {actionMessage && <p className="success-text">{actionMessage}</p>}
      {errorMessage && <p className="error-text">{errorMessage}</p>}

      {activeModal === 'job' && <JobInfoModal job={job} onClose={() => setActiveModal(null)} />}
      {activeModal === 'job-error' && (
        <JobErrorModal
          errorReasonDraft={errorReasonDraft}
          isSavingJobError={isSavingJobError}
          onClose={() => setActiveModal(null)}
          onChangeErrorReason={setErrorReasonDraft}
          onSave={handleSaveJobError}
        />
      )}
      {activeModal === 'delete-answer' && deleteAnswerQuestion && (
        <DeleteAnswerModal
          question={deleteAnswerQuestion}
          profiles={profiles}
          initialTargetProfileIds={profiles.map((targetProfile) => targetProfile.id)}
          isDeleting={deletingQuestion === deleteAnswerQuestion}
          onClose={closeDeleteAnswerModal}
          onDelete={(targetProfileIds) => handleDeleteAnswer(deleteAnswerQuestion, targetProfileIds)}
        />
      )}
      {activeModal === 'profile' && profile && (
        <ProfileInfoModal profile={profile} onClose={() => setActiveModal(null)} />
      )}
    </main>
  );
}
