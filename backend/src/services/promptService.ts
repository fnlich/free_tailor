import fs from 'fs/promises';
import path from 'path';
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
import { normalizePromptModelSelection } from './aiModelCatalog';
import type { AIProvider } from '../types/template';

const DATA_DIR = process.env.TAILOR_DATA_DIR
  ? path.resolve(process.env.TAILOR_DATA_DIR)
  : path.join(__dirname, '../../data');
const CONFIG_DIR = path.join(DATA_DIR, 'config');
const PROMPTS_DIR = path.join(DATA_DIR, 'prompts');
const PROMPT_LIBRARY_CONFIG_FILE = path.join(CONFIG_DIR, 'prompt-library.json');
const CUSTOM_PROMPT_PREFIX = 'custom-';
const PROMPT_SUFFIX = '.json';
const VARIABLE_PATTERN = /\[\[\s*([a-zA-Z0-9_.-]+)\s*\]\]/g;
const PROFILE_SCOPED_PROMPT_FEATURES = new Set<PromptFeatureKey>([
  'analyze-job-description',
  'tailor-resume',
]);

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
    description: 'Extracts structured ATS keywords, role metadata, and soft-skill signals from a raw job description.',
    usage: 'Live prompt used by the resume analysis flow.',
    responseFormat: 'json',
    allowedVariables: [
      {
        name: 'jobDescription',
        description: 'Raw job description text pasted by the user.',
        sampleValue: `Senior Software Engineer

We are looking for a backend-focused engineer with strong Node.js, TypeScript, PostgreSQL, Docker, and AWS experience.

You will design scalable APIs, collaborate cross-functionally, improve reliability, and mentor teammates.

Preferred: GraphQL, Kubernetes, Terraform, CI/CD, and experience in fast-paced startup environments.`,
      },
    ],
  },
  {
    key: 'tailor-resume',
    label: 'Tailor Resume',
    id: 'tailor-resume',
    name: 'Tailor Resume',
    description: 'Rewrites a profile against structured job analysis data and returns tailored resume content.',
    usage: 'Prompt variant available for profile-specific resume generation.',
    responseFormat: 'json',
    allowedVariables: [
      {
        name: 'profileJson',
        description: 'Serialized candidate profile JSON.',
        sampleValue: `{
  "name": "Jane Doe",
  "title": "Senior Software Engineer",
  "totalYearsExperience": 7,
  "summary": "Backend-focused engineer with experience in scalable systems.",
  "skills": ["Node.js", "TypeScript", "PostgreSQL", "AWS"],
  "experience": [
    {
      "title": "Senior Software Engineer",
      "company": "Acme",
      "startDate": "01/2022",
      "endDate": "Present",
      "location": "Remote",
      "description": "Builds backend services and platform tooling.",
      "skills": ["Node.js", "TypeScript", "PostgreSQL", "AWS"],
      "achievements": [
        "Reduced API latency by 35%.",
        "Led migration to TypeScript."
      ]
    }
  ]
}`,
      },
      {
        name: 'jobAnalysisJson',
        description: 'Serialized job analysis JSON produced from the target job description.',
        sampleValue: `{
  "jobMeta": {
    "title": "Senior Backend Engineer",
    "seniority": "Senior",
    "industry": "Software",
    "department": "Engineering"
  },
  "skills": {
    "required": ["Node.js", "TypeScript", "PostgreSQL", "AWS"],
    "preferred": ["GraphQL", "Docker"],
    "tools": ["Docker"],
    "technologies": ["microservices", "CI/CD"]
  },
  "responsibilities": [
    "design and implement scalable backend services",
    "collaborate with product and design teams"
  ],
  "domainKnowledge": ["backend platforms", "distributed systems"],
  "softSkills": ["high ownership mentality", "excellent written communication"],
  "keywords": {
    "actionVerbs": ["design", "collaborate"],
    "buzzwords": ["scalable systems", "ownership mindset"],
    "mustInclude": ["Node.js", "TypeScript"]
  }
}`,
      },
      {
        name: 'jobTitle',
        description: 'Exact job title extracted from job analysis.',
        sampleValue: 'Senior Backend Engineer',
      },
      {
        name: 'skillsJSON',
        description: 'Serialized technical skills extracted from the job analysis, including skills, tools, technologies, protocols, methodologies, and architecture patterns.',
        sampleValue: `["Node.js", "TypeScript", "PostgreSQL", "AWS", "GraphQL", "Docker"]`,
      },
      {
        name: 'hardSkillsJson',
        description: 'Backward-compatible alias for skillsJSON. Serialized flat array of code-decided technical skill names.',
        sampleValue: `["TypeScript", "Python", "JavaScript", "SQL", "Go", "React", "Node.js", "Next.js", "Express", "Django"]`,
      },
      {
        name: 'domainKnowledge',
        description: 'Serialized domain knowledge and industry terms array.',
        sampleValue: `["backend platforms", "distributed systems", "Software"]`,
      },
      {
        name: 'keywordsJson',
        description: 'Serialized unified ATS keyword array, including action terms, tools, technologies, domain terms, and soft skills.',
        sampleValue: `["scalable systems", "cross-functional collaboration", "ownership mindset", "written communication"]`,
      },
      {
        name: 'keyResponsibilitiesJson',
        description: 'Serialized job responsibilities array.',
        sampleValue: `[
  "design and implement scalable backend services",
  "collaborate with product and design teams"
]`,
      },
    ],
  },
  {
    key: 'generate-cover-letter',
    label: 'Generate Cover Letter',
    id: 'generate-cover-letter',
    name: 'Generate Cover Letter',
    description: 'Generates a concise cover letter body using the profile and application details.',
    usage: 'Prompt variant available for profile-specific cover letter generation.',
    responseFormat: 'text',
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
  {
    key: 'filter-google-sheet-job',
    label: 'Filter Google Sheet Job',
    id: 'filter-google-sheet-job',
    name: 'Filter Google Sheet Job',
    description: 'Analyzes scraped job-page content and returns structured job attributes for Google Sheets.',
    usage: 'Live prompt used by the Google Sheets job filter flow.',
    responseFormat: 'json',
    allowedVariables: [
      {
        name: 'jobContent',
        description: 'Scraped text content from the full job page.',
        sampleValue: `Senior Software Engineer

Remote - United States

We are hiring a remote backend engineer based in the US. This role is fully remote, does not require a security clearance, and is not in the healthcare industry.

Compensation: $180,000 - $220,000 base salary plus equity.

Requirements:
- 5+ years of backend engineering experience
- Node.js, TypeScript, PostgreSQL
- Strong written communication`,
      },
      {
        name: 'jobDescription',
        description: 'Legacy alias for jobContent so older prompts continue to render.',
        sampleValue: `Senior Software Engineer

Remote - United States

We are hiring a remote backend engineer based in the US. This role is fully remote, does not require a security clearance, and is not in the healthcare industry.

Compensation: $180,000 - $220,000 base salary plus equity.

Requirements:
- 5+ years of backend engineering experience
- Node.js, TypeScript, PostgreSQL
- Strong written communication`,
      },
      {
        name: 'jobLink',
        description: 'Original job URL for the scraped page.',
        sampleValue: 'https://jobs.example.com/openings/senior-software-engineer',
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

function getPromptPath(id: string): string {
  return path.join(PROMPTS_DIR, `${id}${PROMPT_SUFFIX}`);
}

async function ensurePromptStorage(): Promise<void> {
  await fs.mkdir(PROMPTS_DIR, { recursive: true });
  await fs.mkdir(CONFIG_DIR, { recursive: true });
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

export function validatePromptContent(
  content: string,
  allowedVariables: PromptVariableDefinition[]
): PromptValidation {
  const usedVariables = extractPromptVariables(content);
  const allowed = new Set(allowedVariables.map((variable) => variable.name));
  const unknownVariables = usedVariables.filter((name) => !allowed.has(name));

  return {
    usedVariables,
    unknownVariables,
  };
}

function resolveFeatureAllowedVariables(
  content: string,
  knownVariables: PromptVariableDefinition[]
): PromptVariableDefinition[] {
  const knownByName = new Map(
    knownVariables.map((variable) => [variable.name, variable] as const)
  );

  return extractPromptVariables(content).map((name) => {
    const known = knownByName.get(name);
    return known
      ? { ...known }
      : {
          name,
          sampleValue: buildSampleValue(name),
        };
  });
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
    "seniority": "Senior",
    "industry": "Software",
    "department": "Engineering"
  },
  "skills": {
    "required": ["Node.js", "TypeScript", "PostgreSQL", "AWS"],
    "preferred": ["GraphQL", "Docker"],
    "tools": ["Docker"],
    "technologies": ["microservices", "CI/CD"]
  },
  "responsibilities": ["design scalable backend services"],
  "domainKnowledge": ["backend platforms", "distributed systems"],
  "softSkills": ["ownership mindset"],
  "keywords": {
    "actionVerbs": ["design"],
    "buzzwords": ["scalable systems"],
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

function assertValidPromptDraft(
  content: string,
  allowedVariables: PromptVariableDefinition[]
): PromptValidation {
  const validation = validatePromptContent(content, allowedVariables);
  if (validation.unknownVariables.length > 0) {
    throw new Error(`Unknown prompt variables: ${validation.unknownVariables.join(', ')}`);
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

async function generateCustomPromptId(name: string, featureKey?: PromptFeatureKey): Promise<string> {
  const featurePrefix = featureKey ? `${featureKey}-` : '';
  const base = `${CUSTOM_PROMPT_PREFIX}${featurePrefix}${slugify(name)}`;
  let candidate = base;
  let counter = 1;

  while (true) {
    try {
      await fs.access(getPromptPath(candidate));
      candidate = `${base}-${counter}`;
      counter += 1;
    } catch {
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

async function readPromptJson(id: string): Promise<{
  parsed: StoredPromptJson;
  content: string;
  timestamps: { createdAt: string; updatedAt: string } | null;
} | null> {
  try {
    const filePath = getPromptPath(id);
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as StoredPromptJson;
    const content = normalizePromptContent(typeof parsed.content === 'string' ? parsed.content : '');
    if (!content) return null;

    return {
      parsed,
      content,
      timestamps: await safeStat(filePath),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
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
    if (!isProfileScopedPromptFeature(feature.key) && typeof value === 'string' && value.trim()) {
      activePrompts[feature.key] = value.trim();
    }
  }

  return { activePrompts };
}

async function readPromptLibraryConfig(): Promise<PromptLibraryConfig> {
  try {
    const raw = await fs.readFile(PROMPT_LIBRARY_CONFIG_FILE, 'utf-8');
    return normalizePromptLibraryConfig(JSON.parse(raw) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { activePrompts: {} };
    }
    throw error;
  }
}

async function writePromptLibraryConfig(config: PromptLibraryConfig): Promise<void> {
  await fs.writeFile(
    PROMPT_LIBRARY_CONFIG_FILE,
    `${JSON.stringify(normalizePromptLibraryConfig(config), null, 2)}\n`,
    'utf-8'
  );
}

function toPromptSummary(record: PromptRecord): PromptSummary {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    featureKey: record.featureKey,
    featureLabel: record.featureLabel,
    responseFormat: record.responseFormat,
    modelProvider: record.modelProvider,
    modelName: record.modelName,
    allowedVariables: record.allowedVariables,
    validation: record.validation,
    isBuiltIn: record.isBuiltIn,
    isActiveForFeature: record.isActiveForFeature,
    usage: record.usage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function readBuiltInPromptRecord(definition: PromptFeatureDefinition): Promise<PromptRecord | null> {
  const stored = await readPromptJson(definition.id);
  if (!stored) {
    console.warn(`Built-in prompt file missing: ${definition.id}`);
    return null;
  }

  const modelSelection = normalizePromptModelSelection(
    stored.parsed.modelProvider ?? definition.modelProvider,
    stored.parsed.modelName ?? definition.modelName
  );
  const allowedVariables = resolveFeatureAllowedVariables(stored.content, definition.allowedVariables);

  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    featureKey: definition.key,
    featureLabel: definition.label,
    responseFormat: definition.responseFormat,
    modelProvider: modelSelection?.provider,
    modelName: modelSelection?.modelName,
    allowedVariables,
    validation: validatePromptContent(stored.content, allowedVariables),
    isBuiltIn: true,
    isActiveForFeature: false,
    usage: definition.usage,
    createdAt: typeof stored.parsed.createdAt === 'string'
      ? stored.parsed.createdAt
      : stored.timestamps?.createdAt ?? new Date().toISOString(),
    updatedAt: typeof stored.parsed.updatedAt === 'string'
      ? stored.parsed.updatedAt
      : stored.timestamps?.updatedAt ?? new Date().toISOString(),
    content: stored.content,
  };
}

async function readCustomPromptFile(id: string): Promise<(StoredPromptMeta & { content: string }) | null> {
  const stored = await readPromptJson(id);
  if (!stored) return null;

  const parsed = stored.parsed;
  const featureKey = normalizeFeatureKey(parsed.featureKey);
  const feature = featureKey ? getPromptFeatureDefinition(featureKey) : null;
  const modelSelection = normalizePromptModelSelection(parsed.modelProvider, parsed.modelName);
  const allowedVariables = feature
    ? resolveFeatureAllowedVariables(stored.content, feature.allowedVariables)
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

async function readCustomPromptRecord(id: string): Promise<PromptRecord | null> {
  const prompt = await readCustomPromptFile(id);
  if (!prompt) return null;

  return {
    id: prompt.id,
    name: prompt.name,
    description: prompt.description,
    featureKey: prompt.featureKey,
    featureLabel: prompt.featureKey ? getPromptFeatureDefinition(prompt.featureKey).label : undefined,
    responseFormat: prompt.responseFormat,
    modelProvider: prompt.modelProvider,
    modelName: prompt.modelName,
    allowedVariables: prompt.allowedVariables,
    validation: validatePromptContent(prompt.content, prompt.allowedVariables),
    isBuiltIn: false,
    isActiveForFeature: false,
    usage: prompt.featureKey ? getPromptFeatureDefinition(prompt.featureKey).usage : undefined,
    createdAt: prompt.createdAt,
    updatedAt: prompt.updatedAt,
    content: prompt.content,
  };
}

async function writePromptJson(id: string, prompt: StoredPromptJson & { content: string }): Promise<void> {
  await fs.writeFile(getPromptPath(id), `${JSON.stringify(prompt, null, 2)}\n`, 'utf-8');
}

async function listAllPromptRecords(): Promise<PromptRecord[]> {
  await ensurePromptStorage();

  const builtInRecords = (await Promise.all(PROMPT_FEATURES.map(readBuiltInPromptRecord)))
    .filter((record): record is PromptRecord => record !== null);

  const entries = await fs.readdir(PROMPTS_DIR);
  const customIds = entries
    .filter((entry) => entry.endsWith(PROMPT_SUFFIX))
    .map((entry) => entry.slice(0, -PROMPT_SUFFIX.length))
    .filter((id) => !getPromptFeatureDefinitionById(id));

  const customRecords = (await Promise.all(customIds.map(readCustomPromptRecord)))
    .filter((record): record is PromptRecord => record !== null);

  const config = await readPromptLibraryConfig();
  const activeByFeature = new Map<PromptFeatureKey, string>();

  for (const feature of PROMPT_FEATURES) {
    if (isProfileScopedPromptFeature(feature.key)) {
      continue;
    }

    const variants = [...builtInRecords, ...customRecords].filter((record) => record.featureKey === feature.key);
    const configuredId = config.activePrompts[feature.key];
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
    allowedVariables: cloneAllowedVariables(feature.allowedVariables),
  };
}

export async function createPrompt(input: PromptCreateInput): Promise<PromptRecord> {
  await ensurePromptStorage();

  const name = normalizePromptName(input.name);
  const description = normalizePromptDescription(input.description);
  const content = normalizePromptContent(input.content);
  const modelSelection = normalizePromptModelSelection(input.modelProvider, input.modelName);
  const draftContext = resolveCreateDraftContext(input);

  if (!name) {
    throw new Error('Prompt name is required');
  }
  if (!content) {
    throw new Error('Prompt content is required');
  }

  const allowedVariables = draftContext.featureKey
    ? resolveFeatureAllowedVariables(content, draftContext.allowedVariables)
    : draftContext.allowedVariables;

  assertValidPromptDraft(content, allowedVariables);

  const id = await generateCustomPromptId(name, draftContext.featureKey);
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

  await writePromptJson(id, prompt);

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
    allowedVariables: cloneAllowedVariables(feature.allowedVariables),
  };
}

export async function updatePrompt(id: string, input: PromptUpdateInput): Promise<PromptRecord | null> {
  await ensurePromptStorage();

  const content = normalizePromptContent(input.content);
  if (!content) {
    throw new Error('Prompt content is required');
  }

  if (getPromptFeatureDefinitionById(id)) {
    const feature = getPromptFeatureDefinitionById(id);
    if (!feature) return null;
    const modelSelection = normalizePromptModelSelection(input.modelProvider, input.modelName);
    const allowedVariables = resolveFeatureAllowedVariables(content, feature.allowedVariables);

    assertValidPromptDraft(content, allowedVariables);
    const existing = await readPromptJson(id);
    await writePromptJson(id, {
      id,
      featureKey: feature.key,
      content,
      modelProvider: modelSelection?.provider,
      modelName: modelSelection?.modelName,
      createdAt: typeof existing?.parsed.createdAt === 'string'
        ? existing.parsed.createdAt
        : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return getPromptById(id);
  }

  const current = await readCustomPromptFile(id);
  if (!current) return null;

  const name = normalizePromptName(input.name ?? current.name);
  const description = normalizePromptDescription(input.description ?? current.description);
  const draftContext = resolveUpdateDraftContext(input, current);
  const modelSelection = normalizePromptModelSelection(
    input.modelProvider ?? current.modelProvider,
    input.modelName ?? current.modelName
  );

  if (!name) {
    throw new Error('Prompt name is required');
  }

  const allowedVariables = draftContext.featureKey
    ? resolveFeatureAllowedVariables(content, draftContext.allowedVariables)
    : draftContext.allowedVariables;

  assertValidPromptDraft(content, allowedVariables);

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

  await writePromptJson(id, nextPrompt);

  return getPromptById(id);
}

export async function activatePrompt(id: string): Promise<PromptActivationResult> {
  await ensurePromptStorage();

  const prompt = await getPromptRecordByIdExact(id);
  if (!prompt) {
    throw new Error('Prompt not found');
  }
  if (!prompt.featureKey) {
    throw new Error('Only feature-linked prompts can be activated');
  }
  if (isProfileScopedPromptFeature(prompt.featureKey)) {
    throw new Error('Resume and cover letter prompts are selected per profile');
  }

  const config = await readPromptLibraryConfig();
  config.activePrompts[prompt.featureKey] = prompt.id;
  await writePromptLibraryConfig(config);

  return {
    featureKey: prompt.featureKey,
    promptId: prompt.id,
  };
}

export async function deletePrompt(id: string): Promise<boolean> {
  await ensurePromptStorage();

  if (getPromptFeatureDefinitionById(id)) {
    throw new Error('Cannot delete built-in prompts');
  }

  const prompt = await getPromptById(id);
  if (!prompt) return false;

  await fs.unlink(getPromptPath(id)).catch(() => undefined);

  if (prompt.featureKey) {
    const config = await readPromptLibraryConfig();
    if (config.activePrompts[prompt.featureKey] === id) {
      delete config.activePrompts[prompt.featureKey];
      await writePromptLibraryConfig(config);
    }
  }

  return true;
}

function resolveDraftSource(
  record: PromptRecord | null,
  input: PromptPreviewInput
): { content: string; allowedVariables: PromptVariableDefinition[] } {
  if (record) {
    const content = input.content ? normalizePromptContent(input.content) : record.content;
    return {
      content,
      allowedVariables: record.featureKey
        ? resolveFeatureAllowedVariables(content, getPromptFeatureDefinition(record.featureKey).allowedVariables)
        : record.isBuiltIn
          ? record.allowedVariables
          : normalizeAllowedVariables(input.allowedVariables ?? record.allowedVariables),
    };
  }

  const content = normalizePromptContent(input.content ?? '');
  const allowedVariables = normalizeAllowedVariables(input.allowedVariables);

  if (!content) {
    throw new Error('Prompt content is required');
  }

  return {
    content,
    allowedVariables,
  };
}

export async function previewPrompt(input: PromptPreviewInput): Promise<PromptPreviewResult> {
  await ensurePromptStorage();

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
  await ensurePromptStorage();

  const stored = input.id ? await getPromptById(input.id) : null;
  if (input.id && !stored) {
    throw new Error('Prompt not found');
  }

  const { content, allowedVariables } = resolveDraftSource(stored, input);
  return validatePromptContent(content, allowedVariables);
}

async function resolvePromptForRuntime(id: string): Promise<PromptRecord | null> {
  if (isPromptFeatureKey(id)) {
    return getRuntimePromptByFeature(id);
  }
  return getPromptById(id);
}

export async function resolvePromptByRuntimeId(id: string): Promise<PromptRecord | null> {
  return resolvePromptForRuntime(id);
}

export async function resolvePromptByExactId(id: string): Promise<PromptRecord | null> {
  return getPromptRecordByIdExact(id);
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

export async function renderPromptByExactId(
  id: string,
  values: Record<string, string>
): Promise<string> {
  const prompt = await getPromptRecordByIdExact(id);
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
  const prompt = await getPromptRecordByIdExact(id);
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
