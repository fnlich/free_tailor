import type {
  Award,
  Certification,
  Course,
  CustomSectionEntry,
  Language,
  Project,
  Publication,
  Reference,
  Volunteering,
} from '../types/profile';

/**
 * The render data of the section kinds beyond the classic six - what the
 * blocks the extra-sections macro generates (generators/extraSectionsMarkup.ts)
 * and the DOCX print. Pure: the renderer hands in its own link rules, the ones
 * it applies to `contact.linkedin`, so a project's or a publication's link is
 * policed by exactly the code that polices every other href in a resume.
 *
 * Spread over `...profile` by `prepareResumeRenderData`, so each prepared list
 * stands under the profile field's own name, with the derived text beside the
 * fields (`dates`, `note`, `linkHref`, ...): a template that loops over
 * `certifications` itself keeps working and gains `dates`. Lenient about shape
 * - render data can be a payload this build never normalised - and an entry
 * with nothing in it is dropped again here, so no block prints an empty row.
 */

export type LinkRules = {
  /** An http(s) href for the value, or '' for one that is not safe to link. */
  href(value: string | undefined): string;
  /** The text a link prints as - the host and path, no scheme. */
  display(value: string | undefined): string;
};

export type PreparedCertification = Certification & { dates: string; note: string };
export type PreparedProject = Project & { dates: string; linkHref: string; linkText: string };
export type PreparedVolunteering = Volunteering & { dates: string };
export type PreparedAward = Award & { dates: string };
export type PreparedPublication = Publication & { dates: string; linkHref: string; linkText: string };
export type PreparedCourse = Course & { dates: string };
export type PreparedReference = Reference & { subline: string; contactLine: string };
export type PreparedCustomEntry = CustomSectionEntry & { dates: string };
export type PreparedCustomSection = {
  key: string;
  title: string;
  entries: PreparedCustomEntry[];
  hasEntries: boolean;
};

export type ExtraSectionData = {
  certifications: PreparedCertification[];
  projects: PreparedProject[];
  volunteering: PreparedVolunteering[];
  awards: PreparedAward[];
  publications: PreparedPublication[];
  courses: PreparedCourse[];
  languages: Language[];
  interests: string[];
  references: PreparedReference[];
  customSections: PreparedCustomSection[];
  /** The custom sections by key, for the macro's `lookup`. */
  customSectionsByKey: Record<string, PreparedCustomSection>;
};

type Source = {
  certifications?: unknown;
  projects?: unknown;
  volunteering?: unknown;
  awards?: unknown;
  publications?: unknown;
  courses?: unknown;
  languages?: unknown;
  interests?: unknown;
  references?: unknown;
  customSections?: unknown;
};

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((s) => s.trim()).filter(Boolean) : [];
const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
    : [];

/** "01/2022 - Present", one side alone, or ''. */
export function dateRangeText(start: unknown, end: unknown): string {
  return [text(start), text(end)].filter(Boolean).join(' - ');
}

const nonEmpty = (...values: Array<string | string[]>) =>
  values.some((value) => (Array.isArray(value) ? value.length > 0 : value.length > 0));

export function prepareExtraSectionData(profile: Source, links: LinkRules): ExtraSectionData {
  const certifications = records(profile.certifications)
    .map((item): PreparedCertification => {
      const credentialId = text(item.credentialId);
      return {
        name: text(item.name),
        issuer: text(item.issuer),
        date: text(item.date),
        expiryDate: text(item.expiryDate),
        credentialId,
        dates: dateRangeText(item.date, item.expiryDate),
        note: credentialId ? `Credential ID ${credentialId}` : '',
      };
    })
    .filter((item) => nonEmpty(item.name, item.issuer));

  const projects = records(profile.projects)
    .map((item): PreparedProject => ({
      name: text(item.name),
      role: text(item.role),
      startDate: text(item.startDate),
      endDate: text(item.endDate),
      link: text(item.link),
      description: text(item.description),
      achievements: list(item.achievements),
      dates: dateRangeText(item.startDate, item.endDate),
      linkHref: links.href(text(item.link)),
      linkText: links.display(text(item.link)),
    }))
    .filter((item) => nonEmpty(item.name, item.role, item.description, item.achievements));

  const volunteering = records(profile.volunteering)
    .map((item): PreparedVolunteering => ({
      role: text(item.role),
      organization: text(item.organization),
      startDate: text(item.startDate),
      endDate: text(item.endDate),
      location: text(item.location),
      description: text(item.description),
      achievements: list(item.achievements),
      dates: dateRangeText(item.startDate, item.endDate),
    }))
    .filter((item) => nonEmpty(item.role, item.organization));

  const awards = records(profile.awards)
    .map((item): PreparedAward => ({
      title: text(item.title),
      issuer: text(item.issuer),
      date: text(item.date),
      description: text(item.description),
      dates: text(item.date),
    }))
    .filter((item) => nonEmpty(item.title, item.issuer));

  const publications = records(profile.publications)
    .map((item): PreparedPublication => ({
      title: text(item.title),
      publisher: text(item.publisher),
      date: text(item.date),
      link: text(item.link),
      description: text(item.description),
      dates: text(item.date),
      linkHref: links.href(text(item.link)),
      linkText: links.display(text(item.link)),
    }))
    .filter((item) => nonEmpty(item.title));

  const courses = records(profile.courses)
    .map((item): PreparedCourse => ({
      name: text(item.name),
      institution: text(item.institution),
      date: text(item.date),
      dates: text(item.date),
    }))
    .filter((item) => nonEmpty(item.name));

  const languages = records(profile.languages)
    .map((item): Language => ({ language: text(item.language), proficiency: text(item.proficiency) }))
    .filter((item) => nonEmpty(item.language));

  const interests = list(profile.interests);

  const references = records(profile.references)
    .map((item): PreparedReference => {
      const title = text(item.title);
      const company = text(item.company);
      const email = text(item.email);
      const phone = text(item.phone);
      return {
        name: text(item.name),
        title,
        company,
        email,
        phone,
        subline: [title, company].filter(Boolean).join(', '),
        contactLine: [email, phone].filter(Boolean).join(' | '),
      };
    })
    .filter((item) => nonEmpty(item.name));

  const customSections: PreparedCustomSection[] = [];
  for (const item of records(profile.customSections)) {
    const key = text(item.key);
    if (!key || customSections.some((section) => section.key === key)) continue;
    const entries = records(item.entries)
      .map((entry): PreparedCustomEntry => ({
        heading: text(entry.heading),
        subheading: text(entry.subheading),
        startDate: text(entry.startDate),
        endDate: text(entry.endDate),
        location: text(entry.location),
        description: text(entry.description),
        achievements: list(entry.achievements),
        dates: dateRangeText(entry.startDate, entry.endDate),
      }))
      .filter((entry) => nonEmpty(entry.heading, entry.subheading, entry.description, entry.achievements));
    customSections.push({ key, title: text(item.title), entries, hasEntries: entries.length > 0 });
  }
  const customSectionsByKey: Record<string, PreparedCustomSection> = {};
  for (const section of customSections) customSectionsByKey[section.key] = section;

  return {
    certifications,
    projects,
    volunteering,
    awards,
    publications,
    courses,
    languages,
    interests,
    references,
    customSections,
    customSectionsByKey,
  };
}

/** For the DOCX: the custom section a `custom:<key>` ref names, if the data has it. */
export function customSectionByKey(data: Pick<ExtraSectionData, 'customSectionsByKey'>, key: string): PreparedCustomSection | undefined {
  return data.customSectionsByKey[key];
}
