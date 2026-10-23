/**
 * THE catalogue of a resume's sections, and the one place the section order's
 * semantics live.
 *
 * A resume is drawn from fifteen kinds of section - the six classic
 * ones every template has always had (summary, strengths, skills, soft skills,
 * experience, education) and nine more a resume commonly carries
 * (certifications, projects, volunteering, awards, publications, courses,
 * languages, interests, references) - plus any number of custom sections the
 * person titles themselves. Every section can be dragged into an order the
 * resume stores (`Resume.sectionOrder`), and every template honours it
 * within the column it puts each section in.
 *
 * No imports, no runtime dependency on anything: the frontend keeps a copy of
 * this module (frontend/src/lib/sectionCatalogue.ts) and
 * test/frontendEditorHelpers.test.js runs both over the same inputs, so a
 * change here must be made there too, and the test says so.
 *
 * The ids double as the resume FIELD each kind reads (`skills` also reads
 * `skillCategories`), so `resume[kind]` is the list and a template's
 * `printsSections` needs no mapping. A custom section is referred to as
 * `custom:<key>`, the key being `customSections[].key`.
 */

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

export interface SectionKindDefinition {
  id: SectionKind;
  /** The heading the generated blocks and the DOCX print; the editor's card label. */
  heading: string;
  /** The Resume field the section reads. */
  field: SectionKind;
  shape: SectionShape;
  /** Whether its entries carry achievement bullets (what Write with AI writes). */
  hasBullets: boolean;
  /** One of the six every template has its own markup for. */
  isClassic: boolean;
}

/**
 * Canonical order. The classic six stand in the order the DOCX has always
 * printed them, so a resume with no stored order gets today's DOCX byte for
 * byte; the PDF never applies this order on its own - without a stored order
 * every template prints its sections where its own markup puts them.
 */
export const SECTION_KINDS: readonly SectionKindDefinition[] = [
  { id: 'summary', heading: 'Professional Summary', field: 'summary', shape: 'text', hasBullets: false, isClassic: true },
  { id: 'strengths', heading: 'Key Strengths', field: 'strengths', shape: 'entries', hasBullets: false, isClassic: true },
  { id: 'skills', heading: 'Technical Skills', field: 'skills', shape: 'inline', hasBullets: false, isClassic: true },
  { id: 'softSkills', heading: 'Soft Skills', field: 'softSkills', shape: 'inline', hasBullets: false, isClassic: true },
  { id: 'experience', heading: 'Professional Experience', field: 'experience', shape: 'entries', hasBullets: true, isClassic: true },
  { id: 'education', heading: 'Education', field: 'education', shape: 'entries', hasBullets: false, isClassic: true },
  { id: 'certifications', heading: 'Certifications', field: 'certifications', shape: 'entries', hasBullets: false, isClassic: false },
  { id: 'projects', heading: 'Projects', field: 'projects', shape: 'entries', hasBullets: true, isClassic: false },
  { id: 'volunteering', heading: 'Volunteering', field: 'volunteering', shape: 'entries', hasBullets: true, isClassic: false },
  { id: 'awards', heading: 'Awards', field: 'awards', shape: 'entries', hasBullets: false, isClassic: false },
  { id: 'publications', heading: 'Publications', field: 'publications', shape: 'entries', hasBullets: false, isClassic: false },
  { id: 'courses', heading: 'Courses', field: 'courses', shape: 'entries', hasBullets: false, isClassic: false },
  { id: 'languages', heading: 'Languages', field: 'languages', shape: 'inline', hasBullets: false, isClassic: false },
  { id: 'interests', heading: 'Interests', field: 'interests', shape: 'inline', hasBullets: false, isClassic: false },
  { id: 'references', heading: 'References', field: 'references', shape: 'entries', hasBullets: false, isClassic: false },
];

export const SECTION_KIND_IDS: readonly SectionKind[] = SECTION_KINDS.map((kind) => kind.id);

/** The six every template has markup for, canonical order. */
export const CLASSIC_SECTION_KINDS: readonly ClassicSectionKind[] = SECTION_KINDS.filter((kind) => kind.isClassic).map(
  (kind) => kind.id as ClassicSectionKind
);

/** The nine a template prints through the extra-sections macro, canonical order. */
export const EXTRA_SECTION_KINDS: readonly ExtraSectionKind[] = SECTION_KINDS.filter((kind) => !kind.isClassic).map(
  (kind) => kind.id as ExtraSectionKind
);

/**
 * The cards every resume shows, with no Remove: the classic six and
 * Certifications. The editor always showed a Certifications section, and the
 * owner's reference design has one; it still prints only when it has entries.
 */
export const DEFAULT_SECTION_KINDS: readonly SectionKind[] = [...CLASSIC_SECTION_KINDS, 'certifications'];

export const CUSTOM_REF_PREFIX = 'custom:';
/** A custom section's key: client-generated, safe in a class name, an attribute and a Handlebars string literal. */
export const CUSTOM_KEY_PATTERN = /^[a-z0-9-]{1,40}$/;

/** Caps on what a resume stores, in the style of MAX_RESUME_SOFT_SKILLS. */
export const MAX_RESUME_CUSTOM_SECTIONS = 10;
/** Per list - projects, awards, ..., and each custom section's entries. */
export const MAX_RESUME_SECTION_ENTRIES = 50;
export const MAX_RESUME_INTERESTS = 50;
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

export function sectionKindDefinition(kind: SectionKind): SectionKindDefinition {
  return SECTION_KINDS[SECTION_KIND_IDS.indexOf(kind)];
}

/**
 * What `presenceOf` reads: a Resume, a frontend draft, or render data - any
 * object carrying the section fields by name. Structural so that this module
 * imports nothing.
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
 * has an entry. Shape only - the normaliser decides what an entry is.
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
 * after every listed one in the template's own order. So a kind added later,
 * or a stale list, never hides a section and never scrambles the rest.
 */
export function sectionSortKey(ref: string, stored: readonly string[], nativeIndex: number): number {
  const listed = stored.indexOf(ref);
  return listed >= 0 ? listed : stored.length + nativeIndex;
}

/**
 * The order a resume's sections are shown in the editor and printed by the
 * DOCX, complete.
 *
 * With nothing stored, the template's own order (`native`, the template's
 * `nativeSectionOrder`, or the canonical list where there is no template)
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
