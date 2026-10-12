import fs from 'fs/promises';
import path from 'path';
import { categoryForFeature, getPromptCategory } from '../config/promptCategories';
import { getStaticPromptsDir } from '../config/staticPaths';
import {
  deleteStoredPrompt,
  getStoredPrompt,
  hasStoredPrompt,
  listCustomPrompts,
  readActivePrompts,
  saveStoredPrompt,
  StoredPrompt,
  writeActivePrompts,
} from '../database/promptRepository';
import {
  PromptActivationResult,
  PromptCreateInput,
  PromptFeatureKey,
  PromptPreviewInput,
  PromptPreviewResult,
  PromptRecord,
  PromptResponseFormat,
  PromptSummary,
  PromptUpdateInput,
  PromptValidation,
  PromptVariableDefinition,
} from '../types/prompt';
import { normalizePromptModelOverride, readStoredPromptModelSelection } from './aiModelCatalog';
import type { AIProvider } from '../types/template';

const CUSTOM_PROMPT_PREFIX = 'custom-';
const VARIABLE_PATTERN = /\[\[\s*([a-zA-Z0-9_.-]+)\s*\]\]/g;
const PROFILE_SCOPED_PROMPT_FEATURES = new Set<PromptFeatureKey>([
  'tailor-resume',
]);

/** What Admin -> Prompts and the refusals say about a single-prompt feature. */
type SinglePromptRule = {
  /** The refusal of a new variant (`createPrompt`, or moving a prompt into the feature). */
  variant: string;
  /** The refusal of activating one an older build created. */
  activation: string;
};

/**
 * Features with ONE prompt: the built-in record an administrator may edit,
 * run by its exact id on a model the CODE chooses (`runChoiceWins`). So a
 * variant would never run, an activation would change nothing and a model
 * override would be ignored - none is offered, and a stale `activePrompts`
 * entry an older build wrote for one is ignored. A variant written before is
 * kept and listed - it is the administrator's text - but nothing runs it.
 *
 * - The analysis and the job facts are the two calls of a posting's ONE
 *   analysis, for every profile (owner decisions J0, O1), on the analysis
 *   model.
 * - The revise pass is the tailoring's second call, run by its exact id on
 *   the model the resume is charged at, whichever tailoring prompt the
 *   profile chose.
 * - A cover letter runs on the model the resume is charged at. Its
 *   activation was inert even before: the call always named the built-in
 *   (or a per-profile id no page ever set), so an activated variant showed
 *   "Live" and never ran.
 */
const SINGLE_PROMPT_FEATURES: ReadonlyMap<PromptFeatureKey, SinglePromptRule> = new Map<PromptFeatureKey, SinglePromptRule>([
  [
    'analyze-job-description',
    {
      variant: 'Job analysis has one prompt, the built-in Analyze Job Description. Edit that prompt instead of adding another.',
      activation: 'Job analysis always runs the built-in Analyze Job Description prompt. Edit that prompt instead.',
    },
  ],
  [
    'filter-google-sheet-job',
    {
      variant:
        'The job facts have one prompt, the built-in Job Facts (Filter), which every analysis runs beside Analyze Job ' +
        'Description. Edit that prompt instead of adding another.',
      activation: 'Every analysis runs the built-in Job Facts (Filter) prompt. Edit that prompt instead.',
    },
  ],
  [
    'revise-resume-coverage',
    {
      variant:
        'The revise pass has one prompt, the built-in Revise Resume Coverage, which runs after a tailoring that left ' +
        'checklist terms out or whose bullets carry fewer than five figures. Edit that prompt instead of adding ' +
        'another.',
      activation: 'Every revise pass runs the built-in Revise Resume Coverage prompt. Edit that prompt instead.',
    },
  ],
  [
    'generate-cover-letter',
    {
      variant:
        'A cover letter has one prompt, the built-in Generate Cover Letter. Edit that prompt instead of adding another.',
      activation: 'Every cover letter runs the built-in Generate Cover Letter prompt. Edit that prompt instead.',
    },
  ],
]);

function isSinglePromptFeature(featureKey?: PromptFeatureKey): boolean {
  return Boolean(featureKey && SINGLE_PROMPT_FEATURES.has(featureKey));
}

/** The single-prompt features, in the feature list's order - for the tests that hold the page's copy to it. */
export function listSinglePromptFeatures(): PromptFeatureKey[] {
  return PROMPT_FEATURES.map((feature) => feature.key).filter(isSinglePromptFeature);
}

/**
 * Variables whose value the CODE fixes and is the same on every call, so
 * promptAssembly keeps them in the cacheable stable part of the prompt rather
 * than starting the call's data at them. None today: the analysis prompt's
 * job field and industry lists were the two, and neither reaches a model as a
 * variable any more - the job field list is code-owned text on the facts call
 * (services/jobAnalysis/jobFieldLine.ts) and the industry is derived. Kept,
 * with `isStableSegment`, for the next code constant a prompt carries.
 */
export const STABLE_PROMPT_VARIABLES: ReadonlySet<string> = new Set<string>();

/**
 * When the prompt contract of the owner's texts took effect (owner decision
 * O1): the `updatedAt` of the shipped analysis, job facts and tailoring files,
 * which test/promptVariables.test.js holds equal to it. A STORED record of
 * those features saved before then was written for an older contract, and
 * some of those name only variables that are still supplied - an analysis
 * edit from before the job field lists asked for "bare infinitive verbs" and
 * used just `[[jobDescription]]`, as did the Job Filter's prompt before it was
 * retired - so no reading of its variables can tell it from the owner's new
 * text. Its date can: see `contractSince`.
 */
export const OWNER_PROMPTS_CONTRACT = '2026-10-12T00:00:00.000Z';

type PromptFeatureDefinition = {
  key: PromptFeatureKey;
  label: string;
  id: string;
  name: string;
  description: string;
  usage: string;
  responseFormat: PromptResponseFormat;
  modelProvider?: AIProvider;
  modelName?: string;
  allowedVariables: PromptVariableDefinition[];
  /**
   * Variables every record of this feature must use, by name - each one of
   * `allowedVariables`. Contract markers: a record without them cannot
   * produce what the code parses (an analysis or a facts call that never
   * shows the model the posting, a cover letter written from no profile), so
   * a save without them is refused (`assertValidPromptDraft`), and a stored
   * record without them is marked `needsUpdate` and never run: the
   * feature's built-in prompt runs in its place (`usableAtRuntime`). So does
   * a stored record naming a variable the code no longer supplies - which is
   * how an edit written for an older contract gives way to the shipped text.
   */
  requiredVariables?: readonly string[];
  /**
   * When this feature's prompt contract last changed - what the code sends
   * the prompt and what it reads back - as an ISO time. A record of the
   * feature STORED (an administrator's edit of the built-in, or a variant)
   * with an earlier `updatedAt` is `needsUpdate` whatever variables it uses,
   * `savedForOlderVersion` on the way out, and the built-in runs in its place
   * until it is saved again; the shipped file itself never is. Absent for a
   * feature whose contract an older edit still meets.
   */
  contractSince?: string;
};

type StoredPromptMeta = {
  id: string;
  name: string;
  description: string;
  featureKey?: PromptFeatureKey;
  responseFormat: PromptResponseFormat;
  modelProvider?: AIProvider;
  modelName?: string;
  allowedVariables: PromptVariableDefinition[];
  createdAt: string;
  updatedAt: string;
};

type StoredPromptJson = Partial<StoredPromptMeta> & {
  content?: unknown;
};

type StoredPromptSource = {
  parsed: StoredPromptJson;
  content: string;
  timestamps: { createdAt: string; updatedAt: string } | null;
  /** The shipped default file, or a record in the database - only the second can be written for an older contract. */
  origin: 'shipped' | 'stored';
};

type PromptLibraryConfig = {
  activePrompts: Partial<Record<PromptFeatureKey, string>>;
};

function isProfileScopedPromptFeature(featureKey?: PromptFeatureKey): boolean {
  return Boolean(featureKey && PROFILE_SCOPED_PROMPT_FEATURES.has(featureKey));
}

const PROMPT_FEATURES: PromptFeatureDefinition[] = [
  {
    key: 'analyze-job-description',
    label: 'Analyze Job Description',
    id: 'analyze-job-description',
    name: 'Analyze Job Description',
    description:
      'Reads a job posting once for its keywords: role metadata, skills, technologies, protocols, methods, ' +
      'architecture, responsibilities, domain knowledge and the ATS keywords a resume is checked against.',
    usage:
      'The first of the two calls of the one job analysis (the second is Job Facts (Filter)). Every posting is ' +
      'analysed once, ever, on the analysis model chosen under Admin -> Settings; an edit here reaches only ' +
      'postings never analysed before.',
    responseFormat: 'json',
    contractSince: OWNER_PROMPTS_CONTRACT,
    requiredVariables: ['jobDescription'],
    allowedVariables: [
      {
        name: 'jobDescription',
        description: 'Raw job description text pasted by the user.',
        sampleValue: `Senior Software Engineer

We are looking for a backend-focused engineer with strong Node.js, TypeScript, PostgreSQL, Docker, and AWS experience.

You will design scalable APIs, collaborate cross-functionally, improve reliability, and mentor teammates.

Preferred: GraphQL, Kubernetes, Terraform, CI/CD, and experience in fast-paced startup environments.`,
      },
      {
        name: 'jobLink',
        description: 'The posting\'s own link, or empty when it has none.',
        sampleValue: 'https://jobs.example.com/openings/senior-software-engineer',
      },
    ],
  },
  {
    key: 'filter-google-sheet-job',
    label: 'Job Facts (Filter)',
    id: 'filter-google-sheet-job',
    name: 'Job Facts (Filter)',
    description:
      'Reads the facts of a posting: job type, onsite interview, company category (its industry), seniority, ' +
      'clearance, salary, region and state - what the Job Filter judges and the sheet and the lake show. The ' +
      'code adds the job field to it.',
    usage:
      'The second of the two calls of the one job analysis, beside Analyze Job Description, on the same analysis ' +
      'model. The code adds the job field list and asks for "job_field" itself, so no edit here can drop it; an ' +
      'edit reaches only postings never analysed before.',
    responseFormat: 'json',
    contractSince: OWNER_PROMPTS_CONTRACT,
    requiredVariables: ['jobDescription'],
    allowedVariables: [
      {
        name: 'jobDescription',
        description: 'Raw job description text, the same the analysis prompt reads.',
        sampleValue: `Senior Software Engineer (Remote, US)

We are a SaaS company hiring a backend engineer: Node.js, TypeScript, PostgreSQL and AWS.
5+ years of experience. Interviews are held over video. $150k - $180k a year.`,
      },
      {
        name: 'jobLink',
        description: 'The posting\'s own link, or empty when it has none.',
        sampleValue: 'https://jobs.example.com/openings/senior-software-engineer',
      },
    ],
  },
  {
    key: 'tailor-resume',
    label: 'Tailor Resume',
    id: 'tailor-resume',
    name: 'Tailor Resume',
    description:
      'Writes the tailored resume from a profile and a posting\'s analysis: the headline the code builds on, the ' +
      'summary, every role\'s bullets, the Technical Skills block in groups (the posting\'s soft skills last) and a ' +
      'cover letter.',
    usage:
      'Runs for every resume, on the model it is charged at; a profile may choose a variant of its own. The code ' +
      'composes the title, restores each role\'s facts from the profile, keeps eight bullets a role and prints the ' +
      'skill groups as written. Revise Resume Coverage may follow it.',
    responseFormat: 'json',
    contractSince: OWNER_PROMPTS_CONTRACT,
    requiredVariables: ['profileJson', 'jobAnalysisJson', 'softSkillGroupHeading'],
    allowedVariables: [
      {
        name: 'profileJson',
        description:
          'The candidate as the model needs them: name, headline, years, summary, roles with their achievements, ' +
          'skills, education and certifications - strengths only while the Strengths switch is on. No contact ' +
          'details and no settings.',
        sampleValue: `{"name":"Jane Doe","title":"Senior Software Engineer","totalYearsExperience":7,"summary":"Backend engineer.","experience":[{"title":"Senior Software Engineer","company":"Acme","startDate":"01/2022","endDate":"Present","location":"Remote","companyContext":"Builds backend services.","achievements":["Cut API latency from 180ms to 118ms."],"skills":["Node.js","TypeScript"]}],"skills":["Node.js","TypeScript","PostgreSQL","AWS"],"education":[],"certifications":[]}`,
      },
      {
        name: 'jobAnalysisJson',
        description:
          'The posting\'s analysis in the analysis prompt\'s own schema: jobMeta, skills (technical, tools, soft), ' +
          'technologies, protocols, methodologies, architecturePatterns, responsibilities, domainKnowledge and ' +
          'keywords. Never the posting\'s text, salary or filter facts.',
        sampleValue: `{"jobMeta":{"title":"Senior Backend Engineer","seniority":"senior","industry":"SaaS","department":"engineering"},"skills":{"technical":["API design","code review"],"tools":["Docker","Datadog"],"soft":["Communication skills","Ownership"]},"technologies":["Node.js","TypeScript","PostgreSQL","AWS"],"protocols":["REST"],"methodologies":["CI/CD"],"architecturePatterns":["microservices"],"responsibilities":["backend service development","incident response ownership"],"domainKnowledge":["payments"],"keywords":{"actionVerbs":["built","migrated"],"buzzwords":["cloud-native"],"mustInclude":["Node.js","TypeScript"]}}`,
      },
      {
        name: 'jobTitle',
        description: 'The posting\'s own title, as the analysis read it (the same as targetRoleTitle).',
        sampleValue: 'Senior Backend Engineer',
      },
      {
        name: 'targetRoleTitle',
        description:
          'The posting\'s own title - the role this resume is aimed at. The code also composes the KIND of role ' +
          'onto the candidate\'s headline from it.',
        sampleValue: 'Senior Backend Engineer',
      },
      {
        name: 'skillsJSON',
        description:
          'What the posting named, in its own spelling: its technical abilities, tools, technologies and ' +
          'protocols. Repeats dropped, nothing from the skill library.',
        sampleValue: `["API design","code review","Docker","Datadog","Node.js","TypeScript","PostgreSQL","AWS","REST"]`,
      },
      {
        name: 'topSkillsJson',
        description:
          'The five technologies, tools or protocols the posting leans on most - named in its requirements, first, ' +
          'and repeated - scored by the code.',
        sampleValue: `["Node.js","TypeScript","PostgreSQL","AWS","Docker"]`,
      },
      {
        name: 'keywordsJson',
        description:
          'The prose targets: the posting\'s soft skills, its must-include terms and its past-tense action verbs ' +
          '(the banned ones left out) - minus anything already in skillsJSON or conceptKeywordsJson.',
        sampleValue: `["Communication skills","Ownership","built","migrated"]`,
      },
      {
        name: 'conceptKeywordsJson',
        description:
          'The architecture patterns, methodologies and buzzwords the posting named, minus anything in skillsJSON.',
        sampleValue: `["microservices","CI/CD","cloud-native"]`,
      },
      {
        name: 'conceptToolsJson',
        description:
          'For each concept the posting named that the code\'s table knows (CI/CD, observability, message queues ' +
          '...), the tools it is built with - their order shuffled for each resume.',
        sampleValue: `[{"concept":"CI/CD","tools":["GitHub Actions","Jenkins","GitLab CI","CircleCI"]},{"concept":"microservices","tools":["Docker","Kubernetes","gRPC"]}]`,
      },
      {
        name: 'keyResponsibilitiesJson',
        description: 'The posting\'s responsibilities, as the analysis wrote them.',
        sampleValue: `["backend service development","incident response ownership"]`,
      },
      {
        name: 'domainKnowledge',
        description: 'The domain knowledge the posting asks for, as the analysis wrote it.',
        sampleValue: `["payments","billing systems"]`,
      },
      {
        name: 'softSkillGroupHeading',
        description:
          'The heading the last skill group - the posting\'s soft skills - must carry, drawn per resume from a ' +
          'fixed list. The code finds the soft-skill group by it, and prints it in the Soft Skills section while ' +
          'that switch is on.',
        sampleValue: 'Professional Skills',
      },
    ],
  },
  {
    key: 'revise-resume-coverage',
    label: 'Revise Resume Coverage',
    id: 'revise-resume-coverage',
    name: 'Revise Resume Coverage',
    description:
      'Works the checklist terms a tailored draft left out - and the figures its bullets lack - into its summary ' +
      'and bullets, changing as little as possible.',
    usage:
      'Runs after a fresh tailoring that left checklist terms out, or whose bullets carry fewer than five figures, ' +
      'on the model the resume is charged at. Never on a reused tailoring or on content a page sent back. ' +
      'TAILOR_REVISE_PASS turns it off.',
    responseFormat: 'json',
    requiredVariables: ['draftJson', 'missingTermsJson'],
    allowedVariables: [
      {
        name: 'draftJson',
        description: 'The tailored draft as it would print: its summary, and each role\'s company, title and bullets.',
        sampleValue: `{"summary":"7 years of backend engineering across payment platforms.","experience":[{"company":"Acme","title":"Senior Software Engineer","achievements":["Rewrote the settlement endpoints in Node.js, taking approval time from 9s to 1.4s."]}]}`,
      },
      {
        name: 'missingTermsJson',
        description:
          'The checklist terms the summary and bullets do not carry, in priority order (TAILOR_REVISE_MAX_TERMS at ' +
          'most). Never a term with a banned word in it.',
        sampleValue: `["incident response","Datadog","Communication skills"]`,
      },
      {
        name: 'figuresNote',
        description:
          'A sentence asking for more figures in the bullets when they carry fewer than five, or empty.',
        sampleValue:
          'FIGURES. 3 of the bullets carry a figure and a resume needs at least five. Add a figure to 2 more ' +
          'bullets, never to the summary.',
      },
    ],
  },
  {
    key: 'generate-cover-letter',
    label: 'Generate Cover Letter',
    id: 'generate-cover-letter',
    name: 'Generate Cover Letter',
    description: 'Generates a concise cover letter body using the profile and application details.',
    usage:
      'Writes the cover letter when the tailoring answer brought none (or there is no posting to tailor to), ' +
      'on the model the resume is charged at.',
    responseFormat: 'text',
    requiredVariables: ['profileJson'],
    allowedVariables: [
      { name: 'profileJson', description: 'Serialized candidate profile JSON.' },
      { name: 'companyName', description: 'Target company name.', sampleValue: 'Acme' },
      { name: 'role', description: 'Target role title.', sampleValue: 'Senior Software Engineer' },
    ],
  },
  {
    key: 'extract-template-from-pdf',
    label: 'Extract Template From PDF',
    id: 'extract-template-from-pdf',
    name: 'Extract Template From PDF',
    description: 'Converts resume PDF text into an ATS-friendly Handlebars HTML template.',
    usage: 'Live prompt used when uploading a PDF to create a resume template.',
    responseFormat: 'json',
    allowedVariables: [
      {
        name: 'pdfText',
        description: 'Extracted text content from the uploaded PDF.',
        sampleValue: `JANE DOE
Senior Software Engineer
jane@example.com | San Francisco, CA | linkedin.com/in/jane

SUMMARY
Backend-focused engineer with experience building APIs and internal tooling.

EXPERIENCE
Senior Software Engineer | Acme | 2022 - Present
- Designed and shipped TypeScript APIs used by 5 internal teams.
- Improved reliability of background processing workloads.

EDUCATION
BS Computer Science | State University | 2018`,
      },
      {
        name: 'templateName',
        description: 'The name given to the template being created.',
        sampleValue: 'Imported Template',
      },
    ],
  },
  {
    key: 'extract-profile-from-resume',
    label: 'Extract Profile From Resume',
    id: 'extract-profile-from-resume',
    name: 'Extract Profile From Resume',
    description: 'Parses raw resume text into the structured profile schema used by the app.',
    usage: 'Live prompt used when importing resume text into a profile.',
    responseFormat: 'json',
    allowedVariables: [
      {
        name: 'resumeText',
        description: 'Full resume text extracted from an uploaded resume.',
        sampleValue: `JANE DOE
Senior Software Engineer
jane@example.com
San Francisco, CA

SUMMARY
Senior engineer focused on scalable backend systems.

EXPERIENCE
Senior Software Engineer, Acme, 01/2022 - Present
- Built Node.js services and improved system reliability.

SKILLS
Node.js, TypeScript, PostgreSQL, AWS`,
      },
    ],
  },
];

const FEATURE_KEYS = new Set<PromptFeatureKey>(PROMPT_FEATURES.map((feature) => feature.key));

function isPromptFeatureKey(value: unknown): value is PromptFeatureKey {
  return typeof value === 'string' && FEATURE_KEYS.has(value as PromptFeatureKey);
}

function getPromptFeatureDefinition(featureKey: PromptFeatureKey): PromptFeatureDefinition {
  const feature = PROMPT_FEATURES.find((entry) => entry.key === featureKey);
  if (!feature) {
    throw new Error(`Unknown prompt feature "${featureKey}"`);
  }
  return feature;
}

function getPromptFeatureDefinitionById(id: string): PromptFeatureDefinition | undefined {
  return PROMPT_FEATURES.find((feature) => feature.id === id);
}

function getDefaultPromptPath(id: string): string {
  return path.join(getStaticPromptsDir(), `${id}.json`);
}

function normalizePromptName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function normalizePromptDescription(description?: string): string {
  return description?.trim().replace(/\s+/g, ' ') ?? '';
}

function normalizePromptContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

function normalizeResponseFormat(format?: PromptResponseFormat): PromptResponseFormat {
  return format === 'text' ? 'text' : 'json';
}

function normalizeVariableName(name: string): string {
  return name.trim();
}

function normalizeAllowedVariables(
  allowedVariables: PromptVariableDefinition[] | undefined
): PromptVariableDefinition[] {
  const seen = new Set<string>();
  const normalized: PromptVariableDefinition[] = [];

  for (const variable of allowedVariables ?? []) {
    const name = normalizeVariableName(variable?.name ?? '');
    if (!name) continue;
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
      throw new Error(`Invalid variable name "${name}". Use letters, numbers, ".", "_" or "-".`);
    }
    if (seen.has(name)) continue;
    seen.add(name);
    normalized.push({
      name,
      description: variable.description?.trim() || undefined,
      sampleValue: variable.sampleValue,
    });
  }

  return normalized;
}

function cloneAllowedVariables(allowedVariables: PromptVariableDefinition[]): PromptVariableDefinition[] {
  return allowedVariables.map((variable) => ({ ...variable }));
}

function normalizeFeatureKey(value: unknown): PromptFeatureKey | undefined {
  return isPromptFeatureKey(value) ? value : undefined;
}

export function extractPromptVariables(content: string): string[] {
  const seen = new Set<string>();
  const found: string[] = [];

  for (const match of content.matchAll(VARIABLE_PATTERN)) {
    const name = normalizeVariableName(match[1] ?? '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    found.push(name);
  }

  return found;
}

/**
 * What a prompt's text uses, what it uses that it may not (`unknownVariables`)
 * and which of the variables marked `required` it leaves out
 * (`missingVariables`) - for a feature prompt, its feature's required ones.
 */
export function validatePromptContent(
  content: string,
  allowedVariables: PromptVariableDefinition[]
): PromptValidation {
  const usedVariables = extractPromptVariables(content);
  const allowed = new Set(allowedVariables.map((variable) => variable.name));
  const unknownVariables = usedVariables.filter((name) => !allowed.has(name));
  const used = new Set(usedVariables);
  const missingVariables = allowedVariables
    .filter((variable) => variable.required && !used.has(variable.name))
    .map((variable) => variable.name);

  return {
    usedVariables,
    unknownVariables,
    missingVariables,
  };
}

/**
 * The variables a feature-linked prompt may use: exactly the ones its code
 * supplies, and all of them.
 *
 * It used to be every variable the prompt's own text named, which made the
 * check a tautology - `unknownVariables` came back empty for a feature prompt
 * whatever it said. So `[[includeSoftSkillz]]` saved cleanly, and then every
 * generation that used the record failed with "missing runtime values". Now a
 * name the code does not supply is refused when it is saved, and listed as
 * unknown on a record that already holds one (which could never have run).
 *
 * Each feature's list is the key set of the function that builds its values
 * (`buildTailorResumePromptValues` and its siblings in resumeService, the job
 * analysis's among them); test/promptVariables.test.js fails when the
 * two drift. Listing all of them, rather than the ones a record happens to
 * use, is also what shows an administrator what a prompt CAN use.
 */
function featureAllowedVariables(featureKey: PromptFeatureKey): PromptVariableDefinition[] {
  const definition = getPromptFeatureDefinition(featureKey);
  const required = new Set(definition.requiredVariables ?? []);
  return cloneAllowedVariables(definition.allowedVariables).map((variable) =>
    required.has(variable.name) ? { ...variable, required: true as const } : variable
  );
}

/** Every prompt feature, in the order Admin -> Prompts lists them - which the page's copy is held to. */
export function listPromptFeatureKeys(): PromptFeatureKey[] {
  return PROMPT_FEATURES.map((feature) => feature.key);
}

/** The names a feature's code supplies to its prompt, for the drift test and the docs. */
export function listPromptFeatureVariableNames(featureKey: PromptFeatureKey): string[] {
  return getPromptFeatureDefinition(featureKey).allowedVariables.map((variable) => variable.name);
}

/** The variables every record of a feature must use (`PromptFeatureDefinition.requiredVariables`). */
export function listRequiredPromptVariables(featureKey: PromptFeatureKey): string[] {
  return [...(getPromptFeatureDefinition(featureKey).requiredVariables ?? [])];
}

/** `[[a]]`, `[[a]] and [[b]]`, `[[a]], [[b]] and [[c]]`: names as a sentence writes them. */
function variableList(names: readonly string[]): string {
  const wrapped = names.map((name) => `[[${name}]]`);
  return wrapped.length <= 1 ? wrapped.join('') : `${wrapped.slice(0, -1).join(', ')} and ${wrapped[wrapped.length - 1]}`;
}

/**
 * The refusal of a save that leaves out required variables, naming them and
 * the whole rule - written for the administrator saving it.
 */
function missingVariablesSentence(featureKey: PromptFeatureKey, missing: readonly string[]): string {
  const definition = getPromptFeatureDefinition(featureKey);
  return (
    `Missing required prompt variables: ${missing.join(', ')}. Every ${definition.label} prompt must use ` +
    `${variableList(definition.requiredVariables ?? [])}.`
  );
}

/**
 * Whether a STORED record of a feature was saved before the feature's
 * current prompt contract (`contractSince`). An `updatedAt` that is no time
 * at all counts as before: a record nobody can date is not trusted over the
 * shipped text.
 */
function predatesContract(featureKey: PromptFeatureKey, updatedAt: string): boolean {
  const since = getPromptFeatureDefinition(featureKey).contractSince;
  if (!since) return false;
  const saved = Date.parse(updatedAt);
  return !(saved >= Date.parse(since));
}

/**
 * `needsUpdate`, spread onto a stored record: for a FEATURE record, one that
 * lacks a required variable, names one its feature's code does not supply
 * (an edit written for an older contract - an analysis asking for the lists,
 * a filter reading `[[jobContent]]`), or was saved before its feature's
 * contract changed (`savedForOlderVersion` - an older edit naming only
 * variables still supplied). Any of them, and the feature's built-in runs in
 * its place (`usableAtRuntime`). An unattached record is never flagged: it
 * has nothing to give way to, and its unknown variables fail its run as they
 * always did.
 */
function promptFlags(validation: PromptValidation, featureKey: PromptFeatureKey | undefined, savedForOlderVersion: boolean) {
  const older = featureKey !== undefined && savedForOlderVersion;
  const outdated =
    validation.missingVariables.length > 0 || (featureKey !== undefined && validation.unknownVariables.length > 0) || older;
  return {
    ...(outdated ? { needsUpdate: true as const } : {}),
    ...(older ? { savedForOlderVersion: true as const } : {}),
  };
}

function buildSampleValue(variableName: string): string {
  switch (variableName) {
    case 'jobDescription':
      return `Senior Software Engineer

Looking for a backend-leaning engineer with Node.js, TypeScript, PostgreSQL, Docker, AWS, and cross-functional collaboration experience.`;
    case 'profileJson':
      return `{
  "name": "Jane Doe",
  "title": "Senior Software Engineer",
  "totalYearsExperience": 7,
  "skills": ["Node.js", "TypeScript", "PostgreSQL", "AWS"]
}`;
    case 'jobAnalysisJson':
      return `{
  "jobMeta": {
    "title": "Senior Backend Engineer",
    "seniority": "senior",
    "industry": "SaaS",
    "department": "engineering"
  },
  "skills": {
    "technical": ["API design"],
    "tools": ["Docker"],
    "soft": ["Ownership"]
  },
  "technologies": ["Node.js", "TypeScript", "PostgreSQL", "AWS"],
  "protocols": ["REST"],
  "methodologies": ["CI/CD"],
  "architecturePatterns": ["microservices"],
  "responsibilities": ["backend service development"],
  "domainKnowledge": ["payments"],
  "keywords": {
    "actionVerbs": ["built"],
    "buzzwords": ["cloud-native"],
    "mustInclude": ["Node.js", "TypeScript"]
  }
}`;
    case 'companyName':
      return 'Acme';
    case 'role':
      return 'Senior Software Engineer';
    case 'pdfText':
    case 'resumeText':
      return 'Sample resume text content for preview.';
    case 'templateName':
      return 'Imported Template';
    case 'jobLink':
      return 'https://jobs.example.com/openings/senior-software-engineer';
    default:
      return `<sample:${variableName}>`;
  }
}

function buildSampleValues(
  allowedVariables: PromptVariableDefinition[],
  providedValues?: Record<string, string>
): Record<string, string> {
  const sampleValues: Record<string, string> = {};
  const provided = providedValues ?? {};

  for (const variable of allowedVariables) {
    sampleValues[variable.name] =
      provided[variable.name] ?? variable.sampleValue ?? buildSampleValue(variable.name);
  }

  return sampleValues;
}

function renderPromptText(
  content: string,
  values: Record<string, string>
): { renderedContent: string; missingVariables: string[] } {
  const missing = new Set<string>();
  const renderedContent = content.replace(VARIABLE_PATTERN, (_match, variableName: string) => {
    const name = normalizeVariableName(variableName);
    if (!(name in values)) {
      missing.add(name);
      return `[[${name}]]`;
    }
    return values[name] ?? '';
  });

  return {
    renderedContent,
    missingVariables: [...missing],
  };
}

export type RenderedPromptSegment = {
  text: string;
  variableName?: string;
};

function renderPromptSegmentsFromText(
  content: string,
  values: Record<string, string>
): { segments: RenderedPromptSegment[]; missingVariables: string[] } {
  const missing = new Set<string>();
  const segments: RenderedPromptSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  VARIABLE_PATTERN.lastIndex = 0;
  while ((match = VARIABLE_PATTERN.exec(content)) !== null) {
    const [rawMatch, rawVariableName] = match;
    const variableName = normalizeVariableName(rawVariableName);
    const literalText = content.slice(lastIndex, match.index);
    if (literalText) {
      segments.push({ text: literalText });
    }

    if (!(variableName in values)) {
      missing.add(variableName);
      segments.push({ text: `[[${variableName}]]`, variableName });
    } else {
      segments.push({ text: values[variableName] ?? '', variableName });
    }

    lastIndex = match.index + rawMatch.length;
  }

  const tailText = content.slice(lastIndex);
  if (tailText) {
    segments.push({ text: tailText });
  }

  return {
    segments,
    missingVariables: [...missing],
  };
}

/**
 * The checks every save makes: no variable the code does not supply and, for
 * a feature prompt, every one its feature requires - refused by name.
 */
function assertValidPromptDraft(
  content: string,
  allowedVariables: PromptVariableDefinition[],
  featureKey?: PromptFeatureKey
): PromptValidation {
  const validation = validatePromptContent(content, allowedVariables);
  if (validation.unknownVariables.length > 0) {
    throw new Error(`Unknown prompt variables: ${validation.unknownVariables.join(', ')}`);
  }
  if (featureKey && validation.missingVariables.length > 0) {
    throw new Error(missingVariablesSentence(featureKey, validation.missingVariables));
  }
  return validation;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'prompt';
}

function generateCustomPromptId(name: string, featureKey?: PromptFeatureKey): string {
  const featurePrefix = featureKey ? `${featureKey}-` : '';
  const base = `${CUSTOM_PROMPT_PREFIX}${featurePrefix}${slugify(name)}`;
  let candidate = base;
  let counter = 1;

  while (true) {
    if (hasStoredPrompt(candidate) || getPromptFeatureDefinitionById(candidate)) {
      candidate = `${base}-${counter}`;
      counter += 1;
    } else {
      return candidate;
    }
  }
}

async function safeStat(filePath: string): Promise<{ createdAt: string; updatedAt: string } | null> {
  try {
    const stats = await fs.stat(filePath);
    return {
      createdAt: stats.birthtime.toISOString(),
      updatedAt: stats.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

/** Reads the shipped default prompt file for a built-in feature prompt. */
async function readDefaultPromptFile(id: string): Promise<StoredPromptSource | null> {
  try {
    const filePath = getDefaultPromptPath(id);
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as StoredPromptJson;
    const content = normalizePromptContent(typeof parsed.content === 'string' ? parsed.content : '');
    if (!content) return null;

    return {
      parsed,
      content,
      timestamps: await safeStat(filePath),
      origin: 'shipped',
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function toStoredPromptSource(record: StoredPrompt): StoredPromptSource | null {
  const content = normalizePromptContent(record.content);
  if (!content) return null;
  return {
    parsed: {
      ...record,
      featureKey: normalizeFeatureKey(record.featureKey),
      responseFormat: normalizeResponseFormat(record.responseFormat as PromptResponseFormat | undefined),
      modelProvider: record.modelProvider as AIProvider | undefined,
      allowedVariables: Array.isArray(record.allowedVariables)
        ? (record.allowedVariables as PromptVariableDefinition[])
        : undefined,
    },
    content,
    timestamps: null,
    origin: 'stored',
  };
}

/**
 * Resolves a built-in prompt: the database row (edited version) wins over the
 * shipped default file, which is only used when no edit has been stored.
 */
async function readBuiltInPromptSource(id: string): Promise<StoredPromptSource | null> {
  const stored = getStoredPrompt(id);
  if (stored) {
    const source = toStoredPromptSource(stored);
    if (source) return source;
  }
  return readDefaultPromptFile(id);
}

function readCustomPromptSource(id: string): StoredPromptSource | null {
  const stored = getStoredPrompt(id);
  return stored && !stored.isBuiltIn ? toStoredPromptSource(stored) : null;
}

function normalizePromptLibraryConfig(input: unknown): PromptLibraryConfig {
  const source = typeof input === 'object' && input !== null
    ? input as { activePrompts?: unknown }
    : {};
  const rawActivePrompts = typeof source.activePrompts === 'object' && source.activePrompts !== null
    ? source.activePrompts as Record<string, unknown>
    : {};
  const activePrompts: Partial<Record<PromptFeatureKey, string>> = {};

  for (const feature of PROMPT_FEATURES) {
    const value = rawActivePrompts[feature.key];
    // Nothing is activated for a feature that runs one prompt per profile or
    // one prompt in all: a stale entry an older build wrote is dropped here,
    // and with it on the next write.
    if (
      !isProfileScopedPromptFeature(feature.key) &&
      !isSinglePromptFeature(feature.key) &&
      typeof value === 'string' &&
      value.trim()
    ) {
      activePrompts[feature.key] = value.trim();
    }
  }

  return { activePrompts };
}

function readPromptLibraryConfig(): PromptLibraryConfig {
  return normalizePromptLibraryConfig({ activePrompts: readActivePrompts() });
}

function writePromptLibraryConfig(config: PromptLibraryConfig): void {
  writeActivePrompts(normalizePromptLibraryConfig(config).activePrompts);
}

function toPromptSummary(record: PromptRecord): PromptSummary {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    featureKey: record.featureKey,
    featureLabel: record.featureLabel,
    category: record.category,
    categoryLabel: record.categoryLabel,
    responseFormat: record.responseFormat,
    modelProvider: record.modelProvider,
    modelName: record.modelName,
    allowedVariables: record.allowedVariables,
    validation: record.validation,
    ...(record.needsUpdate ? { needsUpdate: true as const } : {}),
    ...(record.savedForOlderVersion ? { savedForOlderVersion: true as const } : {}),
    isBuiltIn: record.isBuiltIn,
    isActiveForFeature: record.isActiveForFeature,
    usage: record.usage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function readBuiltInPromptRecord(definition: PromptFeatureDefinition): Promise<PromptRecord | null> {
  const stored = await readBuiltInPromptSource(definition.id);
  if (!stored) {
    console.warn(`Default prompt file missing: ${getDefaultPromptPath(definition.id)}`);
    return null;
  }
  return builtInRecordFrom(definition, stored);
}

/** The built-in prompt as it SHIPPED, ignoring an administrator's edit: what runs in place of a record that needs updating. */
async function readShippedPromptRecord(definition: PromptFeatureDefinition): Promise<PromptRecord | null> {
  const shipped = await readDefaultPromptFile(definition.id);
  if (!shipped) {
    console.warn(`Default prompt file missing: ${getDefaultPromptPath(definition.id)}`);
    return null;
  }
  return builtInRecordFrom(definition, shipped);
}

function builtInRecordFrom(definition: PromptFeatureDefinition, stored: StoredPromptSource): PromptRecord {
  const modelSelection = readStoredPromptModelSelection(
    stored.parsed.modelProvider ?? definition.modelProvider,
    stored.parsed.modelName ?? definition.modelName,
    definition.id
  );
  const allowedVariables = featureAllowedVariables(definition.key);
  const validation = validatePromptContent(stored.content, allowedVariables);
  const updatedAt = typeof stored.parsed.updatedAt === 'string'
    ? stored.parsed.updatedAt
    : stored.timestamps?.updatedAt ?? new Date().toISOString();
  const older = stored.origin === 'stored' && predatesContract(definition.key, updatedAt);

  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    featureKey: definition.key,
    featureLabel: definition.label,
    category: categoryForFeature(definition.key),
    categoryLabel: getPromptCategory(categoryForFeature(definition.key)).label,
    responseFormat: definition.responseFormat,
    modelProvider: modelSelection?.provider,
    modelName: modelSelection?.modelName,
    allowedVariables,
    validation,
    ...promptFlags(validation, definition.key, older),
    isBuiltIn: true,
    isActiveForFeature: false,
    usage: definition.usage,
    createdAt: typeof stored.parsed.createdAt === 'string'
      ? stored.parsed.createdAt
      : stored.timestamps?.createdAt ?? new Date().toISOString(),
    updatedAt,
    content: stored.content,
  };
}

function readCustomPromptFile(id: string): (StoredPromptMeta & { content: string }) | null {
  const stored = readCustomPromptSource(id);
  if (!stored) return null;

  const parsed = stored.parsed;
  const featureKey = normalizeFeatureKey(parsed.featureKey);
  const feature = featureKey ? getPromptFeatureDefinition(featureKey) : null;
  const modelSelection = readStoredPromptModelSelection(parsed.modelProvider, parsed.modelName, id);
  const allowedVariables = feature
    ? featureAllowedVariables(feature.key)
    : normalizeAllowedVariables(Array.isArray(parsed.allowedVariables) ? parsed.allowedVariables : []);

  return {
    id: typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id.trim() : id,
    name: normalizePromptName(typeof parsed.name === 'string' ? parsed.name : id),
    description: normalizePromptDescription(typeof parsed.description === 'string' ? parsed.description : ''),
    featureKey,
    responseFormat: feature ? feature.responseFormat : normalizeResponseFormat(parsed.responseFormat),
    modelProvider: modelSelection?.provider,
    modelName: modelSelection?.modelName,
    allowedVariables,
    createdAt: typeof parsed.createdAt === 'string' && parsed.createdAt.trim()
      ? parsed.createdAt.trim()
      : stored.timestamps?.createdAt ?? new Date().toISOString(),
    updatedAt: typeof parsed.updatedAt === 'string' && parsed.updatedAt.trim()
      ? parsed.updatedAt.trim()
      : stored.timestamps?.updatedAt ?? new Date().toISOString(),
    content: stored.content,
  };
}

function readCustomPromptRecord(id: string): PromptRecord | null {
  const prompt = readCustomPromptFile(id);
  if (!prompt) return null;
  const validation = validatePromptContent(prompt.content, prompt.allowedVariables);

  return {
    id: prompt.id,
    name: prompt.name,
    description: prompt.description,
    featureKey: prompt.featureKey,
    featureLabel: prompt.featureKey ? getPromptFeatureDefinition(prompt.featureKey).label : undefined,
    category: categoryForFeature(prompt.featureKey),
    categoryLabel: getPromptCategory(categoryForFeature(prompt.featureKey)).label,
    responseFormat: prompt.responseFormat,
    modelProvider: prompt.modelProvider,
    modelName: prompt.modelName,
    allowedVariables: prompt.allowedVariables,
    validation,
    ...promptFlags(validation, prompt.featureKey, Boolean(prompt.featureKey && predatesContract(prompt.featureKey, prompt.updatedAt))),
    isBuiltIn: false,
    isActiveForFeature: false,
    usage: prompt.featureKey ? getPromptFeatureDefinition(prompt.featureKey).usage : undefined,
    createdAt: prompt.createdAt,
    updatedAt: prompt.updatedAt,
    content: prompt.content,
  };
}

function writeStoredPrompt(
  id: string,
  prompt: StoredPromptJson & { content: string },
  isBuiltIn: boolean
): void {
  const now = new Date().toISOString();
  saveStoredPrompt({
    ...prompt,
    id,
    content: prompt.content,
    isBuiltIn,
    createdAt: prompt.createdAt ?? now,
    updatedAt: prompt.updatedAt ?? now,
  });
}

async function listAllPromptRecords(): Promise<PromptRecord[]> {
  const builtInRecords = (await Promise.all(PROMPT_FEATURES.map(readBuiltInPromptRecord)))
    .filter((record): record is PromptRecord => record !== null);

  const customRecords = listCustomPrompts()
    .filter((prompt) => !getPromptFeatureDefinitionById(prompt.id))
    .map((prompt) => readCustomPromptRecord(prompt.id))
    .filter((record): record is PromptRecord => record !== null);

  const config = readPromptLibraryConfig();
  const activeByFeature = new Map<PromptFeatureKey, string>();

  for (const feature of PROMPT_FEATURES) {
    if (isProfileScopedPromptFeature(feature.key)) {
      continue;
    }

    const variants = [...builtInRecords, ...customRecords].filter((record) => record.featureKey === feature.key);
    // A single-prompt feature runs its built-in record and nothing else,
    // whatever an older build recorded as activated.
    const configuredId = isSinglePromptFeature(feature.key) ? undefined : config.activePrompts[feature.key];
    const activeId = configuredId && variants.some((record) => record.id === configuredId)
      ? configuredId
      : variants.some((record) => record.id === feature.id)
        ? feature.id
        : variants[0]?.id;
    if (activeId) {
      activeByFeature.set(feature.key, activeId);
    }
  }

  const featureOrder = new Map(PROMPT_FEATURES.map((feature, index) => [feature.key, index] as const));

  return [...builtInRecords, ...customRecords]
    .map((record) => ({
      ...record,
      isActiveForFeature: record.featureKey ? activeByFeature.get(record.featureKey) === record.id : false,
    }))
    .sort((left, right) => {
      const leftOrder = left.featureKey ? (featureOrder.get(left.featureKey) ?? 999) : 999;
      const rightOrder = right.featureKey ? (featureOrder.get(right.featureKey) ?? 999) : 999;
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      const leftProfileScoped = isProfileScopedPromptFeature(left.featureKey);
      const rightProfileScoped = isProfileScopedPromptFeature(right.featureKey);
      if (
        !leftProfileScoped &&
        !rightProfileScoped &&
        (left.isActiveForFeature ? 0 : 1) !== (right.isActiveForFeature ? 0 : 1)
      ) {
        return (left.isActiveForFeature ? 0 : 1) - (right.isActiveForFeature ? 0 : 1);
      }
      if ((left.isBuiltIn ? 0 : 1) !== (right.isBuiltIn ? 0 : 1)) {
        return (left.isBuiltIn ? 0 : 1) - (right.isBuiltIn ? 0 : 1);
      }
      return left.name.localeCompare(right.name);
    });
}

async function getPromptRecordByIdExact(id: string): Promise<PromptRecord | null> {
  if (getPromptFeatureDefinitionById(id)) {
    return readBuiltInPromptRecord(getPromptFeatureDefinitionById(id)!);
  }
  return readCustomPromptRecord(id);
}

export async function listPrompts(): Promise<PromptSummary[]> {
  const records = await listAllPromptRecords();
  return records.map(toPromptSummary);
}

export async function getPromptById(id: string): Promise<PromptRecord | null> {
  const records = await listAllPromptRecords();
  return records.find((record) => record.id === id) ?? null;
}

export async function getRuntimePromptByFeature(featureKey: PromptFeatureKey): Promise<PromptRecord | null> {
  if (isProfileScopedPromptFeature(featureKey)) {
    const builtIn = await getPromptRecordByIdExact(featureKey);
    if (builtIn) {
      return builtIn;
    }
  }

  const records = await listAllPromptRecords();
  const exactActive = records.find((record) => record.featureKey === featureKey && record.isActiveForFeature);
  if (exactActive) {
    return exactActive;
  }

  const builtIn = records.find((record) => record.id === featureKey);
  if (builtIn) {
    return builtIn;
  }

  return records.find((record) => record.featureKey === featureKey) ?? null;
}

function resolveCreateDraftContext(input: PromptCreateInput): {
  featureKey?: PromptFeatureKey;
  responseFormat: PromptResponseFormat;
  allowedVariables: PromptVariableDefinition[];
} {
  const featureKey = normalizeFeatureKey(input.featureKey);
  if (!featureKey) {
    return {
      featureKey: undefined,
      responseFormat: normalizeResponseFormat(input.responseFormat),
      allowedVariables: normalizeAllowedVariables(input.allowedVariables),
    };
  }

  const feature = getPromptFeatureDefinition(featureKey);
  return {
    featureKey,
    responseFormat: feature.responseFormat,
    allowedVariables: featureAllowedVariables(featureKey),
  };
}

/** A new prompt for a single-prompt feature would never run: it has one prompt, its built-in. */
function assertNotSinglePromptVariant(featureKey: PromptFeatureKey | undefined): void {
  const rule = featureKey ? SINGLE_PROMPT_FEATURES.get(featureKey) : undefined;
  if (rule) throw new Error(rule.variant);
}

export async function createPrompt(input: PromptCreateInput): Promise<PromptRecord> {
  const name = normalizePromptName(input.name);
  const description = normalizePromptDescription(input.description);
  const content = normalizePromptContent(input.content);
  const modelSelection = normalizePromptModelOverride(input.modelProvider, input.modelName);
  const draftContext = resolveCreateDraftContext(input);

  if (!name) {
    throw new Error('Prompt name is required');
  }
  if (!content) {
    throw new Error('Prompt content is required');
  }
  assertNotSinglePromptVariant(draftContext.featureKey);

  // For a feature prompt, the variables its code supplies (see
  // `featureAllowedVariables`); otherwise the ones the author declared.
  const allowedVariables = draftContext.allowedVariables;

  assertValidPromptDraft(content, allowedVariables, draftContext.featureKey);

  const id = generateCustomPromptId(name, draftContext.featureKey);
  const now = new Date().toISOString();
  const prompt: StoredPromptMeta & { content: string } = {
    id,
    name,
    description,
    featureKey: draftContext.featureKey,
    responseFormat: draftContext.responseFormat,
    modelProvider: modelSelection?.provider,
    modelName: modelSelection?.modelName,
    allowedVariables,
    createdAt: now,
    updatedAt: now,
    content,
  };

  writeStoredPrompt(id, prompt, false);

  const saved = await getPromptById(id);
  if (!saved) {
    throw new Error('Failed to create prompt');
  }
  return saved;
}

function resolveUpdateDraftContext(
  input: PromptUpdateInput,
  current: StoredPromptMeta & { content: string }
): {
  featureKey?: PromptFeatureKey;
  responseFormat: PromptResponseFormat;
  allowedVariables: PromptVariableDefinition[];
} {
  const nextFeatureKey = normalizeFeatureKey(input.featureKey ?? current.featureKey);
  if (!nextFeatureKey) {
    return {
      featureKey: undefined,
      responseFormat: normalizeResponseFormat(input.responseFormat ?? current.responseFormat),
      allowedVariables: normalizeAllowedVariables(input.allowedVariables ?? current.allowedVariables),
    };
  }

  const feature = getPromptFeatureDefinition(nextFeatureKey);
  return {
    featureKey: nextFeatureKey,
    responseFormat: feature.responseFormat,
    allowedVariables: featureAllowedVariables(nextFeatureKey),
  };
}

export async function updatePrompt(id: string, input: PromptUpdateInput): Promise<PromptRecord | null> {
  const content = normalizePromptContent(input.content);
  if (!content) {
    throw new Error('Prompt content is required');
  }

  if (getPromptFeatureDefinitionById(id)) {
    const feature = getPromptFeatureDefinitionById(id);
    if (!feature) return null;
    const existing = await readBuiltInPromptSource(id);
    // Compared with the override the prompt reads as having now - its stored
    // one, else the shipped one - so saving the text alone never trips over it.
    const modelSelection = normalizePromptModelOverride(input.modelProvider, input.modelName, {
      provider: existing?.parsed.modelProvider ?? feature.modelProvider,
      modelName: existing?.parsed.modelName ?? feature.modelName,
    });
    assertValidPromptDraft(content, featureAllowedVariables(feature.key), feature.key);
    writeStoredPrompt(id, {
      id,
      featureKey: feature.key,
      content,
      modelProvider: modelSelection?.provider,
      modelName: modelSelection?.modelName,
      createdAt: typeof existing?.parsed.createdAt === 'string'
        ? existing.parsed.createdAt
        : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, true);
    return getPromptById(id);
  }

  const current = readCustomPromptFile(id);
  if (!current) return null;

  const name = normalizePromptName(input.name ?? current.name);
  const description = normalizePromptDescription(input.description ?? current.description);
  const draftContext = resolveUpdateDraftContext(input, current);
  // A variant written before keeps its feature; moving another prompt INTO
  // a single-prompt feature would make one more that never runs.
  if (draftContext.featureKey !== current.featureKey) assertNotSinglePromptVariant(draftContext.featureKey);
  const modelSelection = normalizePromptModelOverride(
    input.modelProvider ?? current.modelProvider,
    input.modelName ?? current.modelName,
    { provider: current.modelProvider, modelName: current.modelName }
  );

  if (!name) {
    throw new Error('Prompt name is required');
  }

  const allowedVariables = draftContext.allowedVariables;

  assertValidPromptDraft(content, allowedVariables, draftContext.featureKey);

  const nextPrompt: StoredPromptMeta & { content: string } = {
    ...current,
    name,
    description,
    featureKey: draftContext.featureKey,
    responseFormat: draftContext.responseFormat,
    modelProvider: modelSelection?.provider,
    modelName: modelSelection?.modelName,
    allowedVariables,
    updatedAt: new Date().toISOString(),
    content,
  };

  writeStoredPrompt(id, nextPrompt, false);

  return getPromptById(id);
}

export async function activatePrompt(id: string): Promise<PromptActivationResult> {
  const prompt = await getPromptRecordByIdExact(id);
  if (!prompt) {
    throw new Error('Prompt not found');
  }
  if (!prompt.featureKey) {
    throw new Error('Only feature-linked prompts can be activated');
  }
  if (isProfileScopedPromptFeature(prompt.featureKey)) {
    throw new Error('Resume prompts are selected per profile');
  }
  const single = SINGLE_PROMPT_FEATURES.get(prompt.featureKey);
  if (single && prompt.id !== prompt.featureKey) {
    throw new Error(single.activation);
  }

  const config = readPromptLibraryConfig();
  config.activePrompts[prompt.featureKey] = prompt.id;
  writePromptLibraryConfig(config);

  return {
    featureKey: prompt.featureKey,
    promptId: prompt.id,
  };
}

export async function deletePrompt(id: string): Promise<boolean> {
  if (getPromptFeatureDefinitionById(id)) {
    throw new Error('Cannot delete built-in prompts');
  }

  const prompt = await getPromptById(id);
  if (!prompt) return false;

  deleteStoredPrompt(id);

  if (prompt.featureKey) {
    const config = readPromptLibraryConfig();
    if (config.activePrompts[prompt.featureKey] === id) {
      delete config.activePrompts[prompt.featureKey];
      writePromptLibraryConfig(config);
    }
  }

  return true;
}

/**
 * The text a validate or preview call is about, and the variables it is
 * checked against - the SAME ones a save would check it against, so a draft
 * that validates clean is one that saves and runs.
 *
 * A draft that is not saved yet has no record to say which feature it belongs
 * to, so it says so itself (`featureKey`); without one it is checked against
 * the variables it declares, like an unattached prompt.
 */
function resolveDraftSource(
  record: PromptRecord | null,
  input: PromptPreviewInput
): { content: string; allowedVariables: PromptVariableDefinition[] } {
  if (record) {
    const content = input.content ? normalizePromptContent(input.content) : record.content;
    return {
      content,
      allowedVariables: record.featureKey
        ? featureAllowedVariables(record.featureKey)
        : record.isBuiltIn
          ? record.allowedVariables
          : normalizeAllowedVariables(input.allowedVariables ?? record.allowedVariables),
    };
  }

  const content = normalizePromptContent(input.content ?? '');
  const featureKey = normalizeFeatureKey(input.featureKey);
  const allowedVariables = featureKey
    ? featureAllowedVariables(featureKey)
    : normalizeAllowedVariables(input.allowedVariables);

  if (!content) {
    throw new Error('Prompt content is required');
  }

  return {
    content,
    allowedVariables,
  };
}

export async function previewPrompt(input: PromptPreviewInput): Promise<PromptPreviewResult> {
  const stored = input.id ? await getPromptById(input.id) : null;
  if (input.id && !stored) {
    throw new Error('Prompt not found');
  }

  const { content, allowedVariables } = resolveDraftSource(stored, input);
  const validation = validatePromptContent(content, allowedVariables);
  const sampleValues = buildSampleValues(allowedVariables, input.sampleValues);
  const { renderedContent } = renderPromptText(content, sampleValues);

  return {
    renderedContent,
    sampleValues,
    validation,
  };
}

export async function validatePromptDraft(input: PromptPreviewInput): Promise<PromptValidation> {
  const stored = input.id ? await getPromptById(input.id) : null;
  if (input.id && !stored) {
    throw new Error('Prompt not found');
  }

  const { content, allowedVariables } = resolveDraftSource(stored, input);
  return validatePromptContent(content, allowedVariables);
}

const warnedNeedsUpdate = new Set<string>();

/**
 * Why a flagged record is not run, as the log line says it: the required
 * variables it leaves out, the variables it names that this version's code
 * does not supply, and whether it was saved before its feature's contract
 * changed - each a sign of an edit written for an older prompt contract.
 */
function needsUpdateReason(record: PromptRecord, label: string): string {
  const reasons: string[] = [];
  if (record.validation.missingVariables.length > 0) {
    reasons.push(`does not use ${variableList(record.validation.missingVariables)}, which every ${label} prompt must`);
  }
  if (record.validation.unknownVariables.length > 0) {
    reasons.push(`uses ${variableList(record.validation.unknownVariables)}, which this version does not supply`);
  }
  if (record.savedForOlderVersion) {
    reasons.push(`dates from an older version of the ${label} prompt`);
  }
  return reasons.join(', and ');
}

/**
 * The record a run uses in place of `record`: itself, unless it is flagged
 * `needsUpdate` - it lacks one of its feature's required variables, names
 * one its feature's code no longer supplies, or was saved before its
 * feature's contract changed - then the feature's built-in prompt, as an
 * administrator edited it when that edit is usable, else as it shipped. Said
 * once per record and text, naming the reason, so the administrator knows
 * their edit is not what runs.
 *
 * This is how an edit made for an older contract gives way to the shipped
 * text with no migration: an analysis edit asking for the old job field and
 * industry lists, a filter edit reading `[[jobContent]]`, a tailoring
 * variant written before its required variables - and, by its date, an
 * analysis or job facts edit older than the lists that names nothing but
 * `[[jobDescription]]`, as the owner's new texts do too.
 *
 * Only the runtime asks this; Admin -> Prompts lists and edits the stored
 * record as it is, flagged.
 */
async function usableAtRuntime(record: PromptRecord | null): Promise<PromptRecord | null> {
  if (!record?.needsUpdate || !record.featureKey) return record;
  const definition = getPromptFeatureDefinition(record.featureKey);
  let replacement = record.id === definition.id ? null : await readBuiltInPromptRecord(definition);
  if (!replacement || replacement.needsUpdate) replacement = await readShippedPromptRecord(definition);
  const key = `${record.id}:${record.updatedAt}`;
  if (!warnedNeedsUpdate.has(key)) {
    warnedNeedsUpdate.add(key);
    console.warn(
      `[prompts] The prompt "${record.name}" (${record.id}) ${needsUpdateReason(record, definition.label)}; ` +
        `the built-in ${definition.label} prompt runs instead until it is updated under Admin -> Prompts.`
    );
  }
  return replacement;
}

async function resolvePromptForRuntime(id: string): Promise<PromptRecord | null> {
  if (isPromptFeatureKey(id)) {
    return usableAtRuntime(await getRuntimePromptByFeature(id));
  }
  return usableAtRuntime(await getPromptById(id));
}

/** The record a run by feature or id uses - never one that needs updating (see `usableAtRuntime`). */
export async function resolvePromptByRuntimeId(id: string): Promise<PromptRecord | null> {
  return resolvePromptForRuntime(id);
}

/** The record a run by exact id uses - never one that needs updating (see `usableAtRuntime`). */
export async function resolvePromptByExactId(id: string): Promise<PromptRecord | null> {
  return usableAtRuntime(await getPromptRecordByIdExact(id));
}

export async function renderPrompt(
  id: string,
  values: Record<string, string>
): Promise<string> {
  const prompt = await resolvePromptForRuntime(id);
  if (!prompt) {
    throw new Error(`Prompt "${id}" not found`);
  }

  if (prompt.validation.unknownVariables.length > 0) {
    throw new Error(
      `Prompt "${prompt.id}" contains unknown variables: ${prompt.validation.unknownVariables.join(', ')}`
    );
  }

  const { renderedContent, missingVariables } = renderPromptText(prompt.content, values);
  if (missingVariables.length > 0) {
    throw new Error(
      `Prompt "${prompt.id}" is missing runtime values for: ${missingVariables.join(', ')}`
    );
  }

  return renderedContent;
}

export async function renderPromptSegments(
  id: string,
  values: Record<string, string>
): Promise<RenderedPromptSegment[]> {
  const prompt = await resolvePromptForRuntime(id);
  if (!prompt) {
    throw new Error(`Prompt "${id}" not found`);
  }

  if (prompt.validation.unknownVariables.length > 0) {
    throw new Error(
      `Prompt "${prompt.id}" contains unknown variables: ${prompt.validation.unknownVariables.join(', ')}`
    );
  }

  const { segments, missingVariables } = renderPromptSegmentsFromText(prompt.content, values);
  if (missingVariables.length > 0) {
    throw new Error(
      `Prompt "${prompt.id}" is missing runtime values for: ${missingVariables.join(', ')}`
    );
  }

  return segments;
}

export async function renderPromptSegmentsByExactId(
  id: string,
  values: Record<string, string>
): Promise<RenderedPromptSegment[]> {
  const prompt = await resolvePromptByExactId(id);
  if (!prompt) {
    throw new Error(`Prompt "${id}" not found`);
  }

  if (prompt.validation.unknownVariables.length > 0) {
    throw new Error(
      `Prompt "${prompt.id}" contains unknown variables: ${prompt.validation.unknownVariables.join(', ')}`
    );
  }

  const { segments, missingVariables } = renderPromptSegmentsFromText(prompt.content, values);
  if (missingVariables.length > 0) {
    throw new Error(
      `Prompt "${prompt.id}" is missing runtime values for: ${missingVariables.join(', ')}`
    );
  }

  return segments;
}
