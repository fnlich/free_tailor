// @ts-nocheck
const express = require('express');
const fs = require('fs/promises');
const Papa = require('papaparse');
const { randomUUID } = require('crypto');
const { google } = require('googleapis');
const profileRepository = require('../database/profileRepository');
const { isAdmin, requireAdmin, requireUser } = require('../middleware/auth');
const { isPublicError, PublicError, sendPublicError } = require('../middleware/publicError');
const {
  assertSheetNotOwnedByAnotherAccount,
  SheetAccessError,
} = require('../services/sheets/accountSheet');
const { getAccessToken, SHEETS_SCOPE } = require('../integrations/googleSheets');
const profileService = require('../services/profileService');

/*
 * No .env loading, CORS or body parser of its own here, and each used to be.
 *
 * `config/env.ts` loads the repository .env before anything else in the
 * process, and decodes the UTF-16 file PowerShell writes, which a second
 * `dotenv.config` here could not. The app applies CORS before any router. And
 * the app-wide `express.json` (JSON_BODY_MAX_MB) has already consumed the body
 * by the time a request reaches this router, so a router-level 2mb parser here
 * never ran - its limit was a number that looked like a rule and enforced
 * nothing.
 */

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
  getGoogleSheetsForAccount,
  getGoogleSheetById,
  createGoogleSheet,
  updateGoogleSheet,
  deleteGoogleSheet,
  getAppSetting,
  setAppSetting
} = require('../bidAssistant/database');
import { generateAnswers } from '../bidAssistant/aiHelper';

const router = express.Router();
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

/**
 * Everything below needs a signed-in account.
 *
 * At the router rather than per route, so a route added later is protected by
 * default. Before v2 these were open, which was defensible with one user on one
 * machine and is not once profiles belong to people.
 */
router.use(requireUser);

// Ensures a profile id is safe to use as a record key.
function validateProfileId(profileId) {
  if (!/^[a-z0-9_-]+$/i.test(profileId || '')) {
    throw new PublicError('Profile id may only contain letters, numbers, underscores, and hyphens.');
  }
}

// Returns a stable display name for sorting and UI labels.
function getProfileDisplayName(profile) {
  return profile?.name || profile?.id || 'Untitled Profile';
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
    throw new PublicError('Prompt template is required.');
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
    throw new PublicError('Error reason is required when a job is marked as Error.');
  }

  return {
    isError,
    errorReason
  };
}

class ProfileNotFoundError extends PublicError {
  constructor() {
    super('Profile not found.', { status: 404 });
    this.name = 'ProfileNotFoundError';
  }
}

// Reads one profile record, scoped to whoever is asking.
function readProfile(profileId, viewer) {
  const profile = profileRepository.getProfileFor(viewer ?? null, profileId);
  if (!profile) {
    throw new ProfileNotFoundError();
  }
  return profile;
}

// Reads the requester's profile records.
function readAllProfiles(viewer) {
  return profileRepository
    .listProfilesFor(viewer ?? null, { includeDisabled: true })
    .sort((left, right) => getProfileDisplayName(left).localeCompare(getProfileDisplayName(right)));
}

function assertProfilePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PublicError('Profile payload must be a JSON object.');
  }
}

// Applies a full profile JSON payload on top of an existing record.
function updateProfile(profileId, nextProfile, viewer) {
  assertProfilePayload(nextProfile);
  const currentProfile = readProfile(profileId, viewer);
  return profileRepository.saveProfile({
    ...profileService.buildUpdatedProfile(currentProfile, nextProfile),
    // Kept, so an edit through this page does not orphan the profile.
    ownerId: currentProfile.ownerId,
  });
}

// Creates a new profile record from the provided payload.
function createProfile(profile, viewer) {
  assertProfilePayload(profile);
  const requestedId = typeof profile.id === 'string' ? profile.id.trim() : '';
  const nextId = requestedId || randomUUID();
  validateProfileId(nextId);

  if (profileRepository.hasProfile(nextId)) {
    throw new PublicError('A profile with this id already exists.', { status: 409 });
  }

  // The plan's cap applies here as much as on the profiles page: this is a
  // second door into the same table, and a limit only one door honours is not
  // a limit.
  profileRepository.assertCanAddProfile(viewer);

  return profileRepository.saveProfile({
    ...profileService.buildNewProfile(profile, nextId),
    ownerId: viewer.id,
  });
}

// Deletes one profile record.
function deleteProfile(profileId, viewer) {
  validateProfileId(profileId);
  // Resolved through the viewer first, so this cannot delete somebody else's.
  if (!profileRepository.getProfileFor(viewer ?? null, profileId)) {
    throw new ProfileNotFoundError();
  }
  if (!profileRepository.deleteProfile(profileId)) {
    throw new ProfileNotFoundError();
  }
}

/**
 * The same credentials the rest of the app uses, not a second set.
 *
 * This had its own loader, its own env variables and its own search paths, and
 * it only understood a service account key - it read `client_email` and
 * `private_key` straight out of the file. So the moment the app started signing
 * in as a person instead, this router alone said "Google Sheets credentials are
 * not configured" while everything else worked.
 *
 * Taking an access token from the shared layer fixes that and removes the
 * second set of variables: whatever `GOOGLE_CREDENTIALS_PATH` resolves to is
 * what this uses too, whichever of the two shapes it turns out to be.
 */
async function createGoogleSheetsClient() {
  const accessToken = await getAccessToken(SHEETS_SCOPE);
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });

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
    throw new PublicError('Label is required.');
  }

  if (!sheetId) {
    throw new PublicError('Sheet ID is required.');
  }

  return {
    label,
    sheet_id: sheetId
  };
}

/*
 * Every refusal this router writes for the person in front of it - a missing
 * label, a row range, a tab that is not there - is a PublicError, thrown where
 * it is decided; everything else reaches them through `sendPublicError` as the
 * generic sentence with a ref. Two outside failures are translated first,
 * because what the library says is not for them: a duplicate label (a SQLite
 * constraint) and Google refusing a sheet (googleapis' own error text).
 */

// A second source with a label already in use.
function publicSourceError(error) {
  if (!isPublicError(error) && typeof error?.message === 'string'
    && error.message.includes('UNIQUE constraint failed: google_sheets.label')) {
    return new PublicError('A Google Sheet source with this label already exists.', { status: 409 });
  }
  return error;
}

// Google refusing to open the sheet, or a row range past the end of a tab.
function publicSheetReadError(error) {
  if (isPublicError(error)) return error;
  if (typeof error?.message === 'string' && error.message.includes('exceeds grid limits')) {
    return new PublicError('The selected row range exceeds the size of this tab.');
  }
  const status = error?.code ?? error?.response?.status;
  if (status === 403 || status === 404) {
    // Which of the two - a link that is wrong, or a sheet never shared with
    // this server - only the administrator can tell, and Google's text says
    // why in terms of the server's own credential.
    return new PublicError('This sheet could not be opened. Check the sheet link, or contact your administrator.', {
      status: 400,
      detail: error.message,
      cause: error,
    });
  }
  return error;
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
    throw new PublicError('No tabs were found in the selected Google Sheet.');
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
    throw new PublicError('No job rows were found in the selected Google Sheet.');
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
    throw new PublicError('The selected row range did not match any job rows.');
  }

  const fallbackResponse = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: sheet.sheet_id,
    range: `${toA1SheetName(tabName)}!A:ZZ`
  });
  const fallbackRows = Array.isArray(fallbackResponse.data.values) ? fallbackResponse.data.values : [];

  if (fallbackRows.length === 0) {
    throw new PublicError('No job rows were found in the selected Google Sheet.');
  }

  const [headerRow, ...valueRows] = fallbackRows;

  if (!headerRow || headerRow.length === 0) {
    throw new PublicError('The selected tab does not contain a header row.');
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
    throw new PublicError('No job rows were found in the selected Google Sheet.');
  }

  return fallbackJobs;
}

// Validates the requested tab selection for import.
function validateImportTabName(payload) {
  const tabName = typeof payload?.tabName === 'string' ? payload.tabName.trim() : '';

  if (!tabName) {
    throw new PublicError('Select a tab before importing.');
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
    throw new PublicError('From row must be a whole number greater than or equal to 1.');
  }

  if (hasToRow && (!Number.isInteger(toRow) || toRow < 1)) {
    throw new PublicError('To row must be a whole number greater than or equal to 1.');
  }

  if (fromRow && toRow && fromRow > toRow) {
    throw new PublicError('From row must be less than or equal to To row.');
  }

  return {
    fromRow,
    toRow
  };
}

/*
 * Saved sources belong to the account that saved them.
 *
 * They had no owner - this was a single-user tool - so any signed-in account
 * could rename or delete anybody's. Now an account sees its own and the
 * owner-less ones saved before sources had owners; it may change its own, and
 * only an administrator may change an owner-less one (or, by id, anybody's -
 * the list shows an administrator the same two kinds). A source somebody else
 * owns is "not found", not "forbidden", as a profile is: a 403 would confirm
 * that a source with that id exists. The owner's id never leaves the server.
 */
class SourceNotFoundError extends PublicError {
  constructor() {
    super('Google Sheet source not found.', { status: 404 });
    this.name = 'SourceNotFoundError';
  }
}

class SourceNotEditableError extends PublicError {
  constructor() {
    super('This Google Sheet source was saved before sources had owners, so only an administrator can change it.', {
      status: 403,
    });
    this.name = 'SourceNotEditableError';
  }
}

function canSeeSource(req, sheet) {
  return !sheet.account_id || sheet.account_id === String(req.user?.id) || isAdmin(req);
}

function canEditSource(req, sheet) {
  return isAdmin(req) || (Boolean(sheet.account_id) && sheet.account_id === String(req.user?.id));
}

// A source as its reader receives it: what they may do with it, never whose it is.
function sourceForReader(req, sheet) {
  const { account_id: _owner, ...rest } = sheet;
  return { ...rest, canEdit: canEditSource(req, sheet) };
}

// One source by id, if the reader may see it (and, with `edit`, change it).
function readSource(req, id, { edit = false } = {}) {
  const sheet = Number.isInteger(id) ? getGoogleSheetById(id) : null;
  if (!sheet || !canSeeSource(req, sheet)) throw new SourceNotFoundError();
  if (edit && !canEditSource(req, sheet)) throw new SourceNotEditableError();
  return sheet;
}

// Imports a batch of jobs into SQLite.
router.post('/import-jobs', async (req, res) => {
  try {
    const jobs = Array.isArray(req.body) ? req.body : [];
    const addedCount = importJobs(jobs);
    res.json({ addedCount });
  } catch (error) {
    sendPublicError(req, res, error, 'Could not import those jobs');
  }
});

// Returns the reader's saved Google Sheet sources, and the owner-less ones.
router.get('/google-sheets', async (req, res) => {
  try {
    res.json(getGoogleSheetsForAccount(req.user.id).map((sheet) => sourceForReader(req, sheet)));
  } catch (error) {
    sendPublicError(req, res, error, 'Could not load the Google Sheet sources');
  }
});

// Returns the available tabs for one saved Google Sheet source.
router.get('/google-sheets/:id/tabs', async (req, res) => {
  try {
    const sheet = readSource(req, Number(req.params.id));

    // Checked on the way out as well as on the way in: a row saved before this
    // guard existed, or before its spreadsheet was allocated to somebody, would
    // otherwise still be readable.
    assertSheetNotOwnedByAnotherAccount(req.user, sheet.sheet_id);
    const tabs = await listGoogleSheetTabs(sheet.sheet_id);
    res.json(tabs);
  } catch (error) {
    sendPublicError(req, res, publicSheetReadError(error), 'Could not read that Google Sheet');
  }
});

// Creates one saved Google Sheet source.
router.post('/google-sheets', async (req, res) => {
  try {
    const payload = validateGoogleSheetPayload(req.body || {});
    // These sources may point at any spreadsheet shared with this installation,
    // which is the whole point of them - but NOT at another account's personal
    // job sheet. The service account owns those, so without this check saving a
    // source would be a way to read somebody else's sheet through a feature
    // that never had an owner concept.
    assertSheetNotOwnedByAnotherAccount(req.user, payload.sheet_id);
    const sheet = createGoogleSheet(payload, req.user.id);
    res.json(sourceForReader(req, sheet));
  } catch (error) {
    sendPublicError(req, res, publicSourceError(error), 'Could not save that Google Sheet source');
  }
});

// Updates one saved Google Sheet source.
router.put('/google-sheets/:id', async (req, res) => {
  try {
    const existingSheet = readSource(req, Number(req.params.id), { edit: true });

    const payload = validateGoogleSheetPayload(req.body || {});
    assertSheetNotOwnedByAnotherAccount(req.user, payload.sheet_id);
    const sheet = updateGoogleSheet(existingSheet.id, payload);
    res.json(sourceForReader(req, sheet));
  } catch (error) {
    sendPublicError(req, res, publicSourceError(error), 'Could not save that Google Sheet source');
  }
});

// Deletes one saved Google Sheet source.
router.delete('/google-sheets/:id', async (req, res) => {
  try {
    const existingSheet = readSource(req, Number(req.params.id), { edit: true });

    deleteGoogleSheet(existingSheet.id);
    res.json({ message: 'Google Sheet source deleted successfully.' });
  } catch (error) {
    sendPublicError(req, res, error, 'Could not delete that Google Sheet source');
  }
});

// Imports jobs from a saved Google Sheet source.
router.post('/google-sheets/:id/import', async (req, res) => {
  try {
    const sheet = readSource(req, Number(req.params.id));

    assertSheetNotOwnedByAnotherAccount(req.user, sheet.sheet_id);
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
    sendPublicError(req, res, publicSheetReadError(error), 'Could not read that Google Sheet');
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
    sendPublicError(req, res, error, 'Could not load the jobs');
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
    sendPublicError(req, res, error, 'Could not copy the job links');
  }
});

// Deletes one job and all saved answers attached to it. The board is shared,
// and a job takes every account's saved answers for it with it, so this is the
// administrator's call; marking a job as an error stays open to everybody.
router.delete('/jobs/:jobId', requireAdmin, async (req, res) => {
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
    sendPublicError(req, res, error, 'Could not delete that job');
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
    sendPublicError(req, res, error, 'Could not update that job');
  }
});

// Returns the persisted Ask AI prompt template, and whether the reader may
// change it. It is ONE template, the default for every account's Ask AI - the
// page calls it "the global Ask AI prompt" - so it is changed the way every
// other prompt in the app is: by an administrator. Anybody may still send a
// template of their own with a single /ask.
router.get('/settings/prompt-template', async (req, res) => {
  try {
    res.json({ ...getPromptTemplateSetting(), canEdit: isAdmin(req) });
  } catch (error) {
    sendPublicError(req, res, error, 'Could not load the prompt template');
  }
});

// Saves the Ask AI prompt template as a persistent app setting.
router.put('/settings/prompt-template', requireAdmin, async (req, res) => {
  try {
    const promptTemplate = validatePromptTemplatePayload(req.body || {});
    const savedSetting = setAppSetting(promptTemplateSettingKey, promptTemplate);

    res.json({
      promptTemplate: savedSetting.value,
      updatedAt: savedSetting.updated_at
    });
  } catch (error) {
    sendPublicError(req, res, error, 'Could not save the prompt template');
  }
});

// Returns all profile records.
router.get('/profiles', (req, res) => {
  try {
    res.json(readAllProfiles(req.user));
  } catch (error) {
    sendPublicError(req, res, error, 'Could not load the profiles');
  }
});

// Creates one new profile record.
router.post('/profiles', (req, res) => {
  try {
    const profile = createProfile(req.body || {}, req.user);
    res.json(profile);
  } catch (error) {
    sendPublicError(req, res, error, 'Could not save that profile');
  }
});

// Returns one profile record.
router.get('/profiles/:profileId', (req, res) => {
  try {
    res.json(readProfile(req.params.profileId, req.user));
  } catch (error) {
    sendPublicError(req, res, error, 'Could not save that profile');
  }
});

// Replaces one profile record with the submitted JSON.
router.put('/profiles/:profileId', (req, res) => {
  try {
    const profile = updateProfile(req.params.profileId, req.body || {}, req.user);
    res.json({ message: 'Profile saved successfully.', profile });
  } catch (error) {
    sendPublicError(req, res, error, 'Could not save that profile');
  }
});

// Deletes one profile record.
router.delete('/profiles/:profileId', (req, res) => {
  try {
    deleteProfile(req.params.profileId, req.user);
    res.json({ message: 'Profile deleted successfully.' });
  } catch (error) {
    sendPublicError(req, res, error, 'Could not save that profile');
  }
});

// Returns saved answers for one job grouped by profile id - the READER's
// profiles only. The job board is shared, but the answers are written for a
// profile, and profiles belong to accounts: unfiltered, this handed every
// account everybody's answers, keyed by profile id.
router.get('/answers/:jobId', async (req, res) => {
  try {
    const jobId = Number(req.params.jobId);
    const answers = getAnswersByJobId(jobId);
    const own = new Set(readAllProfiles(req.user).map((profile) => profile.id));
    res.json(Object.fromEntries(Object.entries(answers).filter(([profileId]) => own.has(profileId))));
  } catch (error) {
    sendPublicError(req, res, error, 'Could not load the saved answers');
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

    // Resolved through the reader first, so this cannot delete an answer
    // written for somebody else's profile.
    readProfile(profileId, req.user);
    deleteAnswer(jobId, profileId, question);
    res.json({ message: 'Answer deleted successfully.' });
  } catch (error) {
    sendPublicError(req, res, error, 'Could not delete that answer');
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
      targetProfiles.push(readProfile(profileId, req.user));
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
    sendPublicError(req, res, error, 'Could not generate the answers');
  }
});

export default router;
