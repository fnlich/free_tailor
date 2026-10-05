import { resolveAiChoice, type AiChoice } from '../../config/aiPreferences';
import { PublicError } from '../../middleware/publicError';
import {
  isRetiredProviderId,
  RETIRED_FAMILY_DESCRIPTION,
  retiredProviderFamily,
} from '../../config/providerCatalog';
import { generationRenderConcurrency } from '../../config/operational';
import { resolveTemplateForProfile } from '../templateChoice';
import { profileForTemplate } from '../profileService';
import { generateResumeDOCX } from '../../generators/docxGenerator';
import { saveCoverLetter, saveCoverLetterDOCX } from '../../generators/coverLetterGenerator';
import { generateResumePDF } from '../../generators/pdfGenerator';
import { analysisCacheKey } from '../ai/analysisCache';
import { getProviderSemaphore, warnOnce } from '../ai';
import {
  analyzeJobDescription,
  generateCoverLetter,
  parseTailoredResumeContent,
  tailorResume,
} from '../resumeService';
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
  jobAnalysis?: JobAnalysis;
  sourceRowNumber?: number;
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
   * What this resume was charged, in credits: the `creditsPerResume` of the
   * model `choice` resolved to at submit. Snapshotted, and outside `choice`,
   * because a choice can be resolved again after a restart and a refund must
   * give back what was TAKEN, not what the model costs by then. Absent on a task
   * queued before prices were per model, which was charged - and refunds - the
   * default.
   */
  creditCost?: number;
  /** Tailored content a preview already produced, so the model is not re-asked. */
  tailoredContent?: import('../../types/template').TailoredContent;
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
 * between two calls would forget the renders already in flight.
 */
const RENDER_CONCURRENCY = generationRenderConcurrency();

/** The render cap this process is using. For the tests; it never changes after load. */
export function resumeRenderConcurrency(): number {
  return RENDER_CONCURRENCY;
}

/**
 * Analyses currently in flight, keyed exactly as the analysis cache keys them.
 *
 * `analysisCache` already stops the SECOND call for a posting - but only after
 * the first has returned. Ten tasks on one job description all start together,
 * all miss, and all call. That is nine wasted turns on a seat, and it is the
 * commonest shape in this app: one posting, several profiles.
 *
 * Keyed on the model as well as the text, which the cache also does and a
 * per-batch memo did not: two profiles set to different models must not share
 * one analysis produced by whichever got there first.
 */
const inFlightAnalyses = new Map<string, Promise<JobAnalysis>>();

export function resetResumeTaskStateForTests(): void {
  inFlightAnalyses.clear();
}

/**
 * True for a stored choice that names a removed provider, or the "either site"
 * route they offered - the choices `currentChoice` resolves again.
 */
export function namesRetiredProvider(choice: unknown): choice is AiChoice {
  const stored = choice as { provider?: unknown; route?: unknown } | null | undefined;
  return Boolean(stored) && (isRetiredProviderId(stored?.provider) || stored?.route === 'hybrid');
}

/**
 * The task's choice, or a fresh one when it names a retired provider.
 *
 * A choice is resolved when the batch is submitted and written to disk with
 * the task, so a task queued before the browser chat providers or the metered
 * APIs were removed can come back from a restart still naming one - or the
 * "either site" route the browsers offered. Run as stored, it would fail every attempt against a provider nothing
 * serves and then be refunded, and the person who queued it would get nothing.
 * So the choice is resolved again from the profile exactly as a new submission
 * would resolve it: the profile's own model, or the app default. The PRICE is
 * not: what the task was charged is snapshotted on its payload (`creditCost`)
 * and is what a failure refunds, whichever model it ends up running on.
 *
 * The restore does this first, so such a task is placed in the lane of the
 * provider it will actually run on (see `restoreGenerationQueue`); asking again
 * here covers a task whose profile could not be read at that moment.
 */
export async function currentChoice(choice: AiChoice, profile: Profile): Promise<AiChoice> {
  const stored = choice as (AiChoice & { route?: unknown }) | undefined;
  if (!namesRetiredProvider(stored)) return choice;

  const fresh = await resolveAiChoice(undefined, profile);
  const family = retiredProviderFamily(stored.provider) ?? 'browser-chat';
  warnOnce(
    `retiredQueuedChoice:${stored.provider}->${fresh.provider}/${fresh.modelName}`,
    `A queued resume was set to run on "${stored.provider}", one of the removed ` +
      `${RETIRED_FAMILY_DESCRIPTION[family]}; it runs on ${fresh.provider}/${fresh.modelName} instead, ` +
      'resolved from its profile.'
  );
  return fresh;
}

/**
 * The re-resolution on its own, for the tests that pin what a restored task
 * naming a retired provider runs on. Marked rather than made public, as
 * `__analyseOnceForTests` below is: a whole task would also drag in a template,
 * a profile on disk and a PDF render.
 */
export const __currentChoiceForTests = currentChoice;

async function analyseOnce(
  job: ResumeJob,
  choice: AiChoice,
  signal: AbortSignal
): Promise<JobAnalysis | undefined> {
  if (job.jobAnalysis) return job.jobAnalysis;
  if (!job.jobDescription || job.jobDescription.trim().length <= 50) return undefined;

  const key = analysisCacheKey({
    jobDescription: job.jobDescription,
    // The prompt's own text is what the cache keys on; here the id is enough,
    // because a cache hit inside `analyzeJobDescription` does the precise check
    // and this map only has to coalesce calls that are in flight together.
    promptText: 'analyze-job-description',
    model: `${choice.provider}/${choice.modelName}`,
  });

  const existing = inFlightAnalyses.get(key);
  if (existing) return existing;

  const started = analyzeJobDescription(job.jobDescription, choice, undefined, signal).finally(
    () => {
      inFlightAnalyses.delete(key);
    }
  );
  inFlightAnalyses.set(key, started);
  return started;
}

/**
 * The analysis step on its own, for the coalescing tests.
 *
 * Exported under a marked name rather than made public: what it does is an
 * implementation detail of `runResumeTask`, but "ten tasks on one posting call
 * once" cannot be checked through a whole task without also dragging in
 * templates, profiles and a PDF render.
 */
export const __analyseOnceForTests = analyseOnce;

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
  const { profile, job } = input;
  const choice = await currentChoice(input.choice, profile);

  // The same choice the preview and /resume/generate make, against the profile
  // as it is NOW: a task queued before its profile changed layout is drawn
  // with a template that fits the layout it renders in.
  const template = await resolveTemplateForProfile(profile, input.templateId);
  if (!template) throw new Error('Default template not available');

  const analysis = await analyseOnce(job, choice, assignment.signal);

  // Tailored for the template it is drawn with: a section switch that
  // template has no section for is off for the model too, as it is in the
  // PDF and the DOCX below.
  const sectionProfile = profileForTemplate(profile, template);
  let tailoredContent = input.tailoredContent;
  if (tailoredContent && analysis) {
    tailoredContent = finaliseHeldContent(tailoredContent, sectionProfile, analysis);
  }
  if (!tailoredContent && analysis) {
    tailoredContent = await tailorResume(sectionProfile, analysis, choice, assignment.signal);
  }

  // The role the sheet or the form gave, else the posting's own title as the
  // analysis read it - what /resume/generate does. A row with no Job Title
  // otherwise wrote "Dear Hiring Manager, ... for the  role" and filed the
  // resume under an empty `{{job title}}` segment.
  const role = resolveTaskRole(job.role, analysis);

  const coverLetterBody = tailoredContent?.coverLetter?.trim()
    ? tailoredContent.coverLetter.trim()
    : await generateCoverLetter(profile, job.companyName, role, choice, assignment.signal);

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
export function makeResumeRunner(
  readJobs: (batchId: string) => ResumeJob[] | undefined,
  readProfile: (profileId: string) => Profile | null
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

    return runResumeTask(
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
      },
      assignment
    );
  };
}
