import { createHash } from 'crypto';

import { conceptRowsFor, termPattern } from '../config/conceptTools';
import type { Experience } from '../types/resume';
import type { JobAnalysis, TailoredExperience } from '../types/template';
import { contentHash } from './jobAnalysis/identity';
import { SOFT_SKILL_GROUP_HEADINGS } from './skillGroups';

/**
 * What the tailoring prompt is promised about the code around it, kept in one
 * pure module: the lists it is sent, the draws "made per resume", the title the
 * application composes, the role facts it restores, the eight-bullet cap and
 * the text backstops. resumeService.ts builds the prompt values and reads the
 * answer through these; reviseCoverage.ts measures the draft with the same
 * checklist. No I/O, no settings, no library - so a test can hold each promise
 * on its own.
 *
 * Every function here reads an analysis of EITHER shape: a posting analysed
 * once is analysed for ever (owner decision J0), so the analyses stored before
 * the current analysis prompt - with `skills.required`, `skills.technologies`,
 * a top-level `softSkills`, infinitive action verbs - are what most resumes are
 * still tailored from.
 */

/* =================================================================== terms */

/** Trimmed, inner whitespace collapsed, empties dropped, a case-insensitive repeat kept where it first appears. */
export function uniqueTerms(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const term = value.replace(/\s+/g, ' ').trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Whether `text` carries `term` as a whole word or phrase (config/conceptTools.ts `termPattern`). */
export function containsTerm(text: string, term: string): boolean {
  return termPattern(term)?.test(text) ?? false;
}

/** How many times `text` carries `term`, and where the first one is (-1 for none). */
function occurrences(text: string, term: string): { count: number; first: number } {
  const pattern = termPattern(term, true);
  if (!pattern || !text) return { count: 0, first: -1 };
  let count = 0;
  let first = -1;
  for (const match of text.matchAll(pattern)) {
    if (first === -1) first = match.index ?? 0;
    count += 1;
  }
  return { count, first };
}

/**
 * Whether a sentence of a role's description is about the COMPANY rather than
 * the person ("Acme is a fintech platform built on Kafka."): it opens with the
 * company's name and a verb of being or offering, or names the company within
 * eighty characters of a word that marks a corporate description. Moved here
 * from resumeService.ts, unchanged: the tailoring prompt's `companyContext`
 * and the resume's keywords (services/resumeKeywords.ts) both leave such a
 * sentence out, and both must agree on which ones they are.
 */
export function isCompanyDescriptionLike(value: string, company?: string): boolean {
  const normalized = value.trim().replace(/\s+/g, ' ');
  const companyName = company?.trim();
  if (!normalized || !companyName) return false;

  const escapedCompany = companyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const companyLeadPattern = new RegExp(
    `^(?:category:\\s*)?${escapedCompany}\\b\\s+(?:is|are|was|were|builds|provides|offers|serves|uses|aims|helps|connects|creates|develops|delivers)\\b`,
    'i'
  );
  const marketingContextPattern = new RegExp(
    `\\b${escapedCompany}\\b.{0,80}\\b(?:founded|headquartered|acquired|serves|customers|platform|company|nonprofit|non-profit)\\b`,
    'i'
  );

  return companyLeadPattern.test(normalized) || marketingContextPattern.test(normalized);
}

/* ====================================================== banned vocabulary */

/**
 * The tailoring prompt's banned words ("NEVER use these words, in any form,
 * anywhere in the output") and its banned openers ("NEVER open a sentence
 * with these verbs, and do not use them elsewhere either"). The revise
 * prompt bans them too, with no exception - so a checklist term containing
 * one is never handed to the revise pass as missing, nor counted as missing
 * when deciding whether it runs: it would be an instruction nobody can obey.
 * The tailoring prompt still gets such a term; its own text decides (a soft
 * skill the posting names may be written as given).
 */
export const RESUME_BANNED_WORDS: readonly string[] = [
  'leveraged', 'utilized', 'spearheaded', 'orchestrated', 'streamlined', 'seamless', 'robust', 'scalable',
  'maximized', 'cross-functional', 'end-to-end', 'innovative', 'dynamic', 'cutting-edge', 'world-class',
  'best-in-class', 'state-of-the-art', 'holistic', 'comprehensive', 'extensive', 'proven', 'strategic',
  'mission-critical',
];

export const RESUME_BANNED_OPENERS: readonly string[] = [
  'Designed', 'Architected', 'Led', 'Delivered', 'Drove', 'Integrated', 'Partnered', 'Supported', 'Contributed',
  'Managed', 'Streamlined',
];

const BANNED_PATTERNS = [...RESUME_BANNED_WORDS, ...RESUME_BANNED_OPENERS].map(
  (word) => new RegExp(`(?<![A-Za-z0-9])${word.replace(/[-]/g, '\\-')}(?![A-Za-z0-9])`, 'i')
);

/** Whether a term carries a banned word or a banned opener verb, as a whole word, in any case. */
export function containsBannedVocabulary(term: string): boolean {
  return BANNED_PATTERNS.some((pattern) => pattern.test(term));
}

/**
 * Past-tense verbs that do not end in "-ed": the forms an action verb from
 * the posting must already be in for a bullet to carry it verbatim.
 */
const IRREGULAR_PAST = new Set([
  'built', 'ran', 'cut', 'wrote', 'shipped', 'made', 'set', 'led', 'drove', 'grew', 'took', 'put', 'rebuilt',
  'rewrote', 'broke', 'won', 'sold', 'kept', 'taught', 'brought', 'found', 'began', 'met', 'held', 'read', 'spent',
  'sent', 'upheld',
]);

function isPastTense(verb: string): boolean {
  const first = verb.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return first.endsWith('ed') || IRREGULAR_PAST.has(first);
}

/* ================================================== the posting's lists */

/** The analysis's lists, read from either shape and cleaned the same way. */
export type PostingLists = {
  jobMeta: { title: string; seniority: string; industry: string; department: string };
  technical: string[];
  tools: string[];
  soft: string[];
  technologies: string[];
  protocols: string[];
  methodologies: string[];
  architecturePatterns: string[];
  responsibilities: string[];
  domainKnowledge: string[];
  actionVerbs: string[];
  buzzwords: string[];
  mustInclude: string[];
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readPostingLists(analysis: JobAnalysis): PostingLists {
  const skills = (analysis?.skills ?? {}) as Partial<JobAnalysis['skills']>;
  const keywords = (analysis?.keywords ?? {}) as Partial<JobAnalysis['keywords']>;
  const meta = (analysis?.jobMeta ?? {}) as Partial<JobAnalysis['jobMeta']>;
  return {
    jobMeta: {
      title: text(meta.title),
      seniority: text(meta.seniority),
      industry: text(meta.industry),
      department: text(meta.department),
    },
    // An older analysis wrote the same list as `required` beside `technical`;
    // one older still held its requirements there alone.
    technical: uniqueTerms([...list(skills.technical), ...list(skills.required)]),
    tools: uniqueTerms(list(skills.tools)),
    soft: uniqueTerms([...list(skills.soft), ...list(analysis?.softSkills)]),
    technologies: uniqueTerms([...list(analysis?.technologies), ...list(skills.technologies)]),
    protocols: uniqueTerms(list(analysis?.protocols)),
    methodologies: uniqueTerms(list(analysis?.methodologies)),
    architecturePatterns: uniqueTerms(list(analysis?.architecturePatterns)),
    responsibilities: uniqueTerms(list(analysis?.responsibilities)),
    domainKnowledge: uniqueTerms(list(analysis?.domainKnowledge)),
    actionVerbs: uniqueTerms(list(keywords.actionVerbs)),
    buzzwords: uniqueTerms(list(keywords.buzzwords)),
    mustInclude: uniqueTerms(list(keywords.mustInclude)),
  };
}

/**
 * `[[jobAnalysisJson]]`: the analysis in the analysis prompt's own schema and
 * nothing else. Not the posting's text (`sourceJobDescription`, already read),
 * not its job field, industry, salary or filter facts (a resume has no
 * business saying what a job pays or whether it is remote), and not the
 * duplicate lists an older analysis carries (`skills.required`,
 * `skills.preferred`, `skills.technologies`, a top-level `softSkills`), which
 * sent the same terms twice. And not an action verb the prompt bans as an
 * opener: handed "Architected" as the posting's own verb, the model opened a
 * bullet with it (`[[keywordsJson]]` already leaves them out).
 */
export function analysisForPrompt(lists: PostingLists): Record<string, unknown> {
  return {
    jobMeta: lists.jobMeta,
    skills: { technical: lists.technical, tools: lists.tools, soft: lists.soft },
    technologies: lists.technologies,
    protocols: lists.protocols,
    methodologies: lists.methodologies,
    architecturePatterns: lists.architecturePatterns,
    responsibilities: lists.responsibilities,
    domainKnowledge: lists.domainKnowledge,
    keywords: {
      actionVerbs: lists.actionVerbs.filter((verb) => !containsBannedVocabulary(verb)),
      buzzwords: lists.buzzwords,
      mustInclude: lists.mustInclude,
    },
  };
}

function without(values: readonly string[], ...excluded: ReadonlyArray<readonly string[]>): string[] {
  const out = new Set(excluded.flat().map((value) => value.toLowerCase()));
  return values.filter((value) => !out.has(value.toLowerCase()));
}

/* ============================================================= top five */

const LEADING_REQUIREMENTS =
  /^(?:(?:basic|minimum|required|key|core|essential|technical)\s+)?(?:requirements|qualifications|skills(?:\s+(?:and|&)\s+(?:experience|qualifications))?|requirements\s+(?:and|&)\s+qualifications|what\s+you(?:'|’)?ll\s+need|what\s+you\s+need|what\s+you\s+bring|what\s+we(?:'|’)?re\s+looking\s+for|must[\s-]+haves?|must\s+have|you\s+have|about\s+you|who\s+you\s+are)$/i;

const OTHER_HEADINGS =
  /^(?:(?:preferred|desired|bonus|nice[\s-]+to[\s-]+have|additional)\b.*|responsibilities|key\s+responsibilities|what\s+you(?:'|’)?ll\s+do|what\s+you\s+will\s+do|the\s+role|about\s+(?:the\s+role|the\s+team|us|the\s+company)|who\s+we\s+are|benefits|perks(?:\s+(?:and|&)\s+benefits)?|compensation|salary|why\s+join\s+us|our\s+stack|tech\s+stack|how\s+to\s+apply|location|equal\s+opportunity.*)$/i;

/** A line's heading text (and anything after its colon), or null for a line that is not one. */
function headingOf(line: string): { heading: string; rest: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 120) return null;
  if (/^(?:[-*•·▪◦‣+]|\d+[.)])\s/.test(trimmed)) return null;
  const bare = trimmed.replace(/^#+\s*/, '').replace(/^\*\*|\*\*$/g, '').trim();
  const known = (value: string) => LEADING_REQUIREMENTS.test(value) || OTHER_HEADINGS.test(value);
  const colon = /^([^:：]{2,60})[:：]\s*(.*)$/.exec(bare);
  if (colon) {
    const heading = colon[1].replace(/\*+/g, '').trim();
    if (known(heading)) return { heading, rest: colon[2] };
    // "Experience with one of the following:" opens a list inside a block;
    // only a short label on a line of its own is a heading.
    return !colon[2] && heading.split(/\s+/).length <= 4 ? { heading, rest: '' } : null;
  }
  if (bare.split(/\s+/).length > 6 || /[.!?,;]$/.test(bare)) return null;
  // A shouted line is a heading ("REQUIREMENTS", "WHAT YOU'LL DO"); "AWS" alone is not.
  const shouted = bare === bare.toUpperCase() && /[A-Z]{4}/.test(bare);
  return /^#+\s/.test(trimmed) || shouted || known(bare) ? { heading: bare, rest: '' } : null;
}

/**
 * The posting's requirements blocks: the lines under a heading like
 * Requirements, Qualifications, What you'll need, Must have, or Basic /
 * Minimum qualifications, up to the next heading of any kind.
 */
export function requirementsText(posting: string): string {
  const inside: string[] = [];
  let open = false;
  for (const line of posting.split(/\r?\n/)) {
    const heading = headingOf(line);
    if (heading) {
      open = LEADING_REQUIREMENTS.test(heading.heading.replace(/\*+/g, '').trim());
      if (open && heading.rest) inside.push(heading.rest);
      continue;
    }
    if (open) inside.push(line);
  }
  return inside.join('\n');
}

/**
 * `[[topSkillsJson]]`: "THE FIVE THIS POSTING LEANS ON" - exactly five, or
 * fewer when the posting names fewer. The technologies, tools and protocols
 * it names, scored from its own text: +6 for one it marks as must-include,
 * +3 for each mention inside its requirements, +1 for each mention anywhere
 * (counting six at most), and up to +3 for coming early (the first-mentioned
 * of them gets 3, the last next to nothing). Ties go to the one mentioned
 * first, then to list order. Fewer than five of those, and the must-include
 * terms and then the technical abilities top it up, scored the same way.
 *
 * Pure, so the parse rebuilds exactly the five the prompt was sent.
 */
export function pickTopSkills(analysis: JobAnalysis, lists: PostingLists = readPostingLists(analysis)): string[] {
  const posting = text(analysis?.sourceJobDescription);
  const requirements = requirementsText(posting);
  const mustInclude = new Set(lists.mustInclude.map((term) => term.toLowerCase()));

  const rank = (candidates: string[]): string[] => {
    const facts = candidates.map((term, order) => ({
      term,
      order,
      anywhere: occurrences(posting, term),
      required: occurrences(requirements, term).count,
    }));
    const mentioned = facts.filter((fact) => fact.anywhere.first !== -1).sort((a, b) => a.anywhere.first - b.anywhere.first);
    const earliness = new Map(mentioned.map((fact, index) => [fact, (3 * (mentioned.length - index)) / mentioned.length]));
    const score = (fact: (typeof facts)[number]) =>
      (mustInclude.has(fact.term.toLowerCase()) ? 6 : 0) +
      3 * fact.required +
      Math.min(fact.anywhere.count, 6) +
      (earliness.get(fact) ?? 0);
    const firstAt = (fact: (typeof facts)[number]) =>
      fact.anywhere.first === -1 ? Number.POSITIVE_INFINITY : fact.anywhere.first;
    return [...facts]
      .sort((a, b) => score(b) - score(a) || firstAt(a) - firstAt(b) || a.order - b.order)
      .map((fact) => fact.term);
  };

  const pool = uniqueTerms([...lists.technologies, ...lists.tools, ...lists.protocols]);
  const top = rank(pool).slice(0, 5);
  for (const extra of [without(lists.mustInclude, top), without(lists.technical, top, lists.mustInclude)]) {
    if (top.length >= 5) break;
    top.push(...rank(extra).slice(0, 5 - top.length));
  }
  return top;
}

/* ===================================================================== draws */

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * The seed of every draw for one tailored resume: the source resume and the posting.
 *
 * The prompt says the soft-skill heading is "drawn for this resume", the
 * concept tools' order "is shuffled for each request" and the title shape is
 * one of six "drawn per resume". Drawn afresh on every call, every tailoring
 * would be a tailoring-cache miss (the key covers what the prompt is sent),
 * and the parse - which runs again on a cache hit and on a preview sent back -
 * could not know which heading names the soft-skill group or which shape the
 * title took. Seeded per source resume and posting instead: the same resume asked
 * again draws the same, and two candidates on one posting draw differently.
 */
export function tailorSeed(resumeId: string | null | undefined, analysis: Pick<JobAnalysis, 'sourceJobDescription'>): string {
  return sha256(`${resumeId ?? ''}\0${contentHash(analysis?.sourceJobDescription ?? '')}`);
}

/** A small seeded generator (mulberry32): numbers in [0, 1), the same sequence for the same seed. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type TailorDraw = 'soft-skill-heading' | 'concept-tools' | 'title-shape';

/** One draw's own sequence, so a change to one (a concept row more) never moves another. */
export function drawSequence(seed: string, draw: TailorDraw): () => number {
  return mulberry32(createHash('sha256').update(`${seed}\0${draw}`, 'utf8').digest().readUInt32BE(0));
}

function pickIndex(random: () => number, length: number): number {
  return Math.min(length - 1, Math.floor(random() * length));
}

/** `[[softSkillGroupHeading]]`: one of services/skillGroups.ts's headings, drawn for this resume. */
export function drawSoftSkillGroupHeading(seed: string): string {
  return SOFT_SKILL_GROUP_HEADINGS[pickIndex(drawSequence(seed, 'soft-skill-heading'), SOFT_SKILL_GROUP_HEADINGS.length)];
}

/** Fisher-Yates over a copy, from `random`. */
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = pickIndex(random, index + 1);
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

/* =================================================== the prompt's lists */

/**
 * The posting's term lists a resume is measured against, in the posting's own
 * spelling: the skills (technical, tools, technologies, protocols), the
 * concepts (architecture patterns, methodologies, buzzwords - less any that is
 * also a skill) and the five it leans on (`pickTopSkills`). The part of
 * `buildTailorLists` that needs nothing else: the tailoring prompt reads it
 * through that function, and the matcher (services/resumeMatch.ts) reads it
 * directly, because the rest of `buildTailorLists` - the concept tools above
 * all - compiles thousands of patterns per call and a choice among resumes
 * asks once per job.
 */
export function postingTermLists(
  analysis: JobAnalysis,
  lists: PostingLists = readPostingLists(analysis)
): { posting: PostingLists; skills: string[]; concepts: string[]; topSkills: string[] } {
  const skills = uniqueTerms([...lists.technical, ...lists.tools, ...lists.technologies, ...lists.protocols]);
  const concepts = without(
    uniqueTerms([...lists.architecturePatterns, ...lists.methodologies, ...lists.buzzwords]),
    skills
  );
  return { posting: lists, skills, concepts, topSkills: pickTopSkills(analysis, lists) };
}

export type TailorLists = {
  posting: PostingLists;
  /** `[[targetRoleTitle]]` and `[[jobTitle]]`: the posting's own title. */
  targetRoleTitle: string;
  /** `[[skillsJSON]]`. */
  skills: string[];
  /** `[[topSkillsJson]]`. */
  topSkills: string[];
  /** `[[keywordsJson]]`. */
  keywords: string[];
  /** `[[conceptKeywordsJson]]`. */
  concepts: string[];
  /** `[[conceptToolsJson]]`, each row's tools shuffled for this resume. */
  conceptTools: Array<{ concept: string; tools: string[] }>;
  /** `[[softSkillGroupHeading]]`. */
  softSkillGroupHeading: string;
  /**
   * Every term the resume is measured against (the bullet cap, the revise
   * pass), in priority order: the top five, the must-include terms, the
   * concepts, the soft skills, the skills, the verbs. Not the
   * responsibilities - they are topics, written once each in the model's own
   * words - and not the domain knowledge, which the prompt's rule 3 decides
   * against the candidate's history.
   */
  checklist: string[];
};

/**
 * Every list the tailoring prompt is sent, and the checklist the answer is
 * measured with, from the analysis alone - in the posting's own spelling,
 * repeats dropped case-insensitively and nothing else: no skill library, no
 * merging of "AWS" into "AWS Lambda". "THE POSTING'S OWN WORDS, CHARACTER FOR
 * CHARACTER": two forms of one thing are two terms a scanner matches.
 */
export function buildTailorLists(analysis: JobAnalysis, seed: string): TailorLists {
  const { posting, skills, concepts, topSkills } = postingTermLists(analysis);
  const verbs = posting.actionVerbs.filter((verb) => isPastTense(verb) && !containsBannedVocabulary(verb));
  const keywords = without(uniqueTerms([...posting.soft, ...posting.mustInclude, ...verbs]), skills, concepts);

  const random = drawSequence(seed, 'concept-tools');
  const conceptTools = conceptRowsFor([
    ...posting.technical,
    ...posting.tools,
    ...posting.soft,
    ...posting.technologies,
    ...posting.protocols,
    ...posting.methodologies,
    ...posting.architecturePatterns,
    ...posting.buzzwords,
    ...posting.mustInclude,
    ...posting.domainKnowledge,
    ...posting.responsibilities,
  ]).map((row) => ({ concept: row.concept, tools: shuffled(row.tools, random) }));

  const checklist = uniqueTerms([
    ...topSkills,
    ...posting.mustInclude,
    ...concepts,
    ...without(posting.soft, skills, concepts),
    ...skills,
    ...without(verbs, skills, concepts),
  ]);

  return {
    posting,
    targetRoleTitle: posting.jobMeta.title,
    skills,
    topSkills,
    keywords,
    concepts,
    conceptTools,
    softSkillGroupHeading: drawSoftSkillGroupHeading(seed),
    checklist,
  };
}

/* ====================================================================== title */

/**
 * A level is a MODIFIER at the edges of a title - "Senior", "Sr.", "Staff",
 * "Lead" before the role, "II" or "3" after it - never a word inside it: in
 * "Tech Lead" and "Team Lead, Payments" the Lead is the role itself, and
 * taking it out left "Tech" and "Team" to be printed as a kind of role.
 */
const LEADING_LEVELS =
  /^(?:(?:senior|sr|staff|principal|lead|junior|jr|mid-level|mid|entry-level|associate)\.?(?:\s*\/\s*|\s+|$))+/i;
const TRAILING_LEVELS = /(?:(?:^|\s*\/\s*|\s+)(?:i{1,3}|iv|v|[123])\.?)+$/i;
const TAIL = /\s[-–—|]\s|[,:(]/;
const SHORT_KIND_WORDS = new Set(['ai', 'ml', 'qa', 'ui', 'ux']);

/**
 * The KIND of role a posting's title names: the title with anything after
 * " - ", " | ", a comma, a colon or a bracket cut off, then the level words
 * at its start (Senior, Staff, Lead, Junior...) and the level numerals at its
 * end (II, 3...) taken off - "Senior Data & AI Engineer - AWS, Java & Python"
 * is "Data & AI Engineer", "Senior Tech Lead" is "Tech Lead". A title that is
 * nothing but a level has no kind ('').
 */
export function roleKind(postingTitle: string): string {
  const head = (postingTitle.split(TAIL)[0] ?? '').replace(/\s+/g, ' ').trim();
  return head
    .replace(LEADING_LEVELS, '')
    .replace(TRAILING_LEVELS, '')
    .replace(/^[\s/&|,·+-]+|[\s/&|,·+-]+$/g, '')
    .trim();
}

/**
 * What `roleKind` cuts off: the segments of a title after its first " - ", " | ",
 * comma, colon or bracket, trimmed ("Software Engineer, Backend (Payments)" has
 * "Backend" and "Payments)"). The matcher reads them as qualifiers of the
 * kind - "Backend" is what says what a "Software Engineer, Backend" does -
 * while the composed headline still leaves them out.
 */
export function roleTail(postingTitle: string): string[] {
  return postingTitle
    .split(TAIL)
    .slice(1)
    .map((segment) => segment.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** The words of a text: letters, digits, `+` and `#` runs (so `C++` and `C#` are one word each). */
export function words(value: string): string[] {
  return value.split(/[^\p{L}\p{N}+#]+/u).filter(Boolean);
}

/**
 * Whether a headline already says the kind: every word of the kind of three
 * letters or more - or AI, ML, QA, UI, UX - is a word of the headline, in any
 * case. "Senior Software Engineer" says "Software Engineer"; it does not say
 * "Cloud Engineer".
 */
export function titleSaysKind(base: string, kind: string): boolean {
  const have = new Set(words(base).map((word) => word.toLowerCase()));
  return words(kind)
    .filter((word) => word.length >= 3 || SHORT_KIND_WORDS.has(word.toLowerCase()))
    .every((word) => have.has(word.toLowerCase()));
}

/** The six shapes the prompt promises a composed title is drawn from. */
export const TITLE_SHAPES: ReadonlyArray<(title: string, kind: string) => string> = [
  (title, kind) => `${title} | ${kind}`,
  (title, kind) => `${title} (${kind})`,
  (title, kind) => `${title}, ${kind}`,
  (title, kind) => `${title} / ${kind}`,
  (title, kind) => `${title} · ${kind}`,
  (title, kind) => `${title} & ${kind}`,
];

/**
 * The headline a tailored resume prints. The prompt tells the model to
 * return "the candidate's existing headline", and promises the application
 * "appends the KIND of role this application is for ... in one of six shapes
 * drawn per resume, and it leaves the line alone when the candidate's own
 * title already says it". The base is the source resume's own title when it has
 * one - it is the candidate's - else what the model wrote, else the title of
 * their latest role (the caller's chain, the one the render falls back on).
 * Recomputed from the source and the seed on every parse, so a re-parse
 * never appends twice.
 */
export function composeTailoredTitle(base: string, postingTitle: string, seed: string): string {
  const title = base.replace(/\s+/g, ' ').trim();
  // No headline to compose onto prints none: the kind alone is the posting's
  // title, which the prompt says the headline never is ("the headline says
  // who this person is"), and an empty one is the render's to fill from the
  // source resume (pdfGenerator's getResumeTitle).
  if (!title) return '';
  const kind = roleKind(postingTitle);
  if (!kind) return title;
  if (titleSaysKind(title, kind)) return title;
  return TITLE_SHAPES[pickIndex(drawSequence(seed, 'title-shape'), TITLE_SHAPES.length)](title, kind);
}

/* ==================================================================== bullets */

/** The prompt's ceiling: "NO role exceeds 8", and anything past the eighth is discarded. */
export const MAX_TAILORED_BULLETS = 8;

/**
 * A role's bullets cut to the eight the prompt promises survive: "the ones
 * carrying the most checklist terms". A bullet's score is the number of
 * DISTINCT checklist terms it carries; ties go to the earlier bullet, and the
 * eight kept stay in the order they were written. Eight or fewer is left as
 * it is, so the cap is idempotent.
 */
export function capBullets(
  bullets: readonly string[],
  checklist: readonly string[],
  max = MAX_TAILORED_BULLETS
): string[] {
  if (bullets.length <= max) return [...bullets];
  const scored = bullets.map((bullet, index) => ({
    index,
    score: checklist.reduce((sum, term) => sum + (containsTerm(bullet, term) ? 1 : 0), 0),
  }));
  const kept = new Set(
    [...scored]
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, max)
      .map((entry) => entry.index)
  );
  return bullets.filter((_bullet, index) => kept.has(index));
}

/* ======================================================================= text */

/**
 * "Never use em-dashes anywhere in the output, and never write '--' or '–' in
 * place of one" - for the summary, the bullets and the cover letter, in case
 * the model does anyway. A dash between two figures is a range and becomes a
 * hyphen - a figure being the word on either side of it, when that word
 * carries a digit: "2019-2021", "3-5", and just as much "$5M-$10M", "50%-80%",
 * "Q1-Q3" or "10K-20K", which as a list ("$5M, $10M") would say something the
 * model did not. Any other em or en dash, or a spaced " -- ", becomes a comma,
 * with the spaces put right and never a comma doubled or left before a full
 * stop. Line breaks are left alone, so a letter keeps its paragraphs.
 */
export function dashBackstop(value: string): string {
  if (!/[–—]|(?:^|[ \t])--(?:[ \t]|$)/m.test(value)) return value;
  const MARK = '\u0000';
  return value
    .replace(/(?<=\d[^\s–—]*)[ \t]*[–—][ \t]*(?=[^\s–—]*\d)/g, '-')
    .replace(/[ \t]*(?:[–—]|(?<=^|[ \t])--(?=[ \t]|$))[ \t]*/gm, MARK)
    .replace(/[ \t]*,?[ \t]*\u0000(?:[ \t]*,?[ \t]*\u0000)*[ \t]*,?[ \t]*/g, MARK)
    .replace(/^\u0000/gm, '')
    .replace(/\u0000(?=[.;:!?)\]]|$)/gm, '')
    .split(MARK)
    .join(', ');
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

const NUMBER_WORD = Object.keys(NUMBER_WORDS).join('|');
/** The words a number past twenty is built on: "twenty one", "a hundred and five". */
const COMPOUND_LEAD = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred(?:[ \\t]+and)?';
/**
 * A number word before "year(s)" - or a range of two, "two or three years",
 * "five to seven years" - that is not the end of a compound: the "five" of
 * "Twenty-five years" or "thirty five years" is part of a number past twenty,
 * which is left as it is rather than printed as "Twenty-5" or "thirty 5".
 */
const SPELLED_SPAN = new RegExp(
  `(?<![A-Za-z]-)(?<!\\b(?:${COMPOUND_LEAD})[ \\t]+)` +
    `\\b(?:(${NUMBER_WORD})([ \\t]+(?:or|to)[ \\t]+))?(${NUMBER_WORD})(?=[ \\t-]+years?\\b)`,
  'gi'
);

/**
 * A span of years spelled out becomes a numeral: the prompt asks for "7
 * years", never "Seven years". One to twenty, before "year"/"years" (or
 * "-year"), both ends of a range at once ("2 or 3 years", never "two or 3").
 */
export function numeralYears(value: string): string {
  return value.replace(SPELLED_SPAN, (_match, first: string | undefined, between: string | undefined, last: string) =>
    (first ? `${NUMBER_WORDS[first.toLowerCase()]}${between}` : '') + String(NUMBER_WORDS[last.toLowerCase()])
  );
}

/* ====================================================================== roles */

function roleKey(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The four-digit years a date names, "01/2020" and "Jan 2020" alike; '' for "Present" or nothing. */
function yearsOf(value: unknown): string {
  return typeof value === 'string' ? (value.match(/\b(?:19|20)\d\d\b/g) ?? []).join(' ') : '';
}

/** How closely a role's date says the same as the answer's: 2 for the same text, 1 for the same years, else 0. */
function dateAgreement(answered: unknown, own: unknown): number {
  const said = roleKey(answered);
  if (!said) return 0;
  if (said === roleKey(own)) return 2;
  const years = yearsOf(answered);
  return years && years === yearsOf(own) ? 1 : 0;
}

/**
 * Which of several roles of the source resume at one company under one title
 * an answered role is - a person back at an old employer in the same job. The
 * answer carries the dates the model was given, so the stint whose start and
 * end dates agree best is it; with no date agreeing, the first in source order.
 * Without this the n-th answered stint took the n-th source stint, and an
 * answer listing them newest first - as the prompt asks - over a source
 * typed oldest first printed each stint's work under the other's dates.
 */
function closestStint(entry: Record<string, unknown>, candidates: readonly number[], roles: readonly Experience[]): number {
  let best = candidates[0];
  let bestScore = 0;
  for (const index of candidates) {
    // The start decides before the end does: any agreement on it outweighs the end's.
    const score = 3 * dateAgreement(entry.startDate, roles[index]?.startDate) + dateAgreement(entry.endDate, roles[index]?.endDate);
    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The roles a tailored resume prints, against the source resume's own.
 *
 * The prompt says "Preserve title, company, startDate, endDate and location
 * exactly as given" and "never invent a company, a title, a date" - so the
 * code holds it to that. Each returned role is matched to a source role by
 * company and title (normalised) - among several stints with the same pair,
 * the one whose dates agree with the answer's (`closestStint`) - else by
 * company alone when only one of the source's roles is at that company; its
 * five facts are put back from the source. The MODEL'S order is kept ("Most
 * recent company first, always" is the model's to do; a source typed
 * oldest-first must not undo it). A role the source does not have is
 * dropped, and so is a second answer for one source role. A source role the
 * answer left out is put back, with its own bullets, after the nearest role
 * before it in the source.
 * Every role's description is '': the prompt says it is discarded before the
 * resume is printed, and nothing is written in its place.
 *
 * `finish(answered, own)` makes a role's bullets from what the answer said
 * (nothing, for a role put back) and the source's own bullets for it.
 */
export function restoreRoles(
  answered: unknown,
  resumeRoles: readonly Experience[],
  finish: (answered: unknown, own: readonly string[]) => string[]
): TailoredExperience[] {
  const roles = Array.isArray(resumeRoles) ? resumeRoles : [];
  const claimed = new Set<number>();
  const placed: Array<{ resumeIndex: number; achievements: unknown }> = [];

  for (const entry of Array.isArray(answered) ? answered : []) {
    if (!isRecord(entry)) continue;
    const company = roleKey(entry.company);
    const title = roleKey(entry.title);
    const samePair = roles
      .map((role, index) =>
        !claimed.has(index) && roleKey(role?.company) === company && roleKey(role?.title) === title ? index : -1
      )
      .filter((index) => index !== -1);
    let match = samePair.length > 1 ? closestStint(entry, samePair, roles) : samePair[0] ?? -1;
    if (match === -1 && company) {
      const atCompany = roles.map((role, index) => (roleKey(role?.company) === company ? index : -1)).filter((index) => index !== -1);
      if (atCompany.length === 1 && !claimed.has(atCompany[0])) match = atCompany[0];
    }
    if (match === -1) continue;
    claimed.add(match);
    placed.push({ resumeIndex: match, achievements: entry.achievements });
  }

  roles.forEach((_role, index) => {
    if (claimed.has(index)) return;
    let after = -1;
    placed.forEach((entry, position) => {
      if (entry.resumeIndex < index && (after === -1 || entry.resumeIndex > placed[after].resumeIndex)) after = position;
    });
    placed.splice(after + 1, 0, { resumeIndex: index, achievements: undefined });
  });

  return placed.map(({ resumeIndex, achievements }) => {
    const role = roles[resumeIndex];
    const own = (Array.isArray(role?.achievements) ? (role.achievements as unknown[]) : []).filter(
      (item): item is string => typeof item === 'string'
    );
    return {
      title: text(role?.title),
      company: text(role?.company),
      startDate: text(role?.startDate),
      endDate: text(role?.endDate),
      location: text(role?.location),
      description: '',
      achievements: finish(achievements, own),
    };
  });
}
