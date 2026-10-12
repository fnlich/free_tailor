import { createHash } from 'crypto';

import type { AiChoice } from '../config/aiPreferences';
import { describeAiChoice } from '../config/aiPreferences';
import { tailorReviseMaxTerms, tailorRevisePass } from '../config/operational';
import { Profile } from '../types/profile';
import type { AIProvider, JobAnalysis, RawNestedJobAnalysis, SkillGroup, TailoredContent } from '../types/template';
import { createPromptCompletion, createPromptCompletionResult, DEFAULT_PROVIDER } from './ai';
import { UNCLASSIFIED_JOB_FIELD_ID } from '../config/jobFields';
import { normalizeJobFacts, normalizeSeniority, type JobFactsAnswer } from './jobAnalysis/facts';
import { extractJSON } from '../utils/json';
import { resolvePromptByExactId } from './promptService';
import {
  readTailorCache,
  tailorCacheKey,
  writeTailorCache,
  type TailorCacheContext,
} from './tailorCache';
import {
  DEFAULT_COVER_LETTER_PROMPT_ID,
  DEFAULT_RESUME_PROMPT_ID,
  getProfileResumeSections,
} from './profileService';
import { findSoftSkillGroup, flattenSkillGroups, sanitizeSkillGroups } from './skillGroups';
import {
  analysisForPrompt,
  buildTailorLists,
  capBullets,
  composeTailoredTitle,
  dashBackstop,
  numeralYears,
  restoreRoles,
  tailorSeed,
  type TailorLists,
} from './tailorContract';
import {
  buildReviseResumeCoveragePromptValues,
  figureCount,
  FIGURES_NOTE_WORDING,
  mergeRevision,
  missingTerms,
  REVISE_PROMPT_ID,
  revisionWanted,
} from './reviseCoverage';

/**
 * Resume and cover-letter domain logic.
 *
 * Everything about HOW a model is reached now lives in `services/ai`; this
 * module only decides what to ask, and how to read the answer. The `.env` load
 * that used to sit here (with `override: true`, quietly beating the process
 * environment for every importer) belongs to the entry point and lives in
 * index.ts.
 *
 * The tailoring prompt's promises about the code around it - the lists it is
 * sent, the draws made per resume, the title, the role facts, the bullet cap,
 * the dash backstop - are services/tailorContract.ts; the revise pass's are
 * services/reviseCoverage.ts. This file puts them together.
 */

function formatDuration(start: bigint, end: bigint): string {
  return `${(Number(end - start) / 1_000_000_000).toFixed(2)}s`;
}

function normalizeSkillsList(skills: string[] | undefined): string[] {
  if (!Array.isArray(skills)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const raw of skills) {
    if (typeof raw !== 'string') continue;
    const skill = raw.trim();
    if (!skill) continue;
    const key = skill.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(skill);
  }

  return normalized;
}

const JOB_POSTING_PERSPECTIVE_PATTERN =
  /\b(?:we|our|ours|ourselves|you|your|yours|yourself|yourselves)\b/i;
const JOB_POSTING_RECRUITING_PATTERN =
  /\b(?:join us|help us|you will|you'll|you are|you would|the ideal candidate|successful candidate|next generation|break ground|ground-breaking)\b/i;
/**
 * A sentence ABOUT the tailoring rather than about the work: "this background
 * maps to the target role", "keyword coverage for this role". Only such meta
 * phrases - never the bare word "ATS" or "job posting", which name real work
 * ("Greenhouse ATS integration", "the job posting pipeline") and dropped
 * whole keywords and bullets that carried them; nor "aligned with" on its
 * own ("releases aligned with the quarterly plan").
 */
const RESUME_META_TAILORING_PATTERN =
  /\b(?:this background maps to|background maps to|maps to|mapped to|target role|target job|keyword coverage|for this specific role|for this role|(?:aligned|aligns) with the (?:job|role|posting|target)(?: description| posting)?)\b/i;

function normalizeJobAnalysisPhrase(value: string): string {
  return value
    .replace(/^[\s\-*]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/[;:,\s]+$/, '')
    .trim();
}

function isUnsafeJobPostingPhrase(value: string): boolean {
  const normalized = normalizeJobAnalysisPhrase(value);
  if (!normalized) return true;
  return (
    JOB_POSTING_PERSPECTIVE_PATTERN.test(normalized) ||
    JOB_POSTING_RECRUITING_PATTERN.test(normalized) ||
    RESUME_META_TAILORING_PATTERN.test(normalized)
  );
}

function normalizeSafeKeywordList(values: string[]): string[] {
  return normalizeSkillsList(values)
    .map(normalizeJobAnalysisPhrase)
    .filter((item) => item && !isUnsafeJobPostingPhrase(item));
}

/**
 * The posting's responsibilities as the analysis wrote them - noun phrases,
 * which the prompt asks for and the tailoring prompt writes verbatim. Cleaned
 * of a trailing full stop, and an employer-voiced or meta one dropped; never
 * reworded (a rewrite of a leading verb once turned "design system
 * maintenance" into "system maintenance delivery").
 */
function normalizeSafeResponsibilityList(values: string[]): string[] {
  return normalizeSkillsList(values)
    .map((value) => normalizeJobAnalysisPhrase(value).replace(/\.$/, ''))
    .filter((item) => item && !isUnsafeJobPostingPhrase(item));
}


function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return [];
}

/** The keyword half of an analysis: everything the first call reads, nothing the facts call does. */
export type JobAnalysisKeywords = Omit<JobAnalysis, 'jobField' | 'industry' | 'salary' | 'filter'>;

/**
 * The analysis call's answer as the keyword half of a JobAnalysis, every
 * value checked here: keyword lists cleaned, soft skills in the posting's own
 * order (explicit first, as the prompt asks - never re-sorted), the
 * responsibilities as written. A `jobField`, `industry`, `salary` or `filter`
 * key in the answer is IGNORED: an administrator's edit written for the
 * older prompt still asks for them, and those facts are the facts call's
 * (`normalizeJobFacts`) - read here, an `industry` would beat the company
 * category for ever and a `jobField` would compete with the code's own line.
 */
export function normalizeJobAnalysisKeywords(
  parsed: RawNestedJobAnalysis,
  jobDescription: string
): JobAnalysisKeywords {
  const technical = normalizeSafeKeywordList([
    ...toStringList(parsed.skills?.technical),
    ...toStringList(parsed.skills?.required),
  ]);
  const required = normalizeSkillsList(technical);
  const preferred = normalizeSkillsList([
    ...toStringList(parsed.skills?.preferred),
  ]);
  const tools = normalizeSkillsList(toStringList(parsed.skills?.tools));
  const soft = normalizeSkillsList([
    ...toStringList(parsed.skills?.soft),
    ...toStringList(parsed.softSkills),
  ]);
  const technologies = normalizeSafeKeywordList([
    ...toStringList(parsed.technologies),
    ...toStringList(parsed.skills?.technologies),
  ]);
  const protocols = normalizeSafeKeywordList(toStringList(parsed.protocols));
  const methodologies = normalizeSafeKeywordList(toStringList(parsed.methodologies));
  const architecturePatterns = normalizeSafeKeywordList(toStringList(parsed.architecturePatterns));
  const responsibilities = normalizeSafeResponsibilityList([
    ...toStringList(parsed.responsibilities),
  ]);
  const domainKnowledge = normalizeSafeKeywordList([
    ...toStringList(parsed.domainKnowledge),
  ]);
  const keywordGroups = parsed.keywords && typeof parsed.keywords === 'object' && !Array.isArray(parsed.keywords)
    ? parsed.keywords as Record<string, unknown>
    : {};

  return {
    jobMeta: {
      title: asString(parsed.jobMeta?.title),
      seniority: normalizeSeniority(parsed.jobMeta?.seniority),
      industry: asString(parsed.jobMeta?.industry),
      department: asString(parsed.jobMeta?.department),
    },
    skills: {
      technical,
      required,
      preferred,
      tools,
      soft,
      technologies,
    },
    technologies,
    protocols,
    methodologies,
    architecturePatterns,
    responsibilities,
    domainKnowledge,
    softSkills: soft,
    keywords: {
      actionVerbs: normalizeSafeKeywordList(toStringList(keywordGroups.actionVerbs)),
      buzzwords: normalizeSafeKeywordList(toStringList(keywordGroups.buzzwords)),
      mustInclude: normalizeSafeKeywordList([
        ...toStringList(keywordGroups.mustInclude),
      ]),
    },
    sourceJobDescription: jobDescription.trim(),
  };
}

/**
 * One analysis out of its two calls' answers: the keywords, then the facts.
 * Never an `industry` key - a new analysis's industry is derived from the
 * facts call's company category when it is read (`industryOf`). A facts
 * answer that names no job field is `unclassified` here; the gate has asked
 * twice by then.
 */
export function composeJobAnalysis(keywords: JobAnalysisKeywords, facts: JobFactsAnswer): JobAnalysis {
  const { sourceJobDescription, ...keywordFields } = keywords;
  return {
    ...keywordFields,
    // Checked against the closed list in code (`normalizeJobFieldId`): a
    // field the model invents, or one from the area that is not offered, is
    // `unclassified`.
    jobField: facts.jobField ?? UNCLASSIFIED_JOB_FIELD_ID,
    salary: facts.salary,
    filter: facts.filter,
    sourceJobDescription,
  };
}

function isCompanyDescriptionLike(value: string, company?: string): boolean {
  const normalized = value.trim().replace(/\s+/g, ' ');
  const companyName = company?.trim();
  if (!normalized || !companyName) return false;

  const escapedCompany = companyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const companyLeadPattern = new RegExp(
    `^(?:category:\\s*)?${escapedCompany}\\b\\s+(?:is|are|was|were|builds|provides|offers|serves|uses|aims|helps|connects|creates|develops|delivers)\\b`,
    'i'
  );
  const marketingContextPattern = new RegExp(
    `\\b${escapedCompany}\\b.{0,80}\\b(?:founded|headquartered|acquired|serves|customers|platform|company|nonprofit|non-profit)\\b`,
    'i'
  );

  return companyLeadPattern.test(normalized) || marketingContextPattern.test(normalized);
}

function stripUnsafeResumeSentences(value: string, company?: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) return '';

  const sentences = normalized.split(/(?<=[.!?])\s+/);
  const safeSentences = sentences
    .map((sentence) => sentence.trim())
    .filter((sentence) =>
      sentence &&
      !isUnsafeJobPostingPhrase(sentence) &&
      !isCompanyDescriptionLike(sentence, company)
    );

  return safeSentences.join(' ').trim();
}

/**
 * The profile as the MODEL needs to see it.
 *
 * Built by naming what goes in rather than by spreading the record and deleting
 * from it, so a field added to `Profile` later is not sent to a model provider
 * by default and noticed by nobody.
 *
 * Three groups are left out, and each for its own reason:
 *
 * - `id`, `createdAt`, `updatedAt` are this database's bookkeeping. They mean
 *   nothing to a model rewriting a summary.
 * - `profileSettings` is the operator's own configuration: which prompt
 *   records to use, their output file-name templates, and which AI model they
 *   pay for. Sending it put the operator's tooling choices into a third
 *   party's model input for no purpose whatever.
 * - `contact` is a phone number, an email address and social links. This call
 *   rewrites the summary, the experience and the skills; it is never asked for
 *   contact details and the rendered resume takes them straight from the
 *   profile. No prompt in this app so much as mentions them.
 *
 * Measured on a five-role profile, together with dropping the pretty-printing:
 * the profile went from 7,428 characters to 5,363 and the whole tailoring
 * payload from 9,365 to 6,942 - 26% less, with nothing the model reads removed.
 *
 * And two lists are not sent as they stand. `strengths` goes only while the
 * Strengths switch is on: switched off, the person has said those are not for
 * this resume, and "off" means the model is not given them either - they stay
 * with the profile, unsent, until the box is ticked. (The resume prints the
 * profile's own strengths, never a model's; sent, they are context.)
 * `softSkills` is never here: the soft skills a tailored resume prints are
 * the posting's, the last group of the model's skills block, and an untailored
 * one prints the profile's own.
 */
function buildPromptProfile(profile: Profile): Record<string, unknown> {
  const sections = getProfileResumeSections(profile);
  return {
    name: profile.name,
    title: profile.title,
    totalYearsExperience: profile.totalYearsExperience,
    summary: profile.summary,
    experience: profile.experience.map((experience) => ({
      title: experience.title,
      company: experience.company,
      startDate: experience.startDate,
      endDate: experience.endDate,
      location: experience.location,
      // The raw description is replaced, not passed alongside: it is the field
      // most likely to carry a sentence about the COMPANY rather than the
      // person, and `stripUnsafeResumeSentences` is what takes those out.
      companyContext: stripUnsafeResumeSentences(experience.description ?? '', experience.company),
      achievements: experience.achievements,
      skills: experience.skills,
    })),
    ...(sections.strengths ? { strengths: profile.strengths } : {}),
    skills: profile.skills,
    // Sent when the profile has one: the model writes the skills block, and
    // the author's own grouping is a fact about them it should not contradict.
    ...(profile.skillCategories?.length ? { skillCategories: profile.skillCategories } : {}),
    education: profile.education,
    certifications: profile.certifications,
  };
}

/**
 * JSON for a prompt: compact, not pretty.
 *
 * Two-space indentation is for a person reading a file. Nothing reads these but
 * a model, which parses both identically, and the indentation is 15-20% of the
 * payload on a nested record like a profile - paid on every call, for
 * whitespace.
 */
function promptJson(value: unknown): string {
  return JSON.stringify(value);
}

function stripBoldTags(value: string): string {
  return value.replace(/<\/?strong>/gi, '').replace(/<\/?b>/gi, '');
}

/**
 * One line of model prose made safe to print: bold tags out, and a sentence
 * written from the employer's side ("you will", "our") or about the tailoring
 * itself ("maps to the target role") dropped - the whole line when that is all
 * it was.
 */
function sanitizeResumeText(value: string): string {
  const clean = stripUnsafeResumeSentences(stripBoldTags(value), undefined);
  return isUnsafeJobPostingPhrase(clean) ? '' : clean;
}

/**
 * Whether a line of model prose prints as written: making it safe
 * (`sanitizeResumeText`) would drop none of it. The revise pass's answer is
 * taken only where it does (reviseCoverage.ts `mergeRevision`), so a revised
 * bullet or summary that says "our" never replaces the draft's with less.
 */
function printsWhole(value: string): boolean {
  const text = stripBoldTags(value).replace(/\s+/g, ' ').trim();
  return text !== '' && sanitizeResumeText(text) === text;
}

/** A list of bullets as printed: strings only, each sanitised and dash-checked, empties and repeats dropped. */
function cleanBullets(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return normalizeSkillsList(
    values
      .filter((value): value is string => typeof value === 'string')
      .map((value) => dashBackstop(sanitizeResumeText(value)))
  );
}

/**
 * The skills block when the answer brought none - an administrator's prompt
 * written for the older contract, or an answer cut short: the profile's own
 * grouping as typed, else its skills as one group. Never the library's, and
 * never empty when the profile has skills.
 */
function profileSkillGroups(profile: Profile): SkillGroup[] {
  const authored = sanitizeSkillGroups(profile.skillCategories);
  if (authored.length > 0) return authored;
  return sanitizeSkillGroups([{ category: '', skills: Array.isArray(profile.skills) ? profile.skills : [] }]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A tailoring answer as the resume it prints, read against the profile as it
 * is NOW. Run on a fresh answer, on a cached one and on a preview a page sent
 * back, so it is idempotent on its own output: every step either keeps what
 * is already in shape or recomputes from the profile and the seed.
 *
 * - The title is the profile's headline (else the model's) with the kind of
 *   role the posting is for composed onto it (`composeTailoredTitle`).
 * - The roles keep the model's order; their facts come from the profile, a
 *   role the profile lacks is dropped, one the answer left out is put back,
 *   descriptions are '' and each role keeps at most eight bullets - the ones
 *   carrying the most checklist terms (`restoreRoles`, `capBullets`). A role
 *   left with no bullet gets the profile's own, never invented text.
 * - The summary is the model's, made safe, with a spelled-out span of years
 *   written as a numeral; nothing is added to it.
 * - The skills block is the model's `skillGroups`, shape-checked and
 *   otherwise untouched: the soft-skill group is found (services/
 *   skillGroups.ts) and marked, and the heading drawn for this resume stored
 *   beside it, so a re-parse - or the render - finds the same group. The
 *   flat lists are derived from it: `hardSkills` the technical groups, and
 *   `softSkills` the soft group's skills only while the Soft Skills switch is
 *   on for the template (callers pass the profile through
 *   `profileForTemplate`).
 * - Strengths are the profile's own, while that switch is on; the prompt
 *   writes none, and one a model or an older build wrote is not read.
 * - Em and en dashes are taken out of the summary, the bullets and the
 *   cover letter (`dashBackstop`).
 */
function normalizeTailoredContent(raw: Record<string, unknown>, jobAnalysis: JobAnalysis, profile: Profile): TailoredContent {
  const sections = getProfileResumeSections(profile);
  const seed = tailorSeed(profile.id, jobAnalysis);
  const lists = buildTailorLists(jobAnalysis, seed);

  // The candidate's own headline, else the model's, else their latest role's
  // title - the chain the render falls back on (getResumeTitle) - so the kind
  // is composed onto who they are, never printed in place of it.
  const base =
    asString(profile.title) ||
    stripBoldTags(asString(raw.title)).replace(/\s+/g, ' ').trim() ||
    asString(profile.experience?.[0]?.title);
  const title = composeTailoredTitle(base, lists.targetRoleTitle, seed);

  const experience = restoreRoles(raw.experience, profile.experience ?? [], (answered, own) => {
    let bullets = cleanBullets(answered);
    if (bullets.length === 0) bullets = cleanBullets(own);
    if (bullets.length === 0) bullets = normalizeSkillsList(own.map((bullet) => dashBackstop(bullet)));
    return capBullets(bullets, lists.checklist);
  });

  const summary = dashBackstop(
    numeralYears(stripUnsafeResumeSentences(stripBoldTags(typeof raw.summary === 'string' ? raw.summary : ''), undefined))
  );

  let groups = sanitizeSkillGroups(raw.skillGroups);
  if (groups.length === 0) groups = profileSkillGroups(profile);
  const softIndex = findSoftSkillGroup(groups, lists.softSkillGroupHeading);
  const skillGroups: SkillGroup[] = groups.map((group, index) => ({
    category: group.category,
    skills: group.skills,
    ...(index === softIndex ? { soft: true as const } : {}),
  }));
  const hardSkills = flattenSkillGroups(skillGroups.filter((_group, index) => index !== softIndex));
  const softSkills = softIndex !== -1 && sections.softSkills ? flattenSkillGroups([skillGroups[softIndex]]) : [];

  return {
    title,
    summary,
    experience,
    skillGroups,
    softSkillGroupHeading: lists.softSkillGroupHeading,
    hardSkills,
    skills: hardSkills,
    softSkills,
    strengths: sections.strengths ? ownStrengths(profile) : [],
    // Always empty now: every printed skill is the model's or the profile's,
    // and none of them is checked against the library, so there is nothing
    // to offer for confirming.
    unconfirmedHardSkills: [],
    unconfirmedSoftSkills: [],
    ...(typeof raw.coverLetter === 'string' ? { coverLetter: dashBackstop(raw.coverLetter.trim()) } : {}),
  };
}

/** The profile's own strengths as they were typed, minus any with nothing in them. */
function ownStrengths(profile?: Profile): TailoredContent['strengths'] {
  return (profile?.strengths ?? [])
    .map((strength) => ({
      title: typeof strength?.title === 'string' ? strength.title.trim() : '',
      description: typeof strength?.description === 'string' ? strength.description.trim() : '',
    }))
    .filter((strength) => strength.title || strength.description);
}

/**
 * The analysis prompt's values: the posting, and its link. The shipped text
 * uses the posting alone, at its very end, so everything before it is the
 * cached system part. Only services/jobAnalysis/gate.ts runs this prompt.
 */
export function buildAnalyzeJobDescriptionPromptValues(
  jobDescription: string,
  jobLink = ''
): Record<string, string> {
  return {
    jobDescription,
    jobLink: jobLink.trim(),
  };
}

/**
 * The Job Facts (Filter) prompt's values (the analysis's second call): the
 * same posting and link. The job field list it also needs is not a value: it
 * is code-owned text the gate sends beside the record
 * (services/jobAnalysis/jobFieldLine.ts), which no edit can drop. Only the
 * gate runs this prompt.
 */
export function buildJobFactsPromptValues(
  jobDescription: string,
  jobLink = ''
): Record<string, string> {
  return {
    jobDescription,
    jobLink: jobLink.trim(),
  };
}

/** The analysis call's answer as the keyword half (`normalizeJobAnalysisKeywords`); throws on an answer that is not JSON. */
export function parseJobAnalysisKeywords(content: string, jobDescription: string): JobAnalysisKeywords {
  try {
    const jsonText = extractJSON(content);
    const parsed = JSON.parse(jsonText) as RawNestedJobAnalysis;
    return normalizeJobAnalysisKeywords(parsed, jobDescription);
  } catch (error) {
    console.error('Failed to parse model response:', error, content);
    throw new Error('Failed to parse job analysis response');
  }
}

/** The job facts call's answer (`normalizeJobFacts`); throws on an answer that is not a JSON object. */
export function parseJobFacts(content: string): JobFactsAnswer {
  try {
    const parsed: unknown = JSON.parse(extractJSON(content));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
    return normalizeJobFacts(parsed);
  } catch (error) {
    console.error('Failed to parse model response:', error, content);
    throw new Error('Failed to parse job facts response');
  }
}

/**
 * The tailoring prompt's values - exactly the variables promptService.ts
 * declares for the feature, which test/promptVariables.test.js holds equal.
 *
 * Every list is the posting's analysis in the posting's own spelling
 * (services/tailorContract.ts `buildTailorLists`): no skill library, no
 * profile, no setting reaches them, so the same posting gives the same lists
 * for every profile, and nothing an administrator adds to the library changes
 * what a resume is asked. Three values are drawn per resume from a seed of the
 * profile and the posting - the soft-skill group's heading, the order of each
 * concept's tools, and (in the parse) the title's shape - so the same resume
 * asked again is the same question, and a tailoring-cache hit.
 *
 * Not sent: the posting's text (the analysis has read it), its job field,
 * industry, salary and filter facts, and the profile's section switches and
 * layout - Grouped or Plain, and whether the soft-skill group prints in its own
 * section, are decided when the resume is drawn, from the model's skills block.
 * The Strengths switch still reaches the model the one way it matters: the
 * profile's own strengths are in `profileJson` only while it is on.
 */
export function buildTailorResumePromptValues(profile: Profile, jobAnalysis: JobAnalysis): Record<string, string> {
  const lists = buildTailorLists(jobAnalysis, tailorSeed(profile.id, jobAnalysis));
  return {
    profileJson: promptJson(buildPromptProfile(profile)),
    jobAnalysisJson: promptJson(analysisForPrompt(lists.posting)),
    jobTitle: lists.targetRoleTitle,
    targetRoleTitle: lists.targetRoleTitle,
    skillsJSON: promptJson(lists.skills),
    topSkillsJson: promptJson(lists.topSkills),
    keywordsJson: promptJson(lists.keywords),
    conceptKeywordsJson: promptJson(lists.concepts),
    conceptToolsJson: promptJson(lists.conceptTools),
    keyResponsibilitiesJson: promptJson(lists.posting.responsibilities),
    domainKnowledge: promptJson(lists.posting.domainKnowledge),
    softSkillGroupHeading: lists.softSkillGroupHeading,
  };
}

/**
 * A tailoring answer - or content a page held from an earlier preview, or
 * the tailoring cache's - as the resume it prints (`normalizeTailoredContent`).
 * Throws on anything that is not a JSON object, which is what a caller reads
 * as an answer that did not parse.
 */
export function parseTailoredResumeContent(content: string, profile: Profile, jobAnalysis: JobAnalysis): TailoredContent {
  const parsed: unknown = JSON.parse(extractJSON(content));
  if (!isPlainRecord(parsed)) throw new Error('The tailored resume is not a JSON object');
  return normalizeTailoredContent(parsed, jobAnalysis, profile);
}

const warnedMissingResumePrompt = new Set<string>();

/**
 * The tailoring prompt a profile runs: the Tailor Resume prompt it chose
 * (`profileSettings.resumePromptId`), else the built-in. A choice naming a
 * record that is gone - a custom prompt deleted since, which nothing stops -
 * or one that is not a Tailor Resume prompt falls back to the built-in, said
 * once per profile and id, rather than failing every build of the profile
 * with `Prompt "<id>" not found`.
 */
async function resolveProfileResumePromptId(profile: Profile): Promise<string> {
  const chosen = profile.profileSettings?.resumePromptId?.trim();
  if (!chosen || chosen === DEFAULT_RESUME_PROMPT_ID) return DEFAULT_RESUME_PROMPT_ID;
  // As a run resolves it: a variant that needs updating reads as the
  // built-in it gives way to, which is a Tailor Resume prompt.
  const record = await resolvePromptByExactId(chosen);
  if (record?.featureKey === DEFAULT_RESUME_PROMPT_ID) return chosen;
  const key = `${profile.id ?? ''}:${chosen}`;
  if (!warnedMissingResumePrompt.has(key)) {
    warnedMissingResumePrompt.add(key);
    console.warn(
      `[prompts] The profile "${profile.name ?? profile.id ?? ''}" (${profile.id ?? 'unsaved'}) names the tailoring ` +
        `prompt "${chosen}", which ${record ? 'is not a Tailor Resume prompt' : 'does not exist'}; the built-in ` +
        'Tailor Resume prompt runs instead until another is chosen in the profile.'
    );
  }
  return DEFAULT_RESUME_PROMPT_ID;
}

/**
 * The tailoring cache's key for one call (services/tailorCache.ts), or null
 * when there is nothing to key on: no context from the caller, or a prompt
 * record that cannot be read - an answer cached against a prompt nobody can
 * name could never be told apart from a later edit of it.
 *
 * `inputs` is what the call is about to send: the rendered prompt values and
 * the text appended to the user turn. Keyed as they are sent, not only
 * through the profile and the analysis they come from, so any change to the
 * code that builds them - the posting's lists, the concept-tools table, the
 * soft-skill heading drawn - is a miss with no TAILOR_CACHE_VERSION bump.
 * They read no skill library, so a library add or confirm changes no key.
 */
async function cacheKeyFor(
  kind: 'resume' | 'cover-letter',
  profile: Profile,
  choice: AiChoice,
  promptId: string,
  context: TailorCacheContext | undefined,
  inputs: { promptValues: Record<string, string>; appendToUserBody?: string; extra?: Record<string, string> }
): Promise<string | null> {
  if (!context) return null;
  const record = await resolvePromptByExactId(promptId).catch(() => null);
  if (!record) return null;
  return tailorCacheKey({ kind, profile, context, choice, promptId, promptText: record.content, ...inputs });
}

/** Said when an answer is used but not kept: another model than the one asked for wrote it. */
function noteFallbackNotKept(what: string, choice: AiChoice, answeredBy: string): void {
  console.log(
    `[tailor-cache] Not keeping this ${what}: it was written by ${answeredBy}, a fallback for ` +
      `${describeAiChoice(choice)}. The next build asks again.`
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * What else a stored tailoring was made from, beyond the tailoring call's own
 * inputs: the revise pass - its prompt's text, the figures sentence the code
 * writes into it, and the two settings that decide whether it runs and how much
 * it is given. A cached answer is the MERGED resume, so any of these changing
 * is another question.
 */
function reviseKeyInputs(revisePromptText: string | null): Record<string, string> {
  return {
    revisePromptId: REVISE_PROMPT_ID,
    revisePrompt: revisePromptText === null ? '' : sha256(revisePromptText),
    figuresNote: FIGURES_NOTE_WORDING,
    revisePass: tailorRevisePass() ? 'on' : 'off',
    reviseMaxTerms: String(tailorReviseMaxTerms()),
  };
}

type RevisionOutcome = {
  content: TailoredContent;
  /** The revise answer changed the draft. */
  changed: boolean;
  /** The pass was due and its call failed: the draft is the resume. */
  failed: boolean;
  /** Another model than the one asked for wrote the revision. */
  fellBackTo: string | null;
};

const warnedReviseFailures = new Set<string>();

/**
 * The revise pass (`revise-resume-coverage`, services/reviseCoverage.ts) on a
 * draft the tailoring call has just written. It runs only when the draft is
 * missing checklist terms, or its bullets carry fewer than five figures and
 * could carry more; on the model the resume is charged at, whatever the
 * prompt record names (`runChoiceWins`), with the same signal - and inside
 * the same provider pin a queued task runs under. The answer is folded in and
 * finished like the draft. A failure is never the resume's: the draft is the
 * resume, said once; an abort is the caller going away and is passed on.
 */
async function revisePass(
  draft: TailoredContent,
  profile: Profile,
  jobAnalysis: JobAnalysis,
  lists: TailorLists,
  choice: AiChoice,
  signal?: AbortSignal
): Promise<RevisionOutcome> {
  const unchanged: RevisionOutcome = { content: draft, changed: false, failed: false, fellBackTo: null };
  if (!tailorRevisePass()) return unchanged;
  const missing = missingTerms(draft, lists.checklist, tailorReviseMaxTerms());
  const figures = figureCount(draft);
  if (!revisionWanted(missing, figures)) return unchanged;

  const startedAt = process.hrtime.bigint();
  console.log(
    `[Resume timing] Revise pass started: ${missing.length} missing term(s), ${figures.carried} figure(s) ` +
      `(${describeAiChoice(choice)})`
  );
  try {
    const result = await createPromptCompletionResult({
      promptId: REVISE_PROMPT_ID,
      callSite: REVISE_PROMPT_ID,
      promptValues: buildReviseResumeCoveragePromptValues(draft, missing, figures),
      fallbackProvider: choice.provider,
      fallbackModelName: choice.modelName,
      maxTokens: 8000,
      temperature: 0.2,
      responseFormat: 'json',
      useExactPromptId: true,
      // A resume's work runs on the model it is charged at (see runChoiceWins).
      runChoiceWins: true,
      signal,
    });
    console.log(`[Resume timing] Revise pass finished in ${formatDuration(startedAt, process.hrtime.bigint())}`);
    const fellBackTo = result.fellBack ? result.resolvedModel : null;
    const merged = mergeRevision(draft, result.text, printsWhole);
    if (!merged) return { ...unchanged, fellBackTo };
    return {
      content: normalizeTailoredContent(merged as unknown as Record<string, unknown>, jobAnalysis, profile),
      changed: true,
      failed: false,
      fellBackTo,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    const key = `${describeAiChoice(choice)}:${reason}`;
    if (!warnedReviseFailures.has(key)) {
      warnedReviseFailures.add(key);
      console.warn(
        `[tailor] The revise pass failed on ${describeAiChoice(choice)}, so the resume is the first draft: ${reason}`
      );
    }
    return { ...unchanged, failed: true };
  }
}

export async function tailorResume(
  profile: Profile,
  jobAnalysis: JobAnalysis,
  choice: AiChoice,
  signal?: AbortSignal,
  /**
   * The posting's stored analysis and the template, which with the profile,
   * the model and the prompts key the tailoring cache (owner decision P6): the
   * same question asked again is answered from the cache, with no model call
   * - no tailoring and no revise pass. Without an analysis id nothing is
   * cached.
   */
  cache?: TailorCacheContext
): Promise<TailoredContent> {
  const { provider, modelName } = choice;
  const promptId = await resolveProfileResumePromptId(profile);
  // Built before the lookup: they are part of the key (see cacheKeyFor).
  const promptValues = buildTailorResumePromptValues(profile, jobAnalysis);
  let cacheKey: string | null = null;
  if (cache?.analysisId) {
    const revisePrompt = await resolvePromptByExactId(REVISE_PROMPT_ID).catch(() => null);
    cacheKey = await cacheKeyFor('resume', profile, choice, promptId, cache, {
      promptValues,
      extra: reviseKeyInputs(revisePrompt?.content ?? null),
    });
  }
  if (cacheKey) {
    const cached = readTailorCache(cacheKey);
    if (cached !== null) {
      try {
        const reused = parseTailoredResumeContent(cached, profile, jobAnalysis);
        console.log(`[Resume timing] Tailoring reused from the cache, no model call (${describeAiChoice(choice)})`);
        return reused;
      } catch {
        // An answer this build cannot read any more is a miss, never a failure.
      }
    }
  }
  const secondCallStartedAt = process.hrtime.bigint();
  console.log(`[Resume timing] Second LLM call started: tailor resume (${describeAiChoice(choice)})`);
  const result = await createPromptCompletionResult({
    promptId,
    // The prompt record can be a per-profile custom one; the timeout and the
    // usage bucket belong to the FEATURE, which is always this.
    callSite: DEFAULT_RESUME_PROMPT_ID,
    promptValues,
    fallbackProvider: provider,
    fallbackModelName: modelName,
    maxTokens: 11000,
    temperature: 0.2,
    responseFormat: 'json',
    useExactPromptId: true,
    // A resume's work runs on the model it is charged at (see runChoiceWins).
    runChoiceWins: true,
    signal,
  });
  const content = result.text;
  const secondCallEndedAt = process.hrtime.bigint();
  console.log(`[Resume timing] Second LLM call finished in ${formatDuration(secondCallStartedAt, secondCallEndedAt)}`);

  let draft: TailoredContent;
  try {
    draft = parseTailoredResumeContent(content, profile, jobAnalysis);
  } catch {
    console.error('Failed to parse model response:', content);
    throw new Error('Failed to parse tailored resume response');
  }

  const lists = buildTailorLists(jobAnalysis, tailorSeed(profile.id, jobAnalysis));
  const revision = await revisePass(draft, profile, jobAnalysis, lists, choice, signal);

  // Kept only once it parsed: an answer that could not be read is never
  // handed to the next generation as if it could. Nor one a fallback model
  // wrote - the tailoring or its revision: it is this call's answer, not the
  // asked-for model's, and kept it would be every repeat's for
  // TAILOR_CACHE_DAYS. Nor a draft whose revise pass failed: the next build
  // gets to ask for the revision again. What is kept is the resume as it
  // ends: the model's answer, or with a revision the merged result.
  if (cacheKey && result.fellBack) {
    noteFallbackNotKept('tailoring', choice, result.resolvedModel);
  } else if (cacheKey && revision.fellBackTo) {
    noteFallbackNotKept('revised tailoring', choice, revision.fellBackTo);
  } else if (cacheKey && !revision.failed) {
    writeTailorCache({
      key: cacheKey,
      kind: 'resume',
      content: revision.changed ? JSON.stringify(revision.content) : content,
      modelId: choice.modelId,
      analysisId: cache?.analysisId ?? null,
      profileId: profile.id ?? null,
    });
  }
  return revision.content;
}

export function buildCoverLetterPromptValues(
  profile: Profile,
  companyName: string,
  role: string
): Record<string, string> {
  return {
    // The same projection the tailoring call uses. A cover letter needs the
    // person's history and nothing about this installation - and it certainly
    // does not need their phone number, which is what the whole record carried.
    profileJson: promptJson(buildPromptProfile(profile)),
    companyName,
    role,
  };
}

/**
 * Generate a cover letter body when no job description is provided.
 * Returns only the body text (no salutation or sign-off).
 */
export async function generateCoverLetter(
  profile: Profile,
  companyName: string,
  role: string,
  choice: AiChoice,
  signal?: AbortSignal,
  /**
   * The cover letter's own entry in the tailoring cache (owner decision P6),
   * keyed apart from the resume's - on the profile, the company and the role it
   * is written for, the posting's analysis when there is one, the model and the
   * cover-letter prompt's text.
   */
  cache?: TailorCacheContext
): Promise<string> {
  // The built-in, always: a cover letter has one prompt (promptService's
  // single-prompt features), edited under Admin -> Prompts.
  const promptId = DEFAULT_COVER_LETTER_PROMPT_ID;
  const promptValues = buildCoverLetterPromptValues(profile, companyName, role);
  const cacheKey = await cacheKeyFor('cover-letter', profile, choice, promptId, cache, {
    promptValues,
    extra: { companyName, role },
  });
  if (cacheKey) {
    const cached = readTailorCache(cacheKey);
    if (cached !== null && cached.trim()) {
      console.log(`[Resume timing] Cover letter reused from the cache, no model call (${describeAiChoice(choice)})`);
      return dashBackstop(cached.trim());
    }
  }
  const result = await createPromptCompletionResult({
    promptId,
    callSite: DEFAULT_COVER_LETTER_PROMPT_ID,
    promptValues,
    fallbackProvider: choice.provider,
    fallbackModelName: choice.modelName,
    maxTokens: 1500,
    // The only caller that wants sampling variety rather than determinism.
    // None of the CLI seats can honour it, and each says so once.
    temperature: 0.7,
    responseFormat: 'text',
    useExactPromptId: true,
    // A resume's work runs on the model it is charged at (see runChoiceWins).
    runChoiceWins: true,
    signal,
  });
  // The model's answer is what is kept; what is returned has its dashes
  // taken out, as the prompt asks ("never write '--' or '–' in place of one").
  const letter = result.text.trim();
  if (cacheKey && letter && result.fellBack) {
    noteFallbackNotKept('cover letter', choice, result.resolvedModel);
  } else if (cacheKey && letter) {
    writeTailorCache({
      key: cacheKey,
      kind: 'cover-letter',
      content: letter,
      modelId: choice.modelId,
      analysisId: cache?.analysisId ?? null,
      profileId: profile.id ?? null,
    });
  }
  return dashBackstop(letter);
}

export function buildExtractTemplatePromptValues(pdfText: string, templateName: string): Record<string, string> {
  return { pdfText, templateName };
}

export async function extractTemplateFromPDF(
  pdfText: string,
  templateName: string,
  provider: AIProvider = DEFAULT_PROVIDER,
  signal?: AbortSignal
): Promise<{ html: string; css: string; sections: string[] }> {
  const promptValues = buildExtractTemplatePromptValues(pdfText, templateName);
  const content = await createPromptCompletion({
    promptId: 'extract-template-from-pdf',
    signal,
    promptValues,
    fallbackProvider: provider,
    maxTokens: 8000,
    temperature: 0,
    responseFormat: 'json',
    // Runtime resolution on purpose: this feature's prompt can be replaced by
    // an activated custom variant in the admin panel, and pinning the exact id
    // would ignore it. (The tailor and analyze callers are exact because that
    // is what their rendering already used.)
  });

  try {
    const jsonText = extractJSON(content);
    return JSON.parse(jsonText);
  } catch {
    console.error('Failed to parse model response:', content);
    throw new Error('Failed to parse template extraction response');
  }
}

export function buildExtractProfilePromptValues(resumeText: string): Record<string, string> {
  return { resumeText };
}

export async function extractProfileFromResume(
  resumeText: string,
  provider: AIProvider = DEFAULT_PROVIDER,
  signal?: AbortSignal
): Promise<Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>> {
  const promptValues = buildExtractProfilePromptValues(resumeText);
  const content = await createPromptCompletion({
    promptId: 'extract-profile-from-resume',
    signal,
    promptValues,
    fallbackProvider: provider,
    maxTokens: 4000,
    temperature: 0,
    responseFormat: 'json',
    // Runtime resolution: see the note in extractTemplateFromPDF.
  });

  try {
    const jsonText = extractJSON(content);
    return JSON.parse(jsonText);
  } catch {
    console.error('Failed to parse model response:', content);
    throw new Error('Failed to parse profile extraction response');
  }
}

export { DEFAULT_PROVIDER };
