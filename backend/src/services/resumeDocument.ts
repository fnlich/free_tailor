import { normalizeAiPreferences } from '../config/aiPreferences';
import {
  cleanSectionOrder,
  isCustomSectionKey,
  MAX_INTEREST_LENGTH,
  MAX_RESUME_CUSTOM_SECTIONS,
  MAX_RESUME_INTERESTS,
  MAX_RESUME_SECTION_ENTRIES,
  presenceOf,
} from '../config/sectionCatalogue';
import {
  Award,
  Certification,
  Contact,
  Course,
  CreateResumeDTO,
  CustomSection,
  CustomSectionEntry,
  Education,
  Experience,
  Language,
  Resume,
  ResumeSettings,
  Project,
  Publication,
  Reference,
  SkillCategoryGroup,
  Strength,
  TechnicalSkillsLayout,
  Volunteering,
} from '../types/resume';
import {
  DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE,
  DEFAULT_RESUME_FILE_NAME_TEMPLATE,
  validateOutputFileNameTemplate,
} from '../utils/outputStorage';
import type { Template } from '../types/template';
import { inferTemplateCapabilities } from './templateImport';

export const DEFAULT_RESUME_PROMPT_ID = 'tailor-resume';
/** The one prompt a Fully Tailor run uses (promptService's single-prompt features). */
export const FULL_TAILOR_PROMPT_ID = 'tailor-resume-full';
export const DEFAULT_COVER_LETTER_PROMPT_ID = 'generate-cover-letter';
/** Categories on, because that is how every built-in template renders today. */
export const DEFAULT_TECHNICAL_SKILLS_LAYOUT: TechnicalSkillsLayout = 'categorized';

function toSafeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function toOptionalPositiveNumber(value: unknown, fallback?: number): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}

function normalizeStringList(value: unknown, fallback: string[] = []): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : fallback;
}

/**
 * The skills of an uploaded or submitted resume, in whatever shape they came.
 *
 * Four shapes, because all four are things people actually have in a file and
 * refusing three of them would mean editing the file by hand before an import
 * that is supposed to save exactly that work:
 *
 *   ["C#", "Python"]
 *   { "Languages": ["C#"], "Cloud and Infrastructure": ["Vault"] }
 *   [{ "category": "Languages", "skills": ["C#"] }]
 *   ["C#", { "category": "Cloud", "skills": ["Vault"] }]
 *
 * The last one is not a curiosity: it is what a half-edited file looks like,
 * and what the admin form produces while somebody is in the middle of grouping
 * a list they pasted.
 *
 * Both outputs always come back. `skills` is the flat union in first-seen
 * order, because it is what the tailoring prompt is given and what every
 * template that predates categories renders; `categories` is the grouping, and
 * it is empty when the input carried none rather than being invented from the
 * library here - inference belongs to the renderer, which has the job analysis
 * to inform it.
 */
export function normalizeSkillsInput(value: unknown): {
  skills: string[];
  categories: SkillCategoryGroup[];
} {
  const skills: string[] = [];
  const seen = new Set<string>();
  const categories: SkillCategoryGroup[] = [];
  const byCategory = new Map<string, SkillCategoryGroup>();

  const addSkill = (raw: unknown): string => {
    const skill = toSafeString(raw);
    if (!skill) return '';
    const key = skill.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      skills.push(skill);
    }
    return skill;
  };

  const addGroup = (rawCategory: unknown, rawSkills: unknown) => {
    const category = toSafeString(rawCategory);
    const members = Array.isArray(rawSkills) ? rawSkills : [rawSkills];
    // The skill is registered whether or not the group survives, so a group
    // with an empty heading still contributes to the flat list. Anything else
    // would silently drop skills the moment someone left a heading blank.
    const named = members.map(addSkill).filter(Boolean);
    if (!category || named.length === 0) return;

    // A category repeated later in the file extends the first one rather than
    // replacing it - which is what a file assembled from two sources looks
    // like, and losing the earlier half of it would be silent.
    const existing = byCategory.get(category.toLowerCase());
    if (existing) {
      for (const skill of named) {
        if (!existing.skills.some((held) => held.toLowerCase() === skill.toLowerCase())) {
          existing.skills.push(skill);
        }
      }
      return;
    }
    const group: SkillCategoryGroup = { category, skills: named };
    byCategory.set(category.toLowerCase(), group);
    categories.push(group);
  };

  const readEntry = (entry: unknown) => {
    if (typeof entry === 'string') {
      addSkill(entry);
      return;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const record = entry as Record<string, unknown>;
    // `name`/`items` and `title`/`values` are the same idea under the names
    // other resume tools export them under.
    const category = record.category ?? record.name ?? record.title ?? record.label;
    const members = record.skills ?? record.items ?? record.values ?? record.list;
    addGroup(category, members);
  };

  if (Array.isArray(value)) {
    value.forEach(readEntry);
  } else if (value && typeof value === 'object') {
    for (const [category, members] of Object.entries(value as Record<string, unknown>)) {
      addGroup(category, members);
    }
  }

  return { skills, categories };
}

export function isTechnicalSkillsLayout(value: unknown): value is TechnicalSkillsLayout {
  return value === 'categorized' || value === 'flat';
}

/** The layout configured for a resume, falling back to the default. */
export function getResumeTechnicalSkillsLayout(
  resume?: Pick<Resume, 'resumeSettings'> | null
): TechnicalSkillsLayout {
  const value = resume?.resumeSettings?.technicalSkillsLayout;
  return isTechnicalSkillsLayout(value) ? value : DEFAULT_TECHNICAL_SKILLS_LAYOUT;
}

/**
 * Whether the resumes drawn from this resume carry a Soft Skills section.
 *
 * Only a stored `true` turns it on. Absent, and anything that is not a
 * boolean, is off - which is what every resume rendered before the switch
 * existed, so an untouched resume's output does not move.
 */
export function getResumeIncludeSoftSkills(resume?: Pick<Resume, 'resumeSettings'> | null): boolean {
  return resume?.resumeSettings?.includeSoftSkills === true;
}

/** Whether the resumes drawn from this resume carry a Strengths section. Off unless stored `true`. */
export function getResumeIncludeStrengths(resume?: Pick<Resume, 'resumeSettings'> | null): boolean {
  return resume?.resumeSettings?.includeStrengths === true;
}

/**
 * The three rendering choices a saved resume makes about the sections of the
 * resume it prints.
 *
 * Read together because the renderer needs all three at once - the data step
 * to decide what the sections hold, the compile step to decide which markup
 * survives - and two readers of one resume must never disagree about them.
 */
export interface ResumeSectionChoices {
  layout: TechnicalSkillsLayout;
  softSkills: boolean;
  strengths: boolean;
  /**
   * The stored section order, or null for the template's own; and the custom
   * sections' keys, which the extra-sections macro expands a block for each
   * of. Optional, and filled by the renderer from `getResumeSectionLayout`,
   * so every caller of the three switches above compiles as it did.
   */
  sectionOrder?: string[] | null;
  customKeys?: string[];
}

export function getResumeSections(
  resume?: Pick<Resume, 'resumeSettings'> | null
): ResumeSectionChoices {
  return {
    layout: getResumeTechnicalSkillsLayout(resume),
    softSkills: getResumeIncludeSoftSkills(resume),
    strengths: getResumeIncludeStrengths(resume),
  };
}

/**
 * How a resume's sections are laid out: the stored order, or null for the
 * template's own (config/sectionCatalogue.ts has the semantics), and the custom
 * sections' keys. A stored list that cleans to nothing - a hand-written `[]`,
 * refs to sections that are gone - reads as absent too.
 */
export function getResumeSectionLayout(
  resume: Pick<Resume, 'sectionOrder' | 'customSections'>
): { sectionOrder: string[] | null; customKeys: string[] } {
  const { customKeys } = presenceOf(resume);
  const stored = cleanSectionOrder(resume.sectionOrder, customKeys);
  return { sectionOrder: stored.length > 0 ? stored : null, customKeys };
}

/**
 * The saved resume as a resume drawn with `template` reads it: a section
 * switch the template has no markup for counts as off.
 *
 * ONE rule for every output of one generation. Without it the switch meant
 * three different things on a template with no Strengths or Soft Skills
 * section (burgundy-rule, navy-rule, charcoal-sidebar; ink-ledger has no Soft
 * Skills): the PDF printed nothing, the DOCX - which ignores the template -
 * printed the section anyway, and tailoring took the section as present, so
 * the posting's soft-skill keywords left the summary for a list that never
 * printed and the prompt steered overflow keywords into Strengths. Read
 * through here, the switch on such a template behaves exactly as off - which
 * is what the editor tells the person ("ticking it changes nothing here").
 *
 * The capabilities are read off the markup every time rather than taken from
 * the object, which may be one a caller built (a test, the manual builder) or
 * one saved before its markup changed. The same object comes back when
 * nothing changes, so a caller can pass any resume through freely.
 */
export function resumeForTemplate<P extends Pick<Resume, 'resumeSettings'>>(
  resume: P,
  template?: Pick<Template, 'htmlContent'> | null
): P {
  if (!template) return resume;
  const settings = resume.resumeSettings;
  const { supportsSoftSkills, supportsStrengths } = inferTemplateCapabilities(template.htmlContent);
  const dropSoftSkills = settings?.includeSoftSkills === true && !supportsSoftSkills;
  const dropStrengths = settings?.includeStrengths === true && !supportsStrengths;
  if (!dropSoftSkills && !dropStrengths) return resume;
  return {
    ...resume,
    resumeSettings: {
      ...settings,
      ...(dropSoftSkills ? { includeSoftSkills: false } : {}),
      ...(dropStrengths ? { includeStrengths: false } : {}),
    },
  };
}

/**
 * A resume's own soft skills hold at most this many, of at most this many
 * characters each.
 *
 * Generous for a list a person types - a resume shows a handful - and there
 * to stop a pasted paragraph or a runaway import becoming a section that
 * fills the page. An entry over the length is cut rather than dropped, so a
 * long phrase still says most of what it meant.
 */
export const MAX_RESUME_SOFT_SKILLS = 50;
export const MAX_SOFT_SKILL_LENGTH = 100;

/**
 * A short list of names: trimmed, the first spelling of each kept when the
 * same name is written twice in different case, bounded in count and length.
 * The soft skills' rule, shared with the interests.
 */
function normalizeShortTextList(value: unknown, max: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (result.length >= max) break;
    if (typeof entry !== 'string') continue;
    const name = entry.trim().replace(/\s+/g, ' ').slice(0, maxLength).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

/**
 * A resume's soft skills: names only, trimmed, the first spelling of each
 * kept when the same skill is written twice in different case, bounded.
 */
export function normalizeSoftSkillsList(value: unknown): string[] {
  return normalizeShortTextList(value, MAX_RESUME_SOFT_SKILLS, MAX_SOFT_SKILL_LENGTH);
}

/** Omitted keeps what is stored, like every other field here; anything else is normalized. */
function normalizeSoftSkills(value: unknown, existing?: string[]): string[] {
  if (typeof value === 'undefined') return normalizeSoftSkillsList(existing);
  return normalizeSoftSkillsList(value);
}

/** The interests, by the soft skills' rule; omitted keeps what is stored. */
function normalizeInterests(value: unknown, existing?: string[]): string[] {
  const source = typeof value === 'undefined' ? existing : value;
  return normalizeShortTextList(source, MAX_RESUME_INTERESTS, MAX_INTEREST_LENGTH);
}

function normalizeContact(input: CreateResumeDTO['contact'] | undefined, existing?: Contact): Contact {
  return {
    phone: toSafeString(input?.phone, existing?.phone ?? ''),
    email: toSafeString(input?.email, existing?.email ?? ''),
    linkedin: toSafeString(input?.linkedin, existing?.linkedin ?? ''),
    github: toSafeString(input?.github, existing?.github ?? ''),
    portfolio: toSafeString(input?.portfolio, existing?.portfolio ?? ''),
    location: toSafeString(input?.location, existing?.location ?? ''),
  };
}

function normalizeExperience(experience: CreateResumeDTO['experience'] | undefined, existing?: Experience[]): Experience[] {
  if (!experience) return existing ?? [];
  return experience.map((exp): Experience => ({
    title: toSafeString(exp?.title),
    company: toSafeString(exp?.company),
    startDate: toSafeString(exp?.startDate),
    endDate: toSafeString(exp?.endDate),
    location: toSafeString(exp?.location),
    description: toSafeString(exp?.description),
    achievements: normalizeStringList(exp?.achievements),
    skills: normalizeStringList(exp?.skills),
  }));
}

function normalizeStrengths(strengths: CreateResumeDTO['strengths'] | undefined, existing?: Strength[]): Strength[] {
  if (!strengths) return existing ?? [];
  return strengths.map((item): Strength => ({
    title: toSafeString(item?.title),
    description: toSafeString(item?.description),
  }));
}

function normalizeEducation(education: CreateResumeDTO['education'] | undefined, existing?: Education[]): Education[] {
  if (!education) return existing ?? [];
  return education.map((item): Education => ({
    degree: toSafeString(item?.degree),
    institution: toSafeString(item?.institution),
    startDate: toSafeString(item?.startDate),
    endDate: toSafeString(item?.endDate),
    location: toSafeString(item?.location),
    gpa: toSafeString(item?.gpa),
    achievements: Array.isArray(item?.achievements)
      ? item.achievements.filter((a): a is string => typeof a === 'string').map((a) => a.trim()).filter(Boolean)
      : undefined,
  }));
}

function normalizeCertifications(certifications: CreateResumeDTO['certifications'] | undefined, existing?: Certification[]): Certification[] {
  if (!certifications) return existing ?? [];
  return certifications
    .filter((item): item is Certification => !!item && typeof item === 'object')
    .map((item) => ({
      name: toSafeString(item.name),
      issuer: toSafeString(item.issuer),
      date: toSafeString(item.date),
      expiryDate: toSafeString(item.expiryDate),
      credentialId: toSafeString(item.credentialId),
    }));
}

/*
 * The other section kinds (config/sectionCatalogue.ts), one normaliser shape
 * for all of them.
 *
 * Omitted - or not a list at all - keeps what is stored: the list normalisers
 * above `.map` a truthy non-array and answer a 500, and the preview's `list()`
 * is the only thing standing between a client mid-edit and that today, so the
 * new kinds are lenient here as well. In a list, anything that is not an
 * object is dropped, every field is read as text, and an entry with nothing
 * typed into it (`typed`) is dropped rather than stored as a row of empty
 * strings, which is what an "Add entry" abandoned in the editor would be.
 * Capped, like the soft skills, against a pasted or runaway import.
 */
function normalizeEntryList<T>(
  value: unknown,
  existing: T[] | undefined,
  read: (item: Record<string, unknown>) => T,
  typed: (entry: T) => boolean
): T[] {
  if (!Array.isArray(value)) return existing ?? [];
  return value
    .filter((item): item is Record<string, unknown> => isPlainRecord(item))
    .map(read)
    .filter(typed)
    .slice(0, MAX_RESUME_SECTION_ENTRIES);
}

function normalizeProjects(value: unknown, existing?: Project[]): Project[] {
  return normalizeEntryList(
    value,
    existing,
    (item): Project => ({
      name: toSafeString(item.name),
      role: toSafeString(item.role),
      startDate: toSafeString(item.startDate),
      endDate: toSafeString(item.endDate),
      link: toSafeString(item.link),
      description: toSafeString(item.description),
      achievements: normalizeStringList(item.achievements),
    }),
    (entry) => Boolean(entry.name || entry.role || entry.description || entry.achievements.length)
  );
}

function normalizeLanguages(value: unknown, existing?: Language[]): Language[] {
  return normalizeEntryList(
    value,
    existing,
    (item): Language => ({ language: toSafeString(item.language), proficiency: toSafeString(item.proficiency) }),
    (entry) => Boolean(entry.language)
  );
}

function normalizeAwards(value: unknown, existing?: Award[]): Award[] {
  return normalizeEntryList(
    value,
    existing,
    (item): Award => ({
      title: toSafeString(item.title),
      issuer: toSafeString(item.issuer),
      date: toSafeString(item.date),
      description: toSafeString(item.description),
    }),
    (entry) => Boolean(entry.title || entry.issuer)
  );
}

function normalizePublications(value: unknown, existing?: Publication[]): Publication[] {
  return normalizeEntryList(
    value,
    existing,
    (item): Publication => ({
      title: toSafeString(item.title),
      publisher: toSafeString(item.publisher),
      date: toSafeString(item.date),
      link: toSafeString(item.link),
      description: toSafeString(item.description),
    }),
    (entry) => Boolean(entry.title)
  );
}

function normalizeVolunteering(value: unknown, existing?: Volunteering[]): Volunteering[] {
  return normalizeEntryList(
    value,
    existing,
    (item): Volunteering => ({
      role: toSafeString(item.role),
      organization: toSafeString(item.organization),
      startDate: toSafeString(item.startDate),
      endDate: toSafeString(item.endDate),
      location: toSafeString(item.location),
      description: toSafeString(item.description),
      achievements: normalizeStringList(item.achievements),
    }),
    (entry) => Boolean(entry.role || entry.organization)
  );
}

function normalizeCourses(value: unknown, existing?: Course[]): Course[] {
  return normalizeEntryList(
    value,
    existing,
    (item): Course => ({
      name: toSafeString(item.name),
      institution: toSafeString(item.institution),
      date: toSafeString(item.date),
    }),
    (entry) => Boolean(entry.name)
  );
}

function normalizeReferences(value: unknown, existing?: Reference[]): Reference[] {
  return normalizeEntryList(
    value,
    existing,
    (item): Reference => ({
      name: toSafeString(item.name),
      title: toSafeString(item.title),
      company: toSafeString(item.company),
      email: toSafeString(item.email),
      phone: toSafeString(item.phone),
    }),
    (entry) => Boolean(entry.name)
  );
}

function readCustomSectionEntry(item: Record<string, unknown>): CustomSectionEntry {
  return {
    heading: toSafeString(item.heading),
    subheading: toSafeString(item.subheading),
    startDate: toSafeString(item.startDate),
    endDate: toSafeString(item.endDate),
    location: toSafeString(item.location),
    description: toSafeString(item.description),
    achievements: normalizeStringList(item.achievements),
  };
}

/**
 * The custom sections. A section's key is the client's to make (the editor
 * mints `cs-<8 hex>`), so one that is not well formed, or repeats an earlier
 * one, drops the whole section rather than being repaired here - a repaired
 * key would no longer match the `custom:<key>` ref the order carries. A
 * section survives on its title alone, so an added, empty card keeps its name.
 */
function normalizeCustomSections(value: unknown, existing?: CustomSection[]): CustomSection[] {
  if (!Array.isArray(value)) return existing ?? [];
  const seen = new Set<string>();
  const result: CustomSection[] = [];
  for (const item of value) {
    if (result.length >= MAX_RESUME_CUSTOM_SECTIONS) break;
    if (!isPlainRecord(item)) continue;
    const key = toSafeString(item.key);
    if (!isCustomSectionKey(key) || seen.has(key)) continue;
    const title = toSafeString(item.title);
    const entries = normalizeEntryList(
      item.entries,
      undefined,
      readCustomSectionEntry,
      (entry) => Boolean(entry.heading || entry.subheading || entry.description || entry.achievements.length)
    );
    if (!title && entries.length === 0) continue;
    seen.add(key);
    result.push({ key, title, entries });
  }
  return result;
}

/**
 * The section order (config/sectionCatalogue.ts has the semantics). Omitted,
 * or not a list at all, keeps the stored order re-cleaned against the custom
 * sections just saved, so a section deleted in this save loses its ref; `[]`
 * clears it - back to the template's own order, stored as absent; a list is
 * stored as its valid refs, once each, in the order given. NOTHING is appended
 * or filled in: a resume moves only once its person arranges the cards, and
 * the order is completed where it is read (`effectiveSectionOrder`) or drawn
 * (`sectionSortKey`). A list with no valid ref in it clears too - a client
 * that sent only junk arranged nothing.
 */
function normalizeSectionOrder(
  value: unknown,
  existing: string[] | undefined,
  customSections: CustomSection[]
): string[] | undefined {
  const customKeys = customSections.map((section) => section.key);
  const source = Array.isArray(value) ? value : existing;
  const cleaned = cleanSectionOrder(source, customKeys);
  return cleaned.length > 0 ? cleaned : undefined;
}

export function normalizeResumeSettings(
  input: CreateResumeDTO['resumeSettings'] | undefined,
  existing?: ResumeSettings
): ResumeSettings {
  const source = input && typeof input === 'object' ? input : undefined;
  const technicalSkillsLayout = isTechnicalSkillsLayout(source?.technicalSkillsLayout)
    ? source.technicalSkillsLayout
    : isTechnicalSkillsLayout(existing?.technicalSkillsLayout)
      ? existing.technicalSkillsLayout
      : DEFAULT_TECHNICAL_SKILLS_LAYOUT;
  // A boolean in the payload decides; anything else - omitted, null, "yes" -
  // keeps what is stored, and nothing stored is off. The same rule as the
  // layout above, so a client that predates the switches cannot turn them off
  // by saving a resume without them.
  const includeSoftSkills =
    typeof source?.includeSoftSkills === 'boolean' ? source.includeSoftSkills : existing?.includeSoftSkills === true;
  const includeStrengths =
    typeof source?.includeStrengths === 'boolean' ? source.includeStrengths : existing?.includeStrengths === true;

  return {
    resumePromptId:
      toSafeString(source?.resumePromptId, existing?.resumePromptId ?? DEFAULT_RESUME_PROMPT_ID) || DEFAULT_RESUME_PROMPT_ID,
    // No `analyzeJobPromptId` and no `coverLetterPromptId` any more: a
    // posting is analysed once for every resume, by one prompt (owner
    // decision J0), and a cover letter has one prompt too - the built-in, which
    // no page ever let a resume replace. Nor `hardSkillOrdering`: the
    // tailored skills block is printed in the order the model wrote it, and
    // nothing reorders it. Nor `companyFolderNameTemplate`: the folders are
    // the administrator's prefix and the account's own folder path now
    // (utils/outputStorage.ts), and a resume names only its files. One a
    // resume still stores is not read, and its next save drops it. Nor a
    // `tailorMode`: Partial or Fully Tailor is the RUN's (the builder's mode),
    // so a resume stored with one is read past and loses it at its next save.
    resumeFileNameTemplate: validateOutputFileNameTemplate(
      source?.resumeFileNameTemplate ?? existing?.resumeFileNameTemplate,
      DEFAULT_RESUME_FILE_NAME_TEMPLATE
    ),
    coverLetterFileNameTemplate: validateOutputFileNameTemplate(
      source?.coverLetterFileNameTemplate ?? existing?.coverLetterFileNameTemplate,
      DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE
    ),
    technicalSkillsLayout,
    includeSoftSkills,
    includeStrengths,
    // Only values this build understands survive, and an omitted one keeps
    // whatever was stored: a client that predates these fields must not blank
    // them by saving a resume without them.
    ai: normalizeAiPreferences(source && 'ai' in source ? source.ai : existing?.ai),
  };
}

/** Normalizes an incoming resume payload, preserving existing values for omitted fields. */
export function normalizeResumePayload(
  data: CreateResumeDTO,
  existing?: Resume
): Omit<Resume, 'id' | 'createdAt' | 'updatedAt'> {
  const customSections = normalizeCustomSections(data.customSections, existing?.customSections);
  const sectionOrder = normalizeSectionOrder(data.sectionOrder, existing?.sectionOrder, customSections);
  return {
    name: toSafeString(data.name, existing?.name ?? 'Untitled Profile'),
    title: toSafeString(data.title, existing?.title ?? 'Professional'),
    totalYearsExperience: toOptionalPositiveNumber(data.totalYearsExperience, existing?.totalYearsExperience),
    preferredTemplate: toSafeString(data.preferredTemplate, existing?.preferredTemplate ?? ''),
    disabled: typeof data.disabled === 'boolean' ? data.disabled : (existing?.disabled ?? false),
    resumeSettings: normalizeResumeSettings(data.resumeSettings, existing?.resumeSettings),
    contact: normalizeContact(data.contact, existing?.contact),
    summary: toSafeString(data.summary, existing?.summary ?? ''),
    experience: normalizeExperience(data.experience, existing?.experience),
    strengths: normalizeStrengths(data.strengths, existing?.strengths),
    ...normalizeSkills(data, existing),
    softSkills: normalizeSoftSkills(data.softSkills, existing?.softSkills),
    education: normalizeEducation(data.education, existing?.education),
    certifications: normalizeCertifications(data.certifications, existing?.certifications),
    projects: normalizeProjects(data.projects, existing?.projects),
    languages: normalizeLanguages(data.languages, existing?.languages),
    awards: normalizeAwards(data.awards, existing?.awards),
    publications: normalizePublications(data.publications, existing?.publications),
    volunteering: normalizeVolunteering(data.volunteering, existing?.volunteering),
    courses: normalizeCourses(data.courses, existing?.courses),
    interests: normalizeInterests(data.interests, existing?.interests),
    references: normalizeReferences(data.references, existing?.references),
    customSections,
    // Last, because it is cleaned against the custom sections just saved; and
    // left out entirely when absent, so "no order" is not stored as a key.
    ...(sectionOrder ? { sectionOrder } : {}),
  };
}

/**
 * The two skill fields, decided together.
 *
 * Together and not field by field, because they describe the same thing and can
 * contradict each other. The rules, in order:
 *
 * - A payload that names NEITHER keeps what is stored. Omitting a field means
 *   "leave it alone" everywhere else here, and a client that predates
 *   categories must not blank them by saving a resume without them.
 * - A payload that names `skills` in a grouped shape carries its own
 *   categories, and they win: the person who wrote that file said where each
 *   skill goes.
 * - A payload that names `skillCategories` separately is merged INTO the flat
 *   list rather than kept beside it, so the invariant that every categorized
 *   skill is also in `skills` holds however the file was written. Without that,
 *   a skill typed only into a category would be rendered but never reach the
 *   tailoring prompt, and the model would drop it as unclaimed.
 * - A payload that names only a flat `skills` list CLEARS the categories.
 *   Saying "my skills are these, in a list" is a complete statement, and
 *   keeping a stale grouping around it would resurrect headings the person just
 *   removed.
 */
function normalizeSkills(
  data: CreateResumeDTO,
  existing?: Resume
): { skills: string[]; skillCategories?: SkillCategoryGroup[] } {
  const hasSkills = typeof data.skills !== 'undefined';
  const hasCategories = typeof data.skillCategories !== 'undefined';

  if (!hasSkills && !hasCategories) {
    return {
      skills: existing?.skills ?? [],
      ...(existing?.skillCategories ? { skillCategories: existing.skillCategories } : {}),
    };
  }

  const fromSkills = normalizeSkillsInput(hasSkills ? data.skills : []);
  const fromCategories = hasCategories
    ? normalizeSkillsInput(data.skillCategories)
    : { skills: [], categories: [] };

  // One pass over both, so a name appearing in each is stored once and in the
  // order it was first seen.
  const merged = normalizeSkillsInput([
    ...fromSkills.categories,
    ...fromCategories.categories,
    ...fromSkills.skills,
    ...fromCategories.skills,
  ]);

  return {
    skills: merged.skills,
    ...(merged.categories.length > 0 ? { skillCategories: merged.categories } : {}),
  };
}

/** Builds a brand new resume record from a payload. */
export function buildNewResume(data: CreateResumeDTO, id: string): Resume {
  const now = new Date().toISOString();
  return {
    ...normalizeResumePayload(data),
    id,
    createdAt: now,
    updatedAt: now,
  };
}

/** Applies a payload on top of an existing resume, preserving id and creation date. */
export function buildUpdatedResume(existing: Resume, data: CreateResumeDTO): Resume {
  return {
    ...normalizeResumePayload(data, existing),
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The settings a preview renders with. Everything else is the stored value or the default. */
const PREVIEW_SETTING_KEYS = [
  'technicalSkillsLayout',
  'includeSoftSkills',
  'includeStrengths',
] as const;

/**
 * An unsaved draft from the resume editor, as the resume it would become -
 * for the live preview, and for nothing that is ever stored.
 *
 * Lenient where the save is strict, because it runs on every pause in typing:
 *
 * - It NEVER throws. A half-typed file name template ("{{profile na") or one
 *   naming a token that does not exist is the save's to refuse, with a message
 *   the person can act on; refusing the preview over it would blank the resume
 *   they are looking at for a field that does not change how it looks. So only
 *   the settings that change the render are taken from the draft
 *   (`PREVIEW_SETTING_KEYS`), and the file-naming templates and the model
 *   choice stay as stored - which also keeps `checkResumeModelChoice` out of
 *   the preview entirely.
 * - A field of the wrong shape (a string where a list belongs, say, from a
 *   client mid-edit) is treated as omitted, so the stored value shows rather
 *   than an error.
 * - The draft is laid over `existing` with the same omitted-keeps-stored rule
 *   as a save, so fields the form never sends (certifications, a GitHub link)
 *   look the way they will once it is saved.
 *
 * The id, owner and timestamps are the stored resume's, or placeholders for a
 * resume that does not exist yet; none of them reaches a template.
 */
export function buildPreviewResume(draft: unknown, existing?: Resume | null): Resume {
  const source = isPlainRecord(draft) ? draft : {};
  const text = (key: string) => (typeof source[key] === 'string' ? (source[key] as string) : undefined);
  const list = (key: string) =>
    Array.isArray(source[key])
      ? (source[key] as unknown[]).filter((entry) => isPlainRecord(entry))
      : undefined;

  const settingsSource = isPlainRecord(source.resumeSettings) ? source.resumeSettings : {};
  const renderSettings: Record<string, unknown> = {};
  for (const key of PREVIEW_SETTING_KEYS) {
    if (key in settingsSource) renderSettings[key] = settingsSource[key];
  }

  const years = source.totalYearsExperience;
  const dto: CreateResumeDTO = {
    name: text('name'),
    title: text('title'),
    totalYearsExperience: typeof years === 'number' || typeof years === 'string' ? (years as number) : undefined,
    preferredTemplate: text('preferredTemplate'),
    resumeSettings: renderSettings as ResumeSettings,
    contact: isPlainRecord(source.contact) ? (source.contact as CreateResumeDTO['contact']) : undefined,
    summary: text('summary'),
    experience: list('experience') as CreateResumeDTO['experience'],
    strengths: list('strengths') as CreateResumeDTO['strengths'],
    education: list('education') as CreateResumeDTO['education'],
    certifications: list('certifications') as CreateResumeDTO['certifications'],
    projects: list('projects'),
    languages: list('languages'),
    awards: list('awards'),
    publications: list('publications'),
    volunteering: list('volunteering'),
    courses: list('courses'),
    references: list('references'),
    customSections: list('customSections'),
    ...(typeof source.skills !== 'undefined' ? { skills: source.skills } : {}),
    ...(typeof source.skillCategories !== 'undefined' ? { skillCategories: source.skillCategories } : {}),
    ...(Array.isArray(source.softSkills) ? { softSkills: source.softSkills } : {}),
    ...(Array.isArray(source.interests) ? { interests: source.interests } : {}),
    // The order is content, not a setting: a draft that sends [] previews in
    // the template's own order, exactly as the save would print.
    ...(Array.isArray(source.sectionOrder) ? { sectionOrder: source.sectionOrder } : {}),
  };

  const placeholder = {
    id: existing?.id ?? 'preview',
    ...(existing?.ownerId ? { ownerId: existing.ownerId } : {}),
    createdAt: existing?.createdAt ?? '',
    updatedAt: existing?.updatedAt ?? '',
  };

  try {
    return { ...normalizeResumePayload(dto, existing ?? undefined), ...placeholder };
  } catch {
    // Only the stored file-naming templates can still throw here, and only if
    // a row was written before they were validated. The draft's content is
    // what the preview is for, so render it over clean settings instead.
    const withoutStoredSettings = existing ? { ...existing, resumeSettings: undefined } : undefined;
    try {
      return { ...normalizeResumePayload(dto, withoutStoredSettings), ...placeholder };
    } catch {
      return { ...normalizeResumePayload({}, undefined), ...placeholder };
    }
  }
}
