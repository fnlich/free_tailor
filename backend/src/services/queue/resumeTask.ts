import type { AiChoice } from '../../config/aiPreferences';
import type { BrowserChatSiteId } from '../../config/providerCatalog';
import { getTemplateById } from '../../extractors/templateExtractor';
import { generateResumeDOCX } from '../../generators/docxGenerator';
import { saveCoverLetter, saveCoverLetterDOCX } from '../../generators/coverLetterGenerator';
import { generateResumePDF } from '../../generators/pdfGenerator';
import { analysisCacheKey } from '../ai/analysisCache';
import { getProviderSemaphore } from '../ai';
import { analyzeJobDescription, generateCoverLetter, tailorResume } from '../resumeService';
import type { Profile } from '../../types/profile';
import type { JobAnalysis, Template } from '../../types/template';
import { getGeneratedOutputPath } from '../../utils/generatedPath';
import type { Assignment } from './taskQueue';

/**
 * What ONE resume is, as the queue runs it.
 *
 * Lifted almost verbatim out of the batch route's worker, because that block was
 * already the right unit of work: analyse, tailor, write the cover letter, render
 * the files. A task is the whole of one resume rather than one model call, so a
 * browser that takes a task keeps working on that resume until it is finished.
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

export type ResumeTaskInput = {
  profile: Profile;
  job: ResumeJob;
  templateId?: string;
  format: 'pdf' | 'docx' | 'both';
  includeCoverLetterDocx: boolean;
  choice: AiChoice;
  /** Tailored content a preview already produced, so the model is not re-asked. */
  tailoredContent?: import('../../types/template').TailoredContent;
};

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
 * the same number. The old single batch width was capped at 16 partly because
 * "each in-flight item is a model call AND, later, a Chrome tab rendering a
 * PDF"; per-queue widths now add up with no single ceiling over them, so an
 * install with a dozen browsers and a CLI seat could put fifteen simultaneous
 * renders through one Chrome. Rendering is seconds where a model call is
 * minutes, so a modest cap here costs nothing and bounds the memory.
 */
const RENDER_CONCURRENCY = 4;

/**
 * Analyses currently in flight, keyed exactly as the analysis cache keys them.
 *
 * `analysisCache` already stops the SECOND call for a posting - but only after
 * the first has returned. Ten tasks on one job description all start together,
 * all miss, and all call. That is nine wasted turns on a free account, and it is
 * the commonest shape in this app: one posting, several profiles.
 *
 * Keyed on the model as well as the text, which the cache also does and a
 * per-batch memo did not: two profiles set to different models must not share
 * one analysis produced by whichever got there first.
 */
const inFlightAnalyses = new Map<string, Promise<JobAnalysis>>();

export function resetResumeTaskStateForTests(): void {
  inFlightAnalyses.clear();
}

async function resolveTemplate(
  profile: Profile,
  requestedTemplateId?: string
): Promise<Template | null> {
  const candidateIds = [
    typeof requestedTemplateId === 'string' ? requestedTemplateId.trim() : '',
    typeof profile.preferredTemplate === 'string' ? profile.preferredTemplate.trim() : '',
    'default',
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);

  for (const candidateId of candidateIds) {
    const template = await getTemplateById(candidateId);
    if (template && !template.disabled) return template;
  }
  return null;
}

/**
 * The choice, pinned to the browser that actually took the task.
 *
 * A Hybrid task is eligible for both sites, and the dispatcher decides which one
 * by handing it to whichever browser came free. Without this the call would go
 * back to the router and could pick the other site - putting two turns into one
 * window while the one the queue reserved sits idle.
 */
function pinChoice(choice: AiChoice, assignment: Assignment): AiChoice {
  if (assignment.queue !== 'browser' || !assignment.site) return choice;
  if (choice.provider === assignment.site) return choice;
  return { ...choice, provider: assignment.site as BrowserChatSiteId };
}

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

/** Builds one resume. Throws on failure; the queue records it against the task. */
export async function runResumeTask(
  input: ResumeTaskInput,
  assignment: Assignment
): Promise<ResumeTaskResult> {
  const { profile, job } = input;
  const choice = pinChoice(input.choice, assignment);

  const template = await resolveTemplate(profile, input.templateId);
  if (!template) throw new Error('Default template not available');

  const analysis = await analyseOnce(job, choice, assignment.signal);

  let tailoredContent = input.tailoredContent;
  if (!tailoredContent && analysis) {
    tailoredContent = await tailorResume(profile, analysis, choice, assignment.signal);
  }

  const coverLetterBody = tailoredContent?.coverLetter?.trim()
    ? tailoredContent.coverLetter.trim()
    : await generateCoverLetter(profile, job.companyName, job.role, choice, assignment.signal);

  const pathInfo = await getGeneratedOutputPath(
    profile,
    job.companyName,
    job.role,
    job.sourceRowNumber
  );
  const coverLetterPdf = await saveCoverLetter(profile, coverLetterBody, pathInfo);
  const coverLetterDocx = input.includeCoverLetterDocx
    ? await saveCoverLetterDOCX(profile, coverLetterBody, pathInfo)
    : undefined;

  const result: ResumeTaskResult = {
    profileId: profile.id,
    profileName: profile.name,
    companyName: job.companyName,
    role: job.role,
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
        generateResumePDF(profile, template, tailoredContent, pathInfo, job.companyName, job.role),
        generateResumeDOCX(profile, tailoredContent, pathInfo, job.companyName, job.role),
      ]);
      result.pdf = pdf;
      result.docx = docx;
    } else if (input.format === 'docx') {
      result.docx = await generateResumeDOCX(
        profile,
        tailoredContent,
        pathInfo,
        job.companyName,
        job.role
      );
    } else {
      result.pdf = await generateResumePDF(
        profile,
        template,
        tailoredContent,
        pathInfo,
        job.companyName,
        job.role
      );
    }
  } finally {
    release();
  }

  return result;
}
