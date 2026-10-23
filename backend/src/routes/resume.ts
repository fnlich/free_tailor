import { Router, Request, Response } from 'express';
import { isAdmin, requireAdmin, requireUser } from '../middleware/auth';
import { requestSignal } from '../middleware/requestSignal';
import { parseTailoredResumeContent, tailorResume } from '../services/resumeService';
import {
  getOrCreateAnalysis,
  JOB_ANALYSIS_MIN_LENGTH,
  loadAnalysis,
  type StoredJobAnalysis,
} from '../services/jobAnalysis/gate';
import { jobFieldLabel, listJobFieldsForClient } from '../config/jobFields';
import { generatePreviewHTML } from '../generators/pdfGenerator';
import { noTemplateAvailable, resolveTemplateForResume } from '../services/templateChoice';
import { getAppSettings, getUserAppSettings } from '../config/aiModelConfig';
import { effectiveOutputPathSuffix } from '../services/outputPath';
import { normalizeAiPreferences, resolveAiChoice, type AiPreferences } from '../config/aiPreferences';
import type { BuildMode } from '../config/buildModes';
import { issuePreviewToken } from '../services/credits/previewToken';
import { PublicError, sendPublicError } from '../middleware/publicError';
import { confirmSkill, createSkill, deleteSkillHandler, listSkills, updateSkillHandler } from '../controllers/skills';
import { getResumeFor } from '../database/resumeRepository';
import { anyProfile } from '../database/profileTree';
import { getDb } from '../database/sqlite';
import { resumeForTemplate } from '../services/resumeDocument';
import { resumeLabelOf } from '../services/profileRules';
import { planRun, readBuildMode, resolveRunTarget } from '../services/resumeChoice';
import type { TaskMatch } from '../services/resumeMatch';
import type { Resume } from '../types/resume';
import type { JobAnalysis, TailoredContent } from '../types/template';

const router = Router();
/**
 * Everything below needs a signed-in account.
 *
 * At the router rather than per route, so a route added later is protected by
 * default. Before v2 these were open, which was defensible with one user on one
 * machine and is not once resumes belong to people.
 */
router.use(requireUser);


// `requestSignal` - the signal that aborts a model call when the client goes
// away - lives in middleware/requestSignal.ts now, shared with the resume
// editor's Write with AI route (routes/resumes.ts).

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



/**
 * The analysis a request builds on, through the one gate (services/jobAnalysis/
 * gate.ts): the stored one the page names by `analysisId`, else the posting's
 * - stored, in flight, or analysed now, once. Null for a posting too short to
 * analyse, which is built untailored as before.
 *
 * An analysis OBJECT in the body (`jobAnalysis`, which pages used to send) is
 * never read: the server builds only on analyses it stored, so nobody can
 * hand it a job field or a title of their own making. A named id that does
 * not exist is the caller's to fix, and said so.
 */
async function analysisForRequest(
  req: Request,
  res: Response,
  body: { analysisId?: unknown; jobDescription?: unknown; jobLink?: unknown; companyName?: unknown }
): Promise<StoredJobAnalysis | null> {
  const named = typeof body.analysisId === 'string' ? body.analysisId.trim() : '';
  if (named) {
    const stored = loadAnalysis(named);
    if (!stored) {
      throw new PublicError('That job analysis was not found. Analyse the job description again.', { status: 400 });
    }
    return stored;
  }
  const jobDescription = typeof body.jobDescription === 'string' ? body.jobDescription : '';
  const jobLink = typeof body.jobLink === 'string' ? body.jobLink : '';
  if (!jobDescription.trim() && !jobLink.trim()) return null;
  return getOrCreateAnalysis({
    jd: jobDescription,
    link: jobLink,
    requestedBy: req.user?.id ?? null,
    // Recorded on the stored analysis for the Job Data Lake's merge, which
    // hashes a job on its company; never part of the posting's identity.
    ...(typeof body.companyName === 'string' ? { company: body.companyName } : {}),
    signal: requestSignal(req, res),
  });
}

/**
 * An analysis as a page reads it: the analysis, its stored id (what the page
 * sends back to build on it) and its job field's label beside the id.
 */
function analysisResponse(stored: StoredJobAnalysis) {
  const { sourceJobDescription: _text, ...analysis } = stored.analysis;
  return { ...analysis, analysisId: stored.id, jobFieldLabel: jobFieldLabel(stored.jobFieldId) };
}

/**
 * The models a signed-in account may pick, and the builder's defaults.
 *
 * Every account reads this, so it is the slim `UserAppSettings` and nothing
 * more: ids and display names, no providers, CLI model names, prices, locks or
 * the administrator's shared sheets. Admin pages read /api/admin/settings.
 * `outputPathUsesJobTitle` is the reader's own: whether THEIR folder path
 * files by `{{role}}`.
 */
router.get('/models', async (req: Request, res: Response) => {
  try {
    const settings = await getUserAppSettings(effectiveOutputPathSuffix(req.user!.id));
    res.json(settings);
  } catch {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

/*
 * The skill library is ONE store, read for every account's resumes, and
 * managed from the admin Skill Library page. Reading it and confirming a skill
 * typed into a resume (additive and idempotent - the resume editor's own
 * flow) stay open to every account; adding one with its category and
 * priority, changing one and deleting one are the library management that
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

/**
 * The job fields a posting is classified into, for the pages that show or
 * filter by one: `{ areas, fields: [{ id, label, area }], unclassified }`.
 */
router.get('/job-fields', (_req: Request, res: Response) => {
  res.json(listJobFieldsForClient());
});

/**
 * Analyse a job description: the builder's first step.
 *
 * Through the one gate, so a posting is analysed once, ever - this request,
 * an earlier one, a sheet run or the Job Filter, whichever came first - on the
 * administrator's analysis model. Body `{ jobDescription, jobLink? }`; a
 * `model` or `promptId` in it is not read (one analysis model, one analysis
 * prompt). Answers the analysis with `analysisId`, which the page sends to
 * preview, generate and batches to build on it.
 */
router.post('/analyze', async (req: Request, res: Response) => {
  const requestStartedAt = process.hrtime.bigint();
  try {
    const { jobDescription, jobLink, companyName } = req.body as {
      jobDescription?: unknown;
      jobLink?: unknown;
      companyName?: unknown;
    };
    if (typeof jobDescription !== 'string' || jobDescription.trim().length < JOB_ANALYSIS_MIN_LENGTH) {
      res.status(400).json({ error: `Job description must be at least ${JOB_ANALYSIS_MIN_LENGTH} characters` });
      return;
    }

    // The company, when the caller knows it, goes onto the stored analysis
    // like every other builder route's (never part of the posting's identity).
    const stored = await analysisForRequest(req, res, { jobDescription, jobLink, companyName });
    if (!stored) {
      res.status(400).json({ error: `Job description must be at least ${JOB_ANALYSIS_MIN_LENGTH} characters` });
      return;
    }
    console.log(`[Resume timing] /resume/analyze finished in ${formatDuration(requestStartedAt, process.hrtime.bigint())}`);
    res.json(analysisResponse(stored));
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to analyze the job description');
  }
});

/**
 * The Job Keyword Prompt Test page. Administrators only, and through the same
 * gate as everything else: a posting is analysed once, ever, and an
 * administrator testing a prompt is no exception (owner decision J0). So it
 * answers the posting's analysis - stored, or made now on the analysis model
 * with the analysis and Job Facts (Filter) prompts as they stand (its two
 * calls) - and an edited prompt is tried on a posting never analysed before.
 * `promptId` and `model` are not read.
 */
router.post('/analyze-prompt-test', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { jobDescription, jobLink } = req.body as { jobDescription?: unknown; jobLink?: unknown };
    if (typeof jobDescription !== 'string' || jobDescription.trim().length < JOB_ANALYSIS_MIN_LENGTH) {
      res.status(400).json({ error: `Job description must be at least ${JOB_ANALYSIS_MIN_LENGTH} characters` });
      return;
    }
    const stored = await analysisForRequest(req, res, { jobDescription, jobLink });
    if (!stored) {
      res.status(400).json({ error: `Job description must be at least ${JOB_ANALYSIS_MIN_LENGTH} characters` });
      return;
    }
    res.json({ ...analysisResponse(stored), source: stored.source, createdAt: stored.createdAt });
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to test the job description prompt');
  }
});

/**
 * The model a single request asks for.
 *
 * An override for THIS run only. Absent, it falls through to the resume's own
 * setting and then to the app default, which is why it is normalized into
 * preferences rather than resolved here.
 */
function readAiOverrides(body: unknown): AiPreferences {
  const record = (body ?? {}) as Record<string, unknown>;
  return normalizeAiPreferences({
    modelId: typeof record.model === 'string' ? record.model : undefined,
  });
}

/**
 * What the preview's answer says about the resume it drew: the person, the
 * resume, the mode and why this resume was chosen. `match` is null for a
 * re-render of content a page already holds, which chooses nothing.
 */
function previewIdentity(
  resume: Resume,
  profile: { id: string; name: string } | null,
  buildMode: BuildMode,
  match: TaskMatch | null
) {
  return {
    profileId: profile?.id ?? resume.profileId ?? null,
    profileName: profile?.name ?? null,
    resumeId: resume.id,
    resumeLabel: resumeLabelOf(resume),
    buildMode,
    match,
  };
}

/**
 * Preview a resume: exactly one of
 *
 *  - `{ profileId, buildMode?, ...posting, templateId?, model? }`: CHOOSE, then
 *    preview. The resume is chosen as a run would choose it for this posting
 *    (services/resumeChoice.ts `planRun`: the matcher's pick for Choose
 *    Suitable Resume and Partial Tailor, the profile's effective default for
 *    Fully Tailor). Choose Suitable Resume draws it as written - no model call,
 *    `tailored: false`, no token. Partial and Fully tailor it and answer a
 *    `previewToken` for (this account, that resume, that mode), which
 *    finalising presents to be charged that mode's price. A posting too short
 *    to analyse is drawn as written, untailored, in every mode.
 *  - `{ resumeId, tailoredContent, ... }`: a RE-RENDER of content the page
 *    holds (re-read against the resume as it is now). No model call, no token.
 *
 * The answer adds `profileId`, `profileName`, `resumeId`, `resumeLabel`,
 * `buildMode` and `match` (why this resume), so the page can send back
 * `previewedResumeId` and show the choice.
 */
router.post('/preview', async (req: Request, res: Response) => {
  const requestStartedAt = process.hrtime.bigint();
  console.log('[Resume timing] /resume/preview started');
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const profileId = typeof body.profileId === 'string' ? body.profileId.trim() : '';
    const resumeId = typeof body.resumeId === 'string' ? body.resumeId.trim() : '';
    const templateId = typeof body.templateId === 'string' ? body.templateId : undefined;
    const requestedMode = readBuildMode(body.buildMode);
    const mode: BuildMode = requestedMode ?? (await getAppSettings()).defaultBuildMode;

    if (profileId && resumeId) {
      throw new PublicError('Name the profile to preview, or the resume to show again, not both.', {
        status: 400,
        code: 'profile-or-resume',
      });
    }
    if (!profileId && !resumeId) {
      throw new PublicError('Choose a profile to preview.', { status: 400, code: 'profile-required' });
    }

    if (resumeId) {
      // A RE-RENDER of content the page holds: no choice, no model call.
      const heldContent = body.tailoredContent;
      if (!heldContent || typeof heldContent !== 'object' || Array.isArray(heldContent)) {
        throw new PublicError('Send the previewed content to show it again, or name the profile to preview.', {
          status: 400,
          code: 'content-required',
        });
      }
      const resume = getResumeFor(req.user ?? null, resumeId);
      if (!resume) {
        res.status(404).json({ error: 'Resume not found' });
        return;
      }
      if (resume.disabled) {
        res.status(400).json({ error: 'Selected resume is disabled' });
        return;
      }
      const template = await resolveTemplateForResume(resume, templateId);
      if (!template) throw noTemplateAvailable();

      // Existing/manual content is re-read against the resume as it is now
      // (parseTailoredResumeContent) - never tailored or revised again: a model
      // call is what was paid for. Read through the template, as the render
      // does: a switch the template has no section for is off for the model too.
      const storedAnalysis = await analysisForRequest(req, res, body);
      const analysis = storedAnalysis?.analysis;
      let tailoredContent = heldContent as TailoredContent;
      if (analysis) {
        tailoredContent = parseTailoredResumeContent(
          JSON.stringify(tailoredContent),
          resumeForTemplate(resume, template),
          analysis
        );
      }
      const html = await timeResumeStage('Preview HTML generation', () =>
        generatePreviewHTML(resume, template, tailoredContent)
      );
      const profile = resume.profileId ? anyProfile(getDb(), resume.profileId) : null;
      console.log(`[Resume timing] /resume/preview finished in ${formatDuration(requestStartedAt, process.hrtime.bigint())}`);
      res.json({
        html,
        tailored: true,
        tailoredContent,
        ...(storedAnalysis ? { analysisId: storedAnalysis.id } : {}),
        ...previewIdentity(resume, profile, mode, null),
      });
      return;
    }

    // CHOOSE, then preview. The refusals that cost nothing come first: another
    // account's or unknown profile (404), one with no enabled resume (400), a
    // model the request may not use (400) - all before the posting is analysed.
    const admin = isAdmin(req);
    const overrides = readAiOverrides(body);
    const unit = await resolveRunTarget(req.user ?? null, profileId, { preview: true });
    if (mode !== 'suitable' && overrides.modelId) {
      await resolveAiChoice(overrides, unit.defaultResume ?? unit.candidates[0], { admin });
    }

    // One analysis, through the gate: the one the page names, else the
    // posting's own - stored, or made now, once. None for a posting too short.
    const storedAnalysis = await analysisForRequest(req, res, body);
    const analysis: JobAnalysis | undefined = storedAnalysis?.analysis;

    const [planned] = await planRun(
      [
        {
          analysis: analysis ?? null,
          text: typeof body.jobDescription === 'string' ? body.jobDescription : '',
          title: typeof body.role === 'string' ? body.role : '',
          ...(storedAnalysis ? { analysisId: storedAnalysis.id } : {}),
        },
      ],
      unit,
      mode
    );
    const resume = planned.resume;

    const template = await resolveTemplateForResume(resume, templateId);
    if (!template) throw noTemplateAvailable();

    // Choose Suitable Resume tailors nothing: the resume is drawn as written.
    // Partial and Fully call the model, and only content THIS request wrote
    // gets a token naming its mode; a posting with no analysis is drawn as
    // written too (nothing to tailor to).
    let tailoredContent: TailoredContent | undefined;
    let previewToken: string | undefined;
    if (mode !== 'suitable' && analysis) {
      const choice = await resolveAiChoice(overrides, resume, { admin });
      // Tailored through the template it will be drawn with: a section that
      // template cannot print is off for the model too (`resumeForTemplate`).
      tailoredContent = await tailorResume(
        resumeForTemplate(resume, template),
        analysis,
        choice,
        mode,
        requestSignal(req, res),
        { analysisId: storedAnalysis?.id ?? null, templateId: template.id ?? null }
      );
      previewToken = issuePreviewToken({ userId: req.user!.id, resumeId: resume.id, buildMode: mode });
    }

    const html = await timeResumeStage('Preview HTML generation', () =>
      generatePreviewHTML(resume, template, tailoredContent)
    );

    console.log(`[Resume timing] /resume/preview finished in ${formatDuration(requestStartedAt, process.hrtime.bigint())}`);
    res.json({
      html,
      tailored: !!tailoredContent,
      tailoredContent,
      ...(previewToken ? { previewToken } : {}),
      ...(storedAnalysis ? { analysisId: storedAnalysis.id } : {}),
      ...previewIdentity(resume, unit.profile, mode, planned.match),
    });
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to generate the preview');
  }
});

export default router;
