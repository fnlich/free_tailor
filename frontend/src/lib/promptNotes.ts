import type { PromptFeatureKey } from './api';

/**
 * The notes Admin -> Prompts puts on a prompt whose text was written before a
 * feature it now serves - the editor's own reading of the text as it is
 * typed, beside the flags the server sets on a SAVED record
 * (services/promptService.ts `predatesSectionSwitches`, `predatesJobField`,
 * `predatesIndustry`).
 *
 * Imports nothing at runtime, so backend/test/frontendAnalysis.test.js runs
 * it against the server: a note here exactly when the server flags the saved
 * text, and when the analysis gate appends the instructions the text lacks
 * (services/jobAnalysis/gate.ts `analysisOverrideFor`).
 */

/** The one prompt job analysis has (the server refuses a second). */
export const ANALYSIS_PROMPT_FEATURE: PromptFeatureKey = 'analyze-job-description';

/** The server's variable syntax (promptService.ts `VARIABLE_PATTERN`): `[[name]]`, spaces allowed inside. */
const VARIABLE_PATTERN = /\[\[\s*([a-zA-Z0-9_.-]+)\s*\]\]/g;

/** Whether the text names a variable, the way the server reads variables out of it. */
export function namesVariable(content: string, name: string): boolean {
  for (const match of content.matchAll(VARIABLE_PATTERN)) {
    if ((match[1] ?? '').trim() === name) return true;
  }
  return false;
}

/**
 * A tailor-resume prompt that never mentions `[[includeStrengths]]`: written
 * before the profile's Strengths and Soft Skills switches. The app still
 * enforces them.
 */
export function lacksSectionSwitches(featureKey: PromptFeatureKey | undefined | null, content: string): boolean {
  return featureKey === 'tailor-resume' && !namesVariable(content, 'includeStrengths');
}

/**
 * The analysis prompt when it never names `[[jobFieldList]]`: written before a
 * posting had a job field. Postings are still classified - the server appends
 * the instructions (the industry's among them) to every analysis - but outside
 * the part of the prompt a model can cache.
 */
export function lacksJobFieldList(featureKey: PromptFeatureKey | undefined | null, content: string): boolean {
  return featureKey === ANALYSIS_PROMPT_FEATURE && !namesVariable(content, 'jobFieldList');
}

/**
 * The analysis prompt when it names `[[jobFieldList]]` but never
 * `[[industryList]]`: written after job fields, before industries. Postings
 * still get an industry - the server appends the industry list and its
 * instruction to every analysis - outside the cached part. Never true together
 * with `lacksJobFieldList`, as the server never sets both flags: the job-field
 * instructions ask for the industry too.
 */
export function lacksIndustryList(featureKey: PromptFeatureKey | undefined | null, content: string): boolean {
  return (
    featureKey === ANALYSIS_PROMPT_FEATURE &&
    namesVariable(content, 'jobFieldList') &&
    !namesVariable(content, 'industryList')
  );
}
