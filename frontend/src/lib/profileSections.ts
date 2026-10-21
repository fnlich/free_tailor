/**
 * The resume's section catalogue, as the editor knows it.
 *
 * Two halves. The first is a COPY of the server's catalogue
 * (backend/src/config/profileSections.ts): the fifteen kinds in canonical
 * order with their shared fields - id, heading, field, shape, hasBullets,
 * isClassic - and the section order's semantics: `presenceOf`,
 * `cleanSectionOrder`, `sectionSortKey` and `effectiveSectionOrder`, which
 * decide what the editor shows in which order, exactly as the server decides
 * what the DOCX prints. backend/test/frontendEditorHelpers.test.js runs both
 * copies over the same inputs, so a change on either side fails until it is
 * made on both. The second half is the editor's own: each kind's icon, card
 * label and copy, its Edit Entry fields, how a row of it is summarised, and
 * which kinds Write with AI serves.
 *
 * Imports nothing at runtime (types only), so the test can load it the way
 * it loads lib/profileDraft.ts - transpiled, with every `require` refused.
 */

import type { IconName } from '@/components/icons';
import type { WriteBulletsKind } from './api';

export type ClassicSectionKind = 'summary' | 'strengths' | 'skills' | 'softSkills' | 'experience' | 'education';
export type ExtraSectionKind =
  | 'certifications'
  | 'projects'
  | 'volunteering'
  | 'awards'
  | 'publications'
  | 'courses'
  | 'languages'
  | 'interests'
  | 'references';
export type SectionKind = ClassicSectionKind | ExtraSectionKind;

/** How a kind's content is shaped: a paragraph, a list of entries, or one inline line. */
export type SectionShape = 'text' | 'entries' | 'inline';

/** Which editor a section's card holds: the summary box, the two skills lists, a chip list, or rows of entries. */
export type SectionEditor = 'summary' | 'skills' | 'softSkills' | 'chips' | 'entries';

/** One box of the Edit Entry panel. */
export interface FieldSpec {
  /** The entry's field. */
  name: string;
  label: string;
  placeholder?: string;
  /**
   * `textarea` is a multi-line box. `url`, `email` and `tel` only pick the
   * keyboard: the browser's own url check is never used, because it refuses
   * `github.com/x` - how most people write a link, and how imported profiles
   * hold one - and would block the whole save. The server keeps the text as
   * typed and prints only http(s) links.
   */
  input?: 'text' | 'textarea' | 'url' | 'email' | 'tel';
  /** Spans both columns of the panel's grid. */
  wide?: boolean;
}

/** An entry of any kind, read by field name; the draft's rows and the API's entries both qualify. */
export type EntryLike = object;

/** The editor's half of a section's definition - shared by the fifteen kinds and the custom sections. */
export interface SectionSpec {
  shape: SectionShape;
  /** Whether its entries carry achievement bullets (what Write with AI writes). */
  hasBullets: boolean;
  icon: IconName;
  /** The card's label, in the editor's own casing ("Soft skills"); the printed heading is `heading`. */
  label: string;
  /** What one row is called: "+ Add <entryNoun>", "Edit <entryNoun>". */
  entryNoun: string;
  /** One line on the Add content tile. */
  blurb: string;
  /** The line under the card's label; '' for a card that needs none. */
  description: string;
  editor: SectionEditor;
  /** The Edit Entry panel's boxes, in order; [] for a kind with no entries. */
  fields: readonly FieldSpec[];
  /** A row's first line, from the entry; '' when nothing names it yet. */
  rowTitle: (entry: EntryLike) => string;
  /** A row's second line - dates, an organisation; '' for none. */
  rowMeta: (entry: EntryLike) => string;
  /** The kind the Write with AI route is sent, for the three kinds it serves. */
  aiKind?: WriteBulletsKind;
}

export interface SectionKindDefinition extends SectionSpec {
  id: SectionKind;
  /** The heading the generated blocks and the DOCX print. */
  heading: string;
  /** The Profile field the section reads. */
  field: SectionKind;
  /** One of the six every template has its own markup for. */
  isClassic: boolean;
}

const text = (entry: EntryLike, key: string): string => {
  const value = (entry as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
};

/** "01/2023 - 06/2023", "2021 - Present", or one end alone; '' with neither. */
export function dateRange(startDate: unknown, endDate: unknown): string {
  return [startDate, endDate]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .join(' - ');
}

const joined = (...parts: string[]): string => parts.filter(Boolean).join(' · ');
const atOrganisation = (role: string, organisation: string): string =>
  role && organisation ? `${role} at ${organisation}` : role || organisation;

const DATES: readonly FieldSpec[] = [
  { name: 'startDate', label: 'Start date', placeholder: 'MM/YYYY' },
  { name: 'endDate', label: 'End date', placeholder: 'MM/YYYY or Present' },
];
const LOCATION: FieldSpec = { name: 'location', label: 'Location', placeholder: 'City, country or Remote', wide: true };
const DESCRIPTION = (placeholder: string): FieldSpec => ({
  name: 'description',
  label: 'Description',
  placeholder,
  input: 'textarea',
  wide: true,
});

/** The sentence every kind printed as written gets: tailoring reads only the classic sections and the certifications. */
const PRINTED_AS_WRITTEN = 'Printed when it has an entry, as you write it here. Tailoring does not read this section.';

/**
 * Canonical order - the server's. The classic six stand in the order the DOCX
 * has always printed them, so a profile with no stored order gets the same
 * DOCX it always got; the PDF never applies this order on its own - without a
 * stored order every template prints its sections where its own markup puts
 * them, and the editor shows the cards in that order (`nativeSectionOrder`).
 */
export const SECTION_KINDS: readonly SectionKindDefinition[] = [
  {
    id: 'summary',
    heading: 'Professional Summary',
    field: 'summary',
    shape: 'text',
    hasBullets: false,
    isClassic: true,
    icon: 'text',
    label: 'Summary',
    entryNoun: 'summary',
    blurb: '',
    description:
      'Partial tailor rewrites it for each job, starting here; Fully tailor writes a new one from your roles and the job.',
    editor: 'summary',
    fields: [],
    rowTitle: () => '',
    rowMeta: () => '',
  },
  {
    id: 'strengths',
    heading: 'Key Strengths',
    field: 'strengths',
    shape: 'entries',
    hasBullets: false,
    isClassic: true,
    icon: 'shield',
    label: 'Strengths',
    entryNoun: 'strength',
    blurb: '',
    description: '',
    editor: 'entries',
    fields: [
      { name: 'title', label: 'Title', placeholder: 'e.g. Customer-centric', wide: true },
      DESCRIPTION('One or two sentences, with a number if there is one'),
    ],
    rowTitle: (entry) => text(entry, 'title'),
    rowMeta: (entry) => text(entry, 'description'),
  },
  {
    id: 'skills',
    heading: 'Technical Skills',
    field: 'skills',
    shape: 'inline',
    hasBullets: false,
    isClassic: true,
    icon: 'wrench',
    label: 'Technical skills',
    entryNoun: 'skill',
    blurb: '',
    description:
      'The skills the profile claims, in your order - what an untailored resume prints. A tailored resume prints the skill groups written for each job, from these and the posting.',
    editor: 'skills',
    fields: [],
    rowTitle: () => '',
    rowMeta: () => '',
  },
  {
    id: 'softSkills',
    heading: 'Soft Skills',
    field: 'softSkills',
    shape: 'inline',
    hasBullets: false,
    isClassic: true,
    icon: 'groups',
    label: 'Soft skills',
    entryNoun: 'soft skill',
    blurb: '',
    description: '',
    editor: 'softSkills',
    fields: [],
    rowTitle: () => '',
    rowMeta: () => '',
  },
  {
    id: 'experience',
    heading: 'Professional Experience',
    field: 'experience',
    shape: 'entries',
    hasBullets: true,
    isClassic: true,
    icon: 'briefcase',
    label: 'Experience',
    entryNoun: 'experience',
    blurb: '',
    // The parse gives every tailored role an empty description and the render
    // blanks it again; backend/test/frontendTailoring.test.js holds this
    // sentence to that.
    description:
      "A role, company and dates are enough to start: tailoring writes each role's bullets for the job - Partial tailor from the description and achievements you give it (a role left empty from the job), Fully tailor from the company, title and dates alone. A tailored resume prints no role description; yours shows only in this editor's preview.",
    editor: 'entries',
    fields: [
      { name: 'title', label: 'Job title', placeholder: 'e.g. Senior Software Engineer' },
      { name: 'company', label: 'Company', placeholder: 'e.g. Northwind Payments' },
      ...DATES,
      LOCATION,
      DESCRIPTION('Brief description of the role'),
    ],
    rowTitle: (entry) => atOrganisation(text(entry, 'title'), text(entry, 'company')),
    rowMeta: (entry) => joined(dateRange(text(entry, 'startDate'), text(entry, 'endDate')), text(entry, 'location')),
    aiKind: 'experience',
  },
  {
    id: 'education',
    heading: 'Education',
    field: 'education',
    shape: 'entries',
    hasBullets: false,
    isClassic: true,
    icon: 'graduation',
    label: 'Education',
    entryNoun: 'education',
    blurb: '',
    description: '',
    editor: 'entries',
    fields: [
      { name: 'degree', label: 'Degree', placeholder: 'e.g. M.S. Computer Science' },
      { name: 'institution', label: 'Institution', placeholder: 'e.g. University of Washington' },
      ...DATES,
      LOCATION,
    ],
    rowTitle: (entry) => text(entry, 'degree') || text(entry, 'institution'),
    rowMeta: (entry) =>
      joined(
        text(entry, 'degree') ? text(entry, 'institution') : '',
        dateRange(text(entry, 'startDate'), text(entry, 'endDate'))
      ),
  },
  {
    id: 'certifications',
    heading: 'Certifications',
    field: 'certifications',
    shape: 'entries',
    hasBullets: false,
    isClassic: false,
    icon: 'certificate',
    label: 'Certifications',
    entryNoun: 'certification',
    blurb: 'Certificates and licences, with who issued them and when.',
    description: 'Printed when you add one. Tailoring reads them too.',
    editor: 'entries',
    fields: [
      { name: 'name', label: 'Certification', placeholder: 'e.g. AWS Certified Solutions Architect', wide: true },
      { name: 'issuer', label: 'Issuer', placeholder: 'e.g. Amazon Web Services' },
      { name: 'date', label: 'Date', placeholder: 'MM/YYYY' },
    ],
    rowTitle: (entry) => text(entry, 'name'),
    rowMeta: (entry) => joined(text(entry, 'issuer'), text(entry, 'date')),
  },
  {
    id: 'projects',
    heading: 'Projects',
    field: 'projects',
    shape: 'entries',
    hasBullets: true,
    isClassic: false,
    icon: 'folder',
    label: 'Projects',
    entryNoun: 'project',
    blurb: 'Side projects, open source, a portfolio piece - each with its own bullets.',
    description: PRINTED_AS_WRITTEN,
    editor: 'entries',
    fields: [
      { name: 'name', label: 'Project name', placeholder: 'e.g. Lakehouse' },
      { name: 'role', label: 'Your role', placeholder: 'e.g. Lead developer' },
      ...DATES,
      { name: 'link', label: 'Link', placeholder: 'github.com/you/project', input: 'url', wide: true },
      DESCRIPTION('What it is and what it does'),
    ],
    rowTitle: (entry) => text(entry, 'name'),
    rowMeta: (entry) => joined(text(entry, 'role'), dateRange(text(entry, 'startDate'), text(entry, 'endDate'))),
    aiKind: 'project',
  },
  {
    id: 'volunteering',
    heading: 'Volunteering',
    field: 'volunteering',
    shape: 'entries',
    hasBullets: true,
    isClassic: false,
    icon: 'heart',
    label: 'Volunteering',
    entryNoun: 'volunteering role',
    blurb: 'Unpaid roles, with their own bullets.',
    description: PRINTED_AS_WRITTEN,
    editor: 'entries',
    fields: [
      { name: 'role', label: 'Role', placeholder: 'e.g. Mentor' },
      { name: 'organization', label: 'Organisation', placeholder: 'e.g. Code Club' },
      ...DATES,
      LOCATION,
      DESCRIPTION('Brief description of the work'),
    ],
    rowTitle: (entry) => atOrganisation(text(entry, 'role'), text(entry, 'organization')),
    rowMeta: (entry) => joined(dateRange(text(entry, 'startDate'), text(entry, 'endDate')), text(entry, 'location')),
    aiKind: 'volunteering',
  },
  {
    id: 'awards',
    heading: 'Awards',
    field: 'awards',
    shape: 'entries',
    hasBullets: false,
    isClassic: false,
    icon: 'trophy',
    label: 'Awards',
    entryNoun: 'award',
    blurb: 'Prizes and recognitions, with who gave them and when.',
    description: PRINTED_AS_WRITTEN,
    editor: 'entries',
    fields: [
      { name: 'title', label: 'Award', placeholder: 'e.g. Best Paper', wide: true },
      { name: 'issuer', label: 'Given by', placeholder: 'e.g. ACM' },
      { name: 'date', label: 'Date', placeholder: 'MM/YYYY' },
      DESCRIPTION('What it was for, in a sentence'),
    ],
    rowTitle: (entry) => text(entry, 'title'),
    rowMeta: (entry) => joined(text(entry, 'issuer'), text(entry, 'date')),
  },
  {
    id: 'publications',
    heading: 'Publications',
    field: 'publications',
    shape: 'entries',
    hasBullets: false,
    isClassic: false,
    icon: 'bookOpen',
    label: 'Publications',
    entryNoun: 'publication',
    blurb: 'Papers, articles and talks, each with a link.',
    description: PRINTED_AS_WRITTEN,
    editor: 'entries',
    fields: [
      { name: 'title', label: 'Title', placeholder: 'e.g. On Lakes', wide: true },
      { name: 'publisher', label: 'Published in', placeholder: 'e.g. VLDB' },
      { name: 'date', label: 'Date', placeholder: 'MM/YYYY' },
      { name: 'link', label: 'Link', placeholder: 'doi.org/...', input: 'url', wide: true },
      DESCRIPTION('What it says, in a sentence'),
    ],
    rowTitle: (entry) => text(entry, 'title'),
    rowMeta: (entry) => joined(text(entry, 'publisher'), text(entry, 'date')),
  },
  {
    id: 'courses',
    heading: 'Courses',
    field: 'courses',
    shape: 'entries',
    hasBullets: false,
    isClassic: false,
    icon: 'book',
    label: 'Courses',
    entryNoun: 'course',
    blurb: 'Courses and training, with the institution and date.',
    description: PRINTED_AS_WRITTEN,
    editor: 'entries',
    fields: [
      { name: 'name', label: 'Course', placeholder: 'e.g. Machine Learning', wide: true },
      { name: 'institution', label: 'Institution', placeholder: 'e.g. Coursera' },
      { name: 'date', label: 'Date', placeholder: 'MM/YYYY' },
    ],
    rowTitle: (entry) => text(entry, 'name'),
    rowMeta: (entry) => joined(text(entry, 'institution'), text(entry, 'date')),
  },
  {
    id: 'languages',
    heading: 'Languages',
    field: 'languages',
    shape: 'inline',
    hasBullets: false,
    isClassic: false,
    icon: 'language',
    label: 'Languages',
    entryNoun: 'language',
    blurb: 'Languages spoken, and how well.',
    description: PRINTED_AS_WRITTEN,
    editor: 'entries',
    fields: [
      { name: 'language', label: 'Language', placeholder: 'e.g. French' },
      { name: 'proficiency', label: 'Proficiency', placeholder: 'e.g. Fluent, Native, B2' },
    ],
    rowTitle: (entry) => text(entry, 'language'),
    rowMeta: (entry) => text(entry, 'proficiency'),
  },
  {
    id: 'interests',
    heading: 'Interests',
    field: 'interests',
    shape: 'inline',
    hasBullets: false,
    isClassic: false,
    icon: 'star',
    label: 'Interests',
    entryNoun: 'interest',
    blurb: 'A short list of interests, printed on one line.',
    description: PRINTED_AS_WRITTEN,
    editor: 'chips',
    fields: [],
    rowTitle: () => '',
    rowMeta: () => '',
  },
  {
    id: 'references',
    heading: 'References',
    field: 'references',
    shape: 'entries',
    hasBullets: false,
    isClassic: false,
    icon: 'accounts',
    label: 'References',
    entryNoun: 'reference',
    blurb: 'People who will vouch for you, and how to reach them.',
    description: PRINTED_AS_WRITTEN,
    editor: 'entries',
    fields: [
      { name: 'name', label: 'Name', placeholder: 'e.g. Ann Lee', wide: true },
      { name: 'title', label: 'Their title', placeholder: 'e.g. CTO' },
      { name: 'company', label: 'Company', placeholder: 'e.g. Acme' },
      { name: 'email', label: 'Email', placeholder: 'ann@example.com', input: 'email' },
      { name: 'phone', label: 'Phone', placeholder: '+1 (555) 123-4567', input: 'tel' },
    ],
    rowTitle: (entry) => text(entry, 'name'),
    rowMeta: (entry) => joined(text(entry, 'title'), text(entry, 'company')),
  },
];

export const SECTION_KIND_IDS: readonly SectionKind[] = SECTION_KINDS.map((kind) => kind.id);

export const SECTION_KIND_BY_ID: Readonly<Record<SectionKind, SectionKindDefinition>> = Object.fromEntries(
  SECTION_KINDS.map((kind) => [kind.id, kind])
) as Record<SectionKind, SectionKindDefinition>;

/** The six every template has markup for, canonical order. */
export const CLASSIC_SECTION_KINDS: readonly ClassicSectionKind[] = SECTION_KINDS.filter((kind) => kind.isClassic).map(
  (kind) => kind.id as ClassicSectionKind
);

/** The nine a template prints through the extra-sections macro, canonical order. */
export const EXTRA_SECTION_KINDS: readonly ExtraSectionKind[] = SECTION_KINDS.filter((kind) => !kind.isClassic).map(
  (kind) => kind.id as ExtraSectionKind
);

/**
 * The cards every profile shows, with no Remove section: the classic six and
 * Certifications. The editor always showed a Certifications section, and the
 * owner's reference design has one; it still prints only when it has entries.
 */
export const DEFAULT_SECTION_KINDS: readonly SectionKind[] = [...CLASSIC_SECTION_KINDS, 'certifications'];

/** A section of the person's own: titled by them, its entries shaped like a role's. */
export const CUSTOM_SECTION_SPEC: SectionSpec = {
  shape: 'entries',
  hasBullets: true,
  icon: 'list',
  label: 'Custom section',
  entryNoun: 'entry',
  blurb: "A section of your own, under a title you give it, with entries like a role's.",
  description: 'Printed under its title when it has an entry. Tailoring does not read it.',
  editor: 'entries',
  fields: [
    { name: 'heading', label: 'Heading', placeholder: 'e.g. US Patent 1234567' },
    { name: 'subheading', label: 'Subheading', placeholder: 'e.g. Co-inventor' },
    ...DATES,
    LOCATION,
    DESCRIPTION('A sentence or two'),
  ],
  rowTitle: (entry) => text(entry, 'heading'),
  rowMeta: (entry) => joined(text(entry, 'subheading'), dateRange(text(entry, 'startDate'), text(entry, 'endDate'))),
};

export const CUSTOM_REF_PREFIX = 'custom:';
/** A custom section's key: safe in a class name, an attribute and a Handlebars string literal. */
export const CUSTOM_KEY_PATTERN = /^[a-z0-9-]{1,40}$/;

/** The server's caps (config/profileSections.ts), so the editor refuses what it would drop. */
export const MAX_PROFILE_CUSTOM_SECTIONS = 10;
export const MAX_PROFILE_SECTION_ENTRIES = 50;
export const MAX_PROFILE_INTERESTS = 50;
export const MAX_INTEREST_LENGTH = 100;

export type SectionRef = { kind: SectionKind; key?: undefined } | { kind: 'custom'; key: string };

const KIND_SET: ReadonlySet<string> = new Set<string>(SECTION_KIND_IDS);

export function isSectionKind(value: unknown): value is SectionKind {
  return typeof value === 'string' && KIND_SET.has(value);
}

export function isCustomSectionKey(value: unknown): value is string {
  return typeof value === 'string' && CUSTOM_KEY_PATTERN.test(value);
}

export function customSectionRef(key: string): string {
  return `${CUSTOM_REF_PREFIX}${key}`;
}

/** A kind id, or `custom:<key>` with a well-formed key; anything else is null. No trimming, no case folding. */
export function parseSectionRef(value: unknown): SectionRef | null {
  if (typeof value !== 'string') return null;
  if (isSectionKind(value)) return { kind: value };
  if (value.startsWith(CUSTOM_REF_PREFIX)) {
    const key = value.slice(CUSTOM_REF_PREFIX.length);
    return isCustomSectionKey(key) ? { kind: 'custom', key } : null;
  }
  return null;
}

export function sectionRefId(ref: SectionRef): string {
  return ref.kind === 'custom' ? customSectionRef(ref.key) : ref.kind;
}

/** The editor's definition of a section: its kind's, or the one every custom section shares. */
export function sectionSpecOf(ref: SectionRef): SectionSpec {
  return ref.kind === 'custom' ? CUSTOM_SECTION_SPEC : SECTION_KIND_BY_ID[ref.kind];
}

/**
 * A key for a new custom section: `cs-` and eight lowercase hex digits, drawn
 * again while `taken` has it. From the browser's random source; `Math.random`
 * stands in where there is none. `fill` is for the test, which cannot wait
 * for two real draws to collide.
 */
export function newCustomSectionKey(
  taken: readonly string[],
  fill: (bytes: Uint8Array, attempt: number) => void = fillRandom
): string {
  const bytes = new Uint8Array(4);
  for (let attempt = 0; ; attempt += 1) {
    fill(bytes, attempt);
    const key = `cs-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    if (!taken.includes(key)) return key;
  }
}

function fillRandom(bytes: Uint8Array): void {
  const source = globalThis.crypto;
  if (source && typeof source.getRandomValues === 'function') {
    source.getRandomValues(bytes);
    return;
  }
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
}

/**
 * What `presenceOf` reads: a Profile, the editor's draft, or render data -
 * any object carrying the section fields by name. The draft qualifies as it
 * is: its lists are named as the profile's are.
 */
export type SectionSource = {
  summary?: unknown;
  skills?: unknown;
  skillCategories?: unknown;
  customSections?: unknown;
} & Partial<Record<Exclude<SectionKind, 'summary' | 'skills'>, unknown>>;

export type SectionPresence = {
  /** The kinds with content, canonical order. */
  kinds: SectionKind[];
  /** Every well-formed `customSections[].key`, in stored order, once each. */
  customKeys: string[];
};

function hasEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * Which kinds have something to print: a summary that is not blank, skills
 * when either the flat list or the grouping has one, every other list when it
 * has an entry. Shape only - the server's normaliser decides what an entry is.
 */
export function presenceOf(source: SectionSource): SectionPresence {
  const kinds: SectionKind[] = [];
  for (const kind of SECTION_KINDS) {
    let present: boolean;
    if (kind.id === 'summary') present = typeof source.summary === 'string' && source.summary.trim().length > 0;
    else if (kind.id === 'skills') present = hasEntries(source.skills) || hasEntries(source.skillCategories);
    else present = hasEntries(source[kind.id]);
    if (present) kinds.push(kind.id);
  }
  const customKeys: string[] = [];
  if (Array.isArray(source.customSections)) {
    for (const section of source.customSections) {
      const key = section && typeof section === 'object' ? (section as { key?: unknown }).key : undefined;
      if (isCustomSectionKey(key) && !customKeys.includes(key)) customKeys.push(key);
    }
  }
  return { kinds, customKeys };
}

/**
 * The save rule's pure core: the valid refs of `value` in their order, once
 * each, a `custom:` ref kept only for a key in `customKeys`. Anything that is
 * not a list reads as nothing. NOTHING is appended here - the stored order is
 * exactly what the person arranged, and completion happens when it is read
 * (`effectiveSectionOrder`) or drawn (`sectionSortKey`).
 */
export function cleanSectionOrder(value: unknown, customKeys: readonly string[]): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const ref = parseSectionRef(item);
    if (!ref) continue;
    if (ref.kind === 'custom' && !customKeys.includes(ref.key)) continue;
    const id = sectionRefId(ref);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The one sort key the PDF's reorder and the DOCX share: a listed section's
 * place in the stored order, and for one the order does not name, a place
 * after every listed one in the template's own order.
 */
export function sectionSortKey(ref: string, stored: readonly string[], nativeIndex: number): number {
  const listed = stored.indexOf(ref);
  return listed >= 0 ? listed : stored.length + nativeIndex;
}

/**
 * The order a profile's sections are shown in the editor and printed by the
 * DOCX, complete.
 *
 * With nothing stored, the template's own order (`native`, the template's
 * `nativeSectionOrder`, or the default kinds where no template has loaded)
 * filtered to the default kinds and the kinds that have content, then any
 * default or present kind the template does not place (canonical order), then
 * the custom sections. With a stored order, that order first - a listed kind
 * with no entries stays, it is an added, empty section - then the unlisted
 * default kinds in the template's order (one the template lacks follows in
 * canonical order), then the unlisted present kinds in that same order, then
 * the unlisted custom sections.
 */
export function effectiveSectionOrder(stored: unknown, native: readonly string[], presence: SectionPresence): string[] {
  const present = new Set<string>(presence.kinds);
  const defaults = new Set<string>(DEFAULT_SECTION_KINDS);
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (ref: string) => {
    if (seen.has(ref)) return;
    seen.add(ref);
    out.push(ref);
  };
  const nativeKinds = native.filter(isSectionKind);
  const storedRefs = cleanSectionOrder(stored, presence.customKeys);

  if (storedRefs.length === 0) {
    for (const id of nativeKinds) if (defaults.has(id) || present.has(id)) push(id);
    for (const id of SECTION_KIND_IDS) if (defaults.has(id) || present.has(id)) push(id);
    for (const key of presence.customKeys) push(customSectionRef(key));
    return out;
  }

  for (const ref of storedRefs) push(ref);
  for (const id of nativeKinds) if (defaults.has(id)) push(id);
  for (const id of DEFAULT_SECTION_KINDS) push(id);
  for (const id of nativeKinds) if (present.has(id)) push(id);
  for (const id of SECTION_KIND_IDS) if (present.has(id)) push(id);
  for (const key of presence.customKeys) push(customSectionRef(key));
  return out;
}

// --------------------------------------------------------- rearranging

/**
 * The order with `ref` moved `delta` places (negative is up), held inside the
 * list: Move up on the first card, or a ref the order does not hold, changes
 * nothing. Always a new array, so a caller can keep or drop it alike.
 */
export function moveSection(order: readonly string[], ref: string, delta: number): string[] {
  const from = order.indexOf(ref);
  if (from < 0) return [...order];
  const to = Math.min(order.length - 1, Math.max(0, from + delta));
  if (to === from) return [...order];
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, ref);
  return next;
}

export type DropEdge = 'before' | 'after';

/**
 * The order with `moved` taken out and put back just before or after
 * `target` - what a drop does. Dropping a card on itself, or a ref the order
 * does not hold on either side, changes nothing.
 */
export function insertRelative(order: readonly string[], moved: string, target: string, edge: DropEdge): string[] {
  if (moved === target || !order.includes(moved) || !order.includes(target)) return [...order];
  const without = order.filter((ref) => ref !== moved);
  const at = without.indexOf(target) + (edge === 'after' ? 1 : 0);
  return [...without.slice(0, at), moved, ...without.slice(at)];
}

// ----------------------------------------------------------- the rows

export type EntrySummary = {
  title: string;
  meta: string;
  /** True when nothing names the entry yet and `title` is the stand-in ("Project 2"). */
  untitled: boolean;
};

/**
 * How a card lists one entry: its own title and a second line, or, for one
 * with nothing typed into the fields that name it, "<Entry noun> <n>" so the
 * row still reads as something to open.
 */
export function entrySummary(
  spec: Pick<SectionSpec, 'entryNoun' | 'rowTitle' | 'rowMeta'>,
  entry: EntryLike,
  index: number
): EntrySummary {
  const title = spec.rowTitle(entry).trim();
  const meta = spec.rowMeta(entry).trim();
  if (title) return { title, meta, untitled: false };
  const noun = spec.entryNoun.charAt(0).toUpperCase() + spec.entryNoun.slice(1);
  return { title: `${noun} ${index + 1}`, meta, untitled: true };
}
