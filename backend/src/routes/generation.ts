import { Router, type Request, type Response } from 'express';
import { InsufficientCreditsError, releaseReservation, reserveCredits } from '../services/credits';
import { requireUser } from '../middleware/auth';
import { getPublicAppSettings } from '../config/aiModelConfig';
import { resolveAiChoice, type AiPreferences } from '../config/aiPreferences';
import { isBrowserChatSiteId, type BrowserChatSiteId } from '../config/providerCatalog';
import { listProfilesFor, type Viewer } from '../database/profileRepository';
import { describeFailure } from '../middleware/aiErrors';
import {
  getGenerationQueue,
  newBatchId,
  persistNewBatch,
  RESUME_TASK_KIND,
  type Batch,
  type BatchSnapshot,
  type ResumeJob,
  type ResumeTaskPayload,
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
  effort?: string;
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

export class SubmitError extends Error {}

function readAiOverrides(body: SubmitBody): AiPreferences {
  return {
    ...(body.model ? { modelId: body.model } : {}),
    ...(body.effort ? { effort: body.effort as AiPreferences['effort'] } : {}),
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
 * Which queue a task belongs in, and which browsers may run it.
 *
 * The profile's own model choice decides, per profile - a batch of profiles that
 * disagree runs each on what it was set to, rather than on whichever profile
 * happened to come first.
 */
export function routeFor(choice: {
  provider: string;
  route?: string;
}): { queue: 'browser' | 'cli'; sites?: BrowserChatSiteId[] } {
  if (choice.route === 'hybrid') {
    return { queue: 'browser', sites: ['claude-web', 'chatgpt-web'] };
  }
  if (isBrowserChatSiteId(choice.provider)) {
    return { queue: 'browser', sites: [choice.provider] };
  }
  // Everything that is not a chat window runs on the seat's queue: the CLI, and
  // the metered HTTP providers, which have no local resource of their own and
  // would otherwise need a third queue that does nothing.
  return { queue: 'cli' };
}

/**
 * Builds the task list for a submission.
 *
 * Exported so it can be tested without a server: this is where jobs and profiles
 * become the cross-product that goes in the queue, and getting the count or the
 * order wrong is invisible in the response.
 */
export type BuildTaskOptions = {
  /** Set for an order: the account segment and the fixed order tree. */
  accountFolder?: string;
  pathTemplate?: string;
};

export async function buildTasks(
  body: SubmitBody,
  jobs: NormalizedJob[],
  profiles: Profile[],
  batchId: string,
  options: BuildTaskOptions = {}
): Promise<Array<TaskDescriptor<ResumeTaskResult>>> {
  const overrides = readAiOverrides(body);
  const format = body.format === 'docx' ? 'docx' : body.format === 'pdf' ? 'pdf' : 'both';
  const includeCoverLetterDocx = body.includeCoverLetterDocx !== false;
  const tailoredByProfile = (body.tailoredContentByProfileId ?? {}) as Record<string, never>;

  // Resolved once per profile rather than once per task: the choice is a profile
  // setting, and a thirty-job batch would otherwise read the settings row thirty
  // times per profile to get the same answer.
  const choices = new Map<string, Awaited<ReturnType<typeof resolveAiChoice>>>();
  for (const profile of profiles) {
    choices.set(profile.id, await resolveAiChoice(overrides, profile));
  }

  const descriptors: Array<TaskDescriptor<ResumeTaskResult>> = [];
  // Jobs outer, profiles inner, so the queue order reads down the sheet the way
  // the person who imported it expects.
  for (const [jobIndex, job] of jobs.entries()) {
    for (const profile of profiles) {
      const choice = choices.get(profile.id)!;
      const routing = routeFor(choice);
      descriptors.push({
        queue: routing.queue,
        ...(routing.sites ? { sites: routing.sites } : {}),
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
          // Carried rather than looked up when the task runs, so the second
          // half of an order cannot land somewhere else because a setting was
          // edited, or because midnight passed, while it was queued.
          ...(options.accountFolder ? { accountFolder: options.accountFolder } : {}),
          ...(options.pathTemplate ? { pathTemplate: options.pathTemplate } : {}),
          ...(tailoredByProfile[profile.id]
            ? { tailoredContent: tailoredByProfile[profile.id] }
            : {}),
        } satisfies ResumeTaskPayload,
      });
    }
  }
  return descriptors;
}

/** The results and failures of a batch, in submitted order. */
function collectOutcome(batchId: string) {
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
        error: task.error ?? 'Failed to generate resume',
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

function fullSnapshot(snapshot: BatchSnapshot) {
  return { ...snapshot, ...(collectOutcome(snapshot.batchId) ?? {}) };
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
    const settings = await getPublicAppSettings();
    const jobs = normalizeJobs(body, settings.outputPathUsesJobTitle);

    const profiles = loadProfiles(req.user ?? null, body.profileIds);
    if (profiles.length === 0) {
      res.status(400).json({
        error: 'No matching profiles available. Add profiles in Admin or update group members.',
      });
      return;
    }

    // Minted here rather than inside `submit`, because the credits have to be
    // reserved against this batch BEFORE any task can start - and `submit`
    // dispatches immediately, so there is no window afterwards in which to do it.
    const batchId = newBatchId();
    const asOrder = body.asOrder === true;
    const descriptors = await buildTasks(
      body,
      jobs,
      profiles,
      batchId,
      asOrder
        ? { accountFolder: accountFolderName(req.user), pathTemplate: ORDER_OUTPUT_PATH_TEMPLATE }
        : {}
    );

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
     */
    reserveCredits(req.user!, descriptors.length, {
      kind: 'batch',
      id: batchId,
      label: `${jobs.length} job(s) x ${profiles.length} profile(s)`,
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
            }))
          )
        : null;

      batch = queue.submit(descriptors, {
        id: batchId,
        // Written by `persistNewBatch` below, in one transaction, rather than
        // row by row here and then again there.
        deferPersist: true,
        label: typeof body.label === 'string' && body.label.trim() ? body.label.trim() : 'Generation',
        jobCount: jobs.length,
        // The jobs live on the BATCH, once. Each task refers to its own by index,
        // so thirty tasks on one posting do not carry thirty copies of it.
        shared: { jobs, ownerId: req.user!.id },
      });
      // Written as one transaction rather than row by row: a batch that half
      // landed because the process died mid-loop would come back with tasks whose
      // batch does not exist.
      persistNewBatch(batch as Batch);
    } catch (error) {
      // Charged for a run that never started. Give it all back rather than
      // leaving the account short for a failure that was ours.
      releaseReservation(batchId, 'The batch could not be queued.');
      // And an order whose batch never ran would sit at `running` with every
      // item queued and nothing left to move them, its bar stuck at zero.
      if (order) failOrder(order.id, 'The order could not be queued.');
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
      queues: queue.stats(),
      ...(order ? { orderId: order.id, orderNumber: order.number } : {}),
    });
  } catch (error) {
    if (error instanceof SubmitError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof InsufficientCreditsError) {
      res.status(402).json({
        error: error.message,
        code: 'insufficient-credits',
        needed: error.needed,
        balance: error.balance,
      });
      return;
    }
    console.error('Error queueing a generation batch:', error);
    res.status(500).json({ error: describeFailure(error, 'Failed to queue the batch') });
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

/** Every batch the server still holds; `?active=1` for the unfinished ones. */
router.get('/batches', (req: Request, res: Response) => {
  const queue = getGenerationQueue();
  const activeOnly = req.query.active === '1' || req.query.active === 'true';
  res.json({
    batches: queue
      .listBatches(activeOnly)
      // Filtered BEFORE the snapshot is built, so another account's work is
      // never even serialized. The page that reloads takes the first batch in
      // this list and attaches to it, so an unfiltered list would silently
      // point somebody at a stranger's run.
      .filter((batch) => canSeeBatch(req.user ?? null, batch))
      .map((batch) => queue.snapshot(batch.id))
      .filter(Boolean),
    queues: queue.stats(),
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
  res.json(fullSnapshot(snapshot));
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

  const stream = openBatchStream(res);
  stream.send({ type: 'snapshot', ...fullSnapshot(snapshot) });

  if (snapshot.state !== 'running') {
    stream.send({ type: 'done', ...fullSnapshot(snapshot) });
    stream.end();
    return;
  }

  const unsubscribe = queue.subscribe(req.params.id, (event) => {
    stream.send({ type: event.type, ...fullSnapshot(event.snapshot) });
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
  // work in a browser - so an unscoped id here let any signed-in account stop
  // any other account's run.
  const outcome = visibleBatch(req, req.params.id)
    ? getGenerationQueue().cancel(req.params.id)
    : null;
  if (!outcome) {
    res.status(404).json({ error: 'That batch is not running.' });
    return;
  }
  res.json(outcome);
});

/** What the queues are doing, for the admin page. */
router.get('/queues', (_req: Request, res: Response) => {
  res.json(getGenerationQueue().stats());
});

export default router;
