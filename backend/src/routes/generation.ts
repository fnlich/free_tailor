import path from 'path';
import { Router, type Request, type Response } from 'express';
import {
  describeCharge,
  getStatus,
  isExempt,
  releaseReservation,
  reserveCredits,
} from '../services/credits';
import { assertProfileScopeAllowed, isAdmin, requireAdmin, requireUser } from '../middleware/auth';
import {
  resolvePricedAiChoice,
  resolveSuppliedContentChoice,
  type AiPreferences,
  type PricedAiChoice,
} from '../config/aiPreferences';
import { readPreviewToken } from '../services/credits/previewToken';
import { listProfilesFor, NO_MATCHING_PROFILES, type Viewer } from '../database/profileRepository';
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
import { ORDER_OUTPUT_PATH_TEMPLATE, sanitizeFileNameStem } from '../utils/outputStorage';
import { accountFolderName, getGeneratedFilePath } from '../utils/generatedPath';
import type { Profile } from '../types/profile';
import type { UserAccount } from '../types/account';
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
 * refunded (services/queue/tabLease.ts). Both are filed under the order tree
 * with an `orders` row - an immediate run's is never listed - so every queued
 * resume is downloaded through an owner-checked route and refundable by its
 * order item.
 */

const router = Router();
/**
 * Everything below needs a signed-in account.
 *
 * At the router rather than per route, so a route added later is protected by
 * default. Before v2 these were open, which was defensible with one user on one
 * machine and is not once profiles belong to people.
 */
router.use(requireUser);


type SubmitBody = {
  label?: string;
  templateId?: string;
  format?: 'pdf' | 'docx' | 'both';
  includeCoverLetterDocx?: boolean;
  model?: string;
  profileIds?: string[];
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
  /** Tailored content a preview already produced, keyed by profile id. */
  tailoredContentByProfileId?: Record<string, unknown>;
  /**
   * Each preview's token, keyed by profile id: which model wrote that
   * profile's content, so it is priced - and quoted - as that model's work.
   */
  previewTokenByProfileId?: Record<string, unknown>;
  /**
   * `immediate` (Generate Immediately, the default) or `order` (the Order
   * button). An order runs whether or not anybody is watching, is listed on
   * /orders and answers with an order number; an immediate run is leased to
   * the tab that started it (`tabId`) and goes ahead of orders in its lane.
   * See `readRunKind`.
   */
  mode?: unknown;
  /** The older spelling of `mode: 'order'`, still read when `mode` is absent. */
  asOrder?: boolean;
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
 * tab closed. Without `mode`, the older `asOrder: true` still means an order,
 * and anything else is Generate Immediately.
 */
export function readRunKind(body: Pick<SubmitBody, 'mode' | 'asOrder'>): BatchKind {
  if (body.mode !== undefined && body.mode !== null) {
    if (body.mode === ORDER_BATCH_KIND || body.mode === IMMEDIATE_BATCH_KIND) return body.mode;
    throw new SubmitError('mode must be "immediate" or "order".');
  }
  return body.asOrder === true ? ORDER_BATCH_KIND : IMMEDIATE_BATCH_KIND;
}

/** What a tab id may look like: what a page mints (a UUID, say), and nothing that needs escaping anywhere. */
const TAB_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** The submitting tab's id, or undefined when none was sent. Junk is refused, not dropped. */
export function readTabId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && TAB_ID.test(value.trim())) return value.trim();
  throw new SubmitError('tabId must be 1 to 100 letters, digits, "-" or "_".');
}

function readAiOverrides(body: SubmitBody): AiPreferences {
  return {
    ...(body.model ? { modelId: body.model } : {}),
  };
}

/**
 * Reads the jobs out of a submission, refusing only what could never work.
 *
 * A missing company name is refused here, before anything is queued, because it
 * is wrong for every profile and there is nothing to be gained from discovering
 * it thirty times. A missing ROLE is not refused: the job analysis is what names
 * the role when a sheet row does not, and that analysis has not run yet. It is
 * checked per task, once its analysis is in.
 */
export function normalizeJobs(
  body: SubmitBody,
  outputPathUsesJobTitle: boolean
): NormalizedJob[] {
  const jobs = Array.isArray(body.jobs) ? body.jobs : [];
  if (jobs.length === 0) throw new SubmitError('At least one job is required');

  return jobs.map((job, index) => {
    const companyName = typeof job.companyName === 'string' ? job.companyName.trim() : '';
    const jobDescription = typeof job.jobDescription === 'string' ? job.jobDescription.trim() : '';
    const role = typeof job.role === 'string' ? job.role.trim() : '';

    if (!companyName) {
      throw new SubmitError(`Job ${index + 1} is missing a company name`);
    }
    if (outputPathUsesJobTitle && !role && jobDescription.length <= 50) {
      throw new SubmitError(
        `Job ${index + 1} (${companyName}) has no role and no job description to take one from.`
      );
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

function loadProfiles(viewer: Viewer, profileIds?: string[]): Profile[] {
  const selected = Array.isArray(profileIds)
    ? new Set(profileIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))
    : null;
  return listProfilesFor(viewer)
    .filter((profile) => !profile.disabled)
    .filter((profile) => !selected || selected.has(profile.id))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

/**
 * Which queue a task belongs in.
 *
 * The profile's own model choice decides, per profile - a batch of profiles that
 * disagree runs each on what it was set to, rather than on whichever profile
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
 * Exported so it can be tested without a server: this is where jobs and profiles
 * become the cross-product that goes in the queue, and getting the count or the
 * order wrong is invisible in the response.
 */
export type BuildTaskOptions = {
  /**
   * Who this is being built for, filling `{{account name}}`.
   *
   * Passed for EVERY submission, not only orders. The token is offered to the
   * administrator's own template too, and a template using it would otherwise
   * file every queued build into one shared `unknown/` tree while the
   * synchronous routes filed correctly - which is the shape where accounts
   * start overwriting each other.
   */
  accountFolder?: string;
  /**
   * Whether the submitter is an administrator, which decides the forms the
   * request's `model` may take (see ModelRequestOptions). Absent is not one.
   */
  admin?: boolean;
  /** The submitter's account id, which a preview token must have been issued to. */
  userId?: string;
};

/**
 * The model each profile runs on, and what a resume on it costs.
 *
 * Resolved once per profile rather than once per task: the choice is a profile
 * setting, and a thirty-job batch would otherwise read the settings row thirty
 * times per profile to get the same answer. The ONE resolution both the
 * submission and its quote use, so a quote is what the submission charges.
 */
async function resolveProfileChoices(
  body: SubmitBody,
  profiles: Profile[],
  options: Pick<BuildTaskOptions, 'admin' | 'userId'>
): Promise<Map<string, PricedAiChoice>> {
  const overrides = readAiOverrides(body);
  const requestOptions = { admin: options.admin === true };
  const supplied = (body.tailoredContentByProfileId ?? {}) as Record<string, unknown>;
  const tokens = (body.previewTokenByProfileId ?? {}) as Record<string, unknown>;
  const choices = new Map<string, PricedAiChoice>();
  for (const profile of profiles) {
    // A preview's token names the model that wrote this profile's content, and
    // that is the model it runs - and is priced - on. The quote is sent the
    // tokens without the content, which is why a token counts on its own.
    const previewModelId = options.userId
      ? readPreviewToken(tokens[profile.id], { userId: options.userId, profileId: profile.id })
      : null;
    choices.set(
      profile.id,
      previewModelId || supplied[profile.id]
        ? await resolveSuppliedContentChoice(overrides, profile, requestOptions, previewModelId)
        : await resolvePricedAiChoice(overrides, profile, requestOptions)
    );
  }
  return choices;
}

export async function buildTasks(
  body: SubmitBody,
  jobs: NormalizedJob[],
  profiles: Profile[],
  batchId: string,
  options: BuildTaskOptions = {}
): Promise<Array<TaskDescriptor<ResumeTaskResult>>> {
  const format = body.format === 'docx' ? 'docx' : body.format === 'pdf' ? 'pdf' : 'both';
  const includeCoverLetterDocx = body.includeCoverLetterDocx !== false;
  const tailoredByProfile = (body.tailoredContentByProfileId ?? {}) as Record<string, never>;
  const choices = await resolveProfileChoices(body, profiles, options);

  const descriptors: Array<TaskDescriptor<ResumeTaskResult>> = [];
  // Jobs outer, profiles inner, so the queue order reads down the sheet the way
  // the person who imported it expects.
  for (const [jobIndex, job] of jobs.entries()) {
    for (const profile of profiles) {
      const { choice, costMilli } = choices.get(profile.id)!;
      descriptors.push({
        queue: routeFor(choice).queue,
        label: {
          profileId: profile.id,
          profileName: profile.name,
          companyName: job.companyName,
          role: job.role,
          ...(typeof job.sourceRowNumber === 'number'
            ? { sourceRowNumber: job.sourceRowNumber }
            : {}),
        },
        kind: RESUME_TASK_KIND,
        // The PROFILE ID and the JOB INDEX, not the profile and the job. Both
        // are looked up when the task runs, so a task can be written to a
        // database and read back after a restart - and so thirty tasks on one
        // posting do not carry thirty copies of it.
        payload: {
          // Correct from the start now that the route mints the id. It used to
          // be written blank here and patched up after `submit` returned.
          batchId,
          profileId: profile.id,
          jobIndex,
          templateId: body.templateId,
          format,
          includeCoverLetterDocx,
          choice,
          // What this resume is charged, in thousandths of a dollar, fixed
          // now: the reservation is the sum of these, and a failure refunds
          // exactly its own.
          costMilli,
          // Carried rather than looked up when the task runs, so the second
          // half of an order cannot land somewhere else because a setting was
          // edited, or because midnight passed, while it was queued.
          ...(options.accountFolder ? { accountFolder: options.accountFolder } : {}),
          ...(tailoredByProfile[profile.id]
            ? { tailoredContent: tailoredByProfile[profile.id] }
            : {}),
          // The job's ONE analysis, the same on every profile's task, when
          // its posting already had one at submission (resolveAnalysesAtSubmit).
          ...(job.analysisId ? { analysisId: job.analysisId } : {}),
        } satisfies ResumeTaskPayload,
      });
    }
  }
  return descriptors;
}

/**
 * What a list of tasks costs, in thousandths of a dollar, and the line the
 * account's credit history shows for it - by each task's model display name,
 * so a mixed batch reads as what it was charged.
 *
 * An integer sum of integer prices: seven resumes at $0.023 are exactly 161
 * thousandths, every time - not a float sum that adds up only on lucky inputs.
 */
export function chargeFor(descriptors: Array<TaskDescriptor<ResumeTaskResult>>): { costMilli: number; label: string } {
  const units = descriptors.map((descriptor) => {
    const payload = descriptor.payload as ResumeTaskPayload;
    // Read the way the refund hook reads it, so what is charged and what a
    // failure gives back can never be worked out two different ways.
    return { modelLabel: payload.choice.modelLabel, costMilli: taskCostMilli(payload) };
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
  const failures: Array<{ profileId: string; profileName: string; companyName: string; error: string }> =
    [];
  const hard = new Map<string, string>();
  const soft = new Map<string, string>();

  for (const task of batch.tasks) {
    if (task.state === 'done' && task.value) {
      const value = task.value as ResumeTaskResult;
      results.push(value);
      for (const skill of value.unconfirmedHardSkills) {
        const key = skill.trim().toLowerCase();
        if (key && !hard.has(key)) hard.set(key, skill.trim());
      }
      for (const skill of value.unconfirmedSoftSkills) {
        const key = skill.trim().toLowerCase();
        if (key && !soft.has(key)) soft.set(key, skill.trim());
      }
    } else if (task.state === 'failed' || task.state === 'cancelled') {
      failures.push({
        profileId: task.label.profileId,
        profileName: task.label.profileName,
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
    unconfirmedHardSkills: [...hard.values()],
    unconfirmedSoftSkills: [...soft.values()],
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
    // Every queued run is filed under the fixed order tree now, which never
    // renders a `{{job title}}` segment - so no run is held to the
    // administrator's template's requirements: refusing a row for having no
    // role, to fill a segment nothing renders, is a refusal for a reason that
    // does not apply. The role still comes from the analysis when a row has
    // none (`resolveTaskRole`).
    const jobs = normalizeJobs(body, false);

    const profiles = loadProfiles(req.user ?? null, body.profileIds);
    if (profiles.length === 0) {
      res.status(400).json({ error: NO_MATCHING_PROFILES });
      return;
    }
    // More than one profile - or all of them - needs a subscription that
    // includes it (403 `subscription-too-low`), for an order and an
    // immediate run alike. Before anything is priced or charged.
    assertProfileScopeAllowed(req.user, { profileIds: body.profileIds, resolvedCount: profiles.length });

    // ONE analysis per job, resolved before the jobs fan out into a task per
    // profile, so every profile's task carries the same `analysisId`: the
    // sheet row's own (one batched read of the rows), the one the page named,
    // or the posting's stored one. No model is asked here - a job with none
    // is analysed by its first task, through the same gate.
    const sheet = await resolveRunSheet(req.user, body.sheet);
    const analyses = await resolveAnalysesAtSubmit(jobs, { sheet, requestedBy: req.user?.id ?? null });
    if (sheet) {
      console.log(
        `[queue] Sheet run on "${sheet.tabName}": ${analyses.fromSheet} job(s) analysed in the sheet, ` +
          `${analyses.resolved - analyses.fromSheet} from the store, ${jobs.length - analyses.resolved} to analyse.`
      );
    }

    // Minted here rather than inside `submit`, because the credits have to be
    // reserved against this batch BEFORE any task can start - and `submit`
    // dispatches immediately, so there is no window afterwards in which to do it.
    const batchId = newBatchId();
    const descriptors = await buildTasks(body, jobs, profiles, batchId, {
      accountFolder: accountFolderName(req.user),
      admin: isAdmin(req),
      userId: req.user?.id,
    });
    const charge = chargeFor(descriptors);

    /**
     * The charge, before the first model call.
     *
     * Placed here on purpose: after `normalizeJobs`, the empty-profiles check
     * and the subscription check (so a 400 or 403 never costs anything), after `buildTasks` (which only reads
     * settings - no model call, no file), and before `submit`.
     *
     * Per handler rather than as router middleware, and that is the guarantee
     * that keeps previews free: this router also serves reads, and a blanket
     * charge would catch anything added later by accident.
     *
     * The SUM of what each resume costs on the model it resolved to, so a
     * batch whose profiles run on differently priced models is charged each at
     * its own price, and a 402 names the whole amount.
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
       * nobody ordered: its files are filed under the order tree (unique per
       * run, under the account - a manual build used to land wherever the
       * administrator's template said, where two accounts could write one
       * file), they are served only to their owner, each resume is refundable
       * by its order item, and the retention sweep deletes them
       * IMMEDIATE_FILE_RETENTION_MS after the run ends (owner decision M4).
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
                  : `${jobs.length} job(s) x ${profiles.length} profile(s)`,
              retentionDays: kind === ORDER_BATCH_KIND ? orderRetentionDays() : 0,
            },
            descriptors.map((descriptor, seq) => ({
              seq,
              profileId: descriptor.label.profileId,
              profileName: descriptor.label.profileName,
              companyName: descriptor.label.companyName,
              role: descriptor.label.role,
              ...(typeof descriptor.label.sourceRowNumber === 'number'
                ? { sourceRowNumber: descriptor.label.sourceRowNumber }
                : {}),
              // Kept on the item because the task is not: a refund request
              // for this resume can come long after the batch is evicted.
              costMilli: taskCostMilli(descriptor.payload),
            }))
          );

      /**
       * The order's number reaches the paths here, after it has been issued and
       * before a single task has been dispatched.
       *
       * The number cannot be known when `buildTasks` runs - it is allocated by
       * the insert above - and it cannot be applied after `submit`, which
       * dispatches on the spot. This window is the only place it fits, and the
       * payloads are ours to finish until they are handed over.
       */
      const placed = order;
      for (const descriptor of descriptors) {
        const payload = descriptor.payload as ResumeTaskPayload;
        payload.orderNumber = placed.number;
        payload.pathTemplate = ORDER_OUTPUT_PATH_TEMPLATE;
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
        shared: { jobs, ownerId: req.user!.id, kind, ...(tabId ? { tabId } : {}) },
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
        `${descriptors.length} resume(s) queued (${jobs.length} job(s) x ${profiles.length} profile(s))`
    );

    res.status(202).json({
      batchId: batch.id,
      kind,
      total: descriptors.length,
      jobCount: jobs.length,
      profileCount: profiles.length,
      // The lanes and how busy they are, for an administrator's eyes only.
      ...(isAdmin(req) ? { queues: queue.stats() } : {}),
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
 * Takes the body `POST /batches` takes and resolves each profile's model the
 * way it does (`resolveProfileChoices`), so the figure is what that submission
 * would charge. Answers `{ resumes, costMilli, pricePerResumeMilli,
 * balanceMilli, exempt }` - thousandths of a dollar - and nothing about which
 * models or seats: the builder shows it as one line beside the generate
 * button ("7 resumes x $0.023 = $0.161"), and re-asks whenever the selection
 * or the model changes. `pricePerResumeMilli` is the one price every resume
 * in the run costs, or null when the profiles' models are priced differently
 * (or there is nothing to price).
 *
 * Lenient where the submission is strict, on purpose. The builder asks while
 * the form is still being filled in, and a missing company name or role does
 * not change what anything costs - so jobs are counted, not validated, and no
 * profiles or no jobs is a quote of nothing rather than an error. The two
 * refusals are the submission's own: a request naming a model it may not use
 * (400), and a run for more than one profile - or all of them - on a
 * subscription that does not include that (403 `subscription-too-low`). `costMilli` is the full amount even
 * for an administrator, who is not charged it: `exempt` says so.
 *
 * Reads only. No reservation, no task, no model call.
 */
router.post('/quote', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as SubmitBody;
    const jobCount = Array.isArray(body.jobs) ? body.jobs.length : 0;
    // The submission's subscription refusal, mirrored, so the cost line never
    // prices a run that would be refused. Asked of the profiles even with no
    // jobs yet, because the refusal is about WHO the run is for.
    const targeted = loadProfiles(req.user ?? null, body.profileIds);
    assertProfileScopeAllowed(req.user, { profileIds: body.profileIds, resolvedCount: targeted.length });
    const profiles = jobCount > 0 ? targeted : [];
    const choices = await resolveProfileChoices(body, profiles, { admin: isAdmin(req), userId: req.user?.id });

    const prices = [...choices.values()].map((priced) => priced.costMilli);
    const perJob = prices.reduce((sum, price) => sum + price, 0);
    const resumes = jobCount * profiles.length;
    res.json({
      resumes,
      costMilli: jobCount * perJob,
      pricePerResumeMilli:
        resumes > 0 && prices.every((price) => price === prices[0]) ? prices[0] : null,
      balanceMilli: getStatus(req.user!).balanceMilli,
      exempt: isExempt(req.user!),
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
 * generated file paths, and `/api/generated/:filename` only asks for a session -
 * so an unscoped read here would hand one account another's finished resumes.
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
  // 404 rather than 403 for somebody else's batch, matching the profile
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
 * and a profile's file names do not usually say which posting each is for -
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
      const absolute = await getGeneratedFilePath(file.path);
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
