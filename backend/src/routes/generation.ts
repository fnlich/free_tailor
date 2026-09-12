import { Router, type Request, type Response } from 'express';
import { getPublicAppSettings } from '../config/aiModelConfig';
import { resolveAiChoice, type AiPreferences } from '../config/aiPreferences';
import { isBrowserChatSiteId, type BrowserChatSiteId } from '../config/providerCatalog';
import { listProfiles } from '../database/profileRepository';
import { describeFailure } from '../middleware/aiErrors';
import {
  getGenerationQueue,
  persistNewBatch,
  RESUME_TASK_KIND,
  type Batch,
  type BatchSnapshot,
  type ResumeJob,
  type ResumeTaskPayload,
  type ResumeTaskResult,
  type TaskDescriptor,
} from '../services/queue';
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

type SubmitBody = {
  label?: string;
  templateId?: string;
  format?: 'pdf' | 'docx' | 'both';
  includeCoverLetterDocx?: boolean;
  model?: string;
  effort?: string;
  thinking?: string;
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
};

export type NormalizedJob = ResumeJob;

export class SubmitError extends Error {}

function readAiOverrides(body: SubmitBody): AiPreferences {
  return {
    ...(body.model ? { modelId: body.model } : {}),
    ...(body.effort ? { effort: body.effort as AiPreferences['effort'] } : {}),
    ...(body.thinking ? { thinking: body.thinking as AiPreferences['thinking'] } : {}),
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

function loadProfiles(profileIds?: string[]): Profile[] {
  const selected = Array.isArray(profileIds)
    ? new Set(profileIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))
    : null;
  return listProfiles()
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
export async function buildTasks(
  body: SubmitBody,
  jobs: NormalizedJob[],
  profiles: Profile[]
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
          // Rewritten to the real batch id once the batch exists; `submit` is
          // what mints that, and the payload has to be built before it.
          batchId: '',
          profileId: profile.id,
          jobIndex,
          templateId: body.templateId,
          format,
          includeCoverLetterDocx,
          choice,
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

    const profiles = loadProfiles(body.profileIds);
    if (profiles.length === 0) {
      res.status(400).json({
        error: 'No matching profiles available. Add profiles in Admin or update group members.',
      });
      return;
    }

    const descriptors = await buildTasks(body, jobs, profiles);
    const queue = getGenerationQueue();
    const batch = queue.submit(descriptors, {
      label: typeof body.label === 'string' && body.label.trim() ? body.label.trim() : 'Generation',
      jobCount: jobs.length,
      // The jobs live on the BATCH, once. Each task refers to its own by index,
      // so thirty tasks on one posting do not carry thirty copies of it.
      shared: { jobs },
    });

    // The batch id only exists once `submit` has minted it, and every payload
    // needs it to find its job again after a restart.
    for (const task of batch.tasks) {
      (task.payload as ResumeTaskPayload).batchId = batch.id;
    }
    // Written as one transaction rather than row by row: a batch that half
    // landed because the process died mid-loop would come back with tasks whose
    // batch does not exist.
    persistNewBatch(batch as Batch);

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
    });
  } catch (error) {
    if (error instanceof SubmitError) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('Error queueing a generation batch:', error);
    res.status(500).json({ error: describeFailure(error, 'Failed to queue the batch') });
  }
});

/** Every batch the server still holds; `?active=1` for the unfinished ones. */
router.get('/batches', (req: Request, res: Response) => {
  const queue = getGenerationQueue();
  const activeOnly = req.query.active === '1' || req.query.active === 'true';
  res.json({
    batches: queue
      .listBatches(activeOnly)
      .map((batch) => queue.snapshot(batch.id))
      .filter(Boolean),
    queues: queue.stats(),
  });
});

router.get('/batches/:id', (req: Request<{ id: string }>, res: Response) => {
  const snapshot = getGenerationQueue().snapshot(req.params.id);
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
  const snapshot = queue.snapshot(req.params.id);
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
  const outcome = getGenerationQueue().cancel(req.params.id);
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
