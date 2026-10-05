import { normalizeAiPreferences } from '../config/aiPreferences';
import {
  Certification,
  Contact,
  CreateProfileDTO,
  Education,
  Experience,
  HardSkillOrdering,
  Profile,
  ProfileSettings,
  SkillCategoryGroup,
  Strength,
  TechnicalSkillsLayout,
} from '../types/profile';
import {
  DEFAULT_COMPANY_FOLDER_NAME_TEMPLATE,
  DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE,
  DEFAULT_RESUME_FILE_NAME_TEMPLATE,
  validateOutputFolderNameTemplate,
  validateOutputFileNameTemplate,
} from '../utils/outputStorage';
import type { Template } from '../types/template';
import { currentTemplateId } from '../database/templateRepository';
import { inferTemplateCapabilities } from './templateImport';

export const DEFAULT_RESUME_PROMPT_ID = 'tailor-resume';
export const DEFAULT_ANALYZE_JOB_PROMPT_ID = 'analyze-job-description';
export const DEFAULT_COVER_LETTER_PROMPT_ID = 'generate-cover-letter';
export const DEFAULT_HARD_SKILL_ORDERING: HardSkillOrdering = 'library';
/** Categories on, because that is how every built-in template renders today. */
export const DEFAULT_TECHNICAL_SKILLS_LAYOUT: TechnicalSkillsLayout = 'categorized';

function toSafeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

/**
 * A profile's template, saved under the id it is filed under now. A page left
 * open from before the upgrade, or a profile file exported then, can still
 * send an older build's spelling (`My_Template`); the server would find the
 * template either way, but the editor and the Profiles list compare ids as
 * they are, and would call it a template no longer offered. Anything that is
 * no template id at all is kept as written, to fall back as it always has.
 */
function toTemplateReference(value: string): string {
  return value ? (currentTemplateId(value) ?? value) : value;
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
 * The skills of an uploaded or submitted profile, in whatever shape they came.
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

/** The layout configured for a profile, falling back to the default. */
export function getProfileTechnicalSkillsLayout(
  profile?: Pick<Profile, 'profileSettings'> | null
): TechnicalSkillsLayout {
  const value = profile?.profileSettings?.technicalSkillsLayout;
  return isTechnicalSkillsLayout(value) ? value : DEFAULT_TECHNICAL_SKILLS_LAYOUT;
}

/**
 * Whether this profile's resumes carry a Soft Skills section.
 *
 * Only a stored `true` turns it on. Absent, and anything that is not a
 * boolean, is off - which is what every resume rendered before the switch
 * existed, so an untouched profile's output does not move.
 */
export function getProfileIncludeSoftSkills(profile?: Pick<Profile, 'profileSettings'> | null): boolean {
  return profile?.profileSettings?.includeSoftSkills === true;
}

/** Whether this profile's resumes carry a Strengths section. Off unless stored `true`. */
export function getProfileIncludeStrengths(profile?: Pick<Profile, 'profileSettings'> | null): boolean {
  return profile?.profileSettings?.includeStrengths === true;
}

/**
 * The three rendering choices a profile makes about its resume's sections.
 *
 * Read together because the renderer needs all three at once - the data step
 * to decide what the sections hold, the compile step to decide which markup
 * survives - and two readers of one profile must never disagree about them.
 */
export interface ResumeSectionChoices {
  layout: TechnicalSkillsLayout;
  softSkills: boolean;
  strengths: boolean;
}

export function getProfileResumeSections(
  profile?: Pick<Profile, 'profileSettings'> | null
): ResumeSectionChoices {
  return {
    layout: getProfileTechnicalSkillsLayout(profile),
    softSkills: getProfileIncludeSoftSkills(profile),
    strengths: getProfileIncludeStrengths(profile),
  };
}

/**
 * The profile as a resume drawn with `template` reads it: a section switch the
 * template has no markup for counts as off.
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
 * nothing changes, so a caller can pass any profile through freely.
 */
export function profileForTemplate<P extends Pick<Profile, 'profileSettings'>>(
  profile: P,
  template?: Pick<Template, 'htmlContent'> | null
): P {
  if (!template) return profile;
  const settings = profile.profileSettings;
  const { supportsSoftSkills, supportsStrengths } = inferTemplateCapabilities(template.htmlContent);
  const dropSoftSkills = settings?.includeSoftSkills === true && !supportsSoftSkills;
  const dropStrengths = settings?.includeStrengths === true && !supportsStrengths;
  if (!dropSoftSkills && !dropStrengths) return profile;
  return {
    ...profile,
    profileSettings: {
      ...settings,
      ...(dropSoftSkills ? { includeSoftSkills: false } : {}),
      ...(dropStrengths ? { includeStrengths: false } : {}),
    },
  };
}

/**
 * A profile's own soft skills hold at most this many, of at most this many
 * characters each.
 *
 * Generous for a list a person types - a resume shows a handful - and there
 * to stop a pasted paragraph or a runaway import becoming a section that
 * fills the page. An entry over the length is cut rather than dropped, so a
 * long phrase still says most of what it meant.
 */
export const MAX_PROFILE_SOFT_SKILLS = 50;
export const MAX_SOFT_SKILL_LENGTH = 100;

/**
 * A profile's soft skills: names only, trimmed, the first spelling of each
 * kept when the same skill is written twice in different case, bounded.
 */
export function normalizeSoftSkillsList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (result.length >= MAX_PROFILE_SOFT_SKILLS) break;
    if (typeof entry !== 'string') continue;
    const skill = entry.trim().replace(/\s+/g, ' ').slice(0, MAX_SOFT_SKILL_LENGTH).trim();
    if (!skill) continue;
    const key = skill.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(skill);
  }
  return result;
}

/** Omitted keeps what is stored, like every other field here; anything else is normalized. */
function normalizeSoftSkills(value: unknown, existing?: string[]): string[] {
  if (typeof value === 'undefined') return normalizeSoftSkillsList(existing);
  return normalizeSoftSkillsList(value);
}

function normalizeContact(input: CreateProfileDTO['contact'] | undefined, existing?: Contact): Contact {
  return {
    phone: toSafeString(input?.phone, existing?.phone ?? ''),
    email: toSafeString(input?.email, existing?.email ?? ''),
    linkedin: toSafeString(input?.linkedin, existing?.linkedin ?? ''),
    github: toSafeString(input?.github, existing?.github ?? ''),
    portfolio: toSafeString(input?.portfolio, existing?.portfolio ?? ''),
    location: toSafeString(input?.location, existing?.location ?? ''),
  };
}

function normalizeExperience(experience: CreateProfileDTO['experience'] | undefined, existing?: Experience[]): Experience[] {
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

function normalizeStrengths(strengths: CreateProfileDTO['strengths'] | undefined, existing?: Strength[]): Strength[] {
  if (!strengths) return existing ?? [];
  return strengths.map((item): Strength => ({
    title: toSafeString(item?.title),
    description: toSafeString(item?.description),
  }));
}

function normalizeEducation(education: CreateProfileDTO['education'] | undefined, existing?: Education[]): Education[] {
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

function normalizeCertifications(certifications: CreateProfileDTO['certifications'] | undefined, existing?: Certification[]): Certification[] {
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

export function isHardSkillOrdering(value: unknown): value is HardSkillOrdering {
  return value === 'library' || value === 'job-priority';
}

/** Returns the hard-skill ordering configured for a profile, falling back to the default. */
export function getProfileHardSkillOrdering(profile?: Pick<Profile, 'profileSettings'> | null): HardSkillOrdering {
  const value = profile?.profileSettings?.hardSkillOrdering;
  return isHardSkillOrdering(value) ? value : DEFAULT_HARD_SKILL_ORDERING;
}

export function normalizeProfileSettings(
  input: CreateProfileDTO['profileSettings'] | undefined,
  existing?: ProfileSettings
): ProfileSettings {
  const source = input && typeof input === 'object' ? input : undefined;
  const hardSkillOrdering = isHardSkillOrdering(source?.hardSkillOrdering)
    ? source.hardSkillOrdering
    : isHardSkillOrdering(existing?.hardSkillOrdering)
      ? existing.hardSkillOrdering
      : DEFAULT_HARD_SKILL_ORDERING;
  const technicalSkillsLayout = isTechnicalSkillsLayout(source?.technicalSkillsLayout)
    ? source.technicalSkillsLayout
    : isTechnicalSkillsLayout(existing?.technicalSkillsLayout)
      ? existing.technicalSkillsLayout
      : DEFAULT_TECHNICAL_SKILLS_LAYOUT;
  // A boolean in the payload decides; anything else - omitted, null, "yes" -
  // keeps what is stored, and nothing stored is off. The same rule as the
  // layout above, so a client that predates the switches cannot turn them off
  // by saving a profile without them.
  const includeSoftSkills =
    typeof source?.includeSoftSkills === 'boolean' ? source.includeSoftSkills : existing?.includeSoftSkills === true;
  const includeStrengths =
    typeof source?.includeStrengths === 'boolean' ? source.includeStrengths : existing?.includeStrengths === true;

  return {
    resumePromptId:
      toSafeString(source?.resumePromptId, existing?.resumePromptId ?? DEFAULT_RESUME_PROMPT_ID) || DEFAULT_RESUME_PROMPT_ID,
    analyzeJobPromptId:
      toSafeString(source?.analyzeJobPromptId, existing?.analyzeJobPromptId ?? DEFAULT_ANALYZE_JOB_PROMPT_ID) ||
      DEFAULT_ANALYZE_JOB_PROMPT_ID,
    coverLetterPromptId:
      toSafeString(source?.coverLetterPromptId, existing?.coverLetterPromptId ?? DEFAULT_COVER_LETTER_PROMPT_ID) ||
      DEFAULT_COVER_LETTER_PROMPT_ID,
    resumeFileNameTemplate: validateOutputFileNameTemplate(
      source?.resumeFileNameTemplate ?? existing?.resumeFileNameTemplate,
      DEFAULT_RESUME_FILE_NAME_TEMPLATE
    ),
    coverLetterFileNameTemplate: validateOutputFileNameTemplate(
      source?.coverLetterFileNameTemplate ?? existing?.coverLetterFileNameTemplate,
      DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE
    ),
    companyFolderNameTemplate: validateOutputFolderNameTemplate(
      source?.companyFolderNameTemplate ?? existing?.companyFolderNameTemplate,
      DEFAULT_COMPANY_FOLDER_NAME_TEMPLATE
    ),
    hardSkillOrdering,
    technicalSkillsLayout,
    includeSoftSkills,
    includeStrengths,
    // Only values this build understands survive, and an omitted one keeps
    // whatever was stored: a client that predates these fields must not blank
    // them by saving a profile without them.
    ai: normalizeAiPreferences(source && 'ai' in source ? source.ai : existing?.ai),
  };
}

/** Normalizes an incoming profile payload, preserving existing values for omitted fields. */
export function normalizeProfilePayload(
  data: CreateProfileDTO,
  existing?: Profile
): Omit<Profile, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: toSafeString(data.name, existing?.name ?? 'Untitled Profile'),
    title: toSafeString(data.title, existing?.title ?? 'Professional'),
    totalYearsExperience: toOptionalPositiveNumber(data.totalYearsExperience, existing?.totalYearsExperience),
    preferredTemplate: toTemplateReference(toSafeString(data.preferredTemplate, existing?.preferredTemplate ?? '')),
    disabled: typeof data.disabled === 'boolean' ? data.disabled : (existing?.disabled ?? false),
    profileSettings: normalizeProfileSettings(data.profileSettings, existing?.profileSettings),
    contact: normalizeContact(data.contact, existing?.contact),
    summary: toSafeString(data.summary, existing?.summary ?? ''),
    experience: normalizeExperience(data.experience, existing?.experience),
    strengths: normalizeStrengths(data.strengths, existing?.strengths),
    ...normalizeSkills(data, existing),
    softSkills: normalizeSoftSkills(data.softSkills, existing?.softSkills),
    education: normalizeEducation(data.education, existing?.education),
    certifications: normalizeCertifications(data.certifications, existing?.certifications),
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
 *   categories must not blank them by saving a profile without them.
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
  data: CreateProfileDTO,
  existing?: Profile
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

/** Builds a brand new profile record from a payload. */
export function buildNewProfile(data: CreateProfileDTO, id: string): Profile {
  const now = new Date().toISOString();
  return {
    ...normalizeProfilePayload(data),
    id,
    createdAt: now,
    updatedAt: now,
  };
}

/** Applies a payload on top of an existing profile, preserving id and creation date. */
export function buildUpdatedProfile(existing: Profile, data: CreateProfileDTO): Profile {
  return {
    ...normalizeProfilePayload(data, existing),
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
  'hardSkillOrdering',
  'includeSoftSkills',
  'includeStrengths',
] as const;

/**
 * An unsaved draft from the profile editor, as the profile it would become -
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
 *   choice stay as stored - which also keeps `checkProfileModelChoice` out of
 *   the preview entirely.
 * - A field of the wrong shape (a string where a list belongs, say, from a
 *   client mid-edit) is treated as omitted, so the stored value shows rather
 *   than an error.
 * - The draft is laid over `existing` with the same omitted-keeps-stored rule
 *   as a save, so fields the form never sends (certifications, a GitHub link)
 *   look the way they will once it is saved.
 *
 * The id, owner and timestamps are the stored profile's, or placeholders for a
 * profile that does not exist yet; none of them reaches a template.
 */
export function buildPreviewProfile(draft: unknown, existing?: Profile | null): Profile {
  const source = isPlainRecord(draft) ? draft : {};
  const text = (key: string) => (typeof source[key] === 'string' ? (source[key] as string) : undefined);
  const list = (key: string) =>
    Array.isArray(source[key])
      ? (source[key] as unknown[]).filter((entry) => isPlainRecord(entry))
      : undefined;

  const settingsSource = isPlainRecord(source.profileSettings) ? source.profileSettings : {};
  const renderSettings: Record<string, unknown> = {};
  for (const key of PREVIEW_SETTING_KEYS) {
    if (key in settingsSource) renderSettings[key] = settingsSource[key];
  }

  const years = source.totalYearsExperience;
  const dto: CreateProfileDTO = {
    name: text('name'),
    title: text('title'),
    totalYearsExperience: typeof years === 'number' || typeof years === 'string' ? (years as number) : undefined,
    preferredTemplate: text('preferredTemplate'),
    profileSettings: renderSettings as ProfileSettings,
    contact: isPlainRecord(source.contact) ? (source.contact as CreateProfileDTO['contact']) : undefined,
    summary: text('summary'),
    experience: list('experience') as CreateProfileDTO['experience'],
    strengths: list('strengths') as CreateProfileDTO['strengths'],
    education: list('education') as CreateProfileDTO['education'],
    certifications: list('certifications') as CreateProfileDTO['certifications'],
    ...(typeof source.skills !== 'undefined' ? { skills: source.skills } : {}),
    ...(typeof source.skillCategories !== 'undefined' ? { skillCategories: source.skillCategories } : {}),
    ...(Array.isArray(source.softSkills) ? { softSkills: source.softSkills } : {}),
  };

  const placeholder = {
    id: existing?.id ?? 'preview',
    ...(existing?.ownerId ? { ownerId: existing.ownerId } : {}),
    createdAt: existing?.createdAt ?? '',
    updatedAt: existing?.updatedAt ?? '',
  };

  try {
    return { ...normalizeProfilePayload(dto, existing ?? undefined), ...placeholder };
  } catch {
    // Only the stored file-naming templates can still throw here, and only if
    // a row was written before they were validated. The draft's content is
    // what the preview is for, so render it over clean settings instead.
    const withoutStoredSettings = existing ? { ...existing, profileSettings: undefined } : undefined;
    try {
      return { ...normalizeProfilePayload(dto, withoutStoredSettings), ...placeholder };
    } catch {
      return { ...normalizeProfilePayload({}, undefined), ...placeholder };
    }
  }
}
