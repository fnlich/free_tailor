// @ts-nocheck
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs/promises');
const path = require('path');
const Papa = require('papaparse');
const { randomUUID } = require('crypto');
const { google } = require('googleapis');

const backendDirectory = path.join(__dirname, '..', '..');
const repoDirectory = path.join(backendDirectory, '..');

dotenv.config({ path: path.join(repoDirectory, '.env') });

const {
  importJobs,
  getJobs,
  getJobById,
  updateJobError,
  deleteJob,
  getCopyableJobLinks,
  saveAnswer,
  replaceAnswer,
  getAnswerById,
  getAnswersByJobId,
  deleteAnswer,
  getGoogleSheets,
  getGoogleSheetById,
  createGoogleSheet,
  updateGoogleSheet,
  deleteGoogleSheet,
  getAppSetting,
  setAppSetting
} = require('../bidAssistant/database');
const { generateAnswers } = require('../bidAssistant/aiHelper');

const router = express.Router();
const profilesDirectory = path.join(backendDirectory, 'data', 'bid-assistant', 'profiles');
const googleSheetsScopes = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const promptTemplateSettingKey = 'ask_ai_prompt_template';
const defaultPromptTemplate = `Candidate:
- Name: {{candidateName}}
- Skills: {{candidateSkills}}
- Experience: {{candidateExperience}}
- Education: {{candidateEducation}}
- Summary: {{candidateSummary}}

Job:
- Title: {{jobTitle}}
- Company: {{companyName}}
- Description: {{jobDescription}}

Question: {{question}}

Write a professional, natural-sounding answer from the candidate's perspective.
Keep it under {{charLimit}} characters.
Avoid corporate buzzwords and make it sound like a real person.`;

router.use(express.json({ limit: '2mb' }));

// Returns the full file path for a profile id.
function getProfilePath(profileId) {
  return path.join(profilesDirectory, `${profileId}.json`);
}

// Ensures a profile id is safe to use as a file name.
function validateProfileId(profileId) {
  if (!/^[a-z0-9_-]+$/i.test(profileId || '')) {
    throw new Error('Profile id may only contain letters, numbers, underscores, and hyphens.');
  }
}

// Returns a stable display name for sorting and UI labels.
function getProfileDisplayName(profile) {
  return profile?.name || profile?.fullName || profile?.id || 'Untitled Profile';
}

// Returns the persisted Ask AI prompt template or the application default.
function getPromptTemplateSetting() {
  const savedSetting = getAppSetting(promptTemplateSettingKey);
  const promptTemplate = typeof savedSetting?.value === 'string' && savedSetting.value.trim()
    ? savedSetting.value
    : defaultPromptTemplate;

  return {
    promptTemplate,
    updatedAt: savedSetting?.updated_at || null
  };
}

// Validates and normalizes the Ask AI prompt template payload.
function validatePromptTemplatePayload(payload) {
  const promptTemplate = typeof payload?.promptTemplate === 'string'
    ? payload.promptTemplate.trim()
    : '';

  if (!promptTemplate) {
    throw new Error('Prompt template is required.');
  }

  return promptTemplate;
}

// Validates and normalizes one job error update request payload.
function validateJobErrorPayload(payload) {
  const isError = Boolean(payload?.isError);
  const errorReason = typeof payload?.errorReason === 'string'
    ? payload.errorReason.trim()
    : '';

  if (isError && !errorReason) {
    throw new Error('Error reason is required when a job is marked as Error.');
  }

  return {
    isError,
    errorReason
  };
}

// Reads one profile JSON file from disk.
async function readProfile(profileId) {
  const filePath = getProfilePath(profileId);
  const fileContents = await fs.readFile(filePath, 'utf8');
  return JSON.parse(fileContents);
}

// Reads every profile JSON file from disk.
async function readAllProfiles() {
  const fileNames = await fs.readdir(profilesDirectory);
  const profileFiles = fileNames.filter((fileName) => fileName.endsWith('.json'));
  const profiles = [];

  for (const fileName of profileFiles) {
    const filePath = path.join(profilesDirectory, fileName);
    const fileContents = await fs.readFile(filePath, 'utf8');
    profiles.push(JSON.parse(fileContents));
  }

  return profiles.sort((left, right) => getProfileDisplayName(left).localeCompare(getProfileDisplayName(right)));
}

// Normalizes a full profile JSON payload for storage.
function normalizeProfilePayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Profile payload must be a JSON object.');
  }

  const profileData = JSON.parse(JSON.stringify(payload));
  const existingProfile = options.existingProfile || null;
  const nextId = existingProfile?.id || (typeof profileData.id === 'string' ? profileData.id.trim() : '') || randomUUID();

  validateProfileId(nextId);

  return {
    ...profileData,
    id: nextId,
    createdAt: existingProfile?.createdAt || profileData.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

// Writes one full profile JSON object back to disk.
async function updateProfile(profileId, nextProfile) {
  const currentProfile = await readProfile(profileId);
  const normalizedProfile = normalizeProfilePayload(nextProfile, { existingProfile: currentProfile });

  await fs.writeFile(getProfilePath(profileId), `${JSON.stringify(normalizedProfile, null, 2)}\n`);
  return normalizedProfile;
}

// Creates a new profile JSON file from the provided payload.
async function createProfile(profile) {
  const normalizedProfile = normalizeProfilePayload(profile);
  const filePath = getProfilePath(normalizedProfile.id);

  try {
    await fs.access(filePath);
    throw new Error('A profile with this id already exists.');
  } catch (error) {
    if (error.code && error.code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.writeFile(filePath, `${JSON.stringify(normalizedProfile, null, 2)}\n`);
  return normalizedProfile;
}

// Deletes one profile JSON file from disk.
async function deleteProfile(profileId) {
  validateProfileId(profileId);
  await fs.unlink(getProfilePath(profileId));
}

// Maps profile validation and file errors to cleaner API responses.
function getProfileErrorDetails(error) {
  const clientMessages = [
    'Profile payload must be a JSON object.',
    'Profile id may only contain letters, numbers, underscores, and hyphens.',
    'A profile with this id already exists.'
  ];

  if (clientMessages.includes(error.message)) {
    return {
      status: error.message === 'A profile with this id already exists.' ? 409 : 400,
      message: error.message
    };
  }

  if (error.code === 'ENOENT') {
    return {
      status: 404,
      message: 'Profile not found.'
    };
  }

  return {
    status: 500,
    message: error.message
  };
}

async function googleServiceAccountKeyFileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Loads Google service account credentials from env or the shared app key file.
async function loadGoogleServiceAccountCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }

  const keyFilePath =
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE
    || process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH
    || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const candidates = [
    keyFilePath,
    path.join(repoDirectory, 'service-account-key.json'),
    path.join(backendDirectory, 'service-account-key.json')
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolvedPath = path.isAbsolute(candidate)
      ? candidate
      : path.join(repoDirectory, candidate);

    if (await googleServiceAccountKeyFileExists(resolvedPath)) {
      const fileContents = await fs.readFile(resolvedPath, 'utf8');
      return JSON.parse(fileContents);
    }
  }

  throw new Error('Google Sheets credentials are not configured.');
}

// Creates an authenticated Google Sheets client using the configured service account.
async function createGoogleSheetsClient() {
  const credentials = await loadGoogleServiceAccountCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: credentials.client_email,
      private_key: credentials.private_key
    },
    scopes: googleSheetsScopes
  });

  return google.sheets({
    version: 'v4',
    auth
  });
}

// Escapes a sheet title for A1 notation.
function toA1SheetName(sheetTitle) {
  return `'${String(sheetTitle).replace(/'/g, "''")}'`;
}

// Converts one parsed CSV row into the job shape used by the database.
function normalizeImportedJobRow(row) {
  const normalizedRow = {};

  for (const [key, value] of Object.entries(row)) {
    normalizedRow[key.trim().toLowerCase()] = typeof value === 'string' ? value.trim() : value;
  }

  return {
    company_name: normalizedRow.company_name || '',
    job_title: normalizedRow.job_title || '',
    job_url: normalizedRow.job_url || '',
    description: normalizedRow.description || '',
    salary_range: normalizedRow.salary_range || '',
    comment: normalizedRow.comment || '',
    row_number: Number.isInteger(Number(normalizedRow.row_number)) ? Number(normalizedRow.row_number) : undefined,
    posted_date: normalizedRow.posted_date || ''
  };
}

// Converts one Google Sheets row from columns B:I into the job shape used by the database.
function normalizeImportedGoogleSheetColumnsRow(row, rowNumber, googleSheetId, tabName) {
  const values = Array.isArray(row) ? row : [];

  return {
    google_sheet_id: googleSheetId,
    google_sheet_tab_name: tabName,
    row_number: rowNumber,
    posted_date: typeof values[0] === 'string' ? values[0].trim() : '',
    company_name: typeof values[2] === 'string' ? values[2].trim() : '',
    job_title: typeof values[3] === 'string' ? values[3].trim() : '',
    job_url: typeof values[4] === 'string' ? values[4].trim() : '',
    description: typeof values[5] === 'string' ? values[5].trim() : '',
    salary_range: typeof values[6] === 'string' ? values[6].trim() : '',
    comment: typeof values[7] === 'string' ? values[7].trim() : ''
  };
}

// Builds the Google Sheets range for importing job rows from columns B:I.
function buildGoogleSheetJobRange(tabName, fromRow, toRow) {
  const quotedTabName = toA1SheetName(tabName);

  if (fromRow && toRow) {
    return `${quotedTabName}!B${fromRow}:I${toRow}`;
  }

  if (fromRow) {
    return `${quotedTabName}!B${fromRow}:I`;
  }

  if (toRow) {
    return `${quotedTabName}!B1:I${toRow}`;
  }

  return `${quotedTabName}!B:I`;
}

function getRangeStartRow(fromRow) {
  return fromRow || 1;
}

// Ensures a Google Sheet source payload contains the required fields.
function validateGoogleSheetPayload(payload) {
  const label = typeof payload?.label === 'string' ? payload.label.trim() : '';
  const sheetId = typeof payload?.sheetId === 'string' ? payload.sheetId.trim() : '';

  if (!label) {
    throw new Error('Label is required.');
  }

  if (!sheetId) {
    throw new Error('Sheet ID is required.');
  }

  return {
    label,
    sheet_id: sheetId
  };
}

// Maps known Google Sheet source errors to cleaner API responses.
function getGoogleSheetErrorDetails(error) {
  if (error.message === 'Label is required.' || error.message === 'Sheet ID is required.') {
    return {
      status: 400,
      message: error.message
    };
  }

  if (error.message.includes('UNIQUE constraint failed: google_sheets.label')) {
    return {
      status: 409,
      message: 'A Google Sheet source with this label already exists.'
    };
  }

  return {
    status: 500,
    message: error.message
  };
}

// Maps Google Sheet import errors to cleaner API responses.
function getGoogleSheetImportErrorDetails(error) {
  const importValidationMessages = [
    'Select a tab before importing.',
    'From row must be a whole number greater than or equal to 1.',
    'To row must be a whole number greater than or equal to 1.',
    'From row must be less than or equal to To row.',
    'The selected row range did not match any job rows.',
    'Google Sheets credentials are not configured.',
    'The selected row range exceeds the size of this tab.'
  ];

  if (importValidationMessages.includes(error.message)) {
    return {
      status: 400,
      message: error.message
    };
  }

  if (typeof error.message === 'string' && error.message.includes('exceeds grid limits')) {
    return {
      status: 400,
      message: 'The selected row range exceeds the size of this tab.'
    };
  }

  if (error?.code === 403 || error?.response?.status === 403) {
    return {
      status: 403,
      message: 'Google Sheets access was denied. Share the spreadsheet with the service account email and confirm the Sheets API is enabled.'
    };
  }

  if (error?.code === 404 || error?.response?.status === 404) {
    return {
      status: 404,
      message: 'Google Sheets could not find this spreadsheet or tab for the configured service account.'
    };
  }

  return {
    status: 500,
    message: error.message
  };
}

// Lists tabs from a Google Sheet source using the authenticated Sheets API.
async function listGoogleSheetTabs(sheetId) {
  const sheetsClient = await createGoogleSheetsClient();
  const response = await sheetsClient.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: 'sheets(properties(sheetId,title,index,hidden))'
  });

  const tabs = (response.data.sheets || [])
    .map((sheet) => ({
      id: sheet.properties?.sheetId,
      name: sheet.properties?.title || '',
      hidden: Boolean(sheet.properties?.hidden)
    }))
    .filter((tab) => tab.name);

  if (tabs.length === 0) {
    throw new Error('No tabs were found in the selected Google Sheet.');
  }

  return tabs;
}

// Downloads and parses jobs from a saved Google Sheet source.
async function loadJobsFromGoogleSheet(sheet, tabName, fromRow, toRow) {
  const sheetsClient = await createGoogleSheetsClient();
  const response = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: sheet.sheet_id,
    range: buildGoogleSheetJobRange(tabName, fromRow, toRow)
  });
  const rows = Array.isArray(response.data.values) ? response.data.values : [];

  if (rows.length === 0) {
    throw new Error('No job rows were found in the selected Google Sheet.');
  }

  const rangeStartRow = getRangeStartRow(fromRow);
  const importedJobs = rows
    .map((row, index) => normalizeImportedGoogleSheetColumnsRow(
      row,
      rangeStartRow + index,
      sheet.sheet_id,
      tabName
    ))
    .filter((job) => (
      job.company_name
      || job.job_title
      || job.job_url
      || job.description
      || job.salary_range
      || job.comment
      || job.posted_date
    ));

  if (importedJobs.length > 0) {
    return importedJobs;
  }

  if (fromRow || toRow) {
    throw new Error('The selected row range did not match any job rows.');
  }

  const fallbackResponse = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: sheet.sheet_id,
    range: `${toA1SheetName(tabName)}!A:ZZ`
  });
  const fallbackRows = Array.isArray(fallbackResponse.data.values) ? fallbackResponse.data.values : [];

  if (fallbackRows.length === 0) {
    throw new Error('No job rows were found in the selected Google Sheet.');
  }

  const [headerRow, ...valueRows] = fallbackRows;

  if (!headerRow || headerRow.length === 0) {
    throw new Error('The selected tab does not contain a header row.');
  }

  const csvText = Papa.unparse({
    fields: headerRow,
    data: valueRows
  });
  const parsed = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true
  });

  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors[0].message);
  }

  const fallbackJobs = parsed.data
    .map((row, index) => {
      const normalizedRow = normalizeImportedJobRow(row);
      return {
        ...normalizedRow,
        row_number: index + 2,
        google_sheet_id: sheet.sheet_id,
        google_sheet_tab_name: tabName
      };
    })
    .filter((job) => (
      job.company_name
      || job.job_title
      || job.job_url
      || job.description
      || job.salary_range
      || job.comment
      || job.posted_date
    ));

  if (fallbackJobs.length === 0) {
    throw new Error('No job rows were found in the selected Google Sheet.');
  }

  return fallbackJobs;
}

// Validates the requested tab selection for import.
function validateImportTabName(payload) {
  const tabName = typeof payload?.tabName === 'string' ? payload.tabName.trim() : '';

  if (!tabName) {
    throw new Error('Select a tab before importing.');
  }

  return tabName;
}

// Validates the requested import row range.
function validateImportRange(payload) {
  const rawFromRow = payload?.fromRow;
  const rawToRow = payload?.toRow;
  const hasFromRow = rawFromRow !== undefined && rawFromRow !== null && rawFromRow !== '';
  const hasToRow = rawToRow !== undefined && rawToRow !== null && rawToRow !== '';
  const fromRow = hasFromRow ? Number(rawFromRow) : undefined;
  const toRow = hasToRow ? Number(rawToRow) : undefined;

  if (hasFromRow && (!Number.isInteger(fromRow) || fromRow < 1)) {
    throw new Error('From row must be a whole number greater than or equal to 1.');
  }

  if (hasToRow && (!Number.isInteger(toRow) || toRow < 1)) {
    throw new Error('To row must be a whole number greater than or equal to 1.');
  }

  if (fromRow && toRow && fromRow > toRow) {
    throw new Error('From row must be less than or equal to To row.');
  }

  return {
    fromRow,
    toRow
  };
}

// Imports a batch of jobs into SQLite.
router.post('/import-jobs', async (req, res) => {
  try {
    const jobs = Array.isArray(req.body) ? req.body : [];
    const addedCount = importJobs(jobs);
    res.json({ addedCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Returns all saved Google Sheet sources.
router.get('/google-sheets', async (req, res) => {
  try {
    res.json(getGoogleSheets());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Returns the available tabs for one saved Google Sheet source.
router.get('/google-sheets/:id/tabs', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const sheet = getGoogleSheetById(id);

    if (!sheet) {
      return res.status(404).json({ error: 'Google Sheet source not found.' });
    }

    const tabs = await listGoogleSheetTabs(sheet.sheet_id);
    res.json(tabs);
  } catch (error) {
    const errorDetails = getGoogleSheetImportErrorDetails(error);
    res.status(errorDetails.status).json({ error: errorDetails.message });
  }
});

// Creates one saved Google Sheet source.
router.post('/google-sheets', async (req, res) => {
  try {
    const sheet = createGoogleSheet(validateGoogleSheetPayload(req.body || {}));
    res.json(sheet);
  } catch (error) {
    const errorDetails = getGoogleSheetErrorDetails(error);
    res.status(errorDetails.status).json({ error: errorDetails.message });
  }
});

// Updates one saved Google Sheet source.
router.put('/google-sheets/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existingSheet = getGoogleSheetById(id);

    if (!existingSheet) {
      return res.status(404).json({ error: 'Google Sheet source not found.' });
    }

    const sheet = updateGoogleSheet(id, validateGoogleSheetPayload(req.body || {}));
    res.json(sheet);
  } catch (error) {
    const errorDetails = getGoogleSheetErrorDetails(error);
    res.status(errorDetails.status).json({ error: errorDetails.message });
  }
});

// Deletes one saved Google Sheet source.
router.delete('/google-sheets/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existingSheet = getGoogleSheetById(id);

    if (!existingSheet) {
      return res.status(404).json({ error: 'Google Sheet source not found.' });
    }

    deleteGoogleSheet(id);
    res.json({ message: 'Google Sheet source deleted successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Imports jobs from a saved Google Sheet source.
router.post('/google-sheets/:id/import', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const sheet = getGoogleSheetById(id);

    if (!sheet) {
      return res.status(404).json({ error: 'Google Sheet source not found.' });
    }

    const tabName = validateImportTabName(req.body || {});
    const { fromRow, toRow } = validateImportRange(req.body || {});
    const jobs = await loadJobsFromGoogleSheet(sheet, tabName, fromRow, toRow);
    const addedCount = importJobs(jobs);

    res.json({
      label: sheet.label,
      tabName,
      totalRows: jobs.length,
      addedCount,
      fromRow: fromRow || 1,
      toRow: fromRow && !toRow ? fromRow + jobs.length - 1 : toRow || jobs.length
    });
  } catch (error) {
    const errorDetails = getGoogleSheetImportErrorDetails(error);
    res.status(errorDetails.status).json({ error: errorDetails.message });
  }
});

// Returns jobs with optional search and date filtering.
router.get('/jobs', async (req, res) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    const date = typeof req.query.date === 'string' ? req.query.date : '';
    const jobs = getJobs(search, date);
    res.json(jobs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Returns non-error job links for one row range.
router.get('/jobs/copy-links', async (req, res) => {
  try {
    const fromRow = Number(req.query.fromRow);
    const toRow = Number(req.query.toRow);
    const date = typeof req.query.date === 'string' ? req.query.date : '';

    if (!Number.isInteger(fromRow) || !Number.isInteger(toRow) || fromRow > toRow) {
      return res.status(400).json({ error: 'Enter a valid row range where From is less than or equal to To.' });
    }

    const result = getCopyableJobLinks(fromRow, toRow, date);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Deletes one job and all saved answers attached to it.
router.delete('/jobs/:jobId', async (req, res) => {
  try {
    const jobId = Number(req.params.jobId);

    if (!Number.isInteger(jobId)) {
      return res.status(400).json({ error: 'Job id must be a number.' });
    }

    const wasDeleted = deleteJob(jobId);

    if (!wasDeleted) {
      return res.status(404).json({ error: 'Job not found.' });
    }

    res.json({ message: 'Job deleted successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Updates the Error marker and reason for one job.
router.put('/jobs/:jobId/error', async (req, res) => {
  try {
    const jobId = Number(req.params.jobId);
    const existingJob = getJobById(jobId);

    if (!existingJob) {
      return res.status(404).json({ error: 'Job not found.' });
    }

    const { isError, errorReason } = validateJobErrorPayload(req.body || {});
    const updatedJob = updateJobError(jobId, isError, errorReason);

    res.json(updatedJob);
  } catch (error) {
    const status = error.message === 'Error reason is required when a job is marked as Error.' ? 400 : 500;
    res.status(status).json({ error: error.message });
  }
});

// Returns the persisted Ask AI prompt template.
router.get('/settings/prompt-template', async (req, res) => {
  try {
    res.json(getPromptTemplateSetting());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Saves the Ask AI prompt template as a persistent app setting.
router.put('/settings/prompt-template', async (req, res) => {
  try {
    const promptTemplate = validatePromptTemplatePayload(req.body || {});
    const savedSetting = setAppSetting(promptTemplateSettingKey, promptTemplate);

    res.json({
      promptTemplate: savedSetting.value,
      updatedAt: savedSetting.updated_at
    });
  } catch (error) {
    const status = error.message === 'Prompt template is required.' ? 400 : 500;
    res.status(status).json({ error: error.message });
  }
});

// Returns all profile JSON records from disk.
router.get('/profiles', async (req, res) => {
  try {
    const profiles = await readAllProfiles();
    res.json(profiles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Creates one new profile JSON record on disk.
router.post('/profiles', async (req, res) => {
  try {
    const profile = await createProfile(req.body || {});
    res.json(profile);
  } catch (error) {
    const errorDetails = getProfileErrorDetails(error);
    res.status(errorDetails.status).json({ error: errorDetails.message });
  }
});

// Returns one profile JSON record from disk.
router.get('/profiles/:profileId', async (req, res) => {
  try {
    const profile = await readProfile(req.params.profileId);
    res.json(profile);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Updates selected editable fields in one profile JSON record.
router.put('/profiles/:profileId', async (req, res) => {
  try {
    const profile = await updateProfile(req.params.profileId, req.body || {});
    res.json({ message: 'Profile saved successfully.', profile });
  } catch (error) {
    const errorDetails = getProfileErrorDetails(error);
    res.status(errorDetails.status).json({ error: errorDetails.message });
  }
});

// Deletes one profile JSON record from disk.
router.delete('/profiles/:profileId', async (req, res) => {
  try {
    await deleteProfile(req.params.profileId);
    res.json({ message: 'Profile deleted successfully.' });
  } catch (error) {
    const errorDetails = getProfileErrorDetails(error);
    res.status(errorDetails.status).json({ error: errorDetails.message });
  }
});

// Returns saved answers for one job grouped by profile id.
router.get('/answers/:jobId', async (req, res) => {
  try {
    const jobId = Number(req.params.jobId);
    const answers = getAnswersByJobId(jobId);
    res.json(answers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Deletes one saved answer for one job/profile/question combination.
router.delete('/answers/:jobId', async (req, res) => {
  try {
    const jobId = Number(req.params.jobId);
    const profileId = typeof req.query?.profileId === 'string'
      ? req.query.profileId.trim()
      : (typeof req.body?.profileId === 'string' ? req.body.profileId.trim() : '');
    const question = typeof req.query?.question === 'string'
      ? req.query.question.trim()
      : (typeof req.body?.question === 'string' ? req.body.question.trim() : '');

    if (!profileId || !question) {
      return res.status(400).json({ error: 'Profile id and question are required.' });
    }

    deleteAnswer(jobId, profileId, question);
    res.json({ message: 'Answer deleted successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Generates and stores answers for the selected profiles and questions.
router.post('/ask', async (req, res) => {
  try {
    const {
      jobId,
      jobTitle,
      companyName,
      jobDescription,
      focusProfileId,
      targetProfileIds,
      questions,
      promptTemplate
    } = req.body || {};
    const activePromptTemplate = typeof promptTemplate === 'string' && promptTemplate.trim()
      ? promptTemplate
      : getPromptTemplateSetting().promptTemplate;

    const targetProfiles = [];
    const normalizedQuestions = (questions || []).map((item, questionIndex) => {
      const charLimit = Number(item.charLimit) || 500;
      const isManualAnswer = Boolean(item?.isManualAnswer);
      const manualAnswer = typeof item?.manualAnswer === 'string' ? item.manualAnswer.trim() : '';
      const replaceAnswerId = Number.isInteger(Number(item?.replaceAnswerId))
        ? Number(item.replaceAnswerId)
        : null;
      const replaceAnswerSource = replaceAnswerId ? getAnswerById(replaceAnswerId) : null;

      return {
        ...item,
        questionIndex,
        charLimit,
        isManualAnswer,
        manualAnswer,
        replaceAnswerId,
        replaceAnswerSource
      };
    });

    for (const profileId of targetProfileIds || []) {
      const profile = await readProfile(profileId);
      targetProfiles.push(profile);
    }

    if (normalizedQuestions.some((item) => item.isManualAnswer && !item.manualAnswer)) {
      return res.status(400).json({ error: 'Manual answer text is required for questions marked MA.' });
    }

    if (normalizedQuestions.some((item) =>
      item.replaceAnswerId && (!item.replaceAnswerSource || item.replaceAnswerSource.job_id !== jobId)
    )) {
      return res.status(404).json({ error: 'Saved answer not found for resubmission.' });
    }

    const aiQuestions = normalizedQuestions.filter((item) => !item.isManualAnswer);
    const aiAnswersByProfile = aiQuestions.length > 0
      ? await generateAnswers(
          targetProfiles,
          jobTitle,
          companyName,
          jobDescription,
          aiQuestions,
          activePromptTemplate
        )
      : {};
    const generatedAnswersByProfile = {};

    for (const profile of targetProfiles) {
      const profileId = profile.id;
      generatedAnswersByProfile[profileId] = [];

      for (const item of normalizedQuestions) {
        const answer = item.isManualAnswer
          ? item.manualAnswer
          : aiAnswersByProfile[profileId]?.[item.questionIndex];

        if (typeof answer !== 'string') {
          throw new Error(`Missing generated answer for profile ${profileId} and question ${item.questionIndex + 1}.`);
        }

        const shouldReplaceAnswer = item.replaceAnswerId
          && item.replaceAnswerSource?.profile_id === profileId;

        if (shouldReplaceAnswer) {
          const wasReplaced = replaceAnswer(
            item.replaceAnswerId,
            jobId,
            profileId,
            item.question,
            answer,
            item.charLimit,
            item.questionIndex
          );

          if (!wasReplaced) {
            return res.status(404).json({ error: 'Saved answer not found for resubmission.' });
          }
        } else {
          saveAnswer(
            jobId,
            profileId,
            item.question,
            answer,
            item.charLimit,
            item.questionIndex
          );
        }

        generatedAnswersByProfile[profileId].push({
          question: item.question,
          answer,
          charLimit: item.charLimit
        });
      }
    }

    res.json(generatedAnswersByProfile[focusProfileId] || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
