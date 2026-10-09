/**
 * The profile editor's draft, and every decision about it that needs no React:
 * what a stored profile looks like as a form, what the form saves, what the
 * live preview is sent, and which templates the picker may offer.
 *
 * Kept apart from the components for the reason lib/profileModel.ts is: it can
 * be tested without a browser (backend/test/frontendHelpers.test.js transpiles
 * it and refuses any runtime import). Type imports are erased, so they are
 * fine; the one runtime value it would want from lib/api.ts - the library's
 * heading order - is a parameter instead.
 */

import type {
  AiPreferences,
  Certification,
  CreateProfileDTO,
  Education,
  Experience,
  HardSkillOrdering,
  Profile,
  ProfileSettings,
  SkillCategoryGroup,
  Strength,
  TechnicalSkillsLayout,
  Template,
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
}

/** The template every resume falls back to, as the builder and the server name it. */
export const FALLBACK_TEMPLATE_ID = 'default';

export const DEFAULT_PROFILE_SETTINGS: DraftSettings = {
  resumePromptId: 'tailor-resume',
  coverLetterPromptId: 'generate-cover-letter',
  resumeFileNameTemplate: '{{profile name}}',
  coverLetterFileNameTemplate: '{{profile name}}_cover_letter',
  companyFolderNameTemplate: '{{row number}}_{{company name}}',
  hardSkillOrdering: 'library',
  technicalSkillsLayout: 'categorized',
  // Off, which is what every resume printed before the switches existed - so a
  // profile nobody has touched comes out exactly as it did.
  includeSoftSkills: false,
  includeStrengths: false,
  // Empty means every field inherits the app default, which is what a profile
  // that has never chosen should do.
  ai: {},
};

/** The words the editor uses for the two layouts. The stored values stay as they were. */
export const LAYOUT_LABELS: Record<TechnicalSkillsLayout, string> = {
  flat: 'Plain',
  categorized: 'Grouped',
};

/** Both layouts, in the order the server keeps a template's list in. */
export const ALL_SKILLS_LAYOUTS: readonly TechnicalSkillsLayout[] = ['categorized', 'flat'];

/** The server's own limits on soft skills (profileService.ts), so the form refuses what it would drop. */
export const MAX_SOFT_SKILLS = 50;
export const MAX_SOFT_SKILL_LENGTH = 100;

let rowSequence = 0;

/** A key for a new list row. Unique for the page's lifetime, which is all a React key needs. */
export function newRowKey(): string {
  rowSequence += 1;
  return `row-${rowSequence}`;
}

export function normalizeTechnicalSkillsLayout(value: unknown): TechnicalSkillsLayout {
  return value === 'flat' ? 'flat' : 'categorized';
}

export function normalizeHardSkillOrdering(value: unknown): HardSkillOrdering {
  return value === 'job-priority' ? 'job-priority' : 'library';
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

export function draftSettingsFrom(profile?: Pick<Profile, 'profileSettings'> | null): DraftSettings {
  const stored = profile?.profileSettings ?? {};
  return {
    resumePromptId: stored.resumePromptId || DEFAULT_PROFILE_SETTINGS.resumePromptId,
    coverLetterPromptId: stored.coverLetterPromptId || DEFAULT_PROFILE_SETTINGS.coverLetterPromptId,
    resumeFileNameTemplate: stored.resumeFileNameTemplate || DEFAULT_PROFILE_SETTINGS.resumeFileNameTemplate,
    coverLetterFileNameTemplate:
      stored.coverLetterFileNameTemplate || DEFAULT_PROFILE_SETTINGS.coverLetterFileNameTemplate,
    companyFolderNameTemplate:
      stored.companyFolderNameTemplate || DEFAULT_PROFILE_SETTINGS.companyFolderNameTemplate,
    hardSkillOrdering: normalizeHardSkillOrdering(stored.hardSkillOrdering),
    technicalSkillsLayout: normalizeTechnicalSkillsLayout(stored.technicalSkillsLayout),
    // Only `true` is on: absent, and anything that is not a boolean, read as
    // off on the server too.
    includeSoftSkills: stored.includeSoftSkills === true,
    includeStrengths: stored.includeStrengths === true,
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

/** A stored profile - or none, for a new one - as the editor's draft. */
export function draftFromProfile(profile?: Profile | null): ProfileDraft {
  const contact = (profile?.contact ?? {}) as Partial<DraftContact>;
  const skills = Array.isArray(profile?.skills) ? profile.skills.filter((skill) => typeof skill === 'string') : [];
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
    experience: (profile?.experience ?? []).map((item) => {
      const { achievements, ...rest } = item;
      return {
        ...rest,
        title: text(item.title),
        company: text(item.company),
        startDate: text(item.startDate),
        endDate: text(item.endDate),
        location: text(item.location),
        description: text(item.description),
        skills: Array.isArray(item.skills) ? item.skills : [],
        achievementsText: Array.isArray(achievements) ? achievements.join('\n') : '',
        key: newRowKey(),
      };
    }),
    // Spread, so what the editor does not show - a GPA, an expiry date - is
    // sent back as it came rather than dropped by the next save.
    education: (profile?.education ?? []).map((item) => ({ ...item, key: newRowKey() })),
    certifications: (profile?.certifications ?? []).map((item) => ({ ...item, key: newRowKey() })),
    skills,
    skillCategoryBySkill: readSkillCategoryMap(profile?.skillCategories),
    softSkills: Array.isArray(profile?.softSkills) ? profile.softSkills : [],
    strengths: (profile?.strengths ?? []).map((item) => ({ ...item, key: newRowKey() })),
  };
}

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

function withoutKey<T extends { key: string }>(row: T): Omit<T, 'key'> {
  const { key: _key, ...rest } = row;
  void _key;
  return rest;
}

function parseYears(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** The content every request carries: what the profile says, whatever is done with it. */
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
    experience: draft.experience.map((row) => {
      const { key: _key, achievementsText, ...rest } = row;
      void _key;
      return { ...rest, skills: rest.skills ?? [], achievements: achievementsFromText(achievementsText) };
    }),
    strengths: draft.strengths.map(withoutKey),
    skills: [...draft.skills],
    // Sent whether or not the layout is grouped. The grouping is storage and
    // the layout is rendering, so switching to Plain and back must not lose
    // the headings somebody took the trouble to assign.
    skillCategories: buildSkillCategories(draft.skills, draft.skillCategoryBySkill, knownOrder),
    softSkills: [...draft.softSkills],
    education: draft.education.map(withoutKey),
    certifications: draft.certifications.map(withoutKey),
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
      coverLetterPromptId: settings.coverLetterPromptId || DEFAULT_PROFILE_SETTINGS.coverLetterPromptId,
      resumeFileNameTemplate:
        settings.resumeFileNameTemplate.trim() || DEFAULT_PROFILE_SETTINGS.resumeFileNameTemplate,
      coverLetterFileNameTemplate:
        settings.coverLetterFileNameTemplate.trim() || DEFAULT_PROFILE_SETTINGS.coverLetterFileNameTemplate,
      companyFolderNameTemplate:
        settings.companyFolderNameTemplate.trim() || DEFAULT_PROFILE_SETTINGS.companyFolderNameTemplate,
      hardSkillOrdering: normalizeHardSkillOrdering(settings.hardSkillOrdering),
      technicalSkillsLayout: normalizeTechnicalSkillsLayout(settings.technicalSkillsLayout),
      includeSoftSkills: settings.includeSoftSkills === true,
      includeStrengths: settings.includeStrengths === true,
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
      hardSkillOrdering: normalizeHardSkillOrdering(settings.hardSkillOrdering),
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
 * Why a soft skill cannot be added, or null when it can.
 *
 * The server drops a duplicate (by case), a 101st character and a 51st entry
 * without a word, so the form says so before the chip appears rather than
 * after a save quietly loses it.
 */
export function softSkillRefusal(list: readonly string[], value: string): string | null {
  const skill = cleanSkillName(value);
  if (!skill) return null;
  if (hasSkill(list, skill)) return `${skill} is already on the list.`;
  if (skill.length > MAX_SOFT_SKILL_LENGTH) {
    return `A soft skill can be at most ${MAX_SOFT_SKILL_LENGTH} characters.`;
  }
  if (list.length >= MAX_SOFT_SKILLS) return `A profile can list at most ${MAX_SOFT_SKILLS} soft skills.`;
  return null;
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

/** The layouts a template is offered for, as the server lists them, in the order the editor names them. */
export function templateSkillsLayouts(template: Pick<Template, 'skillsLayouts'>): TechnicalSkillsLayout[] {
  return ALL_SKILLS_LAYOUTS.filter((layout) => template.skillsLayouts.includes(layout));
}

export function templateOffersLayout(
  template: Pick<Template, 'skillsLayouts'>,
  layout: TechnicalSkillsLayout
): boolean {
  return template.skillsLayouts.includes(layout);
}

/**
 * Whether a template's markup prints certifications. The same probe the
 * server uses to list a template's sections; none of the built-ins does.
 */
export function templateShowsCertifications(template: Pick<Template, 'htmlContent'>): boolean {
  return /\{\{[#\w\s]*certifications\b/.test(template.htmlContent || '');
}

/** The template a draft renders with: its own, else the one every resume falls back to. */
export function effectiveTemplateId(draft: { preferredTemplate?: string }): string {
  return draft.preferredTemplate || FALLBACK_TEMPLATE_ID;
}

/**
 * The template a profile's next resume is drawn with, decided the way the
 * server's `resolveTemplateForProfile` decides it: the profile's own choice
 * (else `default`) when that is offered and prints the profile's layout, else
 * `default` when that does, else the first offered template that does, else
 * the choice as it is.
 *
 * For the Profiles list, which names the template under each profile. Naming
 * the STORED one was wrong exactly when it mattered: a Plain profile on a
 * template an administrator has since made Grouped-only, or a save that paired
 * them, is drawn with another one, and the editor said so while the list did
 * not. `stored` is the profile's own choice, null when it is not offered.
 */
export function drawnTemplate(
  templates: readonly Template[],
  profile: Pick<Profile, 'preferredTemplate' | 'profileSettings'>
): { stored: Template | null; drawn: Template | null; layout: TechnicalSkillsLayout } {
  const layout = normalizeTechnicalSkillsLayout(profile.profileSettings?.technicalSkillsLayout);
  const stored = templates.find((template) => template.id === effectiveTemplateId(profile)) ?? null;
  const fallback = templates.find((template) => template.id === FALLBACK_TEMPLATE_ID) ?? null;
  const candidates = [stored, fallback].filter((template): template is Template => template !== null);
  const drawn =
    candidates.find((template) => templateOffersLayout(template, layout)) ??
    templates.find((template) => templateOffersLayout(template, layout)) ??
    candidates[0] ??
    null;
  return { stored, drawn, layout };
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
 * The picker's list for one layout: only the templates that offer it, each
 * marked pickable or not.
 *
 * A template another profile uses is listed disabled with that profile's name
 * rather than hidden, so a filtered list never looks empty without a reason.
 * The profile's own templates - the one stored and the one in the draft - are
 * always pickable, whoever else uses them.
 */
export function templateOptions(
  templates: readonly Template[],
  layout: TechnicalSkillsLayout,
  context: { usedByOthers: Record<string, string>; ownTemplateIds: readonly string[] }
): TemplateOption[] {
  return templates
    .filter((template) => templateOffersLayout(template, layout))
    .map((template) => {
      const own = context.ownTemplateIds.includes(template.id);
      const usedBy = own ? undefined : context.usedByOthers[template.id];
      return { template, usedBy, selectable: !usedBy };
    });
}

/**
 * The template to switch to when the layout changes under one that does not
 * offer it: the first of `preferIds` that can be picked (the profile's stored
 * template, so switching away and back returns to it), else `default`, else
 * the first that can. Null when nothing can - the server then falls back on its
 * own, and the editor says so.
 */
export function templateForLayout(
  options: readonly TemplateOption[],
  preferIds: ReadonlyArray<string | undefined> = []
): string | null {
  const selectable = options.filter((option) => option.selectable);
  for (const id of [...preferIds, FALLBACK_TEMPLATE_ID]) {
    if (id && selectable.some((option) => option.template.id === id)) return id;
  }
  return selectable[0]?.template.id ?? null;
}
