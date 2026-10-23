import type { PromptFeatureKey, PromptVariableDefinition } from './api';

/**
 * The variables a prompt of a feature must use, as Admin -> Prompts says so.
 *
 * They are contract markers (services/promptService.ts `requiredVariables`):
 * `[[jobDescription]]` for the analysis and its job facts call, which cannot
 * read a posting they are never shown; `[[profileJson]]` for the cover
 * letter; `[[profileJson]]`, `[[jobAnalysisJson]]` and
 * `[[softSkillGroupHeading]]` for the tailoring (the code finds the soft-skill
 * group by that heading); and `[[draftJson]]` and `[[missingTermsJson]]` for
 * the revise pass. The server marks them
 * `required` in a prompt's `allowedVariables`, refuses a save without them,
 * and serves a stored record without them as `needsUpdate` - and never runs
 * it: the feature's built-in prompt runs in its place. A stored feature
 * record naming a variable the server no longer supplies is `needsUpdate`
 * too (an edit written for an older prompt contract), and so is one the
 * server dates from before its feature's prompt contract changed
 * (`savedForOlderVersion`: an older analysis or job facts edit can name
 * nothing but `[[jobDescription]]`, as the new texts do). This file is the
 * editor's own reading of the text AS TYPED, so a save it knows the server
 * will refuse is refused here first, in the server's words.
 *
 * Imports nothing at runtime, so backend/test/frontendAnalysis.test.js runs
 * it against the server: the same names missing for the same text, the same
 * sentence for the refusal, and the same single-prompt features.
 */

/**
 * The features with ONE prompt, the built-in an administrator edits (the
 * server's `listSinglePromptFeatures`): no variant, no activation, no model
 * override - each runs by its exact id on a model the server chooses.
 */
export const SINGLE_PROMPT_FEATURES: readonly PromptFeatureKey[] = [
  'analyze-job-description',
  'filter-google-sheet-job',
  'tailor-resume-full',
  'revise-resume-coverage',
  'generate-cover-letter',
  'write-entry-bullets',
];

export function isSinglePromptFeature(featureKey?: PromptFeatureKey | null): boolean {
  return Boolean(featureKey && SINGLE_PROMPT_FEATURES.includes(featureKey));
}

/**
 * What Admin -> Prompts says about each single-prompt feature, in place of
 * New Variant, Duplicate and Save Active (`about`) and of the model override
 * (`model`): why there is one prompt, when it runs, and on which model. Every
 * one of `SINGLE_PROMPT_FEATURES` has one (backend/test/frontendAnalysis.test.js).
 */
export const SINGLE_PROMPT_NOTES: Readonly<Record<string, { about: string; model: string }>> = Object.freeze({
  'analyze-job-description': {
    about:
      'Job analysis has one prompt, the built-in one: each posting is analysed once with it - beside Job Facts ' +
      '(Filter), which reads the same posting\'s facts - on the analysis model chosen under Settings > Models, and ' +
      'never again. Editing it changes how postings never analysed before are read; stored analyses are kept as ' +
      'they are.',
    model:
      'Job analysis always runs on the analysis model chosen under Settings > Models, so that every posting is ' +
      'read the same way. There is no model override for it.',
  },
  'filter-google-sheet-job': {
    about:
      'The job facts have one prompt, the built-in one: every new posting\'s analysis runs it beside Analyze Job ' +
      'Description, for the facts the Job Filter judges and the job sheet and the job lake show - job type, onsite ' +
      'interview, company category (its industry), seniority, clearance, salary, region and state. The code adds ' +
      'the job field list and asks for the job field itself, so no edit can leave it out. Editing it changes how ' +
      'postings never analysed before are read; stored analyses are kept as they are.',
    model:
      'The job facts always run on the analysis model chosen under Settings > Models, beside Analyze Job ' +
      'Description. There is no model override for them.',
  },
  'tailor-resume-full': {
    about:
      'Fully tailoring has one prompt, the built-in one: every Fully Tailor run uses it for the profile\'s default ' +
      'resume, whatever tailoring prompt that resume chose for Partial Tailor. It is sent each role\'s title, company and dates only - no ' +
      'summary, description or achievements - and writes the experience and the summary for the posting, with ' +
      'modest, plausible figures.',
    model:
      'Fully tailoring always runs on the model chosen for the run, as Partial Tailor does; what the resume costs ' +
      'is the price of the build mode, whatever the model. There is no model override for it.',
  },
  'revise-resume-coverage': {
    about:
      'The revise pass has one prompt, the built-in one: after a fresh tailoring leaves out of the summary and ' +
      'bullets checklist terms the source resume itself names, or drops a figure the source resume states, it runs once to put ' +
      'them back - after a Fully tailored resume, any checklist term it left out. Otherwise a term the source resume ' +
      'never names is never asked for. It never runs on a tailoring the cache answered or on content sent back ' +
      'from a preview, and TAILOR_REVISE_PASS turns it off.',
    model:
      'The revise pass always runs on the model chosen for the run, as the tailoring does. There is no ' +
      'model override for it.',
  },
  'generate-cover-letter': {
    about:
      'A cover letter has one prompt, the built-in one: it writes the letter when the tailoring answer brought ' +
      'none, which the tailoring prompt\'s own cover letter otherwise is - and it writes the letter of every ' +
      'Choose Suitable Resume build, which tailors nothing.',
    model:
      'A cover letter always runs on the model chosen for the run. There is no model override for it.',
  },
  'write-entry-bullets': {
    about:
      'Writing an entry\'s bullets has one prompt, the built-in one: the resume editor\'s Write with AI and ' +
      'Improve with AI run it for one experience, project or volunteering entry, with the note typed beside the ' +
      'button, and put the answer in the editor - nothing is saved until the resume is. It is free, and open to ' +
      'every account that builds resumes.',
    model:
      'Write Entry Bullets always runs on the app default model chosen under Admin > Models, as every call that ' +
      'names no model does. There is no model override for it.',
  },
});

/** The server's variable syntax (promptService.ts `VARIABLE_PATTERN`): `[[name]]`, spaces allowed inside. */
const VARIABLE_PATTERN = /\[\[\s*([a-zA-Z0-9_.-]+)\s*\]\]/g;

/** Whether the text names a variable, the way the server reads variables out of it. */
function namesVariable(content: string, name: string): boolean {
  for (const match of content.matchAll(VARIABLE_PATTERN)) {
    if ((match[1] ?? '').trim() === name) return true;
  }
  return false;
}

/**
 * The variables the text uses that the prompt may not, in the order they
 * first appear - what the server's `validation.unknownVariables` says of the
 * same text: for a feature's prompt, a variable the feature does not supply
 * (an older contract's, or a typo).
 */
export function unknownVariables(content: string, allowed: readonly PromptVariableDefinition[]): string[] {
  const names = new Set(allowed.map((variable) => variable.name));
  const found: string[] = [];
  for (const match of content.matchAll(VARIABLE_PATTERN)) {
    const name = (match[1] ?? '').trim();
    if (name && !names.has(name) && !found.includes(name)) found.push(name);
  }
  return found;
}

/** The server's refusal of a save naming variables it does not supply, word for word (promptService.ts `assertValidPromptDraft`). */
export function unknownVariablesSentence(unknown: readonly string[]): string {
  return `Unknown prompt variables: ${unknown.join(', ')}`;
}

/**
 * The refusal Save makes without sending anything, as the server would make
 * it - an unknown variable first, then a missing required one - or '' for a
 * text the server would save.
 */
export function saveRefusal(
  content: string,
  allowed: readonly PromptVariableDefinition[],
  featureLabel: string
): string {
  const unknown = unknownVariables(content, allowed);
  if (unknown.length > 0) return unknownVariablesSentence(unknown);
  const missing = missingRequiredVariables(content, allowed);
  if (missing.length > 0) return missingVariablesSentence(featureLabel, missing, requiredVariables(allowed));
  return '';
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
 * The list's one line under a saved prompt the server flags `needsUpdate`:
 * why it is not run, from its `validation` and - for a record saved before
 * its feature's prompt contract changed - the server's `savedForOlderVersion`.
 */
export function notRunLine(
  validation: { missingVariables: readonly string[]; unknownVariables?: readonly string[] },
  savedForOlderVersion = false
): string {
  const missing = validation.missingVariables;
  const unknown = validation.unknownVariables ?? [];
  const reasons: string[] = [];
  if (missing.length > 0) reasons.push(`does not use ${variableList(missing)}`);
  if (unknown.length > 0) reasons.push(`uses ${variableList(unknown)}, which this version does not supply`);
  if (savedForOlderVersion) reasons.push('dates from an older version of this prompt');
  return reasons.length > 0 ? `Not run: it ${reasons.join(', and ')}.` : 'Not run: it cannot run as it is.';
}

/**
 * What the editor says about a SAVED prompt the server flags `needsUpdate`:
 * it is not what runs, and why - the required variables it leaves out
 * (`missing`, the server's `validation.missingVariables`), the ones it uses
 * that the server no longer supplies (`unknown`, its
 * `validation.unknownVariables`), and whether it was saved before its
 * feature's prompt contract changed (`savedForOlderVersion`, the server's
 * flag - any save after that clears it, so "saved again" is the whole fix
 * when nothing else is wrong). A built-in edit gives way to its shipped text;
 * a variant, to the built-in prompt (as an administrator edited it, when that
 * edit is usable).
 */
export function needsUpdateNote(input: {
  featureLabel: string;
  isBuiltIn: boolean;
  missing: readonly string[];
  unknown?: readonly string[];
  savedForOlderVersion?: boolean;
}): string {
  const { featureLabel, isBuiltIn, missing } = input;
  const unknown = input.unknown ?? [];
  const replacement = isBuiltIn ? `the shipped ${featureLabel} prompt` : `the built-in ${featureLabel} prompt`;
  const reasons: string[] = [];
  if (missing.length > 0) {
    reasons.push(`does not use ${variableList(missing)}, which every ${featureLabel} prompt must use`);
  }
  if (unknown.length > 0) {
    reasons.push(`uses ${variableList(unknown)}, which this version does not supply`);
  }
  if (input.savedForOlderVersion) {
    reasons.push(`dates from an older version of the ${featureLabel} prompt`);
  }
  // Neither named (a caller that passed only `missing`, for a record flagged
  // for an unknown variable): still true, and still says what runs.
  if (reasons.length === 0) return `The saved prompt cannot run as it is, so ${replacement} runs in its place until it is updated.`;
  const fix =
    missing.length === 0 && unknown.length === 0
      ? 'until it is saved again'
      : unknown.length === 0
        ? `until it is saved with ${missing.length === 1 ? 'it' : 'them'}`
        : missing.length === 0
          ? `until it is saved without ${unknown.length === 1 ? 'it' : 'them'}`
          : `until it is saved with ${variableList(missing)} and without ${variableList(unknown)}`;
  return `The saved prompt ${reasons.join(', and ')}, so ${replacement} runs in its place ${fix}.`;
}
