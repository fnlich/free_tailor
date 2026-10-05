import { randomUUID } from 'crypto';
import { getDb } from './sqlite';
import type { JobAnalysis, JobSalary } from '../types/template';
import { UNCLASSIFIED_JOB_FIELD_ID } from '../config/jobFields';

/**
 * The `job_analyses` table: every posting this install has analysed, once.
 *
 * Read and written ONLY through services/jobAnalysis/gate.ts, which is what
 * decides that a posting is analysed exactly once. This module knows nothing
 * of models or prompts: it stores what it is handed, never replaces a row,
 * and answers the gate's two lookups - by normalised job link, then by the
 * hash of the whitespace-normalised text - each a single seek on its own
 * UNIQUE index (test/jobAnalysisStore.test.js pins the query plans).
 */

export type JobAnalysisSource = 'ai' | 'sheet';

export type StoredJobAnalysis = {
  id: string;
  contentHash: string;
  linkKey: string | null;
  jobLink: string;
  /** The analysis, with the posting's text back in `sourceJobDescription`. */
  analysis: JobAnalysis;
  jobFieldId: string;
  modelId: string;
  promptHash: string;
  source: JobAnalysisSource;
  createdBy: string | null;
  createdAt: string;
  mergedAt: string | null;
};

type Row = {
  id: string;
  content_hash: string;
  link_key: string | null;
  job_link: string;
  job_description: string;
  analysis_json: string;
  job_field_id: string;
  model_id: string;
  prompt_hash: string;
  source: string;
  created_by: string | null;
  created_at: string;
  merged_at: string | null;
};

const COLUMNS =
  'id, content_hash, link_key, job_link, job_description, analysis_json, job_field_id, ' +
  'model_id, prompt_hash, source, created_by, created_at, merged_at';

/** The gate's lookups, exported so the query-plan test runs exactly these statements. */
export const FIND_BY_LINK_KEY_SQL = `SELECT ${COLUMNS} FROM job_analyses WHERE link_key = ?`;
export const FIND_BY_CONTENT_HASH_SQL = `SELECT ${COLUMNS} FROM job_analyses WHERE content_hash = ?`;

/**
 * A stored row's analysis JSON as an object, or null when it cannot be read as
 * one - JSON that does not parse, or parses to something that is not an object
 * (`null`, a number, an array). The program only ever writes an object, so
 * either is a row damaged outside it: hand-edited, or a backup restored part
 * way.
 */
function readAnalysisJson(row: Pick<Row, 'id' | 'analysis_json'>): Partial<JobAnalysis> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.analysis_json);
  } catch (error) {
    reportUnreadable(row.id, error);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    reportUnreadable(row.id, new Error(`its analysis is ${Array.isArray(parsed) ? 'an array' : String(parsed)}, not an object`));
    return null;
  }
  return parsed as Partial<JobAnalysis>;
}

/** Rows already reported unreadable, so the log names each once rather than on every lookup. */
const reportedUnreadable = new Set<string>();

function reportUnreadable(id: string, error: unknown): void {
  if (reportedUnreadable.has(id)) return;
  reportedUnreadable.add(id);
  console.error(
    `[analysis] Stored analysis ${id} is not readable; it is treated as absent, and the next analysis of its ` +
      'posting is stored over it.',
    error
  );
}

/**
 * A stored row back into an analysis, or null when its analysis is unreadable.
 *
 * Fields an older row may lack - one stored before an analysis carried a job
 * field, salary or filter facts - read as their empty values, so every reader
 * can rely on the full JobAnalysis shape.
 */
function fromRow(row: Row | undefined): StoredJobAnalysis | null {
  if (!row) return null;
  const parsed = readAnalysisJson(row);
  if (!parsed) return null;
  const analysis = {
    ...parsed,
    jobField: typeof parsed.jobField === 'string' ? parsed.jobField : row.job_field_id || UNCLASSIFIED_JOB_FIELD_ID,
    salary: parsed.salary ?? null,
    filter: parsed.filter ?? {
      jobType: 'not_specified',
      onsiteInterview: 'not_specified',
      companyCategory: 'other',
      clearanceRequired: 'not_specified',
      region: 'not_specified',
      usState: '',
    },
    sourceJobDescription: row.job_description,
  } as JobAnalysis;
  return {
    id: row.id,
    contentHash: row.content_hash,
    linkKey: row.link_key,
    jobLink: row.job_link,
    analysis,
    jobFieldId: row.job_field_id,
    modelId: row.model_id,
    promptHash: row.prompt_hash,
    source: row.source === 'sheet' ? 'sheet' : 'ai',
    createdBy: row.created_by,
    createdAt: row.created_at,
    mergedAt: row.merged_at,
  };
}

export function getJobAnalysisById(id: string): StoredJobAnalysis | null {
  if (typeof id !== 'string' || !id.trim()) return null;
  return fromRow(getDb().prepare(`SELECT ${COLUMNS} FROM job_analyses WHERE id = ?`).get(id.trim()) as Row | undefined);
}

export function findJobAnalysisByLinkKey(linkKey: string): StoredJobAnalysis | null {
  return fromRow(getDb().prepare(FIND_BY_LINK_KEY_SQL).get(linkKey) as Row | undefined);
}

export function findJobAnalysisByContentHash(contentHash: string): StoredJobAnalysis | null {
  return fromRow(getDb().prepare(FIND_BY_CONTENT_HASH_SQL).get(contentHash) as Row | undefined);
}

export type NewJobAnalysis = {
  contentHash: string;
  linkKey: string | null;
  jobLink: string;
  analysis: JobAnalysis;
  modelId: string;
  promptHash: string;
  source: JobAnalysisSource;
  createdBy: string | null;
};

function salaryColumns(salary: JobSalary | null | undefined) {
  return {
    salary_min: salary?.min ?? null,
    salary_max: salary?.max ?? null,
    salary_currency: salary?.currency ?? null,
    salary_period: salary?.period ?? null,
    salary_raw: salary?.raw ?? null,
  };
}

/** The columns an analysis fills - everything but the posting's identity and the row's own history. */
function analysisColumns(input: NewJobAnalysis) {
  const { sourceJobDescription: _text, ...analysisOnly } = input.analysis;
  return {
    analysis_json: JSON.stringify(analysisOnly),
    job_field_id: input.analysis.jobField || UNCLASSIFIED_JOB_FIELD_ID,
    job_title: input.analysis.jobMeta?.title ?? '',
    ...salaryColumns(input.analysis.salary),
    model_id: input.modelId,
    prompt_hash: input.promptHash,
    source: input.source,
  };
}

/**
 * Stores a new analysis unless the posting already has one, and says which
 * row is the posting's now.
 *
 * `INSERT ... ON CONFLICT DO NOTHING` against BOTH unique indexes: a second
 * writer for the same text, or the same link, inserts nothing and is handed
 * the row that won. This is the database half of "exactly once" - the gate's
 * in-flight map stops a second call in this process, and this stops a second
 * ROW whatever happens between processes or after a lost race.
 *
 * The one row it fills in rather than keeps is one whose analysis cannot be
 * read (`repairUnreadableRow`): every lookup reads that row as absent, so
 * keeping it would send its posting to a model on every request, for ever.
 */
export function insertJobAnalysisIfAbsent(input: NewJobAnalysis): { row: StoredJobAnalysis; inserted: boolean } {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO job_analyses (
         id, content_hash, link_key, job_link, job_description, analysis_json, job_field_id, job_title,
         salary_min, salary_max, salary_currency, salary_period, salary_raw,
         model_id, prompt_hash, source, created_by, created_at
       ) VALUES (
         @id, @content_hash, @link_key, @job_link, @job_description, @analysis_json, @job_field_id, @job_title,
         @salary_min, @salary_max, @salary_currency, @salary_period, @salary_raw,
         @model_id, @prompt_hash, @source, @created_by, @created_at
       ) ON CONFLICT DO NOTHING`
    )
    .run({
      id,
      content_hash: input.contentHash,
      link_key: input.linkKey,
      job_link: input.jobLink,
      job_description: input.analysis.sourceJobDescription ?? '',
      ...analysisColumns(input),
      created_by: input.createdBy,
      created_at: now,
    });

  if (result.changes === 1) {
    const row = getJobAnalysisById(id);
    if (row) return { row, inserted: true };
  }
  // Lost to a row with the same link or the same text: that row is the
  // posting's analysis, and this one is dropped. Link first, as the gate looks.
  const winner =
    (input.linkKey ? findJobAnalysisByLinkKey(input.linkKey) : null) ??
    findJobAnalysisByContentHash(input.contentHash);
  if (winner) return { row: winner, inserted: false };

  const repaired = repairUnreadableRow(input);
  if (repaired) return repaired;
  throw new Error('A job analysis could be neither stored nor found for its posting.');
}

/**
 * The posting has a row - the insert ran into it - but its analysis cannot be
 * read, so no lookup finds it. The analysis just made is written into THAT
 * row (its id, its posting and its creation stay), once: the next request
 * reads it like any other, and the posting has had exactly one more call,
 * not one per request.
 *
 * Not an overwrite of an analysis - there was none anybody could read. Under
 * an IMMEDIATE transaction, so a second process repairing the same row at the
 * same moment finds it readable and is handed it instead.
 */
function repairUnreadableRow(input: NewJobAnalysis): { row: StoredJobAnalysis; inserted: boolean } | null {
  const db = getDb();
  const repair = db.transaction((): { row: StoredJobAnalysis; inserted: boolean } | null => {
    const candidates = [
      input.linkKey ? (db.prepare(FIND_BY_LINK_KEY_SQL).get(input.linkKey) as Row | undefined) : undefined,
      db.prepare(FIND_BY_CONTENT_HASH_SQL).get(input.contentHash) as Row | undefined,
    ];
    for (const row of candidates) {
      if (!row) continue;
      const readable = fromRow(row);
      if (readable) return { row: readable, inserted: false };
      db.prepare(
        `UPDATE job_analyses SET
           analysis_json = @analysis_json, job_field_id = @job_field_id, job_title = @job_title,
           salary_min = @salary_min, salary_max = @salary_max, salary_currency = @salary_currency,
           salary_period = @salary_period, salary_raw = @salary_raw,
           model_id = @model_id, prompt_hash = @prompt_hash, source = @source
         WHERE id = @id`
      ).run({ id: row.id, ...analysisColumns(input) });
      const repaired = getJobAnalysisById(row.id);
      if (!repaired) return null;
      reportedUnreadable.delete(row.id);
      console.warn(`[analysis] Stored analysis ${row.id} could not be read; the new analysis of its posting replaces it.`);
      return { row: repaired, inserted: true };
    }
    return null;
  });
  return repair.immediate();
}

/**
 * Gives a stored row the link it was found by when it had none - the same
 * posting first analysed from pasted text, then reached from a sheet row with
 * its link. Not an overwrite: only a NULL link is filled, the analysis is not
 * touched, and a link another row already holds is left where it is.
 */
export function attachLinkKey(id: string, linkKey: string, jobLink: string): void {
  try {
    getDb()
      .prepare('UPDATE job_analyses SET link_key = ?, job_link = ? WHERE id = ? AND link_key IS NULL')
      .run(linkKey, jobLink, id);
  } catch (error) {
    // The UNIQUE index refusing it means another row already answers to this
    // link; this one keeps answering to its text. Not an error worth more than a line.
    console.warn(`[analysis] Could not record a link on stored analysis ${id}; it stays found by its text.`, error);
  }
}

/** How many postings have been analysed. For the admin pages and the tests. */
export function countJobAnalyses(): number {
  return (getDb().prepare('SELECT COUNT(*) AS count FROM job_analyses').get() as { count: number }).count;
}
