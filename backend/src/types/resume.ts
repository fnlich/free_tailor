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

/*
 * The section kinds a resume commonly carries beyond the classic six, each a
 * list of entries on the resume (config/sectionCatalogue.ts is the catalogue).
 * A kind prints only when it has an entry; there is no on/off switch for them
 * as there is for Soft Skills and Strengths. Links are stored as typed, like
 * `contact.github`; the renderer keeps only http(s) ones.
 */
export interface Project {
  name: string;
  role: string;
  startDate: string;
  endDate: string;
  link: string;
  description: string;
  achievements: string[];
}

export interface Language {
  language: string;
  proficiency: string;
}

export interface Award {
  title: string;
  issuer: string;
  date: string;
  description: string;
}

export interface Publication {
  title: string;
  publisher: string;
  date: string;
  link: string;
  description: string;
}

export interface Volunteering {
  role: string;
  organization: string;
  startDate: string;
  endDate: string;
  location: string;
  description: string;
  achievements: string[];
}

export interface Course {
  name: string;
  institution: string;
  date: string;
}

export interface Reference {
  name: string;
  title: string;
  company: string;
  email: string;
  phone: string;
}

export interface CustomSectionEntry {
  heading: string;
  subheading: string;
  startDate: string;
  endDate: string;
  location: string;
  description: string;
  achievements: string[];
}

/**
 * A section the person titles themselves. `key` is client-generated,
 * `[a-z0-9-]{1,40}`, unique in the resume, and `sectionOrder` refers to the
 * section as `custom:<key>`.
 */
export interface CustomSection {
  key: string;
  title: string;
  entries: CustomSectionEntry[];
}

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
 * A rendering choice and not a storage one: a resume keeps its categories
 * either way, so switching to flat and back does not lose the grouping somebody
 * typed in.
 */
export type TechnicalSkillsLayout = 'categorized' | 'flat';

/**
 * How a tailoring treats the candidate's own experience (owner's request,
 * 2026-10-20). It is the RUN's builder mode (config/buildModes.ts `BuildMode`
 * less `suitable`, which tailors nothing), passed to the tailoring; no resume
 * carries one:
 *
 * - `partial`: each role's description and achievements and the summary are
 *   sent, and rewritten for the posting (the `tailor-resume` prompt); a role
 *   left empty is written from the posting.
 * - `full`: only each role's title, company and dates are sent, and the whole
 *   experience and the summary are written for the posting
 *   (`tailor-resume-full`).
 *
 * Either way the skills block leads with the posting's own hard skills.
 */
export type TailorMode = 'partial' | 'full';

export interface ResumeSettings {
  resumePromptId?: string;
  resumeFileNameTemplate?: string;
  coverLetterFileNameTemplate?: string;
  /** Categorized or flat Technical Skills. Absent means categorized. */
  technicalSkillsLayout?: TechnicalSkillsLayout;
  /**
   * Whether the resume carries a Soft Skills section.
   *
   * Absent means false, and false is what every resume rendered before this
   * switch existed: the section was stripped from every template. So a resume
   * nobody has touched since comes out exactly as it did, and only somebody who
   * ticks the box sees the section appear. A rendering choice like the layout -
   * the resume keeps its soft skills either way.
   */
  includeSoftSkills?: boolean;
  /** Whether the resume carries a Strengths section. Absent means false, for the same reason. */
  includeStrengths?: boolean;
  /**
   * This resume's default model.
   *
   * Every field is optional and an absent one inherits the app default, so a
   * resume that has never been touched behaves exactly as it did before this
   * existed. A single generation can override any of them for that run.
   */
  ai?: AiPreferences;
}

export interface Resume {
  id: string;
  /**
   * The account this resume belongs to.
   *
   * Optional in the type: a row without one can still be read, and the
   * repository treats an absent owner as admin-only, so such a row is never
   * shown to the wrong person. Every resume created is given its owner.
   */
  ownerId?: string;
  /**
   * The profile (the person) this resume is filed under: exactly one, of the
   * same account. Owned by the SERVER, like `ownerId`: set by
   * database/resumeRepository.ts from the stored row (a new resume: from its
   * placement) and mirrored to the column `resumes.profile_id`; never read from
   * a request body, and moved only by POST /api/profiles/:id/move. Absent only
   * on a row that has not been filed yet (lazy filing,
   * database/profileTree.ts `fileUnfiledResumes`).
   */
  profileId?: string;
  name: string;
  title: string;
  totalYearsExperience?: number;
  preferredTemplate?: string;
  disabled?: boolean;
  resumeSettings?: ResumeSettings;
  contact: Contact;
  summary: string;
  experience: Experience[];
  strengths: Strength[];
  /**
   * Every skill this resume claims, flat.
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
   * and their Vault is their infrastructure, so a resume that wants to say so
   * needs somewhere to say it. When this is present it is used verbatim and
   * nothing is inferred.
   */
  skillCategories?: SkillCategoryGroup[];
  /**
   * The soft skills this person claims, in their own order.
   *
   * Optional because every resume written before the Soft Skills switch has
   * none; absent and empty read the same. Rendered only when
   * `resumeSettings.includeSoftSkills` is on, and kept either way - turning the
   * section off must not throw away the list somebody typed.
   */
  softSkills?: string[];
  education: Education[];
  certifications?: Certification[];
  /*
   * The other section kinds (config/sectionCatalogue.ts). Optional because every
   * resume written before them has none; absent and empty read the same, and a
   * kind prints only when it has an entry.
   */
  projects?: Project[];
  languages?: Language[];
  awards?: Award[];
  publications?: Publication[];
  volunteering?: Volunteering[];
  courses?: Course[];
  interests?: string[];
  references?: Reference[];
  customSections?: CustomSection[];
  /**
   * The order the resume's sections print in - every kind, classic and new,
   * by config/sectionCatalogue.ts id, or `custom:<key>`. ABSENT means the
   * template's own order (every resume saved before this existed), and the
   * normaliser never fills it in: a resume moves only once its person arranges
   * the cards. A kind listed here with nothing in it is an added, empty
   * section: kept, shown as an empty card, and printed as nothing. A template
   * still decides which column a section lives in; the order applies within
   * that column.
   */
  sectionOrder?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateResumeDTO {
  name?: string;
  title?: string;
  totalYearsExperience?: number;
  preferredTemplate?: string;
  disabled?: boolean;
  resumeSettings?: ResumeSettings;
  contact?: Partial<Contact>;
  summary?: string;
  experience?: Partial<Experience>[];
  strengths?: Partial<Strength>[];
  /**
   * Accepted in every shape a real file writes them in. See
   * `normalizeSkillsInput` - a flat list, a category map, a list of groups, or
   * a mix of names and groups all normalize to the same stored resume.
   */
  skills?: unknown;
  skillCategories?: unknown;
  /** A list of names; anything else in it is dropped. Omitted keeps what is stored. */
  softSkills?: unknown;
  education?: Partial<Education>[];
  certifications?: Certification[];
  /*
   * Each a list of entries; anything in it that is not an object is dropped,
   * and an entry with nothing typed into it is dropped too. Omitted (or not a
   * list at all) keeps what is stored; an empty list clears it.
   */
  projects?: unknown;
  languages?: unknown;
  awards?: unknown;
  publications?: unknown;
  volunteering?: unknown;
  courses?: unknown;
  /** A list of names, like softSkills. */
  interests?: unknown;
  references?: unknown;
  customSections?: unknown;
  /**
   * The section order: kind ids and `custom:<key>` refs. Omitted keeps the
   * stored order; `[]` clears it, back to the template's own order; anything
   * in a list that is not a known ref is dropped.
   */
  sectionOrder?: unknown;
}
