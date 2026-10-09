import type { AiChoice } from '../../config/aiPreferences';
import { PublicError } from '../../middleware/publicError';
import { generationRenderConcurrency } from '../../config/operational';
import { resolveTemplateForProfile } from '../templateChoice';
import { profileForTemplate } from '../profileService';
import { generateResumeDOCX } from '../../generators/docxGenerator';
import { saveCoverLetter, saveCoverLetterDOCX } from '../../generators/coverLetterGenerator';
import { generateResumePDF } from '../../generators/pdfGenerator';
import { getProviderSemaphore, runPinnedToProvider, warnOnce } from '../ai';
import {
  generateCoverLetter,
  parseTailoredResumeContent,
  tailorResume,
} from '../resumeService';
import { getOrCreateAnalysis, loadAnalysis, type StoredJobAnalysis } from '../jobAnalysis/gate';
import { writeBackFor, type SheetRowRef } from '../jobAnalysis/submit';
import type { Profile } from '../../types/profile';
import type { JobAnalysis, TailoredContent } from '../../types/template';
import { getGeneratedOutputPath } from '../../utils/generatedPath';
import type { Assignment } from './taskQueue';

/**
 * What ONE resume is, as the queue runs it.
 *
 * Lifted almost verbatim out of the batch route's worker, because that block was
 * already the right unit of work: analyse, tailor, write the cover letter, render
 * the files. A task is the whole of one resume rather than one model call, so a
 * slot that takes a task keeps working on that resume until it is finished.
 *
 * Nothing here knows about express. There is no `req`, no `res`, and no
 * `requestSignal` - a batch now outlives the request that submitted it, so the
 * only thing that may stop this work is the batch's own AbortController, which
 * arrives on the `Assignment`.
 */

export type ResumeJob = {
  companyName: string;
  role: string;
  jobDescription: string;
  /** The posting's link: with its text, what identifies it for the one-analysis rule. */
  jobLink?: string;
  /**
   * The posting's stored analysis, when it had one at submission - its sheet
   * row's own, the one the page named, or the store's (see
   * services/jobAnalysis/submit.ts). Copied onto every task's payload.
   */
  analysisId?: string;
  sourceRowNumber?: number;
  /** The app-sheet row the job came from, when it did: where its analysis is written back, once. */
  sheetRow?: SheetRowRef;
};

/**
 * Everything one resume needs, and nothing that cannot be written to a database.
 *
 * A PROFILE ID rather than the profile, and a JOB INDEX rather than the job.
 * Both are the same saving twice over: the profile is reloaded when the task
 * runs, and the jobs live once on the batch instead of once per task - thirty
 * tasks on one posting would otherwise carry thirty copies of it, on disk and in
 * memory alike.
 */
export type ResumeTaskPayload = {
  batchId: string;
  profileId: string;
  jobIndex: number;
  templateId?: string;
  format: 'pdf' | 'docx' | 'both';
  includeCoverLetterDocx: boolean;
  choice: AiChoice;
  /**
   * What this resume was charged, in thousandths of a dollar: the
   * `pricePerResumeMilli` of the model `choice` resolved to at submit.
   * Snapshotted, and outside `choice`, because a refund must give back what
   * was TAKEN, not what the model costs by then - an administrator can
   * reprice it while the batch runs. Every task the routes queue has one
   * (`buildTasks`); read through `taskCostMilli`.
   */
  costMilli?: number;
  /** Tailored content a preview already produced, so the model is not re-asked. */
  tailoredContent?: import('../../types/template').TailoredContent;
  /**
   * The job's stored analysis (`job_analyses.id`). Set at submission when the
   * posting already had one, and otherwise written onto every task of the job
   * the moment the first of them obtains it (`AnalysisHooks.recorded`) - so a
   * retry, a restored task and a sibling profile's task all skip the
   * analysis step. Persisted with the payload, which `taskRow` writes whole
   * and the restore reads back whole.
   */
  analysisId?: string;
  /**
   * Where an ORDERED build files itself, carried rather than looked up.
   *
   * Both are plain strings for the same reason the profile is an id: the
   * payload is written to SQLite and replayed after a restart, and a path
   * derived from a setting that has since been edited would put the second
   * half of an order somewhere the first half is not.
   */
  accountFolder?: string;
  orderNumber?: string;
  pathTemplate?: string;
};

export type ResumeTaskInput = {
  profile: Profile;
  job: ResumeJob;
  templateId?: string;
  format: 'pdf' | 'docx' | 'both';
  includeCoverLetterDocx: boolean;
  choice: AiChoice;
  tailoredContent?: import('../../types/template').TailoredContent;
  /** The task's own `analysisId`, when it carries one: the analysis step is skipped. */
  analysisId?: string;
  /** Who queued it, recorded on an analysis this task is the first to obtain. */
  requestedBy?: string | null;
  /** Called once when THIS task obtained the job's analysis through the gate. */
  onAnalysis?: (stored: StoredJobAnalysis) => void;
  accountFolder?: string;
  orderNumber?: string;
  pathTemplate?: string;
};

/** The kind a resume task is registered under. */
export const RESUME_TASK_KIND = 'resume';

export type ResumeTaskResult = {
  profileId: string;
  profileName: string;
  companyName: string;
  role: string;
  pdf?: string;
  docx?: string;
  coverLetterPdf?: string;
  coverLetterDocx?: string;
  tailored: boolean;
  unconfirmedHardSkills: string[];
  unconfirmedSoftSkills: string[];
};

/**
 * How many resumes may be RENDERED at once, across every queue.
 *
 * Separate from how many may be generated, and needed because the two used to be
 * the same number. Each in-flight item is a model call AND, later, a Chrome tab
 * rendering a PDF; per-queue widths add up with no single ceiling over them, so
 * two seats sized at eight apiece could put sixteen simultaneous renders
 * through one Chrome. Rendering is seconds where a model call is minutes, so a
 * modest cap here costs nothing and bounds the memory.
 *
 * GENERATION_RENDER_CONCURRENCY, four by default: what a machine can hold is a
 * matter of its RAM and CPU, one Chrome tab per render. Read ONCE, when this
 * module loads, and never again - `getProviderSemaphore` replaces a lane's
 * semaphore whenever it is asked for a different limit, so a value that changed
 * between two calls would resize it under the renders already in flight.
 */
const RENDER_CONCURRENCY = generationRenderConcurrency();

/** The render cap this process is using. For the tests; it never changes after load. */
export function resumeRenderConcurrency(): number {
  return RENDER_CONCURRENCY;
}

/**
 * The job's analysis, as this task needs it.
 *
 * A task that carries an `analysisId` reads it from the store and never
 * reaches the gate: a retry repeats only the step that failed (tailoring, the
 * PDF...), and a task restored after a restart is the same task. Only a task
 * with none goes through the gate - the first of a job's tasks to get there
 * makes the job's one call, and every other profile's task waits for it
 * there - and a FAILED analysis stored nothing, so its retry is the first
 * analysis, not a second. A job whose posting is too short to analyse has
 * none, and its resume is built untailored, as before.
 */
async function analysisFor(input: ResumeTaskInput, signal: AbortSignal): Promise<StoredJobAnalysis | null> {
  if (input.analysisId) {
    const stored = loadAnalysis(input.analysisId);
    if (stored) return stored;
    warnOnce(
      `missingTaskAnalysis:${input.analysisId}`,
      `A queued resume names stored analysis ${input.analysisId}, which is not in the store; its posting is ` +
        'looked up again.'
    );
  }
  const stored = await getOrCreateAnalysis({
    jd: input.job.jobDescription,
    link: input.job.jobLink,
    requestedBy: input.requestedBy ?? null,
    company: input.job.companyName,
    signal,
  });
  if (stored) {
    // Once per job, by whichever task got here first: the job, every sibling
    // task's payload, and the sheet row it came from.
    if (input.job.analysisId !== stored.id) {
      input.job.analysisId = stored.id;
      try {
        input.onAnalysis?.(stored);
      } catch (error) {
        console.warn('[queue] Could not record a job analysis on its tasks; they find it in the store instead.', error);
      }
      try {
        writeBackFor(input.job, stored);
      } catch (error) {
        console.warn('[queue] Could not queue the write-back of a job analysis to its sheet row.', error);
      }
    }
  }
  return stored;
}

/**
 * The analysis step on its own, for the tests: a whole task would also drag
 * in a template, a profile on disk and a PDF render.
 */
export const __analysisForTests = analysisFor;

/**
 * Content a page held from an earlier preview, finished against the profile
 * as it is NOW - what /resume/generate does with the same content.
 *
 * The preview was tailored for whatever the profile said then, and the person
 * can flip a section switch or the skills layout before pressing Generate. A
 * switch turned off is covered at render either way; the rest is not: a
 * grouped skills list padded from the library would render as a plain one,
 * padding and all, and a Soft Skills section turned on would show the
 * posting's list rather than the candidate's own first. Running the same
 * post-processing the tailoring call ends with puts all of it right, and it
 * is idempotent on content it already produced.
 *
 * Never fatal: this content was charged for, and the render gate still holds
 * the switches if it cannot be re-read - so a failure here renders it as sent.
 */
function finaliseHeldContent(
  content: TailoredContent,
  profile: Profile,
  analysis: JobAnalysis
): TailoredContent {
  try {
    return parseTailoredResumeContent(JSON.stringify(content), profile, analysis);
  } catch (error) {
    warnOnce(
      'heldTailoredContentUnreadable',
      `A queued resume's previewed content could not be re-read, so it renders as sent: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return content;
  }
}

/**
 * The finishing step on its own, for the tests: a whole task would also print
 * a PDF, and nothing in the suite may start a browser.
 */
export const __finaliseHeldContentForTests = finaliseHeldContent;

/**
 * The role a resume is built for: the one the job carries, trimmed, else the
 * title the analysis read off the posting, else empty.
 *
 * The same rule as the resume routes' `resolveGenerationRole`, because a
 * queued resume and one built on the spot must name the same role for the
 * same row - in the cover letter, the file path and the task's own label.
 */
export function resolveTaskRole(role: unknown, analysis?: JobAnalysis): string {
  if (typeof role === 'string' && role.trim()) return role.trim();
  return analysis?.jobMeta?.title?.trim() || '';
}

/** Builds one resume. Throws on failure; the queue records it against the task. */
export async function runResumeTask(
  input: ResumeTaskInput,
  assignment: Assignment
): Promise<ResumeTaskResult> {
  const { profile, job, choice } = input;

  // The same choice the preview and /resume/generate make, against the profile
  // as it is NOW: a task queued before its profile changed layout is drawn
  // with a template that fits the layout it renders in.
  const template = await resolveTemplateForProfile(profile, input.templateId);
  if (!template) throw new Error('Default template not available');

  const stored = await analysisFor(input, assignment.signal);
  const analysis = stored?.analysis;
  // What, with the profile, the model and the prompt, keys this resume's
  // tailoring and cover letter in the cache (services/tailorCache.ts): the
  // same resume generated again reuses them, charged as usual.
  const cacheContext = { analysisId: stored?.id ?? null, templateId: template.id ?? null };

  // Tailored for the template it is drawn with: a section switch that
  // template has no section for is off for the model too, as it is in the
  // PDF and the DOCX below.
  const sectionProfile = profileForTemplate(profile, template);
  let tailoredContent = input.tailoredContent;
  if (tailoredContent && analysis) {
    tailoredContent = finaliseHeldContent(tailoredContent, sectionProfile, analysis);
  }
  if (!tailoredContent && analysis) {
    tailoredContent = await tailorResume(sectionProfile, analysis, choice, assignment.signal, cacheContext);
  }

  // The role the sheet or the form gave, else the posting's own title as the
  // analysis read it - what /resume/generate does. A row with no Job Title
  // otherwise wrote "Dear Hiring Manager, ... for the  role" and filed the
  // resume under an empty `{{job title}}` segment.
  const role = resolveTaskRole(job.role, analysis);

  const coverLetterBody = tailoredContent?.coverLetter?.trim()
    ? tailoredContent.coverLetter.trim()
    : await generateCoverLetter(profile, job.companyName, role, choice, assignment.signal, cacheContext);

  const pathInfo = await getGeneratedOutputPath(profile, job.companyName, role, {
    sourceRowNumber: job.sourceRowNumber,
    accountName: input.accountFolder,
    orderNumber: input.orderNumber,
    pathTemplate: input.pathTemplate,
  });
  const coverLetterPdf = await saveCoverLetter(profile, coverLetterBody, pathInfo);
  const coverLetterDocx = input.includeCoverLetterDocx
    ? await saveCoverLetterDOCX(profile, coverLetterBody, pathInfo)
    : undefined;

  const result: ResumeTaskResult = {
    profileId: profile.id,
    profileName: profile.name,
    companyName: job.companyName,
    role,
    coverLetterPdf,
    coverLetterDocx,
    tailored: Boolean(analysis),
    // STRINGS only. A finished batch is kept for an hour, and holding the whole
    // TailoredContent of every resume in it is the one real way this leaks.
    unconfirmedHardSkills: tailoredContent?.unconfirmedHardSkills ?? [],
    unconfirmedSoftSkills: tailoredContent?.unconfirmedSoftSkills ?? [],
  };

  const release = await getProviderSemaphore('resume-render', RENDER_CONCURRENCY).acquire();
  try {
    if (input.format === 'both') {
      const [pdf, docx] = await Promise.all([
        generateResumePDF(profile, template, tailoredContent, pathInfo, job.companyName, role),
        generateResumeDOCX(profile, template, tailoredContent, pathInfo, job.companyName, role),
      ]);
      result.pdf = pdf;
      result.docx = docx;
    } else if (input.format === 'docx') {
      result.docx = await generateResumeDOCX(
        profile,
        template,
        tailoredContent,
        pathInfo,
        job.companyName,
        role
      );
    } else {
      result.pdf = await generateResumePDF(
        profile,
        template,
        tailoredContent,
        pathInfo,
        job.companyName,
        role
      );
    }
  } finally {
    release();
  }

  return result;
}

/**
 * The profile a queued resume names was deleted before it ran.
 *
 * Its owner's own doing, and nothing an administrator can fix, so the stored
 * text says what happened in their terms rather than "contact your
 * administrator" - the id stays out of it and goes to the log as detail. And
 * not retried: no later attempt will find the profile either.
 */
export class ProfileGoneError extends PublicError {
  readonly retryable = false;

  constructor(profileId: string) {
    super('The profile for this resume was deleted before it could be built.', {
      status: 410,
      detail: `Profile ${profileId} no longer exists, so this resume cannot be generated.`,
    });
    this.name = 'ProfileGoneError';
  }
}

/**
 * Turns a stored payload back into a running resume.
 *
 * The indirection a restart costs: a task on disk names its profile and its job
 * rather than holding them, so this is where they are looked up again. A profile
 * deleted while its task was queued fails that task by name instead of throwing
 * something about `undefined`.
 */
export type AnalysisHooks = {
  /** Who queued a batch: recorded on an analysis one of its tasks obtains. */
  ownerOf?: (batchId: string) => string | null;
  /**
   * A task obtained its job's analysis through the gate: write the id onto
   * every task of that job in the batch, so none of them - retried, restored
   * or not started yet - reaches the analysis step again.
   */
  recorded?: (batchId: string, jobIndex: number, analysisId: string) => void;
};

export function makeResumeRunner(
  readJobs: (batchId: string) => ResumeJob[] | undefined,
  readProfile: (profileId: string) => Profile | null,
  hooks: AnalysisHooks = {}
) {
  return async (payload: unknown, assignment: Assignment): Promise<ResumeTaskResult> => {
    const input = payload as ResumeTaskPayload;

    const profile = readProfile(input.profileId);
    if (!profile) {
      throw new ProfileGoneError(input.profileId);
    }

    const jobs = readJobs(input.batchId);
    const job = jobs?.[input.jobIndex];
    if (!job) {
      throw new Error('The job this resume was queued for is no longer on the batch.');
    }

    // Every call this resume makes of its provider's type goes to the provider
    // whose lane slot it holds (services/ai/providerPool.ts): the lane's width
    // and that provider's semaphore are one number only if the work lands
    // where the dispatcher put it.
    return runPinnedToProvider(assignment.queue, () => runResumeTask(
      {
        profile,
        job,
        templateId: input.templateId,
        format: input.format,
        includeCoverLetterDocx: input.includeCoverLetterDocx,
        choice: input.choice,
        accountFolder: input.accountFolder,
        orderNumber: input.orderNumber,
        pathTemplate: input.pathTemplate,
        ...(input.tailoredContent ? { tailoredContent: input.tailoredContent } : {}),
        // The payload's own id first; a job stamped by a sibling task since
        // this one was queued has it too.
        ...(input.analysisId || job.analysisId ? { analysisId: input.analysisId || job.analysisId } : {}),
        requestedBy: hooks.ownerOf?.(input.batchId) ?? null,
        onAnalysis: (stored) => hooks.recorded?.(input.batchId, input.jobIndex, stored.id),
      },
      assignment
    ));
  };
}
