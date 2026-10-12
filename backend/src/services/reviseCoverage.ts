import type { TailoredContent, TailoredExperience } from '../types/template';
import { extractJSON } from '../utils/json';
import { containsBannedVocabulary, containsTerm } from './tailorContract';

/**
 * The revise pass (`revise-resume-coverage`): what the draft of a tailored
 * resume is measured on, what the second call is sent, and how its answer is
 * folded back in. Pure; resumeService's `tailorResume` makes the call.
 *
 * The tailoring prompt asks for every checklist term on the page and at least
 * five figures in the bullets. A first draft rarely manages all of it, so the
 * owner's revise prompt is given the draft, the terms it is missing and - when
 * it needs them - a sentence asking for figures, and asked to "change as
 * little as possible". It returns only what it changed.
 */

export const REVISE_PROMPT_ID = 'revise-resume-coverage';

/** How many figures the bullets must carry: "AT LEAST FIVE FIGURES ON THE PAGE". */
export const FIGURES_WANTED = 5;

/**
 * `[[figuresNote]]` when the bullets carry fewer than five figures. The revise
 * prompt forbids "any figure already in a sentence, unless you are asked above
 * for more" and any outcome not in the draft, so this sentence is where the
 * tailoring prompt's own guard - modest, implied by the work, never a result
 * nobody measured, never in the summary - is restated. Its wording is part of
 * the tailoring cache's key (`FIGURES_NOTE_WORDING`): a merged answer was
 * written to it.
 */
export function figuresNote(carried: number | string, more: number | string): string {
  return (
    `FIGURES. ${carried} of the bullets carry a figure and a resume needs at least five. Add a figure to ${more} ` +
    'more bullets, never to the summary: each a modest quantity the work the bullet already describes implies (how ' +
    'many services or endpoints a change covered, how many people a review involved, how often a release went out, ' +
    'how long a job took before and after). Never a result nobody measured, and never a figure attached to work ' +
    'the draft does not describe.'
  );
}

export const FIGURES_NOTE_WORDING = figuresNote('{n}', '{k}');

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

/** The bullets, how many carry a figure, and how many more could: one per bullet without one, up to five in all. */
export function figureCount(content: Pick<TailoredContent, 'experience'>): { bullets: number; carried: number; wanted: number } {
  const bullets = bulletsOf(content);
  const carried = bullets.filter(hasFigure).length;
  const wanted = carried >= FIGURES_WANTED ? 0 : Math.min(FIGURES_WANTED - carried, bullets.length - carried);
  return { bullets: bullets.length, carried, wanted };
}

/** What a scanner reads of the resume: the summary and the bullets. */
export function resumeProse(content: Pick<TailoredContent, 'summary' | 'experience'>): string {
  return [typeof content.summary === 'string' ? content.summary : '', ...bulletsOf(content)].filter(Boolean).join('\n');
}

/**
 * The checklist terms (services/tailorContract.ts `buildTailorLists`, in its
 * priority order) the summary and bullets do not carry, at most `max` of them.
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

/**
 * Whether the pass runs: a term is missing, or the bullets carry fewer than
 * five figures and one of them could take one. A draft with no bullets has
 * nothing to put a figure in - the prompt widens sentences, it adds none.
 */
export function revisionWanted(missing: readonly string[], figures: { wanted: number }): boolean {
  return missing.length > 0 || figures.wanted > 0;
}

/**
 * The revise prompt's values: the draft as it would print - the summary and,
 * per role, its company, title and bullets - the missing terms, and the
 * figures sentence ('' when no more figures are wanted).
 */
export function buildReviseResumeCoveragePromptValues(
  draft: Pick<TailoredContent, 'summary' | 'experience'>,
  missing: readonly string[],
  figures: { carried: number; wanted: number }
): Record<string, string> {
  return {
    draftJson: JSON.stringify({
      summary: typeof draft.summary === 'string' ? draft.summary : '',
      experience: (Array.isArray(draft.experience) ? draft.experience : []).map((role) => ({
        company: role.company,
        title: role.title,
        achievements: role.achievements,
      })),
    }),
    missingTermsJson: JSON.stringify(missing),
    figuresNote: figures.wanted > 0 ? figuresNote(figures.carried, figures.wanted) : '',
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
 * role finished with no bullet at all prints the profile's raw ones - either
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
