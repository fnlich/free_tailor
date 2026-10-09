import type { TechnicalSkillsLayout } from './profile';

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

/**
 * How a saved template came to be: imported from a JSON file, extracted from a
 * PDF, or built in the manual editor.
 *
 * Written into the template's own file in `static/templates`, and it is what
 * tells a saved template from a built-in there: a file WITH a source is one
 * an administrator saved (editable, deletable), a file without one shipped
 * with the code (read-only; its edits go to `template_overrides`).
 */
export type TemplateSource = 'uploaded' | 'extracted' | 'manual';

export interface Template {
  id: string;
  name: string;
  description: string;
  disabled?: boolean;
  /** Present on a saved template, absent on a built-in. See `TemplateSource`. */
  source?: TemplateSource;
  htmlContent: string;
  cssContent: string;
  sections: string[];
  /**
   * The Technical Skills layouts this template renders well - a non-empty
   * subset of `['categorized', 'flat']`, in that order.
   *
   * A list rather than one value because most templates render both once the
   * compile step is layout-aware; the two whose skills block is a grid of
   * category cells say `['categorized']`. A profile is offered only templates
   * that list its layout, and generation falls back (see
   * `services/templateChoice`) rather than failing when they disagree.
   *
   * Built-ins declare it in their static JSON; anything stored without it gets
   * it from `inferTemplateSkillsLayouts` when it is read, so no row needs
   * migrating.
   */
  skillsLayouts: TechnicalSkillsLayout[];
  /**
   * Read-only, worked out from the markup on every read and never stored:
   * whether the template has anywhere to put the Soft Skills and Strengths
   * sections a profile can switch on. The editor uses them to say "this
   * template has no Strengths section" instead of leaving a ticked box that
   * changes nothing.
   */
  supportsSoftSkills?: boolean;
  supportsStrengths?: boolean;
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
  /**
   * The posting's one job field: a config/jobFields.ts id, or `unclassified`
   * when none fits (owner decision J3). Checked against the list in code, so
   * this is never a value the model made up.
   */
  jobField: string;
  /**
   * The posting's industry: a config/industries.ts id, or `not_specified`.
   * Present ONLY on an analysis made since the prompt asked for it - an older
   * one has no key at all, and its industry is derived when it is read
   * (services/jobAnalysis/facts.ts `industryOf`), never asked of a model again.
   * So it is set only when the model's answer had the key, and never filled
   * in with a default that would hide the older analysis's own evidence.
   */
  industry?: string;
  /** What the posting STATES it pays; null when it states nothing. Never inferred. */
  salary: JobSalary | null;
  /**
   * The facts the Job Filter judges a posting on, read by the same one
   * analysis (owner decision J8: the filter makes no AI read of its own).
   * Seniority is `jobMeta.seniority`. Each value is one of the words the
   * analysis prompt offers, or `not_specified`.
   */
  filter: JobFilterFacts;
  sourceJobDescription?: string;
}

export type JobSalaryPeriod = 'annual' | 'monthly' | 'weekly' | 'daily' | 'hourly';

export interface JobSalary {
  /** As stated, in `currency` per `period`; null when the posting gives no such bound. */
  min: number | null;
  max: number | null;
  /** ISO 4217, upper case (`USD`), or null when the posting names none. */
  currency: string | null;
  period: JobSalaryPeriod | null;
  /** The posting's own words for it, cut to 200 characters. */
  raw: string | null;
}

export interface JobFilterFacts {
  jobType: string;
  onsiteInterview: string;
  companyCategory: string;
  clearanceRequired: string;
  region: string;
  usState: string;
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
 * Every one a subscription seat; config/providerCatalog.ts is the one list.
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
  };
  jobField?: unknown;
  industry?: unknown;
  salary?: unknown;
  filter?: unknown;
};

export interface TailoredContent {
  title: string;
  summary: string;
  experience: TailoredExperience[];
  skills: string[];
  /**
   * Decided by code, never by the model. Grouped profiles get the posting's
   * library skills with the library's headings filled out; plain ones get the
   * posting's library skills and their own related skills, unpadded.
   */
  hardSkills: string[];
  /**
   * Empty when the profile's Soft Skills section is off. On, the profile's own
   * list first, then what the posting asks for that the library confirms.
   */
  softSkills: string[];
  /** The posting's soft skills the library does not know yet; empty when the section is off. */
  unconfirmedSoftSkills: string[];
  unconfirmedHardSkills: string[];
  /**
   * Empty when the profile's Strengths section is off, whatever the model
   * returned. On, the model's, else the profile's own - never made up.
   */
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
  /** The posting's link, which identifies it for the one-analysis rule beside its text. */
  jobLink?: string;
  /**
   * A stored analysis the page already holds (`/resume/analyze` answered
   * it). The server reads it from the store by id; an analysis OBJECT a
   * client sends is never read.
   */
  analysisId?: string;
  tailoredContent?: TailoredContent;
  /** An AI model record id; overrides the profile's own for this run. */
  model?: string;
  companyName: string;
  role: string;
  sourceRowNumber?: number;
  format?: ResumeFormat;
  includeCoverLetterDocx?: boolean;
}
