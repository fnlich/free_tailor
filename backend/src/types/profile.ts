import type { AiPreferences } from '../config/aiPreferences';

export interface Contact {
  phone: string;
  email: string;
  linkedin?: string;
  github?: string;
  portfolio?: string;
  location: string;
}

export interface Experience {
  title: string;
  company: string;
  startDate: string;
  endDate: string;
  location: string;
  description: string;
  achievements: string[];
  skills: string[];
}

export interface Strength {
  title: string;
  description: string;
}

export interface Education {
  degree: string;
  institution: string;
  startDate: string;
  endDate: string;
  location: string;
  gpa?: string;
  achievements?: string[];
}

export interface Certification {
  name: string;
  issuer: string;
  date: string;
  expiryDate?: string;
  credentialId?: string;
}

/**
 * How hard skills are ordered on the rendered resume:
 * - `library`: by the priority stored in the skill library (default)
 * - `job-priority`: by relevance to the analyzed job description
 */
export type HardSkillOrdering = 'library' | 'job-priority';

/**
 * One heading in the Technical Skills block, and the skills under it.
 *
 * `category` may be empty, and that is not a missing value - it is the flat
 * layout, where the skills are listed with no heading over them. Keeping it as
 * one shape rather than two means every renderer has one loop to write instead
 * of a branch, and a template an operator uploaded next year gets the flat
 * layout right without knowing the option exists.
 */
export interface SkillCategoryGroup {
  category: string;
  skills: string[];
}

/**
 * How the Technical Skills block is laid out.
 *
 * - `categorized`: a heading per group, as the built-in templates render today
 * - `flat`: one list of skill names, no headings
 *
 * A rendering choice and not a storage one: a profile keeps its categories
 * either way, so switching to flat and back does not lose the grouping somebody
 * typed in.
 */
export type TechnicalSkillsLayout = 'categorized' | 'flat';

export interface ProfileSettings {
  resumePromptId?: string;
  analyzeJobPromptId?: string;
  coverLetterPromptId?: string;
  resumeFileNameTemplate?: string;
  coverLetterFileNameTemplate?: string;
  companyFolderNameTemplate?: string;
  hardSkillOrdering?: HardSkillOrdering;
  /** Categorized or flat Technical Skills. Absent means categorized. */
  technicalSkillsLayout?: TechnicalSkillsLayout;
  /**
   * This profile's default model, effort and thinking mode.
   *
   * Every field is optional and an absent one inherits the app default, so a
   * profile that has never been touched behaves exactly as it did before this
   * existed. A single generation can override any of them for that run.
   */
  ai?: AiPreferences;
}

export interface Profile {
  id: string;
  name: string;
  title: string;
  totalYearsExperience?: number;
  preferredTemplate?: string;
  disabled?: boolean;
  profileSettings?: ProfileSettings;
  contact: Contact;
  summary: string;
  experience: Experience[];
  strengths: Strength[];
  /**
   * Every skill this profile claims, flat.
   *
   * Stays the canonical list even when `skillCategories` is set: it is what the
   * tailoring prompt is given, what the job-match scoring reads, and what every
   * template that predates categories renders. `skillCategories` groups these
   * same names - it never holds one that is not here.
   */
  skills: string[];
  /**
   * The author's own grouping of `skills`, when they have one.
   *
   * Absent means "work it out", and the renderer then infers a category per
   * skill from the shared skill library. That inference is a good default and a
   * bad master: it has no idea that a particular person's C# is their language
   * and their Vault is their infrastructure, so a profile that wants to say so
   * needs somewhere to say it. When this is present it is used verbatim and
   * nothing is inferred.
   */
  skillCategories?: SkillCategoryGroup[];
  education: Education[];
  certifications?: Certification[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateProfileDTO {
  name?: string;
  title?: string;
  totalYearsExperience?: number;
  preferredTemplate?: string;
  disabled?: boolean;
  profileSettings?: ProfileSettings;
  contact?: Partial<Contact>;
  summary?: string;
  experience?: Partial<Experience>[];
  strengths?: Partial<Strength>[];
  /**
   * Accepted in every shape a real file writes them in. See
   * `normalizeSkillsInput` - a flat list, a category map, a list of groups, or
   * a mix of names and groups all normalize to the same stored profile.
   */
  skills?: unknown;
  skillCategories?: unknown;
  education?: Partial<Education>[];
  certifications?: Certification[];
}
