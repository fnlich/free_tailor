const { getDb } = require('../database/sqlite');

// Bid-assistant tables live in the shared application database.
const db = getDb();

function createJobsTable(tableName = 'jobs') {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name          TEXT,
      job_title             TEXT,
      job_url               TEXT,
      description           TEXT,
      salary_range          TEXT,
      comment               TEXT,
      row_number            INTEGER,
      posted_date           TEXT,
      imported_at           TEXT,
      is_error              INTEGER NOT NULL DEFAULT 0,
      error_reason          TEXT,
      google_sheet_id       TEXT,
      google_sheet_tab_name TEXT
    );
  `);
}

function createJobsIndexes(tableName = 'jobs') {
  db.exec(`
    DROP INDEX IF EXISTS ${tableName}_google_sheet_row_unique;

    CREATE INDEX IF NOT EXISTS ${tableName}_google_sheet_row_index
    ON ${tableName}(google_sheet_id, google_sheet_tab_name, row_number);
  `);
}

function dropJobUrlUniqueIndex(tableName = 'jobs') {
  db.exec(`DROP INDEX IF EXISTS ${tableName}_job_url_unique`);
}


function migrateJobsTableIfNeeded() {
  createJobsTable();

  const jobsTableSql = db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'jobs'
  `).get();
  const jobColumns = db.prepare(`PRAGMA table_info(jobs)`).all();
  const columnNames = new Set(jobColumns.map((column) => column.name));
  const hasGoogleSheetIdColumn = columnNames.has('google_sheet_id');
  const hasGoogleSheetTabNameColumn = columnNames.has('google_sheet_tab_name');
  const hasIsErrorColumn = columnNames.has('is_error');
  const hasErrorReasonColumn = columnNames.has('error_reason');
  const hasLegacyJobUrlUniqueConstraint = /job_url\s+text\s+unique/i.test(jobsTableSql?.sql || '');

  if (
    hasGoogleSheetIdColumn
    && hasGoogleSheetTabNameColumn
    && hasIsErrorColumn
    && hasErrorReasonColumn
    && !hasLegacyJobUrlUniqueConstraint
  ) {
    dropJobUrlUniqueIndex();
    createJobsIndexes();
    return;
  }

  db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS jobs_migrated`);
    createJobsTable('jobs_migrated');

    db.exec(`
      INSERT INTO jobs_migrated (
        id,
        company_name,
        job_title,
        job_url,
        description,
        salary_range,
        comment,
        row_number,
        posted_date,
        imported_at,
        is_error,
        error_reason,
        google_sheet_id,
        google_sheet_tab_name
      )
      SELECT
        id,
        company_name,
        job_title,
        job_url,
        description,
        salary_range,
        ${columnNames.has('comment') ? 'comment' : "''"},
        ${columnNames.has('row_number') ? 'row_number' : 'NULL'},
        posted_date,
        imported_at,
        ${hasIsErrorColumn ? 'is_error' : '0'},
        ${hasErrorReasonColumn ? 'error_reason' : 'NULL'},
        ${hasGoogleSheetIdColumn ? 'google_sheet_id' : 'NULL'},
        ${hasGoogleSheetTabNameColumn ? 'google_sheet_tab_name' : 'NULL'}
      FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_migrated RENAME TO jobs;
    `);
    dropJobUrlUniqueIndex();
    createJobsIndexes();
  })();
}

migrateJobsTableIfNeeded();

db.exec(`
  CREATE TABLE IF NOT EXISTS answers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      INTEGER,
    profile_id  TEXT,
    question    TEXT,
    answer      TEXT,
    char_limit  INTEGER,
    question_order INTEGER,
    updated_at  TEXT,
    UNIQUE(job_id, profile_id, question)
  );
`);

const answerColumns = db.prepare(`PRAGMA table_info(answers)`).all();
const hasQuestionOrderColumn = answerColumns.some((column) => column.name === 'question_order');

if (!hasQuestionOrderColumn) {
  db.exec(`ALTER TABLE answers ADD COLUMN question_order INTEGER`);
}

db.exec(`
  WITH ranked_answers AS (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY job_id, profile_id
        ORDER BY updated_at ASC, id ASC
      ) - 1 AS next_question_order
    FROM answers
    WHERE question_order IS NULL
  )
  UPDATE answers
  SET question_order = (
    SELECT ranked_answers.next_question_order
    FROM ranked_answers
    WHERE ranked_answers.id = answers.id
  )
  WHERE question_order IS NULL;
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS google_sheets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    label      TEXT UNIQUE,
    sheet_id   TEXT,
    sheet_gid  TEXT,
    created_at TEXT,
    updated_at TEXT
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT
  );
`);

const insertJobStatement = db.prepare(`
  INSERT INTO jobs (
    company_name,
    job_title,
    job_url,
    description,
    salary_range,
    comment,
    row_number,
    posted_date,
    imported_at,
    google_sheet_id,
    google_sheet_tab_name
  ) VALUES (
    @company_name,
    @job_title,
    @job_url,
    @description,
    @salary_range,
    @comment,
    @row_number,
    @posted_date,
    @imported_at,
    @google_sheet_id,
    @google_sheet_tab_name
  )
`);

const listJobsStatement = db.prepare(`
  SELECT
    jobs.*,
    EXISTS(
      SELECT 1
      FROM answers
      WHERE answers.job_id = jobs.id
    ) AS has_answers
  FROM jobs
  WHERE
    (
      @search = ''
      OR company_name LIKE @searchLike
      OR job_title LIKE @searchLike
      OR job_url LIKE @searchLike
    )
    AND (
      @date = ''
      OR posted_date = @date
    )
  ORDER BY
    CASE WHEN row_number IS NULL THEN 1 ELSE 0 END ASC,
    row_number ASC,
    posted_date DESC,
    imported_at DESC,
    id DESC
`);

const saveAnswerStatement = db.prepare(`
  INSERT OR REPLACE INTO answers (
    job_id,
    profile_id,
    question,
    answer,
    char_limit,
    question_order,
    updated_at
  ) VALUES (
    @job_id,
    @profile_id,
    @question,
    @answer,
    @char_limit,
    @question_order,
    @updated_at
  )
`);

const getAnswerByIdStatement = db.prepare(`
  SELECT
    id,
    job_id,
    profile_id
  FROM answers
  WHERE id = ?
`);

const deleteConflictingAnswerStatement = db.prepare(`
  DELETE FROM answers
  WHERE job_id = @job_id
    AND profile_id = @profile_id
    AND question = @question
    AND id <> @id
`);

const updateAnswerByIdStatement = db.prepare(`
  UPDATE answers
  SET
    question = @question,
    answer = @answer,
    char_limit = @char_limit,
    question_order = @question_order,
    updated_at = @updated_at
  WHERE id = @id
`);

const listAnswersStatement = db.prepare(`
  SELECT
    id,
    profile_id,
    question,
    answer,
    char_limit,
    question_order
  FROM answers
  WHERE job_id = ?
  ORDER BY
    profile_id,
    CASE WHEN question_order IS NULL THEN 1 ELSE 0 END ASC,
    question_order ASC,
    updated_at ASC,
    id ASC
`);

const deleteAnswerStatement = db.prepare(`
  DELETE FROM answers
  WHERE job_id = @job_id
    AND profile_id = @profile_id
    AND question = @question
`);

const deleteAnswersByJobIdStatement = db.prepare(`
  DELETE FROM answers
  WHERE job_id = ?
`);

const deleteJobStatement = db.prepare(`
  DELETE FROM jobs
  WHERE id = ?
`);

const listGoogleSheetsStatement = db.prepare(`
  SELECT
    id,
    label,
    sheet_id,
    created_at,
    updated_at
  FROM google_sheets
  ORDER BY label COLLATE NOCASE ASC, id ASC
`);

const getGoogleSheetByIdStatement = db.prepare(`
  SELECT
    id,
    label,
    sheet_id,
    created_at,
    updated_at
  FROM google_sheets
  WHERE id = ?
`);

const createGoogleSheetStatement = db.prepare(`
  INSERT INTO google_sheets (
    label,
    sheet_id,
    sheet_gid,
    created_at,
    updated_at
  ) VALUES (
    @label,
    @sheet_id,
    @sheet_gid,
    @created_at,
    @updated_at
  )
`);

const updateGoogleSheetStatement = db.prepare(`
  UPDATE google_sheets
  SET
    label = @label,
    sheet_id = @sheet_id,
    sheet_gid = @sheet_gid,
    updated_at = @updated_at
  WHERE id = @id
`);

const deleteGoogleSheetStatement = db.prepare(`
  DELETE FROM google_sheets
  WHERE id = ?
`);

const getJobByIdStatement = db.prepare(`
  SELECT
    jobs.*,
    EXISTS(
      SELECT 1
      FROM answers
      WHERE answers.job_id = jobs.id
    ) AS has_answers
  FROM jobs
  WHERE jobs.id = ?
  LIMIT 1
`);

const updateJobErrorStatement = db.prepare(`
  UPDATE jobs
  SET
    is_error = @is_error,
    error_reason = @error_reason
  WHERE id = @id
`);

const listJobsInRowRangeStatement = db.prepare(`
  SELECT
    id,
    job_url,
    is_error
  FROM jobs
  WHERE row_number IS NOT NULL
    AND row_number >= @fromRow
    AND row_number <= @toRow
    AND (
      @date = ''
      OR posted_date = @date
    )
  ORDER BY row_number ASC, id ASC
`);

const getAppSettingStatement = db.prepare(`
  SELECT
    key,
    value,
    updated_at
  FROM app_settings
  WHERE key = ?
`);

const setAppSettingStatement = db.prepare(`
  INSERT INTO app_settings (
    key,
    value,
    updated_at
  ) VALUES (
    @key,
    @value,
    @updated_at
  )
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`);

// Inserts or updates imported jobs and returns how many rows changed.
function importJobs(jobs) {
  const insertMany = db.transaction((jobRows) => {
    let addedCount = 0;

    for (const job of jobRows) {
      const normalizedJob = {
        company_name: job.company_name || '',
        job_title: job.job_title || '',
        job_url: job.job_url || '',
        description: job.description || '',
        salary_range: job.salary_range || '',
        comment: job.comment || '',
        row_number: Number.isInteger(job.row_number) ? job.row_number : null,
        posted_date: job.posted_date || '',
        imported_at: new Date().toISOString(),
        google_sheet_id: typeof job.google_sheet_id === 'string' ? job.google_sheet_id.trim() : null,
        google_sheet_tab_name: typeof job.google_sheet_tab_name === 'string' ? job.google_sheet_tab_name.trim() : null
      };
      const result = insertJobStatement.run(normalizedJob);

      addedCount += result.changes;
    }

    return addedCount;
  });

  return insertMany(jobs);
}

// Returns jobs filtered by search text and posted date.
function getJobs(search = '', date = '') {
  return listJobsStatement.all({
    search,
    searchLike: `%${search}%`,
    date
  }).map((job) => ({
    ...job,
    is_error: Boolean(job.is_error),
    has_answers: Boolean(job.has_answers)
  }));
}

// Returns one job row by id.
function getJobById(jobId) {
  const job = getJobByIdStatement.get(jobId);

  if (!job) {
    return null;
  }

  return {
    ...job,
    is_error: Boolean(job.is_error),
    has_answers: Boolean(job.has_answers)
  };
}

// Updates the error marker and reason for one job row.
function updateJobError(jobId, isError, errorReason) {
  updateJobErrorStatement.run({
    id: jobId,
    is_error: isError ? 1 : 0,
    error_reason: isError ? errorReason : null
  });

  return getJobById(jobId);
}

const deleteJobTransaction = db.transaction((jobId) => {
  const existingJob = getJobByIdStatement.get(jobId);

  if (!existingJob) {
    return false;
  }

  deleteAnswersByJobIdStatement.run(jobId);
  deleteJobStatement.run(jobId);

  return true;
});

// Deletes one job row and any answers attached to it.
function deleteJob(jobId) {
  return deleteJobTransaction(jobId);
}

// Returns copyable job links in one row range and how many Error rows were skipped.
function getCopyableJobLinks(fromRow, toRow, date = '') {
  const jobsInRange = listJobsInRowRangeStatement.all({
    fromRow,
    toRow,
    date
  });
  const copyableLinks = [];
  let skippedErrorCount = 0;

  for (const job of jobsInRange) {
    if (Boolean(job.is_error)) {
      skippedErrorCount += 1;
      continue;
    }

    const jobUrl = typeof job.job_url === 'string' ? job.job_url.trim() : '';

    if (jobUrl) {
      copyableLinks.push(jobUrl);
    }
  }

  return {
    links: copyableLinks,
    skippedErrorCount
  };
}

// Saves one generated answer for one job and profile.
function saveAnswer(jobId, profileId, question, answer, charLimit, questionOrder = null) {
  return saveAnswerStatement.run({
    job_id: jobId,
    profile_id: profileId,
    question,
    answer,
    char_limit: charLimit,
    question_order: Number.isInteger(questionOrder) ? questionOrder : null,
    updated_at: new Date().toISOString()
  });
}

const replaceAnswerTransaction = db.transaction((answerId, jobId, profileId, question, answer, charLimit, questionOrder) => {
  const existingAnswer = getAnswerByIdStatement.get(answerId);

  if (!existingAnswer || existingAnswer.job_id !== jobId || existingAnswer.profile_id !== profileId) {
    return false;
  }

  deleteConflictingAnswerStatement.run({
    id: answerId,
    job_id: jobId,
    profile_id: profileId,
    question
  });

  updateAnswerByIdStatement.run({
    id: answerId,
    question,
    answer,
    char_limit: charLimit,
    question_order: Number.isInteger(questionOrder) ? questionOrder : null,
    updated_at: new Date().toISOString()
  });

  return true;
});

// Replaces one saved answer while preserving its identity for resubmits.
function replaceAnswer(answerId, jobId, profileId, question, answer, charLimit, questionOrder = null) {
  return replaceAnswerTransaction(answerId, jobId, profileId, question, answer, charLimit, questionOrder);
}

// Returns one saved answer record by id.
function getAnswerById(answerId) {
  return getAnswerByIdStatement.get(answerId) || null;
}

// Returns answers grouped by profile id for one job.
function getAnswersByJobId(jobId) {
  const rows = listAnswersStatement.all(jobId);
  const groupedAnswers = {};

  for (const row of rows) {
    if (!groupedAnswers[row.profile_id]) {
      groupedAnswers[row.profile_id] = [];
    }

      groupedAnswers[row.profile_id].push({
        id: row.id,
        question: row.question,
        answer: row.answer,
        charLimit: row.char_limit,
        questionOrder: row.question_order
      });
  }

  return groupedAnswers;
}

// Deletes one saved answer for one job/profile/question combination.
function deleteAnswer(jobId, profileId, question) {
  return deleteAnswerStatement.run({
    job_id: jobId,
    profile_id: profileId,
    question
  });
}

// Returns all saved Google Sheet sources.
function getGoogleSheets() {
  return listGoogleSheetsStatement.all();
}

// Returns one Google Sheet source by id.
function getGoogleSheetById(id) {
  return getGoogleSheetByIdStatement.get(id) || null;
}

// Creates a saved Google Sheet source record.
function createGoogleSheet(sheet) {
  const timestamp = new Date().toISOString();
  const result = createGoogleSheetStatement.run({
    label: sheet.label.trim(),
    sheet_id: sheet.sheet_id.trim(),
    sheet_gid: '',
    created_at: timestamp,
    updated_at: timestamp
  });

  return getGoogleSheetById(result.lastInsertRowid);
}

// Updates one saved Google Sheet source record.
function updateGoogleSheet(id, sheet) {
  updateGoogleSheetStatement.run({
    id,
    label: sheet.label.trim(),
    sheet_id: sheet.sheet_id.trim(),
    sheet_gid: '',
    updated_at: new Date().toISOString()
  });

  return getGoogleSheetById(id);
}

// Deletes one saved Google Sheet source record.
function deleteGoogleSheet(id) {
  return deleteGoogleSheetStatement.run(id);
}

// Returns one persisted application setting by key.
function getAppSetting(key) {
  return getAppSettingStatement.get(key) || null;
}

// Creates or updates one persisted application setting.
function setAppSetting(key, value) {
  const updatedAt = new Date().toISOString();

  setAppSettingStatement.run({
    key,
    value,
    updated_at: updatedAt
  });

  return {
    key,
    value,
    updated_at: updatedAt
  };
}

module.exports = {
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
};
