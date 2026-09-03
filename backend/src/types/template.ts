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
}

export interface CreateTemplateDTO {
  name: string;
  description?: string;
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

export type AIProvider = 'openai' | 'claude' | 'openrouter' | 'deepseek';

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
  // Optional fields from job analysis merged into tailored content
  requiredSkills?: string[];
  preferredSkills?: string[];
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
  model?: string;
  companyName: string;
  role: string;
  sourceRowNumber?: number;
  format?: ResumeFormat;
  includeCoverLetterDocx?: boolean;
}
