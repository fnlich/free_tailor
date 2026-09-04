import {
  Certification,
  Contact,
  CreateProfileDTO,
  Education,
  Experience,
  HardSkillOrdering,
  Profile,
  ProfileSettings,
  Strength,
} from '../types/profile';
import {
  DEFAULT_COMPANY_FOLDER_NAME_TEMPLATE,
  DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE,
  DEFAULT_RESUME_FILE_NAME_TEMPLATE,
  validateOutputFolderNameTemplate,
  validateOutputFileNameTemplate,
} from '../utils/outputStorage';

export const DEFAULT_RESUME_PROMPT_ID = 'tailor-resume';
export const DEFAULT_ANALYZE_JOB_PROMPT_ID = 'analyze-job-description';
export const DEFAULT_COVER_LETTER_PROMPT_ID = 'generate-cover-letter';
export const DEFAULT_HARD_SKILL_ORDERING: HardSkillOrdering = 'library';

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
    preferredTemplate: toSafeString(data.preferredTemplate, existing?.preferredTemplate ?? ''),
    disabled: typeof data.disabled === 'boolean' ? data.disabled : (existing?.disabled ?? false),
    profileSettings: normalizeProfileSettings(data.profileSettings, existing?.profileSettings),
    contact: normalizeContact(data.contact, existing?.contact),
    summary: toSafeString(data.summary, existing?.summary ?? ''),
    experience: normalizeExperience(data.experience, existing?.experience),
    strengths: normalizeStrengths(data.strengths, existing?.strengths),
    skills: normalizeStringList(data.skills, existing?.skills ?? []),
    education: normalizeEducation(data.education, existing?.education),
    certifications: normalizeCertifications(data.certifications, existing?.certifications),
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
