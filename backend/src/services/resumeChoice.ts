import { isBuildMode, type BuildMode } from '../config/buildModes';
import { PublicError } from '../middleware/publicError';
import { listResumesFor, NO_PROFILES_TO_BUILD, type Viewer } from '../database/resumeRepository';
import { fileUnfiledResumesFor, requireOwnProfile } from '../database/profileTree';
import { readPreviewToken } from './credits/previewToken';
import { loadAnalysis } from './jobAnalysis/gate';
import { effectiveDefaultResumeId, resumeLabelOf } from './profileRules';
import { chooseForJob, type TaskMatch } from './resumeMatch';
import type { Profile } from '../types/profile';
import type { Resume } from '../types/resume';
import type { JobAnalysis } from '../types/template';

/**
 * Which resume a run builds for each job, and what that costs.
 *
 * A MONEY module (test/money.test.js lists it): a run costs exactly its jobs
 * times the build mode's price, in thousandths of a dollar, summed as integers.
 * Nothing here rounds, floors or parses a float.
 *
 * A run names exactly ONE profile (a person), on every subscription:
 * `readRunRequest` reads and refuses the request's shape, `resolveRunTarget`
 * finds the person and their enabled resumes, `planRun` chooses a resume for
 * each job (Choose Suitable Resume and Partial Tailor: the matcher's pick;
 * Fully Tailor: the profile's effective default), `checkPreview` refuses a run
 * that would build something other than what the page previewed, and
 * `priceRun` prices each planned resume. routes/generation.ts calls them in
 * that order, before anything is reserved, charged or asked of a model, so
 * every refusal here costs nothing.
 *
 * The choice is made ONCE, at submit: the plan is written onto each task's label
 * and its order item, and a restored task builds the resume its payload names
 * and never chooses again.
 */

// -- Refusals ----------------------------------------------------------------- //

/**
 * A run request refused for what it asked for, written for anybody: 400
 * `one-profile-per-run`, `bad-build-mode`, `bad-previewed-resume`,
 * `suitable-takes-no-content`, and 409 `preview-changed`.
 */
export class RunRequestError extends PublicError {
  constructor(message: string, code: string, status = 400, extra?: Record<string, unknown>) {
    super(message, { status, code, ...(extra ? { extra } : {}) });
    this.name = 'RunRequestError';
  }
}

const ONE_PROFILE_PER_RUN ='Choose one profile to build for.';
const BAD_BUILD_MODE = 'buildMode must be "suitable", "partial" or "full".';
const SUITABLE_TAKES_NO_CONTENT =
  'Choose Suitable Resume builds each resume as written, so it takes no previewed content.';

// -- The request -------------------------------------------------------------- //

/** What a run request carries, after its shape is checked. */
export type RunRequest = {
  /** The one profile (person) the run builds for. */
  profileId: string;
  /** Absent: the administrator's default builder mode in effect (the route reads it). */
  buildMode?: BuildMode;
  /** The resume a preview showed, when the page finalises a preview. */
  previewedResumeId?: string;
  /** Tailored content a preview produced, by resume id: only entries that are objects. */
  suppliedContent: Record<string, unknown>;
  /** Each preview's token, by resume id: only entries that are text. */
  previewTokens: Record<string, string>;
};

function hasOwn(source: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A request's `buildMode`: the mode it names, or undefined when it names none
 * (absent or null - the route then uses the administrator's default). Anything
 * else is 400 `bad-build-mode`. Shared by the run routes and the preview.
 */
export function readBuildMode(value: unknown): BuildMode | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isBuildMode(value)) throw new RunRequestError(BAD_BUILD_MODE, 'bad-build-mode');
  return value;
}

/**
 * Reads the shape of a run request (`POST /generation/batches` and `/quote`),
 * refusing with a 400 what could never work:
 *
 *  - no `profileId`, one that is not text, or a `profileIds` / `resumeIds` of
 *    any shape: `one-profile-per-run` - an old client's list would otherwise be
 *    read as "no profile" or silently as one;
 *  - a `buildMode` that is not one of the three: `bad-build-mode`;
 *  - a `previewedResumeId` that is not text: `bad-previewed-resume`;
 *  - Choose Suitable Resume together with previewed content or a token:
 *    `suitable-takes-no-content` (checked again with the mode in effect when
 *    the request names none, `assertSuitableTakesNoContent`).
 *
 * Whether the profile exists, is the caller's and has an enabled resume is
 * `resolveRunTarget`'s.
 */
export function readRunRequest(body: unknown): RunRequest {
  const source: Record<string, unknown> = isPlainObject(body) ? body : {};

  if (
    (hasOwn(source, 'profileIds') && source.profileIds !== undefined) ||
    (hasOwn(source, 'resumeIds') && source.resumeIds !== undefined)
  ) {
    throw new RunRequestError(ONE_PROFILE_PER_RUN, 'one-profile-per-run');
  }
  const profileId = typeof source.profileId === 'string' ? source.profileId.trim() : '';
  if (!profileId) throw new RunRequestError(ONE_PROFILE_PER_RUN, 'one-profile-per-run');

  const buildMode = readBuildMode(source.buildMode);

  let previewedResumeId: string | undefined;
  if (source.previewedResumeId !== undefined && source.previewedResumeId !== null && source.previewedResumeId !== '') {
    if (typeof source.previewedResumeId !== 'string' || !source.previewedResumeId.trim()) {
      throw new RunRequestError('previewedResumeId must be the id of the resume the preview showed.', 'bad-previewed-resume');
    }
    previewedResumeId = source.previewedResumeId.trim();
  }

  const suppliedContent: Record<string, unknown> = {};
  if (isPlainObject(source.tailoredContentByResumeId)) {
    for (const [resumeId, content] of Object.entries(source.tailoredContentByResumeId)) {
      if (isPlainObject(content)) suppliedContent[resumeId] = content;
    }
  }
  const previewTokens: Record<string, string> = {};
  if (isPlainObject(source.previewTokenByResumeId)) {
    for (const [resumeId, token] of Object.entries(source.previewTokenByResumeId)) {
      if (typeof token === 'string' && token) previewTokens[resumeId] = token;
    }
  }

  const request: RunRequest = {
    profileId,
    ...(buildMode ? { buildMode } : {}),
    ...(previewedResumeId ? { previewedResumeId } : {}),
    suppliedContent,
    previewTokens,
  };
  if (buildMode) assertSuitableTakesNoContent(buildMode, request);
  return request;
}

/** 400 `suitable-takes-no-content`: Choose Suitable Resume with previewed content or a preview token. */
export function assertSuitableTakesNoContent(
  mode: BuildMode,
  request: Pick<RunRequest, 'suppliedContent' | 'previewTokens'>
): void {
  if (mode !== 'suitable') return;
  if (Object.keys(request.suppliedContent).length > 0 || Object.keys(request.previewTokens).length > 0) {
    throw new RunRequestError(SUITABLE_TAKES_NO_CONTENT, 'suitable-takes-no-content');
  }
}

// -- The target --------------------------------------------------------------- //

/** The one profile a run builds for, and the resumes it can build from. */
export type RunUnit = {
  profile: Profile;
  /** The profile's name at submit: what the order label, the log and the order items show. */
  profileLabel: string;
  /** The profile's ENABLED resumes, newest first. Never empty. */
  candidates: Resume[];
  /** The effective default (a disabled choice is skipped); what Fully Tailor builds from. */
  defaultResume: Resume | null;
};

function newestFirst(left: Resume, right: Resume): number {
  const a = Date.parse(left.updatedAt);
  const b = Date.parse(right.updatedAt);
  const aTime = Number.isNaN(a) ? 0 : a;
  const bTime = Number.isNaN(b) ? 0 : b;
  if (aTime !== bTime) return bTime > aTime ? 1 : -1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * The profile a run builds for and its resumes. Files the caller's unfiled
 * resumes first (lazy filing), so an account that has not opened its dashboard
 * since the upgrade still has its people.
 *
 * 404 `profile-not-found` for an unknown profile or another account's - an
 * administrator's included; 400 `no-profiles-to-build` (`NO_PROFILES_TO_BUILD`)
 * for a profile with no enabled resume. A PREVIEW (`options.preview`) says
 * the same thing in its own words, naming the person: "{Jane Doe} has no
 * enabled resume to preview. Add or enable one on the profile's page."
 */
export async function resolveRunTarget(
  viewer: Viewer,
  profileId: string,
  options: { preview?: boolean } = {}
): Promise<RunUnit> {
  if (!viewer) {
    // A run always has a signed-in account; a viewer of nobody owns no profile.
    throw new RunRequestError('That profile was not found. It may have been deleted; reload the page.', 'profile-not-found', 404);
  }
  fileUnfiledResumesFor(viewer);
  const profile = requireOwnProfile(viewer, profileId);

  const members = listResumesFor(viewer, { includeDisabled: true }).filter((resume) => resume.profileId === profile.id);
  const candidates = members.filter((resume) => !resume.disabled).sort(newestFirst);
  if (candidates.length === 0) {
    throw new RunRequestError(
      options.preview
        ? `${profile.name} has no enabled resume to preview. Add or enable one on the profile's page.`
        : NO_PROFILES_TO_BUILD,
      'no-profiles-to-build'
    );
  }

  const defaultId = effectiveDefaultResumeId(
    profile.defaultResumeId,
    members.map((resume) => ({ id: resume.id, disabled: Boolean(resume.disabled), createdAt: resume.createdAt }))
  );
  const defaultResume = candidates.find((resume) => resume.id === defaultId) ?? null;
  return { profile, profileLabel: profile.name, candidates, defaultResume };
}

// -- The plan ----------------------------------------------------------------- //

/** One resume to build: which job it is for, which resume, and why it was chosen. */
export type PlannedItem = { jobIndex: number; resume: Resume; match: TaskMatch };

/** What the matcher reads of a job: its analysis (or the id of the stored one), its text and its title. */
type PlanJob = {
  analysis?: JobAnalysis | null;
  text?: string;
  title?: string;
  analysisId?: string;
};

/** Jobs between two yields to the event loop, so a long sheet run does not hold the server's other requests. */
const JOBS_PER_YIELD = 25;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * The resume chosen for each job, in job order - one planned item per job.
 *
 *  - Fully Tailor: the profile's effective default, reason `default`;
 *  - one enabled resume: that one, reason `only`;
 *  - otherwise `chooseForJob` on the job's analysis (the stored one its
 *    `analysisId` names, else the `analysis` given), its text and its title.
 */
export async function planRun(jobs: readonly PlanJob[], unit: RunUnit, mode: BuildMode): Promise<PlannedItem[]> {
  const candidates = unit.candidates;
  const candidateCount = candidates.length;
  const fixed = mode === 'full' ? unit.defaultResume ?? candidates[0] : candidateCount === 1 ? candidates[0] : null;
  const fixedReason: TaskMatch['reason'] = mode === 'full' ? 'default' : 'only';
  const matchCandidates = fixed
    ? []
    : candidates.map((resume) => ({ resume, isDefault: resume.id === unit.defaultResume?.id }));

  const plan: PlannedItem[] = [];
  for (const [jobIndex, job] of jobs.entries()) {
    if (jobIndex > 0 && jobIndex % JOBS_PER_YIELD === 0) await yieldToEventLoop();
    if (fixed) {
      plan.push({
        jobIndex,
        resume: fixed,
        match: { v: 1, mode, reason: fixedReason, candidates: candidateCount },
      });
      continue;
    }
    const analysis = job.analysis ?? (job.analysisId ? loadAnalysis(job.analysisId)?.analysis ?? null : null);
    const { resume, match } = chooseForJob(
      {
        analysis,
        ...(job.text !== undefined ? { text: job.text } : {}),
        ...(job.title !== undefined ? { title: job.title } : {}),
      },
      matchCandidates,
      mode
    );
    plan.push({ jobIndex, resume, match });
  }
  return plan;
}

/**
 * 409 `preview-changed`: the run would build a resume the preview did not show.
 *
 * Applies only when the request sent a `previewedResumeId` or any previewed
 * content: every planned resume must then be the previewed one or one of the
 * content's keys. Otherwise the profile's resumes changed (or the posting's
 * analysis did) since the page previewed, and building something else - at the
 * price of what was shown - is refused BEFORE anything is reserved or charged.
 * `profileName` is the profile's name for the sentence (the resume's own name
 * when the caller has none to give).
 */
export function checkPreview(
  plan: readonly PlannedItem[],
  previewedResumeId: string | undefined,
  suppliedKeys: readonly string[],
  profileName?: string
): void {
  if (!previewedResumeId && suppliedKeys.length === 0) return;
  const shown = new Set<string>(suppliedKeys);
  if (previewedResumeId) shown.add(previewedResumeId);
  const unexpected = plan.find((item) => !shown.has(item.resume.id));
  if (!unexpected) return;
  const resume = unexpected.resume;
  const who = profileName?.trim() || resume.name || 'This profile';
  throw new RunRequestError(
    `${who}'s resumes have changed since the preview: this run would now build ${resumeLabelOf(resume)}. Preview again.`,
    'preview-changed',
    409,
    { profileId: resume.profileId ?? null, resumeId: resume.id }
  );
}

// -- The price ---------------------------------------------------------------- //

/**
 * What each planned resume costs, in thousandths of a dollar, and the sum.
 *
 * A resume costs its build mode's price. Previewed content is the exception:
 * content a request supplies for a resume without a preview token valid for
 * (this account, that resume, THIS mode) costs at least the dearest mode's
 * price (`max(prices[mode], prices.partial, prices.full)`) - content of unknown
 * origin is charged as if it had been written the dearest way, and a token for
 * Partial Tailor does not pay for Fully Tailor's work. Administrators are
 * never held to the floor; they are not charged at all (credits `reserveCredits`
 * exempts them), and their figure is the mode's own, as a quote shows them.
 */
export function priceRun(args: {
  plan: readonly PlannedItem[];
  mode: BuildMode;
  prices: Record<BuildMode, number>;
  suppliedContent: Record<string, unknown>;
  previewTokens: Record<string, string>;
  userId: string;
  admin: boolean;
}): { costs: number[]; totalMilli: number } {
  const { mode, prices } = args;
  const base = prices[mode];
  const floor = Math.max(base, prices.partial, prices.full);
  const costs = args.plan.map((item) => {
    if (args.admin) return base;
    const resumeId = item.resume.id;
    if (!Object.prototype.hasOwnProperty.call(args.suppliedContent, resumeId)) return base;
    const tokenMode = readPreviewToken(args.previewTokens[resumeId], { userId: args.userId, resumeId });
    return tokenMode === mode ? base : floor;
  });
  return { costs, totalMilli: costs.reduce((sum, cost) => sum + cost, 0) };
}

/**
 * The same price for a run not planned yet - `/generation/quote`, which asks
 * while the form is still being filled in and makes no choice.
 *
 * Without previewed content every job costs the mode's price. With some, the
 * resume the page previewed (`previewedResumeId`, else the first content key
 * that is one of the profile's) stands for every job, exactly as finalising a
 * preview builds it; a plan that turns out different is refused at submit
 * (`checkPreview`), so the figure quoted is the figure charged.
 */
export function quoteRun(args: {
  jobCount: number;
  unit: RunUnit;
  mode: BuildMode;
  prices: Record<BuildMode, number>;
  suppliedContent: Record<string, unknown>;
  previewTokens: Record<string, string>;
  previewedResumeId?: string;
  userId: string;
  admin: boolean;
}): { resumes: number; perResumeMilli: number; totalMilli: number } {
  const byId = new Map(args.unit.candidates.map((resume) => [resume.id, resume]));
  const stand =
    (args.previewedResumeId ? byId.get(args.previewedResumeId) : undefined) ??
    Object.keys(args.suppliedContent)
      .map((id) => byId.get(id))
      .find((resume): resume is Resume => Boolean(resume)) ??
    args.unit.defaultResume ??
    args.unit.candidates[0];
  // Every job stands for the same resume, so every job costs the same: ONE
  // stand-in is priced and multiplied. A quote is lenient about the jobs it
  // counts (it validates none), so a plan of jobCount entries would let one
  // request with a body full of `{}` allocate without bound.
  const resumes = Math.max(0, args.jobCount);
  const { costs } = priceRun({
    plan: [
      {
        jobIndex: 0,
        resume: stand,
        match: { v: 1, mode: args.mode, reason: 'default', candidates: args.unit.candidates.length },
      },
    ],
    mode: args.mode,
    prices: args.prices,
    suppliedContent: args.suppliedContent,
    previewTokens: args.previewTokens,
    userId: args.userId,
    admin: args.admin,
  });
  const perResumeMilli = costs[0];
  return { resumes, perResumeMilli, totalMilli: perResumeMilli * resumes };
}
