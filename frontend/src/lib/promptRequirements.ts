import type { PromptFeatureKey, PromptVariableDefinition } from './api';

/**
 * The variables a prompt of a feature must use, as Admin -> Prompts says so.
 *
 * Two features have them (services/promptService.ts `requiredVariables`): the
 * analysis prompt's `[[jobFieldList]]` and `[[industryList]]`, without which
 * no posting gets a job field or an industry, and the tailoring prompt's
 * `[[includeStrengths]]`, `[[includeSoftSkills]]` and
 * `[[technicalSkillsLayout]]`, without which a resume ignores the profile's
 * section switches. The server marks them `required` in a prompt's
 * `allowedVariables`, refuses a save without them, and serves a stored record
 * without them as `needsUpdate` - and never runs it: the feature's built-in
 * prompt runs in its place. This file is the editor's own reading of the text
 * AS TYPED, so a save it knows the server will refuse is refused here first,
 * in the server's words.
 *
 * Imports nothing at runtime, so backend/test/frontendAnalysis.test.js runs
 * it against the server: the same names missing for the same text, and the
 * same sentence for the refusal.
 */

/** The one prompt job analysis has (the server refuses a second). */
export const ANALYSIS_PROMPT_FEATURE: PromptFeatureKey = 'analyze-job-description';

/** The server's variable syntax (promptService.ts `VARIABLE_PATTERN`): `[[name]]`, spaces allowed inside. */
const VARIABLE_PATTERN = /\[\[\s*([a-zA-Z0-9_.-]+)\s*\]\]/g;

/** Whether the text names a variable, the way the server reads variables out of it. */
function namesVariable(content: string, name: string): boolean {
  for (const match of content.matchAll(VARIABLE_PATTERN)) {
    if ((match[1] ?? '').trim() === name) return true;
  }
  return false;
}

/** The variables the server marked required, in the feature's order. */
export function requiredVariables(allowed: readonly PromptVariableDefinition[]): string[] {
  return allowed.filter((variable) => variable.required === true).map((variable) => variable.name);
}

/**
 * The required variables the text does not use, in the feature's order - what
 * the server's `validation.missingVariables` says of the same text. [] for a
 * complete prompt, and for an unattached one, which has none.
 */
export function missingRequiredVariables(content: string, allowed: readonly PromptVariableDefinition[]): string[] {
  return requiredVariables(allowed).filter((name) => !namesVariable(content, name));
}

/** `[[a]]`, `[[a]] and [[b]]`, `[[a]], [[b]] and [[c]]` (promptService.ts `variableList`). */
export function variableList(names: readonly string[]): string {
  const wrapped = names.map((name) => `[[${name}]]`);
  return wrapped.length <= 1 ? wrapped.join('') : `${wrapped.slice(0, -1).join(', ')} and ${wrapped[wrapped.length - 1]}`;
}

/**
 * The server's refusal of a save that leaves required variables out, word for
 * word (promptService.ts `missingVariablesSentence`): what Save says without
 * sending anything. `featureLabel` is the prompt's `featureLabel`, the
 * server's own name for the feature.
 */
export function missingVariablesSentence(
  featureLabel: string,
  missing: readonly string[],
  required: readonly string[]
): string {
  return (
    `Missing required prompt variables: ${missing.join(', ')}. Every ${featureLabel} prompt must use ` +
    `${variableList(required)}.`
  );
}

/**
 * What the editor says about a SAVED prompt the server flags `needsUpdate`:
 * it is not what runs. A built-in edited without them gives way to its
 * shipped text; a variant, to the built-in prompt (as an administrator edited
 * it, when that edit is complete).
 */
export function needsUpdateNote(input: { featureLabel: string; isBuiltIn: boolean; missing: readonly string[] }): string {
  const { featureLabel, isBuiltIn, missing } = input;
  const replacement = isBuiltIn ? `the shipped ${featureLabel} prompt` : `the built-in ${featureLabel} prompt`;
  return (
    `The saved prompt does not use ${variableList(missing)}, which every ${featureLabel} prompt must use, so ` +
    `${replacement} runs in its place until it is saved with ${missing.length === 1 ? 'it' : 'them'}.`
  );
}
