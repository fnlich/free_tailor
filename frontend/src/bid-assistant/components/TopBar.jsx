import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_PROMPT_TEMPLATE,
  PROMPT_TOKENS
} from '../lib/promptTemplate.js';
import { getBidAssistantApiUrl } from '../lib/apiBase.js';

// Returns the empty form state for creating a new Google Sheet source.
function createEmptySheetForm() {
  return {
    id: null,
    label: '',
    sheetId: ''
  };
}

// Returns the default import range form state.
function createImportRangeForm() {
  return {
    fromRow: '',
    toRow: ''
  };
}

// Returns a blank profile JSON template that matches the real profile shape.
function createEmptyProfileTemplate() {
  return {
    name: '',
    title: '',
    totalYearsExperience: 0,
    preferredTemplate: '',
    disabled: false,
    contact: {
      phone: '',
      email: '',
      linkedin: '',
      github: '',
      portfolio: '',
      location: ''
    },
    summary: '',
    experience: [],
    strengths: [],
    skills: [],
    education: [],
    certifications: []
  };
}

// Returns a stable display label for a profile.
function getProfileDisplayName(profile) {
  return profile?.name || profile?.fullName || profile?.id || 'Untitled Profile';
}

// Returns pretty JSON text for the profile editor.
function formatProfileJson(profile) {
  return `${JSON.stringify(profile, null, 2)}\n`;
}

// Renders the header controls plus source and profile management modals.
export default function TopBar({
  profiles,
  googleSheets,
  selectedProfileId,
  onProfileChange,
  filterDate,
  onDateChange,
  availableDates,
  onJobsImported,
  onGoogleSheetsChanged,
  onProfilesChanged,
  promptTemplate,
  onPromptTemplateSaved
}) {
  const [showImportModal, setShowImportModal] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showPromptModal, setShowPromptModal] = useState(false);
  const [activeSheetId, setActiveSheetId] = useState(null);
  const [sheetForm, setSheetForm] = useState(createEmptySheetForm());
  const [tabs, setTabs] = useState([]);
  const [selectedTabName, setSelectedTabName] = useState('');
  const [importRange, setImportRange] = useState(createImportRangeForm());
  const [importMessage, setImportMessage] = useState('');
  const [importError, setImportError] = useState('');
  const [formMessage, setFormMessage] = useState('');
  const [formError, setFormError] = useState('');
  const [tabsError, setTabsError] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [isSavingSheet, setIsSavingSheet] = useState(false);
  const [isDeletingSheet, setIsDeletingSheet] = useState(false);
  const [isLoadingTabs, setIsLoadingTabs] = useState(false);
  const [activeProfileId, setActiveProfileId] = useState(selectedProfileId || null);
  const [profileJsonText, setProfileJsonText] = useState(formatProfileJson(createEmptyProfileTemplate()));
  const [profileEditorMode, setProfileEditorMode] = useState('create');
  const [profileMessage, setProfileMessage] = useState('');
  const [profileError, setProfileError] = useState('');
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isDeletingProfile, setIsDeletingProfile] = useState(false);
  const [promptTemplateDraft, setPromptTemplateDraft] = useState(promptTemplate || DEFAULT_PROMPT_TEMPLATE);
  const [promptMessage, setPromptMessage] = useState('');
  const [promptError, setPromptError] = useState('');
  const [isSavingPrompt, setIsSavingPrompt] = useState(false);

  const activeSheet = useMemo(
    () => googleSheets.find((sheet) => sheet.id === activeSheetId) || null,
    [googleSheets, activeSheetId]
  );

  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId) || null,
    [profiles, activeProfileId]
  );

  const promptTokenText = PROMPT_TOKENS.join(', ');

  useEffect(() => {
    if (!showPromptModal) {
      setPromptTemplateDraft(promptTemplate || DEFAULT_PROMPT_TEMPLATE);
    }
  }, [promptTemplate, showPromptModal]);

  // Keeps the active sheet selection aligned with the saved source list.
  useEffect(() => {
    if (googleSheets.length === 0) {
      setActiveSheetId(null);
      return;
    }

    const hasActiveSheet = googleSheets.some((sheet) => sheet.id === activeSheetId);

    if (!hasActiveSheet) {
      setActiveSheetId(googleSheets[0].id);
    }
  }, [googleSheets, activeSheetId]);

  // Keeps the active profile selection aligned with the saved profile list.
  useEffect(() => {
    if (profiles.length === 0) {
      setActiveProfileId(null);
      return;
    }

    const hasActiveProfile = profiles.some((profile) => profile.id === activeProfileId);

    if (!hasActiveProfile) {
      setActiveProfileId(selectedProfileId || profiles[0].id);
    }
  }, [profiles, activeProfileId, selectedProfileId]);

  // Loads the selected profile JSON into the editor when editing existing records.
  useEffect(() => {
    if (profileEditorMode !== 'edit') {
      return;
    }

    if (!activeProfile) {
      setProfileJsonText(formatProfileJson(createEmptyProfileTemplate()));
      return;
    }

    setProfileJsonText(formatProfileJson(activeProfile));
  }, [activeProfile, profileEditorMode]);

  // Loads available tabs for the active Google Sheet source.
  useEffect(() => {
    let cancelled = false;

    async function loadTabs() {
      if (!activeSheetId) {
        setTabs([]);
        setSelectedTabName('');
        setTabsError('');
        return;
      }

      try {
        setIsLoadingTabs(true);
        setTabsError('');

        const response = await fetch(getBidAssistantApiUrl(`/api/google-sheets/${activeSheetId}/tabs`));
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Could not load tabs.');
        }

        if (cancelled) {
          return;
        }

        setTabs(data);
        setSelectedTabName((currentName) =>
          data.some((tab) => tab.name === currentName) ? currentName : data[0]?.name || ''
        );
      } catch (error) {
        if (!cancelled) {
          setTabs([]);
          setSelectedTabName('');
          setTabsError(error.message);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingTabs(false);
        }
      }
    }

    loadTabs();

    return () => {
      cancelled = true;
    };
  }, [activeSheetId]);

  // Copies an existing source into the edit form.
  function startEditingSheet(sheet) {
    setSheetForm({
      id: sheet.id,
      label: sheet.label,
      sheetId: sheet.sheet_id
    });
    setFormMessage('');
    setFormError('');
  }

  // Resets the source form to create a new record.
  function resetSheetForm() {
    setSheetForm(createEmptySheetForm());
  }

  // Updates one field in the Google Sheet source form.
  function updateSheetForm(fieldName, value) {
    setSheetForm((currentForm) => ({
      ...currentForm,
      [fieldName]: value
    }));
  }

  // Updates one field in the import range form.
  function updateImportRange(fieldName, value) {
    setImportRange((currentRange) => ({
      ...currentRange,
      [fieldName]: value
    }));
  }

  function openPromptModal() {
    setPromptTemplateDraft(promptTemplate || DEFAULT_PROMPT_TEMPLATE);
    setPromptMessage('');
    setPromptError('');
    setShowPromptModal(true);
  }

  async function handleSavePromptTemplate() {
    try {
      setIsSavingPrompt(true);
      setPromptMessage('');
      setPromptError('');

      const savedPromptTemplate = await onPromptTemplateSaved(
        promptTemplateDraft.trim() || DEFAULT_PROMPT_TEMPLATE
      );

      setPromptTemplateDraft(savedPromptTemplate);
      setPromptMessage('Prompt template saved.');
    } catch (error) {
      setPromptError(error.message);
    } finally {
      setIsSavingPrompt(false);
    }
  }

  // Opens the profile editor in create mode with a blank template.
  function startCreatingProfile() {
    setProfileEditorMode('create');
    setProfileJsonText(formatProfileJson(createEmptyProfileTemplate()));
    setProfileMessage('');
    setProfileError('');
  }

  // Opens the profile editor in edit mode for the selected profile.
  function startEditingProfile(profile) {
    setActiveProfileId(profile.id);
    setProfileEditorMode('edit');
    setProfileJsonText(formatProfileJson(profile));
    setProfileMessage('');
    setProfileError('');
  }

  // Saves the current profile JSON as either a new or existing record.
  async function handleSaveProfile() {
    try {
      setIsSavingProfile(true);
      setProfileMessage('');
      setProfileError('');

      const parsedProfile = JSON.parse(profileJsonText);
      const requestMethod = profileEditorMode === 'edit' && activeProfile?.id ? 'PUT' : 'POST';
      const requestUrl = requestMethod === 'PUT' ? `/api/profiles/${activeProfile.id}` : '/api/profiles';

      const response = await fetch(getBidAssistantApiUrl(requestUrl), {
        method: requestMethod,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(parsedProfile)
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Could not save profile.');
      }

      const nextProfiles = await onProfilesChanged();
      setActiveProfileId(data.id);
      onProfileChange(data.id);
      setProfileEditorMode('edit');
      setProfileJsonText(formatProfileJson(data));
      setProfileMessage(requestMethod === 'PUT' ? 'Profile updated.' : 'Profile created.');

      if (nextProfiles.length === 1) {
        setActiveProfileId(nextProfiles[0].id);
      }
    } catch (error) {
      setProfileError(error.message);
    } finally {
      setIsSavingProfile(false);
    }
  }

  // Deletes the active profile record.
  async function handleDeleteProfile(profileId) {
    try {
      setIsDeletingProfile(true);
      setProfileMessage('');
      setProfileError('');

      const response = await fetch(getBidAssistantApiUrl(`/api/profiles/${profileId}`), {
        method: 'DELETE'
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Could not delete profile.');
      }

      const nextProfiles = await onProfilesChanged();
      const nextSelectedProfileId = nextProfiles[0]?.id || '';
      onProfileChange(nextSelectedProfileId);
      setActiveProfileId(nextSelectedProfileId || null);
      setProfileEditorMode('create');
      setProfileJsonText(formatProfileJson(createEmptyProfileTemplate()));
      setProfileMessage('Profile deleted.');
    } catch (error) {
      setProfileError(error.message);
    } finally {
      setIsDeletingProfile(false);
    }
  }

  // Creates or updates one saved Google Sheet source.
  async function handleSaveSheet() {
    try {
      setIsSavingSheet(true);
      setFormMessage('');
      setFormError('');

      const requestMethod = sheetForm.id ? 'PUT' : 'POST';
      const requestUrl = sheetForm.id ? `/api/google-sheets/${sheetForm.id}` : '/api/google-sheets';

      const response = await fetch(getBidAssistantApiUrl(requestUrl), {
        method: requestMethod,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          label: sheetForm.label,
          sheetId: sheetForm.sheetId
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Could not save Google Sheet source.');
      }

      const nextSheets = await onGoogleSheetsChanged();
      setActiveSheetId(data.id);
      resetSheetForm();
      setFormMessage(sheetForm.id ? 'Source updated.' : 'Source created.');
      setFormError('');

      if (nextSheets.length === 1) {
        setActiveSheetId(nextSheets[0].id);
      }
    } catch (error) {
      setFormError(error.message);
    } finally {
      setIsSavingSheet(false);
    }
  }

  // Deletes one saved Google Sheet source.
  async function handleDeleteSheet(sheetId) {
    try {
      setIsDeletingSheet(true);
      setFormMessage('');
      setFormError('');

      const response = await fetch(getBidAssistantApiUrl(`/api/google-sheets/${sheetId}`), {
        method: 'DELETE'
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Could not delete Google Sheet source.');
      }

      if (sheetForm.id === sheetId) {
        resetSheetForm();
      }

      await onGoogleSheetsChanged();
      setFormMessage('Source deleted.');
      setFormError('');
    } catch (error) {
      setFormError(error.message);
    } finally {
      setIsDeletingSheet(false);
    }
  }

  // Imports jobs from the selected saved Google Sheet source.
  async function handleImport() {
    try {
      if (!activeSheetId) {
        throw new Error('Select a Google Sheet source to import.');
      }

      setIsImporting(true);
      setImportMessage('');
      setImportError('');

      const response = await fetch(getBidAssistantApiUrl(`/api/google-sheets/${activeSheetId}/import`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          tabName: selectedTabName,
          fromRow: importRange.fromRow,
          toRow: importRange.toRow
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Import failed.');
      }

      setImportMessage(
        `${data.label} / ${data.tabName}: synced ${data.totalRows} job row(s) from row ${data.fromRow} to row ${data.toRow}.`
      );
      await onJobsImported();
    } catch (error) {
      setImportError(error.message);
    } finally {
      setIsImporting(false);
    }
  }

  return (
    <>
      <header className="top-bar">
        <div className="brand-block">
          <img className="brand-mark" src="/app-icon.svg" alt="" />
          <div className="brand-copy">
            <div className="brand-title">Bid Assistant</div>
            <div className="brand-subtitle">Professional pipeline for job tracking and answer generation</div>
          </div>
        </div>

        <div className="top-bar-left">
          <label className="field-group">
            <span>Profile:</span>
            <select
              value={selectedProfileId}
              onChange={(event) => onProfileChange(event.target.value)}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {getProfileDisplayName(profile)}
                </option>
              ))}
            </select>
          </label>

          <label className="field-group">
            <span>Date:</span>
            <select value={filterDate} onChange={(event) => onDateChange(event.target.value)}>
              <option value="">All dates</option>
              {availableDates.map((date) => (
                <option key={date} value={date}>
                  {date}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="top-bar-right">
          <button className="secondary-button" onClick={openPromptModal}>
            Prompt
          </button>
          <button className="secondary-button" onClick={() => setShowProfileModal(true)}>
            Manage Profiles
          </button>
          <button className="primary-button" onClick={() => setShowImportModal(true)}>
            Import from Google Sheets
          </button>
        </div>
      </header>

      {showPromptModal && (
        <div className="modal-backdrop" onClick={() => setShowPromptModal(false)}>
          <div className="modal-card prompt-modal" onClick={(event) => event.stopPropagation()}>
            <button className="icon-button" onClick={() => setShowPromptModal(false)}>
              x
            </button>

            <div className="section-header modal-header">
              <div className="modal-header-copy">
                <h2>Prompt Template</h2>
                <p className="muted-text">
                  Edit the global Ask AI prompt here. The Ask AI modal will use this template automatically.
                </p>
              </div>
            </div>

            <textarea
              className="prompt-editor"
              value={promptTemplateDraft}
              onChange={(event) => {
                setPromptTemplateDraft(event.target.value);
                setPromptMessage('');
                setPromptError('');
              }}
              rows="16"
              spellCheck={false}
            />

            <div className="form-actions">
              <button className="primary-button" onClick={handleSavePromptTemplate} disabled={isSavingPrompt}>
                {isSavingPrompt ? 'Saving...' : 'Save Prompt'}
              </button>
            </div>

            <p className="muted-text prompt-hint">
              Available placeholders: {promptTokenText}
            </p>

            {promptMessage && <p className="success-text">{promptMessage}</p>}
            {promptError && <p className="error-text">{promptError}</p>}
          </div>
        </div>
      )}

      {showProfileModal && (
        <div className="modal-backdrop" onClick={() => setShowProfileModal(false)}>
          <div className="modal-card import-modal" onClick={(event) => event.stopPropagation()}>
            <button className="icon-button" onClick={() => setShowProfileModal(false)}>
              x
            </button>

            <h2>Profile Manager</h2>
            <p className="muted-text">
              Create, edit, and delete the full profile JSON records directly. New profiles get their `id`,
              `createdAt`, and `updatedAt` values from the backend.
            </p>

            <div className="source-manager-grid">
              <section className="source-panel">
                <div className="source-panel-header">
                  <h3>Profiles</h3>
                  <button className="secondary-button" onClick={startCreatingProfile}>
                    New Profile
                  </button>
                </div>

                <div className="source-list">
                  {profiles.map((profile) => (
                    <div
                      key={profile.id}
                      className={`source-row ${profile.id === activeProfileId ? 'active' : ''}`}
                    >
                      <button
                        className="source-row-main"
                        onClick={() => setActiveProfileId(profile.id)}
                      >
                        <strong>{getProfileDisplayName(profile)}</strong>
                        <span>{profile.title || profile.id}</span>
                        <span>{profile.disabled ? 'Disabled' : 'Active'}</span>
                      </button>
                      <div className="source-row-actions">
                        <button
                          className="text-button"
                          onClick={() => startEditingProfile(profile)}
                        >
                          Edit
                        </button>
                        <button
                          className="text-button"
                          onClick={() => onProfileChange(profile.id)}
                        >
                          Use
                        </button>
                        <button
                          className="text-button danger-text"
                          onClick={() => handleDeleteProfile(profile.id)}
                          disabled={isDeletingProfile}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}

                  {profiles.length === 0 && <p className="empty-state">No profiles found.</p>}
                </div>
              </section>

              <section className="source-panel">
                <div className="source-panel-header">
                  <h3>{profileEditorMode === 'edit' ? 'Edit Profile JSON' : 'Create Profile JSON'}</h3>
                </div>

                <textarea
                  className="json-editor"
                  value={profileJsonText}
                  onChange={(event) => setProfileJsonText(event.target.value)}
                  spellCheck={false}
                />

                <div className="form-actions">
                  <button className="primary-button" onClick={handleSaveProfile} disabled={isSavingProfile}>
                    {isSavingProfile ? 'Saving...' : profileEditorMode === 'edit' ? 'Update Profile' : 'Create Profile'}
                  </button>
                  <button className="secondary-button" onClick={startCreatingProfile}>
                    Reset
                  </button>
                </div>

                <p className="muted-text">
                  This editor saves the entire JSON object. Keep the structure consistent with your copied profile files.
                </p>

                {profileMessage && <p className="success-text">{profileMessage}</p>}
                {profileError && <p className="error-text">{profileError}</p>}
              </section>
            </div>
          </div>
        </div>
      )}

      {showImportModal && (
        <div className="modal-backdrop" onClick={() => setShowImportModal(false)}>
          <div className="modal-card import-modal" onClick={(event) => event.stopPropagation()}>
            <button className="icon-button" onClick={() => setShowImportModal(false)}>
              x
            </button>

            <h2>Google Sheet Sources</h2>
            <p className="muted-text">
              Save each sheet once, then import jobs by label. The importer reads column B as date,
              and columns D:I as company name, job title, job link, description, salary range, and comment.
            </p>

            <div className="source-manager-grid">
              <section className="source-panel">
                <div className="source-panel-header">
                  <h3>Saved Sources</h3>
                  <button className="secondary-button" onClick={resetSheetForm}>
                    New Source
                  </button>
                </div>

                <div className="source-list">
                  {googleSheets.map((sheet) => (
                    <div
                      key={sheet.id}
                      className={`source-row ${sheet.id === activeSheetId ? 'active' : ''}`}
                    >
                      <button
                        className="source-row-main"
                        onClick={() => setActiveSheetId(sheet.id)}
                      >
                        <strong>{sheet.label}</strong>
                        <span>{sheet.sheet_id}</span>
                      </button>
                      <div className="source-row-actions">
                        <button
                          className="text-button"
                          onClick={() => startEditingSheet(sheet)}
                        >
                          Edit
                        </button>
                        <button
                          className="text-button danger-text"
                          onClick={() => handleDeleteSheet(sheet.id)}
                          disabled={isDeletingSheet}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}

                  {googleSheets.length === 0 && (
                    <p className="empty-state">No saved Google Sheet sources yet.</p>
                  )}
                </div>

                <div className="import-block">
                  <div className="import-block-copy">
                    <strong>{activeSheet?.label || 'No source selected'}</strong>
                    <span>{activeSheet ? 'Select a tab, then import that job list.' : 'Select a source first.'}</span>
                  </div>
                  <button
                    className="primary-button"
                    onClick={handleImport}
                    disabled={isImporting || !activeSheetId || !selectedTabName}
                  >
                    {isImporting ? 'Importing...' : 'Import Selected Source'}
                  </button>
                </div>

                <div className="form-grid compact-grid">
                  <label className="stacked-field">
                    <span>Tab</span>
                    <select
                      value={selectedTabName}
                      onChange={(event) => setSelectedTabName(event.target.value)}
                      disabled={isLoadingTabs || tabs.length === 0}
                    >
                      {tabs.length === 0 && <option value="">No tabs available</option>}
                      {tabs.map((tab) => (
                        <option key={tab.name} value={tab.name}>
                          {tab.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="form-grid compact-grid">
                  <label className="stacked-field">
                    <span>From row</span>
                    <input
                      type="number"
                      min="1"
                      value={importRange.fromRow}
                      onChange={(event) => updateImportRange('fromRow', event.target.value)}
                      placeholder="1"
                    />
                  </label>
                  <label className="stacked-field">
                    <span>To row</span>
                    <input
                      type="number"
                      min="1"
                      value={importRange.toRow}
                      onChange={(event) => updateImportRange('toRow', event.target.value)}
                      placeholder="200"
                    />
                  </label>
                </div>

                <p className="muted-text">
                  Select the tab first. Row numbers are the actual Google Sheet row numbers. Leave the range blank to import all populated rows from columns B:I.
                </p>

                {tabsError && <p className="error-text">{tabsError}</p>}
                {importMessage && <p className="success-text">{importMessage}</p>}
                {importError && <p className="error-text">{importError}</p>}
              </section>

              <section className="source-panel">
                <div className="source-panel-header">
                  <h3>{sheetForm.id ? 'Edit Source' : 'Add Source'}</h3>
                </div>

                <div className="form-grid">
                  <label className="stacked-field">
                    <span>Label</span>
                    <input
                      value={sheetForm.label}
                      onChange={(event) => updateSheetForm('label', event.target.value)}
                      placeholder="Remote roles"
                    />
                  </label>

                  <label className="stacked-field">
                    <span>Google Sheet ID</span>
                    <input
                      value={sheetForm.sheetId}
                      onChange={(event) => updateSheetForm('sheetId', event.target.value)}
                      placeholder="1AbCdEf..."
                    />
                  </label>

                </div>

                <div className="form-actions">
                  <button className="primary-button" onClick={handleSaveSheet} disabled={isSavingSheet}>
                    {isSavingSheet ? 'Saving...' : sheetForm.id ? 'Update Source' : 'Create Source'}
                  </button>
                  <button className="secondary-button" onClick={resetSheetForm}>
                    Clear
                  </button>
                </div>

                <p className="muted-text">
                  Share the spreadsheet with your service account email. Tabs are loaded automatically after you select the source.
                </p>

                {formMessage && <p className="success-text">{formMessage}</p>}
                {formError && <p className="error-text">{formError}</p>}
              </section>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
