import { createHash } from 'crypto';
import { resolveAnalysisModel } from '../../config/aiModelConfig';
import { describeAiChoice, type AiChoice } from '../../config/aiPreferences';
import { renderJobFieldListForPrompt } from '../../config/jobFields';
import {
  attachCompanyName,
  attachLinkKey,
  findJobAnalysisByContentHash,
  findJobAnalysisByLinkKey,
  getJobAnalysisById,
  insertJobAnalysisIfAbsent,
  type StoredJobAnalysis,
} from '../../database/jobAnalysisRepository';
import type { JobAnalysis, RawNestedJobAnalysis } from '../../types/template';
import { createPromptCompletion } from '../ai';
import { resolvePromptByExactId } from '../promptService';
import {
  buildAnalyzeJobDescriptionPromptValues,
  normalizeJobAnalysisResponse,
  parseJobAnalysisContent,
} from '../resumeService';
import { SENIORITY_VALUES } from './facts';
import { normalizeJobDescriptionText, postingKeysOf, samePosting, type PostingKeys } from './identity';

export type { StoredJobAnalysis } from '../../database/jobAnalysisRepository';

/**
 * THE ONE GATE to a job analysis: a posting is analysed exactly once, ever
 * (owner decision J0; PLAN check 1).
 *
 * `getOrCreateAnalysis` is the only function in the codebase that runs the
 * analysis prompt - test/analysisGate.test.js reads every module and fails if
 * anything else names it or calls its completion. Every caller comes here:
 * /resume/analyze, the previews, /resume/generate, the queue's tasks (and the
 * batch submission before them), the Job Filter, and later the reporter run
 * and the lake's merge. It answers, in order:
 *
 *   0. a Google Sheet row's own analysis, read by the SERVER from the row's
 *      protected Analysis cell (services/sheets/analysisColumns.ts) - the
 *      stored row it names, or, when the store has none for this posting yet,
 *      the sheet's content registered without a model call, so the database
 *      and the sheet hold the same analysis;
 *   1. the stored analysis of this posting - by its normalised link, then by
 *      its whitespace-normalised text (identity.ts), one index seek each;
 *   2. the analysis of this posting already in flight in this process, which
 *      the caller waits for instead of starting its own;
 *   3. ONE model call, on the administrator's analysis model (J1), stored with
 *      INSERT ... ON CONFLICT DO NOTHING and read back - so even a race lost
 *      between two processes keeps one row, and both get it.
 *
 * Nothing about a model, a prompt, a profile or an account is part of what
 * identifies a posting: editing the prompt or switching the analysis model
 * reaches only postings never analysed before, and there is no re-analyse.
 * A call that FAILS - a timeout, a seat down, an answer that does not parse -
 * stores nothing, because there is no analysis yet; the next request is the
 * first real one. That is the only way a posting reaches a model twice - bar
 * a stored row damaged outside the program (hand-edited, a backup restored
 * part way), which reads as absent: its posting is analysed once more and the
 * answer written into that row (jobAnalysisRepository's `repairUnreadableRow`),
 * not once per request.
 */

/** The analysis prompt's id: the built-in record, edited by an administrator or not. */
export const ANALYSIS_PROMPT_ID = 'analyze-job-description';

/** A posting shorter than this, with nothing stored for it, is not analysed. */
export const JOB_ANALYSIS_MIN_LENGTH = 50;

/**
 * A Google Sheet row's own analysis, as the server read it from the row's
 * protected Analysis cell - never from a request body. `analysisId` is the
 * stored row the cell names; `analysis` is the cell's content, already
 * normalised. Either may be missing: a cell cut at Google's limit still names
 * its row, and a cell from another install names a row this store lacks.
 */
export type SheetRowAnalysis = {
  analysisId?: string;
  analysis?: JobAnalysis;
  /**
   * The keys of the posting the cell says it was written for. A sheet row's
   * posting can be replaced, or rows sorted under the protected columns, so
   * neither the stored row a cell names nor its content is used for a posting
   * it was not written for - and content that names no posting is not
   * registered for any.
   */
  posting?: Partial<PostingKeys>;
  /** For the log line when the cell is used or cannot be. */
  row?: number;
};

export type AnalysisRequest = {
  /** The posting's text. */
  jd?: string;
  /** The posting's link, which identifies it as well as its text does. */
  link?: string;
  sheetRow?: SheetRowAnalysis;
  /** The account whose action produced the analysis, recorded as `created_by`. */
  requestedBy?: string | null;
  /**
   * The company the posting is for, when the caller knows it - a build's
   * job, a sheet row, a report. Recorded on the stored row (never over one
   * already there): the analysis itself leaves company names out, and the
   * Job Data Lake's merge hashes the job on it. Never part of the posting's
   * identity.
   */
  company?: string;
  /**
   * Steps 0 and 1 only: the sheet's analysis or the stored one, else null -
   * never a model call. What a batch's submission asks, which must answer at
   * once; a posting with neither is analysed by its first task instead.
   */
  storedOnly?: boolean;
  signal?: AbortSignal;
};

/** The two keys a request's posting is known by. */
function postingKeys(input: { jd?: string; link?: string }): PostingKeys {
  return postingKeysOf(input);
}

/**
 * The stored analysis of a posting, or null - by its link, then by its text.
 *
 * Link first: the same job reached from two sheets with its text reworded is
 * one posting when its link says so. A posting found by its text that had no
 * link on record is given this one, so the next request with the link and
 * different words finds it too. Store only: never a model call.
 */
export function findStoredAnalysis(input: { jd?: string; link?: string }): StoredJobAnalysis | null {
  const keys = postingKeys(input);
  if (keys.link) {
    const byLink = findJobAnalysisByLinkKey(keys.link);
    if (byLink) return byLink;
  }
  if (keys.hash) {
    const byText = findJobAnalysisByContentHash(keys.hash);
    if (byText) {
      if (keys.link && !byText.linkKey) attachLinkKey(byText.id, keys.link, (input.link ?? '').trim());
      return byText;
    }
  }
  return null;
}

/** A stored analysis by its id, or null. What a caller holding an `analysisId` reads. */
export function loadAnalysis(analysisId: unknown): StoredJobAnalysis | null {
  return typeof analysisId === 'string' ? getJobAnalysisById(analysisId) : null;
}

/**
 * Whether a stored analysis is the one of THIS posting, by link or by text.
 * A client may name any analysis it was given, and a sheet row's Analysis
 * cell may name one written for the posting that sat in the row before; only
 * one that matches the posting being built for is used for it, or written
 * back into its row.
 */
export function analysisMatchesPosting(stored: StoredJobAnalysis, input: { jd?: string; link?: string }): boolean {
  return samePosting({ hash: stored.contentHash, link: stored.linkKey }, postingKeys(input));
}

/* ------------------------------------------------------------ in flight -- */

type InFlight = {
  promise: Promise<StoredJobAnalysis>;
  controller: AbortController;
  waiters: number;
};

/**
 * Analyses being made right now, keyed on the POSTING - under its link key
 * and its content hash both, so a second request that shares either waits
 * for the first one's call instead of starting another.
 *
 * Process-wide, not per batch or per request: two pages pressing Generate on
 * one posting at once, or a batch's tasks for three profiles on three
 * models, all end up here.
 */
const inFlight = new Map<string, InFlight>();

function inFlightKeys(keys: { hash: string | null; link: string | null }): string[] {
  return [keys.link ? `link:${keys.link}` : null, keys.hash ? `hash:${keys.hash}` : null].filter(
    (key): key is string => key !== null
  );
}

function cancelled(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('The job analysis was cancelled.');
}

/**
 * Waits for a shared call on one caller's behalf.
 *
 * The call is shared, so no ONE caller's signal may stop it: a page that
 * closes must not fail the batch waiting on the same posting. Each caller is
 * released on its own abort, and the call itself is aborted only when the
 * last of them has gone.
 */
function waitFor(entry: InFlight, signal: AbortSignal | undefined): Promise<StoredJobAnalysis> {
  entry.waiters += 1;
  return new Promise((resolve, reject) => {
    let done = false;
    const leave = (): boolean => {
      if (done) return false;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      entry.waiters -= 1;
      return true;
    };
    const onAbort = () => {
      if (!leave()) return;
      if (entry.waiters <= 0) entry.controller.abort();
      reject(cancelled(signal!));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    entry.promise.then(
      (value) => {
        if (leave()) resolve(value);
      },
      (error) => {
        if (leave()) reject(error);
      }
    );
  });
}

/** Tests share one process: a call left in the map would be joined by the next test. */
export function resetAnalysisGateForTests(): void {
  inFlight.clear();
}

/** How many postings are being analysed right now. For the tests. */
export function analysesInFlight(): number {
  return new Set(inFlight.values()).size;
}

/* ------------------------------------------------------------- the gate -- */

export async function getOrCreateAnalysis(input: AnalysisRequest): Promise<StoredJobAnalysis | null> {
  const found = await resolveAnalysis(input);
  if (found && input.company && !found.companyName) {
    attachCompanyName(found.id, input.company);
    return getJobAnalysisById(found.id) ?? found;
  }
  return found;
}

async function resolveAnalysis(input: AnalysisRequest): Promise<StoredJobAnalysis | null> {
  const jd = typeof input.jd === 'string' ? input.jd.trim() : '';
  const link = typeof input.link === 'string' ? input.link.trim() : '';
  const keys = postingKeys({ jd, link });

  // 0. The sheet row's own analysis.
  if (input.sheetRow) {
    const fromSheet = useSheetAnalysis(input.sheetRow, { jd, link, keys }, input.requestedBy ?? null, input.company ?? '');
    if (fromSheet) return fromSheet;
  }

  // 1. Stored.
  const stored = findStoredAnalysis({ jd, link });
  if (stored) return stored;

  if (input.storedOnly) return null;
  if (normalizeJobDescriptionText(jd).length < JOB_ANALYSIS_MIN_LENGTH || !keys.hash) return null;

  // 2. In flight.
  const flightKeys = inFlightKeys(keys);
  for (const key of flightKeys) {
    const running = inFlight.get(key);
    if (!running) continue;
    const joined = await waitFor(running, input.signal);
    // Joined by text, the call may have been made without this link: record
    // it, so the next request with the link and other words finds the row.
    if (keys.link && !joined.linkKey) attachLinkKey(joined.id, keys.link, link);
    return joined;
  }

  // 3. One call.
  const controller = new AbortController();
  const entry: InFlight = {
    controller,
    waiters: 0,
    promise: analyseAndStore(
      { jd, link, keys: { hash: keys.hash, link: keys.link }, requestedBy: input.requestedBy ?? null, company: input.company ?? '' },
      controller.signal
    ),
  };
  for (const key of flightKeys) inFlight.set(key, entry);
  // Out of the map once settled, whichever way: a success is in the store by
  // then, and a failure stored nothing, so the next request starts afresh.
  entry.promise
    .finally(() => {
      for (const key of flightKeys) if (inFlight.get(key) === entry) inFlight.delete(key);
    })
    .catch(() => undefined);
  return waitFor(entry, input.signal);
}

/**
 * Step 0: the sheet's content, or the stored row it names - for THIS posting.
 *
 * The stored row wins when the cell names one: the program wrote both, and
 * the store is the source of truth. Otherwise the cell's content is
 * registered for this posting (source `sheet`), unless the store already has
 * an analysis of the posting - then that one is the posting's analysis, and
 * the sheet's is logged as disagreeing rather than stored beside it.
 *
 * Either only when the cell was written for this posting. A row's posting can
 * be replaced, and rows sorted under the protected columns; a cell left from
 * the posting that sat there before is not this one's analysis, so the store
 * (or one analysis) answers instead, and the write-back puts the right one in.
 */
function useSheetAnalysis(
  sheetRow: SheetRowAnalysis,
  posting: { jd: string; link: string; keys: PostingKeys },
  requestedBy: string | null,
  company: string
): StoredJobAnalysis | null {
  const where = sheetRow.row ? `sheet row ${sheetRow.row}` : 'a sheet row';
  const named = sheetRow.analysisId ? getJobAnalysisById(sheetRow.analysisId) : null;
  if (named) {
    if (analysisMatchesPosting(named, posting)) return named;
    console.warn(`[analysis] ${where} holds the analysis of another posting (${named.id}); it is not used.`);
    return null;
  }
  if (!sheetRow.analysis || !posting.keys.hash) return null;
  if (!sheetRow.posting || !samePosting(sheetRow.posting, posting.keys)) {
    console.warn(
      `[analysis] ${where} holds an analysis that was not written for its posting; it is not registered or used.`
    );
    return null;
  }

  const existing = findStoredAnalysis({ jd: posting.jd, link: posting.link });
  if (existing) {
    console.warn(
      `[analysis] ${where} holds an analysis the store does not know, but the store already has one for ` +
        `this posting (${existing.id}); the stored one is used.`
    );
    return existing;
  }

  const { row, inserted } = insertJobAnalysisIfAbsent({
    contentHash: posting.keys.hash,
    linkKey: posting.keys.link,
    jobLink: posting.link,
    analysis: { ...sheetRow.analysis, sourceJobDescription: posting.jd },
    modelId: '',
    promptHash: '',
    source: 'sheet',
    createdBy: requestedBy,
    companyName: company,
  });
  if (inserted) console.log(`[analysis] Registered the analysis read from ${where} (${row.id}); no model was asked.`);
  return row;
}

/**
 * The analysis instructions an administrator's record lacks when it was
 * written before postings had a job field (`predatesJobField` on Admin ->
 * Prompts): appended to the turn so its postings are still classified, priced
 * and screened. The shipped prompt carries all of this in its cached part.
 *
 * Seniority included: such a record asks for an older, shorter list of words
 * (no "intern", "director" or "vp"), and the Job Filter now judges the
 * analysis's own `jobMeta.seniority` - a VP posting answered "unknown" would
 * pass the filter that used to fail it.
 */
export function buildAnalysisFactsOverride(): string {
  const seniority = SENIORITY_VALUES.map((word) => `"${word}"`).join(', ');
  return [
    `"jobMeta.seniority": exactly one of ${seniority} - this list replaces any other seniority list above. The title`,
    'decides when it says ("Intern" -> "intern", "Staff Engineer" -> "staff", "Principal" -> "principal", "Lead" -> "lead",',
    '"Engineering Manager" -> "manager", "Director" -> "director", "VP" or "Vice President" -> "vp"); otherwise years of',
    'experience: 0-2 -> "junior", 3-5 -> "mid", more than 5 -> "senior".',
    '',
    'ALSO RETURN, in the same JSON object, these three keys - read off the posting itself, never guessed:',
    '"jobField": exactly ONE id from the list below (the text before the colon), or "unclassified" when none fits.',
    '"salary": { "min", "max", "currency", "period", "raw" } - ONLY what the posting explicitly states, numbers for',
    'min and max, an ISO 4217 code for currency, one of "annual", "monthly", "weekly", "daily", "hourly" for period,',
    'the posting\'s own words for raw; all five null when it states no salary.',
    '"filter": { "jobType": "remote"|"hybrid"|"on_site"|"not_specified", "onsiteInterview": "yes"|"no"|"not_specified",',
    '"companyCategory": "healthcare"|"fintech"|"consulting"|"defense_military"|"saas"|"ecommerce"|"cybersecurity"|',
    '"ai_ml"|"edtech"|"govtech"|"insurtech"|"legaltech"|"media_entertainment"|"logistics"|"energy"|',
    '"enterprise_software"|"other", "clearanceRequired": "none"|"public_trust"|"secret"|"top_secret"|"ts_sci"|',
    '"not_specified", "region": "us"|"not_us", "usState": a 2-letter code, or null when remote or unclear }.',
    '',
    'JOB FIELDS (id: label):',
    renderJobFieldListForPrompt(),
  ].join('\n');
}

/** SHA-256 of the prompt text that produced an analysis - an audit, never part of its identity. */
function promptHash(content: string | undefined): string {
  return content ? createHash('sha256').update(content, 'utf8').digest('hex') : '';
}

/**
 * The model call, and the row it leaves.
 *
 * On the analysis model whatever the prompt record names (`runChoiceWins`):
 * the setting under Admin -> Settings is the one place that decides which
 * model reads postings, so every posting's job field comes from one model.
 */
async function analyseAndStore(
  input: { jd: string; link: string; keys: { hash: string; link: string | null }; requestedBy: string | null; company: string },
  signal: AbortSignal
): Promise<StoredJobAnalysis> {
  const model = await resolveAnalysisModel();
  const choice: AiChoice = {
    provider: model.provider,
    modelName: model.modelName,
    modelId: model.id,
    modelLabel: model.name,
  };
  const record = await resolvePromptByExactId(ANALYSIS_PROMPT_ID).catch(() => null);
  const predates = Boolean(record && !/\[\[\s*jobFieldList\s*\]\]/.test(record.content));

  const startedAt = process.hrtime.bigint();
  console.log(`[analysis] Analysing a new posting (${describeAiChoice(choice)})`);
  const content = await createPromptCompletion({
    promptId: ANALYSIS_PROMPT_ID,
    callSite: ANALYSIS_PROMPT_ID,
    promptValues: buildAnalyzeJobDescriptionPromptValues(input.jd, input.link),
    fallbackProvider: choice.provider,
    fallbackModelName: choice.modelName,
    maxTokens: 7000,
    temperature: 0,
    responseFormat: 'json',
    useExactPromptId: true,
    runChoiceWins: true,
    ...(predates ? { appendToUserBody: buildAnalysisFactsOverride() } : {}),
    signal,
  });
  const analysis = parseJobAnalysisContent(content, input.jd);
  const seconds = (Number(process.hrtime.bigint() - startedAt) / 1_000_000_000).toFixed(2);

  const { row, inserted } = insertJobAnalysisIfAbsent({
    contentHash: input.keys.hash,
    linkKey: input.keys.link,
    jobLink: input.link,
    analysis,
    modelId: model.id,
    promptHash: promptHash(record?.content),
    source: 'ai',
    createdBy: input.requestedBy,
    companyName: input.company,
  });
  console.log(
    inserted
      ? `[analysis] Stored analysis ${row.id} (${row.jobFieldId}) in ${seconds}s`
      : `[analysis] Another process stored this posting first (${row.id}); its analysis is used`
  );
  return row;
}

/**
 * An Analysis cell's content as a JobAnalysis, checked exactly as a model's
 * answer is - the job field against the list, the salary and the filter facts
 * against their words. The cell is protected, but what reaches the store from
 * it is never trusted further than a model's answer would be.
 */
export function normalizeSheetAnalysis(raw: unknown, jobDescription: string): JobAnalysis | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  try {
    return normalizeJobAnalysisResponse(raw as RawNestedJobAnalysis, jobDescription);
  } catch {
    return null;
  }
}
