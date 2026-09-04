import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_PROMPT_TEMPLATE } from '../lib/promptTemplate.js';
import { getBidAssistantApiUrl } from '../lib/apiBase.js';

// Creates a blank question row with a default character limit.
function createQuestionRow(overrides = {}) {
  return {
    question: '',
    charLimit: 500,
    isManualAnswer: false,
    manualAnswer: '',
    replaceAnswerId: null,
    ...overrides
  };
}

function getInitialQuestions(initialQuestions) {
  if (!Array.isArray(initialQuestions) || initialQuestions.length === 0) {
    return [createQuestionRow()];
  }

  return initialQuestions.map((item) => createQuestionRow({
    question: typeof item?.question === 'string' ? item.question : '',
    charLimit: Number(item?.charLimit) || 500,
    isManualAnswer: Boolean(item?.isManualAnswer),
    manualAnswer: typeof item?.manualAnswer === 'string' ? item.manualAnswer : '',
    replaceAnswerId: Number.isInteger(Number(item?.replaceAnswerId)) ? Number(item.replaceAnswerId) : null
  }));
}

// Returns only question rows that have actual question text.
function getFilledQuestions(questions) {
  return questions
    .filter((item) => item.question.trim())
    .map((item) => ({
      question: item.question.trim(),
      charLimit: item.charLimit,
      isManualAnswer: Boolean(item.isManualAnswer),
      manualAnswer: typeof item.manualAnswer === 'string' ? item.manualAnswer.trim() : '',
      replaceAnswerId: Number.isInteger(item.replaceAnswerId) ? item.replaceAnswerId : null
    }));
}

// Returns a display label for one profile record.
function getProfileDisplayName(profile) {
  return profile?.name || profile?.id || 'Untitled Profile';
}

// Renders the modal for generating AI answers for selected profiles.
export default function AskWindow({
  job,
  profiles,
  defaultFocusProfileId,
  initialQuestions,
  initialTargetProfileIds,
  mode = 'create',
  promptTemplate,
  onClose,
  onAnswersReady
}) {
  const [focusProfileId, setFocusProfileId] = useState(defaultFocusProfileId);
  const [targetProfileIds, setTargetProfileIds] = useState(
    Array.isArray(initialTargetProfileIds) && initialTargetProfileIds.length > 0
      ? initialTargetProfileIds
      : profiles.map((profile) => profile.id)
  );
  const [questions, setQuestions] = useState(() => getInitialQuestions(initialQuestions));
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    if (profiles.length > 0 && !profiles.some((profile) => profile.id === focusProfileId)) {
      setFocusProfileId(profiles[0].id);
    }
  }, [focusProfileId, profiles]);

  const focusProfileName = getProfileDisplayName(
    profiles.find((profile) => profile.id === focusProfileId) || null
  );

  function handleClose(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    onClose();
  }

  // Resets focus and target profiles when the modal inputs change.
  useEffect(() => {
    setFocusProfileId(defaultFocusProfileId);
    setTargetProfileIds(
      Array.isArray(initialTargetProfileIds) && initialTargetProfileIds.length > 0
        ? initialTargetProfileIds
        : profiles.map((profile) => profile.id)
    );
    setQuestions(getInitialQuestions(initialQuestions));
  }, [defaultFocusProfileId, initialQuestions, initialTargetProfileIds, profiles]);

  // Toggles one profile in the target profile checkbox list.
  function toggleTargetProfile(profileId) {
    setTargetProfileIds((currentIds) =>
      currentIds.includes(profileId)
        ? currentIds.filter((id) => id !== profileId)
        : [...currentIds, profileId]
    );
  }

  // Updates one field inside a question row.
  function updateQuestion(index, fieldName, value) {
    setQuestions((currentQuestions) =>
      currentQuestions.map((item, itemIndex) =>
        itemIndex === index
          ? {
              ...item,
              [fieldName]: fieldName === 'charLimit' ? Number(value) || 0 : value
            }
          : item
      )
    );
  }

  // Toggles manual-answer mode for one question row.
  function toggleManualAnswer(index) {
    setQuestions((currentQuestions) =>
      currentQuestions.map((item, itemIndex) =>
        itemIndex === index
          ? {
              ...item,
              isManualAnswer: !item.isManualAnswer,
              manualAnswer: item.isManualAnswer ? '' : item.manualAnswer
            }
          : item
      )
    );
  }

  // Removes one question row from the modal.
  function removeQuestion(index) {
    setQuestions((currentQuestions) => currentQuestions.filter((_, itemIndex) => itemIndex !== index));
  }

  // Adds one more blank question row to the modal.
  function addQuestion() {
    setQuestions((currentQuestions) => [...currentQuestions, createQuestionRow()]);
  }

  // Sends the ask request and stores returned answers for the focus profile.
  async function handleSubmit() {
    try {
      if (!focusProfileId) {
        throw new Error('Select a focus profile.');
      }

      const filledQuestions = getFilledQuestions(questions);
      const profileIds = targetProfileIds.includes(focusProfileId)
        ? targetProfileIds
        : [focusProfileId, ...targetProfileIds];

      if (profileIds.length === 0) {
        throw new Error('Select at least one target profile.');
      }

      if (filledQuestions.length === 0) {
        throw new Error('Add at least one question.');
      }

      if (filledQuestions.some((item) => item.isManualAnswer && !item.manualAnswer)) {
        throw new Error('Add the manual answer text for each question marked MA.');
      }

      const hasAiQuestion = filledQuestions.some((item) => !item.isManualAnswer);

      const activePromptTemplate = hasAiQuestion
        ? (
            typeof promptTemplate === 'string' && promptTemplate.trim()
              ? promptTemplate
              : DEFAULT_PROMPT_TEMPLATE
          )
        : '';

      if (hasAiQuestion && !activePromptTemplate.trim()) {
        throw new Error('Add a prompt template.');
      }

      setLoading(true);
      setErrorMessage('');

      const response = await fetch(getBidAssistantApiUrl('/api/ask'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          jobId: job.id,
          jobTitle: job.job_title,
          companyName: job.company_name,
          jobDescription: job.description,
          focusProfileId,
          targetProfileIds: profileIds,
          questions: filledQuestions,
          promptTemplate: activePromptTemplate
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Answer generation failed.');
      }

      onAnswersReady();
      onClose();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  const isResubmitMode = mode === 'resubmit';
  const modalTitle = isResubmitMode ? 'Resubmit Answer' : 'Ask AI';
  const modalDescription = isResubmitMode
    ? 'Resend this question and replace the saved answer with the new result. You can change the question and character limit first.'
    : 'Generate answers for one or more profiles. New answers will appear in the main workspace.';
  const submitLabel = isResubmitMode ? 'Update Answer' : `Generate Answers for ${focusProfileName}`;

  const content = (
    <>
      <div className="section-header modal-header">
        <div className="modal-header-copy">
          <h2>{modalTitle}</h2>
          <p className="muted-text">{modalDescription}</p>
        </div>
      </div>

      <label className="stacked-field">
        <span>Focus Profile:</span>
        <select value={focusProfileId} onChange={(event) => setFocusProfileId(event.target.value)}>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {getProfileDisplayName(profile)}
            </option>
          ))}
        </select>
      </label>

      <div className="stacked-field">
        <span>Generate for:</span>
        <div className="checkbox-list profile-checkbox-list">
          {profiles.map((profile) => (
            <label key={profile.id} className="checkbox-row">
              <input
                type="checkbox"
                checked={targetProfileIds.includes(profile.id)}
                onChange={() => toggleTargetProfile(profile.id)}
              />
              <span>{getProfileDisplayName(profile)}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="stacked-field">
        <span>Questions</span>
        <div className="question-list">
          {questions.map((item, index) => (
            <div key={index} className="question-item">
              <div className="question-row">
                <input
                  className="question-input"
                  value={item.question}
                  onChange={(event) => updateQuestion(index, 'question', event.target.value)}
                  placeholder="Enter a job application question"
                />
                <label className="char-limit-field">
                  <span>max chars</span>
                  <input
                    type="number"
                    min="1"
                    value={item.charLimit}
                    onChange={(event) => updateQuestion(index, 'charLimit', event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className={`secondary-button question-mode-button ${item.isManualAnswer ? 'active' : ''}`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleManualAnswer(index);
                  }}
                >
                  MA
                </button>
                <button
                  type="button"
                  className="icon-button subtle"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    removeQuestion(index);
                  }}
                >
                  x
                </button>
              </div>

              {item.isManualAnswer && (
                <textarea
                  className="manual-answer-input"
                  value={item.manualAnswer}
                  onChange={(event) => updateQuestion(index, 'manualAnswer', event.target.value)}
                  placeholder="Type the manual answer to save for all selected profiles"
                  rows="4"
                />
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          className="text-button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            addQuestion();
          }}
        >
          + Add Question
        </button>
      </div>

      <button
        type="button"
        className="primary-button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          handleSubmit();
        }}
        disabled={loading}
      >
        {loading ? 'Generating...' : submitLabel}
      </button>

      {errorMessage && <p className="error-text">{errorMessage}</p>}
    </>
  );

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          handleClose(event);
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          handleClose(event);
        }
      }}
    >
      <div
        className="modal-card ask-modal"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {content}
      </div>
    </div>,
    document.body
  );
}
