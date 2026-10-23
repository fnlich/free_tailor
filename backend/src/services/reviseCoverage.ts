import type { Resume } from '../types/resume';
import type { TailoredContent, TailoredExperience } from '../types/template';
import { extractJSON } from '../utils/json';
import { containsBannedVocabulary, containsTerm } from './tailorContract';

/**
 * The revise pass (`revise-resume-coverage`): what the draft of a tailored
 * resume is measured on, what the second call is sent, and how its answer is
 * folded back in. Pure; resumeService's `tailorResume` makes the call.
 *
 * The tailoring prompt asks for every checklist term the source resume
 * supports on the page, and for every figure it states. A first draft rarely
 * manages all of it, so the owner's revise prompt is given the draft, the
 * terms it is missing and - when the draft dropped any - the source's own
 * lines whose figures it no longer shows, and asked to "change as little as
 * possible": a term goes in only where the draft describes work that involved
 * it, a figure only back into the bullet about the work the source states it
 * for. It returns only what it changed.
 */

export const REVISE_PROMPT_ID = 'revise-resume-coverage';

/**
 * One line of `[[figuresNote]]`: a sentence of the source resume - a role's bullet,
 * or a sentence of its description - carrying a figure the draft dropped, and
 * the role it is from.
 */
export type DroppedFigureLine = { company: string; title: string; line: string };

/**
 * `[[figuresNote]]` when the draft dropped a figure the source resume states:
 * the source's own lines that carry one, each under its role, and the one thing
 * to do with them - put the figure back into the bullet about that same work,
 * exactly as stated, or add nothing. The tailoring prompt writes a figure only
 * where the source states one, and the revise prompt forbids any figure
 * "except one the FIGURES lines above state", so this is the only road a
 * figure takes into a revision, and every one of them is the candidate's own.
 * (The sentence that used to ask here for "modest" figures the work "implies"
 * is gone: it was an invitation to invent a measurement.) Its wording is part
 * of the tailoring cache's key (`FIGURES_NOTE_WORDING`): a merged answer was
 * written to it.
 */
export function figuresNote(dropped: readonly DroppedFigureLine[]): string {
  const lines = dropped.map((entry) => {
    const role = [entry.company, entry.title].filter(Boolean).join(', ');
    return role ? `- ${role}: ${entry.line}` : `- ${entry.line}`;
  });
  return (
    "FIGURES THE PROFILE STATES AND THE DRAFT DROPPED. Each line below is the candidate's own, from the role named " +
    'before it, and carries a figure the draft no longer shows. Where a bullet of that role describes the same piece ' +
    'of work, put the figure back into it exactly as the line states it; where no bullet describes that work, add ' +
    'nothing. Never a figure these lines do not state, and never one in the summary.\n' +
    lines.join('\n')
  );
}

export const FIGURES_NOTE_WORDING = figuresNote([{ company: '{company}', title: '{title}', line: '{line}' }]);

/**
 * A figure: a number that is not glued to a letter before it - so "37%", "40
 * minutes", "2B+" and "9s to 1.4s" are figures, and S3, EC2, p99, OAuth2 and
 * v1.2 are names. Read at the number's first digit, so the second 9 of p99
 * does not count either.
 */
export function hasFigure(text: string): boolean {
  return /(?<![A-Za-z0-9.])\d/.test(text);
}

function bulletsOf(content: Pick<TailoredContent, 'experience'>): string[] {
  return (Array.isArray(content.experience) ? content.experience : []).flatMap((role) =>
    Array.isArray(role?.achievements) ? role.achievements.filter((bullet): bullet is string => typeof bullet === 'string') : []
  );
}

/**
 * The figures of a text, as digits: each number not glued to a letter before
 * it, thousands separators dropped, decimals kept - "9s to 1.4s" is 9 and 1.4,
 * "1,200 users" is 1200, "$5M" is 5 - less a four-digit year, which is a date.
 * p99, S3 and v1.2 are nothing (`hasFigure`).
 */
export function figureTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(/(?<![A-Za-z0-9.])\d[\d,]*(?:\.\d+)?/g)) {
    const token = match[0].replace(/,/g, '');
    if (!/^(?:19|20)\d\d$/.test(token)) tokens.push(token);
  }
  return tokens;
}

/** How many of the resume's lines `[[figuresNote]]` lists at most. */
export const MAX_DROPPED_FIGURE_LINES = 12;

/**
 * The resume's own lines - each role's bullets, then the sentences of its
 * description, in resume order - that carry a figure the draft's summary and
 * bullets no longer show, at most `max` of them. A figure is carried by its
 * digits wherever they stand ("40 minutes" by "40-minute", "1,200" by "1200");
 * a role the parse restored with the source's own bullets has dropped
 * nothing, and a figure the source never stated is not looked for.
 */
export function droppedResumeFigures(
  resume: Pick<Resume, 'experience'>,
  draft: Pick<TailoredContent, 'summary' | 'experience'>,
  max: number = MAX_DROPPED_FIGURE_LINES
): DroppedFigureLine[] {
  const carried = new Set(figureTokens(resumeProse(draft)));
  const dropped: DroppedFigureLine[] = [];
  for (const role of Array.isArray(resume.experience) ? resume.experience : []) {
    if (!role || typeof role !== 'object') continue;
    const description = typeof role.description === 'string' ? role.description : '';
    const lines: unknown[] = [
      ...(Array.isArray(role.achievements) ? role.achievements : []),
      ...description.split(/(?<=[.!?])\s+/),
    ];
    for (const raw of lines) {
      if (dropped.length >= max) return dropped;
      const line = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
      if (!line || !figureTokens(line).some((token) => !carried.has(token))) continue;
      dropped.push({
        company: typeof role.company === 'string' ? role.company : '',
        title: typeof role.title === 'string' ? role.title : '',
        line,
      });
    }
  }
  return dropped;
}

/** What a scanner reads of the resume: the summary and the bullets. */
export function resumeProse(content: Pick<TailoredContent, 'summary' | 'experience'>): string {
  return [typeof content.summary === 'string' ? content.summary : '', ...bulletsOf(content)].filter(Boolean).join('\n');
}

/**
 * The checklist terms (services/tailorContract.ts `buildTailorLists`, in its
 * priority order - the caller passes only those the resume carries,
 * `supportedTerms`) the summary and bullets do not carry, at most `max` of them.
 * A term carrying a banned word or opener is never among them - the revise
 * prompt bans those words with no exception, so asking for one is an
 * instruction it cannot obey.
 */
export function missingTerms(
  content: Pick<TailoredContent, 'summary' | 'experience'>,
  checklist: readonly string[],
  max: number
): string[] {
  const prose = resumeProse(content);
  const missing: string[] = [];
  for (const term of checklist) {
    if (missing.length >= max) break;
    if (containsBannedVocabulary(term)) continue;
    if (!containsTerm(prose, term)) missing.push(term);
  }
  return missing;
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.flatMap(strings) : [];
}

function fieldsOf(list: unknown, keys: readonly string[]): string[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? keys.flatMap((key) => strings((item as Record<string, unknown>)[key]))
      : []
  );
}

/**
 * The candidate's own words, as one text a checklist term is looked up in:
 * the headline and summary, every skill they list (and the headings they
 * grouped them under), their soft skills and strengths, and the lines that
 * describe their work - each role's title, description, bullets and skills,
 * and their certifications, projects, volunteering, courses, awards and
 * publications. Never a company's name: having worked at Stripe is not having
 * used Stripe. The caller passes the resume as the tailoring call saw it
 * (resumeService's `sourceAsShown`: a description's sentences about the
 * company dropped), so a term only the company's own blurb names is not one.
 */
export function resumeEvidence(resume: Partial<Resume>): string {
  const source = resume as Record<string, unknown>;
  return [
    ...strings(source.title),
    ...strings(source.summary),
    ...strings(source.skills),
    ...fieldsOf(source.skillCategories, ['category', 'skills']),
    ...strings(source.softSkills),
    ...fieldsOf(source.strengths, ['title', 'description']),
    ...fieldsOf(source.experience, ['title', 'description', 'achievements', 'skills']),
    ...fieldsOf(source.certifications, ['name', 'issuer']),
    ...fieldsOf(source.projects, ['name', 'role', 'description', 'achievements']),
    ...fieldsOf(source.volunteering, ['role', 'description', 'achievements']),
    ...fieldsOf(source.courses, ['name']),
    ...fieldsOf(source.awards, ['title', 'description']),
    ...fieldsOf(source.publications, ['title', 'description']),
  ]
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * The checklist terms the candidate's own words carry (`resumeEvidence`, the
 * same whole-word match the draft is measured with), in the checklist's
 * order. Only these are ever handed to the revise pass. It reads the draft
 * and not the source resume, so it cannot know whether the candidate has a term the
 * source never names - and the tailoring prompt is told to leave exactly
 * such a term out. Asked for one, the revise pass would undo that, on the one
 * call that cannot check.
 */
export function supportedTerms(checklist: readonly string[], evidence: string): string[] {
  return checklist.filter((term) => containsTerm(evidence, term));
}

/**
 * Whether the pass runs: a term is missing, or the draft dropped a figure the
 * source resume states. A draft carrying every term and every figure is the
 * resume as it stands.
 */
export function revisionWanted(missing: readonly string[], dropped: readonly DroppedFigureLine[]): boolean {
  return missing.length > 0 || dropped.length > 0;
}

/**
 * The revise prompt's values: the draft as it would print - the summary and,
 * per role, its company, title, dates and bullets - the missing terms, and the
 * figures note ('' when the draft dropped no figure of the source's). The
 * dates are there for the prompt's years rule: after a Fully tailored draft
 * the terms asked for include technologies the source never names, and
 * without them one could land in a role it postdates.
 */
export function buildReviseResumeCoveragePromptValues(
  draft: Pick<TailoredContent, 'summary' | 'experience'>,
  missing: readonly string[],
  dropped: readonly DroppedFigureLine[]
): Record<string, string> {
  return {
    draftJson: JSON.stringify({
      summary: typeof draft.summary === 'string' ? draft.summary : '',
      experience: (Array.isArray(draft.experience) ? draft.experience : []).map((role) => ({
        company: role.company,
        title: role.title,
        startDate: role.startDate,
        endDate: role.endDate,
        achievements: role.achievements,
      })),
    }),
    missingTermsJson: JSON.stringify(missing),
    figuresNote: dropped.length > 0 ? figuresNote(dropped) : '',
  };
}

/** The revise prompt's own example value for a summary it left alone. */
const SUMMARY_PLACEHOLDER = 'the rewritten summary, or omit this key if you did not change it';

function pairKey(company: unknown, title: unknown): string {
  const norm = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : '');
  return `${norm(company)}\u0000${norm(title)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether a revised line prints as it was written: the caller's finishing
 * (resumeService's sanitiser, which drops a sentence written from the
 * employer's side - "we", "our", "you" - or about the tailoring itself) keeps
 * every sentence of it. The revise prompt has no pronoun rule of its own, so
 * "cut our build time" is a fair answer, and a line that would lose a sentence
 * is not taken over the draft's.
 */
export type PrintsWhole = (text: string) => boolean;

function lineKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/**
 * Which of several draft roles with one company and title a returned role is,
 * when the answer did not return every one of them: the one whose bullets it
 * repeats most. The prompt lists a role "only if you changed one of its
 * bullets" and asks for "every bullet for this role, in order, changed and
 * unchanged alike", and the draft it is sent carries no dates - so the
 * unchanged bullets are what name the stint. By position, the one revised
 * stint of two always took the first, and the recent role printed the old
 * one's work. A role sharing no bullet with any of them, or as many with two,
 * is not known, and is ignored like any role the draft does not have.
 */
function stintSharingMost(
  bullets: readonly string[],
  candidates: readonly number[],
  experience: ReadonlyArray<Pick<TailoredExperience, 'achievements'>>
): number | undefined {
  const returned = new Set(bullets.map(lineKey));
  let best: number | undefined;
  let bestShared = 0;
  let tied = false;
  for (const index of candidates) {
    const own = new Set((experience[index]?.achievements ?? []).map(lineKey));
    const shared = [...own].filter((line) => returned.has(line)).length;
    if (shared > bestShared) {
      best = index;
      bestShared = shared;
      tied = false;
    } else if (shared === bestShared && shared > 0) {
      tied = true;
    }
  }
  return tied ? undefined : best;
}

/**
 * The draft with the revise answer folded in, or null when the answer changes
 * nothing. Only two things are read:
 *
 * - `summary`, taken when it is a non-empty string other than the prompt's
 *   own placeholder, and only when it prints whole;
 * - `experience`, where the n-th role returned with a given company and title
 *   (trimmed, any case) replaces the bullets of the n-th draft role with that
 *   pair when the answer returned every draft role with it - two stints at
 *   one company under one title stay apart - and only with a non-empty list
 *   of strings. When it returned fewer of them (the prompt lists only the
 *   roles it changed), a returned role is the stint whose bullets it repeats
 *   most (`stintSharingMost`). A role the draft does not have, or one that
 *   cannot be told apart, is ignored.
 *
 * A revised bullet that would not print whole - a sentence of it dropped, all
 * of it, or a repeat of one before it in the list - never costs the draft its
 * own: when the role came back with as many bullets as the draft has, the
 * draft's bullet stands at that place; otherwise the role keeps its draft
 * bullets. Taking the revision as written would leave the role short, and a
 * role finished with no bullet at all prints the source's raw ones - either
 * way the terms the draft already carried go, the opposite of what the pass is
 * for. A part the answer returned exactly as the draft has it is no change.
 *
 * Nothing else - skills, a cover letter, dates, a new role - is taken. An
 * answer that is not a JSON object, or `{}`, changes nothing. The caller runs
 * the result through the same finishing as the draft (sanitising, the dash
 * backstop, the eight-bullet cap).
 */
export function mergeRevision<T extends Pick<TailoredContent, 'summary' | 'experience'>>(
  draft: T,
  answer: string,
  printsWhole: PrintsWhole
): T | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJSON(answer));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  let changed = false;
  let summary = draft.summary;
  if (typeof parsed.summary === 'string') {
    const written = parsed.summary.trim();
    if (written && written.toLowerCase() !== SUMMARY_PLACEHOLDER && written !== draft.summary && printsWhole(written)) {
      summary = written;
      changed = true;
    }
  }

  const experience = (Array.isArray(draft.experience) ? draft.experience : []).map((role) => ({
    ...role,
    achievements: [...(role.achievements ?? [])],
  }));
  const keys = experience.map((role) => pairKey(role.company, role.title));
  const entries = (Array.isArray(parsed.experience) ? parsed.experience : []).filter(isRecord);
  const returned = new Map<string, number>();
  for (const entry of entries) {
    const key = pairKey(entry.company, entry.title);
    returned.set(key, (returned.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const claimed = new Set<number>();
  for (const entry of entries) {
    const key = pairKey(entry.company, entry.title);
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    if (!Array.isArray(entry.achievements)) continue;
    const bullets = entry.achievements
      .filter((bullet): bullet is string => typeof bullet === 'string')
      .map((bullet) => bullet.trim())
      .filter(Boolean);
    if (bullets.length === 0) continue;
    const stints = keys.map((candidate, index) => (candidate === key ? index : -1)).filter((index) => index !== -1);
    const target =
      stints.length <= 1 || returned.get(key) === stints.length
        ? stints[nth]
        : stintSharingMost(bullets, stints.filter((index) => !claimed.has(index)), experience);
    if (target === undefined) continue;
    claimed.add(target);

    const own = experience[target].achievements;
    const lines = new Set<string>();
    const prints = bullets.map((bullet) => {
      const line = lineKey(bullet);
      const whole = !lines.has(line) && printsWhole(bullet);
      lines.add(line);
      return whole;
    });
    let revised: string[];
    if (prints.every(Boolean)) revised = bullets;
    else if (bullets.length === own.length) revised = bullets.map((bullet, index) => (prints[index] ? bullet : own[index]));
    else continue;
    if (sameLines(revised, own)) continue;
    experience[target].achievements = revised;
    changed = true;
  }

  return changed ? { ...draft, summary, experience } : null;
}
