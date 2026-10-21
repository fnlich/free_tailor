/**
 * The profile editor's draft, and every decision about it that needs no React:
 * what a stored profile looks like as a form, what the form saves, what the
 * live preview is sent, which templates the picker may offer, how an entry is
 * found and changed, and what Write with AI is sent.
 *
 * Kept apart from the components for the reason lib/profileModel.ts is: it can
 * be tested without a browser (backend/test/frontendHelpers.test.js transpiles
 * it and refuses any runtime import). Type imports are erased, so they are
 * fine; the one runtime value it would want from lib/api.ts - the library's
 * heading order - is a parameter instead, and the section catalogue
 * (lib/profileSections.ts) is the editor's to bring: a section is referred to
 * here by its ref string, `<kind>` or `custom:<key>`.
 */

import type {
  AiPreferences,
  Award,
  Certification,
  Course,
  CreateProfileDTO,
  CustomSection,
  CustomSectionEntry,
  Education,
  Experience,
  Language,
  Profile,
  ProfileSettings,
  Project,
  Publication,
  Reference,
  SkillCategoryGroup,
  Strength,
  TailorMode,
  TechnicalSkillsLayout,
  Template,
  Volunteering,
  WriteBulletsKind,
  WriteBulletsRequest,
  WriteBulletsTask,
} from './api';

export type DraftSettings = Required<ProfileSettings>;

/**
 * Every list row carries a key of its own.
 *
 * Index keys were the old form's bug: a pending skill typed into the second of
 * three roles followed the index, not the role, so removing the first role
 * moved the half-typed text onto a different job.
 */
export interface DraftExperience extends Omit<Experience, 'achievements'> {
  key: string;
  /**
   * The achievements as typed, one per line. Kept as text rather than a list
   * because the list cannot hold a line that is still empty: splitting on
   * every keystroke ate the Enter somebody had just pressed.
   */
  achievementsText: string;
}

export interface DraftStrength extends Strength {
  key: string;
}

export interface DraftEducation extends Education {
  key: string;
}

export interface DraftCertification extends Certification {
  key: string;
}

/* The other section kinds (lib/profileSections.ts); the bullet kinds carry `achievementsText` like a role. */

export interface DraftProject extends Omit<Project, 'achievements'> {
  key: string;
  achievementsText: string;
}

export interface DraftLanguage extends Language {
  key: string;
}

export interface DraftAward extends Award {
  key: string;
}

export interface DraftPublication extends Publication {
  key: string;
}

export interface DraftVolunteering extends Omit<Volunteering, 'achievements'> {
  key: string;
  achievementsText: string;
}

export interface DraftCourse extends Course {
  key: string;
}

export interface DraftReference extends Reference {
  key: string;
}

export interface DraftCustomEntry extends Omit<CustomSectionEntry, 'achievements'> {
  key: string;
  achievementsText: string;
}

/** A custom section. `key` is the STORED key, and the React key too: it is unique in the profile and never reused. */
export interface DraftCustomSection {
  key: string;
  title: string;
  entries: DraftCustomEntry[];
}

export interface DraftContact {
  phone: string;
  email: string;
  linkedin: string;
  github: string;
  portfolio: string;
  location: string;
}

export interface ProfileDraft {
  name: string;
  title: string;
  /** As typed; parsed on save, so "4." mid-edit is not refused. */
  totalYearsExperience: string;
  /** Empty means none chosen, which renders with `default` as the builder does. */
  preferredTemplate: string;
  settings: DraftSettings;
  contact: DraftContact;
  summary: string;
  experience: DraftExperience[];
  education: DraftEducation[];
  certifications: DraftCertification[];
  /** Every hard skill the profile claims - the canonical flat list. */
  skills: string[];
  /**
   * One heading per skill rather than a list of groups, because that is the
   * question the form asks - "where does this skill go?" - and it makes two
   * impossible states unrepresentable: a skill in two groups, and a group
   * holding a skill the profile no longer claims.
   */
  skillCategoryBySkill: Record<string, string>;
  softSkills: string[];
  strengths: DraftStrength[];
  projects: DraftProject[];
  languages: DraftLanguage[];
  awards: DraftAward[];
  publications: DraftPublication[];
  volunteering: DraftVolunteering[];
  courses: DraftCourse[];
  interests: string[];
  references: DraftReference[];
  customSections: DraftCustomSection[];
  /**
   * The section order as arranged, or null for "follow the template": the
   * cards sit in the template's own order and nothing is stored. The first
   * drag, Move, Add content or Remove section turns null into the list as it
   * was shown, then changes it; "Use the template's order" puts null back.
   */
  sectionOrder: string[] | null;
}

/** The template every resume falls back to, as the builder and the server name it. */
export const FALLBACK_TEMPLATE_ID = 'default';

export const DEFAULT_PROFILE_SETTINGS: DraftSettings = {
  resumePromptId: 'tailor-resume',
  resumeFileNameTemplate: '{{profile_name}}',
  coverLetterFileNameTemplate: '{{profile_name}}_cover_letter',
  technicalSkillsLayout: 'categorized',
  // Off, which is what every resume printed before the switches existed - so a
  // profile nobody has touched comes out exactly as it did.
  includeSoftSkills: false,
  includeStrengths: false,
  // null follows the default (`defaultTailorMode` of GET /resume/models), so a
  // profile that never chose keeps following `.env`'s DEFAULT_TAILOR_MODE.
  tailorMode: null,
  // Empty means every field inherits the app default, which is what a profile
  // that has never chosen should do.
  ai: {},
};

/** The words the editor uses for the two layouts. The stored values stay as they were. */
export const LAYOUT_LABELS: Record<TechnicalSkillsLayout, string> = {
  flat: 'Plain',
  categorized: 'Grouped',
};

/** The two tailoring modes, in the order the Generation card offers them, with what each does to a resume. */
export const TAILOR_MODE_CHOICES: ReadonlyArray<{ value: TailorMode; label: string; description: string }> = [
  {
    value: 'partial',
    label: 'Partial tailor',
    description:
      'Rewrites your own summary and each role\'s description and achievements for the posting. A role you left ' +
      'empty is written from the posting.',
  },
  {
    value: 'full',
    label: 'Fully tailor',
    description:
      'Sends only each role\'s company, title and dates, and writes the whole experience and the summary for ' +
      'the posting, with plausible figures. Read it before you send it.',
  },
];

/** A stored or sent mode this page knows, else null - "follow the default". */
export function normalizeTailorMode(value: unknown): TailorMode | null {
  return value === 'partial' || value === 'full' ? value : null;
}

/** Both layouts, in the order the editor and the template viewers offer them. Every template prints both. */
export const ALL_SKILLS_LAYOUTS: readonly TechnicalSkillsLayout[] = ['categorized', 'flat'];

/** The server's own limits on soft skills (profileService.ts), so the form refuses what it would drop. */
export const MAX_SOFT_SKILLS = 50;
export const MAX_SOFT_SKILL_LENGTH = 100;
/** The interests have the same limits (config/profileSections.ts). */
export const MAX_INTERESTS = 50;
export const MAX_INTEREST_LENGTH = 100;

/** What a tailored resume prints of a role's bullets at most, and what Write with AI hands back at most. */
export const MAX_TAILORED_BULLETS = 8;

/** How the order refers to a custom section (the catalogue's `CUSTOM_REF_PREFIX`, which this module cannot import at runtime). */
const CUSTOM_REF_PREFIX = 'custom:';

let rowSequence = 0;

/** A key for a new list row. Unique for the page's lifetime, which is all a React key needs. */
export function newRowKey(): string {
  rowSequence += 1;
  return `row-${rowSequence}`;
}

export function normalizeTechnicalSkillsLayout(value: unknown): TechnicalSkillsLayout {
  return value === 'flat' ? 'flat' : 'categorized';
}

/** The model choice as stored: `modelId` when it is a non-empty string, nothing otherwise. */
function readModelChoice(value: unknown): AiPreferences {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const modelId = typeof source.modelId === 'string' ? source.modelId.trim() : '';
  return modelId ? { modelId } : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function draftSettingsFrom(profile?: Pick<Profile, 'profileSettings'> | null): DraftSettings {
  const stored = profile?.profileSettings ?? {};
  return {
    resumePromptId: stored.resumePromptId || DEFAULT_PROFILE_SETTINGS.resumePromptId,
    resumeFileNameTemplate: stored.resumeFileNameTemplate || DEFAULT_PROFILE_SETTINGS.resumeFileNameTemplate,
    coverLetterFileNameTemplate:
      stored.coverLetterFileNameTemplate || DEFAULT_PROFILE_SETTINGS.coverLetterFileNameTemplate,
    technicalSkillsLayout: normalizeTechnicalSkillsLayout(stored.technicalSkillsLayout),
    // Only `true` is on: absent, and anything that is not a boolean, read as
    // off on the server too.
    includeSoftSkills: stored.includeSoftSkills === true,
    includeStrengths: stored.includeStrengths === true,
    tailorMode: normalizeTailorMode(stored.tailorMode),
    ai: readModelChoice(stored.ai),
  };
}

/** The profile's grouping, as a lookup from skill to heading. */
export function readSkillCategoryMap(groups?: SkillCategoryGroup[] | null): Record<string, string> {
  const map: Record<string, string> = {};
  for (const group of groups ?? []) {
    const category = group?.category?.trim();
    if (!category) continue;
    for (const skill of group.skills ?? []) {
      if (skill && !map[skill]) map[skill] = category;
    }
  }
  return map;
}

/**
 * Turns the per-skill headings back into groups, in the library's own order.
 *
 * A heading the profile no longer has any skill under is dropped rather than
 * stored empty, and a skill with no heading is simply absent - the renderer
 * infers one for it. Both keep the stored shape the same as an imported file
 * would produce, so a profile edited here and one uploaded as JSON are
 * indistinguishable afterwards. `knownOrder` is the library's heading list
 * (HARD_SKILL_CATEGORIES); headings somebody typed themselves follow it.
 */
export function buildSkillCategories(
  skills: readonly string[],
  categoryBySkill: Record<string, string>,
  knownOrder: readonly string[]
): SkillCategoryGroup[] {
  const order: string[] = [];
  const grouped = new Map<string, string[]>();
  for (const skill of skills) {
    const category = categoryBySkill[skill]?.trim();
    if (!category) continue;
    if (!grouped.has(category)) {
      grouped.set(category, []);
      order.push(category);
    }
    grouped.get(category)!.push(skill);
  }
  const known = knownOrder.filter((category) => grouped.has(category));
  const extra = order.filter((category) => !knownOrder.includes(category));
  return [...known, ...extra].map((category) => ({ category, skills: grouped.get(category) ?? [] }));
}

export function achievementsFromText(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** A stored entry with `achievements`, as a row with the text box the editor types them into. */
function withAchievementsText<T extends { achievements?: unknown }>(item: T): Omit<T, 'achievements'> & { key: string; achievementsText: string } {
  const { achievements, ...rest } = item;
  return { ...rest, achievementsText: stringList(achievements).join('\n'), key: newRowKey() };
}

/** A stored profile - or none, for a new one - as the editor's draft. */
export function draftFromProfile(profile?: Profile | null): ProfileDraft {
  const contact = (profile?.contact ?? {}) as Partial<DraftContact>;
  const skills = stringList(profile?.skills);
  const storedOrder = stringList(profile?.sectionOrder);
  return {
    name: text(profile?.name),
    title: text(profile?.title),
    totalYearsExperience:
      typeof profile?.totalYearsExperience === 'number' ? String(profile.totalYearsExperience) : '',
    preferredTemplate: text(profile?.preferredTemplate),
    settings: draftSettingsFrom(profile),
    contact: {
      phone: text(contact.phone),
      email: text(contact.email),
      linkedin: text(contact.linkedin),
      github: text(contact.github),
      portfolio: text(contact.portfolio),
      location: text(contact.location),
    },
    summary: text(profile?.summary),
    experience: (profile?.experience ?? []).map((item) => ({
      ...withAchievementsText(item),
      title: text(item.title),
      company: text(item.company),
      startDate: text(item.startDate),
      endDate: text(item.endDate),
      location: text(item.location),
      description: text(item.description),
      skills: stringList(item.skills),
    })),
    // Spread, so what the editor does not show - a GPA, an expiry date - is
    // sent back as it came rather than dropped by the next save.
    education: (profile?.education ?? []).map((item) => ({ ...item, key: newRowKey() })),
    certifications: (profile?.certifications ?? []).map((item) => ({ ...item, key: newRowKey() })),
    skills,
    skillCategoryBySkill: readSkillCategoryMap(profile?.skillCategories),
    softSkills: stringList(profile?.softSkills),
    strengths: (profile?.strengths ?? []).map((item) => ({ ...item, key: newRowKey() })),
    projects: (profile?.projects ?? []).map(withAchievementsText),
    languages: (profile?.languages ?? []).map((item) => ({ ...item, key: newRowKey() })),
    awards: (profile?.awards ?? []).map((item) => ({ ...item, key: newRowKey() })),
    publications: (profile?.publications ?? []).map((item) => ({ ...item, key: newRowKey() })),
    volunteering: (profile?.volunteering ?? []).map(withAchievementsText),
    courses: (profile?.courses ?? []).map((item) => ({ ...item, key: newRowKey() })),
    interests: stringList(profile?.interests),
    references: (profile?.references ?? []).map((item) => ({ ...item, key: newRowKey() })),
    customSections: (profile?.customSections ?? []).map((section) => ({
      key: text(section.key),
      title: text(section.title),
      entries: (section.entries ?? []).map(withAchievementsText),
    })),
    // Null unless the profile stores an order: an older profile, and every
    // one whose person never arranged the cards, follows its template.
    sectionOrder: storedOrder.length > 0 ? storedOrder : null,
  };
}

/**
 * A new profile's draft on the template and layout the chooser started it
 * with ('' for no template: `default` draws it until one is chosen). Nothing
 * else differs from an empty profile's, so it reads as "Nothing entered yet"
 * and saves exactly what is typed, on that template.
 */
export function draftForNewProfile(start: { templateId: string; layout: TechnicalSkillsLayout }): ProfileDraft {
  const draft = draftFromProfile(null);
  return {
    ...draft,
    preferredTemplate: start.templateId,
    settings: { ...draft.settings, technicalSkillsLayout: normalizeTechnicalSkillsLayout(start.layout) },
  };
}

// ------------------------------------------------------------ new rows

export function emptyExperience(): DraftExperience {
  return {
    key: newRowKey(),
    title: '',
    company: '',
    startDate: '',
    endDate: '',
    location: '',
    description: '',
    achievementsText: '',
    skills: [],
  };
}

export function emptyEducation(): DraftEducation {
  return { key: newRowKey(), degree: '', institution: '', startDate: '', endDate: '', location: '' };
}

export function emptyCertification(): DraftCertification {
  return { key: newRowKey(), name: '', issuer: '', date: '' };
}

export function emptyStrength(): DraftStrength {
  return { key: newRowKey(), title: '', description: '' };
}

export function emptyProject(): DraftProject {
  return { key: newRowKey(), name: '', role: '', startDate: '', endDate: '', link: '', description: '', achievementsText: '' };
}

export function emptyLanguage(): DraftLanguage {
  return { key: newRowKey(), language: '', proficiency: '' };
}

export function emptyAward(): DraftAward {
  return { key: newRowKey(), title: '', issuer: '', date: '', description: '' };
}

export function emptyPublication(): DraftPublication {
  return { key: newRowKey(), title: '', publisher: '', date: '', link: '', description: '' };
}

export function emptyVolunteering(): DraftVolunteering {
  return {
    key: newRowKey(),
    role: '',
    organization: '',
    startDate: '',
    endDate: '',
    location: '',
    description: '',
    achievementsText: '',
  };
}

export function emptyCourse(): DraftCourse {
  return { key: newRowKey(), name: '', institution: '', date: '' };
}

export function emptyReference(): DraftReference {
  return { key: newRowKey(), name: '', title: '', company: '', email: '', phone: '' };
}

export function emptyCustomEntry(): DraftCustomEntry {
  return {
    key: newRowKey(),
    heading: '',
    subheading: '',
    startDate: '',
    endDate: '',
    location: '',
    description: '',
    achievementsText: '',
  };
}

export function emptyCustomSection(key: string, title: string): DraftCustomSection {
  return { key, title, entries: [] };
}

/** The kinds whose card is rows of entries opened in the Edit Entry panel. */
export type EntryKind =
  | 'experience'
  | 'education'
  | 'certifications'
  | 'strengths'
  | 'projects'
  | 'volunteering'
  | 'awards'
  | 'publications'
  | 'courses'
  | 'languages'
  | 'references';

export type DraftEntry =
  | DraftExperience
  | DraftEducation
  | DraftCertification
  | DraftStrength
  | DraftProject
  | DraftVolunteering
  | DraftAward
  | DraftPublication
  | DraftCourse
  | DraftLanguage
  | DraftReference
  | DraftCustomEntry;

const EMPTY_ENTRY: Record<EntryKind | 'custom', () => DraftEntry> = {
  experience: emptyExperience,
  education: emptyEducation,
  certifications: emptyCertification,
  strengths: emptyStrength,
  projects: emptyProject,
  volunteering: emptyVolunteering,
  awards: emptyAward,
  publications: emptyPublication,
  courses: emptyCourse,
  languages: emptyLanguage,
  references: emptyReference,
  custom: emptyCustomEntry,
};

/** A new, empty row of the kind - what "+ Add <entry>" opens. */
export function emptyEntry(kind: EntryKind | 'custom'): DraftEntry {
  return EMPTY_ENTRY[kind]();
}

/**
 * Whether nothing has been typed into a row: every text blank, every list
 * empty, its key aside. Such a row is not saved - a row opened and left blank
 * would otherwise be stored as a line of empty strings - and a panel closed
 * on one drops it.
 */
export function isBlankEntry(row: object): boolean {
  for (const [field, value] of Object.entries(row as Record<string, unknown>)) {
    if (field === 'key') continue;
    if (typeof value === 'string') {
      if (value.trim()) return false;
    } else if (Array.isArray(value)) {
      if (value.length > 0) return false;
    } else if (value !== undefined && value !== null) {
      return false;
    }
  }
  return true;
}

// ------------------------------------------------- finding and changing rows

/** One section's rows: a kind's list, or a custom section's by its stored key. */
export type EntryListRef = { kind: EntryKind } | { kind: 'custom'; sectionKey: string };
/** One row: its list, and its own key. */
export type EntryRef = EntryListRef & { key: string };

export function entriesOf(draft: ProfileDraft, ref: EntryListRef): DraftEntry[] {
  if (ref.kind === 'custom') {
    return draft.customSections.find((section) => section.key === ref.sectionKey)?.entries ?? [];
  }
  return draft[ref.kind];
}

function withEntries(draft: ProfileDraft, ref: EntryListRef, entries: DraftEntry[]): ProfileDraft {
  if (ref.kind === 'custom') {
    return {
      ...draft,
      customSections: draft.customSections.map((section) =>
        section.key === ref.sectionKey ? { ...section, entries: entries as DraftCustomEntry[] } : section
      ),
    };
  }
  return { ...draft, [ref.kind]: entries } as ProfileDraft;
}

export function findEntry(draft: ProfileDraft, ref: EntryRef): DraftEntry | null {
  return entriesOf(draft, ref).find((row) => row.key === ref.key) ?? null;
}

/** The draft with one row changed. `patch` is the row's own fields; its key is never changed. */
export function replaceEntry(draft: ProfileDraft, ref: EntryRef, patch: object): ProfileDraft {
  return withEntries(
    draft,
    ref,
    entriesOf(draft, ref).map((row) => (row.key === ref.key ? ({ ...row, ...patch, key: row.key } as DraftEntry) : row))
  );
}

export function removeEntry(draft: ProfileDraft, ref: EntryRef): ProfileDraft {
  return withEntries(
    draft,
    ref,
    entriesOf(draft, ref).filter((row) => row.key !== ref.key)
  );
}

/** The draft with a row added at the end of its list. */
export function appendEntry(draft: ProfileDraft, ref: EntryListRef, entry: DraftEntry): ProfileDraft {
  return withEntries(draft, ref, [...entriesOf(draft, ref), entry]);
}

/** Replaces one row of a keyed list. */
export function replaceRow<T extends { key: string }>(rows: readonly T[], key: string, patch: Partial<T>): T[] {
  return rows.map((row) => (row.key === key ? { ...row, ...patch } : row));
}

/** Drops one row of a keyed list. */
export function removeRow<T extends { key: string }>(rows: readonly T[], key: string): T[] {
  return rows.filter((row) => row.key !== key);
}

// ------------------------------------------------------------ sections

function customKeyOf(ref: string): string | null {
  return ref.startsWith(CUSTOM_REF_PREFIX) ? ref.slice(CUSTOM_REF_PREFIX.length) : null;
}

/**
 * How much a section holds, for its card's count and the Remove section
 * confirm: the summary is one thing or nothing, the skills and the chip lists
 * count their names, every other section its rows.
 */
export function entryCount(draft: ProfileDraft, ref: string): number {
  const customKey = customKeyOf(ref);
  if (customKey !== null) return draft.customSections.find((section) => section.key === customKey)?.entries.length ?? 0;
  switch (ref) {
    case 'summary':
      return draft.summary.trim() ? 1 : 0;
    case 'skills':
      return draft.skills.length;
    case 'softSkills':
      return draft.softSkills.length;
    case 'interests':
      return draft.interests.length;
    default: {
      const list = (draft as unknown as Record<string, unknown>)[ref];
      return Array.isArray(list) ? list.length : 0;
    }
  }
}

/**
 * The draft with a section added at the end of `order` - the cards as shown,
 * which becomes the stored order (a null order is converted by this first
 * touch). A kind already in the order moves to the end rather than appearing
 * twice.
 */
export function addSectionKind(draft: ProfileDraft, kind: string, order: readonly string[]): ProfileDraft {
  return { ...draft, sectionOrder: [...order.filter((ref) => ref !== kind), kind] };
}

/** The draft with a new, empty custom section under `title`, last in the order. */
export function addCustomSection(draft: ProfileDraft, key: string, title: string, order: readonly string[]): ProfileDraft {
  const ref = `${CUSTOM_REF_PREFIX}${key}`;
  return {
    ...draft,
    customSections: [...draft.customSections.filter((section) => section.key !== key), emptyCustomSection(key, title)],
    sectionOrder: [...order.filter((item) => item !== ref), ref],
  };
}

/**
 * The draft with a section gone: its ref out of the order (`order` is the
 * cards as shown, stored from here on), and its content with it - a custom
 * section is deleted, a kind's list emptied. The default kinds are never
 * offered this, but a kind's content goes the same way if they were.
 */
export function removeSection(draft: ProfileDraft, ref: string, order: readonly string[]): ProfileDraft {
  const sectionOrder = order.filter((item) => item !== ref);
  const customKey = customKeyOf(ref);
  if (customKey !== null) {
    return { ...draft, sectionOrder, customSections: draft.customSections.filter((section) => section.key !== customKey) };
  }
  switch (ref) {
    case 'summary':
      return { ...draft, sectionOrder, summary: '' };
    case 'skills':
      return { ...draft, sectionOrder, skills: [], skillCategoryBySkill: {} };
    case 'softSkills':
      return { ...draft, sectionOrder, softSkills: [] };
    case 'interests':
      return { ...draft, sectionOrder, interests: [] };
    default:
      return Array.isArray((draft as unknown as Record<string, unknown>)[ref])
        ? ({ ...draft, sectionOrder, [ref]: [] } as ProfileDraft)
        : { ...draft, sectionOrder };
  }
}

/**
 * Whether the template prints a section: the server's `printsSections`, by
 * kind id, or `custom` for a custom section.
 */
export function templatePrintsSection(template: Pick<Template, 'printsSections'>, ref: string): boolean {
  return template.printsSections.includes(customKeyOf(ref) !== null ? 'custom' : ref);
}

// ------------------------------------------------------------ the payload

function withoutKey<T extends { key: string }>(row: T): Omit<T, 'key'> {
  const { key: _key, ...rest } = row;
  void _key;
  return rest;
}

/** A list's rows worth saving, keys off. */
function savedRows<T extends { key: string }>(rows: readonly T[]): Omit<T, 'key'>[] {
  return rows.filter((row) => !isBlankEntry(row)).map(withoutKey);
}

/** The same for a bullet kind: `achievementsText` back into the list the server stores. */
function savedBulletRows<T extends { key: string; achievementsText: string }>(
  rows: readonly T[]
): Array<Omit<T, 'key' | 'achievementsText'> & { achievements: string[] }> {
  return rows
    .filter((row) => !isBlankEntry(row))
    .map((row) => {
      const { key: _key, achievementsText, ...rest } = row;
      void _key;
      return { ...rest, achievements: achievementsFromText(achievementsText) };
    });
}

function parseYears(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * The content every request carries: what the profile says, whatever is done
 * with it. EVERY list is named, empty or not, because an omitted list keeps
 * what is stored and a row somebody deleted must go; a row with nothing typed
 * into it is not sent at all. The order goes as `[]` when the cards follow
 * the template, which clears a stored one.
 */
function draftContent(draft: ProfileDraft, knownOrder: readonly string[]): CreateProfileDTO {
  return {
    name: draft.name,
    title: draft.title,
    totalYearsExperience: parseYears(draft.totalYearsExperience),
    // Empty is sent as absent, which keeps whatever is stored - the server's
    // rule for every omitted field, and what the old form did too.
    preferredTemplate: draft.preferredTemplate || undefined,
    contact: { ...draft.contact },
    summary: draft.summary,
    experience: savedBulletRows(draft.experience),
    strengths: savedRows(draft.strengths),
    skills: [...draft.skills],
    // Sent whether or not the layout is grouped. The grouping is storage and
    // the layout is rendering, so switching to Plain and back must not lose
    // the headings somebody took the trouble to assign.
    skillCategories: buildSkillCategories(draft.skills, draft.skillCategoryBySkill, knownOrder),
    softSkills: [...draft.softSkills],
    education: savedRows(draft.education),
    certifications: savedRows(draft.certifications),
    projects: savedBulletRows(draft.projects),
    languages: savedRows(draft.languages),
    awards: savedRows(draft.awards),
    publications: savedRows(draft.publications),
    volunteering: savedBulletRows(draft.volunteering),
    courses: savedRows(draft.courses),
    interests: [...draft.interests],
    references: savedRows(draft.references),
    // A section survives on its title alone: an added, empty card keeps its name.
    customSections: draft.customSections.map(
      (section): CustomSection => ({ key: section.key, title: section.title, entries: savedBulletRows(section.entries) })
    ),
    sectionOrder: draft.sectionOrder ?? [],
  };
}

/**
 * What a save sends.
 *
 * Every setting is named, the two section switches included: an omitted one
 * would keep what is stored, and a box somebody just unticked must save as
 * unticked. `ai` is decided by the caller (`savableModelChoice`), because it
 * needs the model list the page loaded.
 */
export function draftToPayload(
  draft: ProfileDraft,
  ai: AiPreferences,
  knownOrder: readonly string[]
): CreateProfileDTO {
  const settings = draft.settings;
  return {
    ...draftContent(draft, knownOrder),
    profileSettings: {
      resumePromptId: settings.resumePromptId || DEFAULT_PROFILE_SETTINGS.resumePromptId,
      resumeFileNameTemplate:
        settings.resumeFileNameTemplate.trim() || DEFAULT_PROFILE_SETTINGS.resumeFileNameTemplate,
      coverLetterFileNameTemplate:
        settings.coverLetterFileNameTemplate.trim() || DEFAULT_PROFILE_SETTINGS.coverLetterFileNameTemplate,
      technicalSkillsLayout: normalizeTechnicalSkillsLayout(settings.technicalSkillsLayout),
      includeSoftSkills: settings.includeSoftSkills === true,
      includeStrengths: settings.includeStrengths === true,
      // Named every time, like the switches: null is "use the default", which
      // clears a stored choice - an omitted one would keep it.
      tailorMode: normalizeTailorMode(settings.tailorMode),
      ai,
    },
  };
}

/**
 * What the live preview is sent: the content, and only the settings that
 * change how the page looks.
 *
 * The server would ignore the rest anyway (file names and the model never
 * reach a template), and leaving them out keeps them out of the preview's key -
 * so typing a file name does not redraw the resume once per keystroke.
 */
export function draftToPreviewProfile(draft: ProfileDraft, knownOrder: readonly string[]): CreateProfileDTO {
  const settings = draft.settings;
  return {
    ...draftContent(draft, knownOrder),
    profileSettings: {
      technicalSkillsLayout: normalizeTechnicalSkillsLayout(settings.technicalSkillsLayout),
      includeSoftSkills: settings.includeSoftSkills === true,
      includeStrengths: settings.includeStrengths === true,
    },
  };
}

// ------------------------------------------------------------- skills

/** Trimmed, inner whitespace collapsed - the server's own reading of a skill name. */
export function cleanSkillName(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function hasSkill(list: readonly string[], skill: string): boolean {
  const wanted = skill.toLowerCase();
  return list.some((entry) => entry.toLowerCase() === wanted);
}

/**
 * Why a name cannot join a short list, or null when it can.
 *
 * The server drops a duplicate (by case), a 101st character and a 51st entry
 * without a word, so the form says so before the chip appears rather than
 * after a save quietly loses it. The soft skills' rule, shared with the
 * interests.
 */
function shortListRefusal(
  list: readonly string[],
  value: string,
  noun: { one: string; many: string },
  max: number,
  maxLength: number
): string | null {
  const name = cleanSkillName(value);
  if (!name) return null;
  if (hasSkill(list, name)) return `${name} is already on the list.`;
  if (name.length > maxLength) return `${noun.one.charAt(0).toUpperCase()}${noun.one.slice(1)} can be at most ${maxLength} characters.`;
  if (list.length >= max) return `A profile can list at most ${max} ${noun.many}.`;
  return null;
}

/** Why a soft skill cannot be added, or null when it can. */
export function softSkillRefusal(list: readonly string[], value: string): string | null {
  return shortListRefusal(list, value, { one: 'a soft skill', many: 'soft skills' }, MAX_SOFT_SKILLS, MAX_SOFT_SKILL_LENGTH);
}

/** Why an interest cannot be added, or null when it can. */
export function interestRefusal(list: readonly string[], value: string): string | null {
  return shortListRefusal(list, value, { one: 'an interest', many: 'interests' }, MAX_INTERESTS, MAX_INTEREST_LENGTH);
}

// ------------------------------------------------- sections switched off

/** The two sections a profile can switch off, by the draft field that holds each. */
export type SwitchedSection = 'softSkills' | 'strengths';

/**
 * How many entries a section holds while its box is unticked: every soft
 * skill, and every strength with anything typed in it (an empty card is not
 * something kept).
 */
export function keptCount(draft: Pick<ProfileDraft, SwitchedSection>, section: SwitchedSection): number {
  if (section === 'softSkills') return draft.softSkills.length;
  return draft.strengths.filter((row) => row.title.trim() || row.description.trim()).length;
}

/**
 * The line an unticked Soft Skills or Strengths box shows in place of its
 * list, or null when it keeps nothing.
 *
 * Unticking hides the list and keeps it: nothing is deleted, the entries are
 * still saved with the profile, and ticking the box brings them back to print
 * and edit. The line is what says they are still there.
 */
export function keptNote(count: number, section: SwitchedSection): string | null {
  if (count <= 0) return null;
  const noun =
    section === 'softSkills' ? (count === 1 ? 'soft skill' : 'soft skills') : count === 1 ? 'strength' : 'strengths';
  return `${count} ${noun} kept with the profile. Tick the box to print and edit ${count === 1 ? 'it' : 'them'}.`;
}

// --------------------------------------------------------- Write with AI

/** Write when the entry has no bullets yet, Improve once it has. */
export function bulletsTask(achievementsText: string): WriteBulletsTask {
  return achievementsFromText(achievementsText).length > 0 ? 'improve' : 'write';
}

/**
 * Why the button is off, or null: the route's `entry-incomplete` rule, in its
 * own words (services/entryBullets.ts `readEntryForBullets`) - the model
 * would have nothing to write from, and the sentence says what to type.
 */
export function bulletsBlocker(kind: WriteBulletsKind, row: object): string | null {
  const has = (field: string) => {
    const value = (row as Record<string, unknown>)[field];
    return typeof value === 'string' && value.trim() !== '';
  };
  switch (kind) {
    case 'experience':
      return has('title') || has('company') ? null : 'Give the role a title or a company before asking for bullets.';
    case 'project':
      return has('name') ? null : 'Give the project a name before asking for bullets.';
    case 'volunteering':
      return has('role') || has('organization')
        ? null
        : 'Give the volunteering entry a role or an organisation before asking for bullets.';
  }
}

/**
 * The request for one entry: the fields that name it, by kind - title and
 * company, name and role, role and organisation - its dates, location,
 * description, bullets and skills; five facts about the person, never their
 * contact details; the task; and the note when there is one.
 */
export function bulletsRequestFor(
  kind: WriteBulletsKind,
  row: object,
  draft: Pick<ProfileDraft, 'name' | 'title' | 'totalYearsExperience' | 'summary' | 'skills'>,
  task: WriteBulletsTask,
  instructions: string
): WriteBulletsRequest {
  const source = row as Record<string, unknown>;
  const field = (name: string) => (typeof source[name] === 'string' ? (source[name] as string).trim() : '');
  const named: Record<string, string> =
    kind === 'experience'
      ? { title: field('title'), company: field('company') }
      : kind === 'project'
        ? { name: field('name'), role: field('role') }
        : { role: field('role'), organization: field('organization') };
  const years = parseYears(draft.totalYearsExperience);
  const note = instructions.replace(/\s+/g, ' ').trim();
  return {
    kind,
    entry: {
      ...named,
      startDate: field('startDate'),
      endDate: field('endDate'),
      location: field('location'),
      description: field('description'),
      achievements: achievementsFromText(field('achievementsText')),
      skills: stringList(source.skills),
    },
    profile: {
      name: draft.name.trim(),
      title: draft.title.trim(),
      ...(years !== undefined ? { totalYearsExperience: years } : {}),
      summary: draft.summary.trim(),
      skills: [...draft.skills],
    },
    task,
    ...(note ? { instructions: note } : {}),
  };
}

/** The answer's bullets as lines for the box: strings only, trimmed, at most eight. */
export function readBullets(answer: unknown): string[] {
  const list = answer && typeof answer === 'object' ? (answer as { bullets?: unknown }).bullets : undefined;
  return stringList(list)
    .map((bullet) => bullet.trim())
    .filter(Boolean)
    .slice(0, MAX_TAILORED_BULLETS);
}

/**
 * The line under the bullets box: how many there are, and that a tailored
 * resume prints at most eight of them (the parse keeps the eight carrying the
 * most of the posting's terms). Null with none.
 */
export function bulletCountNote(achievementsText: string): string | null {
  const count = achievementsFromText(achievementsText).length;
  if (count === 0) return null;
  const noun = count === 1 ? 'bullet' : 'bullets';
  if (count <= MAX_TAILORED_BULLETS) {
    return `${count} ${noun}. A tailored resume prints at most ${MAX_TAILORED_BULLETS}, chosen for the job; an untailored one prints them all.`;
  }
  return `${count} ${noun}. A tailored resume prints at most ${MAX_TAILORED_BULLETS} of them - the ones carrying the most of the posting's terms - so the rest serve it as notes.`;
}

// ------------------------------------------------- the preview's sample text

/**
 * What the preview's sample resume says in each field the server may fill.
 *
 * The live preview draws an empty field with the sample person's text (the
 * gallery's sample, `withSampleDefaults` on the server), in the preview only,
 * so a half-filled profile still shows the template's whole shape. The form
 * shows the same text as each input's placeholder, so a blank input and the
 * sample in the page beside it are visibly the same thing. A copy, because a
 * placeholder is drawn before any request; backend/test/frontendEditorHelpers
 * .test.js fails when it drifts from the server's sample.
 */
export const SAMPLE_PLACEHOLDERS = {
  name: 'Jordan Avery Chen',
  title: 'Senior Software Engineer',
  email: 'jordan.chen@example.com',
  phone: '+1 (555) 123-4567',
  location: 'San Francisco, CA',
  linkedin: 'linkedin.com/in/jordanchen',
  summary:
    'Senior engineer with nine years building and operating payment and data platforms at scale. ' +
    'Leads backend architecture for services handling 40M requests a day...',
  experienceTitle: 'Senior Software Engineer',
  experienceCompany: 'Northwind Payments',
  educationDegree: 'M.S. Computer Science',
  educationInstitution: 'University of Washington',
} as const;

/**
 * The server's keys for what it filled from the sample (`sampled` in the
 * preview's answer), in the order the form asks for them, with the words the
 * notice uses.
 */
export const SAMPLED_FIELD_WORDS: ReadonlyArray<readonly [string, string]> = [
  ['name', 'name'],
  ['title', 'title'],
  ['email', 'email'],
  ['phone', 'phone'],
  ['location', 'location'],
  ['linkedin', 'LinkedIn'],
  ['summary', 'summary'],
  ['experience', 'experience'],
  ['education', 'education'],
  ['skills', 'skills'],
  ['softSkills', 'soft skills'],
  ['strengths', 'strengths'],
];

/**
 * "Sample text shown for: name, phone, experience." - or null when the page
 * is all the profile's own.
 *
 * A key this build has no word for is still named (camelCase spelled out)
 * rather than dropped: the notice exists so nobody mistakes sample text for
 * their own, and a newer server filling one more field must not make it
 * quietly incomplete.
 */
export function sampledNotice(sampled: readonly string[] | null | undefined): string | null {
  if (!Array.isArray(sampled)) return null;
  const keys = sampled.filter((key): key is string => typeof key === 'string' && key.trim() !== '');
  if (keys.length === 0) return null;
  const known = SAMPLED_FIELD_WORDS.filter(([key]) => keys.includes(key)).map(([, words]) => words);
  const unknown = keys
    .filter((key, index) => !SAMPLED_FIELD_WORDS.some(([known]) => known === key) && keys.indexOf(key) === index)
    .map((key) => key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
  return `Sample text shown for: ${[...known, ...unknown].join(', ')}.`;
}

// ------------------------------------------------------------- templates

/** The template a draft renders with: its own, else the one every resume falls back to. */
export function effectiveTemplateId(draft: { preferredTemplate?: string }): string {
  return draft.preferredTemplate || FALLBACK_TEMPLATE_ID;
}

/**
 * The template a profile's next resume is drawn with, decided the way the
 * server's `resolveTemplateForProfile` decides it: the profile's own choice
 * (else `default`) when that is offered, else `default`, else the first
 * template offered - the server's list is newest first, as it picks.
 *
 * For the Profiles list, which names the template under each profile.
 * `stored` is the profile's own choice, null when it is not offered any more
 * (disabled or deleted), and only then is `drawn` another template. Every
 * template prints both Technical Skills layouts, so the layout plays no part.
 */
export function drawnTemplate(
  templates: readonly Template[],
  profile: Pick<Profile, 'preferredTemplate'>
): { stored: Template | null; drawn: Template | null } {
  const stored = templates.find((template) => template.id === effectiveTemplateId(profile)) ?? null;
  const fallback = templates.find((template) => template.id === FALLBACK_TEMPLATE_ID) ?? null;
  return { stored, drawn: stored ?? fallback ?? templates[0] ?? null };
}

/**
 * Which template each of the account's OTHER profiles uses, by template id.
 *
 * The UI's one-template-per-profile rule. Only an explicit choice counts: a
 * profile with none renders with `default` but has not claimed it, as before.
 */
export function templatesUsedByOthers(
  profiles: ReadonlyArray<Pick<Profile, 'id' | 'name' | 'preferredTemplate'>>,
  currentProfileId?: string
): Record<string, string> {
  const used: Record<string, string> = {};
  for (const profile of profiles) {
    if (profile.id === currentProfileId || !profile.preferredTemplate) continue;
    if (!used[profile.preferredTemplate]) used[profile.preferredTemplate] = profile.name || 'another profile';
  }
  return used;
}

export interface TemplateOption {
  template: Template;
  /** The other profile that already uses it, when that is why it cannot be picked. */
  usedBy?: string;
  selectable: boolean;
}

/**
 * The picker's list: every template offered, each marked pickable or not -
 * every template prints both Technical Skills layouts, so the layout filters
 * nothing.
 *
 * A template another profile uses is listed disabled with that profile's name
 * rather than hidden, so the list never looks short without a reason. The
 * profile's own templates - the one stored and the one in the draft - are
 * always pickable, whoever else uses them.
 */
export function templateOptions(
  templates: readonly Template[],
  context: { usedByOthers: Record<string, string>; ownTemplateIds: readonly string[] }
): TemplateOption[] {
  return templates.map((template) => {
    const own = context.ownTemplateIds.includes(template.id);
    const usedBy = own ? undefined : context.usedByOthers[template.id];
    return { template, usedBy, selectable: !usedBy };
  });
}
