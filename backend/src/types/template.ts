/** Stored config for manual templates; enables edit. Matches ManualTemplateConfig shape. */
export interface ManualTemplateConfigStored {
  name: string;
  description?: string;
  columns: 1 | 2;
  accentColor?: string;
  bodyColor?: string;
  bodyFontSizePt?: number;
  titleFontSizePt?: number;
  sectionOrder?: string[];
  leftSectionOrder?: string[];
  rightSectionOrder?: string[];
  nameStyle?: Record<string, unknown>;
  headerTitleStyle?: Record<string, unknown>;
  contactStyle?: Record<string, unknown>;
  sectionStyles?: Record<string, Record<string, Record<string, unknown>>>;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  disabled?: boolean;
  htmlContent: string;
  cssContent: string;
  sections: string[];
  createdAt: string;
  updatedAt: string;
  /** Stored config for manual templates; enables edit */
  manualConfig?: ManualTemplateConfigStored;
  /** True for templates shipped as static files; their HTML cannot be edited or deleted */
  isBuiltIn?: boolean;
}

export interface JobAnalysis {
  jobMeta: {
    title: string;
    seniority: string;
    industry: string;
    department: string;
  };
  skills: {
    technical: string[];
    required: string[];
    preferred: string[];
    tools: string[];
    soft: string[];
    technologies: string[];
  };
  technologies: string[];
  protocols: string[];
  methodologies: string[];
  architecturePatterns: string[];
  responsibilities: string[];
  domainKnowledge: string[];
  softSkills: string[];
  keywords: {
    actionVerbs: string[];
    buzzwords: string[];
    mustInclude: string[];
  };
  sourceJobDescription?: string;
}

/**
 * The AI providers this app can run a completion on: subscription seats only,
 * each a CLI the operator signed in on this machine.
 *
 * `claude-cli` drives the locally installed `claude` binary against the
 * operator's Claude subscription; `codex-cli` drives `codex` against a ChatGPT
 * subscription; `gemini-cli` drives `gemini` against a signed-in Google
 * account. None holds an API key, and each strips or blanks any key in its
 * child's environment, because a key outranks the subscription in every one of
 * these CLIs and would move every call onto metered billing while looking
 * identical.
 *
 * The former `openrouter` id was replaced by `claude-cli`; stored records that
 * still carry it are coerced by `coerceProviderId` in config/providerCatalog.
 * Two families were retired outright, with no replacement: the browser chat
 * providers (`claude-web`, `chatgpt-web`) and the metered APIs (`claude`, the
 * Anthropic API, plus `openai` and `deepseek`). Stored records naming them are
 * dropped or ignored on read - see `RETIRED_PROVIDER_IDS` there.
 */
export type AIProvider = 'claude-cli' | 'codex-cli' | 'gemini-cli';

export type RawNestedJobAnalysis = Partial<JobAnalysis> & {
  jobMeta?: {
    title?: unknown;
    seniority?: unknown;
    industry?: unknown;
    department?: unknown;
  };
  skills?: {
    technical?: unknown;
    required?: unknown;
    preferred?: unknown;
    tools?: unknown;
    soft?: unknown;
    technologies?: unknown;
  };
  technologies?: unknown;
  protocols?: unknown;
  methodologies?: unknown;
  architecturePatterns?: unknown;
  responsibilities?: unknown;
  domainKnowledge?: unknown;
  softSkills?: unknown;
  keywords?: {
    actionVerbs?: unknown,
    buzzwords?: unknown,
    mustInclude?: unknown
  }
};

export interface TailoredContent {
  title: string;
  summary: string;
  experience: TailoredExperience[];
  skills: string[];
  hardSkills: string[];
  softSkills: string[];
  unconfirmedSoftSkills: string[];
  unconfirmedHardSkills: string[];
  strengths: TailoredStrength[];
  /** Cover letter body content without the greeting or sign-off */
  coverLetter?: string;
}

export interface TailoredExperience {
  title: string;
  company: string;
  startDate: string;
  endDate: string;
  location: string;
  description: string;
  achievements: string[];
}

export interface TailoredStrength {
  title: string;
  description: string;
}

export type ResumeFormat = 'pdf' | 'docx' | 'both';

export interface GenerateResumeRequest {
  profileId: string;
  templateId: string;
  jobDescription?: string;
  jobAnalysis?: JobAnalysis;
  tailoredContent?: TailoredContent;
  /** An AI model record id; overrides the profile's own for this run. */
  model?: string;
  companyName: string;
  role: string;
  sourceRowNumber?: number;
  format?: ResumeFormat;
  includeCoverLetterDocx?: boolean;
}
