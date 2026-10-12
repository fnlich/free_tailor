import { createHash } from 'crypto';
import { resolveAnalysisModel } from '../../config/aiModelConfig';
import { describeAiChoice, type AiChoice } from '../../config/aiPreferences';
import {
  attachCompanyName,
  attachLinkKey,
  findJobAnalysisByContentHash,
  findJobAnalysisByLinkKey,
  getJobAnalysisById,
  insertJobAnalysisIfAbsent,
  type StoredJobAnalysis,
} from '../../database/jobAnalysisRepository';
import { createPromptCompletion } from '../ai';
import { resolvePromptByExactId } from '../promptService';
import {
  buildAnalyzeJobDescriptionPromptValues,
  buildJobFactsPromptValues,
  composeJobAnalysis,
  parseJobAnalysisKeywords,
  parseJobFacts,
  type JobAnalysisKeywords,
} from '../resumeService';
import { isAnalysisOfPosting } from '../sheets/analysisColumns';
import type { JobFactsAnswer } from './facts';
import { normalizeJobDescriptionText, postingKeysOf, type PostingKeys } from './identity';
import { JOB_FIELD_PREAMBLE, JOB_FIELD_REMINDER } from './jobFieldLine';

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
 *      STORED analysis the cell names, and only when that stored analysis is
 *      this posting's. The cell's own content is never used and never
 *      stored: a cell naming nothing in the store is ignored, and the steps
 *      below answer;
 *   1. the stored analysis of this posting - by its normalised link, then by
 *      its whitespace-normalised text (identity.ts), one index seek each;
 *   2. the analysis of this posting already in flight in this process, which
 *      the caller waits for instead of starting its own;
 *   3. ONE analysis, on the administrator's analysis model (J1): two calls
 *      made in parallel (owner decision O1) - the analysis prompt for the
 *      posting's keywords, and the Job Facts (Filter) prompt for its facts
 *      plus the job field the code asks for (jobFieldLine.ts) - composed
 *      into one row, stored with INSERT ... ON CONFLICT DO NOTHING and read
 *      back - so even a race lost between two processes keeps one row, and
 *      both get it.
 *
 * Nothing about a model, a prompt, a profile or an account is part of what
 * identifies a posting: editing either prompt or switching the analysis model
 * reaches only postings never analysed before, and there is no re-analyse.
 * A call that FAILS - a timeout, a seat down, an answer that does not parse -
 * stops the other and stores nothing, because there is no analysis yet; the
 * next request is the first real one and makes both calls again. That is the
 * only way a posting reaches a model twice - bar a facts answer that names no
 * job field, which is asked once more before it is stored as unclassified,
 * and a stored row damaged outside the program (hand-edited, a backup
 * restored part way), which reads as absent: its posting is analysed once
 * more and the answer written into that row (jobAnalysisRepository's
 * `repairUnreadableRow`), not once per request.
 */

/** The analysis prompt's id: the built-in record, edited by an administrator or not. */
export const ANALYSIS_PROMPT_ID = 'analyze-job-description';

/** The job facts prompt's id - the analysis's second call. The owner's id, from when it was the Job Filter's own read. */
export const JOB_FACTS_PROMPT_ID = 'filter-google-sheet-job';

/** A posting shorter than this, with nothing stored for it, is not analysed. */
export const JOB_ANALYSIS_MIN_LENGTH = 50;

/**
 * A Google Sheet row's own analysis, as the server read it from the row's
 * protected Analysis cell - never from a request body: the stored analysis
 * the cell names (`analysisId`, read off the cell's start, which survives the
 * cell being cut at Google's limit).
 *
 * Only an id, on purpose. The cell's content was once registered as the
 * posting's analysis when the store had none - and so a cell nobody can tell
 * from the program's (a formula spilled into the column from an unprotected
 * one, a row pasted from another install's sheet) became that posting's only
 * analysis, for ever, under the one-analysis rule. Now nothing in a sheet
 * reaches the store: a cell is worth exactly the stored analysis it names,
 * when that one is the posting's.
 */
export type SheetRowAnalysis = {
  analysisId?: string;
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
 * different words finds it too - unless `readOnly` (a preview a GET serves,
 * which writes nothing). Store only: never a model call.
 */
export function findStoredAnalysis(
  input: { jd?: string; link?: string },
  options: { readOnly?: boolean } = {}
): StoredJobAnalysis | null {
  const keys = postingKeys(input);
  if (keys.link) {
    const byLink = findJobAnalysisByLinkKey(keys.link);
    if (byLink) return byLink;
  }
  if (keys.hash) {
    const byText = findJobAnalysisByContentHash(keys.hash);
    if (byText) {
      if (keys.link && !byText.linkKey && !options.readOnly) attachLinkKey(byText.id, keys.link, (input.link ?? '').trim());
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
 * Whether a stored analysis is the one of THIS posting, by link or by text -
 * or by the copy of its text cut at a sheet cell's limit, which a pushed row
 * with no link is known by (analysisColumns.ts's `isAnalysisOfPosting`).
 * A client may name any analysis it was given, and a sheet row's Analysis
 * cell may name one written for the posting that sat in the row before; only
 * one that matches the posting being built for is used for it, or written
 * back into its row.
 */
export function analysisMatchesPosting(stored: StoredJobAnalysis, input: { jd?: string; link?: string }): boolean {
  return isAnalysisOfPosting(stored, postingKeys(input));
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

  // 0. The sheet row's own analysis: the stored one its cell names.
  if (input.sheetRow) {
    const fromSheet = useSheetAnalysis(input.sheetRow, { jd, link });
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
 * Step 0: the stored analysis a sheet row's Analysis cell names - for THIS
 * posting, by link or by text - else null, and the store (step 1) answers.
 *
 * A row's posting can be replaced, and rows sorted under the protected
 * columns, so a cell can name the analysis of the posting that sat in the
 * row before: not this one's, and not used. And a cell can name an analysis
 * this store never held - another install's, a backup's, or text that only
 * looks like the program's: it is ignored, logged, and NEVER registered; the
 * posting is found in the store or analysed once, and the write-back puts
 * the real cell in.
 */
function useSheetAnalysis(sheetRow: SheetRowAnalysis, posting: { jd: string; link: string }): StoredJobAnalysis | null {
  const where = sheetRow.row ? `sheet row ${sheetRow.row}` : 'a sheet row';
  if (!sheetRow.analysisId) return null;
  const named = getJobAnalysisById(sheetRow.analysisId);
  if (!named) {
    console.warn(
      `[analysis] ${where}'s Analysis cell names an analysis this store does not have (${sheetRow.analysisId}); ` +
        'it is ignored - nothing in a sheet is stored as an analysis - and the store answers for the posting instead.'
    );
    return null;
  }
  if (analysisMatchesPosting(named, posting)) return named;
  console.warn(`[analysis] ${where} holds the analysis of another posting (${named.id}); it is not used.`);
  return null;
}

/**
 * SHA-256 of what produced an analysis - an audit, never part of its
 * identity: the two prompt texts that ran and the code's own job field text,
 * so a change of any one of them is told apart. '' when a record could not
 * be read.
 */
function promptHash(analysisPrompt: string | undefined, factsPrompt: string | undefined): string {
  if (!analysisPrompt || !factsPrompt) return '';
  return createHash('sha256')
    .update([analysisPrompt, factsPrompt, JOB_FIELD_PREAMBLE, JOB_FIELD_REMINDER].join('\0'), 'utf8')
    .digest('hex');
}

/**
 * The job facts call: the Job Facts (Filter) prompt, with the job field list
 * before it and the one-line reminder after the posting (jobFieldLine.ts) -
 * code-owned text, so no edit of the prompt can drop the job field. An answer
 * that names no job field at all (as opposed to "unclassified") is asked once
 * more, then stored as unclassified with a warning naming the posting: the
 * job field is what files a job in the lake for ever.
 */
async function askJobFacts(
  input: { jd: string; link: string; hash: string },
  choice: AiChoice,
  signal: AbortSignal
): Promise<JobFactsAnswer> {
  const ask = async (): Promise<JobFactsAnswer> =>
    parseJobFacts(
      await createPromptCompletion({
        promptId: JOB_FACTS_PROMPT_ID,
        callSite: JOB_FACTS_PROMPT_ID,
        promptValues: buildJobFactsPromptValues(input.jd, input.link),
        systemPreamble: JOB_FIELD_PREAMBLE,
        appendToUserBody: JOB_FIELD_REMINDER,
        fallbackProvider: choice.provider,
        fallbackModelName: choice.modelName,
        maxTokens: 1000,
        temperature: 0,
        responseFormat: 'json',
        useExactPromptId: true,
        runChoiceWins: true,
        signal,
      })
    );
  const first = await ask();
  if (first.jobField !== null) return first;
  if (signal.aborted) throw cancelled(signal);
  const second = await ask();
  if (second.jobField !== null) return second;
  console.warn(
    `[analysis] The job facts answer for posting ${input.hash} named no job field, asked twice; it is stored as ` +
      'unclassified, which keeps it out of the Job Data Lake.'
  );
  return second;
}

/**
 * The two model calls, and the row they leave.
 *
 * On the analysis model whatever either prompt record names
 * (`runChoiceWins`): the setting under Admin -> Settings is the one place
 * that decides which model reads postings, so every posting's job field
 * comes from one model. In parallel, so the facts call adds no wait to the
 * analysis a build is waiting on; and either failing aborts the other - one
 * analysis is both answers or nothing, and nothing is stored. The shared
 * `signal` (the last waiter leaving, see `waitFor`) stops both.
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
  // The records that run, for the audit hash: an administrator's edit that
  // needs updating never does (promptService `usableAtRuntime`).
  const [analysisRecord, factsRecord] = await Promise.all([
    resolvePromptByExactId(ANALYSIS_PROMPT_ID).catch(() => null),
    resolvePromptByExactId(JOB_FACTS_PROMPT_ID).catch(() => null),
  ]);

  const startedAt = process.hrtime.bigint();
  console.log(`[analysis] Analysing a new posting (${describeAiChoice(choice)})`);
  const both = new AbortController();
  const stopBoth = () => both.abort(signal.reason);
  if (signal.aborted) stopBoth();
  else signal.addEventListener('abort', stopBoth, { once: true });
  // The first failure aborts the other call: its answer would be thrown away.
  const settle = <T>(work: Promise<T>): Promise<T> =>
    work.catch((error: unknown) => {
      if (!both.signal.aborted) both.abort(error);
      throw error;
    });
  let keywords: JobAnalysisKeywords;
  let facts: JobFactsAnswer;
  try {
    [keywords, facts] = await Promise.all([
      settle(
        createPromptCompletion({
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
          signal: both.signal,
        }).then((content) => parseJobAnalysisKeywords(content, input.jd))
      ),
      settle(askJobFacts({ jd: input.jd, link: input.link, hash: input.keys.hash }, choice, both.signal)),
    ]);
  } finally {
    signal.removeEventListener('abort', stopBoth);
  }
  const analysis = composeJobAnalysis(keywords, facts);
  const seconds = (Number(process.hrtime.bigint() - startedAt) / 1_000_000_000).toFixed(2);

  const { row, inserted } = insertJobAnalysisIfAbsent({
    contentHash: input.keys.hash,
    linkKey: input.keys.link,
    jobLink: input.link,
    analysis,
    modelId: model.id,
    promptHash: promptHash(analysisRecord?.content, factsRecord?.content),
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
