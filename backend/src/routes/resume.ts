import { Router, Request, Response } from 'express';
import {
  describeCharge,
  newReservationId,
  releaseReservation,
  reserveCredits,
  settleRun,
} from '../services/credits';
import { assertProfileScopeAllowed, isAdmin, requireAdmin, requireUser } from '../middleware/auth';
import path from 'path';
import {
  analyzeJobDescription,
  analyzeJobDescriptionPromptRaw,
  generateCoverLetter,
  parseTailoredResumeContent,
  tailorResume,
} from '../services/resumeService';
import { generateResumePDF, generatePreviewHTML, getGeneratedPDFPath } from '../generators/pdfGenerator';
import { generateResumeDOCX } from '../generators/docxGenerator';
import { saveCoverLetter, saveCoverLetterDOCX } from '../generators/coverLetterGenerator';
import { accountFolderName, getGeneratedOutputPath } from '../utils/generatedPath';
import { ownerOfGeneratedFile } from '../database/orderRepository';
import { noTemplateAvailable, resolveTemplateForProfile } from '../services/templateChoice';
// One rule for a role left empty, shared with the queue so a resume built on
// the spot and a queued one name the same role for the same row.
import { resolveTaskRole } from '../services/queue/resumeTask';
import { getUserAppSettings, type ModelRequestOptions } from '../config/aiModelConfig';
import {
  normalizeAiPreferences,
  resolveAiChoice,
  resolvePricedAiChoice,
  resolveSuppliedContentChoice,
  type AiChoice,
  type AiPreferences,
} from '../config/aiPreferences';
import { mapWithConcurrency, resolveBatchCapacity } from '../services/ai';
import { issuePreviewToken, readPreviewToken } from '../services/credits/previewToken';
import { PublicError, publicItemError, sendPublicError } from '../middleware/publicError';
import { confirmSkill, createSkill, deleteSkillHandler, listSkills, updateSkillHandler } from '../controllers/skills';
import { Profile } from '../types/profile';
import { getProfileFor, listProfilesFor, NO_MATCHING_PROFILES, type Viewer } from '../database/profileRepository';
import { DEFAULT_ANALYZE_JOB_PROMPT_ID, profileForTemplate } from '../services/profileService';
import { GenerateResumeRequest, JobAnalysis, TailoredContent } from '../types/template';

const router = Router();
/**
 * Everything below needs a signed-in account.
 *
 * At the router rather than per route, so a route added later is protected by
 * default. Before v2 these were open, which was defensible with one user on one
 * machine and is not once profiles belong to people.
 */
router.use(requireUser);


/**
 * A signal that fires when the client goes away before the response is sent.
 *
 * Threaded down to the AI transport so a user who closes the tab mid-batch
 * kills the model calls (and, on the CLI provider, the child processes) rather
 * than leaving them to run out the clock against the subscription seat.
 *
 * Keyed on `res` rather than `req`: `req` emits 'close' on normal completion
 * too, so listening there would abort work that had already succeeded.
 */
const requestControllers = new WeakMap<Response, AbortController>();

function requestSignal(req: Request, res: Response): AbortSignal {
  // Memoised per response. All current callers ask once, but the helper reads
  // as though it were safe to call in a loop - and there it would attach a
  // listener per iteration and trip Node's max-listeners warning.
  const existing = requestControllers.get(res);
  if (existing) {
    return existing.signal;
  }

  const controller = new AbortController();
  requestControllers.set(res, controller);
  res.on('close', () => {
    if (!res.writableFinished) {
      controller.abort();
    }
  });
  return controller.signal;
}

function formatDuration(start: bigint, end: bigint): string {
  return `${(Number(end - start) / 1_000_000_000).toFixed(2)}s`;
}

async function timeResumeStage<T>(label: string, action: () => Promise<T>): Promise<T> {
  const startedAt = process.hrtime.bigint();
  try {
    return await action();
  } finally {
    console.log(`[Resume timing] ${label} finished in ${formatDuration(startedAt, process.hrtime.bigint())}`);
  }
}

function shouldGenerateCoverLetterDocx(value: unknown): boolean {
  return typeof value === 'boolean' ? value : true;
}


function getProfileAnalyzeJobPromptId(profile?: Profile): string {
  return profile?.profileSettings?.analyzeJobPromptId?.trim() || DEFAULT_ANALYZE_JOB_PROMPT_ID;
}

/**
 * The models a signed-in account may pick, and the builder's defaults.
 *
 * Every account reads this, so it is the slim `UserAppSettings` and nothing
 * more: ids and display names, no providers, CLI model names, prices, locks or
 * the administrator's shared sheets. Admin pages read /api/admin/settings.
 */
router.get('/models', async (req: Request, res: Response) => {
  try {
    const settings = await getUserAppSettings();
    res.json(settings);
  } catch {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

/*
 * The skill library is ONE store, read for every account's resumes, and
 * managed from the admin Skill Library page. Reading it and confirming a skill
 * found in use (additive and idempotent - the builder's and the profile
 * editor's own flow) stay open to every account; adding one with its category
 * and priority, changing one and deleting one are the library management that
 * page does, and were open to any signed-in account, which let anybody rename
 * or remove a skill out of everybody's resumes.
 */

// Confirm and persist a new skill
router.post('/skills/confirm', confirmSkill);

// List skills
router.get('/skills', listSkills);

// Add skill
router.post('/skills', requireAdmin, createSkill);

// Update skill
router.put('/skills', requireAdmin, updateSkillHandler);

// Delete skill
router.delete('/skills', requireAdmin, deleteSkillHandler);

// Analyze job description
router.post('/analyze', async (req: Request, res: Response) => {
  const requestStartedAt = process.hrtime.bigint();
  console.log('[Resume timing] /resume/analyze started');
  try {
    const { jobDescription, promptId } = req.body as {
      jobDescription?: string;
      promptId?: string;
    };

    if (!jobDescription || jobDescription.trim().length < 50) {
      res.status(400).json({ error: 'Job description must be at least 50 characters' });
      return;
    }

    const selectedModel = await resolveAiChoice(readAiOverrides(req.body), null, { admin: isAdmin(req) });
    const analysis = await analyzeJobDescription(
      jobDescription,
      selectedModel,
      promptId,
      requestSignal(req, res)
    );
    console.log(`[Resume timing] /resume/analyze finished in ${formatDuration(requestStartedAt, process.hrtime.bigint())}`);
    res.json(analysis);
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to analyze the job description');
  }
});

/**
 * The Prompt Test page's raw run. Administrators only: it is how a prompt is
 * debugged, it can name any model by provider, and its answer is the model's
 * unparsed output.
 */
router.post('/analyze-prompt-test', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { jobDescription, promptId } = req.body as {
      jobDescription?: string;
      promptId?: string;
    };

    if (!jobDescription || jobDescription.trim().length < 50) {
      res.status(400).json({ error: 'Job description must be at least 50 characters' });
      return;
    }

    const selectedModel = await resolveAiChoice(readAiOverrides(req.body), null, { admin: isAdmin(req) });
    const result = await analyzeJobDescriptionPromptRaw(
      jobDescription,
      selectedModel,
      promptId
    );
    res.json(result);
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to test the job description prompt');
  }
});

router.post('/analyze-multi-job', async (req: Request, res: Response) => {
  try {
    const {
      jobs,
      model,
    } = req.body as {
      jobs?: Array<{
        companyName?: string;
        jobDescription?: string;
        sourceRowNumber?: number;
      }>;
      model?: string;
    };

    if (!Array.isArray(jobs) || jobs.length === 0) {
      res.status(400).json({ error: 'At least one job is required' });
      return;
    }

    const selectedModel = await resolveAiChoice(readAiOverrides(req.body), null, { admin: isAdmin(req) });

    const validJobs: Array<{
      customId: string;
      companyName: string;
      jobDescription: string;
      sourceRowNumber?: number;
    }> = [];
    const failures: Array<{
      companyName: string;
      sourceRowNumber?: number;
      error: string;
    }> = [];

    for (const [index, job] of jobs.entries()) {
      const companyName = typeof job.companyName === 'string' ? job.companyName.trim() : '';
      const jobDescription = typeof job.jobDescription === 'string' ? job.jobDescription.trim() : '';

      if (!companyName) {
        failures.push({
          companyName: `Job ${index + 1}`,
          sourceRowNumber: job.sourceRowNumber,
          error: 'Company name is required',
        });
        continue;
      }

      if (jobDescription.length < 50) {
        failures.push({
          companyName,
          sourceRowNumber: job.sourceRowNumber,
          error: 'Job description must be at least 50 characters',
        });
        continue;
      }

      validJobs.push({
        customId: `job_${index + 1}`,
        companyName,
        jobDescription,
        sourceRowNumber: job.sourceRowNumber,
      });
    }

    const analyses: Array<{
      companyName: string;
      sourceRowNumber?: number;
      jobDescription: string;
      analysis: JobAnalysis;
    }> = [];

    // The analyses go out at the chosen provider's width too. They are the
    // short calls, but there is one per job and a sheet import brings dozens.
    const analysisCapacity = await resolveBatchCapacity(selectedModel);
    const analysisOutcomes = await mapWithConcurrency(validJobs, analysisCapacity.limit, (job) =>
      analyzeJobDescription(
        job.jobDescription,
        selectedModel,
        undefined,
        requestSignal(req, res)
      )
    );

    analysisOutcomes.forEach((outcome, index) => {
      const job = validJobs[index];
      if (outcome.ok) {
        analyses.push({
          companyName: job.companyName,
          sourceRowNumber: job.sourceRowNumber,
          jobDescription: job.jobDescription,
          analysis: outcome.value,
        });
        return;
      }
      failures.push({
        companyName: job.companyName,
        sourceRowNumber: job.sourceRowNumber,
        error: publicItemError(outcome.error, 'Analysis failed', `analyze-multi-job ${job.customId}`),
      });
    });

    res.json({
      analyzed: analyses.length,
      analyses,
      failed: failures.length,
      failures,
    });
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to analyze the job descriptions');
  }
});

/**
 * The requester's non-disabled profiles, optionally narrowed to a set of ids.
 *
 * Scoped by the viewer, and the narrowing happens AFTER: naming somebody else's
 * profile id in `profileIds` selects nothing rather than reaching it, so the
 * request builds fewer resumes than asked rather than one it should not.
 */
async function loadAllProfiles(viewer: Viewer, profileIds?: string[]): Promise<Profile[]> {
  const selectedIds = Array.isArray(profileIds)
    ? new Set(profileIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))
    : null;
  return listProfilesFor(viewer)
    .filter((profile) => !selectedIds || selectedIds.has(profile.id))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function collectUnconfirmedSkillMaps(
  content: TailoredContent | undefined,
  hardMap: Map<string, string>,
  softMap: Map<string, string>
): void {
  if (!content) return;

  for (const skill of content.unconfirmedHardSkills ?? []) {
    const key = skill.trim().toLowerCase();
    if (key && !hardMap.has(key)) {
      hardMap.set(key, skill.trim());
    }
  }

  for (const skill of content.unconfirmedSoftSkills ?? []) {
    const key = skill.trim().toLowerCase();
    if (key && !softMap.has(key)) {
      softMap.set(key, skill.trim());
    }
  }
}

/**
 * How many AI-only batch items one request offers up at once.
 *
 * The provider's own process-wide semaphore is what actually bounds concurrent
 * `claude` processes across simultaneous requests; this only decides how many
 * items this loop hands it. Deliberately NOT set above that limit: the excess
 * can do nothing but queue, and a queued item still spends its caller's
 * deadline, so a wider fan-out buys nothing and risks turning a slow batch
 * into a failed one.
 */
/**
 * The model a single request asks for.
 *
 * An override for THIS run only. Absent, it falls through to the profile's own
 * setting and then to the app default, which is why it is normalized into
 * preferences rather than resolved here.
 */
function readAiOverrides(body: unknown): AiPreferences {
  const record = (body ?? {}) as Record<string, unknown>;
  return normalizeAiPreferences({
    modelId: typeof record.model === 'string' ? record.model : undefined,
  });
}

async function tailorResumesForProfiles(
  profiles: Profile[],
  analysis: JobAnalysis,
  requestChoice: AiChoice,
  overrides: AiPreferences,
  options: ModelRequestOptions,
  templateId: string | undefined,
  signal?: AbortSignal
): Promise<{
  tailoredByProfileId: Map<string, TailoredContent>;
  /** The model each profile's content was written on, for its preview token. */
  modelIdByProfileId: Map<string, string>;
  failures: Array<{ profileId: string; profileName: string; error: string }>;
  unconfirmedHardSkills: string[];
  unconfirmedSoftSkills: string[];
}> {
  const tailoredByProfileId = new Map<string, TailoredContent>();
  const modelIdByProfileId = new Map<string, string>();
  const failures: Array<{ profileId: string; profileName: string; error: string }> = [];
  const unconfirmedHardMap = new Map<string, string>();
  const unconfirmedSoftMap = new Map<string, string>();

  // Tailoring is pure model work with no shared state, so running profiles in
  // parallel is only a question of how many at once. It used to be one - a
  // five-profile batch was five full model calls end to end, with the user
  // waiting through all of them. Failures are still collected per profile
  // rather than aborting the batch, exactly as the sequential loop did.
  // Resolved per profile, not once for the batch: the model is a PROFILE
  // setting, so a batch of profiles that disagree must
  // run each on its own choice rather than on whichever profile came first.
  // The request's own overrides still win over every one of them.
  // Width from the provider the REQUEST resolved to. Each profile may still
  // resolve its own model below - that is a per-profile setting - but the
  // capacity question is about the resource in front of the batch, and asking
  // it once per profile would read the settings row once per profile to get the
  // same answer.
  const capacity = await resolveBatchCapacity(requestChoice);
  const outcomes = await mapWithConcurrency(profiles, capacity.limit, async (profile) => {
    const choice = await resolveAiChoice(overrides, profile, options);
    modelIdByProfileId.set(profile.id, choice.modelId);
    // Tailored for the template it will be drawn with, which the preview
    // below resolves the same way: a section that template cannot print is
    // off for the model too (see `profileForTemplate`).
    const template = await resolveTemplateForProfile(profile, templateId);
    return tailorResume(profileForTemplate(profile, template), analysis, choice, signal);
  });

  outcomes.forEach((outcome, index) => {
    const profile = profiles[index];
    if (outcome.ok) {
      tailoredByProfileId.set(profile.id, outcome.value);
      collectUnconfirmedSkillMaps(outcome.value, unconfirmedHardMap, unconfirmedSoftMap);
      return;
    }
    failures.push({
      profileId: profile.id,
      profileName: profile.name,
      error: publicItemError(outcome.error, 'Failed to tailor the resume', `tailor ${profile.id}`),
    });
  });

  return {
    tailoredByProfileId,
    modelIdByProfileId,
    failures,
    unconfirmedHardSkills: Array.from(unconfirmedHardMap.values()),
    unconfirmedSoftSkills: Array.from(unconfirmedSoftMap.values()),
  };
}

// Preview resumes for all profiles
router.post('/preview-all', async (req: Request, res: Response) => {
  try {
    const {
      templateId,
      jobDescription,
      jobAnalysis,
      model,
      profileIds,
    } = req.body as {
      templateId?: string;
      jobDescription?: string;
      jobAnalysis?: import('../types/template').JobAnalysis;
      model?: string;
      profileIds?: string[];
    };

    const aiOverrides = readAiOverrides(req.body);
    const requestOptions: ModelRequestOptions = { admin: isAdmin(req) };
    const selectedModel = await resolveAiChoice(aiOverrides, null, requestOptions);

    const profiles = await loadAllProfiles(req.user ?? null, profileIds);
    if (profiles.length === 0) {
      res.status(400).json({ error: NO_MATCHING_PROFILES });
      return;
    }
    // Previewing several profiles is the first half of building for several,
    // and is refused on the same terms (403 `subscription-too-low`) - before
    // the analysis, so a refusal never costs a model call.
    assertProfileScopeAllowed(req.user, { profileIds, resolvedCount: profiles.length });


    let analysis: JobAnalysis | undefined;
    const trimmedJobDescription = jobDescription?.trim();
    if (trimmedJobDescription && trimmedJobDescription.length > 50) {
      analysis = jobAnalysis || await analyzeJobDescription(
        trimmedJobDescription,
        selectedModel,
        getProfileAnalyzeJobPromptId(profiles[0]),
        requestSignal(req, res)
      );
    }

    const previews: Array<{
      profileId: string;
      profileName: string;
      html: string;
      tailoredContent?: TailoredContent;
      /** Names the model that wrote `tailoredContent`; finalising is charged for that model. */
      previewToken?: string;
    }> = [];
    const unconfirmedHardMap = new Map<string, string>();
    const unconfirmedSoftMap = new Map<string, string>();
    const bulkTailoring = analysis
      ? await tailorResumesForProfiles(
          profiles,
          analysis,
          selectedModel,
          aiOverrides,
          requestOptions,
          templateId,
          requestSignal(req, res)
        )
      : null;

    if (bulkTailoring && bulkTailoring.failures.length > 0) {
      // Built from each profile's PUBLIC sentence, so it is public too.
      throw new PublicError(
        `Failed to tailor ${bulkTailoring.failures.length} profile(s): ${bulkTailoring.failures
          .slice(0, 3)
          .map((item) => `${item.profileName}: ${item.error}`)
          .join(' | ')}${bulkTailoring.failures.length > 3 ? ' | ...' : ''}`,
        { status: 502 }
      );
    }

    const capacity = await resolveBatchCapacity(selectedModel);
    const previewable = profiles.filter((profile): profile is Profile => Boolean(profile));
    const outcomes = await mapWithConcurrency(previewable, capacity.limit, async (profile) => {
      const template = await resolveTemplateForProfile(profile, templateId);
      if (!template) {
        throw new Error('Default template not available');
      }

      const tailoredContent = analysis
        ? bulkTailoring
          ? bulkTailoring.tailoredByProfileId.get(profile.id)
          : await tailorResume(profileForTemplate(profile, template), analysis, selectedModel, requestSignal(req, res))
        : undefined;
      const writtenOn = tailoredContent
        ? bulkTailoring?.modelIdByProfileId.get(profile.id) ?? selectedModel.modelId
        : null;

      return {
        tailoredContent,
        preview: {
          profileId: profile.id,
          profileName: profile.name,
          html: await generatePreviewHTML(profile, template, tailoredContent),
          tailoredContent,
          ...(writtenOn
            ? { previewToken: issuePreviewToken({ userId: req.user!.id, profileId: profile.id, modelId: writtenOn }) }
            : {}),
        },
      };
    });

    // A missing template fails THIS profile, not the whole preview.
    //
    // The loop this replaced answered 500 and returned the moment one profile
    // had no template, discarding every preview already built - including the
    // model calls that produced them. A batch that throws away finished work
    // over one bad row is the thing every other batch path here avoids.
    for (const [index, outcome] of outcomes.entries()) {
      const profile = previewable[index];
      if (!outcome.ok) {
        console.error(`Error previewing resume for profile ${profile.id} (${profile.name}):`, outcome.error);
        continue;
      }
      collectUnconfirmedSkillMaps(outcome.value.tailoredContent, unconfirmedHardMap, unconfirmedSoftMap);
      previews.push(outcome.value.preview);
    }

    res.json({
      previews,
      tailored: !!analysis,
      unconfirmedHardSkills: bulkTailoring?.unconfirmedHardSkills ?? Array.from(unconfirmedHardMap.values()),
      unconfirmedSoftSkills: bulkTailoring?.unconfirmedSoftSkills ?? Array.from(unconfirmedSoftMap.values()),
    });
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to preview the resumes');
  }
});

// Generate tailored resume (single profile)
router.post('/generate', async (req: Request, res: Response) => {
  const requestStartedAt = process.hrtime.bigint();
  console.log('[Resume timing] /resume/generate started');
  try {
    const {
      profileId,
      templateId,
      jobDescription,
      jobAnalysis,
      companyName,
      role,
      sourceRowNumber,
      model,
      format = 'pdf',
      includeCoverLetterDocx,
    }: GenerateResumeRequest = req.body;
    const appSettings = await getUserAppSettings();

    if (!profileId) {
      res.status(400).json({ error: 'Profile ID is required' });
      return;
    }

    if (!companyName || !companyName.trim()) {
      res.status(400).json({ error: 'Company name is required' });
      return;
    }

    // Load profile
    const profile = getProfileFor(req.user ?? null, profileId);
    if (!profile) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    if (profile.disabled) {
      res.status(400).json({ error: 'Selected profile is disabled' });
      return;
    }

    // Resolved BEFORE the charge, because the charge is this model's price.
    // Not at the top of the handler: the model is a per-profile setting, so
    // the profile has to be loaded before it can be read. The request's own
    // override still wins - and one it may not use is refused here, before
    // anything is taken.
    //
    // Content a preview already wrote is priced at the model that wrote it -
    // named by the preview's token - and not at whatever this request names,
    // since no model writes it again here (see resolveSuppliedContentChoice).
    const suppliedContent = Boolean((req.body as GenerateResumeRequest).tailoredContent);
    const { choice: selectedModel, costMilli } = suppliedContent
      ? await resolveSuppliedContentChoice(
          readAiOverrides(req.body),
          profile,
          { admin: isAdmin(req) },
          readPreviewToken((req.body as { previewToken?: unknown }).previewToken, {
            userId: req.user!.id,
            profileId: profile.id,
          })
        )
      : await resolvePricedAiChoice(readAiOverrides(req.body), profile, { admin: isAdmin(req) });

    // One resume, one price - however many files it writes. A run asking for
    // PDF and DOCX plus a cover letter produces four files and is still one
    // resume, because what was asked for is one tailored resume.
    //
    // Note where this ISN'T: /preview below has the identical shape and is NOT
    // charged, because it writes no file and its tailored output is handed back
    // for /batches to reuse. Charging both would bill the ordinary
    // preview-then-generate flow twice for one piece of model work.
    const singleReservation = newReservationId();
    reserveCredits(req.user!, costMilli, {
      kind: 'request',
      id: singleReservation,
      label: `${profile.name} / ${companyName.trim()} - ${describeCharge([
        { modelLabel: selectedModel.modelLabel, costMilli },
      ])}`,
    });
    try {

    // Ensure built-in templates exist, then load requested template
    const template = await resolveTemplateForProfile(profile, templateId);
    if (!template) {
      throw noTemplateAvailable();
    }

    // If job description provided, tailor the resume. Existing/manual content still
    // gets normalized so skills remain code-decided from the library.
    let tailoredContent = (req.body as GenerateResumeRequest).tailoredContent as TailoredContent | undefined;
    let analysis = jobAnalysis;
    if (!analysis && jobDescription && jobDescription.trim().length > 50) {
      analysis = jobAnalysis || await analyzeJobDescription(
        jobDescription,
        selectedModel,
        getProfileAnalyzeJobPromptId(profile),
        requestSignal(req, res)
      );
    }
    // Tailoring reads the profile through its template, as the render does: a
    // switch the template has no section for is off for the model too.
    const sectionProfile = profileForTemplate(profile, template);
    if (tailoredContent && analysis) {
      tailoredContent = parseTailoredResumeContent(JSON.stringify(tailoredContent), sectionProfile, analysis);
    }
    if (!tailoredContent && analysis) {
      tailoredContent = await tailorResume(sectionProfile, analysis, selectedModel, requestSignal(req, res));
    }
    const resolvedRole = resolveTaskRole(role, analysis);
    if (appSettings.outputPathUsesJobTitle && !resolvedRole) {
      res.status(400).json({ error: 'Role is required' });
      return;
    }

    const generateBoth = (format as string) === 'both';
    const generateCoverLetterDocx = shouldGenerateCoverLetterDocx(includeCoverLetterDocx);
    const unconfirmedHardSkills = tailoredContent?.unconfirmedHardSkills ?? [];
    const unconfirmedSoftSkills = tailoredContent?.unconfirmedSoftSkills ?? [];
    const buildAfterLlmStartedAt = process.hrtime.bigint();

    // Get cover letter body: from tailored content or generate when no job description
    const coverLetterBody = await timeResumeStage('Cover letter body setup', async () => {
      if (tailoredContent?.coverLetter?.trim()) {
        return tailoredContent.coverLetter.trim();
      }
      return generateCoverLetter(
        profile,
        companyName.trim(),
        resolvedRole,
        selectedModel,
        requestSignal(req, res)
      );
    });

    const pathInfo = await getGeneratedOutputPath(profile, companyName.trim(), resolvedRole, {
      sourceRowNumber,
      accountName: accountFolderName(req.user),
    });
    const { coverLetterPdfPath, coverLetterDocxPath } = await timeResumeStage('Cover letter file generation', async () => {
      const pdfPath = await saveCoverLetter(profile, coverLetterBody, pathInfo);
      const docxPath = generateCoverLetterDocx
        ? await saveCoverLetterDOCX(profile, coverLetterBody, pathInfo)
        : undefined;
      return { coverLetterPdfPath: pdfPath, coverLetterDocxPath: docxPath };
    });

    if (generateBoth) {
      const [pdfFilename, docxFilename] = await timeResumeStage('Resume PDF/DOCX generation', () =>
        Promise.all([
          generateResumePDF(profile, template, tailoredContent, pathInfo, companyName.trim(), resolvedRole),
          generateResumeDOCX(profile, template, tailoredContent, pathInfo, companyName.trim(), resolvedRole),
        ])
      );
      console.log(`[Resume timing] Build after LLM finished in ${formatDuration(buildAfterLlmStartedAt, process.hrtime.bigint())}`);
      console.log(`[Resume timing] /resume/generate finished in ${formatDuration(requestStartedAt, process.hrtime.bigint())}`);
      res.json({
        pdf: { filename: pdfFilename, downloadUrl: `/api/resume/download/${pdfFilename}` },
        docx: { filename: docxFilename, downloadUrl: `/api/resume/download/${docxFilename}` },
        coverLetter: {
          pdf: { filename: coverLetterPdfPath, downloadUrl: `/api/resume/download/${coverLetterPdfPath}` },
          ...(coverLetterDocxPath
            ? {
                docx: {
                  filename: coverLetterDocxPath,
                  downloadUrl: `/api/resume/download/${coverLetterDocxPath}`,
                },
              }
            : {}),
        },
        tailored: !!tailoredContent,
        unconfirmedHardSkills,
        unconfirmedSoftSkills,
      });
    } else {
      const formatNorm = format === 'docx' ? 'docx' : 'pdf';
      const filename = await timeResumeStage(`Resume ${formatNorm.toUpperCase()} generation`, () =>
        formatNorm === 'docx'
          ? generateResumeDOCX(profile, template, tailoredContent, pathInfo, companyName.trim(), resolvedRole)
          : generateResumePDF(profile, template, tailoredContent, pathInfo, companyName.trim(), resolvedRole)
      );

      console.log(`[Resume timing] Build after LLM finished in ${formatDuration(buildAfterLlmStartedAt, process.hrtime.bigint())}`);
      console.log(`[Resume timing] /resume/generate finished in ${formatDuration(requestStartedAt, process.hrtime.bigint())}`);
      res.json({
        filename,
        downloadUrl: `/api/resume/download/${filename}`,
        coverLetter: {
          pdf: { filename: coverLetterPdfPath, downloadUrl: `/api/resume/download/${coverLetterPdfPath}` },
          ...(coverLetterDocxPath
            ? {
                docx: {
                  filename: coverLetterDocxPath,
                  downloadUrl: `/api/resume/download/${coverLetterDocxPath}`,
                },
              }
            : {}),
        },
        tailored: !!tailoredContent,
        format: formatNorm,
        unconfirmedHardSkills,
        unconfirmedSoftSkills,
      });
    }
    // The resume exists, so its price is spent.
    settleRun(singleReservation);
    } finally {
      // A no-op on the happy path, because `settleRun` above already closed it
      // with the resume's price spent. On a throw nothing settled it, so this
      // sweeps the price back - which is the whole reason the body is wrapped
      // rather than refunded at each exit.
      releaseReservation(singleReservation, 'The run did not finish.');
    }
  } catch (error) {
    // Too little credit is a 402 with `neededMilli` and `balanceMilli`; a model
    // the request may not use, a 400. Both are public. Anything else is generic.
    sendPublicError(req, res, error, 'Failed to generate the resume');
  }
});

// Preview resume HTML
router.post('/preview', async (req: Request, res: Response) => {
  const requestStartedAt = process.hrtime.bigint();
  console.log('[Resume timing] /resume/preview started');
  try {
    const { profileId, templateId, jobDescription, jobAnalysis, tailoredContent: manualTailoredContent }: GenerateResumeRequest = req.body;

    if (!profileId) {
      res.status(400).json({ error: 'Profile ID is required' });
      return;
    }

    // Load profile
    const profile = getProfileFor(req.user ?? null, profileId);
    if (!profile) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    if (profile.disabled) {
      res.status(400).json({ error: 'Selected profile is disabled' });
      return;
    }

    // Resolved here rather than at the top of the handler: the model
    // is a per-profile setting, so the profile has to be loaded
    // before they can be read. The request's own overrides still win.
    const selectedModel = await resolveAiChoice(readAiOverrides(req.body), profile, { admin: isAdmin(req) });

    // Ensure built-in templates exist, then load requested template
    const template = await resolveTemplateForProfile(profile, templateId);
    if (!template) {
      throw noTemplateAvailable();
    }

    // If job description provided, tailor the resume. Existing/manual content still
    // gets normalized so skills remain code-decided from the library.
    let tailoredContent = manualTailoredContent;
    let analysis = jobAnalysis;
    if (!analysis && jobDescription && jobDescription.trim().length > 50) {
      analysis = await analyzeJobDescription(
        jobDescription,
        selectedModel,
        getProfileAnalyzeJobPromptId(profile),
        requestSignal(req, res)
      );
    }
    // Tailoring reads the profile through its template, as the render does: a
    // switch the template has no section for is off for the model too.
    const sectionProfile = profileForTemplate(profile, template);
    if (tailoredContent && analysis) {
      tailoredContent = parseTailoredResumeContent(JSON.stringify(tailoredContent), sectionProfile, analysis);
    }
    // Only content THIS request wrote gets a token naming its model. Content
    // the request supplied is re-rendered, and a token for it would let any
    // model's work be re-labelled as the one the request names.
    let previewToken: string | undefined;
    if (!tailoredContent && analysis) {
      tailoredContent = await tailorResume(sectionProfile, analysis, selectedModel, requestSignal(req, res));
      previewToken = issuePreviewToken({ userId: req.user!.id, profileId: profile.id, modelId: selectedModel.modelId });
    }

    // Generate HTML preview
    const html = await timeResumeStage('Preview HTML generation', () =>
      generatePreviewHTML(profile, template, tailoredContent)
    );

    console.log(`[Resume timing] /resume/preview finished in ${formatDuration(requestStartedAt, process.hrtime.bigint())}`);
    res.json({ html, tailored: !!tailoredContent, tailoredContent, ...(previewToken ? { previewToken } : {}) });
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to generate the preview');
  }
});

// Download generated resume (PDF or DOCX)
router.get('/download/:filename(*)', async (req: Request<{ filename: string }>, res: Response) => {
  try {
    // The same ownership check as `/api/generated`, and for the same reason:
    // an ordered resume's path is derivable from a fixed template, so a
    // signed-in-only check on a path parameter hands out everybody's files.
    // See `ownerOfGeneratedFile`. A path no order claims is unaffected.
    const owner = ownerOfGeneratedFile(req.params.filename);
    if (owner && owner !== req.user!.id) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const filepath = await getGeneratedPDFPath(req.params.filename);
    if (!filepath) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const ext = path.extname(req.params.filename).toLowerCase();
    const contentType =
      ext === '.docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/pdf';

    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(req.params.filename)}"`);
    res.setHeader('Content-Type', contentType);
    res.download(filepath);
  } catch (error) {
    res.status(500).json({ error: 'Failed to download file' });
  }
});

export default router;
