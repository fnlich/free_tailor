import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { CONCEPT_TOOLS, termPattern } from '../config/conceptTools';
import type { Resume } from '../types/resume';
import { isCompanyDescriptionLike, roleKind } from './tailorContract';

/**
 * A resume's keywords: the technologies, tools and concepts it claims, and the
 * kinds of role it is titled for. The matcher (services/resumeMatch.ts) reads
 * them to choose the suitable resume of a profile for a posting.
 *
 * COMPUTED, never stored: `keywordsOf` is pure, `matchKeywordsOf` memoises it
 * (512 entries, keyed by the resume's id, its `updatedAt` and
 * `KEYWORDS_VERSION`) and writes nothing back - a read that saved would upsert
 * the whole document and could overwrite a concurrent edit with an older copy.
 * They are served on GET /api/resumes (routes/resumes.ts) and nowhere else:
 * not read from a body, not in an export, not in the prompt's JSON, not in the
 * tailoring cache's key. Nothing here touches the database or the network.
 *
 * Where the terms come from, in this order:
 *
 *   1. CURATED - what the person typed: the resume's `skills` and each role's
 *      `skills`, spelled as the shipped list spells them (`go` is `Go`). They
 *      are never displaced and need no prose rule.
 *   2. SCANNED - the technologies the prose names, in first-appearance order:
 *      the resume's own words (the same fields the revise pass reads as
 *      evidence, less the soft skills) searched for the SHIPPED skill list
 *      (`backend/static/skills/skills.json`, the hard skills) and the concept
 *      table's tools and aliases. Never the live skill library: any builder can
 *      add to that one (POST /resume/skills/confirm), which would make one
 *      account's keywords depend on another's actions - the tailoring cache
 *      follows the same rule. A sentence about the COMPANY ("Acme is a fintech
 *      platform built on Kafka.") is left out, by the same test the tailoring
 *      prompt's `companyContext` uses.
 *   3. TITLES - `headline` and `roleTitles`, the KIND of role each names
 *      (`roleKind`: levels taken off the edges).
 *
 * The shipped list holds everyday English words (Kind, Less, Express, Spring,
 * Swift, Echo, Hack, Logs, Math), so a name is found in prose only by a rule
 * for its shape - the "class" of the entry:
 *
 *   one character (C, R)                       never in prose; curated only
 *   two letters (Go, Nx, jq; aliases CI, ML)   exact case, not where a
 *                                              sentence or bullet starts unless it
 *                                              reads as a list item or a requirement
 *                                              (below), not before a hyphen ("Go-live")
 *   two characters with a digit/symbol (C#, S3) exact case
 *   one word of letters, Title-case (Express)  exact case; at a sentence start
 *                                              only if it is NOT an everyday word
 *                                              (`SENTENCE_START_AMBIGUOUS`: Express,
 *                                              Spring, Swift, Testing...)
 *   one word of letters, lower or UPPER (curl, REST) exact case
 *   anything else (Node.js, CI/CD, gRPC, "unit testing", a concept alias of
 *   three characters or more that is not ALL-CAPS)  any case, whole word
 *
 * A sentence starts at the text's start, after a line break (and an optional
 * bullet) or after `.`, `!` or `?` and a space; `:` and `,` do not end one, so
 * "Nice to have: Terraform" counts. A requirement list with one technology per
 * line or bullet ("- Python", "Kubernetes", "1. Terraform") and "(e.g. Docker)"
 * or "etc. Python" all start a "sentence" in that sense, so a Title-case name
 * is refused there only when it is also an everyday word. Even a refused name
 * (Go, TS, Swift, Node...) is taken at such a start when it reads as a list
 * item or a requirement (`readsAsListItemOrRequirement`): it is the whole line
 * ("- Go", "1. Swift"), another technology follows a list separator ("Go,
 * Docker", "Go/Docker", "Swift and Objective-C", "TS or JS"), or a requirement
 * cue follows ("Swift required.", "Node is a plus"). The same key from
 * several sources takes the most permissive class and the spelling of the
 * shipped list, else the tool's, else the alias's.
 *
 * The vocabulary is the shipped list, the concept table's tools and aliases
 * AND every spelling of `TERM_SYNONYMS` (K8s, Golang, Node, NodeJS, Vue,
 * Mongo, Amazon Web Services, TS, sklearn...), each with the class its own
 * shape earns; a spelling found in a text is that thing's term, and its
 * `synonymKey` is the canonical one's.
 *
 * Three refinements, each of which a posting or a resume needs:
 *   - a short closed list of names that are no English word (`SAFE_ANY_CASE`:
 *     Docker, Kubernetes, Python...) is read in any case, for the casual or
 *     all-capitals posting;
 *   - a name inside a LONGER name is not a hit of its own: "CI" in "CI/CD",
 *     "GitHub" in "GitHub Actions" (a standalone mention elsewhere still is);
 *   - a name inside a company's ("American Express") or the clearance "TS/SCI"
 *     is not a hit.
 */

/** Bumped by hand whenever the extraction below changes what it answers for the same resume. */
export const KEYWORDS_VERSION = 4;

/** At most this many terms; curated ones come first and are never displaced by scanned ones. */
const MAX_KEYWORD_TERMS = 80;
const MAX_KEYWORD_LENGTH = 60;
const MAX_ROLE_TITLES = 12;
const MAX_HEADLINE_KINDS = 4;
/** `matchKeywordsOf`'s memo. */
export const MATCH_KEYWORDS_CACHE_SIZE = 512;
/** The normaliser's placeholder for a resume with no headline (resumeDocument.ts). */
const PLACEHOLDER_HEADLINE = 'professional';

export type ResumeKeywords = {
  version: number;
  /** First 16 hex of a hash over the vocabulary's entries, their classes and the synonym groups. */
  vocabulary: string;
  /** Hash of exactly the fields read, so a test (or a person) can tell what changed. */
  basedOn: string;
  /** The kind of role the headline names; [] for none (or the normaliser's placeholder). */
  headline: string[];
  /** The kind of role each held title names, in resume order, repeats dropped, at most 12. */
  roleTitles: string[];
  terms: string[];
};

/* ================================================================ spelling */

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Whitespace collapsed and trimmed; case kept at two characters or fewer, else lower case (`termPattern`'s own rule). */
function matchKey(term: string): string {
  const collapsed = collapse(term);
  return collapsed.length <= 2 ? collapsed : collapsed.toLowerCase();
}

/**
 * Spellings of one thing. A closed list in code, like config/conceptTools.ts:
 * two spellings of one technology are one term for the dedupe and the matcher.
 */
export const TERM_SYNONYMS: ReadonlyArray<readonly string[]> = [
  ['Go', 'Golang'],
  ['Kubernetes', 'K8s'],
  ['PostgreSQL', 'Postgres'],
  ['Node.js', 'NodeJS', 'Node'],
  ['React', 'React.js', 'ReactJS'],
  ['Vue.js', 'Vue', 'VueJS'],
  ['Next.js', 'NextJS'],
  ['JavaScript', 'JS', 'ES6'],
  ['TypeScript', 'TS'],
  ['HTML', 'HTML5'],
  ['CSS', 'CSS3'],
  ['Python', 'Python3'],
  ['AWS', 'Amazon Web Services'],
  ['GCP', 'Google Cloud', 'Google Cloud Platform'],
  ['Azure', 'Microsoft Azure'],
  ['C#', 'CSharp'],
  ['.NET', 'dotnet'],
  ['CI/CD', 'CICD'],
  ['MongoDB', 'Mongo'],
  ['Amazon S3', 'S3'],
  ['Apache Kafka', 'Kafka'],
  ['Apache Spark', 'Spark'],
  ['Apache Airflow', 'Airflow'],
  ['scikit-learn', 'sklearn'],
];

const SYNONYM_GROUP = new Map<string, string>();
const SYNONYM_GROUP_LOWER = new Map<string, string>();
for (const group of TERM_SYNONYMS) {
  const id = matchKey(group[0]);
  for (const spelling of group) {
    SYNONYM_GROUP.set(matchKey(spelling), id);
    SYNONYM_GROUP_LOWER.set(spelling.toLowerCase(), id);
  }
}

/** The key two spellings of one thing share: their group's, else `matchKey`. */
export function synonymKey(term: string): string {
  const key = matchKey(term);
  return SYNONYM_GROUP.get(key) ?? SYNONYM_GROUP_LOWER.get(collapse(term).toLowerCase()) ?? key;
}

/** The distinct `[A-Za-z0-9]+` runs of a text, lower-cased: what a whole-word match of any term must contain. */
export function alnumRuns(text: string): string[] {
  const runs = text.match(/[A-Za-z0-9]+/g);
  return runs ? [...new Set(runs.map((run) => run.toLowerCase()))] : [];
}

function firstRun(term: string): string {
  const run = /[A-Za-z0-9]+/.exec(term);
  return run ? run[0].toLowerCase() : '';
}

/* ================================================================== classes */

type TermClass = 'never' | 'two' | 'title' | 'symbol' | 'exact' | 'any';
type TermSource = 'library' | 'tool' | 'alias';

const CLASS_RANK: Record<TermClass, number> = { never: 0, two: 1, title: 2, symbol: 3, exact: 3, any: 4 };
const SOURCE_RANK: Record<TermSource, number> = { library: 3, tool: 2, alias: 1 };

function classify(spelling: string, source: TermSource): TermClass {
  if (spelling.length <= 1) return 'never';
  if (spelling.length === 2) return /^\p{L}{2}$/u.test(spelling) ? 'two' : 'symbol';
  if (!/^\p{L}+$/u.test(spelling)) return 'any';
  const upper = spelling === spelling.toUpperCase();
  const lower = spelling === spelling.toLowerCase();
  // A concept alias of three characters or more that is not ALL-CAPS ("monitoring") is a phrase in any case.
  if (source === 'alias') return upper ? 'exact' : 'any';
  if (upper || lower) return 'exact';
  return /^\p{Lu}\p{Ll}+$/u.test(spelling) ? 'title' : 'any';
}

/**
 * Names that are not everyday English words, found in any case. Deliberately
 * short and closed: lower-case "react", "express", "rust", "spring", "kind" are
 * ordinary words, and so are "snowflake" and "airflow", so none of those is here.
 * (Keys as `matchKey` spells them: lower case.)
 */
const SAFE_ANY_CASE: ReadonlySet<string> = new Set([
  'kubernetes',
  'docker',
  'terraform',
  'python',
  'postgres',
  'postgresql',
  'kafka',
  'ansible',
  'jenkins',
  'golang',
  'redis',
  'linux',
  'grafana',
  'prometheus',
  'mongodb',
]);

/**
 * The Title-case names of the 'title' class that are also everyday words (or
 * first names, places, companies), refused where a sentence, line, bullet or
 * numbered item starts: "Kind regards", "Express yourself", "Spring is here",
 * "Swift Developer wanted", "Testing is hard", "Analysis of the requirements".
 * Anywhere else in a sentence ("built Express APIs", "Stack: Spring") they are
 * the technologies, and at a start too when they read as a list item or a
 * requirement ("- Node", "Swift required."). Every other Title-case name (Python, Kubernetes, Terraform,
 * Helm, Kafka, Redis, Snowflake, Airflow, Spark...) IS taken at a sentence
 * start, because a requirement list names one technology per line.
 *
 * Hand-curated (design G2 had no such list: it refused the whole class there).
 * Made by reading all the 'title'-class entries of the shipped list and the
 * concept table, and the Title-case spellings of `TERM_SYNONYMS`, for words that
 * open ordinary sentences: (1) everyday English words and names, (2) generic
 * practices whose name is a gerund or a plain noun (Testing, Automation,
 * Statistics, Migrations, Transactions...). A word here that the vocabulary
 * lacks is harmless - it is kept so that a skill added to the shipped list
 * later does not flip. Lower-case keys. test/resumeKeywords.test.js pins the
 * whole list, so changing it is a decision with a diff.
 */
export const SENTENCE_START_AMBIGUOUS: ReadonlySet<string> = new Set([
  // Everyday words, names and places.
  'ada', 'aurora', 'bamboo', 'beam', 'behave', 'bun', 'calico', 'chef', 'chroma', 'confluent', 'consul', 'copilot',
  'crystal', 'doppler', 'echo', 'ember', 'emotion', 'envoy', 'expo', 'express', 'falcon', 'fiber', 'flux', 'gin',
  'hack', 'harbor', 'hive', 'honeycomb', 'hugo', 'insomnia', 'jasmine', 'julia', 'kind', 'kong', 'less', 'lighthouse',
  'lit', 'monolith', 'node', 'nomad', 'packer', 'parcel', 'phoenix', 'pony', 'prettier', 'presto', 'puppet', 'realm',
  'relay', 'remix', 'render', 'ribbon', 'rocket', 'scheme', 'sed', 'semaphore', 'sentry', 'spring', 'split',
  'swift', 'temporal', 'unleash', 'vapor', 'varnish', 'vault', 'warp', 'waterfall', 'zig',
  'apex', 'artillery', 'assembly',
  // Generic practices and concepts named by a plain noun or gerund.
  'analysis', 'automation', 'benchmarking', 'blockchain', 'closures', 'clustering', 'compression', 'concurrency',
  'cybersecurity', 'debugging', 'denormalization', 'deserialization', 'encryption', 'generics', 'hashing',
  'idempotency', 'immutability', 'indexing', 'infrastructure', 'linting', 'logs', 'macros', 'math', 'metaprogramming',
  'migrations', 'mocking', 'namespaces', 'normalization', 'pagination', 'paging', 'parallelism', 'partitioning',
  'promises', 'quantization', 'queuing', 'refactoring', 'reflection', 'replication', 'runbooks', 'serialization',
  'sharding', 'spying', 'statistics', 'streams', 'stubbing', 'subnets', 'subnetting', 'testing', 'threading',
  'throttling', 'traceability', 'transactions', 'triggers', 'vector', 'webhooks',
]);

/** `termPattern`'s body, global; case-insensitive only for the class that reads any case. */
function classPattern(term: string, cls: TermClass): RegExp | null {
  if (cls === 'never') return null;
  const base = termPattern(term, true);
  return base ? new RegExp(base.source, cls === 'any' ? 'gi' : 'g') : null;
}

/** Whether a match at `index` is at the start of a sentence or bullet. */
function atSentenceStart(text: string, index: number): boolean {
  const blank = (char: string | undefined) => char === ' ' || char === '\t' || char === ' ';
  let at = index - 1;
  while (at >= 0 && blank(text[at])) at -= 1;
  if (at < 0) return true;
  const char = text[at];
  if (char === '\n' || char === '\r') return true;
  if (char === '-' || char === '*' || char === '•' || char === '·') {
    let before = at - 1;
    while (before >= 0 && blank(text[before])) before -= 1;
    return before < 0 || text[before] === '\n' || text[before] === '\r';
  }
  return (char === '.' || char === '!' || char === '?') && at < index - 1;
}

/** Only a bullet or number marker (or nothing) lies between the line's start and `index`. */
const LINE_PREFIX_MARKER = /^[ \t ]*(?:[-*•·]|\d{1,3}[.)])?[ \t ]*$/;
/** What may follow a term that is the whole item of a line: a note in brackets, a stray `,` `;` or `.`. */
const LINE_REST_ITEM = /^[ \t ]*(?:\([^)\n]{0,40}\))?[ \t ]*[,;.]?[ \t ]*(?:\r?\n|$)/;
/** A list separator and the word after it: `, X`  `/X`  ` / X`  ` and X`  ` or X`  ` & X`. */
const LIST_SEPARATOR = /^(?:[ \t]*[,;/][ \t]*|[ \t]+(?:and|or|&)[ \t]+)([A-Za-z0-9]+)/i;
/** A skills line with years: `Go: 3 years`. */
const LIST_YEARS = /^:[ \t]*\d/;
/**
 * The word after a term that makes it a requirement: "Swift required.", "Go
 * experience", "Node is a plus", "TS preferred". "developer(s)" and
 * "development" are NOT cues: "Swift Developer wanted" and "Go developer" are
 * prose about a person, which a title-case name must not start.
 */
const REQUIREMENT_CUE =
  /^[ \t]+(?:(?:is|are)[ \t]+)?(?:a[ \t]+)?(?:required|requirements?|experience[d]?|preferred|proficiency|proficient|knowledge|expertise|skills?|plus|desired|background|fluency|fluent|familiarity)\b/i;

/** Whether `word`, spelled as written, is the first word of a vocabulary entry read in that case ("JS", "Rust", "Objective"). */
function namesATechnology(word: string): boolean {
  for (const entry of vocabulary().scan.get(word.toLowerCase()) ?? []) {
    // A name read in any case ("docker") is itself the word; a longer one ("Go modules") only by its first word's own spelling.
    if (entry.cls === 'any' && /^[A-Za-z0-9]+$/.test(entry.term)) return true;
    if (/^[A-Za-z0-9]+/.exec(entry.term)?.[0] === word) return true;
  }
  return false;
}

/**
 * A term the sentence-start rule would refuse that nevertheless reads as a list
 * item or a requirement: (a) the whole line after an optional bullet or number
 * ("- Go", "1. Swift", "TS"); (b) a list separator and another technology next
 * ("Go, Docker", "Go/Docker", "Swift and Objective-C", "TS or JS", "Go: 3 years");
 * (c) a requirement cue next ("Swift required.", "Node is a plus"). "Kind
 * regards", "Swift reply", "Go to market", "Swift Developer wanted" and
 * "Express yourself" are none of them.
 */
function readsAsListItemOrRequirement(text: string, index: number, length: number): boolean {
  const end = index + length;
  const after = text.slice(end, end + 80);
  const lineStart = Math.max(text.lastIndexOf('\n', index - 1), text.lastIndexOf('\r', index - 1)) + 1;
  if (LINE_PREFIX_MARKER.test(text.slice(lineStart, index)) && LINE_REST_ITEM.test(after)) return true;
  const separated = LIST_SEPARATOR.exec(after);
  if (separated && namesATechnology(separated[1])) return true;
  if (LIST_YEARS.test(after)) return true;
  return REQUIREMENT_CUE.test(after);
}

function accepted(cls: TermClass, text: string, index: number, length: number): boolean {
  if (cls === 'two') {
    if (text[index + length] === '-') return false;
    return !atSentenceStart(text, index) || readsAsListItemOrRequirement(text, index, length);
  }
  if (cls === 'title') {
    if (!atSentenceStart(text, index) || !SENTENCE_START_AMBIGUOUS.has(text.slice(index, index + length).toLowerCase())) return true;
    return readsAsListItemOrRequirement(text, index, length);
  }
  return true;
}

/** Where the first match of `pattern` that its class accepts begins, -1 for none. */
function firstAccepted(pattern: RegExp, cls: TermClass, text: string): number {
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (accepted(cls, text, match.index, match[0].length)) return match.index;
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return -1;
}

/* ================================================================ vocabulary */

type VocabularyEntry = {
  term: string;
  key: string;
  cls: TermClass;
  first: string;
  pattern: RegExp | null;
  aliasRows: number[];
  toolRows: number[];
};

type AliasProbe = { row: number; pattern: RegExp };

type Vocabulary = {
  entries: Map<string, VocabularyEntry>;
  lower: Map<string, VocabularyEntry>;
  /** First alphanumeric run (lower case) -> the entries a text holding that run may name. */
  scan: Map<string, VocabularyEntry[]>;
  /** First run of a concept alias -> the alias's row and pattern. */
  aliases: Map<string, AliasProbe[]>;
  hash: string;
};

const SHIPPED_SKILLS_FILE = path.join(__dirname, '..', '..', 'static', 'skills', 'skills.json');

let libraryOverride: readonly string[] | null = null;
let fileOverride: string | null = null;
let vocabularyMemo: Vocabulary | null = null;
let warnedUnreadable = false;

function readShippedSkills(): string[] {
  const file = fileOverride ?? SHIPPED_SKILLS_FILE;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { hard?: unknown };
    const hard = Array.isArray(parsed?.hard) ? parsed.hard : [];
    return hard
      .map((item) => (typeof item === 'string' ? item : (item as { skill?: unknown } | null)?.skill))
      .filter((skill): skill is string => typeof skill === 'string');
  } catch (error) {
    if (!warnedUnreadable) {
      warnedUnreadable = true;
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `[keywords] The shipped skill list could not be read (${reason}); resume keywords use the concept table alone.`
      );
    }
    return [];
  }
}

function buildVocabulary(library: readonly string[]): Vocabulary {
  type Draft = { term: string; cls: TermClass; source: TermSource; aliasRows: Set<number>; toolRows: Set<number> };
  const drafts = new Map<string, Draft>();
  const add = (raw: string, source: TermSource, row?: number) => {
    const term = collapse(raw);
    if (!term || term.length > MAX_KEYWORD_LENGTH || !/[\p{L}\p{N}]/u.test(term)) return;
    const key = matchKey(term);
    const cls = classify(term, source);
    let draft = drafts.get(key);
    if (!draft) {
      draft = { term, cls, source, aliasRows: new Set(), toolRows: new Set() };
      drafts.set(key, draft);
    } else {
      if (CLASS_RANK[cls] > CLASS_RANK[draft.cls]) draft.cls = cls;
      if (SOURCE_RANK[source] > SOURCE_RANK[draft.source]) {
        draft.term = term;
        draft.source = source;
      }
    }
    if (row !== undefined) (source === 'alias' ? draft.aliasRows : draft.toolRows).add(row);
  };

  for (const skill of library) add(skill, 'library');
  CONCEPT_TOOLS.forEach((row, index) => {
    for (const tool of row.tools) add(tool, 'tool', index);
    for (const alias of row.aliases) add(alias, 'alias', index);
  });
  // Every spelling of a synonym group is a name a posting may use ("Golang",
  // "K8s", "NodeJS", "Amazon Web Services"), whether or not the shipped list
  // has it; `add` merges by key, so one the list has keeps the most
  // permissive class, and each new one takes the class its shape earns.
  for (const group of TERM_SYNONYMS) for (const spelling of group) add(spelling, 'library');

  const entries = new Map<string, VocabularyEntry>();
  const lower = new Map<string, VocabularyEntry>();
  const scan = new Map<string, VocabularyEntry[]>();
  for (const [key, draft] of drafts) {
    // A name that is no English word is a technology in any case: a casual or
    // scraped posting writes "docker and kubernetes" or "DOCKER".
    if (SAFE_ANY_CASE.has(key) && (draft.cls === 'title' || draft.cls === 'exact')) draft.cls = 'any';
    const entry: VocabularyEntry = {
      term: draft.term,
      key,
      cls: draft.cls,
      first: firstRun(draft.term),
      pattern: classPattern(draft.term, draft.cls),
      aliasRows: [...draft.aliasRows].sort((a, b) => a - b),
      toolRows: [...draft.toolRows].sort((a, b) => a - b),
    };
    entries.set(key, entry);
    if (!lower.has(draft.term.toLowerCase()) || draft.source === 'library') lower.set(draft.term.toLowerCase(), entry);
    if (entry.pattern && entry.first) {
      const bucket = scan.get(entry.first);
      if (bucket) bucket.push(entry);
      else scan.set(entry.first, [entry]);
    }
  }

  const aliases = new Map<string, AliasProbe[]>();
  CONCEPT_TOOLS.forEach((row, index) => {
    for (const alias of row.aliases) {
      const pattern = termPattern(alias);
      const first = firstRun(alias);
      if (!pattern || !first) continue;
      const bucket = aliases.get(first);
      if (bucket) bucket.push({ row: index, pattern });
      else aliases.set(first, [{ row: index, pattern }]);
    }
  });

  const digest = createHash('sha256');
  for (const key of [...entries.keys()].sort()) {
    const entry = entries.get(key)!;
    digest.update(`${key}\0${entry.term}\0${entry.cls}\0${entry.aliasRows.join(',')}\0${entry.toolRows.join(',')}\n`);
  }
  digest.update(JSON.stringify(TERM_SYNONYMS));
  return { entries, lower, scan, aliases, hash: digest.digest('hex').slice(0, 16) };
}

function vocabulary(): Vocabulary {
  vocabularyMemo ??= buildVocabulary(libraryOverride ?? readShippedSkills());
  return vocabularyMemo;
}

/* ================================================================== a term */

/** What the matcher knows of one spelling: its keys, its class and the concept rows it belongs to. */
export type TermInfo = {
  spelling: string;
  /** `matchKey`. */
  key: string;
  /** `synonymKey`: shared by the spellings of one thing. */
  synonym: string;
  cls: TermClass;
  /** Lower-case alphanumeric runs of the spelling; `first` is the first of them ('' for none). */
  runs: readonly string[];
  first: string;
  /** Rows of CONCEPT_TOOLS this spelling is an alias of / a tool of. */
  aliasRows: readonly number[];
  toolRows: readonly number[];
  /** The class's own pattern (global); null for a one-character term, which prose never names. */
  pattern: RegExp | null;
  /** `termPattern`'s whole-word test between two terms (not prose). */
  loose: RegExp | null;
};

const termCache = new Map<string, TermInfo>();
const namedRowsCache = new WeakMap<TermInfo, readonly number[]>();
const MAX_CACHED_TERMS = 20000;

export function describeTerm(spelling: string): TermInfo {
  const term = collapse(spelling);
  const cached = termCache.get(term);
  if (cached) return cached;
  const entry = vocabulary().entries.get(matchKey(term));
  const cls = entry?.cls ?? classify(term, 'library');
  const info: TermInfo = {
    spelling: term,
    key: matchKey(term),
    synonym: synonymKey(term),
    cls,
    runs: alnumRuns(term),
    first: firstRun(term),
    aliasRows: entry?.aliasRows ?? [],
    toolRows: entry?.toolRows ?? [],
    pattern: entry && entry.term === term ? entry.pattern : classPattern(term, cls),
    loose: termPattern(term),
  };
  if (termCache.size >= MAX_CACHED_TERMS) termCache.clear();
  termCache.set(term, info);
  return info;
}

/** The rows of CONCEPT_TOOLS whose alias this term holds as a whole word ("CI/CD pipelines" names CI/CD). */
export function namedRows(info: TermInfo): readonly number[] {
  const known = namedRowsCache.get(info);
  if (known) return known;
  const rows = new Set<number>();
  const aliases = vocabulary().aliases;
  for (const run of info.runs) {
    for (const probe of aliases.get(run) ?? []) {
      if (!rows.has(probe.row) && probe.pattern.test(info.spelling)) rows.add(probe.row);
    }
  }
  const result = [...rows].sort((a, b) => a - b);
  namedRowsCache.set(info, result);
  return result;
}

/** Where the term first appears in `text` under its class's rule, -1 for none. Callers prefilter on `info.first`. */
export function termIndexIn(info: TermInfo, text: string): number {
  return info.pattern ? firstAccepted(info.pattern, info.cls, text) : -1;
}

export type ScanHit = { term: TermInfo; index: number };

/**
 * The vocabulary's terms a text names, by the class rules above, in the order
 * of their first accepted appearance. Exact: a whole-word match of any entry
 * contains the entry's first alphanumeric run as a whole run of the text, so
 * looking the text's runs up first loses nothing and tests few patterns.
 */
export function scanVocabulary(text: string, runs: readonly string[] = alnumRuns(text)): ScanHit[] {
  if (!text) return [];
  const { scan } = vocabulary();
  // Every place each entry is named, so that the places inside a longer name
  // can be set aside ("CI" inside "CI/CD", "GitHub" inside "GitHub Actions",
  // "Express" inside "American Express") without losing a standalone mention
  // of the shorter one elsewhere in the text.
  type Found = Span & { entry: VocabularyEntry | null };
  const found: Found[] = [];
  const seenRuns = new Set<string>();
  for (const run of runs) {
    if (seenRuns.has(run)) continue;
    seenRuns.add(run);
    for (const entry of scan.get(run) ?? []) {
      for (const span of acceptedSpans(entry.pattern!, entry.cls, text)) found.push({ ...span, entry });
    }
  }
  if (found.length === 0) return [];
  COMPANY_NAMES.lastIndex = 0;
  for (let match = COMPANY_NAMES.exec(text); match; match = COMPANY_NAMES.exec(text)) {
    found.push({ start: match.index, end: match.index + match[0].length, entry: null });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);

  const hits: Array<ScanHit & { key: string }> = [];
  const taken = new Set<string>();
  let reach = -1;
  for (let at = 0; at < found.length; ) {
    // The spans with these exact bounds stand or fall together.
    let to = at;
    while (to < found.length && found[to].start === found[at].start && found[to].end === found[at].end) to += 1;
    const inside = reach >= found[at].end;
    if (!inside) {
      for (let k = at; k < to; k += 1) {
        const entry = found[k].entry;
        if (entry && !taken.has(entry.key)) {
          taken.add(entry.key);
          hits.push({ term: describeTerm(entry.term), index: found[k].start, key: entry.key });
        }
      }
    }
    reach = Math.max(reach, found[at].end);
    at = to;
  }
  hits.sort((a, b) => a.index - b.index || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return hits.map(({ term, index }) => ({ term, index }));
}

/**
 * Names that hold a technology's but are not it: the companies "American
 * Express" and "Express Scripts" (not the Express framework) and the clearance
 * "TS/SCI" (not TypeScript). A closed list, matched whole-word in any case; a
 * hit lying inside one of these is not a hit.
 */
const COMPANY_NAMES = /\b(?:American Express|Express Scripts|TS\/SCI)\b/gi;

type Span = { start: number; end: number };

/** Every place `pattern` matches that its class accepts. */
function acceptedSpans(pattern: RegExp, cls: TermClass, text: string): Span[] {
  const spans: Span[] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (accepted(cls, text, match.index, match[0].length)) spans.push({ start: match.index, end: match.index + match[0].length });
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return spans;
}

/**
 * Whether `spelling` is, as a whole, an entry of the vocabulary - the shipped
 * list, a concept tool or alias, or a synonym spelling ("CI/CD", "TCP/IP",
 * "A/B testing", "K8s"). The matcher uses it to leave such a term in one piece
 * when it would otherwise split an analysis term on "/".
 */
export function isVocabularyTerm(spelling: string): boolean {
  const term = collapse(spelling);
  if (!term) return false;
  const { entries, lower } = vocabulary();
  return entries.has(matchKey(term)) || lower.has(term.toLowerCase());
}

/** A typed skill in the shipped list's spelling (`go` is `Go`, `kubernetes` is `Kubernetes`), else as typed. */
function canonicalSpelling(term: string): string {
  const { entries, lower } = vocabulary();
  return (entries.get(matchKey(term)) ?? lower.get(term.toLowerCase()))?.term ?? term;
}

/* ================================================================ the sources */

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
  return list(value).filter((item): item is string => typeof item === 'string');
}

function records(value: unknown): Array<Record<string, unknown>> {
  return list(value).filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)
  );
}

function curatedSkills(resume: Resume): string[] {
  const typed = [...strings(resume.skills), ...records(resume.experience).flatMap((role) => strings(role.skills))];
  const kept: string[] = [];
  for (const raw of typed) {
    const term = collapse(raw);
    if (!term || term.length > MAX_KEYWORD_LENGTH || !/[\p{L}\p{N}]/u.test(term)) continue;
    kept.push(term);
  }
  return kept;
}

/**
 * A description as lines the scan reads: each line's sentences about the
 * COMPANY dropped (`isCompanyDescriptionLike`, the test the tailoring prompt's
 * `companyContext` uses), the rest kept in order.
 */
function descriptionLines(description: unknown, company: unknown): string[] {
  if (typeof description !== 'string') return [];
  const owner = typeof company === 'string' ? company : undefined;
  const lines: string[] = [];
  for (const line of description.split(/\r?\n/)) {
    const normalized = collapse(line);
    if (!normalized) continue;
    const kept = normalized
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => sentence && !isCompanyDescriptionLike(sentence, owner))
      .join(' ');
    if (kept) lines.push(kept);
  }
  return lines;
}

/**
 * The text the prose scan reads, one line per field: the same fields the
 * revise pass reads as the resume's evidence (headline, summary, skills and
 * their headings, strengths, each role's title, description and bullets and
 * skills, certifications, projects, volunteering, courses, awards and
 * publications), less the soft skills. Never the name, the contact, a company
 * field, the education, the languages, the interests, the references or the
 * custom sections.
 */
function scanText(resume: Resume): string {
  const lines: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const normalized = value.replace(/[ \t]+/g, ' ').trim();
    if (normalized) lines.push(normalized);
  };
  const addAll = (values: unknown) => strings(values).forEach(add);

  add(resume.title);
  add(resume.summary);
  addAll(resume.skills);
  for (const group of records(resume.skillCategories)) {
    add(group.category);
    addAll(group.skills);
  }
  for (const strength of records(resume.strengths)) {
    add(strength.title);
    descriptionLines(strength.description, undefined).forEach(add);
  }
  for (const role of records(resume.experience)) {
    add(role.title);
    descriptionLines(role.description, role.company).forEach(add);
    addAll(role.achievements);
    addAll(role.skills);
  }
  for (const item of records(resume.certifications)) {
    add(item.name);
    add(item.issuer);
  }
  for (const item of records(resume.projects)) {
    add(item.name);
    add(item.role);
    descriptionLines(item.description, undefined).forEach(add);
    addAll(item.achievements);
  }
  for (const item of records(resume.volunteering)) {
    add(item.role);
    descriptionLines(item.description, item.organization).forEach(add);
    addAll(item.achievements);
  }
  for (const item of records(resume.courses)) add(item.name);
  for (const item of records(resume.awards)) {
    add(item.title);
    descriptionLines(item.description, undefined).forEach(add);
  }
  for (const item of records(resume.publications)) {
    add(item.title);
    descriptionLines(item.description, undefined).forEach(add);
  }
  return lines.join('\n');
}

function distinct(values: readonly string[], limit: number): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    kept.push(value);
    if (kept.length >= limit) break;
  }
  return kept;
}

function headlineKinds(title: unknown): string[] {
  const headline = typeof title === 'string' ? collapse(title) : '';
  if (!headline || headline.toLowerCase() === PLACEHOLDER_HEADLINE) return [];
  // A headline can name two kinds: "Backend Engineer | Platform Engineer".
  return distinct(
    headline.split(/\s+[|/·]\s+/).map((segment) => roleKind(segment)),
    MAX_HEADLINE_KINDS
  );
}

function titleKinds(resume: Resume): string[] {
  return distinct(
    records(resume.experience).map((role) => roleKind(typeof role.title === 'string' ? role.title : '')),
    MAX_ROLE_TITLES
  );
}

/* ================================================================= keywords */

/** The resume's keywords from its own fields alone. Pure; costs about a millisecond. */
export function keywordsOf(resume: Resume): ResumeKeywords {
  const voc = vocabulary();
  const curated = curatedSkills(resume).map(canonicalSpelling);
  const text = scanText(resume);
  const terms: string[] = [];
  const seen = new Set<string>();
  const take = (term: string) => {
    const key = synonymKey(term);
    if (seen.has(key) || terms.length >= MAX_KEYWORD_TERMS) return;
    seen.add(key);
    terms.push(term);
  };
  curated.forEach(take);
  for (const hit of scanVocabulary(text)) take(hit.term.spelling);

  const sources = {
    headline: typeof resume.title === 'string' ? resume.title : '',
    roleTitles: records(resume.experience).map((role) => (typeof role.title === 'string' ? role.title : '')),
    curated: curatedSkills(resume),
    text,
  };
  return {
    version: KEYWORDS_VERSION,
    vocabulary: voc.hash,
    basedOn: createHash('sha256').update(JSON.stringify(sources), 'utf8').digest('hex'),
    headline: headlineKinds(resume.title),
    roleTitles: titleKinds(resume),
    terms,
  };
}

const keywordMemo = new Map<string, ResumeKeywords>();

function frozen(keywords: ResumeKeywords): ResumeKeywords {
  Object.freeze(keywords.headline);
  Object.freeze(keywords.roleTitles);
  Object.freeze(keywords.terms);
  return Object.freeze(keywords);
}

/**
 * `keywordsOf` through a 512-entry memo keyed by the resume's id, its
 * `updatedAt` and `KEYWORDS_VERSION` - a save moves `updatedAt`, so an edited
 * resume is computed afresh. A resume with no id or no time (a draft) is not
 * memoised. The answer is frozen and nothing is written to the resume.
 */
export function matchKeywordsOf(resume: Resume): ResumeKeywords {
  const id = typeof resume.id === 'string' ? resume.id : '';
  const updatedAt = typeof resume.updatedAt === 'string' ? resume.updatedAt : '';
  if (!id || !updatedAt) return keywordsOf(resume);
  const key = `${id}\0${updatedAt}\0${KEYWORDS_VERSION}`;
  const known = keywordMemo.get(key);
  if (known) {
    keywordMemo.delete(key);
    keywordMemo.set(key, known);
    return known;
  }
  const keywords = frozen(keywordsOf(resume));
  keywordMemo.set(key, keywords);
  while (keywordMemo.size > MATCH_KEYWORDS_CACHE_SIZE) {
    const oldest = keywordMemo.keys().next().value as string;
    keywordMemo.delete(oldest);
  }
  return keywords;
}

/* ===================================================================== seams */

function resetVocabulary(): void {
  vocabularyMemo = null;
  warnedUnreadable = false;
  termCache.clear();
  keywordMemo.clear();
}

/**
 * Tests: the shipped hard-skill list replaced by `skills` (null = the shipped
 * file again). Clears the vocabulary, the term caches and the memo.
 */
export function setMatchVocabularyForTests(skills: readonly string[] | null): void {
  libraryOverride = skills;
  resetVocabulary();
}

/** Tests: the file the shipped list is read from (null = the real one), e.g. a missing one. */
export function setMatchVocabularyFileForTests(file: string | null): void {
  fileOverride = file;
  resetVocabulary();
}
