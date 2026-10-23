import path from 'path';
import { Router, type Request, type Response } from 'express';
import {
  describeCharge,
  getStatus,
  isExempt,
  releaseReservation,
  reserveCredits,
} from '../services/credits';
import { isAdmin, requireAdmin, requireUser } from '../middleware/auth';
import { resolveAiChoice, type AiChoice, type AiPreferences } from '../config/aiPreferences';
import { getAppSettings, getBuildModePrices } from '../config/aiModelConfig';
import { BUILD_MODE_LABELS, type BuildMode } from '../config/buildModes';
import type { Viewer } from '../database/resumeRepository';
import {
  assertSuitableTakesNoContent,
  checkPreview,
  planRun,
  priceRun,
  quoteRun,
  readRunRequest,
  resolveRunTarget,
  type PlannedItem,
  type RunRequest,
  type RunUnit,
} from '../services/resumeChoice';
import { resumeLabelOf } from '../services/profileRules';
import {
  genericMessage,
  isPublicError,
  PublicError,
  publicStoredError,
  sendPublicError,
} from '../middleware/publicError';
import {
  batchKind,
  getGenerationQueue,
  getTabLeases,
  IMMEDIATE_BATCH_KIND,
  isImmediateBatch,
  isOrderBatch,
  laneFor,
  newBatchId,
  ORDER_BATCH_KIND,
  persistNewBatch,
  RESUME_TASK_KIND,
  taskCostMilli,
  type Batch,
  type BatchKind,
  type BatchSnapshot,
  type ResumeJob,
  type ResumeTaskPayload,
  type QueueName,
  type ResumeTaskResult,
  type TaskDescriptor,
} from '../services/queue';
import {
  createOrder,
  failOrder,
  findOrderForBatch,
  findOrderItemByTask,
  findOrderItemForBatch,
  isOrderFileKind,
  type Order,
  type OrderFileKind,
  type OrderItem,
} from '../database/orderRepository';
import { filesFromTaskResult } from '../services/orders/orderTracking';
import { orderRetentionDays } from '../services/orders/retention';
import { sanitizeFileNameStem } from '../utils/outputStorage';
import { getGeneratedFilePath } from '../utils/generatedPath';
import { planRunOutput } from '../services/outputPath';
import type { UserAccount } from '../types/account';
import type { TailoredContent } from '../types/template';
import { openBatchStream } from './batchStream';
import { loadAnalysis } from '../services/jobAnalysis/gate';
import { resolveAnalysesAtSubmit, type SheetSource } from '../services/jobAnalysis/submit';
import { resolveAddressableSheet } from '../services/sheets/accountSheet';

/**
 * Submitting work to the generation queue.
 *
 * Its own router rather than more of `routes/resume.ts`, which is 1250 lines and
 * shares nothing with this: every route in there performs work and answers with
 * it, and every route in here talks about work that is happening elsewhere.
 *
 * The shape of the contract is the point. `POST` returns a batch id as soon as
 * the tasks are queued, before any of them has run. Progress is read back
 * separately, so a reload can pick the work back up.
 *
 * A run is one of two kinds (`mode`). An ORDER runs on the server whether or
 * not anybody is watching and is followed on /orders. GENERATE IMMEDIATELY is
 * tied to the tab that started it (owner decision B4): the tab's progress
 * stream holds a lease on the run, and when the tab is gone for longer than
 * IMMEDIATE_TAB_GRACE_MS the run is cancelled and what had not started is
 * refunded (services/queue/tabLease.ts). Both are filed in the run's own folder
 * under the output prefix, with an `orders` row - an immediate run's is never
 * listed - so every queued resume is downloaded through an owner-checked route
 * and refundable by its order item.
 */

const router = Router();
/**
 * Everything below needs a signed-in account.
 *
 * At the router rather than per route, so a route added later is protected by
 * default. Before v2 these were open, which was defensible with one user on one
 * machine and is not once resumes belong to people.
 */
router.use(requireUser);


type SubmitBody = {
  label?: string;
  templateId?: string;
  format?: 'pdf' | 'docx' | 'both';
  includeCoverLetterDocx?: boolean;
  model?: string;
  /**
   * The ONE profile (person) the run builds for. A run builds exactly one on
   * every subscription: `profileIds` (any shape) and `resumeIds` are refused
   * 400 `one-profile-per-run` (services/resumeChoice.ts `readRunRequest`).
   */
  profileId?: string;
  /**
   * `suitable` (Choose Suitable Resume), `partial` (Partial Tailor) or `full`
   * (Fully Tailor). Absent: the administrator's default builder mode in effect.
   */
  buildMode?: BuildMode;
  /** The resume a preview showed, when the page finalises a preview: the run is refused (409 `preview-changed`) if it would build another. */
  previewedResumeId?: string;
  jobs?: Array<{
    companyName?: string;
    role?: string;
    jobDescription?: string;
    /** The posting's link: with its text, what identifies it for the one-analysis rule. */
    jobLink?: string;
    /**
     * A stored analysis the page holds for this posting (`/resume/analyze`
     * answered it). Must exist. An analysis OBJECT sent as `jobAnalysis` is
     * not read: the server only uses analyses it stored itself.
     */
    analysisId?: string;
    sourceRowNumber?: number;
  }>;
  /**
   * The app sheet the jobs were read from, for a sheet run: the account's own
   * spreadsheet (`spreadsheetId` may name it, and nothing else - any other id
   * is 404), and the tab. Each job's `sourceRowNumber` is its
   * row. The server reads the rows' analysis cells itself - one batched read
   * at submission - and a row already analysed skips analysis (sheet first);
   * a row analysed now has its cells written back, once.
   */
  sheet?: { spreadsheetId?: unknown; tabName?: unknown };
  /** Tailored content a preview already produced, keyed by resume id. Partial and Fully only. */
  tailoredContentByResumeId?: Record<string, unknown>;
  /**
   * Each preview's token, keyed by resume id: which build mode wrote that
   * resume's content, so it is priced - and quoted - as that mode's work. Content
   * without a token valid for this account, resume and mode costs the dearest
   * mode's price.
   */
  previewTokenByResumeId?: Record<string, unknown>;
  /**
   * `immediate` (Generate Immediately, the default) or `order` (the Order
   * button). An order runs whether or not anybody is watching, is listed on
   * /orders and answers with an order number; an immediate run is leased to
   * the tab that started it (`tabId`) and goes ahead of orders in its lane.
   * Absent is `immediate`. See `readRunKind`.
   */
  mode?: unknown;
  /**
   * The starting tab's own id, for `immediate`: the tab whose stream
   * (`?tab=`) holds the run's lease and whose page may release it. A random
   * id the page keeps for the life of the tab (sessionStorage), never shown
   * back to anybody. Optional - a run without one is held by its owner's
   * stream without a `tab` - and ignored for an order.
   */
  tabId?: unknown;
};

export type NormalizedJob = ResumeJob;

/** A submission refused for what it asked for - always the caller's to fix, so public. */
export class SubmitError extends PublicError {
  constructor(message: string) {
    super(message, { status: 400 });
    this.name = 'SubmitError';
  }
}

/**
 * Which kind of run a submission asks for.
 *
 * `mode` decides when it is there; it must be `immediate` or `order`, and
 * anything else is refused rather than guessed - a typo that silently placed a
 * three-hundred-row order as a run tied to one tab would stop the moment the
 * tab closed. Without `mode` it is Generate Immediately, and nothing else in
 * the body is read for it: an older script's `asOrder: true` now places an
 * immediate run, which the tab lease stops (and refunds) when nothing reads
 * its stream - such a script sends `mode: 'order'`.
 */
export function readRunKind(body: Pick<SubmitBody, 'mode'>): BatchKind {
  if (body.mode !== undefined && body.mode !== null) {
    if (body.mode === ORDER_BATCH_KIND || body.mode === IMMEDIATE_BATCH_KIND) return body.mode;
    throw new SubmitError('mode must be "immediate" or "order".');
  }
  return IMMEDIATE_BATCH_KIND;
}

/** What a tab id may look like: what a page mints (a UUID, say), and nothing that needs escaping anywhere. */
const TAB_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** The submitting tab's id, or undefined when none was sent. Junk is refused, not dropped. */
export function readTabId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && TAB_ID.test(value.trim())) return value.trim();
  throw new SubmitError('tabId must be 1 to 100 letters, digits, "-" or "_".');
}

function readAiOverrides(body: Pick<SubmitBody, 'model'>): AiPreferences {
  return {
    ...(body.model ? { modelId: body.model } : {}),
  };
}

/**
 * The build mode a run is in: the one the request names, else the
 * administrator's default builder mode in effect (`defaultBuildMode`). Choose
 * Suitable Resume takes no previewed content, whichever way the mode was
 * decided (400 `suitable-takes-no-content`).
 */
async function resolveBuildMode(request: RunRequest): Promise<BuildMode> {
  const mode = request.buildMode ?? (await getAppSettings()).defaultBuildMode;
  assertSuitableTakesNoContent(mode, request);
  return mode;
}

/**
 * Reads the jobs out of a submission, refusing only what could never work.
 *
 * A missing company name is refused here, before anything is queued, because it
 * is wrong for every resume and there is nothing to be gained from discovering
 * it thirty times. A missing ROLE is not refused: the job analysis is what names
 * the role when a sheet row does not (`resolveTaskRole`), and that analysis has
 * not run yet; a role still empty then files under an `unknown` `{{role}}`
 * folder rather than failing a resume over a folder name.
 */
export function normalizeJobs(body: SubmitBody): NormalizedJob[] {
  const jobs = Array.isArray(body.jobs) ? body.jobs : [];
  if (jobs.length === 0) throw new SubmitError('At least one job is required');

  return jobs.map((job, index) => {
    const companyName = typeof job.companyName === 'string' ? job.companyName.trim() : '';
    const jobDescription = typeof job.jobDescription === 'string' ? job.jobDescription.trim() : '';
    const role = typeof job.role === 'string' ? job.role.trim() : '';

    if (!companyName) {
      throw new SubmitError(`Job ${index + 1} is missing a company name`);
    }

    const jobLink = typeof job.jobLink === 'string' ? job.jobLink.trim() : '';
    const analysisId = typeof job.analysisId === 'string' ? job.analysisId.trim() : '';
    if (analysisId && !loadAnalysis(analysisId)) {
      throw new SubmitError(`Job ${index + 1} (${companyName}) names a job analysis that was not found.`);
    }

    // `jobAnalysis`, an analysis object a page used to send, is not read:
    // the server uses only analyses it stored, by id.
    return {
      companyName,
      role,
      jobDescription,
      ...(jobLink ? { jobLink } : {}),
      ...(analysisId ? { analysisId } : {}),
      ...(typeof job.sourceRowNumber === 'number'
        ? { sourceRowNumber: job.sourceRowNumber }
        : {}),
    };
  });
}

/**
 * The sheet a run's jobs came from, when the submission names one: checked
 * like every route that takes a sheet - the account's own, and anything else
 * is 404, an administrator's included - because analysis cells are about to
 * be read from it and written into it.
 *
 * A sheet that is not set up on the server, or cannot be resolved for any
 * reason but "not yours", leaves the run without sheet-first: the jobs are
 * analysed from the store or by the gate exactly as manual ones are, and
 * nothing is written back. The rows themselves came from the page.
 */
async function resolveRunSheet(account: UserAccount | undefined, sheet: SubmitBody['sheet']): Promise<SheetSource | null> {
  if (!account || !sheet || typeof sheet !== 'object') return null;
  const tabName = typeof sheet.tabName === 'string' ? sheet.tabName.trim() : '';
  if (!tabName) throw new SubmitError('sheet.tabName is required for a sheet run.');
  try {
    const spreadsheetId = await resolveAddressableSheet(account, sheet.spreadsheetId);
    return { spreadsheetId, tabName };
  } catch (error) {
    if (isPublicError(error) && (error as PublicError).status === 404) throw error;
    console.warn('[queue] The run names a sheet that could not be resolved; its rows are analysed without it.', error);
    return null;
  }
}

/**
 * Which queue a task belongs in.
 *
 * The resume's own model choice decides, per resume - a batch of resumes that
 * disagree runs each on what it was set to, rather than on whichever resume
 * happened to come first.
 */
export function routeFor(choice: { provider: string }): { queue: QueueName } {
  // The POOL of the model's type (owner decision P4): the queue places each
  // task with whichever provider of that type has the most room, each provider
  // being a lane of its own with its own semaphore and limit. The Claude pool
  // is also the pool of last resort: a provider id this build has no seat for
  // - a retired one on a choice stored before the upgrade - lands there, and
  // the restore resolves such a choice again before it runs. The same rule
  // the restore places by.
  return { queue: laneFor(choice.provider) };
}

/**
 * Builds the task list for a submission.
 *
 * Exported so it can be tested without a server: this is where jobs and resumes
 * become the cross-product that goes in the queue, and getting the count or the
 * order wrong is invisible in the response.
 */
export type BuildTaskOptions = {
  /**
   * Whether the submitter is an administrator, which decides the forms the
   * request's `model` may take (see ModelRequestOptions) and that the price of
   * previewed content is not floored for them. Absent is not one.
   */
  admin?: boolean;
  /** The submitter's account id, which a preview token must have been issued to. */
  userId?: string;
  /** The run's build mode: every task of it builds in this mode. */
  mode: BuildMode;
  /** What each mode costs per resume, in thousandths of a dollar (the settings read at submit). */
  prices: Record<BuildMode, number>;
  /** The profile the run builds for: its name is recorded on every task. */
  unit: Pick<RunUnit, 'profileLabel'>;
  /** The previewed content and tokens the request carried, by resume id (Partial and Fully only). */
  supplied?: Pick<RunRequest, 'suppliedContent' | 'previewTokens'>;
};

/**
 * The model each planned resume runs on.
 *
 * Resolved once per DISTINCT resume rather than once per task: a thirty-job
 * run that chooses the same three resumes would otherwise read the settings
 * row thirty times to get the same answers. The request's `model` wins; else
 * the resume's own choice; else the app default. The model never changes what
 * a resume costs (prices are per build mode), only where it runs.
 */
async function resolveResumeChoices(
  body: Pick<SubmitBody, 'model'>,
  plan: readonly PlannedItem[],
  admin: boolean
): Promise<Map<string, AiChoice>> {
  const overrides = readAiOverrides(body);
  const choices = new Map<string, AiChoice>();
  for (const item of plan) {
    if (choices.has(item.resume.id)) continue;
    choices.set(item.resume.id, await resolveAiChoice(overrides, item.resume, { admin }));
  }
  return choices;
}

export async function buildTasks(
  body: SubmitBody,
  jobs: NormalizedJob[],
  plan: PlannedItem[],
  batchId: string,
  options: BuildTaskOptions
): Promise<Array<TaskDescriptor<ResumeTaskResult>>> {
  const format = body.format === 'docx' ? 'docx' : body.format === 'pdf' ? 'pdf' : 'both';
  const includeCoverLetterDocx = body.includeCoverLetterDocx !== false;
  const supplied = options.supplied ?? { suppliedContent: {}, previewTokens: {} };
  const choices = await resolveResumeChoices(body, plan, options.admin === true);
  // Each planned resume's price, fixed now (priceRun: its mode's price, or the
  // dearest mode's for previewed content without a token valid for this mode).
  const { costs } = priceRun({
    plan,
    mode: options.mode,
    prices: options.prices,
    suppliedContent: supplied.suppliedContent,
    previewTokens: supplied.previewTokens,
    userId: options.userId ?? '',
    admin: options.admin === true,
  });

  const descriptors: Array<TaskDescriptor<ResumeTaskResult>> = [];
  // One planned resume per job, in job order, so the queue order reads down the
  // sheet the way the person who imported it expects.
  for (const [index, planned] of plan.entries()) {
    const jobIndex = planned.jobIndex;
    const job = jobs[jobIndex];
    const resume = planned.resume;
    const choice = choices.get(resume.id)!;
    const content = Object.prototype.hasOwnProperty.call(supplied.suppliedContent, resume.id)
      ? (supplied.suppliedContent[resume.id] as TailoredContent)
      : undefined;
    descriptors.push({
      queue: routeFor(choice).queue,
      label: {
        resumeId: resume.id,
        resumeName: resume.name,
        companyName: job.companyName,
        role: job.role,
        ...(typeof job.sourceRowNumber === 'number'
          ? { sourceRowNumber: job.sourceRowNumber }
          : {}),
        // What the run chose and why, recorded at submit and never chosen
        // again (a restored task builds the resume its payload names).
        resumeLabel: resumeLabelOf(resume),
        profileLabel: options.unit.profileLabel,
        match: planned.match,
      },
      kind: RESUME_TASK_KIND,
      // The RESUME ID and the JOB INDEX, not the resume and the job. Both
      // are looked up when the task runs, so a task can be written to a
      // database and read back after a restart - and so thirty tasks on one
      // posting do not carry thirty copies of it.
      payload: {
        // Correct from the start now that the route mints the id. It used to
        // be written blank here and patched up after `submit` returned.
        batchId,
        resumeId: resume.id,
        jobIndex,
        templateId: body.templateId,
        format,
        includeCoverLetterDocx,
        choice,
        // The run's mode, snapshotted: a restored task builds in it and never
        // asks the settings again (absent on a task queued before v4.2, which
        // builds Partial).
        buildMode: options.mode,
        // What this resume is charged, in thousandths of a dollar, fixed
        // now: the reservation is the sum of these, and a failure refunds
        // exactly its own.
        costMilli: costs[index],
        // Content a preview produced is attached only to its own resume.
        ...(content ? { tailoredContent: content } : {}),
        // The job's ONE analysis, the same on every resume's task, when
        // its posting already had one at submission (resolveAnalysesAtSubmit).
        ...(job.analysisId ? { analysisId: job.analysisId } : {}),
      } satisfies ResumeTaskPayload,
    });
  }
  return descriptors;
}

/**
 * What a list of tasks costs, in thousandths of a dollar, and the line the
 * account's credit history shows for it - by the run's build mode, so the
 * line reads as what it was charged: "3 resumes: 3 x Partial Tailor @ $0.02 =
 * $0.06".
 *
 * An integer sum of integer prices: seven resumes at $0.023 are exactly 161
 * thousandths, every time - not a float sum that adds up only on lucky inputs.
 */
export function chargeFor(
  descriptors: Array<TaskDescriptor<ResumeTaskResult>>,
  mode: BuildMode
): { costMilli: number; label: string } {
  const units = descriptors.map((descriptor) => {
    const payload = descriptor.payload as ResumeTaskPayload;
    // Read the way the refund hook reads it, so what is charged and what a
    // failure gives back can never be worked out two different ways.
    return { label: BUILD_MODE_LABELS[mode], costMilli: taskCostMilli(payload) };
  });
  return {
    costMilli: units.reduce((sum, unit) => sum + unit.costMilli, 0),
    label: describeCharge(units),
  };
}

/**
 * A stored task failure as this reader may see it.
 *
 * New failures are stored already safe (`publicTaskError`), but a batch the
 * queue restored from before that can still hold a raw one - a seat's stderr,
 * a path - so anybody but an administrator reads it through
 * `publicStoredError`. An administrator reads it as stored.
 */
function readTaskError(error: string, admin: boolean): string {
  return admin ? error : publicStoredError(error, TASK_FAILED);
}

const TASK_FAILED = 'This resume could not be built';

/** The results and failures of a batch, in submitted order. */
function collectOutcome(batchId: string, admin: boolean) {
  const batch = getGenerationQueue().getBatch(batchId);
  if (!batch) return null;

  const results: ResumeTaskResult[] = [];
  const failures: Array<{ resumeId: string; resumeName: string; companyName: string; error: string }> =
    [];

  for (const task of batch.tasks) {
    if (task.state === 'done' && task.value) {
      results.push(task.value as ResumeTaskResult);
    } else if (task.state === 'failed' || task.state === 'cancelled') {
      failures.push({
        resumeId: task.label.resumeId,
        resumeName: task.label.resumeName,
        companyName: task.label.companyName,
        error: task.error ? readTaskError(task.error, admin) : genericMessage(TASK_FAILED),
      });
    }
  }

  return {
    results,
    failures,
    failedCompanies: [...new Set(failures.map((failure) => failure.companyName))],
    tailored: results.some((result) => result.tailored),
  };
}

/**
 * A snapshot as a page reads it: the queue's own, plus what a page needs to
 * follow a run - its `kind` (`immediate`, `order`, or null for one queued
 * before kinds existed) and, on each finished task, the `files` it produced
 * by kind (`resume-pdf`, `resume-docx`, `cover-letter-pdf`,
 * `cover-letter-docx`): what a Generate Immediately page downloads, one
 * `GET /batches/:id/tasks/:taskId/:kind` each. Kinds, never paths.
 */
type PageSnapshot = BatchSnapshot & {
  kind: BatchKind | null;
  tasks: Array<BatchSnapshot['tasks'][number] & { files?: OrderFileKind[] }>;
};

function decorate(snapshot: BatchSnapshot): PageSnapshot {
  const batch = getGenerationQueue().getBatch(snapshot.batchId);
  const values = new Map((batch?.tasks ?? []).map((task) => [task.id, task.value]));
  return {
    ...snapshot,
    kind: batch ? batchKind(batch) : null,
    tasks: snapshot.tasks.map((task) =>
      task.state === 'done'
        ? { ...task, files: filesFromTaskResult(values.get(task.id)).map((file) => file.kind) }
        : task
    ),
  };
}

/**
 * A snapshot as this reader may see it. Which provider a task is running on or
 * ran on (`runningOn`, `ranOn`) is an administrator's business, and so is a
 * raw stored error.
 */
function readerSnapshot(snapshot: BatchSnapshot, admin: boolean): PageSnapshot {
  const decorated = decorate(snapshot);
  if (admin) return decorated;
  return {
    ...decorated,
    tasks: decorated.tasks.map(({ runningOn: _lane, ranOn: _ranOn, ...task }) =>
      task.error ? { ...task, error: readTaskError(task.error, false) } : task
    ),
  };
}

function fullSnapshot(snapshot: BatchSnapshot, admin: boolean) {
  return { ...readerSnapshot(snapshot, admin), ...(collectOutcome(snapshot.batchId, admin) ?? {}) };
}

/**
 * Queue a batch and return at once.
 *
 * The response carries the id and the counts and nothing else - the work has not
 * started. Everything about how it goes is read back through the routes below.
 */
router.post('/batches', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as SubmitBody;
    const kind = readRunKind(body);
    const tabId = kind === IMMEDIATE_BATCH_KIND ? readTabId(body.tabId) : undefined;
    // A run builds exactly ONE profile, on every subscription: `profileIds`,
    // `resumeIds` or no `profileId` is a 400, another account's profile a 404,
    // a profile with no enabled resume a 400. Before anything is priced,
    // reserved or asked of a model, so a refusal costs nothing. Asked BEFORE
    // the jobs are read, as /quote asks it: a request naming the wrong people
    // is told so, not that it has no jobs.
    const request = readRunRequest(body);
    const jobs = normalizeJobs(body);
    const admin = isAdmin(req);
    const mode = await resolveBuildMode(request);
    // The early read is for its refusals (an unknown or foreign profile, one
    // with nothing to build) ahead of the Google read below; the profile the
    // run is planned against is read again after it (`unit`, below).
    await resolveRunTarget(req.user ?? null, request.profileId);
    const startedAt = Date.now();

    // ONE analysis per job, resolved before the choice is made, so every
    // job's task carries its `analysisId` and the matcher reads the same
    // analysis the tailoring will: the sheet row's own (one batched read of
    // the rows), the one the page named, or the posting's stored one. No model
    // is asked here - a job with none is analysed by its task, through the
    // same gate, and is matched on its text and title meanwhile.
    const sheet = await resolveRunSheet(req.user, body.sheet);
    const analyses = await resolveAnalysesAtSubmit(jobs, { sheet, requestedBy: req.user?.id ?? null });
    if (sheet) {
      console.log(
        `[queue] Sheet run on "${sheet.tabName}": ${analyses.fromSheet} job(s) analysed in the sheet, ` +
          `${analyses.resolved - analyses.fromSheet} from the store, ${jobs.length - analyses.resolved} to analyse.`
      );
    }

    // The profile and its enabled resumes as they are NOW, not as they were
    // before the sheet and the analyses were awaited (seconds, on a big sheet
    // run): a resume disabled or deleted in that window is not chosen, and
    // Fully Tailor builds the default in effect at the moment of the plan.
    const unit = await resolveRunTarget(req.user ?? null, request.profileId);

    // Minted here rather than inside `submit`, because the credits have to be
    // reserved against this batch BEFORE any task can start - and `submit`
    // dispatches immediately, so there is no window afterwards in which to do it.
    const batchId = newBatchId();

    // The choice, made once and fixed: which resume of the profile each job is
    // built from (the matcher's pick, or the default for Fully Tailor), and why.
    // Then the preview check - a run that would build something other than what
    // the page previewed is refused (409 `preview-changed`) before a thing is
    // reserved or charged.
    const plan = await planRun(
      jobs.map((job) => ({ text: job.jobDescription, title: job.role, analysisId: job.analysisId })),
      unit,
      mode
    );
    checkPreview(plan, request.previewedResumeId, Object.keys(request.suppliedContent), unit.profileLabel);

    // What each mode costs, read now (THROWS when the settings cannot be read:
    // a run is never priced at a guess).
    const prices = await getBuildModePrices();
    const descriptors = await buildTasks(body, jobs, plan, batchId, {
      admin,
      userId: req.user?.id,
      mode,
      prices,
      unit,
      supplied: request,
    });
    // Where the run files its resumes - the output folder, the prefix and the
    // submitter's own folder path in effect NOW, and today - worked out once,
    // so the whole run lands in one folder whatever is edited while it runs.
    const output = await planRunOutput(req.user!);
    const charge = chargeFor(descriptors, mode);

    /**
     * The charge, before the first model call.
     *
     * Placed here on purpose: after `normalizeJobs`, the run request's checks
     * (one profile, a mode, a profile with a resume to build, the preview
     * check - so a 400, 404 or 409 never costs anything), after `buildTasks`
     * (which only reads settings - no model call, no file), and before `submit`.
     *
     * Per handler rather than as router middleware, and that is the guarantee
     * that keeps previews free: this router also serves reads, and a blanket
     * charge would catch anything added later by accident.
     *
     * The SUM of what each planned resume costs in the run's build mode (the
     * mode's price, or the dearest mode's for previewed content without a
     * token valid for this mode), and a 402 names the whole amount.
     */
    reserveCredits(req.user!, charge.costMilli, {
      kind: 'batch',
      id: batchId,
      label: charge.label,
    });

    const queue = getGenerationQueue();
    let batch;
    let order: Order | null = null;
    try {
      /**
       * The order exists BEFORE the first task can finish.
       *
       * `submit` dispatches immediately, so a resume can be built and reported
       * within milliseconds. Creating the order afterwards would race that: the
       * hook would look for an item row, find none, and the first few resumes
       * of every run would go silently unrecorded.
       *
       * Inside the try, not above it, because the credits have already been
       * charged by this point - a throw out here without the release below
       * leaves the account short for a run that never started.
       *
       * Every run gets an order row - an immediate one too, of kind
       * `immediate`, which /orders never lists. What the row buys a run that
       * nobody ordered: a number, which its prefix folder names - so its
       * folder is its own, recorded as the row's `output_root`, and every
       * file in it is served only to its owner - a refund by order item, and
       * the retention sweep deleting its files IMMEDIATE_FILE_RETENTION_MS
       * after the run ends (owner decision M4).
       * An immediate row's `expires_at` is not what deletes its files - see
       * `listFinishedImmediateRuns` - so it is stamped as placed.
       */
      order = createOrder(
            {
              userId: req.user!.id,
              batchId,
              kind,
              label:
                typeof body.label === 'string' && body.label.trim()
                  ? body.label.trim()
                  : `${jobs.length} job(s) for ${unit.profileLabel}, ${BUILD_MODE_LABELS[mode]}`,
              retentionDays: kind === ORDER_BATCH_KIND ? orderRetentionDays() : 0,
              outputRootFor: output.rootFor,
            },
            descriptors.map((descriptor, seq) => ({
              seq,
              resumeId: descriptor.label.resumeId,
              resumeName: descriptor.label.resumeName,
              companyName: descriptor.label.companyName,
              role: descriptor.label.role,
              ...(typeof descriptor.label.sourceRowNumber === 'number'
                ? { sourceRowNumber: descriptor.label.sourceRowNumber }
                : {}),
              // Kept on the item because the task is not: a refund request
              // for this resume can come long after the batch is evicted.
              costMilli: taskCostMilli(descriptor.payload),
              // What the run chose for this job and why: the chosen resume's
              // label, the person's name, and the matcher's explanation.
              ...(descriptor.label.resumeLabel ? { resumeLabel: descriptor.label.resumeLabel } : {}),
              ...(descriptor.label.profileLabel ? { profileLabel: descriptor.label.profileLabel } : {}),
              ...(descriptor.label.match ? { match: descriptor.label.match } : {}),
            }))
          );

      /**
       * The run's place reaches the tasks here, after the order's number has
       * been issued and before a single task has been dispatched.
       *
       * The number cannot be known when `buildTasks` runs - it is allocated by
       * the insert above, and the prefix holds it - and it cannot be applied
       * after `submit`, which dispatches on the spot. This window is the only
       * place it fits, and the payloads are ours to finish until they are
       * handed over.
       */
      const place = output.placeFor(order.number);
      for (const descriptor of descriptors) {
        (descriptor.payload as ResumeTaskPayload).output = place;
      }

      batch = queue.submit(descriptors, {
        id: batchId,
        // Written by `persistNewBatch` below, in one transaction, rather than
        // row by row here and then again there.
        deferPersist: true,
        label: typeof body.label === 'string' && body.label.trim() ? body.label.trim() : 'Generation',
        jobCount: jobs.length,
        // The jobs live on the BATCH, once. Each task refers to its own by index,
        // so thirty tasks on one posting do not carry thirty copies of it.
        // The kind says how it is followed: an order on /orders (the builder's
        // active list leaves it out, see GET /batches), an immediate run by
        // the tab named here, which holds its lease.
        shared: { jobs, ownerId: req.user!.id, kind, buildMode: mode, ...(tabId ? { tabId } : {}) },
        // Somebody is sitting in front of an immediate run; nobody is waiting
        // on an order. On the same seat, the first goes first.
        urgent: kind === IMMEDIATE_BATCH_KIND,
      });
      // Written as one transaction rather than row by row: a batch that half
      // landed because the process died mid-loop would come back with tasks whose
      // batch does not exist.
      persistNewBatch(batch as Batch);
    } catch (error) {
      // Charged for a run that never started. Give it all back rather than
      // leaving the account short for a failure that was ours.
      releaseReservation(batchId, 'The batch could not be queued.');
      /*
       * Only when the work never started.
       *
       * `submit` dispatches on the spot and cannot be taken back, so a throw
       * from `persistNewBatch` - which runs AFTER it - leaves three hundred
       * tasks running. Failing the order there would be a lie that outlives
       * itself: the tasks go on to finish and write their results back, but
       * `settleOrderIfFinished` refuses to move an order out of `failed`, so it
       * would sit at "Failed" for ever over a full set of ready resumes.
       *
       * An order whose batch genuinely never ran is the opposite case, and does
       * need closing - otherwise it waits at `running` with every item queued
       * and nothing left to move them.
       */
      if (order && !batch) failOrder(order.id, 'The order could not be queued.');
      throw error;
    }

    // The lease starts at once, not when the tab first attaches: a tab that
    // never does - it crashed, or lost the network the moment it had the id -
    // must not leave a run building for nobody. Attaching inside the grace
    // stops the timer.
    if (kind === IMMEDIATE_BATCH_KIND) getTabLeases().arm(batch.id);

    console.log(
      `[queue] ${kind === ORDER_BATCH_KIND ? `order ${order!.number}` : 'immediate run'} ${batch.id}: ` +
        `${descriptors.length} resume(s) queued (${jobs.length} job(s) for ${unit.profileLabel}, ` +
        `${BUILD_MODE_LABELS[mode]}; chosen among ${unit.candidates.length} resume(s) in ${Date.now() - startedAt} ms)`
    );

    res.status(202).json({
      batchId: batch.id,
      kind,
      total: descriptors.length,
      jobCount: jobs.length,
      buildMode: mode,
      // The lanes and how busy they are, for an administrator's eyes only.
      ...(admin ? { queues: queue.stats() } : {}),
      // An order's number is what the receipt shows. An immediate run's row
      // is not the person's business - it is never listed - so it is not named.
      ...(kind === ORDER_BATCH_KIND && order ? { orderId: order.id, orderNumber: order.number } : {}),
    });
  } catch (error) {
    // A refused submission (400), too little credit (402 with `neededMilli`
    // and `balanceMilli`) and a model the request may not use (400) are all
    // public and say so in their own words; anything else is generic, with a ref.
    sendPublicError(req, res, error, 'Failed to queue the batch');
  }
});

/**
 * What a submission WOULD cost, without submitting anything.
 *
 * Takes the body `POST /batches` takes and prices it the way it does
 * (services/resumeChoice.ts `quoteRun`: jobs times the build mode's price, or
 * the dearest mode's for previewed content without a token valid for the
 * mode), so the figure is what that submission would charge. Answers
 * `{ resumes, costMilli, pricePerResumeMilli, balanceMilli, exempt,
 * buildMode }` - thousandths of a dollar - and nothing about which models or
 * seats: the builder shows it as one line beside the generate button ("7
 * resumes x $0.023 = $0.161"), and re-asks whenever the profile, the mode or
 * the jobs change. `pricePerResumeMilli` is the one price every resume in the
 * run costs, or null when they differ (or there is nothing to price).
 *
 * Lenient where the submission is strict, on purpose. The builder asks while
 * the form is still being filled in, and a missing company name or role does
 * not change what anything costs - so jobs are counted, not validated, and no
 * jobs is a quote of nothing rather than an error. The refusals are the
 * submission's own: not exactly one profile (400 `one-profile-per-run`),
 * another account's or unknown profile (404), one with no enabled resume (400),
 * and a request naming a model it may not use (400). `costMilli` is the full
 * amount even for an administrator, who is not charged it: `exempt` says so.
 *
 * Reads only. No reservation, no task, no model call.
 */
router.post('/quote', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as SubmitBody;
    const jobCount = Array.isArray(body.jobs) ? body.jobs.length : 0;
    // The submission's refusals, mirrored, so the cost line never prices a run
    // that would be refused. Asked even with no jobs yet, because they are about
    // WHO the run is for.
    const request = readRunRequest(body);
    const admin = isAdmin(req);
    const mode = await resolveBuildMode(request);
    const unit = await resolveRunTarget(req.user ?? null, request.profileId);
    if (jobCount > 0) {
      // A model the request may not use is refused here as it is at submit.
      await resolveAiChoice(readAiOverrides(body), unit.defaultResume ?? unit.candidates[0], { admin });
    }
    const prices = await getBuildModePrices();
    const { resumes, perResumeMilli, totalMilli } = quoteRun({
      jobCount,
      unit,
      mode,
      prices,
      suppliedContent: request.suppliedContent,
      previewTokens: request.previewTokens,
      ...(request.previewedResumeId ? { previewedResumeId: request.previewedResumeId } : {}),
      userId: req.user!.id,
      admin,
    });
    res.json({
      resumes,
      costMilli: totalMilli,
      pricePerResumeMilli: resumes > 0 ? perResumeMilli : null,
      balanceMilli: getStatus(req.user!).balanceMilli,
      exempt: isExempt(req.user!),
      buildMode: mode,
    });
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to price the run');
  }
});

/**
 * Whether this account may see a batch at all.
 *
 * The owner is recorded on `shared` at submit, which `restore` reads back, so it
 * survives a restart for free. A batch naming no owner is an administrator's
 * to read and nobody else's - the safe direction.
 *
 * This matters more than it looks. A snapshot carries the task labels AND the
 * generated file paths, so an unscoped read here would tell one account what
 * another is applying for, and where its resumes are (the download itself
 * checks whose run the file is, routes/generatedFiles.ts).
 */
function canSeeBatch(viewer: Viewer, batch: { shared: Record<string, unknown> } | undefined): boolean {
  if (!batch) return false;
  if (viewer === null) return true;
  if (viewer.role === 'admin') return true;
  const ownerId = batch.shared.ownerId;
  return typeof ownerId === 'string' && ownerId === viewer.id;
}

/** The batch, or null when it is not this account's to see. */
function visibleBatch(req: Request, batchId: string) {
  const batch = getGenerationQueue().getBatch(batchId);
  return canSeeBatch(req.user ?? null, batch) ? batch : null;
}

/**
 * True for a batch the builder may pick back up: the caller's OWN, and not an
 * order.
 *
 * Own even for an administrator. `canSeeBatch` lets an administrator read any
 * run, which is right for looking one up by id - but the builder reattaches
 * to the first batch in the active list, so an administrator opening Build
 * Resumes was following somebody else's run, locked out of their own page
 * until it finished. And never an order: an order is followed on /orders, and
 * a builder that took it for its own run locked the page for as long as the
 * order took.
 */
function isBuilderRun(viewer: Viewer, batch: { shared: Record<string, unknown> }): boolean {
  return viewer !== null && batch.shared.ownerId === viewer.id && !isOrderBatch(batch);
}

/** A `tab` as a request sends it: the query string's, trimmed, or '' for none. */
function readRequestTab(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Whether a request comes from the tab an immediate run was started in.
 *
 * A run submitted without a `tabId` matches a request without a `tab`, so a
 * page that never sent one still holds its own run - and a page that did must
 * name it, so a second tab of the same account cannot hold (or stop) another
 * tab's run by accident.
 */
function fromRunTab(batch: { shared: Record<string, unknown> }, tab: string): boolean {
  const own = typeof batch.shared.tabId === 'string' ? batch.shared.tabId : '';
  return tab === own;
}

/**
 * Every batch the server still holds that this account may see.
 *
 * `?active=1` is the builder's question - "is a run of mine still going?" -
 * and answers only the caller's own unfinished, non-order batches, whoever
 * the caller is (`isBuilderRun`). `&tab=<tabId>` narrows it to the Generate
 * Immediately runs started from that tab, which is what a reloaded tab
 * reattaches to - never another tab's run, whose downloads are not its own.
 * Without `active`, the list is everything the caller may see, an
 * administrator's included.
 */
router.get('/batches', (req: Request, res: Response) => {
  const queue = getGenerationQueue();
  const activeOnly = req.query.active === '1' || req.query.active === 'true';
  const tab = readRequestTab(req.query.tab);
  const admin = isAdmin(req);
  const viewer = req.user ?? null;
  res.json({
    batches: queue
      .listBatches(activeOnly)
      // Filtered BEFORE the snapshot is built, so another account's work is
      // never even serialized. The page that reloads takes the first batch in
      // the active list and attaches to it, so an unfiltered list would
      // silently point somebody at a stranger's run.
      .filter((batch) => (activeOnly ? isBuilderRun(viewer, batch) : canSeeBatch(viewer, batch)))
      .filter((batch) => !activeOnly || !tab || (isImmediateBatch(batch) && fromRunTab(batch, tab)))
      .map((batch) => queue.snapshot(batch.id))
      .filter((snapshot): snapshot is BatchSnapshot => Boolean(snapshot))
      .map((snapshot) => readerSnapshot(snapshot, admin)),
    ...(admin ? { queues: queue.stats() } : {}),
  });
});

router.get('/batches/:id', (req: Request<{ id: string }>, res: Response) => {
  // 404 rather than 403 for somebody else's batch, matching the resume
  // routes: a 403 would confirm that a batch with that id exists.
  const snapshot = visibleBatch(req, req.params.id)
    ? getGenerationQueue().snapshot(req.params.id)
    : null;
  if (!snapshot) {
    // Named, because the page that asks is usually one that reloaded and is
    // holding an id from before a server restart - and "unknown batch" alone
    // would have it retry for ever.
    res.status(404).json({
      error: 'That batch is no longer on the server.',
      reason: 'restarted-or-expired',
    });
    return;
  }
  res.json(fullSnapshot(snapshot, isAdmin(req)));
});

/**
 * Live progress, as NDJSON.
 *
 * The FIRST line is always a complete snapshot, then one line per task that
 * settles, then a final `done`. That is what makes reconnecting trivially
 * correct: a page that joins late, or rejoins after a reload, never has to
 * reconcile the events it missed.
 *
 * `?tab=<tabId>`: for a Generate Immediately run, the stream of its OWNER
 * from the tab it was started in (the `tabId` it was submitted with; none for
 * a run submitted without one) is what keeps the run alive. While at least one
 * such stream is open the run's lease is held; when the last closes, the
 * IMMEDIATE_TAB_GRACE_MS timer starts, and a run nobody reattaches to inside
 * it is cancelled with what had not started refunded (tabLease.ts). Such a
 * stream is ended by the server every LEASE_READER_LIFETIME_MS (20 s), and
 * the page attaches again: that renewal, not the connection closing, is how a
 * tab whose network vanished silently is told from one still following. Any
 * other reader - another tab, an administrator, a page following an order -
 * only reads, for as long as it likes.
 */
router.get('/batches/:id/stream', (req: Request<{ id: string }>, res: Response) => {
  const queue = getGenerationQueue();
  const batch = visibleBatch(req, req.params.id);
  const snapshot = batch ? queue.snapshot(req.params.id) : null;
  if (!batch || !snapshot) {
    res.status(404).json({
      error: 'That batch is no longer on the server.',
      reason: 'restarted-or-expired',
    });
    return;
  }

  const admin = isAdmin(req);
  const stream = openBatchStream(res);
  stream.send({ type: 'snapshot', ...fullSnapshot(snapshot, admin) });

  if (snapshot.state !== 'running') {
    stream.send({ type: 'done', ...fullSnapshot(snapshot, admin) });
    stream.end();
    return;
  }

  const unsubscribe = queue.subscribe(req.params.id, (event) => {
    stream.send({ type: event.type, ...fullSnapshot(event.snapshot, admin) });
    if (event.type === 'done') {
      unsubscribe();
      stream.end();
    }
  });

  // The run's own tab holds its lease while this stream is open - for
  // LEASE_READER_LIFETIME_MS at most. Then the hold is counted out and the
  // stream is ended here, without waiting for a `close` that a connection
  // which vanished without a word (a laptop lid, a dead battery) would not
  // send for many minutes; a page that is still there reads an ordinary end
  // and attaches again a second later, holding afresh (tabLease.ts).
  const holdsLease =
    isImmediateBatch(batch) &&
    req.user?.id === batch.shared.ownerId &&
    fromRunTab(batch, readRequestTab(req.query.tab));
  const letGo = holdsLease
    ? getTabLeases().hold(batch.id, () => {
        unsubscribe();
        stream.end();
      })
    : () => {};

  // For an order, or any reader that is not the run's tab, this detaches a
  // listener and NOTHING else - a page that navigates away is not a reason to
  // stop an order. For the run's own tab it also lets go of the lease, which
  // starts the grace rather than stopping anything at once: a dropped
  // connection can come straight back. (A page that is closed, reloaded or
  // left sends /release, which stops the run now.)
  res.on('close', () => {
    unsubscribe();
    letGo();
  });
});

/**
 * The page is leaving: stop its Generate Immediately run NOW.
 *
 * What a tab sends from `pagehide`, and when somebody leaves Build Resumes
 * inside the app and confirms. The owner only (an administrator included gets
 * 404 for somebody else's), and only from the run's own tab: `?tab=<tabId>`,
 * the id it was submitted with (or no `tab` for a run submitted without one).
 * Cancels exactly as POST /batches/:id/cancel does - queued resumes dropped
 * and refunded, running ones aborted - and answers
 * `{ released: true, cancelled, aborted }`, or `{ released: false, state }`
 * for a run that had already finished.
 *
 * No body is read, so it works as a `fetch(..., { method: 'POST', keepalive:
 * true, credentials: 'include' })` with the session cookie alone - no
 * Authorization header and no Content-Type, which keeps it a CORS "simple"
 * request with no preflight to lose while the page unloads - and as
 * `navigator.sendBeacon(url)`.
 *
 * 409 `not-immediate` for an order (cancel that from /orders) or a run queued
 * before kinds existed; 409 `tab-mismatch` when another tab asks.
 */
router.post('/batches/:id/release', (req: Request<{ id: string }>, res: Response) => {
  const batch = getGenerationQueue().getBatch(req.params.id);
  if (!batch || batch.shared.ownerId !== req.user!.id) {
    res.status(404).json({ error: 'That run is not running.' });
    return;
  }
  if (!isImmediateBatch(batch)) {
    res.status(409).json({
      error: 'Only a Generate Immediately run stops when its page closes. Cancel an order from Orders.',
      code: 'not-immediate',
    });
    return;
  }
  if (!fromRunTab(batch, readRequestTab(req.query.tab))) {
    res.status(409).json({ error: 'That run was started in another tab.', code: 'tab-mismatch' });
    return;
  }
  if (batch.state !== 'running') {
    res.json({ released: false, state: batch.state });
    return;
  }

  const outcome = getTabLeases().release(batch.id) as { cancelled: number; aborted: number } | null;
  console.log(
    `[queue] Immediate run ${batch.id} stopped by its page: ` +
      `${outcome?.cancelled ?? 0} resume(s) not started (refunded), ${outcome?.aborted ?? 0} aborted.`
  );
  res.json({ released: true, cancelled: outcome?.cancelled ?? 0, aborted: outcome?.aborted ?? 0 });
});

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * What a downloaded file is called: the company first, then the file's own
 * name. A Generate Immediately run downloads every resume into one folder,
 * and a resume's file names do not usually say which posting each is for -
 * five `Jane_Doe.pdf (n)` would leave the person opening each to find out.
 */
export function downloadFileName(companyName: string, absolutePath: string): string {
  const base = path.basename(absolutePath);
  const company = sanitizeFileNameStem(companyName);
  if (!company || base.toLowerCase().includes(company.toLowerCase())) return base;
  return `${company}_${base}`;
}

/** The order item a queued task produced, if its batch was filed with one. */
function itemForTask(batchId: string, orderId: string, taskId: string): OrderItem | null {
  const recorded = findOrderItemByTask(orderId, taskId);
  if (recorded) return recorded;
  // Not finished yet (the id is recorded with the outcome), or recorded under
  // an earlier id: the live batch still knows the task's position.
  const live = getGenerationQueue()
    .getBatch(batchId)
    ?.tasks.find((task) => task.id === taskId);
  return live ? findOrderItemForBatch(batchId, live.seq)?.item ?? null : null;
}

/**
 * One file of one finished resume of a queued run - what a Generate
 * Immediately page auto-downloads as each resume lands.
 *
 * `:kind` is `resume-pdf`, `resume-docx`, `cover-letter-pdf` or
 * `cover-letter-docx` (a snapshot's task lists the ones it has as `files`).
 * The OWNER only: the run is found through its order row, whose account must
 * be the caller's - 404 otherwise, an administrator included, and for an id
 * that is not there, because the difference would confirm it exists. Read
 * from the order row rather than the batch, so it keeps working after the
 * queue has evicted a finished batch. 409 `not-ready` for a resume still
 * being built; 410 `file-deleted` once IMMEDIATE_FILE_RETENTION_MS after the
 * run (or an order's retention) has deleted it. Sent as an attachment named
 * `<company>_<file name>` (`downloadFileName`).
 */
router.get(
  '/batches/:id/tasks/:taskId/:kind',
  async (req: Request<{ id: string; taskId: string; kind: string }>, res: Response) => {
    try {
      const notFound = () => res.status(404).json({ error: 'That file was not found.' });
      const kind = req.params.kind;
      if (!isOrderFileKind(kind)) {
        notFound();
        return;
      }
      const order = findOrderForBatch(req.params.id);
      if (!order || order.userId !== req.user!.id) {
        notFound();
        return;
      }
      const item = itemForTask(req.params.id, order.id, req.params.taskId);
      if (!item) {
        notFound();
        return;
      }
      if (item.state === 'queued' || item.state === 'running') {
        res.status(409).json({ error: 'That resume is not ready yet.', code: 'not-ready' });
        return;
      }
      const file = item.files.find((candidate) => candidate.kind === kind);
      if (!file) {
        notFound();
        return;
      }
      const gone = () =>
        res.status(410).json({
          error: 'That file has been deleted from the server. Files are kept only for a short while.',
          code: 'file-deleted',
        });
      if (file.removedAt) {
        gone();
        return;
      }
      // Resolved through the same traversal guard every download uses.
      const absolute = await getGeneratedFilePath(file.path, order.outputRoot);
      if (!absolute) {
        gone();
        return;
      }

      const extension = path.extname(absolute).toLowerCase();
      if (CONTENT_TYPES[extension]) res.setHeader('Content-Type', CONTENT_TYPES[extension]);
      res.download(absolute, downloadFileName(item.companyName, absolute), (sendError) => {
        if (!sendError) return;
        console.warn(`[queue] Could not finish sending ${file.path}.`, sendError);
        if (!res.headersSent) gone();
        else res.destroy();
      });
    } catch (error) {
      sendPublicError(req, res, error, 'Could not read that file');
    }
  }
);

router.post('/batches/:id/cancel', (req: Request<{ id: string }>, res: Response) => {
  // Resolved through the viewer FIRST. Cancelling is destructive - it aborts
  // work already running - so an unscoped id here let any signed-in account
  // stop any other account's run.
  const outcome = visibleBatch(req, req.params.id)
    ? getGenerationQueue().cancel(req.params.id)
    : null;
  if (!outcome) {
    res.status(404).json({ error: 'That batch is not running.' });
    return;
  }
  res.json(outcome);
});

/** What the queues are doing, for the admin page - and only for an administrator. */
router.get('/queues', requireAdmin, (_req: Request, res: Response) => {
  res.json(getGenerationQueue().stats());
});

export default router;
