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
   * Present ONLY on an analysis stored while the analysis prompt asked for
   * one (v6, before the facts call). Every other analysis - older, and every
   * one made since, which never carries the key - has its industry derived
   * when it is read (services/jobAnalysis/facts.ts `industryOf`: the facts
   * call's company category, else `jobMeta.industry`), never asked of a model
   * and never filled in with a default.
   */
  industry?: string;
  /** What the posting STATES it pays; null when it states nothing. Never inferred. */
  salary: JobSalary | null;
  /**
   * The facts the Job Filter judges a posting on, read by the same one
   * analysis (owner decision J8: the filter makes no AI read of its own) -
   * since O1, by its second call, the Job Facts (Filter) prompt. Each value
   * is one of the words that prompt offers, or `not_specified`.
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
  /**
   * The facts call's seniority (services/jobAnalysis/facts.ts
   * `SENIORITY_VALUES`, else `not_specified`). Absent on an analysis stored
   * before the facts call - whose `jobMeta.seniority` was asked in the same
   * words, so the filter reads that instead. Never defaulted: its absence is
   * how an older analysis is told apart.
   */
  seniority?: string;
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

/**
 * One heading of the model's Technical Skills block and the skills under it,
 * in the order written. `soft` marks the soft-skill group (the last one,
 * headed `[[softSkillGroupHeading]]`) once it has been found, so a heading
 * edited afterwards does not lose it. Read through services/skillGroups.ts.
 */
export interface SkillGroup {
  category: string;
  skills: string[];
  soft?: true;
}

export interface TailoredContent {
  /**
   * The headline the resume prints, exactly as composed - the render passes
   * it through `sanitizeTitleForATS` only, which keeps `| ( ) / , . & + # · -`.
   */
  title: string;
  summary: string;
  /**
   * The roles as tailored. The render prints no `description` for any of them
   * (the tailoring prompt says it is discarded) and at most eight bullets.
   */
  experience: TailoredExperience[];
  skills: string[];
  /**
   * The model's Technical Skills block, shape-sanitised and nothing more.
   * When it has any group it IS the printed block: Grouped prints it as it
   * stands, Plain as one list in the same order with repeats removed, and the
   * soft-skill group goes to the template's Soft Skills section only while
   * that switch is on (as the template leaves it). Absent on content written
   * before the model wrote the block.
   */
  skillGroups?: SkillGroup[];
  /** The heading drawn for this resume's soft-skill group (`[[softSkillGroupHeading]]`). */
  softSkillGroupHeading?: string;
  /**
   * The technical skills as one list. With `skillGroups` present it is
   * derived from them and the render prints the groups instead; content
   * without them - held from an older build - prints this list, unpadded.
   */
  hardSkills: string[];
  /**
   * With `skillGroups` present the render takes the soft-skill group from
   * them. Without, it prints this list while the switch is on, or the
   * profile's own when this is empty.
   */
  softSkills: string[];
  /** The posting's soft skills the library does not know yet; empty when the section is off. */
  unconfirmedSoftSkills: string[];
  unconfirmedHardSkills: string[];
  /**
   * Never printed: with the Strengths switch on the render prints the
   * profile's OWN strengths, whatever a model or an older build put here.
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

/** POST /api/resume/preview's body (the model is read by `readAiOverrides`, the posting by `analysisForRequest`). */
export interface PreviewResumeRequest {
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
}
