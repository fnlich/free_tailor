import { Router, type Request, type Response } from 'express';
import {
  describeCharge,
  getStatus,
  isExempt,
  releaseReservation,
  reserveCredits,
} from '../services/credits';
import { isAdmin, requireAdmin, requireUser } from '../middleware/auth';
import { getUserAppSettings } from '../config/aiModelConfig';
import {
  resolvePricedAiChoice,
  resolveSuppliedContentChoice,
  type AiPreferences,
  type PricedAiChoice,
} from '../config/aiPreferences';
import { readPreviewToken } from '../services/credits/previewToken';
import { listProfilesFor, NO_MATCHING_PROFILES, type Viewer } from '../database/profileRepository';
import { genericMessage, PublicError, publicStoredError, sendPublicError } from '../middleware/publicError';
import {
  getGenerationQueue,
  isOrderBatch,
  laneFor,
  newBatchId,
  ORDER_BATCH_KIND,
  persistNewBatch,
  RESUME_TASK_KIND,
  taskCostMilli,
  type Batch,
  type BatchSnapshot,
  type ResumeJob,
  type ResumeTaskPayload,
  type QueueName,
  type ResumeTaskResult,
  type TaskDescriptor,
} from '../services/queue';
import { createOrder, failOrder } from '../database/orderRepository';
import { orderRetentionDays } from '../services/orders/retention';
import { ORDER_OUTPUT_PATH_TEMPLATE } from '../utils/outputStorage';
import { accountFolderName } from '../utils/generatedPath';
import type { Profile } from '../types/profile';
import type { JobAnalysis } from '../types/template';
import { openBatchStream } from './batchStream';

/**
 * Submitting work to the generation queue.
 *
 * Its own router rather than more of `routes/resume.ts`, which is 1250 lines and
 * shares nothing with this: every route in there performs work and answers with
 * it, and every route in here talks about work that is happening elsewhere.
 *
 * The shape of the contract is the point. `POST` returns a batch id as soon as
 * the tasks are queued, before any of them has run. Progress is read back
 * separately, so closing the page cannot stop the work and reopening it can pick
 * the work back up.
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
    jobAnalysis?: JobAnalysis;
    sourceRowNumber?: number;
  }>;
  /** Tailored content a preview already produced, keyed by profile id. */
  tailoredContentByProfileId?: Record<string, unknown>;
  /**
   * Each preview's token, keyed by profile id: which model wrote that
   * profile's content, so it is priced - and quoted - as that model's work.
   */
  previewTokenByProfileId?: Record<string, unknown>;
  /**
   * Place this as an ORDER rather than a build the caller waits for.
   *
   * What the sheet import sends. It changes three things: the files are filed
   * under the fixed order tree instead of the administrator's template, a
   * durable record is kept that outlives the batch, and the response carries an
   * order number the caller shows instead of waiting for results.
   */
  asOrder?: boolean;
};

export type NormalizedJob = ResumeJob;

/** A submission refused for what it asked for - always the caller's to fix, so public. */
export class SubmitError extends PublicError {
  constructor(message: string) {
    super(message, { status: 400 });
    this.name = 'SubmitError';
  }
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

    return {
      companyName,
      role,
      jobDescription,
      ...(job.jobAnalysis ? { jobAnalysis: job.jobAnalysis } : {}),
      ...(typeof job.sourceRowNumber === 'number'
        ? { sourceRowNumber: job.sourceRowNumber }
        : {}),
    };
  });
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
  // Each seat has its own lane because each has its own semaphore, sized by
  // its own variable. Sharing the Claude seat's lane meant the dispatcher
  // offered `AI_CLI_CONCURRENCY` slots into an `AI_CODEX_CONCURRENCY` pool, so
  // one of the two was always wrong. The Claude seat's lane is also the lane of
  // last resort: a provider id this build has no seat for - a retired one on a
  // choice stored before the upgrade - lands there, and the restore resolves
  // such a choice again before it runs. The same rule the restore places by.
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
 * A snapshot as this reader may see it. Which lane and seat a task is running on
 * (`runningOn`) is an administrator's business, and so is a raw stored error.
 */
function readerSnapshot(snapshot: BatchSnapshot, admin: boolean): BatchSnapshot {
  if (admin) return snapshot;
  return {
    ...snapshot,
    tasks: snapshot.tasks.map(({ runningOn: _lane, ...task }) =>
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
    const asOrder = body.asOrder === true;
    const settings = await getUserAppSettings();
    // An order does not use the administrator's template, so it must not be
    // held to that template's requirements: refusing a sheet row for having no
    // role, to fill a `{{job title}}` segment an order never renders, is a
    // refusal for a reason that does not apply to it.
    const jobs = normalizeJobs(body, asOrder ? false : settings.outputPathUsesJobTitle);

    const profiles = loadProfiles(req.user ?? null, body.profileIds);
    if (profiles.length === 0) {
      res.status(400).json({ error: NO_MATCHING_PROFILES });
      return;
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
     * Placed here on purpose: after `normalizeJobs` and the empty-profiles check
     * (so a 400 never costs anything), after `buildTasks` (which only reads
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
    let order = null;
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
       */
      order = asOrder
        ? createOrder(
            {
              userId: req.user!.id,
              batchId,
              label:
                typeof body.label === 'string' && body.label.trim()
                  ? body.label.trim()
                  : `${jobs.length} job(s) x ${profiles.length} profile(s)`,
              retentionDays: orderRetentionDays(),
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
          )
        : null;

      /**
       * The order's number reaches the paths here, after it has been issued and
       * before a single task has been dispatched.
       *
       * The number cannot be known when `buildTasks` runs - it is allocated by
       * the insert above - and it cannot be applied after `submit`, which
       * dispatches on the spot. This window is the only place it fits, and the
       * payloads are ours to finish until they are handed over.
       */
      if (order) {
        for (const descriptor of descriptors) {
          const payload = descriptor.payload as ResumeTaskPayload;
          payload.orderNumber = order.number;
          payload.pathTemplate = ORDER_OUTPUT_PATH_TEMPLATE;
        }
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
        // An order says so: it is followed on /orders, and the builder's
        // active list leaves it out (see GET /batches).
        shared: { jobs, ownerId: req.user!.id, ...(asOrder ? { kind: ORDER_BATCH_KIND } : {}) },
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

    console.log(
      `[queue] batch ${batch.id}: ${descriptors.length} resume(s) queued ` +
        `(${jobs.length} job(s) x ${profiles.length} profile(s))`
    );

    res.status(202).json({
      batchId: batch.id,
      total: descriptors.length,
      jobCount: jobs.length,
      profileCount: profiles.length,
      // The lanes and how busy they are, for an administrator's eyes only.
      ...(isAdmin(req) ? { queues: queue.stats() } : {}),
      ...(order ? { orderId: order.id, orderNumber: order.number } : {}),
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
 * profiles or no jobs is a quote of nothing rather than an error. The one
 * refusal is a request naming a model it may not use (400), because the
 * submission would be refused over it too. `costMilli` is the full amount even
 * for an administrator, who is not charged it: `exempt` says so.
 *
 * Reads only. No reservation, no task, no model call.
 */
router.post('/quote', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as SubmitBody;
    const jobCount = Array.isArray(body.jobs) ? body.jobs.length : 0;
    const profiles = jobCount > 0 ? loadProfiles(req.user ?? null, body.profileIds) : [];
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
 * survives a restart for free. A batch with NO owner predates this check or was
 * written by an older build; it reads as admin-only rather than public, the same
 * safe direction an unowned profile takes.
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

/**
 * Every batch the server still holds that this account may see.
 *
 * `?active=1` is the builder's question - "is a run of mine still going?" -
 * and answers only the caller's own unfinished, non-order batches, whoever
 * the caller is (`isBuilderRun`). Without it, the list is everything the
 * caller may see, an administrator's included.
 */
router.get('/batches', (req: Request, res: Response) => {
  const queue = getGenerationQueue();
  const activeOnly = req.query.active === '1' || req.query.active === 'true';
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
 */
router.get('/batches/:id/stream', (req: Request<{ id: string }>, res: Response) => {
  const queue = getGenerationQueue();
  const snapshot = visibleBatch(req, req.params.id) ? queue.snapshot(req.params.id) : null;
  if (!snapshot) {
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

  // Detaches a listener and NOTHING else. The work is the queue's now; a page
  // that navigates away is not a reason to stop building somebody's resumes.
  res.on('close', unsubscribe);
});

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
