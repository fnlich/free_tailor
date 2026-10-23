import type { BuildMode } from '../config/buildModes';
import type { Resume } from '../types/resume';
import type { JobAnalysis } from '../types/template';
import {
  alnumRuns,
  describeTerm,
  isVocabularyTerm,
  matchKeywordsOf,
  namedRows,
  scanVocabulary,
  termIndexIn,
  type ResumeKeywords,
  type TermInfo,
} from './resumeKeywords';
import { postingTermLists, requirementsText, roleKind, roleTail, words } from './tailorContract';

/**
 * Choosing the suitable resume of a profile for a posting (Choose Suitable
 * Resume and Partial Tailor). Pure: no database, no model, no I/O - the
 * caller (services/resumeChoice.ts) hands it the profile's enabled resumes and
 * the job, and gets the resume and the reason back.
 *
 * A resume's score for a posting is
 *
 *     S = 0.45 * T + 0.55 * R
 *
 * T is TITLE affinity: how much of the kind of role the posting names (its
 * analysis' title and the role the caller gave, with the level words taken off:
 * `roleKind`) the resume's headline (70%) and its best held title (30%) say.
 * The kind's last word, the head ("Engineer"), counts 1 and every qualifier
 * before it ("Backend") counts 2 ("Software" 1), so "Data Engineer" is a third
 * of the way to "Backend Engineer" and "Backend Developer" all of it. The words
 * of the title's TAIL - what `roleKind` cuts off after a comma, " - ", " | ", a
 * colon or a bracket: "Software Engineer, Backend", "Software Engineer
 * (Backend)", "Engineer II, Backend Platform" - are further qualifiers of
 * weight 2 (less level numerals, "Remote"-like words, the kind's own words and
 * any that is a term of the posting); `titleMatched` is about the kind alone.
 *
 * R is RECALL over the posting's own terms - R = 0.7 * core + 0.3 * rest, each
 * the weighted share of the tier's terms the resume has (a term the resume
 * lacks counts nothing; one it carries counts its factor). What the resume
 * has beyond what the posting names counts for nothing, so a long list cannot
 * win on size alone, and the core tier keeps a long secondary list from
 * diluting the posting's headline stack.
 *
 *   with an analysis:  core = the five it leans on (`pickTopSkills`) and the
 *                      must-include terms, weight 3; rest = its other skills,
 *                      weight 2, and its concepts and domain knowledge,
 *                      weight 1. Soft skills, verbs and responsibilities are
 *                      never scored.
 *   from text alone:   the vocabulary scan of services/resumeKeywords.ts, plus
 *                      every candidate's own term the text names; core = a term
 *                      in the title (weight 3) or in a requirements block
 *                      (weight 2), rest = anywhere else (weight 1).
 *
 * The factor of a posting term t is the best, over the resume's terms r, of:
 *   1.0  the same thing (synonym), or t is a whole word inside r ("AWS" in
 *        "AWS Lambda")
 *   0.6  r is a whole word inside t (the resume says "AWS", the posting "AWS Lambda")
 *   0.8  r is an alias of a concept row t names ("continuous integration" for "CI/CD")
 *   0.5  r is a tool of a concept row t names (Jenkins for "CI/CD")
 *
 * An analysis term that spells alternatives - "Go (Golang)", "Go/Golang",
 * "Golang or Go", "Kubernetes (K8s)" - is scored as each of them and the term
 * itself, and the best factor counts; a term that is itself a vocabulary entry
 * ("CI/CD", "TCP/IP", "A/B testing") is not split.
 *
 * The analysis is read through `postingTermLists` + `pickTopSkills`, never
 * `buildTailorLists`: that one compiles about 16,000 patterns for the concept
 * tools (8 ms a job), a choice among resumes asks once per job, and the
 * tailoring prompt's lists are not changed by sharing the part they have in
 * common. Choosing for 500 jobs among 25 resumes takes about 0.2 s.
 *
 * Ties are decided by the profile's effective default, then by precision
 * (the share of the resume's terms the posting names), then by strict title
 * affinity (a missing headline counted as nothing, so a specialist whose
 * headline and roles both match beats a headline-less resume that merely lists
 * one matching role), then the newer `updatedAt`, then the lower id - a total order, so the answer never depends
 * on the order the candidates came in.
 */

const TITLE_WEIGHT = 0.45;
const RECALL_WEIGHT = 0.55;
const CORE_SHARE = 0.7;
const HEADLINE_SHARE = 0.7;
const MAX_MATCHED = 8;

export type TaskMatch = {
  v: 1;
  mode: BuildMode;
  /**
   * `matched`: the resume won on its score; `tie`: the top score was shared
   * (or nothing matched at all) and the tie-break decided; `only`: the profile
   * has one enabled resume; `default`: Fully Tailor, which builds the
   * profile's effective default by rule.
   */
  reason: 'matched' | 'tie' | 'only' | 'default';
  /** Enabled resumes the profile had when the choice was made. */
  candidates: number;
  /** What the score was worked out from; `matched` and `tie` only. */
  basis?: 'analysis' | 'text' | 'title' | 'none';
  score?: number;
  titleMatched?: boolean;
  /** The posting's terms the chosen resume carries, best first, at most 8, in the posting's spelling. */
  matched?: string[];
  matchedCount?: number;
  postingTermCount?: number;
};

export type MatchJob = { analysis?: JobAnalysis | null; text?: string; title?: string };
export type MatchCandidate = { resume: Resume; isDefault: boolean };

type Basis = NonNullable<TaskMatch['basis']>;

export type ResumeScore = {
  score: number;
  titleMatched: boolean;
  matched: string[];
  matchedCount: number;
  postingTermCount: number;
  basis: Basis;
  /** The share of the resume's terms the posting names; the second tie-break. */
  precision: number;
  /** Title affinity with a missing headline or role list counted as nothing; the third tie-break. */
  strict: number;
};

/* ================================================================== titles */

const SHORT_WORDS = new Set(['ai', 'ml', 'qa', 'ui', 'ux']);
const STOP_WORDS = new Set(['and', 'the', 'for', 'with']);
const HEADS = new Map([
  ['developer', 'engineer'],
  ['programmer', 'engineer'],
  ['dev', 'engineer'],
  ['swe', 'engineer'],
]);
const FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bfront end\b/g, 'frontend'],
  [/\bback end\b/g, 'backend'],
  [/\bfull stack\b/g, 'fullstack'],
  [/\bdev ops\b/g, 'devops'],
  [/\bmachine learning\b/g, 'ml'],
  [/\bartificial intelligence\b/g, 'ai'],
  [/\bquality assurance\b/g, 'qa'],
  // Site reliability, SRE and DevOps name one kind of role in postings and on resumes alike.
  [/\bsite reliability\b/g, 'devops'],
  [/\bsre\b/g, 'devops'],
];

/**
 * Words that are kin without being the same: a Platform Engineer posting
 * counts a DevOps resume half (and the other way round). Symmetric; the
 * posting word's own weight is halved.
 */
const KIN_WORDS: ReadonlyArray<readonly [string, string]> = [['platform', 'devops']];

/** The words of a role kind that count: folded spellings, 3+ letters (or AI/ML/QA/UI/UX), heads unified. */
function kindWords(kind: string): string[] {
  let folded = kind.toLowerCase().replace(/[-‐‑–—_]/g, ' ').replace(/\s+/g, ' ');
  for (const [pattern, to] of FOLDS) folded = folded.replace(pattern, to);
  return words(folded)
    .filter((word) => (word.length >= 3 || SHORT_WORDS.has(word)) && !STOP_WORDS.has(word))
    .map((word) => HEADS.get(word) ?? word);
}

/**
 * A posting's kind of role as weighted words. The first `mainCount` words are
 * the kind itself (`roleKind`); the rest are the qualifiers its tail adds
 * ("Backend" in "Software Engineer, Backend"). `total` is all the weight,
 * `mainTotal` the kind's own.
 */
type JobTitle = { words: string[]; weights: number[]; total: number; mainCount: number; mainTotal: number };

/** Tail words that say nothing about the kind of role: where, how long, how it is hired. */
const TAIL_NOISE = new Set([
  'remote', 'hybrid', 'onsite', 'site', 'contract', 'contractor', 'temporary', 'permanent', 'full', 'part', 'time',
  'fulltime', 'parttime', 'hiring', 'urgent', 'immediate', 'opening', 'new',
]);
/** A level numeral that `kindWords` keeps (three letters): "Engineer III, Backend". */
const LEVEL_WORDS = new Set(['iii']);
/** Qualifiers of weight 1 rather than 2: a word every second engineer's title carries. */
const GENERIC_QUALIFIERS = new Set(['software']);

/**
 * The title a posting's TEXT opens with, when it looks like one: the first
 * non-empty line, at most 8 words and 80 characters, not ending like a
 * sentence. For a posting given without a role (the builder's Role box can be
 * hidden, and a sheet row may not have one) the first line is usually the
 * title, and without it a resume that holds only titles could never be told
 * apart. A first line that reads as a sentence ("We use Zorblax every day.")
 * is not one, and is left to the vocabulary scan.
 */
function openingTitle(text: unknown): string {
  if (typeof text !== 'string') return '';
  const line = firstLine(text);
  if (!line || line.length > 80 || line.split(/\s+/).length > 8 || /[.!?:;]$/.test(line)) return '';
  return line;
}

/**
 * The posting's role kinds: the analysis' title's and the caller's, levels off,
 * repeats dropped. The kind is `roleKind`'s (the title up to its first tail);
 * the words of the TAIL - "Backend" in "Software Engineer, Backend",
 * "Software Engineer (Backend)", "Software Engineer - Backend Platform",
 * "Engineer II, Backend Platform" - are added as qualifiers of weight 2, less
 * the level numerals, the words of `TAIL_NOISE`, those the kind already has and
 * those that are a single-word term of the posting itself (the "(Go,
 * Kubernetes)" of a title is scored as the terms it is, not twice).
 */
function jobTitles(job: MatchJob, fromText = false, termWords: ReadonlySet<string> = new Set()): JobTitle[] {
  const given = [job.analysis?.jobMeta?.title, job.title].filter(
    (title): title is string => typeof title === 'string' && title.trim() !== ''
  );
  const named = given.length > 0 || !fromText ? given : [openingTitle(job.analysis?.sourceJobDescription || job.text)];
  const seen = new Set<string>();
  const titles: JobTitle[] = [];
  for (const title of named) {
    const kind = title ? roleKind(title) : '';
    const parts = kind ? kindWords(kind) : [];
    if (parts.length === 0) continue;
    // The last word is the head and counts 1; every qualifier counts 2, "software" 1.
    const weights = parts.map((part, index) => (index === parts.length - 1 || GENERIC_QUALIFIERS.has(part) ? 1 : 2));
    const tail: string[] = [];
    for (const segment of roleTail(title)) {
      for (const word of kindWords(segment)) {
        if (parts.includes(word) || tail.includes(word) || LEVEL_WORDS.has(word) || TAIL_NOISE.has(word) || termWords.has(word)) continue;
        tail.push(word);
      }
    }
    const words = [...parts, ...tail];
    const key = words.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    const mainTotal = weights.reduce((sum, weight) => sum + weight, 0);
    titles.push({
      words,
      weights: [...weights, ...tail.map(() => 2)],
      total: mainTotal + 2 * tail.length,
      mainCount: parts.length,
      mainTotal,
    });
  }
  return titles;
}

const kindWordSets = new Map<string, Set<string>>();

function wordSetOf(kind: string): Set<string> {
  let set = kindWordSets.get(kind);
  if (!set) {
    set = new Set(kindWords(kind));
    if (kindWordSets.size > 5000) kindWordSets.clear();
    kindWordSets.set(kind, set);
  }
  return set;
}

/**
 * The weight of the posting's kind that `kind` says: the words of `title` that
 * `kind` also has, each at its weight - the kind's own words alone with
 * `mainOnly`, which is what "the title says the whole kind" is decided on.
 */
function matchedWeight(title: JobTitle, kind: string, mainOnly = false): number {
  const have = wordSetOf(kind);
  let matched = 0;
  title.words.forEach((word, index) => {
    if (mainOnly && index >= title.mainCount) return;
    if (have.has(word)) {
      matched += title.weights[index];
      return;
    }
    // Kin count half.
    for (const [first, second] of KIN_WORDS) {
      const kin = word === first ? second : word === second ? first : null;
      if (kin !== null && have.has(kin)) {
        matched += title.weights[index] / 2;
        return;
      }
    }
  });
  return matched;
}

/** T for one posting kind: 70% the best headline kind, 30% the best held title; a part missing is left out. */
function titleAffinity(
  keywords: ResumeKeywords,
  title: JobTitle
): { affinity: number; strict: number; whole: boolean } {
  const best = (kinds: readonly string[]) =>
    kinds.reduce((top, kind) => Math.max(top, matchedWeight(title, kind)), 0);
  const headline = keywords.headline.length > 0 ? best(keywords.headline) / title.total : null;
  const roles = keywords.roleTitles.length > 0 ? best(keywords.roleTitles) / title.total : null;
  // "Whole" is the kind's own words, not the tail's: a "Software Engineer, Backend" is titled for by a resume that says
  // "Software Engineer", though it says nothing of Backend.
  const bestMain = (kinds: readonly string[]) =>
    kinds.reduce((top, kind) => Math.max(top, matchedWeight(title, kind, true)), 0);
  const whole = bestMain(keywords.headline) === title.mainTotal || bestMain(keywords.roleTitles) === title.mainTotal;
  // `strict` counts a part the resume does not have as NOTHING (the score
  // itself leaves it out, so a bare resume that lists one matching old role
  // scores as high as a specialist whose headline and roles both match). It
  // only breaks a tie, after precision.
  const strict = HEADLINE_SHARE * (headline ?? 0) + (1 - HEADLINE_SHARE) * (roles ?? 0);
  if (headline !== null && roles !== null) return { affinity: HEADLINE_SHARE * headline + (1 - HEADLINE_SHARE) * roles, strict, whole };
  return { affinity: headline ?? roles ?? 0, strict, whole };
}

/* ================================================================ the posting */

/** One reading of a posting term: the term itself, or one of the alternatives it spells ("Go" of "Go (Golang)"). */
type Alternative = { info: TermInfo; rows: readonly number[] };

type PostingTerm = {
  /** The term as the posting spells it: what the explanation shows and the dedupe is by. */
  info: TermInfo;
  weight: number;
  core: boolean;
  /** The readings scored; a resume's factor is the best of them. `[the term itself]` for a plain term. */
  alternatives: readonly Alternative[];
};

const MAX_ALTERNATIVES = 6;

/**
 * The alternatives an ANALYSIS term spells: "Go (Golang)" is Go or Golang,
 * "Go/Golang" and "Golang or Go" likewise, "Kubernetes (K8s)" both. Split at a
 * bracket, " or " and "/" - unless the whole term is a vocabulary entry
 * ("CI/CD", "TCP/IP", "A/B testing") - and the term itself is always one of the
 * readings, so "CI/CD pipelines" still names its concept. Pieces without a
 * letter ("24/7") and repeats are dropped; at most six readings.
 */
function alternativeSpellings(spelling: string): string[] {
  if (isVocabularyTerm(spelling)) return [spelling];
  const pieces = spelling
    .split(/[()]|\s+or\s+|\//i)
    .map((piece) => piece.replace(/\s+/g, ' ').trim())
    .filter((piece) => /\p{L}/u.test(piece) && piece.toLowerCase() !== spelling.toLowerCase());
  if (pieces.length === 0) return [spelling];
  const seen = new Set<string>([spelling.toLowerCase()]);
  const alternatives = [spelling];
  for (const piece of pieces) {
    const key = piece.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    alternatives.push(piece);
    if (alternatives.length >= MAX_ALTERNATIVES) break;
  }
  return alternatives;
}

function alternativeOf(info: TermInfo): Alternative {
  return { info, rows: namedRows(info) };
}

function postingTerm(spelling: string, weight: number, core: boolean): PostingTerm {
  const info = describeTerm(spelling);
  const [, ...others] = alternativeSpellings(info.spelling);
  const whole = alternativeOf(info);
  return { info, weight, core, alternatives: [whole, ...others.map((other) => alternativeOf(describeTerm(other)))] };
}

/** An analysis' terms with their weights: core 3 (the five and the must-include), skills 2, concepts and domain 1. */
function analysisPosting(analysis: JobAnalysis): PostingTerm[] {
  const { posting, skills, concepts, topSkills } = postingTermLists(analysis);
  const ordered: Array<[readonly string[], number, boolean]> = [
    [topSkills, 3, true],
    [posting.mustInclude, 3, true],
    [skills, 2, false],
    [concepts, 1, false],
    [posting.domainKnowledge, 1, false],
  ];
  // Listed from the heaviest tier down, so a term in several lists keeps the highest weight.
  const seen = new Set<string>();
  const terms: PostingTerm[] = [];
  for (const [list, weight, core] of ordered) {
    for (const spelling of list) {
      const term = postingTerm(spelling, weight, core);
      if (!term.info.first || seen.has(term.info.synonym)) continue;
      seen.add(term.info.synonym);
      terms.push(term);
    }
  }
  return terms;
}

function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/** The terms a posting's text names: the vocabulary's and the candidates' own, weighted by where they are. */
function textPosting(text: string, title: string | undefined, candidates: CandidateSet): PostingTerm[] {
  if (!text.trim()) return [];
  const runs = alnumRuns(text);
  const found = new Map<string, { info: TermInfo; index: number }>();
  for (const hit of scanVocabulary(text, runs)) {
    if (!found.has(hit.term.synonym)) found.set(hit.term.synonym, { info: hit.term, index: hit.index });
  }
  // "payments" is in nobody's vocabulary but may be on a resume: the candidates' terms the text names count too.
  for (const run of runs) {
    for (const at of candidates.byFirst.get(run) ?? []) {
      const info = candidates.terms[at];
      if (found.has(info.synonym)) continue;
      const index = termIndexIn(info, text);
      if (index !== -1) found.set(info.synonym, { info, index });
    }
  }

  const titleText = [title ?? '', firstLine(text)].filter(Boolean).join('\n');
  const titleRuns = new Set(alnumRuns(titleText));
  const required = requirementsText(text);
  const requiredRuns = new Set(alnumRuns(required));
  return [...found.values()]
    .sort((a, b) => a.index - b.index)
    .map(({ info }) => {
      const weight =
        titleRuns.has(info.first) && termIndexIn(info, titleText) !== -1
          ? 3
          : requiredRuns.has(info.first) && termIndexIn(info, required) !== -1
            ? 2
            : 1;
      return { info, weight, core: weight >= 2, alternatives: [alternativeOf(info)] };
    });
}

/* ============================================================== the candidates */

/**
 * The distinct terms of a set of candidates, indexed every way the factors
 * look them up, so a posting term finds the resume terms it relates to by a
 * few Map reads instead of a test against each of the (up to 25 x 80) terms.
 */
type CandidateSet = {
  keywords: ResumeKeywords[];
  terms: TermInfo[];
  /** Candidate positions holding each term. */
  owners: number[][];
  byKey: Map<string, number[]>;
  byRun: Map<string, number[]>;
  byFirst: Map<string, number[]>;
  aliasOf: Map<number, number[]>;
  toolOf: Map<number, number[]>;
  /** Term indexes of each candidate. */
  held: number[][];
};

function pushTo<K>(map: Map<K, number[]>, key: K, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function buildCandidateSet(keywords: ResumeKeywords[]): CandidateSet {
  const set: CandidateSet = {
    keywords,
    terms: [],
    owners: [],
    byKey: new Map(),
    byRun: new Map(),
    byFirst: new Map(),
    aliasOf: new Map(),
    toolOf: new Map(),
    held: keywords.map(() => []),
  };
  const indexOf = new Map<string, number>();
  keywords.forEach((candidate, position) => {
    for (const spelling of candidate.terms) {
      let at = indexOf.get(spelling);
      if (at === undefined) {
        const info = describeTerm(spelling);
        if (!info.first) continue;
        at = set.terms.length;
        indexOf.set(spelling, at);
        set.terms.push(info);
        set.owners.push([]);
        pushTo(set.byKey, info.synonym, at);
        for (const run of info.runs) pushTo(set.byRun, run, at);
        pushTo(set.byFirst, info.first, at);
        // A term that names a concept row ("continuous integration pipelines") stands for it like an alias.
        for (const row of new Set([...info.aliasRows, ...namedRows(info)])) pushTo(set.aliasOf, row, at);
        for (const row of info.toolRows) pushTo(set.toolOf, row, at);
      }
      if (!set.owners[at].includes(position)) {
        set.owners[at].push(position);
        set.held[position].push(at);
      }
    }
  });
  return set;
}

const candidateSets = new WeakMap<readonly MatchCandidate[], CandidateSet>();

/** The candidates' index, kept for the array it was built for while every resume's keywords are the ones it was built from. */
function candidateSetFor(candidates: readonly MatchCandidate[]): CandidateSet {
  const keywords = candidates.map((candidate) => matchKeywordsOf(candidate.resume));
  const known = candidateSets.get(candidates);
  if (known && known.keywords.length === keywords.length && known.keywords.every((item, at) => item === keywords[at])) {
    return known;
  }
  const built = buildCandidateSet(keywords);
  candidateSets.set(candidates, built);
  return built;
}

/* ================================================================== scoring */

type Posting = { terms: PostingTerm[]; basis: Basis; titles: JobTitle[] };

function postingFor(job: MatchJob, candidates: CandidateSet): Posting {
  let terms: PostingTerm[] = [];
  let basis: Basis = 'none';
  if (job.analysis) {
    terms = analysisPosting(job.analysis);
    if (terms.length > 0) basis = 'analysis';
  }
  if (terms.length === 0) {
    // No analysis, or one that names nothing: the text it was made from, else the caller's.
    const text = (job.analysis?.sourceJobDescription || job.text) ?? '';
    terms = textPosting(typeof text === 'string' ? text : '', job.title, candidates);
    if (terms.length > 0) basis = 'text';
  }
  // A word of the title's tail that is one of the terms ("(Go, Kubernetes)") is scored as that term, not as a qualifier.
  const termWords = new Set(terms.flatMap((term) => (term.info.runs.length === 1 ? term.info.runs : [])));
  let titles = jobTitles(job, false, termWords);
  if (terms.length === 0 && titles.length === 0) {
    // Nothing named and no role given: the posting's opening line may be its
    // title. Used ONLY here, where there is nothing else to decide by - a
    // posting with terms is scored on them as it always was.
    titles = jobTitles(job, true);
  }
  if (terms.length === 0 && titles.length > 0) basis = 'title';
  return { terms, basis, titles };
}

/** The best factor each candidate reaches for each posting term, and which candidate terms the posting names at all. */
function factorsFor(posting: PostingTerm[], set: CandidateSet): { best: Float64Array[]; named: Uint8Array } {
  const best = set.keywords.map(() => new Float64Array(posting.length));
  const named = new Uint8Array(set.terms.length);
  posting.forEach((term, at) => {
    const give = (indexes: readonly number[] | undefined, factor: number) => {
      if (!indexes) return;
      for (const index of indexes) {
        named[index] = 1;
        for (const owner of set.owners[index]) if (best[owner][at] < factor) best[owner][at] = factor;
      }
    };
    // Each alternative the term spells ("Go" and "Golang" of "Go (Golang)") is scored on its own; `give` keeps the best.
    for (const { info, rows } of term.alternatives) {
      give(set.byKey.get(info.synonym), 1);
      // A one- or two-character term is an exact match only: "C" is not "C++", "Go" is not in "Gopher".
      if (info.spelling.length > 2 && info.loose) {
        const inside = (set.byRun.get(info.first) ?? []).filter((index) => info.loose!.test(set.terms[index].spelling));
        give(inside, 1);
      }
      for (const run of info.runs) {
        const contained = (set.byFirst.get(run) ?? []).filter((index) => {
          const other = set.terms[index];
          return other.spelling.length > 2 && other.loose !== null && other.loose.test(info.spelling);
        });
        give(contained, 0.6);
      }
      for (const row of rows) {
        give(set.aliasOf.get(row), 0.8);
        give(set.toolOf.get(row), 0.5);
      }
    }
  });
  return { best, named };
}

function scoreAll(job: MatchJob, set: CandidateSet): ResumeScore[] {
  const posting = postingFor(job, set);
  const { best, named } = factorsFor(posting.terms, set);
  return set.keywords.map((keywords, position) => {
    const factors = best[position];
    let coreSum = 0;
    let coreTotal = 0;
    let restSum = 0;
    let restTotal = 0;
    const matched: Array<{ spelling: string; value: number; order: number }> = [];
    posting.terms.forEach((term, at) => {
      const factor = factors[at];
      if (term.core) {
        coreTotal += term.weight;
        coreSum += term.weight * factor;
      } else {
        restTotal += term.weight;
        restSum += term.weight * factor;
      }
      if (factor > 0) matched.push({ spelling: term.info.spelling, value: term.weight * factor, order: at });
    });
    const recall =
      coreTotal > 0 && restTotal > 0
        ? CORE_SHARE * (coreSum / coreTotal) + (1 - CORE_SHARE) * (restSum / restTotal)
        : coreTotal > 0
          ? coreSum / coreTotal
          : restTotal > 0
            ? restSum / restTotal
            : 0;

    let affinity = 0;
    let strict = 0;
    let titleMatched = false;
    for (const title of posting.titles) {
      const result = titleAffinity(keywords, title);
      affinity = Math.max(affinity, result.affinity);
      strict = Math.max(strict, result.strict);
      if (result.whole) titleMatched = true;
    }

    const hasTerms = posting.terms.length > 0;
    const hasTitles = posting.titles.length > 0;
    const score = hasTerms && hasTitles
      ? TITLE_WEIGHT * affinity + RECALL_WEIGHT * recall
      : hasTerms
        ? recall
        : hasTitles
          ? affinity
          : 0;

    const held = set.held[position];
    const precision = held.length === 0 ? 0 : held.reduce((count, index) => count + named[index], 0) / held.length;
    matched.sort((a, b) => b.value - a.value || a.order - b.order);
    return {
      score,
      titleMatched,
      matched: matched.slice(0, MAX_MATCHED).map((item) => item.spelling),
      matchedCount: matched.length,
      postingTermCount: posting.terms.length,
      basis: posting.basis,
      precision,
      strict,
    };
  });
}

/**
 * One resume's score for a job, on its own: the posting's terms from its
 * analysis, else from its text, the resume's own terms counting among the ones
 * a text names. Scores of the text path are comparable among resumes scored
 * TOGETHER (`chooseForJob`), since the terms the text names include theirs.
 */
export function scoreResumeForJob(keywords: ResumeKeywords, job: MatchJob): ResumeScore {
  return scoreAll(job, buildCandidateSet([keywords]))[0];
}

/* ================================================================== choosing */

const SCORE_SCALE = 1e6;

function rounded(score: number): number {
  return Math.round(score * SCORE_SCALE);
}

function candidateOrder(
  a: { candidate: MatchCandidate; result: ResumeScore },
  b: { candidate: MatchCandidate; result: ResumeScore }
): number {
  return (
    rounded(b.result.score) - rounded(a.result.score) ||
    Number(b.candidate.isDefault) - Number(a.candidate.isDefault) ||
    Math.round(b.result.precision * 1e9) - Math.round(a.result.precision * 1e9) ||
    Math.round(b.result.strict * 1e9) - Math.round(a.result.strict * 1e9) ||
    compareText(b.candidate.resume.updatedAt ?? '', a.candidate.resume.updatedAt ?? '') ||
    compareText(a.candidate.resume.id, b.candidate.resume.id)
  );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The resume of `candidates` (the profile's ENABLED resumes) to build for a
 * job, and why. Fully Tailor builds the effective default by rule; one
 * candidate is the only choice; otherwise the highest score wins and a shared
 * top score goes to the default, then the more precise, the newer, the lower id.
 * Nothing matching at all is such a tie: the default is built.
 *
 * `mode` is recorded on the match so an order item says what it was chosen for.
 */
export function chooseForJob(
  job: MatchJob,
  candidates: readonly MatchCandidate[],
  mode: BuildMode
): { resume: Resume; match: TaskMatch } {
  if (candidates.length === 0) throw new Error('chooseForJob needs at least one candidate resume.');
  const count = candidates.length;

  if (mode === 'full' || count === 1) {
    const reason = mode === 'full' ? 'default' : 'only';
    const pick =
      [...candidates].sort(
        (a, b) =>
          Number(b.isDefault) - Number(a.isDefault) ||
          compareText(b.resume.updatedAt ?? '', a.resume.updatedAt ?? '') ||
          compareText(a.resume.id, b.resume.id)
      )[0];
    return { resume: pick.resume, match: { v: 1, mode, reason, candidates: count } };
  }

  const results = scoreAll(job, candidateSetFor(candidates));
  const ranked = candidates.map((candidate, at) => ({ candidate, result: results[at] })).sort(candidateOrder);
  const [winner, runnerUp] = ranked;
  const top = rounded(winner.result.score);
  const shared = top === 0 || (runnerUp !== undefined && rounded(runnerUp.result.score) === top);
  const { result } = winner;
  return {
    resume: winner.candidate.resume,
    match: {
      v: 1,
      mode,
      reason: shared ? 'tie' : 'matched',
      candidates: count,
      basis: result.basis,
      score: Math.round(result.score * 1e4) / 1e4,
      titleMatched: result.titleMatched,
      matched: result.matched,
      matchedCount: result.matchedCount,
      postingTermCount: result.postingTermCount,
    },
  };
}
